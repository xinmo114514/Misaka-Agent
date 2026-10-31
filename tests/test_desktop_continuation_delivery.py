"""Real mailbox -> continuation CAS -> native transcript receipt regressions."""
import asyncio
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from types import SimpleNamespace

import pytest
from test_desktop_research_card_control import (
    board as board,  # noqa: PLC0414 - fixture re-export
)
from test_desktop_research_card_control import control_fixture
from test_research_plan_change import task

from misaka.config import CFG
from misaka.core.network import dispatch, messages
from misaka.core.platform import cards, tasks
from misaka.core.research import runs, workflow


@pytest.fixture
def delivery(board, tmp_path, monkeypatch):
    control, tid, _run, _ = control_fixture(board, tmp_path)
    config = {'db': str(tmp_path / 'board.db'), 'messages_db': str(tmp_path / 'mail.db'),
              'profiles_root': str(tmp_path / 'profiles'), 'roles_root': str(tmp_path / 'profiles'),
              'provider': 'fixture', 'default_model': 'fixture'}
    (tmp_path / 'profiles' / 'commune-historian').mkdir(parents=True)
    control.scope.current_config = lambda: config
    for key in ('db', 'messages_db'):
        monkeypatch.setitem(CFG, key, config[key])
    for key in ('MISAKA_SISTER_OWNER_DB', 'MISAKA_USAGE_DB', 'MISAKA_SISTER_OWNER_GENERATION'):
        monkeypatch.delenv(key, raising=False)
    # Only process/model boundaries are replaced; queue, registry, CAS and receipts are real.
    monkeypatch.setattr(control, '_queue', lambda *args: None)
    monkeypatch.setattr(messages, '_SCOPE_WAKE_HOOK', control.wake_card)
    monkeypatch.setattr(dispatch, '_SCOPE_CONTINUATION_CLAIMED',
                        lambda *args, **kwargs: control.claimed(*args, **kwargs), raising=False)
    monkeypatch.setattr(dispatch, '_SCOPE_CONTINUATION_CLAIMING',
                        lambda *args, **kwargs: control.claiming(*args, **kwargs), raising=False)
    monkeypatch.setattr(dispatch.worker, 'run_card', lambda *args, **kwargs: {'settled': True})
    with closing(messages.connect()) as mail:
        yield SimpleNamespace(control=control, tid=tid, board=board, mail=mail, config=config, tmp=tmp_path)


def send(world, text):
    return messages.send_as('last-order', world.tid, text, text[:25])


def resume(world, monkeypatch, expected=1):
    record = world.control._registry()[world.tid]
    monkeypatch.setenv('MISAKA_DESKTOP_CONTINUATION_EXECUTION_ID', record['executionId'])
    monkeypatch.setenv('MISAKA_DESKTOP_CONTINUATION', world.tid)
    return dispatch.run_task(world.board, tasks.get(world.board, world.tid), world.config,
                             say='Read the queued questions.', consult=False, expected_generation=expected)


def reader(world, monkeypatch, generation, *, session=None):
    from misaka.agent.agent import Agent
    from misaka.core.agent_session import AgentSession
    from misaka.core.session_manager import SessionManager
    if session is None:
        session = object.__new__(AgentSession)
        session.agent = Agent({"streamFn": lambda *_: None})
        session._customMessageReceipts = {}
        session.sessionManager = SessionManager.create(str(world.tmp), str(world.tmp / 'sessions'))
        session.sessionManager.rewrite_file()
        async def persist(payload, options):
            session._customMessageReceipts[options['_deliveryId']] = options
            session._appendCustomMessage({'role': 'custom', **payload,
                'details': {**payload['details'], 'delivery_id': options['_deliveryId']}})
        session.sendCustomMessage = persist
    part = messages.MessagesPart(sender='commune-historian', receive=True, card_task=world.tid)
    part.attach(session)
    monkeypatch.setattr(part, '_task_generation', lambda: generation)
    return part


def entries(part):
    return [entry for entry in part.session.sessionManager.getEntries()
            if entry.get('customType') == 'agent-messages']


async def test_finished_card_exact_body_survives_real_claim_and_replay(delivery, monkeypatch):
    world = delivery
    body = 'Original question: preserve whitespace\n  second line & <data>.'
    out = send(world, body)
    assert resume(world, monkeypatch)
    assert tasks.get(world.board, world.tid)['generation'] == 2
    part = reader(world, monkeypatch, 2)
    await part._deliver_once(world.mail)
    assert len(entries(part)) == 1
    row = world.mail.execute('SELECT * FROM messages WHERE id=?', (out['details']['message_id'],)).fetchone()
    assert row['body'] == body and row['generation'] == 2 and row['delivered_at'] is not None
    assert 'Original question: preserve whitespace\n  second line &amp; &lt;data&gt;.' in entries(part)[0]['content']
    # Lost ACK after native flush: the persisted per-mail receipt suppresses a second body.
    world.mail.execute('UPDATE messages SET delivered_at=NULL WHERE id=?', (row['id'],))
    await part._deliver_once(world.mail)
    assert len(entries(part)) == 1
    assert world.mail.execute('SELECT delivered_at FROM messages WHERE id=?', (row['id'],)).fetchone()[0]


async def test_old_reader_never_consumes_held_or_future_continuation(delivery, monkeypatch):
    world = delivery
    out = send(world, 'Must reach only the next attempt')
    old = reader(world, monkeypatch, 1)
    await old._deliver_once(world.mail)
    assert entries(old) == []
    assert resume(world, monkeypatch)
    await old._deliver_once(world.mail)
    assert entries(old) == []
    assert world.mail.execute('SELECT delivered_at FROM messages WHERE id=?',
                              (out['details']['message_id'],)).fetchone()[0] is None
    new = reader(world, monkeypatch, 2)
    await new._deliver_once(world.mail)
    assert len(entries(new)) == 1


async def test_concurrent_accepted_messages_survive_one_consumer(delivery, monkeypatch):
    world = delivery
    bodies = ['Question one\n  exact body', 'Question two & exact body', 'Question three — exact body']
    with ThreadPoolExecutor(max_workers=3) as pool:
        receipts = list(pool.map(lambda text: send(world, text), bodies))
    assert len({item['details']['execution_id'] for item in receipts}) == 1
    assert resume(world, monkeypatch)
    part = reader(world, monkeypatch, 2)
    await part._deliver_once(world.mail)
    rows = world.mail.execute('SELECT * FROM messages ORDER BY id').fetchall()
    assert sorted(row['body'] for row in rows) == sorted(bodies)
    assert all(row['generation'] == 2 and row['delivered_at'] is not None for row in rows)
    assert sum(entry['details']['count'] for entry in entries(part)) == 3
    await part._deliver_once(world.mail)
    assert sum(entry['details']['count'] for entry in entries(part)) == 3


async def test_message_enrollment_crossing_claim_joins_the_claimed_consumer(delivery, monkeypatch):
    world = delivery
    first = send(world, 'First question starts the continuation')
    def cross_claim(target, message):
        assert resume(world, monkeypatch)
        return world.control.wake_card(target, message)
    monkeypatch.setattr(messages, '_SCOPE_WAKE_HOOK', cross_claim)
    second = send(world, 'Second question queued just before the CAS')
    assert first['details']['execution_id'] == second['details']['execution_id']
    part = reader(world, monkeypatch, 2)
    await part._deliver_once(world.mail)
    assert sum(entry['details']['count'] for entry in entries(part)) == 2
    assert [row[0] for row in world.mail.execute('SELECT body FROM messages WHERE delivered_at IS NOT NULL ORDER BY id')] == [
        'First question starts the continuation', 'Second question queued just before the CAS']


async def test_message_enrollment_after_cas_before_release_is_accepted(delivery, monkeypatch):
    world = delivery
    first = send(world, 'First question starts the continuation')
    claim_resume = tasks.claim_resume
    enrolled = {}

    def cross_cas(target, message):
        def claim_then_enroll(*args, **kwargs):
            result = claim_resume(*args, **kwargs)
            assert result
            record = world.control._registry()[world.tid]
            assert record.get('claimedGeneration') is None
            assert tasks.get(world.board, world.tid)['generation'] == 2
            enrolled.update(world.control.wake_card(target, message))
            # Enrollment alone does not expose either input before release.
            assert all(row[0].startswith('continuation:') for row in
                       world.mail.execute('SELECT lease_token FROM messages'))
            return result

        with monkeypatch.context() as patch:
            patch.setattr(tasks, 'claim_resume', claim_then_enroll)
            assert resume(world, patch)
        return enrolled

    monkeypatch.setattr(messages, '_SCOPE_WAKE_HOOK', cross_cas)
    second = send(world, 'Concurrent question staged before the CAS')
    assert first['details']['accepted'] and second['details']['accepted']
    assert first['details']['execution_id'] == second['details']['execution_id']
    assert first['details']['message_id'] != second['details']['message_id']
    part = reader(world, monkeypatch, 2)
    await part._deliver_once(world.mail)
    rows = world.mail.execute('SELECT body,generation,delivered_at FROM messages ORDER BY id').fetchall()
    assert [row['body'] for row in rows] == [
        'First question starts the continuation', 'Concurrent question staged before the CAS']
    assert all(row['generation'] == 2 and row['delivered_at'] is not None for row in rows)
    assert sum(entry['details']['count'] for entry in entries(part)) == 2
    await part._deliver_once(world.mail)
    assert sum(entry['details']['count'] for entry in entries(part)) == 2


@pytest.mark.parametrize('release_reason', ['budget_stop', 'cancellation'])
async def test_pre_release_return_to_ready_recovers_input_on_scheduler_retry(delivery, monkeypatch, release_reason):
    world = delivery
    send(world, 'Durable input before the claim was returned to ready')

    def cancel(*args, **kwargs):
        raise asyncio.CancelledError()

    with monkeypatch.context() as patch:
        if release_reason == 'budget_stop':
            patch.setattr(dispatch.budget, 'status', lambda *args, **kwargs: {'mode': 'stop'})
            assert resume(world, patch) is False
        else:
            patch.setattr(dispatch, '_SCOPE_CONTINUATION_CLAIMED', cancel)
            with pytest.raises(asyncio.CancelledError):
                resume(world, patch)

    row = tasks.get(world.board, world.tid)
    assert row['status'] == 'ready' and row['generation'] == 2
    intent = world.control._registry()[world.tid]['claimIntent']
    prior = world.board.execute('SELECT status FROM task_runs WHERE task_id=? AND claim_lock=?',
                                (world.tid, intent['claimLock'])).fetchone()
    assert prior['status'] == 'released'
    part = reader(world, monkeypatch, 2)
    await part._deliver_once(world.mail)
    assert entries(part) == []
    assert dispatch.run_task(world.board, tasks.get(world.board, world.tid), world.config)
    await part._deliver_once(world.mail)
    mail = world.mail.execute('SELECT body,generation,delivered_at FROM messages').fetchone()
    assert mail['generation'] == 2 and mail['delivered_at'] is not None
    assert mail['body'] == 'Durable input before the claim was returned to ready'
    assert sum(entry['details']['count'] for entry in entries(part)) == 1
    await part._deliver_once(world.mail)
    assert sum(entry['details']['count'] for entry in entries(part)) == 1


@pytest.mark.parametrize(('field', 'foreign'), [
    ('generation', 3), ('claimLock', 'foreign-claim'), ('pid', -1), ('identity', 'foreign-process'),
])
def test_pre_release_enrollment_rejects_mismatched_journal_owner(delivery, monkeypatch, field, foreign):
    from misaka.desktop_research.model_policy import atomic_json
    world = delivery
    send(world, 'Input reserved for the journalled execution')
    target = messages.resolve_address(world.tid, sender='last-order')
    claim_resume = tasks.claim_resume

    def claim_then_check_owner(*args, **kwargs):
        result = claim_resume(*args, **kwargs)
        assert result
        records = world.control._registry()
        original = records[world.tid]['claimIntent'][field]
        records[world.tid]['claimIntent'][field] = foreign
        atomic_json(world.control.registry_path, records)
        with pytest.raises(ValueError, match='moved to attempt'):
            world.control.wake_card({**target, 'requestId': 'foreign-enrollment'}, 'Read inbox')
        assert 'foreign-enrollment' not in world.control._registry()[world.tid]['requests']
        records[world.tid]['claimIntent'][field] = original
        atomic_json(world.control.registry_path, records)
        return result

    monkeypatch.setattr(tasks, 'claim_resume', claim_then_check_owner)
    assert resume(world, monkeypatch)


async def test_failed_process_start_retains_all_accepted_input(delivery, monkeypatch):
    from misaka.desktop_research import card_control
    world = delivery
    first = send(world, 'Accepted before failed process start')
    record = world.control._registry()[world.tid]
    pending = card_control._PendingLaunch(world.control, world.tid, 'Read inbox', 1,
                                         record['executionId'], record['workspace'])
    def fail_start(*args, **kwargs):
        raise OSError('fixture process start failed')
    monkeypatch.setattr(card_control.subprocess, 'Popen', fail_start)
    world.control._launch(pending)
    assert world.control._registry()[world.tid]['state'] == 'failed'
    old = reader(world, monkeypatch, 1)
    await old._deliver_once(world.mail)
    assert entries(old) == []
    second = send(world, 'Accepted by the replacement launch')
    assert first['details']['execution_id'] != second['details']['execution_id']
    assert resume(world, monkeypatch)
    part = reader(world, monkeypatch, 2)
    await part._deliver_once(world.mail)
    assert sum(entry['details']['count'] for entry in entries(part)) == 2


async def test_sender_exit_between_queue_and_registry_enrollment_is_recoverable(delivery, monkeypatch):
    world = delivery
    target = messages.resolve_address(world.tid, sender='last-order')
    orphan = messages.post({**target, '_continuation_hold': True}, 'Durable before sender exit',
                           summary='orphan', sender='last-order')
    # The sender exits before calling the wake owner; a later accepted message
    # starts the consumer and adopts that staged row into the receipt registry.
    send(world, 'Message that recovers the unregistered input')
    assert resume(world, monkeypatch)
    assert str(orphan) in world.control._registry()[world.tid]['requests']
    part = reader(world, monkeypatch, 2)
    await part._deliver_once(world.mail)
    assert sum(entry['details']['count'] for entry in entries(part)) == 2
    assert all(row[0] is not None for row in world.mail.execute('SELECT delivered_at FROM messages'))
    await part._deliver_once(world.mail)
    assert sum(entry['details']['count'] for entry in entries(part)) == 2


async def test_failed_claim_keeps_mail_recoverable_for_later_success(delivery, monkeypatch):
    world = delivery
    send(world, 'Survive admission CAS failure')
    monkeypatch.setattr(dispatch.admission, 'limits', lambda: (0, 0))
    assert resume(world, monkeypatch) is False
    old = reader(world, monkeypatch, 1)
    await old._deliver_once(world.mail)
    assert entries(old) == []
    monkeypatch.setattr(dispatch.admission, 'limits', lambda: (None, None))
    assert resume(world, monkeypatch)
    new = reader(world, monkeypatch, 2)
    await new._deliver_once(world.mail)
    assert len(entries(new)) == 1


async def test_late_enrollment_preserves_an_existing_delivery_lease(delivery, monkeypatch):
    world = delivery
    first = send(world, 'Already leased by the claimed reader')
    target = messages.resolve_address(world.tid, sender='last-order')
    assert resume(world, monkeypatch)
    mid = first['details']['message_id']
    token = messages.new_lease_token()
    assert messages.claim(world.mail, [mid], token=token) == {mid}
    late = messages.post({**target, '_continuation_hold': True}, 'Late accepted question',
                         summary='late', sender='last-order')
    world.control.wake_card({**target, 'message_id': late}, 'Read inbox')
    assert world.mail.execute('SELECT lease_token FROM messages WHERE id=?', (mid,)).fetchone()[0] == token
    part = reader(world, monkeypatch, 2)
    await part._deliver_once(world.mail)
    assert sum(entry['details']['count'] for entry in entries(part)) == 1
    messages.unclaim(world.mail, [mid], token=token)
    await part._deliver_once(world.mail)
    assert sum(entry['details']['count'] for entry in entries(part)) == 2


async def test_unrelated_later_attempt_does_not_release_continuation_input(delivery, monkeypatch):
    world = delivery
    send(world, 'Input reserved for the accepted continuation')
    # Another actor wins the original CAS; it is not this registry execution.
    assert tasks.claim_resume(world.board, world.tid, 'foreign:1:claim', os.getpid(),
                              expected_generation=1)
    row = tasks.get(world.board, world.tid)
    assert tasks.mark_failed(world.board, world.tid, generation=2, claim_lock=row['claim_lock'],
                             failure_kind='configuration', reason='foreign worker failed')
    assert dispatch.run_task(world.board, tasks.get(world.board, world.tid), world.config,
                             say='Unrelated later work', expected_generation=2)
    part = reader(world, monkeypatch, 3)
    await part._deliver_once(world.mail)
    assert entries(part) == []
    row = world.mail.execute('SELECT generation,delivered_at,lease_token FROM messages').fetchone()
    assert row['generation'] == 1 and row['delivered_at'] is None
    assert row['lease_token'].startswith('continuation:')


@pytest.mark.parametrize('before_release', [True, False])
async def test_worker_crash_rebinds_only_owned_undelivered_mail(delivery, monkeypatch, before_release):
    world = delivery
    send(world, 'Question accepted before worker crash')
    def crash(*args, **kwargs):
        raise OSError('fixture worker crash')
    if before_release:
        monkeypatch.setattr(dispatch, '_SCOPE_CONTINUATION_CLAIMED', crash)
    else:
        monkeypatch.setattr(dispatch.worker, 'run_card', crash)
    with pytest.raises(OSError, match='fixture worker crash'):
        resume(world, monkeypatch)
    current = tasks.get(world.board, world.tid)
    if current['status'] == 'running':
        assert tasks.mark_failed(world.board, world.tid, generation=current['generation'],
                                 claim_lock=current['claim_lock'], reason='lost worker')
    # The real crash handler returns a ready card. A scheduler retry claims that
    # same generation; it does not invent a second continuation CAS.
    assert tasks.get(world.board, world.tid)['status'] == 'ready'
    send(world, 'Question accepted during recovery')
    monkeypatch.setattr(dispatch, '_SCOPE_CONTINUATION_CLAIMED', lambda *args, **kwargs: world.control.claimed(*args, **kwargs))
    monkeypatch.setattr(dispatch.worker, 'run_card', lambda *args, **kwargs: {'settled': True})
    monkeypatch.delenv('MISAKA_DESKTOP_CONTINUATION_EXECUTION_ID')
    monkeypatch.delenv('MISAKA_DESKTOP_CONTINUATION')
    # Only skip the elapsed retry backoff, not the board claim or projection.
    world.board.execute('UPDATE tasks SET next_attempt_at=NULL WHERE id=?', (world.tid,))
    assert dispatch.run_task(world.board, tasks.get(world.board, world.tid), world.config)
    part = reader(world, monkeypatch, 2)
    await part._deliver_once(world.mail)
    rows = world.mail.execute('SELECT body,generation,delivered_at FROM messages ORDER BY id').fetchall()
    assert [row['body'] for row in rows] == ['Question accepted before worker crash', 'Question accepted during recovery']
    assert all(row['generation'] == 2 and row['delivered_at'] is not None for row in rows)
    assert sum(entry['details']['count'] for entry in entries(part)) == 2


@pytest.mark.parametrize('before_release', [True, False])
async def test_killed_worker_reconcile_recovers_mail_without_python_cleanup(delivery, monkeypatch, before_release):
    world = delivery
    send(world, 'Durable input before abrupt process exit')
    record = world.control._registry()[world.tid]
    source = '''
import json, os, sys
from pathlib import Path
from types import SimpleNamespace
from misaka.core.network import dispatch
from misaka.core.platform import tasks
from misaka.desktop_research.card_control import DesktopCardControl
config, task_id, directory, before = json.loads(sys.argv[1])
scope = SimpleNamespace(team=SimpleNamespace(directory=Path(directory)), current_config=lambda: config)
control = DesktopCardControl(scope)
dispatch._SCOPE_CONTINUATION_CLAIMING = control.claiming
def abruptly_exit(*args, **kwargs):
    if not before:
        control.claimed(*args, **kwargs)
    os._exit(23)
dispatch._SCOPE_CONTINUATION_CLAIMED = abruptly_exit
con = tasks.connect(config['db'])
dispatch.run_task(con, tasks.get(con, task_id), config, say='Read the inbox', consult=False, expected_generation=1)
raise AssertionError('The continuation never reached the post-CAS process boundary')
'''
    child = await asyncio.to_thread(subprocess.run, [sys.executable, '-c', source, json.dumps(
        [world.config, world.tid, str(world.control.scope.team.directory), before_release])],
        env={**os.environ, 'MISAKA_DESKTOP_CONTINUATION': world.tid,
             'MISAKA_DESKTOP_CONTINUATION_EXECUTION_ID': record['executionId']},
        capture_output=True, text=True, timeout=20, check=False)
    assert child.returncode == 23, child.stderr
    assert tasks.get(world.board, world.tid)['status'] == 'running'
    dispatch.reconcile(world.board, world.config, task_ids=[world.tid])
    assert tasks.get(world.board, world.tid)['status'] == 'ready'
    send(world, 'Concurrent question after abrupt process exit')
    assert dispatch.run_task(world.board, tasks.get(world.board, world.tid), world.config)
    part = reader(world, monkeypatch, 2)
    await part._deliver_once(world.mail)
    rows = world.mail.execute('SELECT body,generation,delivered_at FROM messages ORDER BY id').fetchall()
    assert [row['body'] for row in rows] == [
        'Durable input before abrupt process exit', 'Concurrent question after abrupt process exit']
    assert all(row['generation'] == 2 and row['delivered_at'] is not None for row in rows)
    assert sum(entry['details']['count'] for entry in entries(part)) == 2


def test_real_remove_and_plan_replay_rebuilds_dependency_projection(board, tmp_path):
    run = runs.create(board, workspace=str(tmp_path), question='Rebuild removed dependency')
    root = runs.nodes(board, run['id'])[0]
    assert runs.acquire_driver(board, run['id'], 'driver')
    runs.prepare_runner(board, 'research_execution', root['id'])
    run, root = runs.get(board, run['id']), runs.node(board, root['id'])
    specs = [task('a'), task('b', dependencies=['a'])]
    before = asyncio.run(workflow._submit_tasks(board, run, root, specs, kind='research'))
    assert cards.remove(board, str(tmp_path), before['a'])[0]
    assert tasks.get(board, before['b'])['status'] == 'ready'
    assert tasks.parent_ids(board, before['b']) == []
    after = asyncio.run(workflow._submit_tasks(board, run, root, specs, kind='research'))
    assert after['a'] != before['a'] and after['b'] == before['b']
    assert tasks.get(board, after['b'])['status'] == 'todo'
    assert tasks.parent_ids(board, after['b'], strict=True) == [after['a']]
    written = cards.read(cards.card_path(str(tmp_path), after['b']))
    assert written['fields']['status'] == 'todo' and written['fields']['needs'] == [after['a']]


async def test_native_consultation_releases_mail_without_reopening_card(delivery, monkeypatch):
    world = delivery
    out = send(world, "Consult the accepted result")
    record = world.control._registry()[world.tid]
    monkeypatch.setenv("MISAKA_DESKTOP_CONTINUATION", world.tid)
    monkeypatch.setenv("MISAKA_DESKTOP_CONTINUATION_EXECUTION_ID", record["executionId"])
    assert dispatch.run_task(world.board, tasks.get(world.board, world.tid), world.config,
        say="Read inbox", consult=True, expected_generation=1)
    row = tasks.get(world.board, world.tid)
    assert row["status"] == "done" and row["generation"] == 1
    part = reader(world, monkeypatch, 1)
    await part._deliver_once(world.mail)
    mail = world.mail.execute("SELECT * FROM messages WHERE id=?", (out["details"]["message_id"],)).fetchone()
    assert mail["generation"] == 1 and mail["delivered_at"] is not None
    assert len(entries(part)) == 1


@pytest.mark.parametrize("before_release", [True, False])
async def test_native_consultation_retry_retains_mail_and_finished_card(delivery, monkeypatch, before_release):
    world = delivery
    send(world, "Question before the consultation failed")
    record = world.control._registry()[world.tid]
    monkeypatch.setenv("MISAKA_DESKTOP_CONTINUATION", world.tid)
    monkeypatch.setenv("MISAKA_DESKTOP_CONTINUATION_EXECUTION_ID", record["executionId"])
    def fail(*args, **kwargs):
        raise OSError("consult fixture failure")
    with monkeypatch.context() as patch:
        patch.setattr(dispatch if before_release else dispatch.worker,
            "_SCOPE_CONTINUATION_CLAIMED" if before_release else "run_card", fail)
        with pytest.raises(OSError, match="consult fixture failure"):
            dispatch.run_task(world.board, tasks.get(world.board, world.tid), world.config,
                say="Read inbox", consult=True, expected_generation=1)
    row = tasks.get(world.board, world.tid)
    assert row["status"] == "done" and row["generation"] == 1
    assert tasks.live_consultation(world.board, world.tid) is None
    assert dispatch.run_task(world.board, row, world.config,
        say="Read inbox", consult=True, expected_generation=1)
    part = reader(world, monkeypatch, 1)
    await part._deliver_once(world.mail)
    assert len(entries(part)) == 1


@pytest.mark.parametrize("before_release", [True, False])
async def test_reap_automatically_requeues_dead_native_consultation_once(delivery, monkeypatch, before_release):
    import threading
    from misaka.desktop_research import card_control
    from misaka.desktop_research.model_policy import atomic_json
    world = delivery
    send(world, "Exact original question, preserved through automatic recovery")
    original = world.control._registry()[world.tid]
    monkeypatch.setenv("MISAKA_DESKTOP_CONTINUATION", world.tid)
    monkeypatch.setenv("MISAKA_DESKTOP_CONTINUATION_EXECUTION_ID", original["executionId"])
    def crash(*args, **kwargs):
        raise OSError("dead consultation")
    with monkeypatch.context() as patch:
        patch.setattr(dispatch if before_release else dispatch.worker,
            "_SCOPE_CONTINUATION_CLAIMED" if before_release else "run_card", crash)
        with pytest.raises(OSError):
            dispatch.run_task(world.board, tasks.get(world.board, world.tid), world.config,
                say="Read inbox", consult=True, expected_generation=1)
    records = world.control._registry()
    records[world.tid]["state"] = "running"
    atomic_json(world.control.registry_path, records)
    world.control.continuations[world.tid] = SimpleNamespace(poll=lambda: 23)
    queued, ready = [], threading.Event()
    monkeypatch.setattr(world.control, "_queue", lambda *args: (queued.append(args), ready.set()))
    monkeypatch.setattr(card_control, "REAP_INTERVAL_SECONDS", .01)
    world.control._ensure_monitor()
    try:
        assert await asyncio.to_thread(ready.wait, 2)
        retry = world.control._registry()[world.tid]
        assert retry["state"] == "pending" and retry["automaticRetries"] == 1
        assert retry["generation"] == 1 and retry["executionId"] != original["executionId"]
        assert len(queued) == 1
        monkeypatch.setenv("MISAKA_DESKTOP_CONTINUATION_EXECUTION_ID", retry["executionId"])
        assert dispatch.run_task(world.board, tasks.get(world.board, world.tid), world.config,
            say=queued[0][1], consult=True, expected_generation=1)
        part = reader(world, monkeypatch, 1)
        await part._deliver_once(world.mail)
        await part._deliver_once(world.mail)
        assert len(entries(part)) == 1
        assert "Exact original question" in entries(part)[0]["content"]
        records = world.control._registry()
        records[world.tid]["state"] = "running"
        atomic_json(world.control.registry_path, records)
        world.control.continuations[world.tid] = SimpleNamespace(poll=lambda: 0)
        world.control._reap()
        assert len(queued) == 1
        row = tasks.get(world.board, world.tid)
        assert row["status"] == "done" and row["generation"] == 1
    finally:
        world.control._monitor_stop.set()
        world.control._monitor_thread.join(2)


def test_dead_consultation_automatic_recovery_has_persisted_retry_limit(delivery, monkeypatch):
    from misaka.desktop_research.card_control import MAX_AUTOMATIC_RETRIES
    from misaka.desktop_research.model_policy import atomic_json
    world = delivery
    send(world, "Do not loop forever")
    records = world.control._registry()
    records[world.tid].update(state="running", automaticRetries=MAX_AUTOMATIC_RETRIES)
    atomic_json(world.control.registry_path, records)
    world.control.continuations[world.tid] = SimpleNamespace(poll=lambda: 23)
    queued = []
    monkeypatch.setattr(world.control, "_queue", lambda *args: queued.append(args))
    world.control._reap()
    record = world.control._registry()[world.tid]
    assert record["state"] == "failed" and record["errorCode"] == "DESKTOP_CONTINUATION_RETRY_LIMIT"
    world.control._reap()
    assert queued == []
    assert world.mail.execute("SELECT delivered_at FROM messages").fetchone()[0] is None


def test_new_host_recovers_previously_reaped_native_consultation(delivery, monkeypatch):
    from misaka.desktop_research.model_policy import atomic_json
    world = delivery
    send(world, "Question left behind by the previous host")
    records = world.control._registry()
    records[world.tid]["state"] = "settled"
    atomic_json(world.control.registry_path, records)
    queued = []
    monkeypatch.setattr(world.control, "_queue", lambda *args: queued.append(args))
    world.control._reap()
    assert len(queued) == 1
    retry = world.control._registry()[world.tid]
    assert retry["state"] == "pending" and retry["automaticRetries"] == 1
    assert retry["generation"] == 1
