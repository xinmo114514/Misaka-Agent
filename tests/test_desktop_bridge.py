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

    def setRebindSession(self, fn: Any) -> None:
        self.rebind_handler = fn

    async def switchSession(self, path: str) -> None:
        pass

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
