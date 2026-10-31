"""Task 1 contract: desktop research card messages and continuations stay inside the
owning desktop runtime.

The real regression (2026-10-11 audit): a finished card of a desktop research run was woken
by SendMessage through the global panel continuation, which ran the native CARD_SHELL against
the global profiles root and failed with "Sister <name> is not in the roster", and retried the
work. These tests pin the scope-local continuation hook, the consult flag and the generation
fence reaching the real claim CAS.
"""
from __future__ import annotations

import json
import os
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace

import pytest

from misaka.core.network import messages
from misaka.core.platform import tasks
from misaka.core.research import runs


@pytest.fixture
def board(tmp_path, monkeypatch):
    from misaka.core.platform import repo
    monkeypatch.setattr(repo, "enabled", lambda *a: False)
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        runs.init(con)
        yield con


def _workspace(tmp_path):
    workspace = tmp_path / "project"
    workspace.mkdir(exist_ok=True)
    return str(workspace)


def _finished_card(board, tmp_path, *, assignee="commune-historian"):
    from misaka.core.platform import cards as card_files

    workspace = _workspace(tmp_path)
    tid = card_files.create(board, workspace, "Synthetic finished card", "fixture body", assignee)
    # A finished card is written by the lifecycle itself: claim, then the accepted submission.
    lock = "test:1:aaaa"
    assert tasks.claim(board, tid, lock, generation=1, pid=os.getpid())
    assert tasks.submit_task(board, tid, generation=1, claim_lock=lock)
    row = tasks.get(board, tid)
    assert row["status"] == "done", row["status"]
    return tid, workspace


def test_scope_local_wake_hook_wins_over_the_panel_continuation(monkeypatch):
    calls = []
    target = {"to_task": "t_ab12cd", "generation": 4, "say": "hello"}

    def hook(item, message):
        calls.append((dict(item), message))
        return {"pane_id": None, "execution_kind": "desktop", "execution_id": "chain-1"}

    monkeypatch.setattr(messages, "_SCOPE_WAKE_HOOK", hook, raising=False)
    try:
        out = messages.wake_card(target, "the message")
    finally:
        if hasattr(messages, "_SCOPE_WAKE_HOOK"):
            delattr(messages, "_SCOPE_WAKE_HOOK")
    assert calls and calls[0][0]["to_task"] == "t_ab12cd" and calls[0][1] == "the message"
    assert out["execution_kind"] == "desktop"


def test_without_a_hook_the_panel_route_is_unchanged(monkeypatch):
    from misaka.ui.panel import client as net
    calls = []
    monkeypatch.setattr(net, "ensure", lambda *a, **kw: None)
    monkeypatch.setattr(net, "request", lambda method, params=None: calls.append((method, params))
                        or {"pane_id": "p9"})
    monkeypatch.delenv("MISAKA_NET_PANE", raising=False)
    out = messages.wake_card({"to_task": "t_ab12cd", "generation": 4}, "msg")
    assert calls == [("pane.continue_card", {"task_id": "t_ab12cd", "say": "msg",
                                             "expected_generation": 4})]
    assert out["pane_id"] == "p9"


def test_claim_resume_generation_and_consult_reach_the_real_cas(board, tmp_path):
    tid, _ = _finished_card(board, tmp_path)
    lock = "test:2:bbbb"
    # Stale generation must be refused by the real CAS.
    assert tasks.start_consultation(board, tid, generation=0, lock=lock, pid=os.getpid()) is None
    assert tasks.get(board, tid)["status"] == "done"
    # Consult continues without invalidating descendants and bumps the generation once.
    before = tasks.get(board, tid)["generation"]
    assert tasks.start_consultation(board, tid, generation=before, lock=lock, pid=os.getpid()) is not None
    row = tasks.get(board, tid)
    assert row["status"] == "done" and row["generation"] == before


def test_dispatch_run_task_carries_consult_to_claim_resume(board, tmp_path, monkeypatch):
    from misaka.core.network import dispatch

    tid, _ = _finished_card(board, tmp_path)
    seen = {}

    def fake_worker(task, *args, **kwargs):
        con = kwargs.get("con")
        row = tasks.get(con, task["id"])
        seen["status"] = row["status"]
        seen["generation"] = int(row["generation"])
        return {"ok": True, "settled": True, "exit_code": 0}

    monkeypatch.setattr(dispatch.worker, "run_card", fake_worker)
    import socket as _socket
    monkeypatch.setattr(_socket, "gethostname", lambda: "testhost")
    workspaces = tmp_path / "profiles"
    (workspaces / "commune-historian").mkdir(parents=True)
    row = tasks.get(board, tid)
    row_before = int(row["generation"])
    ok = dispatch.run_task(board, row, {"db": str(tmp_path / "board.db"), "profiles_root": str(workspaces),
                                        "roles_root": str(workspaces),
                                        "provider": "fixture", "default_model": "fixture"},
                           say="the consult", consult=True, expected_generation=row_before)
    assert ok is True
    assert seen["status"] == "done" and seen["generation"] == row_before
    # A second, stale continuation must refuse before the CAS and leave the card running: this is
    # the generated-generation race the desktop fences are for.
    refuses = dispatch.run_task(board, tasks.get(board, tid),
                                {"db": str(tmp_path / "board.db"), "profiles_root": str(workspaces),
                                 "roles_root": str(workspaces), "provider": "fixture", "default_model": "fixture"},
                                say="stale", consult=True, expected_generation=row_before - 1)
    assert refuses is False


def test_parse_card_flags_reads_the_desktop_continuation_fences():
    from misaka.desktop_research import worker_entry

    task, say, generation, consult = worker_entry.parse_card_flags(
        ["--run-card", "t_ab12cd", "--say", "note", "--expected-generation", "3", "--consult"])
    assert (task, say, generation, consult) == ("t_ab12cd", "note", 3, True)
    # A plain first-run card keeps the old shape: no say, no fences.
    task, say, generation, consult = worker_entry.parse_card_flags(["--run-card", "t_ab12cd"])
    assert (task, say, generation, consult) == ("t_ab12cd", None, None, False)


def test_worker_entry_passes_generation_and_consult_to_main_card(monkeypatch):
    from misaka.desktop_research import worker_entry

    captured = {}

    class FakeNode:
        @staticmethod
        def main_card(task_id, *, say=None, consult=False, expected_generation=None):
            captured.update(task_id=task_id, say=say, consult=consult, expected_generation=expected_generation)
            return 0

    def fake_parse(args):
        return SimpleNamespace(policy="p.json", epoch=1, provider="prov", model="mod", launch_id=None,
                               lane="card", flags=["--run-card", "t_ab12cd", "--say", "note",
                                                   "--expected-generation", "3", "--consult"])

    monkeypatch.setattr(worker_entry, "parse_worker_args", fake_parse)
    monkeypatch.setattr(worker_entry, "validate_worker_binding", lambda args, policy: {"provider": "prov",
                                                                                         "modelId": "mod", "epoch": 1})
    monkeypatch.setattr(worker_entry, "DesktopTeamModelPolicy", lambda *a, **k: SimpleNamespace())

    def fake_team(directory, root, provider, model):
        return SimpleNamespace(profile_root=root, model_policy=SimpleNamespace(path="p.json"))

    class FakeScope:
        def __init__(self, team, config, role):
            self.native = SimpleNamespace(module=lambda name: FakeNode())

    monkeypatch.setattr(worker_entry, "DesktopResearchTeam", fake_team)
    monkeypatch.setattr(worker_entry, "DesktopExecutionScope", FakeScope)
    monkeypatch.setattr(Path, "read_text",
                        lambda self, encoding=None: json.dumps({"profiles_root": str(self.parent)}))
    monkeypatch.setattr(worker_entry, "parse_card_flags", lambda flags: (flags[1], "note", 3, True))
    monkeypatch.setattr(worker_entry.asyncio, "run", lambda coro: coro)

    from misaka.cli import bootstrap
    monkeypatch.setattr(bootstrap, "install", lambda: None)
    from misaka.utils import loop_watchdog
    monkeypatch.setattr(loop_watchdog, "configure", lambda *a, **k: None)

    rc = worker_entry.main([])
    assert rc == 0
    assert captured["task_id"] == "t_ab12cd" and captured["say"] == "note"
    assert captured["consult"] is True and captured["expected_generation"] == 3



def control_fixture(board, tmp_path):
    from misaka.desktop_research.card_control import DesktopCardControl
    from misaka.desktop_research.model_policy import DesktopTeamModelPolicy
    tid, workspace = _finished_card(board, tmp_path)
    run = runs.create(board, workspace=workspace, question='Fixture question')
    root = tmp_path / 'root.jsonl'
    runs.set_state(board, run['id'], root_session=str(root))
    board.execute('INSERT INTO research_cards(task_id,run_id,branch_id,kind,created_at) VALUES(?,?,?,?,?)',
                  (tid, run['id'], 'fixture', 'research', 1))
    directory = tmp_path / 'team'
    directory.mkdir()
    (directory / 'owner.json').write_text(json.dumps({'rootSession': str(root), 'workspace': workspace}), encoding='utf-8')
    policy = DesktopTeamModelPolicy(directory / 'policy.json', 'fixture', 'model')
    scope = SimpleNamespace(team=SimpleNamespace(directory=directory, model_policy=policy),
                            policy=SimpleNamespace(guard_model=lambda **kwargs: policy.guard_model(),
                                                   snapshot=lambda **kwargs: policy.snapshot()),
                            base_config={'db': str(tmp_path / 'board.db')}, pending_launches=set(),
                            record_launch=lambda binding: 'launch-fixture',
                            current_config=lambda: {'db': str(tmp_path / 'board.db')})
    return DesktopCardControl(scope), tid, run, policy


def test_card_control_reads_scope_database_not_global_cfg(board, tmp_path, monkeypatch):
    control, tid, run, _policy = control_fixture(board, tmp_path)
    from misaka.config import CFG
    monkeypatch.setitem(CFG, 'db', str(tmp_path / 'wrong-board.db'))
    actual, error = control._card_owner(tid)
    assert error is None
    assert actual['id'] == run['id']


def test_model_wait_launch_is_pending_owned_and_cancelable(board, tmp_path, monkeypatch):
    import threading

    from misaka.desktop_research import card_control
    control, tid, _run, policy = control_fixture(board, tmp_path)
    with policy.lock:
        state = policy._read()
        state['state'] = 'switching'
        policy._write(state)
    started = []
    class Process:
        pid = 987654321
        def poll(self):
            return 0
    monkeypatch.setattr(card_control.subprocess, 'Popen', lambda *a, **k: started.append(a) or Process())
    done = threading.Event()
    def call():
        control._spawn(tid, 'first distinct message', 1)
        done.set()
    caller = threading.Thread(target=call)
    caller.start()
    try:
        assert done.wait(.3), 'model barrier blocked synchronous message control'
        assert control.scope.pending_launches
        control.stop_all()
        assert not control.scope.pending_launches
        assert started == []
    finally:
        with policy.lock:
            state = policy._read()
            state['state'] = 'ready'
            policy._write(state)
        caller.join(3)
        control.stop_all()


def test_shared_continuation_stop_uses_pid_birth_identity(board, tmp_path, monkeypatch):
    from misaka.core.platform import processes
    from misaka.desktop_research.model_policy import atomic_json
    control, tid, _run, _policy = control_fixture(board, tmp_path)
    atomic_json(control.registry_path, {tid: {'executionId': 'owned', 'state': 'running',
                                            'pid': 222222, 'identity': 'fixture-birth'}})
    terminated = []
    monkeypatch.setattr(processes, 'identity_is_alive', lambda pid, identity: (pid, identity) == (222222, 'fixture-birth'))
    monkeypatch.setattr(processes, 'terminate', lambda pid: terminated.append(pid))
    assert control.stop_all() == [tid]
    assert terminated == [222222]


def test_reaped_child_updates_shared_registry_before_new_message(board, tmp_path):
    from misaka.desktop_research.model_policy import atomic_json
    control, tid, _run, _policy = control_fixture(board, tmp_path)
    atomic_json(control.registry_path, {tid: {'executionId': 'previous', 'state': 'running', 'pid': 987654321}})
    control.continuations[tid] = SimpleNamespace(poll=lambda: 0)
    control._reap()
    assert control._registry()[tid]['state'] == 'settled'


def test_desktop_wake_branch_queues_each_distinct_message(monkeypatch):
    from misaka.core.platform import cards
    queued, woke = [], []
    target = {'to_addr': 'fixture', 'to_task': 't_fixture', 'to_session': None, 'generation': 1,
              'workspace': 'synthetic-workspace', 'wake_card': True, 'label': 'fixture'}
    monkeypatch.setattr(messages, 'resolve_address', lambda *a, **kw: dict(target))
    def post(target, body, **kwargs):
        queued.append(body)
        return len(queued)
    monkeypatch.setattr(messages, 'post', post)
    monkeypatch.setattr(cards, 'append_log', lambda *a: None)
    monkeypatch.setattr(messages, '_SCOPE_WAKE_HOOK', lambda target, message: woke.append(target) or
                        {'execution_kind': 'desktop', 'execution_id': 'same-live-child', 'accepted': True, 'settled': False}, raising=False)
    messages.send_as('last-order', 'fixture', 'first question', 'first')
    messages.send_as('last-order', 'fixture', 'second question', 'second')
    assert queued == ['first question', 'second question']
    assert [target['message_id'] for target in woke] == [1, 2]


def test_dead_pending_launch_owner_is_recoverable_not_permanent_duplicate(board, tmp_path, monkeypatch):
    from misaka.core.platform import processes
    from misaka.desktop_research.model_policy import atomic_json
    control, tid, _run, _policy = control_fixture(board, tmp_path)
    atomic_json(control.registry_path, {tid: {'executionId': 'abandoned', 'state': 'pending',
                                            'ownerPid': 222222, 'ownerIdentity': 'dead-fixture-birth',
                                            'requests': ['stable-request'], 'generation': 1}})
    monkeypatch.setattr(processes, 'identity_is_alive', lambda *args: False)
    queued = []
    monkeypatch.setattr(control, '_queue', lambda *args: queued.append(args))
    out = control.wake_card({'to_task': tid, 'generation': 1, 'requestId': 'stable-request'}, 'fixture note')
    assert out['execution_id'] != 'abandoned'
    assert len(queued) == 1


async def test_reopened_host_automatically_recovers_report_without_resume(board, tmp_path, monkeypatch):
    # The bridge recovery helper must use real native JSONL persistence, never restart workflow.
    from misaka.agent.agent import Agent
    from misaka.cli import desktop_bridge as bridge
    from misaka.core.agent_session import AgentSession
    from misaka.core.session_manager import SessionManager
    run = runs.create(board, workspace=str(tmp_path), question='Fixture recovered report')
    report = tmp_path / 'report.md'
    report.write_text('# Actual recovered report', encoding='utf-8')
    import hashlib
    aid, _ = runs.register_file(board, run['id'], 'report', 'Final', str(report),
                               sha256=hashlib.sha256(report.read_bytes()).hexdigest())
    session = object.__new__(AgentSession)
    session.agent = Agent({"streamFn": lambda *_: None})
    session._customMessageReceipts = {}
    manager = SessionManager.create(str(tmp_path), str(tmp_path / 'sessions'))
    manager.rewrite_file()
    session.sessionManager = SessionManager.open(manager.sessionFile)
    runs.set_state(board, run['id'], status='done', phase='done', root_session=manager.sessionFile, final_artifact=aid)
    from misaka.core.research.wiring import research
    part = research.ResearchPart()
    def send(payload, options):
        session._customMessageReceipts[options['_deliveryId']] = options
        session._appendCustomMessage({'role': 'custom', **payload,
            'details': {**payload['details'], 'delivery_id': options['_deliveryId']}})
    session.moments = SimpleNamespace(parts=[part], send_message=send)
    part.attach(session)
    assert await bridge.recover_research_report(session, board) == 'delivered'
    assert await bridge.recover_research_report(session, board) == 'delivered'
    entries = session.sessionManager.getEntries()
    assert len([e for e in entries if e.get('customType') == 'research-final']) == 1
    assert runs.get(board, run['id'])['status'] == 'done'


async def test_same_host_reconnect_retries_failed_native_persistence(board, tmp_path, monkeypatch):
    import hashlib

    from misaka.agent.agent import Agent
    from misaka.cli import desktop_bridge as bridge
    from misaka.core.agent_session import AgentSession
    from misaka.core.research import delivery
    from misaka.core.research.wiring import research
    from misaka.core.session_manager import SessionManager
    run = runs.create(board, workspace=str(tmp_path), question='Fixture retry delivery')
    report = tmp_path / 'retry-report.md'
    report.write_text('# Persisted retry body', encoding='utf-8')
    aid, _ = runs.register_file(board, run['id'], 'report', 'Final', str(report),
                               sha256=hashlib.sha256(report.read_bytes()).hexdigest())
    session = object.__new__(AgentSession)
    session.agent = Agent({"streamFn": lambda *_: None})
    session._customMessageReceipts = {}
    session.sessionManager = SessionManager.create(str(tmp_path), str(tmp_path / 'sessions'))
    session.sessionManager.rewrite_file()
    runs.set_state(board, run['id'], status='done', phase='done',
                   root_session=session.sessionManager.sessionFile, final_artifact=aid)
    part = research.ResearchPart()
    part.attach(session)
    original = session.sessionManager.appendCustomMessageEntry
    attempts = []
    def append(*args, **kwargs):
        attempts.append(True)
        if len(attempts) == 1:
            raise OSError('fixture transient disk failure')
        return original(*args, **kwargs)
    monkeypatch.setattr(session.sessionManager, 'appendCustomMessageEntry', append)
    def send(payload, options):
        session._customMessageReceipts[options['_deliveryId']] = options
        try:
            session._appendCustomMessage({'role': 'custom', **payload,
                'details': {**payload['details'], 'delivery_id': options['_deliveryId']}})
        except OSError:
            pass  # native Moments logs async send errors; _onError already received the failure
    session.moments = SimpleNamespace(parts=[part], send_message=send)
    assert await bridge.recover_research_report(session, board) == 'failed'
    assert delivery.snapshot(board, run['id'])['state'] == 'failed'
    assert await bridge.recover_research_report(session, board) == 'delivered'
    assert len(attempts) == 2
    receipts = board.execute('SELECT COUNT(*) FROM events WHERE task_id=? AND kind=?', (run['id'], delivery.KIND)).fetchone()[0]
    assert await bridge.recover_research_report(session, board) == 'delivered'
    assert board.execute('SELECT COUNT(*) FROM events WHERE task_id=? AND kind=?', (run['id'], delivery.KIND)).fetchone()[0] == receipts
    assert len([e for e in session.sessionManager.getEntries() if e.get('customType') == 'research-final']) == 1


def test_parse_card_prompt_file_keeps_long_unicode_and_generation(tmp_path):
    from misaka.desktop_research.worker_entry import parse_card_flags
    prompt = tmp_path / "continuation.md"
    text = "研究上下文\r\n" * 20000
    prompt.write_bytes(text.encode("utf-8"))
    assert parse_card_flags(["--run-card", "t_ab12cd", "--say-file", str(prompt),
        "--expected-generation", "8", "--consult"]) == ("t_ab12cd", text, 8, True)


def test_long_continuation_prompt_is_a_file_until_child_settles(board, tmp_path, monkeypatch):
    from misaka.desktop_research import card_control
    from misaka.desktop_research.model_policy import atomic_json
    from misaka.utils.prompt_file import readPromptFile
    control, tid, _run, policy = control_fixture(board, tmp_path)
    message = "很长的研究问题\r\n" * 20000
    atomic_json(control.registry_path, {tid: {"executionId": "long", "state": "pending", "generation": 1}})
    seen = {}
    class Process:
        pid = 987654321
        def poll(self):
            return 0
    def spawn(argv, **kwargs):
        assert "--say" not in argv and message not in argv
        path = argv[argv.index("--say-file") + 1]
        seen["path"] = Path(path)
        assert readPromptFile(path) == message
        assert argv[argv.index("--expected-generation") + 1] == "1" and "--consult" in argv
        return Process()
    monkeypatch.setattr(card_control.subprocess, "Popen", spawn)
    pending = card_control._PendingLaunch(control, tid, message, 1, "long", str(tmp_path))
    control._launch(pending)
    assert "path" in seen, str(control._registry())
    assert seen["path"].exists()
    control._reap()
    assert not seen["path"].exists() and control.prompt_files == {}
