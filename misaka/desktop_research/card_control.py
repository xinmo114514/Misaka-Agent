"""Desktop-owned wake/continuation for research cards (Task 1).

The 2026-10-11 regression: a finished card of a desktop research run was woken by SendMessage
through the global panel (``pane.continue_card``), which runs the native ``card_shell`` against
the global profiles root and failed with "Sister <name> is not in the roster". The continuation
now belongs to the owning desktop scope: the same ``worker_entry`` chain (policy, private team,
private profiles) that runs every other desktop card, with the resolved generation and the
``consult`` flag travelling to the real ``claim_resume`` CAS.

Nothing here replaces the board CAS. The pre-checks below only keep a stale or foreign request
from starting a process; the worker re-checks the generation before reopening anything.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import uuid
from pathlib import Path

from filelock import FileLock

from misaka.utils.prompt_file import removePromptFile, writePromptToTempFile

from .model_policy import atomic_json


_LOG = logging.getLogger(__name__)
REAP_INTERVAL_SECONDS = 3.0
MAX_AUTOMATIC_RETRIES = 2


class DesktopCardControl:
    """One desktop scope's continuation owner: wake, watch, stop."""

    def __init__(self, scope):
        self.scope = scope
        self.prompt_files = {}
        self.continuations = {}          # task_id -> subprocess.Popen
        self._pending = {}
        self.registry_path = Path(scope.team.directory) / "continuation-registry.json"
        self.registry_lock = FileLock(str(self.registry_path) + ".lock", timeout=2)
        if not hasattr(scope, "pending_launches"):
            scope.pending_launches = set()
        self.launches = {}               # task_id -> launch id recorded for admission
        self._monitor_lock = threading.Lock()
        self._monitor_stop = threading.Event()
        self._monitor_thread = None
        if self.registry_path.exists():
            self._ensure_monitor()

    # -- identity ---------------------------------------------------------------

    def owner(self):
        """The desktop owner record written by the host scope, or None."""
        path = Path(self.scope.team.directory) / 'owner.json'
        try:
            return json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return None

    def _card_owner(self, task_id):
        """The research run this card belongs to, when it is a desktop research card."""
        from misaka.core.platform import tasks as task_store
        from misaka.core.research import runs

        record = self.owner()
        if record is None:
            return None, 'This card does not belong to a desktop research team.'
        con = task_store.connect(os.path.expanduser(self.scope.current_config()['db']))
        try:
            link = con.execute('SELECT run_id FROM research_cards WHERE task_id=?', (task_id,)).fetchone()
            if link is None:
                return None, f'Card {task_id} is not a research card of this desktop team.'
            run = runs.get(con, link['run_id'])
            if run is None:
                return None, f'Card {task_id} names research run {link["run_id"]}, which is gone.'
            root = str(run['root_session'] or '')
            expected = str(record.get('rootSession') or '')
            workspace = str(record.get('workspace') or '')
            if (not expected or not root or os.path.realpath(root) != os.path.realpath(expected)
                    or not workspace or os.path.realpath(workspace) != os.path.realpath(run['workspace'])):
                return None, (f'Card {task_id} belongs to research run {run["id"]} of another root '
                              'conversation; it is continued in that window.')
            return dict(run), None
        finally:
            con.close()

    # -- wake -------------------------------------------------------------------

    def wake_card(self, target, message):
        """The scope hook: continue ``target['to_task']`` as a desktop worker child.

        Returns the same shape ``messages.wake_card`` promises its caller: a mapping with
        ``pane_id`` (None here) plus ``execution_kind``/``execution_id`` so the tool result can say
        who was woken without pretending a panel pane exists.
        """
        task_id = str(target.get('to_task') or '')
        generation = target.get('generation')
        if not task_id:
            raise ValueError('A woken desktop card needs its task id.')
        run, refusal = self._card_owner(task_id)
        if run is None:
            raise ValueError(refusal)
        self._reap()
        from misaka.core.platform import tasks as task_store

        con = task_store.connect(os.path.expanduser(self.scope.current_config()['db']))
        try:
            row = task_store.get(con, task_id)
            if row is None:
                raise ValueError(f'Card {task_id} is not on the board.')
            current = int(row['generation'])
            resolved = int(generation) if generation is not None else current
            if resolved != current:
                with self.registry_lock:
                    record = self._registry().get(task_id, {})
                    intent = record.get('claimIntent', {})
                    # The real CAS may have committed before claimed() publishes
                    # its release metadata. Join only that exact journalled owner.
                    journalled_owner = (intent.get('generation') == current
                                        and intent.get('claimLock') == row['claim_lock']
                                        and intent.get('pid') == row['worker_pid']
                                        and intent.get('identity') == row['worker_identity'])
                    published_owner = (record.get('claimedGeneration') == current
                                       and record.get('claimLock') == row['claim_lock'])
                    joining = (record.get('state') in {'pending', 'running'}
                               and record.get('generation') == resolved
                               and (published_owner or journalled_owner)
                               and row['status'] == 'running' and current == resolved + 1)
                if not joining:
                    raise ValueError(f'Card {task_id} moved to attempt {current}; the message resolved '
                                     f'attempt {resolved}. Reopen the card and send again.')
        finally:
            con.close()
        request_id = target.get('requestId') or target.get('message_id') or uuid.uuid4().hex
        execution_id, duplicate = self._accept(task_id, message, resolved, str(request_id), run['workspace'])
        return {'pane_id': None, 'execution_kind': 'desktop', 'execution_id': execution_id,
                'accepted': True, 'settled': False, 'duplicate': duplicate}

    @staticmethod
    def _owner_identity():
        from misaka.core.platform import processes
        return processes.identity(os.getpid())

    def _registry(self):
        try:
            return json.loads(self.registry_path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            return {}

    def _accept(self, task_id, message, generation, request_id, workspace):
        with self.registry_lock:
            records = self._registry()
            existing = records.get(task_id)
            if (existing and existing.get('state') in {'pending', 'running'}
                    and existing.get('generation') == generation):
                # Messages are already durable in the task inbox. A different message
                # shares the live consumer rather than being reported as a duplicate.
                duplicate = request_id in existing.get('requests', [])
                if not duplicate:
                    existing.setdefault('requests', []).append(request_id)
                atomic_json(self.registry_path, records)
                if existing.get('claimedGeneration') is not None:
                    self._release_mail(task_id, existing)
                return existing['executionId'], duplicate
            execution_id = uuid.uuid4().hex
            records[task_id] = {'executionId': execution_id, 'state': 'pending',
                                'generation': generation, 'consult': True, 'automaticRetries': 0,
                                'requests': list(dict.fromkeys([*(existing or {}).get('requests', []), request_id])),
                                'workspace': workspace, 'ownerPid': os.getpid(),
                                'ownerIdentity': self._owner_identity()}
            atomic_json(self.registry_path, records)
        self._queue(task_id, message, generation, execution_id, workspace)
        return execution_id, False

    def claiming(self, task_id, generation, claim_lock, identity, *, consult=False):
        """Journal the exact prospective CAS owner, including the pre-release crash window."""
        execution_id = (os.environ.get('MISAKA_DESKTOP_CONTINUATION_EXECUTION_ID')
                        if os.environ.get('MISAKA_DESKTOP_CONTINUATION') == task_id else None)
        if not execution_id:
            return
        with self.registry_lock:
            records = self._registry()
            record = records.get(task_id, {})
            if (record.get('executionId') != execution_id
                    or record.get('state') not in {'pending', 'running'}
                    or record.get('generation') != generation):
                raise ValueError('Desktop continuation execution ownership changed before claim')
            record['consult'] = consult
            record['claimIntent'] = {'generation': generation if consult else generation + 1, 'consult': consult, 'claimLock': claim_lock,
                                     'pid': os.getpid(), 'identity': identity}
            atomic_json(self.registry_path, records)

    def claimed(self, task_id, generation, claim_lock, *, consult=False):
        """Release inbox input only for this execution's successful board CAS.

        The registry precedes the mailbox write: either crash window is replayable.
        Request IDs survive replacement launches until their native mail receipts ACK.
        """
        execution_id = (os.environ.get('MISAKA_DESKTOP_CONTINUATION_EXECUTION_ID')
                        if os.environ.get('MISAKA_DESKTOP_CONTINUATION') == task_id else None)
        from misaka.core.platform import tasks
        with self.registry_lock:
            records = self._registry()
            record = records.get(task_id, {})
            if not record:
                return
            if execution_id and (record.get('executionId') != execution_id
                                 or record.get('state') not in {'pending', 'running'}):
                raise ValueError('Desktop continuation execution ownership changed before inbox release')
            con = tasks.connect(self.scope.current_config()['db'])
            try:
                if not execution_id:
                    # Ordinary scheduler retries carry no continuation environment.
                    # Only the same generation's settled, journalled execution proves
                    # this is recovery, rather than unrelated later work on the card.
                    # Budget stops and cancellation settle that attempt as released.
                    intent = record.get('claimIntent', {})
                    prior = con.execute('SELECT 1 FROM task_runs WHERE task_id=? AND generation=? '
                                        'AND claim_lock=? AND pid=? AND process_identity IS ? '
                                        "AND status IN ('failed','reclaimed','released')",
                                        (task_id, generation, intent.get('claimLock'), intent.get('pid'),
                                         intent.get('identity'))).fetchone()
                    if intent.get('generation') != generation or prior is None:
                        return
                row = tasks.get(con, task_id)
                if consult:
                    live = tasks.live_consultation(con, task_id)
                    intent = record.get('claimIntent', {})
                    if (row is None or int(row['generation']) != generation
                            or generation != int(record['generation']) or live is None
                            or live['claim_lock'] != claim_lock or live['pid'] != os.getpid()
                            or live['process_identity'] != intent.get('identity')):
                        raise ValueError('Desktop consultation ownership changed before inbox release')
                    record.update(claimedGeneration=generation, claimLock=claim_lock,
                                  consultationId=live['id'])
                    atomic_json(self.registry_path, records)
                    self._release_mail(task_id, record)
                    return
                if (row is None or row['status'] != 'running' or int(row['generation']) != generation
                        or row['claim_lock'] != claim_lock or row['worker_pid'] != os.getpid()
                        or generation != int(record['generation']) + 1):
                    raise ValueError('Desktop continuation claim ownership changed before inbox release')
                record.update(claimedGeneration=generation, claimLock=claim_lock)
                atomic_json(self.registry_path, records)
                self._release_mail(task_id, record)
            finally:
                con.close()

    def _release_mail(self, task_id, record):
        """Registry lock held; preserve rows across retries, never their expired delivery lease."""
        from misaka.core.network import messages
        from misaka.core.platform import tasks
        config = self.scope.current_config()
        con = tasks.connect(config['db'])
        try:
            # Fence the independent mailbox write against another board generation.
            with tasks.write_txn(con):
                row = tasks.get(con, task_id)
                if row is None or row['generation'] != record.get('claimedGeneration'):
                    return
                if record.get('consultationId'):
                    live = tasks.live_consultation(con, task_id)
                    if (live is None or live['id'] != record['consultationId']
                            or live['claim_lock'] != record.get('claimLock')):
                        return
                elif row['status'] != 'running' or row['claim_lock'] != record.get('claimLock'):
                    return
                mail = messages.connect(config.get('messages_db'))
                try:
                    # Include staged rows whose senders died between queue insertion
                    # and registry enrollment. Persist their receipts before release.
                    held = mail.execute('SELECT id FROM messages WHERE to_task=? AND delivered_at IS NULL '
                                        'AND lease_token LIKE ? AND generation<=?',
                                        (task_id, messages.CONTINUATION_TOKEN + '%', record['generation'])).fetchall()
                    requests = list(dict.fromkeys([*record.get('requests', []),
                                                   *(str(item['id']) for item in held)]))
                    if requests != record.get('requests', []):
                        record['requests'] = requests
                        records = self._registry()
                        records[task_id] = record
                        atomic_json(self.registry_path, records)
                    ids = [int(value) for value in requests if str(value).isdigit()]
                    for start in range(0, len(ids), 500):
                        batch = ids[start:start + 500]
                        marks = ','.join('?' for _ in batch)
                        # Already-bound rows retain their live delivery leases.
                        mail.execute(f'UPDATE messages SET generation=?, lease_expires=NULL, lease_token=NULL '
                                     f'WHERE id IN ({marks}) AND to_task=? AND delivered_at IS NULL '
                                     'AND (generation IS NOT ? OR lease_token LIKE ?)',
                                     (record['claimedGeneration'], *batch, task_id, record['claimedGeneration'],
                                      messages.CONTINUATION_TOKEN + '%'))
                finally:
                    mail.close()
        finally:
            con.close()

    def _spawn(self, task_id, message, generation):
        # Compatibility seam: synchronous control returns an owned pending receipt.
        run, error = self._card_owner(task_id)
        if run is None:
            raise ValueError(error)
        return self._accept(task_id, message, generation, uuid.uuid4().hex, run['workspace'])[0]

    def _queue(self, task_id, message, generation, execution_id, workspace):
        pending = _PendingLaunch(self, task_id, message, generation, execution_id, workspace)
        self._pending[execution_id] = pending
        self.scope.pending_launches.add(pending)
        pending.start()
        self._ensure_monitor()

    def _launch(self, pending):
        from .model_policy import ModelPolicyPaused
        task_id = pending.task_id
        try:
            while not pending.cancelled.is_set():
                with self.registry_lock:
                    record = self._registry().get(task_id, {})
                    if record.get('executionId') != pending.execution_id or record.get('state') != 'pending':
                        return
                try:
                    binding = {**self.scope.policy.guard_model(role='sister'), 'role': 'sister'}
                    break
                except ModelPolicyPaused:
                    if self.scope.policy.snapshot(role='sister')['state'] == 'failed':
                        raise ValueError('The team model boundary needs a retry')
                    pending.cancelled.wait(.05)
            else:
                return
            # Model waiting may have crossed a root/generation boundary; recheck
            # immediately before spawn, then the worker still uses the real claim CAS.
            run, error = self._card_owner(task_id)
            if run is None:
                raise ValueError(error)
            from misaka.core.platform import tasks
            con = tasks.connect(self.scope.current_config()['db'])
            try:
                row = tasks.get(con, task_id)
                if row is None or int(row['generation']) != pending.generation:
                    raise ValueError('The card generation changed while launch was pending')
            finally:
                con.close()
            with self.registry_lock:
                records = self._registry()
                record = records.get(task_id, {})
                if pending.cancelled.is_set() or record.get('state') != 'pending' or record.get('executionId') != pending.execution_id:
                    return
                launch_id = self.scope.record_launch(binding)
                log_dir = Path(self.scope.team.directory) / 'continuations'
                log_dir.mkdir(parents=True, exist_ok=True)
                written = writePromptToTempFile(task_id, pending.message)
                self.prompt_files[task_id] = written
                argv = [sys.executable, '-m', 'misaka.desktop_research.worker_entry',
                        '--policy', str(self.scope.team.model_policy.path),
                        '--epoch', str(binding['epoch']), '--provider', binding['provider'],
                        '--model', binding['modelId'], '--launch-id', launch_id, '--lane', 'card',
                        '--role', 'sister',
                        '--', '--run-card', task_id, '--say-file', written[1],
                        '--expected-generation', str(pending.generation), '--consult']
                with open(log_dir / f'{task_id}-{launch_id}.log', 'a', encoding='utf-8') as log:
                    process = subprocess.Popen(argv, cwd=workspace_path(run),
                        env={**os.environ, 'MISAKA_DESKTOP_CONTINUATION': task_id,
                             'MISAKA_DESKTOP_CONTINUATION_EXECUTION_ID': pending.execution_id},
                        stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
                self.continuations[task_id] = process
                self.launches[task_id] = launch_id
                from misaka.core.platform import processes
                record.update(state='running', pid=process.pid, identity=processes.identity(process.pid))
                atomic_json(self.registry_path, records)
        except Exception as error:  # noqa: BLE001 - pending launch failure is persisted for retry
            removePromptFile(self.prompt_files.pop(task_id, None))
            with self.registry_lock:
                records = self._registry()
                record = records.get(task_id, {})
                if record.get('executionId') == pending.execution_id and record.get('state') == 'pending':
                    record.update(state='failed', errorCode='DESKTOP_CONTINUATION_FAILED', errorClass=type(error).__name__)
                    atomic_json(self.registry_path, records)
        finally:
            self.scope.pending_launches.discard(pending)
            self._pending.pop(pending.execution_id, None)

    def _ensure_monitor(self):
        with self._monitor_lock:
            if self._monitor_stop.is_set() or (self._monitor_thread is not None and self._monitor_thread.is_alive()):
                return
            self._monitor_thread = threading.Thread(target=self._monitor, daemon=True,
                                                    name="desktop-consultation-recovery")
            self._monitor_thread.start()

    def _monitor(self):
        while not self._monitor_stop.wait(REAP_INTERVAL_SECONDS):
            try:
                self._reap()
            except Exception:  # A failed poll must not lose the persisted recovery intent.
                _LOG.exception("Desktop consultation recovery needs another poll")

    def _retry_consultation(self, task_id, record):
        """Requeue only this dead execution's undelivered inbox, within a persisted retry limit."""
        if not record.get('consult', record.get('claimIntent', {}).get('consult', False)):
            return None
        from misaka.core.network import messages
        from misaka.core.platform import tasks
        config = self.scope.current_config()
        con = tasks.connect(config['db'])
        try:
            row = tasks.get(con, task_id)
            generation = int(record['generation'])
            if row is None or int(row['generation']) != generation or row['status'] not in tasks.CONSULTABLE:
                return None
            live = tasks.live_consultation(con, task_id)
            if live is not None:
                intent = record.get('claimIntent', {})
                if (live['claim_lock'] != record.get('claimLock', intent.get('claimLock'))
                        or live['pid'] != intent.get('pid')
                        or live['process_identity'] != intent.get('identity')):
                    return None  # Another process's consultation cannot be interrupted.
                tasks.end_consultation(con, live['id'], live['claim_lock'], 'failed',
                                       reason='Desktop consultation worker exited before delivery')
            mail = messages.connect(config.get('messages_db'))
            try:
                ids = {str(value) for value in record.get('requests', []) if str(value).isdigit()}
                pending = [str(item['id']) for item in mail.execute(
                    "SELECT id,lease_token FROM messages WHERE to_task=? AND generation=? AND delivered_at IS NULL",
                    (task_id, generation))
                    if str(item['id']) in ids or str(item['lease_token'] or '').startswith(messages.CONTINUATION_TOKEN)]
            finally:
                mail.close()
            if not pending:
                return None
            retries = int(record.get('automaticRetries', 0))
            if retries >= MAX_AUTOMATIC_RETRIES:
                record.update(state='failed', errorCode='DESKTOP_CONTINUATION_RETRY_LIMIT')
                return None
            execution_id = uuid.uuid4().hex
            record.update(state='pending', executionId=execution_id, requests=pending,
                          automaticRetries=retries + 1, ownerPid=os.getpid(),
                          ownerIdentity=self._owner_identity())
            for field in ('claimIntent', 'claimLock', 'claimedGeneration', 'consultationId', 'pid', 'identity'):
                record.pop(field, None)
            return (task_id, "Read the newly queued task inbox messages and answer their questions.",
                    generation, execution_id, record['workspace'])
        finally:
            con.close()

    def _reap(self):
        from misaka.core.platform import processes
        launches = []
        with self.registry_lock:
            records = self._registry()
            changed = False
            for task_id, record in records.items():
                if record.get('state') == 'pending':
                    pid, birth = record.get('ownerPid'), record.get('ownerIdentity')
                    if pid and birth and not processes.identity_is_alive(pid, birth):
                        record.update(state='failed', errorCode='DESKTOP_LAUNCH_OWNER_LOST')
                        changed = True
                        launch = self._retry_consultation(task_id, record)
                        if launch is not None:
                            launches.append(launch)
                    continue
                if record.get('state') == 'settled':
                    # A previous host may have reaped the process before it could queue recovery.
                    launch = self._retry_consultation(task_id, record)
                    if launch is not None:
                        launches.append(launch)
                        changed = True
                    elif record.get('state') == 'failed':
                        changed = True
                    continue
                if record.get('state') != 'running':
                    continue
                process = self.continuations.get(task_id)
                dead = process is not None and process.poll() is not None
                if process is None and record.get('pid') and record.get('identity'):
                    dead = not processes.identity_is_alive(record['pid'], record['identity'])
                if dead:
                    record['state'] = 'settled'
                    changed = True
                    removePromptFile(self.prompt_files.pop(task_id, None))
                    self.continuations.pop(task_id, None)
                    self.launches.pop(task_id, None)
                    launch = self._retry_consultation(task_id, record)
                    if launch is not None:
                        launches.append(launch)
            if changed:
                atomic_json(self.registry_path, records)
        for launch in launches:
            if not self._monitor_stop.is_set():
                self._queue(*launch)

    def stop_all(self):
        """Every continued card of this scope dies with it; the claim is left to reconcile."""
        from misaka.core.platform import processes

        self._monitor_stop.set()
        pending = list(self._pending.values())
        for launch in pending:
            launch.cancelled.set()
        with self.registry_lock:
            records = self._registry()
            owned = [(task_id, dict(record)) for task_id, record in records.items()
                     if record.get('state') in {'pending', 'running'}]
            for task_id, record in owned:
                records[task_id]['state'] = 'cancelled'
            atomic_json(self.registry_path, records)
        for launch in pending:
            launch.thread.join(5)
            if launch.thread.is_alive():
                raise RuntimeError('Continuation launch settlement pending')
        stopped = []
        for task_id, record in owned:
            pid = record.get('pid')
            identity = record.get('identity')
            if pid and identity and processes.identity_is_alive(pid, identity):
                processes.terminate(pid)
                stopped.append(task_id)
            process = self.continuations.get(task_id)
            if process is not None and process.poll() is None:
                try:
                    process.wait(5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(5)
            removePromptFile(self.prompt_files.pop(task_id, None))
            self.continuations.pop(task_id, None)
            self.launches.pop(task_id, None)
        return stopped


def workspace_path(run):
    return str(Path(run['workspace']).resolve())


class _PendingLaunch:
    def __init__(self, control, task_id, message, generation, execution_id, workspace):
        self.control, self.task_id, self.message = control, task_id, message
        self.generation, self.execution_id = generation, execution_id
        self.cancelled = threading.Event()
        self.thread = threading.Thread(target=control._launch, args=(self,), daemon=True)

    def start(self):
        self.thread.start()
