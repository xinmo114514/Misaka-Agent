"""Recoverable card projections. Locks precede SQL; failed replacement aborts SQL.

One intent per card/outer transaction retains the original backup across repeated writes.
The exact operation marker commits with the CAS. Recovery is generation fenced and keeps
conflicting intents for diagnosis rather than overwriting externally modified files.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import uuid
import weakref
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

from filelock import FileLock

LOCK_TIMEOUT = 1.8
JOURNAL_SUFFIX = ".card-projection.json"
_HELD = ContextVar("card_publication_locks", default=None)
_PREPARED = ContextVar("card_prepared_candidates", default=None)
_LIVE_STAGES = weakref.WeakValueDictionary()
_PENDING = {}  # id(connection) -> live outer transaction intents; removed by finish


def pending_for(con):
    return _PENDING.get(id(con), {})


def journal_path(path):
    return Path(path).with_name("." + Path(path).name + JOURNAL_SUFFIX)


def _digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def _read_bytes(path):
    try:
        return Path(path).read_bytes()
    except FileNotFoundError:
        return None


def _lock_dir(task_id):
    from misaka.core.platform import tasks
    directory = tasks.task_state_dir(task_id)
    os.makedirs(directory, exist_ok=True)
    return directory


@contextmanager
def lock_cards(task_ids, *, timeout=LOCK_TIMEOUT):
    held = (_HELD.get() or {})
    acquired = []
    mapping = dict(held)
    token = None
    try:
        for task_id in sorted(set(task_ids)):
            if task_id in mapping:
                continue
            lock = FileLock(os.path.join(_lock_dir(task_id), "card.lock"), timeout=timeout)
            lock.acquire()
            acquired.append(lock)
            mapping[task_id] = lock
        token = _HELD.set(mapping)
        yield
    finally:
        if token is not None:
            _HELD.reset(token)
        for lock in reversed(acquired):
            lock.release()


def locks_held():
    return bool(_HELD.get() or {})


def invalidate_preparation(task_id):
    cache = _PREPARED.get()
    if cache is not None:
        cache.pop(task_id, None)


def _field_key(fields):
    return json.dumps(fields, sort_keys=True, default=str)


@contextmanager
def prepare_cards(con, task_ids, *, field_updates=None, targets=None):
    """Prewrite exact static-contract candidates before the outer SQL writer.

    Conditional transitions select a prepared status/generation candidate, never
    parse, serialize, hash, or write a temporary file under BEGIN IMMEDIATE.
    Generation candidates cover the current generation and one explicit reopen;
    larger composite resets must provide their projection at a new transaction boundary.
    """
    if _PREPARED.get() is not None or not task_ids:
        yield
        return
    if con.in_transaction:
        # Caller-owned raw BEGIN is supported by the legacy immediate-lock path;
        # prepared outer transactions use tasks.write_txn instead.
        yield
        return
    from misaka.core.platform import cards, tasks
    from misaka.utils.frontmatter import parseFrontmatter as parse_frontmatter
    cache = {}
    files = []
    token = None
    try:
        for task_id in task_ids:
            row = tasks.get(con, task_id)
            if row is None:
                continue
            path = Path(cards.card_path(row['workspace'], task_id))
            if journal_path(path).exists():
                live = _LIVE_STAGES.get(task_id)
                if live is not None and not live.done:
                    continue  # an explicit caller is about to commit this prepared intent
                result = settle(con, row['workspace'], task_id)
                if result in {'conflict', 'pending'}:
                    raise RuntimeError('Card projection recovery conflict')
            previous = _read_bytes(path)
            if previous is None:
                continue
            parsed = parse_frontmatter(previous.decode('utf-8'))
            original_fields = dict(parsed.frontmatter or {})
            body = parsed.body or ''
            operation = uuid.uuid4().hex
            base_intent = {'taskId': task_id, 'operationId': operation, 'path': str(path),
                           'expectedGeneration': int(row['generation']),
                           'claimFence': row['claim_lock'],
                           'oldDigest': _digest(previous),
                           'previous': base64.b64encode(previous).decode('ascii')}
            candidates = {}
            field_sets = [original_fields]
            if field_updates and task_id in field_updates:
                field_sets.append({**original_fields, **field_updates[task_id]})
            transitions = (targets or {}).get(task_id)
            if transitions is None:
                transitions = [(status, offset) for offset in (0, 1)
                    for status in dict.fromkeys([original_fields.get('status'), 'ready', 'todo', 'done',
                                                'stopped', 'failed', 'review', 'blocked', 'triage'])]
            for fields in field_sets:
                for status, offset in transitions:
                        generation = int(row['generation']) + offset
                        changed = {**fields, 'generation': generation}
                        if status is not None:
                            changed['status'] = status
                        candidate_key = _field_key(changed)
                        if candidate_key in candidates:
                            continue  # An unchanged field update reuses the exact candidate.
                        data = cards._dump(changed, body).encode('utf-8')
                        stage_path = path.with_name('.' + path.name + '.' + operation + '.' + str(len(candidates)) + '.stage')
                        intent_path = stage_path.with_suffix(JOURNAL_SUFFIX + '.intent')
                        files.extend([stage_path, intent_path])
                        with open(stage_path, 'xb') as handle:
                            handle.write(data)
                            handle.flush()
                            os.fsync(handle.fileno())
                        intent = {**base_intent, 'stage': str(stage_path), 'generation': generation,
                                  'newStatus': status, 'newDigest': _digest(data),
                                  'next': base64.b64encode(data).decode('ascii')}
                        intent_path.write_text(json.dumps(intent), encoding='utf-8')
                        with open(intent_path, 'r+b') as handle:
                            os.fsync(handle.fileno())
                        candidates[candidate_key] = (stage_path, intent_path, intent)
            cache[task_id] = {'fields': original_fields, 'body': body, 'candidates': candidates}
        token = _PREPARED.set(cache)
        yield
    finally:
        if token is not None:
            _PREPARED.reset(token)
        for path in files:
            path.unlink(missing_ok=True)


def _use_prepared(con, task_id, mutate):
    cached = (_PREPARED.get() or {}).get(task_id)
    if cached is None:
        return None
    from misaka.core.platform import tasks
    fields, body = dict(cached['fields']), cached['body']
    if mutate is not None:
        fields, body = mutate(fields, body)
    candidate = cached['candidates'].get(_field_key(fields))
    if candidate is None or body != cached['body']:
        raise RuntimeError('Card transition needs an explicitly prepared projection')
    stage_path, intent_path, intent = candidate
    pending = pending_for(con)
    prepared = pending.get(task_id)
    if prepared is None:
        prepared = PreparedCard(path=intent['path'], stage=stage_path,
                                journal=journal_path(intent['path']), intent=dict(intent))
        _PENDING.setdefault(id(con), {})[task_id] = prepared
        tasks.on_transaction_end(con, lambda: prepared.finish(con))
    else:
        prepared.stage = stage_path
        prepared.intent = dict(intent)
        prepared.generation = int(intent['generation'])
    # Both source files were fully written/fsynced before BEGIN. Only atomic
    # renames and SQL marker writes remain in the critical section.
    os.replace(intent_path, prepared.journal)
    cached['fields'] = fields
    return prepared


class PreparedCard:
    def __init__(self, *, path, stage, journal, intent, lock=None):
        self.path, self.stage, self.journal = Path(path), Path(stage), Path(journal)
        self.intent = intent
        self.operation = intent["operationId"]
        self.task_id = intent["taskId"]
        self.generation = intent["generation"]
        self.deferred, self.done = False, False
        self._held_lock = lock

    def publish(self, con):
        """Replacement failure still occurs before the enclosing SQL commit."""
        from misaka.core.platform import tasks
        row = tasks.get(con, self.task_id)
        if row is None or int(row['generation']) != int(self.generation):
            raise RuntimeError('Card projection generation changed before publication')
        # A transaction can publish several intermediate candidates. SQL rollback
        # erases its markers, so retain the actually attempted digests independently
        # before each replacement; recovery must recognize our first intermediate
        # file when a later replacement fails, without accepting arbitrary edits.
        history = Path(self.intent.get('publishedPath') or
                       str(self.path.with_name('.' + self.path.name + '.' + self.operation + '.published')))
        with open(history, 'ab') as handle:
            handle.write((self.intent['newDigest'] + '\n').encode('ascii'))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(self.stage, self.path)
        if not tasks.add_event(con, self.task_id, "card_projection_committed",
                               {"operationId": self.operation, "claimFence": row['claim_lock']}, generation=self.generation):
            raise RuntimeError("Card projection generation changed before its marker")

    def commit_fast(self, con, outcome=None):
        # Compatibility for callers that prepared outside SQL. Marker, not a missing
        # callback outcome, decides recovery; publish is never a postcommit finalizer.
        if self.done:
            return
        token = None
        if self._held_lock is not None:
            token = _HELD.set({**(_HELD.get() or {}), self.task_id: self._held_lock})
        try:
            settle(con, str(self.path.parent.parent), self.task_id)
        finally:
            if token is not None:
                _HELD.reset(token)
            self._release()

    def finish(self, con):
        if self.done:
            return
        pending = pending_for(con)
        pending.pop(self.task_id, None)
        if not pending:
            _PENDING.pop(id(con), None)
        self.commit_fast(con)
        self.done = not self.journal.exists()

    def abort_fast(self):
        self._release()
        self.stage.unlink(missing_ok=True)
        self.journal.unlink(missing_ok=True)
        self.done = True

    def _release(self):
        if self._held_lock is not None:
            self._held_lock.release()
            self._held_lock = None


def stage(workspace, task_id, mutate, *, generation, new_status, con=None):
    from misaka.core.platform import cards, tasks
    from misaka.utils.frontmatter import parseFrontmatter as parse_frontmatter
    path = Path(cards.card_path(workspace, task_id))
    if con is not None and con.in_transaction:
        prepared = _use_prepared(con, task_id, mutate)
        if prepared is not None:
            return prepared
    pending = pending_for(con) if con is not None else {}
    prepared = pending.get(task_id)
    lock = None
    if prepared is None:
        if task_id not in (_HELD.get() or {}):
            # Inside a caller-owned writer, fail immediately rather than waiting with SQL.
            lock = FileLock(os.path.join(_lock_dir(task_id), "card.lock"),
                            timeout=0 if con is not None and con.in_transaction else LOCK_TIMEOUT)
            lock.acquire()
        if journal_path(path).exists():
            if con is None:
                if lock is not None:
                    lock.release()
                raise RuntimeError("Card projection recovery pending")
            result = settle(con, workspace, task_id)
            if result in {"conflict", "pending"}:
                if lock is not None:
                    lock.release()
                raise RuntimeError("Card projection recovery conflict")
    new_stage = None
    intent_stage = None
    try:
        previous = _read_bytes(path)
        if previous is None:
            raise FileNotFoundError(str(path))
        parsed = parse_frontmatter(previous.decode("utf-8"))
        fields, body = dict(parsed.frontmatter or {}), parsed.body or ""
        old_generation = int(fields.get("generation", generation))
        if mutate is not None:
            fields, body = mutate(fields, body)
        data = cards._dump(fields, body).encode("utf-8")
        new_stage = path.with_name("." + path.name + "." + uuid.uuid4().hex + ".stage")
        new_stage.write_bytes(data)
        with open(new_stage, 'r+b') as handle:
            os.fsync(handle.fileno())
        row = tasks.get(con, task_id) if con is not None else None
        if prepared is None:
            intent = {"taskId": task_id, "operationId": uuid.uuid4().hex,
                      "path": str(path), "generation": int(generation),
                      "expectedGeneration": old_generation,
                      "claimFence": row["claim_lock"] if row is not None else None,
                      "newStatus": new_status, "oldDigest": _digest(previous),
                      "previous": base64.b64encode(previous).decode("ascii")}
            prepared = PreparedCard(path=path, stage=new_stage, journal=journal_path(path),
                                    intent=intent, lock=lock)
        else:
            prepared.stage.unlink(missing_ok=True)
        prepared.stage = new_stage
        prepared.generation = int(generation)
        prepared.intent.update(stage=str(new_stage), generation=int(generation),
                               newStatus=new_status, newDigest=_digest(data),
                               claimFence=row["claim_lock"] if row is not None else None)
        # Write before replacement; a crash here leaves the authoritative file untouched.
        intent_stage = prepared.journal.with_name(prepared.journal.name + '.' + uuid.uuid4().hex + '.tmp')
        intent_stage.write_text(json.dumps(prepared.intent), encoding="utf-8")
        with open(intent_stage, 'r+b') as handle:
            os.fsync(handle.fileno())
        os.replace(intent_stage, prepared.journal)
        if con is not None and con.in_transaction and task_id not in pending:
            _PENDING.setdefault(id(con), {})[task_id] = prepared
            tasks.on_transaction_end(con, lambda: prepared.finish(con))
        if con is None:
            _LIVE_STAGES[task_id] = prepared
            prepared._release()
        return prepared
    except BaseException:
        if intent_stage is not None:
            intent_stage.unlink(missing_ok=True)
        if new_stage is not None:
            # A successfully installed intent owns its material until recovery.
            try:
                recorded = json.loads(journal_path(path).read_text(encoding='utf-8'))
            except (OSError, ValueError):
                recorded = {}
            if recorded.get('stage') != str(new_stage):
                new_stage.unlink(missing_ok=True)
        if lock is not None:
            lock.release()
        raise


def settle(con, workspace, task_id):
    from misaka.core.platform import cards
    path = Path(cards.card_path(workspace, task_id))
    journal = journal_path(path)
    if not journal.exists():
        return None
    # A live transaction owns its intent; recovery must not undo an uncommitted marker.
    if task_id in pending_for(con):
        return "pending"
    with lock_cards([task_id], timeout=0 if con.in_transaction else LOCK_TIMEOUT):
        intent = json.loads(journal.read_text(encoding="utf-8"))
        if str(Path(intent["path"]).resolve()) != str(path.resolve()):
            return "conflict"
        row = con.execute("SELECT generation,claim_lock FROM tasks WHERE id=?", (task_id,)).fetchone()
        markers = con.execute("SELECT payload FROM events WHERE task_id=? AND "
                              "kind='card_projection_committed'", (task_id,)).fetchall()
        committed = False
        committed_claim = None
        for marker in markers:
            try:
                payload = json.loads(marker[0] or '{}')
                if payload.get('operationId') == intent['operationId']:
                    committed = True
                    committed_claim = payload.get('claimFence')
            except (TypeError, ValueError):
                continue
        expected = intent["generation"] if committed else intent.get("expectedGeneration", intent["generation"])
        if row is None or int(row[0]) != int(expected):
            return "conflict"
        if committed and row[1] != committed_claim:
            return "conflict"
        current = _digest(_read_bytes(path))
        history = path.with_name('.' + path.name + '.' + intent['operationId'] + '.published')
        published = set((_read_bytes(history) or b'').decode('ascii').splitlines())
        if current not in {intent.get("oldDigest"), intent.get("newDigest"), *published}:
            return "conflict"
        target = intent.get("newDigest") if committed else intent.get("oldDigest")
        if current != target:
            if committed:
                material = Path(intent['stage'])
                data = material.read_bytes() if material.exists() else base64.b64decode(intent['next'])
            else:
                data = base64.b64decode(intent['previous'])
            # An atomic recovery replacement; any IO failure retains all materials.
            recovery = path.with_name("." + path.name + ".recovery")
            recovery.write_bytes(data)
            os.replace(recovery, path)
        Path(intent["stage"]).unlink(missing_ok=True)
        journal.unlink(missing_ok=True)
        history.unlink(missing_ok=True)
        live = _LIVE_STAGES.pop(task_id, None)
        if live is not None:
            live.done = True
        cards._forget(str(path))
        return "recovered" if committed else "rolled-back"


def recover_pending(con, workspace):
    root = Path(workspace)
    if not root.is_dir():
        return []
    outcomes = []
    for journal in root.rglob("*" + JOURNAL_SUFFIX):
        intent = json.loads(journal.read_text(encoding="utf-8"))
        task_id = intent.get("taskId")
        if isinstance(task_id, str):
            outcome = settle(con, workspace, task_id)
            if outcome:
                outcomes.append((task_id, outcome))
    return outcomes
