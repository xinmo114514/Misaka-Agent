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
            state['executors'].pop(key, None)
            self._write(state)
        self._callbacks.pop(executor_id, None)

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
