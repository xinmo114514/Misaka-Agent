"""/research stop RUN_ID on a run that has ended says so and drives nothing: the driver it
started ran the failed run again, its turns spent for a stop (0.18.10 sweep)."""
import asyncio
from contextlib import asynccontextmanager, closing
from types import SimpleNamespace

import pytest

from misaka.core.platform import repo, tasks
from misaka.core.research import runs
from misaka.core.research import window as research_window
from misaka.core.research.wiring import research


@pytest.fixture
def board(tmp_path, monkeypatch):
    monkeypatch.setattr(repo, "enabled", lambda *a: False)
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        runs.init(con)
        yield con


async def test_stopping_a_run_that_has_ended_drives_nothing(board, tmp_path, monkeypatch):
    notices, opened = [], []
    monkeypatch.setattr(research, "_con", lambda: board)
    monkeypatch.setattr(research, "_cfg", lambda: {"db": str(tmp_path / "board.db"), "roles_root": str(tmp_path)})
    monkeypatch.delenv("MISAKA_NET_PANE", raising=False)

    @asynccontextmanager
    async def fake_node_session(con, cfg, run, node):
        opened.append((run["status"], run["stop_requested"]))
        raise RuntimeError("SENTINEL: root Last Order session opened")
        yield
    monkeypatch.setattr(research_window, "node_session", fake_node_session)

    class FakeWindow:
        def __init__(self, session, check_active, **kw):
            current = runs.get(board, run["id"])
            opened.append((current["status"], current["stop_requested"]))
            raise RuntimeError("SENTINEL: root Last Order window driven")
    monkeypatch.setattr(research_window, "WindowLO", FakeWindow)

    part = research.ResearchPart()
    sent = []
    part.attach(SimpleNamespace(moments=SimpleNamespace(
        send_message=lambda payload, options: sent.append(payload), send_user_message=lambda t: None)))
    ctx = SimpleNamespace(cwd=str(tmp_path), isIdle=lambda: True,
                          sessionManager=SimpleNamespace(sessionId="s", sessionFile=str(tmp_path / "w.jsonl")),
                          ui=SimpleNamespace(notify=lambda text, kind: notices.append((text, kind))))
    run = runs.create(board, workspace=research._workspace(ctx), question="Fixture question")
    runs.set_state(board, run["id"], status="failed", error="earlier failure")
    await part.commands[0].handler(f"stop {run['id']}", ctx)
    for _ in range(50):
        await asyncio.sleep(0.05)
        if sent:
            break
    await part._cleanup({}, ctx)
    assert opened == [] and "already failed" in notices[0][0]
    assert runs.get(board, run["id"])["last_error"] == "earlier failure"
