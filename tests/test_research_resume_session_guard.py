"""`/research resume` typed in a window other than the run's Last Order conversation used to
adopt that window silently: root_session and the root node's session file were rebound to a
Last Order that remembered none of the run's turns, and the red team's deliberation source
moved with them (2026-09-23 23:27). The window path now refuses unless the session matches or
`--here` says the adoption is meant; the CLI path, which reopens the saved session, is
unchanged."""
import asyncio
import os
import socket
import time
from contextlib import closing
from types import SimpleNamespace

import pytest

from misaka.core.platform import repo, tasks
from misaka.core.research import runs, workflow
from misaka.core.research.wiring import research


@pytest.fixture
def board(tmp_path, monkeypatch):
    monkeypatch.setattr(repo, "enabled", lambda *a: False)
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        runs.init(con)
        yield con


@pytest.fixture
async def chat(board, tmp_path, monkeypatch):
    state = SimpleNamespace(notices=[], driven=[], started=asyncio.Event())
    monkeypatch.setattr(research, "_con", lambda: board)
    monkeypatch.setattr(research, "_cfg", dict)
    monkeypatch.delenv("MISAKA_NET_PANE", raising=False)

    async def drive(con, cfg, spawner, **kwargs):
        state.driven.append(kwargs)
        state.started.set()
        return {"reason": "stopped", "final": {"artifact": None, "path": None, "content": ""},
                "run": runs.summary(con, kwargs["run_id"])}

    monkeypatch.setattr(workflow, "run", drive)
    state.part = research.ResearchPart()
    state.part.attach(SimpleNamespace(moments=SimpleNamespace(
        send_message=lambda payload, options: None, send_user_message=lambda text: None)))
    state.ctx = SimpleNamespace(
        cwd=str(tmp_path), isIdle=lambda: True,
        sessionManager=SimpleNamespace(sessionId="fixture", sessionFile=str(tmp_path / "other-window.jsonl")),
        ui=SimpleNamespace(notify=lambda text, kind: state.notices.append((text, kind))))
    state.command = state.part.commands[0].handler
    run = runs.create(board, workspace=research._workspace(state.ctx), question="Fixture question")
    runs.set_state(board, run["id"], status="stopped", root_session=str(tmp_path / "root-window.jsonl"))
    state.run = run
    try:
        yield state
    finally:
        await state.part._cleanup({}, state.ctx)


def test_the_parser_reads_here_only_right_after_the_run_id():
    assert research.parse_command("resume r_1 --here") == {
        "action": "resume", "run_id": "r_1", "clarification": "", "here": True}
    assert research.parse_command("resume r_1 --here 1805 onwards") == {
        "action": "resume", "run_id": "r_1", "clarification": "1805 onwards", "here": True}
    assert research.parse_command("resume --here") == {
        "action": "resume", "run_id": None, "clarification": "", "here": True}
    assert research.parse_command("resume r_1 an answer that mentions --here") == {
        "action": "resume", "run_id": "r_1", "clarification": "an answer that mentions --here", "here": False}


async def test_a_foreign_window_is_refused_and_told_which_session_to_open(chat):
    await chat.command(f"resume {chat.run['id']}", chat.ctx)
    text, kind = chat.notices[-1]
    assert kind == "error" and "root-window.jsonl" in text and "--here" in text
    assert chat.driven == []


async def test_the_saved_window_and_an_explicit_here_both_resume(chat, tmp_path):
    chat.ctx.sessionManager.sessionFile = str(tmp_path / "root-window.jsonl")
    await chat.command(f"resume {chat.run['id']}", chat.ctx)
    await asyncio.wait_for(chat.started.wait(), 3)
    assert chat.driven[-1]["run_id"] == chat.run["id"] and chat.driven[-1]["resume"] is True
    assert chat.notices[-1][0].startswith("Resumed research run")

    chat.started.clear()
    chat.ctx.sessionManager.sessionFile = str(tmp_path / "other-window.jsonl")
    await chat.command(f"resume {chat.run['id']} --here", chat.ctx)
    await asyncio.wait_for(chat.started.wait(), 3)
    assert len(chat.driven) == 2 and chat.driven[-1]["clarification"] == ""


async def test_stop_reenters_a_waiting_run_with_no_live_driver(chat, board, tmp_path):
    chat.ctx.sessionManager.sessionFile = str(tmp_path / "root-window.jsonl")
    runs.set_state(board, chat.run["id"], status="waiting_input", phase="waiting_input")

    await chat.command(f"stop {chat.run['id']}", chat.ctx)
    await asyncio.wait_for(chat.started.wait(), 3)

    assert chat.driven[-1]["run_id"] == chat.run["id"]
    assert chat.driven[-1].get("resume") is not True
    assert "Stop request recorded" in chat.notices[-1][0]


@pytest.mark.parametrize("lease", ["absent", "expired", "dead-local"])
async def test_stop_reenters_persisted_stopping_run_after_driver_disappears(chat, board, lease):
    """An orphaned stop needs a settlement driver, not another user/model turn."""
    runs.set_state(board, chat.run["id"], status="stopping")
    runs.request_stop(board, chat.run["id"])
    if lease == "expired":
        lock, expires = "driver:remote-fixture:42:old", int(time.time()) - 10
    elif lease == "dead-local":
        lock, expires = f"driver:{socket.gethostname()}:2147483647:dead", int(time.time()) + 600
    else:
        lock, expires = None, None
    board.execute("UPDATE research_runs SET driver_lock=?,driver_expires=? WHERE id=?",
                  (lock, expires, chat.run["id"]))

    await chat.command(f"stop {chat.run['id']}", chat.ctx)
    await asyncio.wait_for(chat.started.wait(), 3)

    assert len(chat.driven) == 1
    assert chat.driven[0]["run_id"] == chat.run["id"]
    assert chat.driven[0]["resume"] is False
    assert runs.get(board, chat.run["id"])["stop_requested"] == 1


@pytest.mark.parametrize("lock", [
    f"driver:{socket.gethostname()}:{os.getpid()}:live",
    "driver:remote-fixture:42:live",
])
async def test_stop_does_not_duplicate_a_live_or_foreign_driver(chat, board, lock):
    runs.set_state(board, chat.run["id"], status="stopping")
    runs.request_stop(board, chat.run["id"])
    board.execute("UPDATE research_runs SET driver_lock=?,driver_expires=? WHERE id=?",
                  (lock, int(time.time()) + 600, chat.run["id"]))

    await chat.command(f"stop {chat.run['id']}", chat.ctx)
    await asyncio.sleep(0)

    assert chat.driven == []
    assert runs.get(board, chat.run["id"])["stop_requested"] == 1
    assert "Stop request recorded" in chat.notices[-1][0]


@pytest.mark.parametrize("status", ["stopped", "failed", "done"])
async def test_repeated_stop_on_terminal_run_does_not_redrive(chat, board, status):
    runs.set_state(board, chat.run["id"], status=status, error="previous failure" if status == "failed" else None)

    await chat.command(f"stop {chat.run['id']}", chat.ctx)
    await asyncio.sleep(0)

    current = runs.get(board, chat.run["id"])
    assert current["status"] == status
    assert current["stop_requested"] == 0
    assert current["last_error"] == ("previous failure" if status == "failed" else None)
    assert chat.driven == []
    assert f"already {status}" in chat.notices[-1][0]
