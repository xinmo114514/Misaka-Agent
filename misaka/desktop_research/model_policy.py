"""File-backed, cooperative model boundary shared by desktop executor processes.

Executors acknowledge a staged pair only after every old request has drained.
Callbacks prepare their session but must not launch requests themselves. Workers
cooperate by calling ``request`` (or ``synchronize_executor`` while idle).
"""
import asyncio
import inspect
import json
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import psutil
from filelock import FileLock


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    try:
        with temporary.open('w', encoding='utf-8') as output:
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def model_pair(provider, model_id):
    if not isinstance(provider, str) or not provider.strip():
        raise ValueError('A provider is required')
    if not isinstance(model_id, str) or not model_id.strip():
        raise ValueError('A model ID is required')
    return {'provider': provider, 'modelId': model_id}


class ModelPolicyPaused(RuntimeError):
    """No new launch or provider request is permitted at this boundary."""


class DesktopTeamModelPolicy:
    def __init__(self, path, provider, model_id):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = FileLock(str(self.path) + '.lock', timeout=30)
        self.process_key = f'{os.getpid()}:{uuid.uuid4().hex}'
        self._callbacks = {}
        self._synchronizing = set()
        self._subscribers = []
        self._last_public = None
        with self.lock:
            if not self.path.exists():
                self._write({'effective': model_pair(provider, model_id), 'target': None,
                             'epoch': 0, 'state': 'ready', 'executors': {}, 'requests': {}})
            self._last_public = self._public(self._read())

    def _read(self):
        state = json.loads(self.path.read_text(encoding='utf-8'))
        dead = []
        for key, executor in state['executors'].items():
            try:
                process = psutil.Process(executor['pid'])
                if executor.get('birth') is not None and process.create_time() != executor['birth']:
                    dead.append(key)
            except psutil.NoSuchProcess:
                dead.append(key)
            except psutil.AccessDenied:
                pass  # An uncertain process remains part of the barrier.
        if dead:
            for key in dead:
                state['executors'].pop(key)
            state['requests'] = {key: value for key, value in state['requests'].items()
                                 if value['executor'] not in dead}
            self._write(state)
        return state

    def _write(self, state):
        atomic_json(self.path, state)
        self._notify(state)

    def _notify(self, state):
        public = self._public(state)
        if public != self._last_public:
            self._last_public = public
            for callback in list(self._subscribers):
                try:
                    callback(json.loads(json.dumps(public)))
                except Exception:
                    logging.getLogger(__name__).exception('Model policy subscriber failed')

    def subscribe(self, callback):
        """Subscribe to persisted public-state changes, including observed peer writes.

        Callbacks are synchronous notifications; schedule asynchronous UI delivery
        from them. A callback failure does not affect the model transaction.
        """
        if not callable(callback):
            raise TypeError('Subscriber must be callable')
        self._subscribers.append(callback)

        def unsubscribe():
            if callback in self._subscribers:
                self._subscribers.remove(callback)

        return unsubscribe

    @staticmethod
    def _public(state):
        return {k: state[k] for k in ('effective', 'target', 'epoch', 'state', 'error') if k in state}

    def snapshot(self):
        with self.lock:
            state = self._read()
            self._notify(state)
            return self._public(state)

    def _key(self, executor_id):
        return f'{self.process_key}:{executor_id}'

    def register_executor(self, executor_id, prepare=None):
        if not isinstance(executor_id, str) or not executor_id:
            raise ValueError('An executor ID is required')
        with self.lock:
            state = self._read()
            key = self._key(executor_id)
            if key not in state['executors']:
                state['executors'][key] = {'id': executor_id, 'pid': os.getpid(),
                                           'birth': psutil.Process().create_time(),
                                           'process': self.process_key, 'ack': None,
                                           'bound': state['effective'], 'boundEpoch': state['epoch']}
                self._write(state)
        self._callbacks[executor_id] = prepare
        return self.guard_model() if state['state'] == 'ready' else self.snapshot()

    def unregister_executor(self, executor_id):
        with self.lock:
            state = self._read()
            key = self._key(executor_id)
            if any(r['executor'] == key for r in state['requests'].values()):
                raise ValueError('Executor still has active requests')
            # An executor explicitly marked closing by another process is released here only
            # when nothing remains; a caller that reaches this door with a live request must
            # use settle_executor so the pending state is visible instead of being an error.
            state['executors'].pop(key, None)
            self._write(state)
        self._callbacks.pop(executor_id, None)

    def begin_closing(self, executor_id):
        """Mark one executor as closing: new admissions pause, existing requests drain.

        Task 2: close and release are different facts. ``closing`` stops new work at once so no
        fresh request can join the barrier while the settlement is still draining; the settle
        step below is what actually removes the executor and its callback.
        """
        with self.lock:
            state = self._read()
            key = self._key(executor_id)
            executor = state['executors'].get(key)
            if executor is None:
                return False
            executor['closing'] = True
            self._write(state)
            return True

    def settle_executor(self, executor_id):
        """The close/drain step: unregister only when no request remains.

        Returns ``'settled'`` when the executor (and its callback) are gone, ``'pending'`` when a
        request is still live, and ``'absent'`` when it was already released. Task 2: a pending
        settlement is a state to retry, not a crash to report; the caller keeps the object until
        this returns ``settled`` or ``absent``.
        """
        with self.lock:
            state = self._read()
            key = self._key(executor_id)
            if key not in state['executors']:
                self._callbacks.pop(executor_id, None)
                return 'absent'
            if any(r['executor'] == key for r in state['requests'].values()):
                return 'pending'
            state['executors'].pop(key, None)
            self._write(state)
            self._callbacks.pop(executor_id, None)
            return 'settled'

    def guard_model(self, expected_epoch=None):
        with self.lock:
            state = self._read()
            if state['state'] != 'ready':
                raise ModelPolicyPaused(state.get('error') or 'Model switch in progress')
            if expected_epoch is not None and expected_epoch != state['epoch']:
                raise ValueError('Stale model epoch')
            return {**state['effective'], 'epoch': state['epoch']}

    def begin_request(self, executor_id, expected_epoch=None):
        with self.lock:
            state = self._read()
            if state['state'] != 'ready':
                raise ModelPolicyPaused(state.get('error') or 'Model switch in progress')
            if expected_epoch is not None and expected_epoch != state['epoch']:
                raise ValueError('Stale model epoch')
            key = self._key(executor_id)
            executor = state['executors'].get(key)
            if executor is None:
                raise ValueError('Executor is not registered in this process')
            if executor.get('closing'):
                # The executor is being closed: no new admission may join the barrier (Task 2).
                raise ModelPolicyPaused('Executor is closing')
            if executor['bound'] != state['effective'] or executor['boundEpoch'] != state['epoch']:
                raise ModelPolicyPaused('Executor needs to synchronize its model')
            ticket = {**state['effective'], 'epoch': state['epoch'], 'requestId': uuid.uuid4().hex}
            state['requests'][ticket['requestId']] = {'executor': key, **ticket}
            self._write(state)
            return ticket

    def end_request(self, ticket):
        request_id = ticket['requestId'] if isinstance(ticket, dict) else ticket
        with self.lock:
            state = self._read()
            request = state['requests'].get(request_id)
            if request and not request['executor'].startswith(self.process_key + ':'):
                raise ValueError('Request belongs to another process')
            state['requests'].pop(request_id, None)
            self._write(state)

    async def synchronize_executor(self, executor_id):
        if executor_id in self._synchronizing:
            return
        with self.lock:
            state = self._read()
            key = self._key(executor_id)
            executor = state['executors'].get(key)
            if executor is None:
                raise ValueError('Executor is not registered')
            if state['requests'] or executor.get('busy'):
                return
            if state['state'] == 'switching' and state.get('phase') in ('drain', 'prepare'):
                pair, epoch = state['target'], state['epoch'] + 1
            elif state.get('phase') == 'cancel':
                pair, epoch = state['effective'], state['epoch']
            else:
                return
            operation = state['operation']
            if executor['ack'] == operation:
                return
            executor['dirty'] = True
            executor['busy'] = True
            self._write(state)
        self._synchronizing.add(executor_id)
        try:
            callback = self._callbacks.get(executor_id)
            if callback:
                result = callback(pair['provider'], pair['modelId'], epoch)
                if inspect.isawaitable(result):
                    await result
            with self.lock:
                state = self._read()
                if state.get('operation') == operation and key in state['executors']:
                    state['executors'][key].update(ack=operation, bound=pair, boundEpoch=epoch, dirty=False)
                    self._write(state)
        except Exception as error:
            with self.lock:
                state = self._read()
                if state.get('operation') == operation:
                    state.update(state='failed', error=str(error))
                    self._write(state)
            raise
        finally:
            self._synchronizing.discard(executor_id)
            with self.lock:
                state = self._read()
                if key in state['executors']:
                    state['executors'][key]['busy'] = False
                    self._write(state)

    @asynccontextmanager
    async def request(self, executor_id):
        while True:
            await self.synchronize_executor(executor_id)
            try:
                ticket = self.begin_request(executor_id)
                break
            except ModelPolicyPaused:
                if self.snapshot()['state'] == 'failed':
                    raise
                await asyncio.sleep(.01)
        try:
            yield {k: ticket[k] for k in ('provider', 'modelId', 'epoch')}
        finally:
            self.end_request(ticket)

    async def switch(self, provider, model_id, *, timeout=30):
        target = model_pair(provider, model_id)
        with self.lock:
            state = self._read()
            if state['state'] not in ('ready', 'failed'):
                raise ModelPolicyPaused('Another model boundary is pending')
            if state['state'] == 'ready' and target == state['effective']:
                return self._public(state)
            state.update(state='switching', target=target, phase='drain', operation=uuid.uuid4().hex)
            operation = state['operation']
            state.pop('error', None)
            self._write(state)
        try:
            return await self._finish_boundary(timeout, cancel=False, operation=operation)
        except asyncio.CancelledError:
            with self.lock:
                state = self._read()
                if state['state'] == 'switching' and state.get('operation') == operation:
                    state.update(state='failed', error='Switch interrupted; cancel or retry explicitly')
                    self._write(state)
            raise

    async def _finish_boundary(self, timeout, *, cancel, operation=None):
        deadline = time.monotonic() + timeout
        if operation is None:
            with self.lock:
                operation = self._read().get('operation')
        while True:
            with self.lock:
                state = self._read()
                if state.get('operation') != operation:
                    return self._public(state)
                if not cancel and state['state'] == 'failed':
                    return self._public(state)
                if not state['requests']:
                    state['phase'] = 'cancel' if cancel else 'prepare'
                    self._write(state)
            for executor_id in list(self._callbacks):
                try:
                    await asyncio.wait_for(self.synchronize_executor(executor_id),
                                           max(.001, deadline - time.monotonic()))
                except TimeoutError:
                    with self.lock:
                        state = self._read()
                        if state.get('operation') == operation:
                            state.update(state='failed', error='Executor preparation timed out')
                            self._write(state)
                    return self.snapshot()
                except Exception:
                    # synchronize_executor persisted the diagnostic before propagating.
                    if not self.snapshot().get('error'):
                        raise
                    return self.snapshot()
            with self.lock:
                state = self._read()
                if state.get('operation') != operation:
                    return self._public(state)
                all_ack = all(e['ack'] == state['operation'] for e in state['executors'].values())
                if (not state['requests'] or cancel) and all_ack and (state['state'] != 'failed' or cancel):
                    if not cancel:
                        state['effective'] = state['target']
                        state['epoch'] += 1
                    state.update(target=None, state='ready')
                    for field in ('phase', 'operation', 'error'):
                        state.pop(field, None)
                    self._write(state)
                    return self._public(state)
                if time.monotonic() >= deadline:
                    state.update(state='failed', error='Model boundary timed out')
                    self._write(state)
                    return self._public(state)
            await asyncio.sleep(.01)

    async def cancel_switch(self, *, timeout=30):
        with self.lock:
            state = self._read()
            if state['state'] == 'ready':
                return self._public(state)
            state.update(state='switching', phase='cancel', operation=uuid.uuid4().hex)
            operation = state['operation']
            state.pop('error', None)
            # Unchanged, in-flight old sessions need no restoration acknowledgement.
            for executor in state['executors'].values():
                if (executor['bound'] == state['effective'] and executor['boundEpoch'] == state['epoch']
                        and not executor.get('dirty')):
                    executor['ack'] = state['operation']
            self._write(state)
        return await self._finish_boundary(timeout, cancel=True, operation=operation)


class DesktopRoleModelPolicy:
    """Two cooperative boundaries sharing a team identity, but not request drains.

    The historical policy file remains the Sister boundary. A pre-existing single
    policy is copied exactly into the Last Order boundary on first role-aware open.
    Both files are independently durable and may be opened by child processes.
    """

    ROLES = ('last_order', 'sister')

    def __init__(self, path, provider, model_id, *, lo_provider=None, lo_model=None):
        self.path = Path(path)
        self._gate_path = self.path.with_name(self.path.stem + '-all-boundary' + self.path.suffix)
        self._gate_lock = FileLock(str(self._gate_path) + '.lock', timeout=30)
        # A first opener creates both roles as one migration decision. Without
        # this lock a concurrent child could mistake the freshly created Sister
        # file for an old single-policy team and seed LO from the wrong pair.
        with FileLock(str(self.path) + '.roles.lock', timeout=30):
            old_team = self.path.exists()
            self._policies = {'sister': DesktopTeamModelPolicy(path, provider, model_id)}
            saved = self._policies['sister'].snapshot()['effective']
            lo_path = self.path.with_name(self.path.stem + '-last-order' + self.path.suffix)
            initial = saved if old_team else model_pair(lo_provider or provider, lo_model or model_id)
            self._policies['last_order'] = DesktopTeamModelPolicy(lo_path, initial['provider'], initial['modelId'])
        self._executor_roles = {}
        self._all_task = None

    @staticmethod
    def _role(role):
        if role not in DesktopRoleModelPolicy.ROLES:
            raise ValueError(f'Unknown desktop model role: {role}')
        return role

    def _policy(self, role='sister'):
        return self._policies[self._role(role)]

    def _gate(self):
        with self._gate_lock:
            try:
                return json.loads(self._gate_path.read_text(encoding='utf-8'))
            except FileNotFoundError:
                return None

    def _set_gate(self, state):
        with self._gate_lock:
            if state is None:
                self._gate_path.unlink(missing_ok=True)
            else:
                atomic_json(self._gate_path, state)

    def _check_gate(self):
        gate = self._gate()
        if gate:
            raise ModelPolicyPaused(gate.get('error') or 'All-team model switch in progress')

    def snapshot(self, role='sister'):
        binding = self._policy(role).snapshot()
        gate = self._gate()
        if gate and gate['state'] == 'failed':
            return {**binding, 'state': 'failed', 'error': gate['error'], 'target': gate['target']}
        return binding

    def bindings(self):
        return {role: self.snapshot(role=role) for role in self.ROLES}

    def subscribe(self, callback):
        # Emit for changes in either persisted boundary. The legacy callback
        # payload remains the primary/Sister binding.
        unsubscribers = [policy.subscribe(lambda _state: callback(self.snapshot()))
                         for policy in self._policies.values()]
        def unsubscribe():
            for stop in unsubscribers:
                stop()
        return unsubscribe

    def guard_model(self, expected_epoch=None, *, role='sister'):
        self._check_gate()
        return self._policy(role).guard_model(expected_epoch)

    def register_executor(self, executor_id, prepare=None, *, role='sister'):
        self._executor_roles[executor_id] = self._role(role)
        return self._policy(role).register_executor(executor_id, prepare)

    def _executor_policy(self, executor_id):
        return self._policy(self._executor_roles.get(executor_id, 'sister'))

    def unregister_executor(self, executor_id):
        result = self._executor_policy(executor_id).unregister_executor(executor_id)
        self._executor_roles.pop(executor_id, None)
        return result

    def begin_closing(self, executor_id):
        return self._executor_policy(executor_id).begin_closing(executor_id)

    def settle_executor(self, executor_id):
        result = self._executor_policy(executor_id).settle_executor(executor_id)
        if result != 'pending':
            self._executor_roles.pop(executor_id, None)
        return result

    def begin_request(self, executor_id, expected_epoch=None, *, role=None):
        role = self._role(role or self._executor_roles.get(executor_id, 'sister'))
        self._check_gate()
        return {**self._policy(role).begin_request(executor_id, expected_epoch), 'role': role}

    def end_request(self, ticket):
        if isinstance(ticket, dict) and ticket.get('role') in self.ROLES:
            return self._policy(ticket['role']).end_request(ticket)
        # Legacy callers pass a request ID rather than a ticket; locate its
        # policy without ever releasing another process's request.
        for policy in self._policies.values():
            with policy.lock:
                found = ticket in policy._read()['requests']
            if found:
                return policy.end_request(ticket)

    async def synchronize_executor(self, executor_id):
        return await self._executor_policy(executor_id).synchronize_executor(executor_id)

    @asynccontextmanager
    async def request(self, executor_id):
        role = self._executor_roles.get(executor_id, 'sister')
        while True:
            await self.synchronize_executor(executor_id)
            try:
                ticket = self.begin_request(executor_id, role=role)
                break
            except ModelPolicyPaused:
                if self.snapshot(role=role)['state'] == 'failed':
                    raise
                await asyncio.sleep(.01)
        try:
            yield {k: ticket[k] for k in ('provider', 'modelId', 'epoch')}
        finally:
            self.end_request(ticket)

    async def switch(self, provider, model_id, *, role='all', timeout=30):
        if role != 'all':
            self._check_gate()
            return await self._policy(role).switch(provider, model_id, timeout=timeout)
        # Preserve the historical all-team operation. Switch Sister first so a
        # failed root legacy preparation leaves LO unchanged; if LO fails later,
        # restore Sister and expose the truthful independent failure bindings.
        originals = {name: policy.snapshot()['effective'] for name, policy in self._policies.items()}
        gate = self._gate()
        if gate and gate['state'] != 'failed':
            raise ModelPolicyPaused('Another all-team model boundary is pending')
        operation = uuid.uuid4().hex
        self._set_gate({'state': 'switching', 'target': model_pair(provider, model_id),
                        'operation': operation})
        self._all_task = asyncio.current_task()
        async def cancelled():
            current = self._gate()
            if current and current.get('operation') == operation and current['state'] == 'switching':
                return False
            for name, original in originals.items():
                policy = self._policy(name)
                actual = policy.snapshot()
                if actual['state'] != 'ready':
                    await policy.cancel_switch(timeout=timeout)
                    actual = policy.snapshot()
                if actual['state'] == 'ready' and actual['effective'] != original:
                    await policy.switch(original['provider'], original['modelId'], timeout=timeout)
            current = self._gate()
            if current and current.get('operation') == operation and current['state'] == 'cancelling':
                self._set_gate(None)
            return True
        try:
            result = await self._policy('sister').switch(provider, model_id, timeout=timeout)
            if await cancelled():
                return self.snapshot()
            if result['state'] != 'ready':
                self._set_gate({'state': 'failed', 'target': model_pair(provider, model_id),
                                'error': result.get('error', 'Sister preparation failed'), 'operation': operation})
                return self.snapshot()
            other = await self._policy('last_order').switch(provider, model_id, timeout=timeout)
            if await cancelled():
                return self.snapshot()
            if other['state'] != 'ready':
                original = originals['sister']
                await self._policy('sister').switch(original['provider'], original['modelId'], timeout=timeout)
                self._set_gate({'state': 'failed', 'target': model_pair(provider, model_id),
                                'error': other.get('error', 'Last Order preparation failed'), 'operation': operation})
                return self.snapshot()
            self._set_gate(None)
            return self.snapshot()
        except BaseException:
            current = self._gate()
            if current and current.get('operation') == operation and current['state'] != 'cancelling':
                self._set_gate({'state': 'failed', 'target': model_pair(provider, model_id),
                                'error': 'All-team switch interrupted; cancel or retry explicitly',
                                'operation': operation})
            raise
        finally:
            if self._all_task is asyncio.current_task():
                self._all_task = None

    async def cancel_switch(self, *, role='all', timeout=30):
        if role != 'all':
            return await self._policy(role).cancel_switch(timeout=timeout)
        gate = self._gate()
        if gate and gate['state'] == 'switching':
            self._set_gate({**gate, 'state': 'cancelling'})
        for current in self.ROLES:
            await self._policy(current).cancel_switch(timeout=timeout)
        task = self._all_task
        if task is not None and task is not asyncio.current_task():
            await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
        if all(p.snapshot()['state'] == 'ready' for p in self._policies.values()) and self._all_task is None:
            self._set_gate(None)
        return self.snapshot()
