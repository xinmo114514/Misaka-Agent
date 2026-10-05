"""Tests for the Misaka desktop bridge (JSONL stdio protocol)."""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from typing import Any

import pytest

from misaka.cli.desktop_bridge import run_desktop_bridge
from misaka.core.output_guard import isStdoutTakenOver, restoreStdout, takeOverStdout


class MockAgent:
    def __init__(self) -> None:
        self.listeners: list[Any] = []

    def subscribe(self, fn: Any) -> Any:
        self.listeners.append(fn)
        return lambda: self.listeners.remove(fn) if fn in self.listeners else None

    def abort(self) -> None:
        pass


class MockSessionManager:
    def getCwd(self) -> str:
        return os.getcwd()


class MockSession:
    def __init__(self, session_id: str = "test-session-123") -> None:
        self.sessionId = session_id
        self.isStreaming = False
        self.agent = MockAgent()
        self.sessionManager = MockSessionManager()
        self.listeners: list[Any] = []
        self.aborted_count = 0
        self.thinking_level = "off"

    def subscribe(self, fn: Any) -> Any:
        self.listeners.append(fn)
        return lambda: self.listeners.remove(fn) if fn in self.listeners else None

    def emit(self, event: Any) -> None:
        for fn in list(self.listeners):
            fn(event)

    async def prompt(self, text: str, options: Any = None) -> None:
        self.isStreaming = True
        try:
            self.emit({"type": "agent_start"})
            self.emit({
                "type": "message_update",
                "message": {"role": "assistant", "usage": {"input": 10}},
                "assistantMessageEvent": {"type": "text_delta", "delta": "Hello "},
            })
            self.emit({
                "type": "message_update",
                "message": {"role": "assistant", "usage": {"input": 10}},
                "assistantMessageEvent": {"type": "text_delta", "delta": "world!"},
            })
            self.emit({
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "Hello world!"}],
                },
            })
            self.emit({"type": "agent_end"})
        finally:
            self.isStreaming = False

    async def steer(self, text: str, images: Any = None) -> None:
        pass

    async def followUp(self, text: str, images: Any = None) -> None:
        pass

    async def abort(self) -> None:
        self.aborted_count += 1
        self.isStreaming = False

    async def waitForIdle(self) -> None:
        pass

    def setThinkingLevel(self, level: str, persist: bool = False) -> None:
        self.thinking_level = level

    def getSessionStats(self) -> dict[str, Any]:
        return {"sessionId": self.sessionId, "totalMessages": 2}

    def getContextUsage(self) -> dict[str, Any]:
        return {"tokens": 100, "contextWindow": 1000000, "percent": 0.01}

    def getAllTools(self) -> list[Any]:
        return []

    def getSlashCommands(self) -> list[Any]:
        return []

    async def bindExtensions(self, ext: Any) -> None:
        pass


class MockRuntimeHost:
    def __init__(self, session: Any = None) -> None:
        self.session = session or MockSession()
        self.rebind_handler: Any = None
        self.disposed = False
        self.new_session_calls: list[Any] = []
        self.switch_session_calls: list[Any] = []

    def setRebindSession(self, fn: Any) -> None:
        self.rebind_handler = fn

    async def switchSession(self, path: str) -> None:
        self.switch_session_calls.append(path)

    async def newSession(self, options: Any = None) -> dict[str, Any]:
        self.new_session_calls.append(options)
        return {"cancelled": False}

    async def dispose(self) -> None:
        self.disposed = True


@pytest.mark.asyncio
async def test_invalid_json_line_returns_error_ack_and_survives(monkeypatch: pytest.MonkeyPatch) -> None:
    session = MockSession()
    runtime = MockRuntimeHost(session)

    input_lines = (
        "not a valid json\n"
        '{"type": "get_stats", "requestId": "req-2"}\n'
        '{"type": "shutdown", "requestId": "req-3"}\n'
    )
    fake_stdin = io.StringIO(input_lines)
    output_capture = io.StringIO()

    monkeypatch.setattr(sys, "stdin", fake_stdin)
    import misaka.cli.desktop_bridge as bridge_mod
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output_capture.write)

    exit_code = await run_desktop_bridge(runtime)
    assert exit_code == 0

    lines = [json.loads(line) for line in output_capture.getvalue().strip().splitlines() if line]
    assert len(lines) == 3

    # First line: error ack for invalid JSON
    assert lines[0]["type"] == "ack"
    assert lines[0]["requestId"] is None
    assert lines[0]["ok"] is False
    assert "Invalid JSON" in lines[0]["error"]

    # Second line: success ack for get_stats
    assert lines[1]["type"] == "ack"
    assert lines[1]["requestId"] == "req-2"
    assert lines[1]["ok"] is True
    assert "stats" in lines[1]["data"]

    # Third line: success ack for shutdown
    assert lines[2]["type"] == "ack"
    assert lines[2]["requestId"] == "req-3"
    assert lines[2]["ok"] is True


@pytest.mark.asyncio
async def test_seq_is_monotonically_increasing(monkeypatch: pytest.MonkeyPatch) -> None:
    session = MockSession()
    runtime = MockRuntimeHost(session)

    input_lines = (
        '{"type": "prompt", "requestId": "p1", "text": "hello"}\n'
        '{"type": "shutdown", "requestId": "p2"}\n'
    )
    fake_stdin = io.StringIO(input_lines)
    output_capture = io.StringIO()

    monkeypatch.setattr(sys, "stdin", fake_stdin)
    import misaka.cli.desktop_bridge as bridge_mod
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output_capture.write)

    exit_code = await run_desktop_bridge(runtime)
    assert exit_code == 0

    lines = [json.loads(line) for line in output_capture.getvalue().strip().splitlines() if line]
    event_lines = [item for item in lines if "event" in item]

    assert len(event_lines) >= 4
    seq_list = [item["seq"] for item in event_lines]
    assert seq_list == list(range(1, len(seq_list) + 1))
    for i in range(len(seq_list) - 1):
        assert seq_list[i + 1] > seq_list[i]


@pytest.mark.asyncio
async def test_message_end_convergence(monkeypatch: pytest.MonkeyPatch) -> None:
    """Client stream convergence: delta stream converges to authoritative message_end."""
    session = MockSession()
    runtime = MockRuntimeHost(session)

    # Custom prompt that emits a partial stream and then an authoritative message_end
    async def custom_prompt(text: str, options: Any = None) -> None:
        session.emit({
            "type": "message_update",
            "message": {"role": "assistant", "usage": {"input": 5}},
            "assistantMessageEvent": {"type": "text_delta", "delta": "Partial draft"},
        })
        session.emit({
            "type": "message_update",
            "message": {"role": "assistant", "usage": {"input": 10}},
            "assistantMessageEvent": {"type": "text_delta", "delta": " with typo"},
        })
        # Authoritative message_end fixes/replaces the content
        session.emit({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "Authoritative final clean response."}],
            },
        })

    session.prompt = custom_prompt  # type: ignore[assignment]

    input_lines = (
        '{"type": "prompt", "requestId": "c1", "text": "test"}\n'
        '{"type": "shutdown", "requestId": "c2"}\n'
    )
    fake_stdin = io.StringIO(input_lines)
    output_capture = io.StringIO()

    monkeypatch.setattr(sys, "stdin", fake_stdin)
    import misaka.cli.desktop_bridge as bridge_mod
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output_capture.write)

    exit_code = await run_desktop_bridge(runtime)
    assert exit_code == 0

    lines = [json.loads(line) for line in output_capture.getvalue().strip().splitlines() if line]

    # Replicate client consumption logic
    accumulated_deltas = []
    final_content = None

    for item in lines:
        if "event" not in item:
            continue
        ev = item["event"]
        ev_type = ev.get("type")
        if ev_type == "message_update":
            delta = ev.get("assistantMessageEvent", {}).get("delta", "")
            accumulated_deltas.append(delta)
        elif ev_type == "message_end":
            content_blocks = ev.get("message", {}).get("content", [])
            for block in content_blocks:
                if block.get("type") == "text":
                    final_content = block.get("text")

    # The delta concatenation is different from the authoritative end
    streamed_text = "".join(accumulated_deltas)
    assert streamed_text == "Partial draft with typo"
    assert final_content == "Authoritative final clean response."
    assert streamed_text != final_content


@pytest.mark.asyncio
async def test_abort_idempotency(monkeypatch: pytest.MonkeyPatch) -> None:
    session = MockSession()
    runtime = MockRuntimeHost(session)

    input_lines = (
        '{"type": "abort", "requestId": "a1"}\n'
        '{"type": "abort", "requestId": "a2"}\n'
        '{"type": "shutdown", "requestId": "a3"}\n'
    )
    fake_stdin = io.StringIO(input_lines)
    output_capture = io.StringIO()

    monkeypatch.setattr(sys, "stdin", fake_stdin)
    import misaka.cli.desktop_bridge as bridge_mod
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output_capture.write)

    exit_code = await run_desktop_bridge(runtime)
    assert exit_code == 0

    lines = [json.loads(line) for line in output_capture.getvalue().strip().splitlines() if line]
    assert len(lines) == 3
    assert lines[0] == {"type": "ack", "requestId": "a1", "ok": True}
    assert lines[1] == {"type": "ack", "requestId": "a2", "ok": True}
    assert lines[2] == {"type": "ack", "requestId": "a3", "ok": True}
    assert session.aborted_count == 2


@pytest.mark.asyncio
async def test_unknown_command_returns_error_ack_and_survives(monkeypatch: pytest.MonkeyPatch) -> None:
    session = MockSession()
    runtime = MockRuntimeHost(session)

    input_lines = (
        '{"type": "non_existent_op", "requestId": "u1"}\n'
        '{"type": "get_stats", "requestId": "u2"}\n'
        '{"type": "shutdown", "requestId": "u3"}\n'
    )
    fake_stdin = io.StringIO(input_lines)
    output_capture = io.StringIO()

    monkeypatch.setattr(sys, "stdin", fake_stdin)
    import misaka.cli.desktop_bridge as bridge_mod
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output_capture.write)

    exit_code = await run_desktop_bridge(runtime)
    assert exit_code == 0

    lines = [json.loads(line) for line in output_capture.getvalue().strip().splitlines() if line]
    assert len(lines) == 3
    assert lines[0]["type"] == "ack"
    assert lines[0]["requestId"] == "u1"
    assert lines[0]["ok"] is False
    assert "Unknown command" in lines[0]["error"]

    assert lines[1]["type"] == "ack"
    assert lines[1]["requestId"] == "u2"
    assert lines[1]["ok"] is True


@pytest.mark.asyncio
async def test_stdout_contains_only_valid_json_lines(monkeypatch: pytest.MonkeyPatch) -> None:
    session = MockSession()
    runtime = MockRuntimeHost(session)

    # Simulate some stdout-polluting print that should NOT leak into protocol stdout
    takeOverStdout()

    input_lines = (
        '{"type": "set_theme", "requestId": "t1", "name": "dark"}\n'
        'bad line\n'
        '{"type": "shutdown", "requestId": "t2"}\n'
    )
    fake_stdin = io.StringIO(input_lines)
    output_capture = io.StringIO()

    monkeypatch.setattr(sys, "stdin", fake_stdin)
    import misaka.cli.desktop_bridge as bridge_mod
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output_capture.write)

    # Some library attempts to write to stdout
    sys.stdout.write("Third party debug log message\n")

    try:
        exit_code = await run_desktop_bridge(runtime)
        assert exit_code == 0
    finally:
        if isStdoutTakenOver():
            restoreStdout()

    raw_output = output_capture.getvalue()
    for line in raw_output.strip().splitlines():
        parsed = json.loads(line)
        assert isinstance(parsed, dict)
        assert "type" in parsed or "seq" in parsed


def test_cli_pipe_integration() -> None:
    """End-to-end subprocess probe test with uv run misaka desktop-bridge."""
    cmd = ["uv", "run", "misaka", "desktop-bridge", "--no-session"]
    payload = json.dumps({"type": "get_stats", "requestId": "sub-1"}) + "\n"
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    stdout, _stderr = proc.communicate(payload, timeout=20)
    assert proc.returncode == 0

    lines = [json.loads(line) for line in stdout.strip().splitlines() if line]
    assert len(lines) >= 1
    assert lines[0]["type"] == "ack"
    assert lines[0]["requestId"] == "sub-1"
    assert lines[0]["ok"] is True
    assert "stats" in lines[0]["data"]


@pytest.mark.asyncio
async def test_switch_workspace_command_new_directory(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    session = MockSession()
    runtime = MockRuntimeHost(session)
    target_dir = str(tmp_path / "my_project")
    os.makedirs(target_dir, exist_ok=True)
    resolved_target = os.path.realpath(target_dir)

    input_lines = (
        json.dumps({"type": "switch_workspace", "requestId": "sw1", "path": target_dir}) + chr(10)
        + json.dumps({"type": "shutdown", "requestId": "bye"}) + chr(10)
    )
    output_capture = io.StringIO()
    monkeypatch.setattr(sys, "stdin", io.StringIO(input_lines))
    import misaka.cli.desktop_bridge as bridge_mod
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output_capture.write)

    exit_code = await run_desktop_bridge(runtime)
    assert exit_code == 0
    lines = [json.loads(line) for line in output_capture.getvalue().strip().splitlines() if line]
    ack = next(item for item in lines if item.get("requestId") == "sw1")
    assert ack.get("ok") is True
    assert ack["data"]["workspace"] == resolved_target
    assert runtime.new_session_calls == [{"cwd": resolved_target}]


@pytest.mark.asyncio
async def test_switch_workspace_command_invalid_directory(monkeypatch: pytest.MonkeyPatch) -> None:
    session = MockSession()
    runtime = MockRuntimeHost(session)
    non_existent = "non_existent_folder_xyz_12345"

    input_lines = (
        json.dumps({"type": "switch_workspace", "requestId": "sw2", "path": non_existent}) + chr(10)
        + json.dumps({"type": "shutdown", "requestId": "bye"}) + chr(10)
    )
    output_capture = io.StringIO()
    monkeypatch.setattr(sys, "stdin", io.StringIO(input_lines))
    import misaka.cli.desktop_bridge as bridge_mod
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output_capture.write)

    exit_code = await run_desktop_bridge(runtime)
    assert exit_code == 0
    lines = [json.loads(line) for line in output_capture.getvalue().strip().splitlines() if line]
    ack = next(item for item in lines if item.get("requestId") == "sw2")
    assert ack.get("ok") is False
    assert "Invalid workspace path" in ack.get("error", "")


@pytest.mark.asyncio
async def test_new_session_with_cwd(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    session = MockSession()
    runtime = MockRuntimeHost(session)
    target_dir = str(tmp_path / "custom_cwd")

    input_lines = (
        json.dumps({"type": "new_session", "requestId": "ns_cwd", "cwd": target_dir}) + chr(10)
        + json.dumps({"type": "shutdown", "requestId": "bye"}) + chr(10)
    )
    output_capture = io.StringIO()
    monkeypatch.setattr(sys, "stdin", io.StringIO(input_lines))
    import misaka.cli.desktop_bridge as bridge_mod
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output_capture.write)

    exit_code = await run_desktop_bridge(runtime)
    assert exit_code == 0
    assert runtime.new_session_calls == [{"carryOverContext": False, "cwd": target_dir}]


@pytest.mark.asyncio
async def test_tools_and_new_settings_bridge_commands(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from types import SimpleNamespace
    session = MockSession()
    sm = SimpleNamespace(default_thinking_level="off")
    sm.setDefaultThinkingLevel = lambda lvl: setattr(sm, "default_thinking_level", lvl)
    session.settingsManager = sm
    runtime = MockRuntimeHost(session)

    target_dir = str(tmp_path / "new_cwd")
    os.makedirs(target_dir, exist_ok=True)

    input_lines = chr(10).join([
        json.dumps({"type": "get_tools", "requestId": "gt1"}),
        json.dumps({"type": "set_cwd", "requestId": "scwd1", "path": target_dir}),
        json.dumps({"type": "set_default_thinking_level", "requestId": "sdtl1", "level": "high"}),
        json.dumps({"type": "get_diagnostics", "requestId": "diag1"}),
        json.dumps({"type": "shutdown", "requestId": "bye"}),
        "",
    ])
    output_capture = io.StringIO()
    monkeypatch.setattr(sys, "stdin", io.StringIO(input_lines))
    import misaka.cli.desktop_bridge as bridge_mod
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output_capture.write)

    exit_code = await run_desktop_bridge(runtime)
    assert exit_code == 0
    lines = [json.loads(line) for line in output_capture.getvalue().strip().splitlines() if line]
    acks = {item["requestId"]: item for item in lines if item.get("type") == "ack"}

    assert acks["gt1"]["ok"] is True
    assert "tools" in acks["gt1"]["data"]

    assert acks["scwd1"]["ok"] is True
    assert os.path.realpath(acks["scwd1"]["data"]["cwd"]) == os.path.realpath(target_dir)

    assert acks["sdtl1"]["ok"] is True
    assert getattr(sm, "default_thinking_level", None) == "high"

    assert acks["diag1"]["ok"] is True
    assert acks["diag1"]["data"]["bridgeStatus"] == "connected"
    assert "pythonVersion" in acks["diag1"]["data"]


def test_bridge_main_opens_a_last_order_session(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """The bridge must assemble a role session, not a bare engine one.

    Without an assembly, ``platform.session.open_session`` leaves parts/custom_tools None, so the
    desktop's conversation has no ResearchPart (no /research command), no TOOL_MODULES (no doc_*,
    no misaka_research_*) and no Last Order persona.
    """
    from types import SimpleNamespace
    import misaka.core.platform.session as session_mod
    from misaka.cli import desktop_bridge

    captured: dict[str, Any] = {}

    async def fake_open_session(flags, cwd, assembly=None):
        captured["flags"] = list(flags)
        captured["cwd"] = cwd
        captured["assembly"] = assembly
        return None, None, "captured"

    monkeypatch.setattr(session_mod, "open_session", fake_open_session)

    workspace = tmp_path / "project"
    workspace.mkdir()
    args = SimpleNamespace(cwd=str(workspace), session=None, model=None, theme=None, no_session=True)
    assert desktop_bridge.main(args) == 1

    assembly = captured["assembly"]
    assert assembly is not None, "the bridge opened a bare engine session"
    assert os.path.basename(assembly.spec.profile_dir) == "last_order"
    assert assembly.spec.receive_messages is False, "the bridge must not claim a mailbox"
    assert captured["cwd"] == str(workspace)
    # The persona is what makes her Last Order; a bare session has none.
    assert "--append-system-prompt" in captured["flags"]
    assert "--no-session" in captured["flags"] and "--mode" in captured["flags"]


def test_bridge_main_passes_the_model_to_the_role_setup_once(monkeypatch: pytest.MonkeyPatch,
                                                             tmp_path: Path) -> None:
    """A second --model would silently let the last flag win."""
    from types import SimpleNamespace
    import misaka.core.platform.session as session_mod
    from misaka.cli import desktop_bridge

    captured: dict[str, Any] = {}

    async def fake_open_session(flags, cwd, assembly=None):
        captured["flags"] = list(flags)
        captured["assembly"] = assembly
        return None, None, "captured"

    monkeypatch.setattr(session_mod, "open_session", fake_open_session)
    workspace = tmp_path / "project"
    workspace.mkdir()
    args = SimpleNamespace(cwd=str(workspace), session=None, model="anthropic/claude", theme=None,
                           no_session=False)
    desktop_bridge.main(args)

    assert captured["flags"].count("--model") == 1
    assert captured["flags"][captured["flags"].index("--model") + 1] == "anthropic/claude"


def test_serialize_session_entries_keeps_research_progress() -> None:
    """A research run reports itself to its own conversation as custom_message entries.

    Dropping them made a reopened run look like it had never run: the feed is the only record of
    which node started, which plan waits, and which card went to which Sister.
    """
    from misaka.cli.desktop_bridge import _serialize_session_entries

    entries = [
        {"type": "message", "id": "e1", "timestamp": "2026-10-05T00:00:00.000Z",
         "message": {"role": "user", "content": [{"type": "text", "text": "/research 2 on X"}],
                     "timestamp": 1}},
        {"type": "custom_message", "id": "e2", "timestamp": "2026-10-05T00:00:01.000Z",
         "customType": "research-progress", "display": True,
         "content": [{"type": "text", "text": "Research `r_1` | plan written"}],
         "details": {"run_id": "r_1", "stage": "plan_review", "node_id": "b_1"}},
        {"type": "custom_message", "id": "e3", "timestamp": "2026-10-05T00:00:02.000Z",
         "customType": "research-progress", "display": False, "content": "not for the feed",
         "details": {"run_id": "r_1"}},
        {"type": "message", "id": "e4", "timestamp": "2026-10-05T00:00:03.000Z",
         "message": {"role": "assistant", "content": [{"type": "text", "text": "Working."}],
                     "timestamp": 2}},
    ]
    out = _serialize_session_entries(entries)

    custom = [item for item in out if item["role"] == "custom"]
    assert len(custom) == 2, "both the list-content and the string-content form must survive"
    first = custom[0]
    assert first["customType"] == "research-progress"
    assert first["content"] == "Research `r_1` | plan written"
    assert first["details"] == {"run_id": "r_1", "stage": "plan_review", "node_id": "b_1"}
    assert first["entryId"] == "e2"
    # The engine decides what the feed shows; the bridge passes that on rather than deciding again.
    assert [item["display"] for item in custom] == [True, False]
    assert custom[1]["content"] == "not for the feed"
    # Ordinary turns are unaffected.
    assert [item["role"] for item in out if item["role"] != "custom"] == ["user", "assistant"]


def test_serialize_research_run_reports_who_owns_it(tmp_path, monkeypatch) -> None:
    """The desktop cannot offer an intervention without knowing who holds the run."""
    import sqlite3

    from misaka.cli.desktop_bridge import _serialize_research_run
    from misaka.config import home
    from misaka.core.platform import tasks
    from misaka.core.research import runs

    home_root = tmp_path / "home"
    home_root.mkdir()
    monkeypatch.setenv("MISAKA_HOME", str(home_root))
    workspace = tmp_path / "project"
    workspace.mkdir()

    directory = home.path("sessions") / "last_order"
    directory.mkdir(parents=True, exist_ok=True)
    window = directory / "own.jsonl"
    window.write_text("", encoding="utf-8")
    board = tmp_path / "board.db"
    # A lease names the driver's pid; only a live one reads as driving.
    lock = f"driver:testhost:{os.getpid()}:nonce"

    with tasks.connect(str(board)) as con:
        runs.init(con)
        run = runs.create(con, workspace=str(workspace), question="Ownership")
        runs.set_state(con, run["id"], root_session=str(window))
        runs.acquire_driver(con, run["id"], lock)

        # The read-only handle the bridge actually uses: a plain sqlite3.Row, which hands back the
        # raw home-relative pointer rather than the expanded one tasks.Row would.
        plain = sqlite3.connect(str(board))
        plain.row_factory = sqlite3.Row
        row = plain.execute("SELECT * FROM research_runs WHERE id=?", (run["id"],)).fetchone()
        assert not os.path.isabs(str(row["root_session"])), "premise: the board stores a relative name"

        out = _serialize_research_run(runs, con, row, session=None)
        assert out["rootSession"] == os.path.realpath(str(window))
        assert out["ownedByThisProcess"] is False
        assert out["driverLock"] == lock
        assert out["driving"] is True
        assert {"question", "createdAt", "updatedAt", "originSession", "driverExpires"} <= set(out)
        plain.close()

    # With this process's own conversation as the root window, the run is the desktop's.
    from types import SimpleNamespace
    with tasks.connect(str(board)) as con:
        plain = sqlite3.connect(str(board))
        plain.row_factory = sqlite3.Row
        row = plain.execute("SELECT * FROM research_runs WHERE id=?", (run["id"],)).fetchone()
        own = SimpleNamespace(sessionManager=SimpleNamespace(sessionFile=str(window)))
        out = _serialize_research_run(runs, con, row, own)
        assert out["ownedByThisProcess"] is True
        plain.close()

    # A driver that died mid-run must not keep the desktop from offering a resume.
    with tasks.connect(str(board)) as con:
        runs.release_driver(con, run["id"], lock)
        plain = sqlite3.connect(str(board))
        plain.row_factory = sqlite3.Row
        row = plain.execute("SELECT * FROM research_runs WHERE id=?", (run["id"],)).fetchone()
        out = _serialize_research_run(runs, con, row, None)
        assert out["driverLock"] is None and out["driving"] is False
        plain.close()


def test_a_dead_driver_lease_is_not_driving(tmp_path, monkeypatch) -> None:
    """``driving`` reuses the engine's own lease rules, so a killed terminal frees the run.

    A lease naming a *foreign* host is never judged from here (runs.py:336) -- only its TTL
    decides. The desktop has to inherit that exact asymmetry, or it would offer a takeover for a
    run another machine is still driving while refusing one whose driver died on this one.
    """
    import socket
    import sqlite3

    from misaka.cli.desktop_bridge import _serialize_research_run
    from misaka.config import home
    from misaka.core.platform import tasks
    from misaka.core.research import runs

    home_root = tmp_path / "home"
    home_root.mkdir()
    monkeypatch.setenv("MISAKA_HOME", str(home_root))
    workspace = tmp_path / "project"
    workspace.mkdir()
    directory = home.path("sessions") / "last_order"
    directory.mkdir(parents=True, exist_ok=True)
    board = tmp_path / "board.db"

    def row_for(lock):
        with tasks.connect(str(board)) as con:
            runs.init(con)
            run = runs.create(con, workspace=str(workspace), question="Dead driver")
            runs.set_state(con, run["id"], root_session=str(directory / "own.jsonl"))
            assert runs.acquire_driver(con, run["id"], lock) is True
            plain = sqlite3.connect(str(board))
            plain.row_factory = sqlite3.Row
            row = plain.execute("SELECT * FROM research_runs WHERE id=?", (run["id"],)).fetchone()
            out = _serialize_research_run(runs, con, row, None)
            plain.close()
        return out

    # A dead pid on this host: the driver crashed, so the run is free to take over.
    dead = row_for(f"driver:{socket.gethostname()}:2:nonce")
    assert dead["driverLock"] == f"driver:{socket.gethostname()}:2:nonce"
    assert dead["driving"] is False, "a local lease naming a process that no longer exists is not driving"

    # Same host, a live pid (this test's): held.
    alive = row_for(f"driver:{socket.gethostname()}:{os.getpid()}:nonce")
    assert alive["driving"] is True

    # Another machine's live-looking pid is not judged from here; its TTL holds the run.
    foreign = row_for("driver:not-this-host:2:nonce")
    assert foreign["driving"] is True, "a foreign lease is left to its TTL, never judged by pid"
