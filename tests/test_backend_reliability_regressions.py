"""Isolated regression proofs for the second reliability review."""
import asyncio
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace

import pytest

from misaka.core.platform import card_publication, cards, tasks
from misaka.desktop_research.model_policy import DesktopTeamModelPolicy
from misaka.desktop_research.runtime import DesktopExecutionScope, install_model_binding


@pytest.fixture
def board(tmp_path, monkeypatch):
    from misaka.core.platform import repo
    monkeypatch.setenv('MISAKA_HOME', str(tmp_path / 'home'))
    monkeypatch.setattr(repo, 'enabled', lambda *a: False)
    with closing(tasks.connect(str(tmp_path / 'board.db'))) as con:
        yield con


def card(board, tmp_path):
    workspace = tmp_path / 'workspace'
    workspace.mkdir(exist_ok=True)
    tid = cards.create(board, str(workspace), 'Fixture', 'body', 'fixture')
    return tid, workspace, Path(cards.card_path(str(workspace), tid))


def test_sqlite_context_rollback_preserves_file(board, tmp_path):
    tid, _workspace, path = card(board, tmp_path)
    before = path.read_bytes()
    with pytest.raises(RuntimeError, match='abort'), board:
        board.execute('BEGIN IMMEDIATE')
        assert tasks.mark_stopped(board, tid)
        raise RuntimeError('abort')
    assert tasks.get(board, tid)['status'] == 'ready'
    assert path.read_bytes() == before
    assert not card_publication.journal_path(path).exists()


def test_two_same_card_transitions_keep_latest_file(board, tmp_path):
    tid, workspace, path = card(board, tmp_path)
    with tasks.write_txn(board):
        assert tasks.mark_stopped(board, tid)
        assert tasks.reopen_task(board, tid, target_status='ready')
    assert tasks.get(board, tid)['generation'] == 2
    assert cards.read(str(path))['fields']['generation'] == 2
    assert cards.read(str(path))['fields']['status'] == 'ready'
    assert not list(workspace.rglob('*.stage'))
    assert not card_publication.journal_path(path).exists()


def test_projection_replace_failure_rolls_back_sql(board, tmp_path, monkeypatch):
    tid, _workspace, path = card(board, tmp_path)
    before = path.read_bytes()
    def fail(*args):
        raise OSError('fixture replace failure')
    monkeypatch.setattr(card_publication.os, 'replace', fail)
    with pytest.raises(OSError, match='fixture replace failure'):
        tasks.mark_stopped(board, tid)
    assert tasks.get(board, tid)['status'] == 'ready'
    assert path.read_bytes() == before


async def test_startup_cancel_finds_real_controller_session(tmp_path):
    scope = DesktopExecutionScope.__new__(DesktopExecutionScope)
    task = asyncio.create_task(asyncio.sleep(30))
    part = SimpleNamespace(_starts={task})
    scope.controller = SimpleNamespace(session=SimpleNamespace(moments=SimpleNamespace(parts=[part])))
    scope.sessions = {}
    try:
        results = await scope.cancel_startup_now()
        assert task.done()
        assert len(results) == 1
        assert isinstance(results[0], asyncio.CancelledError)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


def bound_fixture(tmp_path):
    scope = DesktopExecutionScope.__new__(DesktopExecutionScope)
    scope.policy = DesktopTeamModelPolicy(tmp_path / 'policy.json', 'fixture', 'model')
    scope.role = 'last_order'
    scope.team = SimpleNamespace(role_thinking=lambda role: None)
    scope.sessions, scope.idle_jobs, scope.releasing = {}, {}, {}
    model = SimpleNamespace(provider='fixture', id='model', api='fixture')
    class Registry:
        def find(self, provider, model_id):
            return model
        async def checkConfiguredAuth(self, model):
            return True
    class Stream:
        async def result(self):
            return 'completed'
        async def aclose(self):
            pass
    session = SimpleNamespace(model=model, modelRegistry=Registry(),
                              agent=SimpleNamespace(streamFn=lambda *a: Stream()))
    scope.sessions[id(session)] = session
    install_model_binding(session, scope.policy, 'root', scope)
    return scope, session


async def test_failed_stream_release_remains_retryable_and_owned(tmp_path, monkeypatch):
    scope, session = bound_fixture(tmp_path)
    stream = await session.agent.streamFn(None, {})
    original = scope.policy.end_request
    def fail(ticket):
        raise OSError('fixture store unavailable')
    monkeypatch.setattr(scope.policy, 'end_request', fail)
    with pytest.raises(OSError, match='fixture store unavailable'):
        await stream.aclose()
    assert stream in session._desktop_active_streams
    monkeypatch.setattr(scope.policy, 'end_request', original)
    assert await scope.release_session(session, timeout=1) == 'settled'
    assert scope.policy._read()['requests'] == {}


async def test_close_tracks_opening_stream_and_prevents_late_admission(tmp_path):
    scope, session = bound_fixture(tmp_path)
    started, blocked = asyncio.Event(), asyncio.Event()
    async def transport(*args):
        started.set()
        await blocked.wait()
    opening = asyncio.create_task(session.agent.streamFn(None, {}, _transport=transport))
    try:
        await started.wait()
        # The bounded API may report pending while its shielded settlement keeps
        # running; this test checks lifecycle ownership, not a 50 ms disk SLA.
        assert await scope.release_session(session, timeout=.05) in {'settled', 'cleanup_pending'}
        with pytest.raises(asyncio.CancelledError):
            await session.agent.streamFn(None, {})
        assert await scope.release_session(session, timeout=1) == 'settled'
        assert opening.done() and opening.cancelled()
        assert id(session) not in scope.sessions
        state = scope.policy._read()
        assert state['requests'] == {} and state['executors'] == {}
    finally:
        opening.cancel()
        await asyncio.gather(opening, return_exceptions=True)


async def test_cancelled_stream_consumer_signals_the_request_before_drain(tmp_path):
    """A stop lands while the session waits on its own model request.

    The consumer's cancellation must raise this request's door before joining the producer, so
    the ticket releases after the finalizer drains -- not never (2026-10-19 stop hang).
    """
    from misaka.ai.types import AssistantMessage, ErrorEvent
    from misaka.ai.utils.event_stream import (
        AssistantMessageEventStream,
        spawn_stream_task,
    )
    scope, session = bound_fixture(tmp_path)
    transport_seen = {}
    upstream = SimpleNamespace(aborted=False)
    body_done, producer_done = asyncio.Event(), asyncio.Event()

    async def transport(_model, _context, options):
        transport_seen['signal'] = options['signal']
        stream = AssistantMessageEventStream()

        async def producer():
            await body_done.wait()
            reply = AssistantMessage(content=[], api='fixture', provider='fixture', model='model',
                stopReason='aborted', timestamp=1,
                usage={'input': 1, 'output': 1, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 2,
                       'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0}})
            stream.push(ErrorEvent(reason='aborted', error=reply))
            stream.end(reply)
            producer_done.set()
        spawn_stream_task(producer(), stream=stream)
        return stream

    stream = await session.agent.streamFn(None, {}, {'signal': upstream}, _transport=transport)
    assert scope.policy._read()['requests']

    async def consume():
        async for _event in stream:
            pass
    consumer = asyncio.create_task(consume())
    await asyncio.sleep(.02)
    consumer.cancel()
    await asyncio.sleep(.02)
    assert transport_seen['signal'] is not upstream and transport_seen['signal'].aborted
    assert not upstream.aborted
    assert scope.policy._read()['requests'], 'release waits for the producer'
    body_done.set()
    with pytest.raises(asyncio.CancelledError):
        await consumer
    assert producer_done.is_set()
    while scope.policy._read()['requests']:
        await asyncio.sleep(.01)
    assert await scope.release_session(session, timeout=2) == 'settled'


async def test_cancelled_result_waiter_keeps_finalizer_before_release(tmp_path):
    """A cancelled result waiter aborts its request but still joins the running finalizer."""
    from misaka.ai.types import AssistantMessage, DoneEvent
    from misaka.ai.utils.event_stream import (
        AssistantMessageEventStream,
        spawn_stream_task,
    )
    scope, session = bound_fixture(tmp_path)
    transport_seen = {}
    finalizer_done, finalizer_hold = asyncio.Event(), asyncio.Event()

    async def transport(_model, _context, options):
        transport_seen['signal'] = options['signal']
        stream = AssistantMessageEventStream()
        reply = AssistantMessage(content=[], api='fixture', provider='fixture', model='model',
            stopReason='stop', timestamp=1,
            usage={'input': 1, 'output': 1, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 2,
                   'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0}})

        async def producer():
            stream.push(DoneEvent(reason='stop', message=reply))
            stream.end(reply)
            finalizer_done.set()
            await finalizer_hold.wait()
        spawn_stream_task(producer(), stream=stream)
        return stream

    stream = await session.agent.streamFn(None, {}, _transport=transport)
    waiter = asyncio.create_task(stream.result())
    await finalizer_done.wait()
    await asyncio.sleep(.02)
    waiter.cancel()
    await asyncio.sleep(.02)
    assert transport_seen['signal'].aborted
    assert scope.policy._read()['requests'], 'release waits for the running finalizer'
    finalizer_hold.set()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    while scope.policy._read()['requests']:
        await asyncio.sleep(.01)
    assert await scope.release_session(session, timeout=2) == 'settled'

def test_plain_sqlite_transaction_rollback_preserves_file(board, tmp_path):
    import sqlite3
    tid, _workspace, path = card(board, tmp_path)
    before = path.read_bytes()
    with closing(sqlite3.connect(str(tmp_path / 'board.db'), isolation_level=None)) as plain:
        plain.row_factory = tasks.Row
        with pytest.raises(RuntimeError, match='abort'), tasks.write_txn(plain):
            assert tasks.mark_stopped(plain, tid)
            raise RuntimeError('abort')
    assert tasks.get(board, tid)['status'] == 'ready'
    assert path.read_bytes() == before


async def test_begin_closing_store_failure_retains_retryable_session(tmp_path, monkeypatch):
    scope, session = bound_fixture(tmp_path)
    original = scope.policy.begin_closing
    def fail(*args):
        raise OSError('fixture closing write failed')
    monkeypatch.setattr(scope.policy, 'begin_closing', fail)
    assert await scope.release_session(session, timeout=.01) == 'cleanup_pending'
    assert id(session) in scope.sessions
    monkeypatch.setattr(scope.policy, 'begin_closing', original)
    assert await scope.release_session(session, timeout=1) == 'settled'


async def test_absent_executor_settlement_removes_owned_callback(tmp_path):
    scope, session = bound_fixture(tmp_path)
    state = scope.policy._read()
    state['executors'] = {}
    scope.policy._write(state)
    assert await scope.release_session(session, timeout=1) == 'settled'
    assert scope.policy._callbacks == {}


def test_failed_journal_write_leaves_no_orphan_stage(board, tmp_path, monkeypatch):
    tid, workspace, _path = card(board, tmp_path)
    original = Path.write_text
    def fail_journal(self, *args, **kwargs):
        if card_publication.JOURNAL_SUFFIX in self.name:
            raise OSError('fixture intent write failure')
        return original(self, *args, **kwargs)
    monkeypatch.setattr(Path, 'write_text', fail_journal)
    with pytest.raises(OSError, match='fixture intent write failure'):
        tasks.mark_stopped(board, tid)
    assert tasks.get(board, tid)['status'] == 'ready'
    assert not list(workspace.rglob('*.stage'))
    # The file lock is reusable even when preparation fails before callback registration.
    with card_publication.lock_cards([tid], timeout=0):
        pass


@pytest.mark.parametrize('operation', ['mark_stopped', 'outer', 'reopen', 'claim_resume', 'submit', 'promote', 'native_stop'])
def test_slow_card_serialization_happens_before_sql_writer(board, tmp_path, monkeypatch, operation):
    import threading
    tid, workspace, _path = card(board, tmp_path)
    if operation in {'reopen', 'claim_resume'}:
        assert tasks.mark_stopped(board, tid)
    elif operation == 'submit':
        assert tasks.claim(board, tid, 'fixture-claim', generation=1)
    elif operation == 'promote':
        assert tasks.block_task(board, tid, kind='transient', reason='fixture')
        assert tasks.unblock_task(board, tid)
        board.execute("UPDATE tasks SET status='todo' WHERE id=?", (tid,))
        cards.set_fields(str(workspace), tid, status='todo')
    entered, release = threading.Event(), threading.Event()
    original = cards._dump
    def slow_dump(*args):
        entered.set()
        assert release.wait(5), 'test preparation barrier was not released'
        return original(*args)
    monkeypatch.setattr(cards, '_dump', slow_dump)
    errors = []
    def transition():
        try:
            if operation == 'outer':
                with tasks.write_txn(board, card_ids=[tid]):
                    tasks.mark_stopped(board, tid)
            elif operation == 'reopen':
                tasks.reopen_task(board, tid)
            elif operation == 'claim_resume':
                tasks.claim_resume(board, tid, 'resume-claim', None, expected_generation=1, consult=True)
            elif operation == 'submit':
                tasks.submit_task(board, tid, generation=1, claim_lock='fixture-claim')
            elif operation == 'promote':
                tasks.promote_task(board, tid)
            elif operation == 'native_stop':
                from misaka.core.research import workflow
                workflow._stop_pending(board, [tasks.get(board, tid)])
            else:
                tasks.mark_stopped(board, tid)
        except Exception as error:  # noqa: BLE001 - report every fixture-thread failure to the asserting test
            errors.append(error)
    other = tasks.connect(str(tmp_path / 'board.db'))
    other.execute('PRAGMA busy_timeout=100')
    worker = threading.Thread(target=transition)
    worker.start()
    try:
        assert entered.wait(3), 'production serializer was not reached'
        assert tasks.add_event(other, tid, 'slow-serialization-probe', {}) is True
    finally:
        release.set()
        worker.join(5)
        other.close()
    assert not errors
    assert not worker.is_alive()


async def test_deferred_native_launch_belongs_to_startup_cancellation(tmp_path, monkeypatch):
    from misaka.core.research.node import ProcessSpawner
    from misaka.desktop_research.runtime import DeferredDesktopProcess
    scope = DesktopExecutionScope.__new__(DesktopExecutionScope)
    scope.policy = DesktopTeamModelPolicy(tmp_path / 'policy.json', 'fixture', 'model')
    scope.pending_launches = set()
    scope.sessions = {}
    scope.controller = SimpleNamespace(session=SimpleNamespace(moments=SimpleNamespace(parts=[])))
    scope.record_launch = lambda binding: 'fixture-launch'
    with scope.policy.lock:
        state = scope.policy._read()
        state['state'] = 'switching'
        scope.policy._write(state)
    spawned = []
    monkeypatch.setattr(ProcessSpawner, 'spawn', lambda *a, **kw: spawned.append(a))
    process = DeferredDesktopProcess(scope, SimpleNamespace(), ['python', '-m', 'misaka.cli.research_node'], {}, asyncio.get_running_loop())
    try:
        await asyncio.sleep(.02)
        assert process in scope.pending_launches
        await scope.cancel_startup_now()
        assert not scope.pending_launches
        assert spawned == []
        assert process.poll() == -15
    finally:
        process.stop(SimpleNamespace())
        await asyncio.sleep(.02)


async def test_nested_async_subprocess_barrier_wait_is_owned_and_settled(tmp_path):
    from misaka.desktop_research.team import DesktopResearchTeam
    team = DesktopResearchTeam(tmp_path / 'team', tmp_path / 'profiles', 'fixture', 'model')
    scope = DesktopExecutionScope(team, {'db': str(tmp_path / 'board.db'), 'profiles_root': str(tmp_path / 'profiles')})
    role_policy = scope.policy._policy('last_order')
    with role_policy.lock:
        state = role_policy._read()
        state['state'] = 'switching'
        role_policy._write(state)
    launch = scope.native.module('misaka.core.subagent.runtime').asyncio.create_subprocess_exec
    opening = asyncio.create_task(launch('synthetic-no-spawn'))
    try:
        await asyncio.sleep(.02)
        assert opening in getattr(scope, 'pending_launch_jobs', set())
        await scope.cancel_startup_now()
        assert opening.done()
        assert not scope.pending_launch_jobs
    finally:
        opening.cancel()
        await asyncio.gather(opening, return_exceptions=True)


def test_claim_lease_does_not_serialize_unrelated_card_files(board, tmp_path, monkeypatch):
    tid, _workspace, _path = card(board, tmp_path)
    def unexpected(*args):
        raise AssertionError('lease claim serialized static card files')
    monkeypatch.setattr(cards, '_dump', unexpected)
    assert tasks.claim(board, tid, 'fixture-lease', generation=1)


def test_owned_metadata_transaction_does_not_prepare_unrelated_board_cards(board, tmp_path, monkeypatch):
    from misaka.core.research import runs
    runs.init(board)
    run = runs.create(board, workspace=str(tmp_path), question='Fixture metadata owner')
    _tid, _workspace, _path = card(board, tmp_path)
    def unexpected(*args):
        raise AssertionError('metadata update prepared unrelated board cards')
    monkeypatch.setattr(cards, '_dump', unexpected)
    with runs.owned_txn(board, run):
        board.execute("UPDATE research_runs SET phase='fixture' WHERE id=?", (run['id'],))
    assert runs.get(board, run['id'])['phase'] == 'fixture'


def test_outer_dependency_projection_preserves_native_contract(board, tmp_path):
    a, workspace, _ = card(board, tmp_path)
    b = cards.create(board, str(workspace), 'Child', 'body', 'fixture')
    with tasks.write_txn(board):
        assert tasks.link_tasks(board, a, b)
    assert tasks.parent_ids(board, b, strict=True) == [a]


def test_unrelated_held_card_does_not_block_metadata_transaction(board, tmp_path):
    from filelock import FileLock
    a, workspace, _ = card(board, tmp_path)
    b = cards.create(board, str(workspace), 'Unrelated', 'body', 'fixture')
    holder = FileLock(str(Path(tasks.task_state_dir(b)) / 'card.lock'))
    with holder, tasks.write_txn(board):
        assert tasks.add_event(board, a, 'metadata-only', {})


def test_second_publication_failure_restores_first_intermediate_bytes(board, tmp_path, monkeypatch):
    tid, _workspace, path = card(board, tmp_path)
    before = path.read_bytes()
    original = card_publication.os.replace
    publishes = []
    def replace(source, destination):
        if str(destination) == str(path):
            publishes.append(True)
            if len(publishes) == 2:
                raise OSError('fixture second publication failure')
        return original(source, destination)
    monkeypatch.setattr(card_publication.os, 'replace', replace)
    with pytest.raises(OSError, match='fixture second publication failure'), tasks.write_txn(board):
        assert tasks.mark_stopped(board, tid)
        assert tasks.reopen_task(board, tid, target_status='ready')
    assert tasks.get(board, tid)['status'] == 'ready'
    assert tasks.get(board, tid)['generation'] == 1
    assert path.read_bytes() == before
    assert not card_publication.journal_path(path).exists()


async def test_host_recovery_error_returns_ack_without_stranding_command_worker(tmp_path, monkeypatch):
    import io
    import json
    import sys

    from misaka.cli import desktop_bridge as bridge
    from tests.test_desktop_bridge import MockRuntimeHost, MockSession
    session = MockSession()
    session.moments = SimpleNamespace(parts=[])
    session.sessionManager.buildContextEntries = list
    session.getPermissionMode = lambda: 'default'
    output = io.StringIO()
    monkeypatch.setattr(bridge, 'writeRawStdout', output.write)
    monkeypatch.setattr(bridge, '_open_research_readonly', lambda: None)
    async def failure(*args):
        raise OSError('fixture recovery failed')
    monkeypatch.setattr(bridge, 'recover_research_report', failure)
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({'type':'get_research_host','requestId':'host'})+'\n'))
    assert await asyncio.wait_for(bridge.run_desktop_bridge(MockRuntimeHost(session)), 1) == 0
    ack = next(json.loads(line) for line in output.getvalue().splitlines() if json.loads(line).get('requestId') == 'host')
    assert ack['ok'] is False
    assert 'fixture recovery failed' in ack['error']


def test_stale_prepared_generation_does_not_replace_newer_card(board, tmp_path):
    tid, workspace, path = card(board, tmp_path)
    def stopped(fields, body):
        return {**fields, 'status': 'stopped'}, body
    prepared = card_publication.stage(str(workspace), tid, stopped,
                                     generation=1, new_status='stopped')
    board.execute('UPDATE tasks SET generation=2 WHERE id=?', (tid,))
    cards.set_fields(str(workspace), tid, generation=2)
    current = path.read_bytes()
    with pytest.raises(RuntimeError, match='generation changed'), tasks.write_txn(board):
        prepared.publish(board)
    assert path.read_bytes() == current
    assert tasks.get(board, tid)['generation'] == 2
