"""Task 4: the final report is the real artifact, delivered once, only from its own root.

The 2026-10-11 audit: deliver_final_report fell back to "run finished" prose when the artifact
could not be read, labelled it authoritative and burned the delivery id — a report that could
never arrive and could never be repaired. These tests drive the real ResearchPart command with
a real board: a missing/changed/foreign artifact must produce a structured error and leave the
delivery identity unused; the true root receives the true text exactly once.
"""
from __future__ import annotations

import hashlib
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace

import pytest

from misaka.core.platform import tasks
from misaka.core.research import runs
from misaka.core.research.wiring import research


@pytest.fixture
def board(tmp_path, monkeypatch):
    from misaka.core.platform import repo
    monkeypatch.setattr(repo, "enabled", lambda *a: False)
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        runs.init(con)
        yield con


def _part(sent, notices):
    part = research.ResearchPart()
    part.attach(SimpleNamespace(moments=SimpleNamespace(
        send_message=lambda payload, options: sent.append((payload, options)),
        send_user_message=lambda t: None)))
    return part


def _ctx(tmp_path, session_file, notices=None):
    notices = notices if notices is not None else []
    return SimpleNamespace(cwd=str(tmp_path), isIdle=lambda: True,
                           sessionManager=SimpleNamespace(sessionId="s", sessionFile=str(session_file)),
                           ui=SimpleNamespace(notify=lambda text, kind=None: notices.append((text, kind))))


def _done_run(board, tmp_path, *, content=b"# Complete report content", corrupt=False):
    run = runs.create(board, workspace=str(tmp_path), question="Completed research question")
    report = tmp_path / "report.md"
    report.write_text(content.decode("utf-8"), encoding="utf-8")
    digest = hashlib.sha256(content).hexdigest()
    aid, _ = runs.register_file(board, run["id"], "report", "Final Report", str(report), sha256=digest)
    if corrupt:
        report.write_text("changed behind the registry", encoding="utf-8")
    runs.set_state(board, run["id"], status="done", phase="done", final_artifact=aid)
    return run, aid


def _root_context(tmp_path, run):
    root = Path(dict(runs.get_board if False else run).get("root") or tmp_path / "root.jsonl")
    return root


async def test_a_missing_artifact_yields_a_structured_error_and_no_delivery(board, tmp_path, monkeypatch):
    monkeypatch.setattr(research, "_con", lambda: board)
    monkeypatch.setattr(research, "_cfg", lambda: {"db": str(tmp_path / "board.db"), "roles_root": str(tmp_path)})
    run, aid = _done_run(board, tmp_path)
    Path(runs.artifact(board, aid)["path"]).unlink()
    sent, notices = [], []
    part = _part(sent, notices)
    await part.commands[0].handler(f"resume {run['id']}", _ctx(tmp_path, tmp_path / "root.jsonl", notices))
    assert sent and sent[0][0]["customType"] == "research-error"
    assert sent[0][0]["details"]["errorCode"] == "RESEARCH_REPORT_UNAVAILABLE"
    assert opts_with(sent) is False


def opts_with(sent):
    return any("_deliveryId" in options for _payload, options in sent)


async def test_a_changed_artifact_is_refused_not_delivered(board, tmp_path, monkeypatch):
    monkeypatch.setattr(research, "_con", lambda: board)
    monkeypatch.setattr(research, "_cfg", lambda: {"db": str(tmp_path / "board.db"), "roles_root": str(tmp_path)})
    run, _aid = _done_run(board, tmp_path, corrupt=True)
    sent, notices = [], []
    part = _part(sent, notices)
    await part.commands[0].handler(f"resume {run['id']}", _ctx(tmp_path, tmp_path / "root.jsonl", notices))
    assert sent and sent[0][0]["customType"] == "research-error"
    assert opts_with(sent) is False


async def test_foreign_window_is_refused_before_any_delivery(board, tmp_path, monkeypatch):
    monkeypatch.setattr(research, "_con", lambda: board)
    monkeypatch.setattr(research, "_cfg", lambda: {"db": str(tmp_path / "board.db"), "roles_root": str(tmp_path)})
    run, _aid = _done_run(board, tmp_path)
    root = tmp_path / "saved-root.jsonl"
    runs.set_state(board, run["id"], root_session=str(root))
    sent, notices = [], []
    part = _part(sent, notices)
    await part.commands[0].handler(f"resume {run['id']}", _ctx(tmp_path, tmp_path / "other.jsonl", notices))
    assert sent == []
    assert notices and "belongs to the Last Order conversation" in notices[0][0]


async def test_the_true_root_receives_the_true_text_once(board, tmp_path, monkeypatch):
    monkeypatch.setattr(research, "_con", lambda: board)
    monkeypatch.setattr(research, "_cfg", lambda: {"db": str(tmp_path / "board.db"), "roles_root": str(tmp_path)})
    run, aid = _done_run(board, tmp_path)
    root = tmp_path / "saved-root.jsonl"
    runs.set_state(board, run["id"], root_session=str(root))
    sent, notices = [], []
    part = _part(sent, notices)
    await part.commands[0].handler(f"resume {run['id']}", _ctx(tmp_path, root, notices))
    assert len(sent) == 1
    payload, options = sent[0]
    assert payload["customType"] == "research-final"
    assert "Complete report content" in payload["content"]
    assert "# Delivered final report" in payload["content"]
    assert options["_deliveryId"] == f"research-final:{run['id']}:{aid}"


async def test_another_runs_artifact_is_refused(board, tmp_path, monkeypatch):
    monkeypatch.setattr(research, "_con", lambda: board)
    monkeypatch.setattr(research, "_cfg", lambda: {"db": str(tmp_path / "board.db"), "roles_root": str(tmp_path)})
    run, aid = _done_run(board, tmp_path)
    runs.create(board, workspace=str(tmp_path), question="Another run")
    runs.set_state(board, run["id"], final_artifact=aid)
    # Point the run at an artifact owned by a different run id.
    stray = runs.create(board, workspace=str(tmp_path), question="Stray")
    import pathlib
    stray_file = pathlib.Path(tmp_path) / "stray.md"
    stray_file.write_text("# Stray", encoding="utf-8")
    stray_aid, _ = runs.register_file(board, stray["id"], "report", "Stray", str(stray_file),
                                      sha256=hashlib.sha256(b"# Stray").hexdigest())
    runs.set_state(board, run["id"], final_artifact=stray_aid)
    sent, notices = [], []
    part = _part(sent, notices)
    await part.commands[0].handler(f"resume {run['id']}", _ctx(tmp_path, tmp_path / "root.jsonl", notices))
    assert sent and sent[0][0]["customType"] == "research-error"
    assert opts_with(sent) is False


async def test_delivery_stays_pending_until_native_persistence_confirmation(board, tmp_path, monkeypatch):
    monkeypatch.setattr(research, '_con', lambda: board)
    run, _aid = _done_run(board, tmp_path)
    sent = []
    part = _part(sent, [])
    part.deliver_final_report(run['id'], con=board)
    _payload, options = sent[-1]
    assert callable(options.get('_onPersist'))
    assert callable(options.get('_onError'))
    assert runs.summary(board, run['id'])['reportDelivery']['state'] == 'pending'
    options['_onError'](OSError('fixture disk full'))
    assert runs.summary(board, run['id'])['reportDelivery']['state'] == 'failed'
    part.deliver_final_report(run['id'], con=board)
    sent[-1][1]['_onPersist']()
    assert runs.summary(board, run['id'])['reportDelivery']['state'] == 'delivered'
    assert runs.get(board, run['id'])['status'] == 'done'


async def test_partial_delivery_has_incomplete_identity(board, tmp_path, monkeypatch):
    monkeypatch.setattr(research, '_con', lambda: board)
    run, _aid = _done_run(board, tmp_path)
    runs.set_state(board, run['id'], status='stopped', phase='stopped')
    sent = []
    part = _part(sent, [])
    part.deliver_final_report(run['id'], con=board)
    payload, options = sent[-1]
    assert 'incomplete' in payload['content'].lower()
    assert 'authoritative version' not in payload['content']
    assert payload['details']['incomplete'] is True
    assert options['_deliveryId'].startswith('research-partial:')


async def test_final_override_does_not_replace_registered_final_identity(board, tmp_path, monkeypatch):
    monkeypatch.setattr(research, '_con', lambda: board)
    run, aid = _done_run(board, tmp_path)
    other = tmp_path / 'other.md'
    other.write_text('wrong report', encoding='utf-8')
    other_aid, _ = runs.register_file(board, run['id'], 'report', 'Other', str(other),
                                    sha256=hashlib.sha256(b'wrong report').hexdigest())
    sent = []
    part = _part(sent, [])
    part.deliver_final_report(run['id'], final={'artifact': other_aid, 'content': 'caller prose'}, con=board)
    assert sent[-1][0]['details']['final_artifact'] == aid
    assert 'Complete report content' in sent[-1][0]['content']


def test_done_partial_result_preserves_registered_final(board, tmp_path):
    from misaka.core.research import workflow
    run, aid = _done_run(board, tmp_path)
    result = workflow._partial_result(board, dict(runs.get(board, run['id'])), 'late cancellation')
    assert runs.get(board, run['id'])['status'] == 'done'
    assert runs.get(board, run['id'])['final_artifact'] == aid
    assert result['reason'] == 'done'


async def test_real_jsonl_report_persistence_repair_and_lost_ack(board, tmp_path):
    from misaka.agent.agent import Agent
    from misaka.core.agent_session import AgentSession
    from misaka.core.research import delivery
    from misaka.core.session_manager import SessionManager
    run, aid = _done_run(board, tmp_path)
    session = object.__new__(AgentSession)
    session.agent = Agent()
    session._customMessageReceipts = {}
    session.sessionManager = SessionManager.create(str(tmp_path), str(tmp_path / 'sessions'))
    session.sessionManager.rewrite_file()
    root = session.sessionManager.sessionFile
    runs.set_state(board, run['id'], root_session=root)
    current = dict(runs.get(board, run['id']))
    original_id = f"research-final:{run['id']}:{aid}"
    session.sessionManager.appendCustomMessageEntry('research-final', 'old placeholder', True,
                                                    {'delivery_id': original_id, 'run_id': run['id']})
    def send(payload, options):
        message = {'role': 'custom', **payload,
                   'details': {**payload['details'], 'delivery_id': options['_deliveryId']}}
        session._customMessageReceipts[options['_deliveryId']] = options
        session._append_custom_message(message)
    prepared = delivery.prepare_final_delivery(board, current, session)
    assert await delivery.persist_final_delivery(board, current, prepared, session, send) == 'delivered'
    saved = session.sessionManager.getEntries()
    repaired = [e for e in saved if e.get('customType') == 'research-final' and
                'Complete report content' in str(e.get('content'))]
    assert len(repaired) == 1
    assert repaired[0]['details']['delivery_id'].startswith('research-final-repair:')
    # Simulate a lost receipt while the JSONL report survived, then reopen the true file.
    board.execute("DELETE FROM events WHERE task_id=? AND kind=?", (run['id'], delivery.KIND))
    session.sessionManager = SessionManager.open(root)
    def duplicate(*args):
        raise AssertionError('persisted report was appended twice')
    assert await delivery.persist_final_delivery(board, current, prepared, session, duplicate) == 'delivered'
    assert delivery.snapshot(board, run['id'])['state'] == 'delivered'


def test_activity_timestamp_ignores_heartbeat_and_polling(board, tmp_path):
    run, _aid = _done_run(board, tmp_path)
    board.execute('INSERT INTO events(task_id,kind,payload,run_id,created_at) VALUES(?,?,?,?,?)',
                  (run['id'], 'research-progress', '{}', run['id'], 123))
    board.execute('UPDATE research_runs SET created_at=100,updated_at=999 WHERE id=?', (run['id'],))
    board.execute('INSERT INTO events(task_id,kind,payload,run_id,created_at) VALUES(?,?,?,?,?)',
                  (run['id'], 'heartbeat', '{}', run['id'], 999))
    assert runs.summary(board, run['id'])['lastActivityAt'] == 123000
    assert runs.summary(board, run['id'])['lastActivityAt'] == 123000
