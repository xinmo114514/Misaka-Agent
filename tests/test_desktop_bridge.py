"""Tests for the Misaka desktop bridge (JSONL stdio protocol)."""

from __future__ import annotations

import asyncio
import io
import json
import os
import subprocess
import sys
from pathlib import Path
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
@pytest.mark.parametrize('mode', ['steer', 'followUp'])
@pytest.mark.parametrize('running', [False, True])
async def test_intervention_prompt_preserves_mode_and_acknowledges_acceptance(monkeypatch, mode, running):
    import misaka.cli.desktop_bridge as bridge_mod
    session = MockSession()
    session.isStreaming = running
    calls = []
    output = io.StringIO()

    async def prompt(text, options=None):
        # The engine may start a background turn after the UI saw an idle session.
        session.isStreaming = True
        assert '"requestId":"intervention"' not in output.getvalue()
        calls.append((text, options['streamingBehavior']))
        options['preflightResult'](True)

    session.prompt = prompt
    monkeypatch.setattr(bridge_mod, 'writeRawStdout', output.write)
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({
        'type': 'prompt', 'requestId': 'intervention', 'text': '调整', 'streamingBehavior': mode,
    }) + '\n' + json.dumps({'type': 'shutdown'}) + '\n'))
    assert await run_desktop_bridge(MockRuntimeHost(session)) == 0
    acks = [json.loads(line) for line in output.getvalue().splitlines() if json.loads(line).get('requestId') == 'intervention']
    assert calls == [('调整', mode)]
    assert len(acks) == 1 and acks[0]['ok'] is True


@pytest.mark.asyncio
async def test_prompt_preflight_failure_returns_correlated_failed_ack(monkeypatch):
    import misaka.cli.desktop_bridge as bridge_mod
    session = MockSession()
    output = io.StringIO()

    async def prompt(text, options=None):
        if options and options.get('preflightResult'):
            options['preflightResult'](False)
        raise RuntimeError('input hook failed')

    session.prompt = prompt
    monkeypatch.setattr(bridge_mod, 'writeRawStdout', output.write)
    monkeypatch.setattr(sys, 'stdin', io.StringIO(
        json.dumps({'type': 'prompt', 'requestId': 'failed-prompt', 'text': 'test', 'streamingBehavior': 'steer'}) + '\n'
        + json.dumps({'type': 'shutdown'}) + '\n'))
    assert await run_desktop_bridge(MockRuntimeHost(session)) == 0
    acks = [json.loads(line) for line in output.getvalue().splitlines() if json.loads(line).get('requestId') == 'failed-prompt']
    assert len(acks) == 1
    assert acks[0]['ok'] is False
    assert acks[0]['error'] == 'input hook failed'


@pytest.mark.asyncio
async def test_error_after_acceptance_does_not_send_failed_ack(monkeypatch):
    import misaka.cli.desktop_bridge as bridge_mod
    session = MockSession()
    output = io.StringIO()

    async def prompt(text, options=None):
        options['preflightResult'](True)
        raise RuntimeError('provider failed after accepting the user message')

    session.prompt = prompt
    monkeypatch.setattr(bridge_mod, 'writeRawStdout', output.write)
    monkeypatch.setattr(sys, 'stdin', io.StringIO(
        json.dumps({'type': 'prompt', 'requestId': 'accepted', 'text': 'test', 'streamingBehavior': 'steer'}) + '\n'
        + json.dumps({'type': 'shutdown'}) + '\n'))
    assert await run_desktop_bridge(MockRuntimeHost(session)) == 0
    acks = [json.loads(line) for line in output.getvalue().splitlines() if json.loads(line).get('requestId') == 'accepted']
    assert len(acks) == 1 and acks[0]['ok'] is True


@pytest.mark.asyncio
async def test_eof_waits_for_original_run_after_follow_up_submission(monkeypatch):
    import misaka.cli.desktop_bridge as bridge_mod
    session = MockSession()
    output = io.StringIO()
    release = asyncio.Event()
    queued = asyncio.Event()

    async def prompt(text, options=None):
        options['preflightResult'](True)
        if text == 'first':
            session.isStreaming = True
            await release.wait()
        else:
            queued.set()

    session.prompt = prompt
    monkeypatch.setattr(bridge_mod, 'writeRawStdout', output.write)
    monkeypatch.setattr(sys, 'stdin', io.StringIO(''.join(json.dumps(command) + '\n' for command in [
        {'type': 'prompt', 'requestId': 'first', 'text': 'first', 'streamingBehavior': 'steer'},
        {'type': 'prompt', 'requestId': 'next', 'text': 'next', 'streamingBehavior': 'followUp'},
    ])))
    bridge_task = asyncio.create_task(run_desktop_bridge(MockRuntimeHost(session)))
    try:
        await asyncio.wait_for(queued.wait(), 5)
        await asyncio.sleep(0.05)
        assert not bridge_task.done(), 'EOF must still wait for the original run'
    finally:
        release.set()
        assert await asyncio.wait_for(bridge_task, 5) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize('mode', ['steer', 'followUp'])
async def test_intervention_waits_for_initial_prompt_preflight(monkeypatch, mode):
    import misaka.cli.desktop_bridge as bridge_mod
    session = MockSession()
    started = asyncio.Event()
    release_preflight = asyncio.Event()
    release_run = asyncio.Event()
    second_called = asyncio.Event()
    output = io.StringIO()
    calls = []

    async def prompt(text, options=None):
        if text == 'initial':
            started.set()
            await release_preflight.wait()
            options['preflightResult'](True)
            session.isStreaming = True
            await release_run.wait()
        else:
            calls.append((session.isStreaming, options['streamingBehavior']))
            second_called.set()
            options['preflightResult'](True)

    session.prompt = prompt
    monkeypatch.setattr(bridge_mod, 'writeRawStdout', output.write)
    monkeypatch.setattr(sys, 'stdin', io.StringIO(''.join(json.dumps(command) + '\n' for command in [
        {'type': 'prompt', 'requestId': 'first', 'text': 'initial', 'streamingBehavior': 'steer'},
        {'type': 'prompt', 'requestId': 'second', 'text': 'intervention', 'streamingBehavior': mode},
    ])))
    task = asyncio.create_task(run_desktop_bridge(MockRuntimeHost(session)))
    try:
        await asyncio.wait_for(started.wait(), 5)
        await asyncio.sleep(0.05)
        assert not second_called.is_set(), 'Submission must not race the first prompt preparation'
        release_preflight.set()
        await asyncio.wait_for(second_called.wait(), 5)
        assert calls == [(True, mode)]
    finally:
        release_preflight.set()
        release_run.set()
        assert await asyncio.wait_for(task, 5) == 0


@pytest.mark.asyncio
async def test_abort_cancels_preparing_and_waiting_submissions(monkeypatch):
    import misaka.cli.desktop_bridge as bridge_mod
    session = MockSession()
    release = asyncio.Event()
    cancelled = []
    calls = []
    output = io.StringIO()

    async def prompt(text, options=None):
        calls.append(text)
        try:
            await release.wait()
            options['preflightResult'](True)
        except asyncio.CancelledError:
            cancelled.append(text)
            raise

    session.prompt = prompt
    monkeypatch.setattr(bridge_mod, 'writeRawStdout', output.write)
    monkeypatch.setattr(sys, 'stdin', io.StringIO(''.join(json.dumps(command) + '\n' for command in [
        {'type': 'prompt', 'requestId': 'first', 'text': 'first', 'streamingBehavior': 'steer'},
        {'type': 'prompt', 'requestId': 'second', 'text': 'second', 'streamingBehavior': 'followUp'},
        {'type': 'abort', 'requestId': 'stop'},
    ])))
    task = asyncio.create_task(run_desktop_bridge(MockRuntimeHost(session)))
    try:
        for _ in range(100):
            if '"requestId":"stop"' in output.getvalue():
                break
            await asyncio.sleep(0.01)
        assert cancelled == ['first']
        assert calls == ['first']
        items = [json.loads(line) for line in output.getvalue().splitlines()]
        acks = {item.get('requestId'): item for item in items if item.get('type') == 'ack'}
        assert acks['first']['ok'] is False and acks['second']['ok'] is False
        assert acks['stop']['ok'] is True
        assert any(item.get('event', {}).get('type') == 'agent_settled' for item in items)
    finally:
        release.set()
        assert await asyncio.wait_for(task, 5) == 0


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
async def test_new_workspace_preview_ack_carries_history_version_without_preview_event(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import misaka.cli.desktop_bridge as bridge_mod
    workspace = tmp_path / "new-workspace"
    workspace.mkdir()
    runtime = MockRuntimeHost()
    output = io.StringIO()
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({
        "type": "switch_workspace", "requestId": "new", "path": str(workspace), "preview": True,
    }) + "\n" + json.dumps({"type": "shutdown"}) + "\n"))
    assert await run_desktop_bridge(runtime) == 0
    lines = [json.loads(line) for line in output.getvalue().splitlines()]
    assert not any(item.get("event", {}).get("type") == "session_preview" for item in lines)
    ack = next(item for item in lines if item.get("requestId") == "new" and item.get("type") == "ack")
    assert isinstance(ack["historyVersion"], str) and ack["historyVersion"]
    assert ack["messages"] == []


@pytest.mark.asyncio
async def test_workspace_lookup_does_not_create_bucket_when_new_session_is_cancelled(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import misaka.cli.desktop_bridge as bridge_mod
    from misaka.core.session_manager import encode_cwd
    workspace = tmp_path / "new-workspace"
    workspace.mkdir()
    root = tmp_path / "sessions"
    root.mkdir()
    runtime = MockRuntimeHost()
    runtime.session.sessionManager.getSessionDir = lambda: str(root)

    async def cancelled_new_session(options: Any) -> dict[str, bool]:
        return {"cancelled": True}

    runtime.newSession = cancelled_new_session
    output = io.StringIO()
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({
        "type": "switch_workspace", "requestId": "cancel", "path": str(workspace), "preview": True,
    }) + "\n" + json.dumps({"type": "shutdown"}) + "\n"))
    assert await run_desktop_bridge(runtime) == 0
    assert not (root / encode_cwd(str(workspace))).exists()


@pytest.mark.asyncio
async def test_workspace_lookup_uses_cwd_bucket_without_listing_every_history(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import misaka.cli.desktop_bridge as bridge_mod
    from misaka.core.session_manager import (
        CURRENT_SESSION_VERSION,
        SessionManager,
        encode_cwd,
    )
    workspace = tmp_path / "target"
    workspace.mkdir()
    root = tmp_path / "sessions"
    target_bucket = root / encode_cwd(str(workspace))
    target_bucket.mkdir(parents=True)
    path = target_bucket / "target.jsonl"
    path.write_text(json.dumps({"type": "session", "version": CURRENT_SESSION_VERSION,
                                "id": "target", "cwd": str(workspace), "timestamp": "2026-10-05T00:00:00Z"}) + "\n", encoding="utf-8")
    runtime = MockRuntimeHost()
    runtime.session.sessionManager.getSessionDir = lambda: str(root / encode_cwd(str(tmp_path)))

    async def no_scan(*args, **kwargs):
        raise AssertionError("full session summary enumeration is not needed for a cwd switch")

    monkeypatch.setattr(SessionManager, "listAll", no_scan)
    output = io.StringIO()
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({
        "type": "switch_workspace", "requestId": "target", "path": str(workspace),
    }) + "\n" + json.dumps({"type": "shutdown"}) + "\n"))
    assert await run_desktop_bridge(runtime) == 0
    assert runtime.switch_session_calls == [str(path)]


@pytest.mark.asyncio
async def test_workspace_existing_history_previews_before_activation(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import misaka.cli.desktop_bridge as bridge_mod
    from misaka.core.session_manager import (
        CURRENT_SESSION_VERSION,
        SessionManager,
        encode_cwd,
    )
    workspace = tmp_path / "target"
    workspace.mkdir()
    root = tmp_path / "sessions"
    bucket = root / encode_cwd(str(workspace))
    bucket.mkdir(parents=True)
    path = bucket / "target.jsonl"
    path.write_text(json.dumps({"type": "session", "version": CURRENT_SESSION_VERSION,
                                "id": "target", "cwd": str(workspace), "timestamp": "2026-10-05T00:00:00Z"}) + "\n", encoding="utf-8")
    runtime = MockRuntimeHost()
    runtime.session.sessionManager.getSessionDir = lambda: str(root / encode_cwd(str(tmp_path)))
    output = io.StringIO()

    async def switch(target: str) -> dict[str, bool]:
        assert any(json.loads(line).get("event", {}).get("type") == "session_preview" for line in output.getvalue().splitlines())
        runtime.session.sessionManager = SessionManager.open(target)
        runtime.session.sessionId = "target"
        runtime.session.sessionFile = target
        await runtime.rebind_handler()
        return {"cancelled": False}

    runtime.switchSession = switch
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({
        "type": "switch_workspace", "requestId": "sw", "path": str(workspace), "preview": True,
    }) + "\n" + json.dumps({"type": "shutdown"}) + "\n"))
    assert await run_desktop_bridge(runtime) == 0
    lines = [json.loads(line) for line in output.getvalue().splitlines()]
    preview = next(item["event"] for item in lines if item.get("event", {}).get("type") == "session_preview")
    assert preview["requestId"] == "sw" and preview["session"]["sessionId"] == "target"
    ack = next(item for item in lines if item.get("type") == "ack" and item.get("requestId") == "sw")
    assert ack["historyUnchanged"] is True and ack["historyVersion"] == preview["historyVersion"]


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
async def test_opt_in_load_previews_read_only_before_switch_and_acknowledges_unchanged(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import misaka.cli.desktop_bridge as bridge_mod
    from misaka.core.session_manager import CURRENT_SESSION_VERSION, SessionManager

    path = tmp_path / "history.jsonl"
    path.write_text("\n".join(json.dumps(entry) for entry in [
        {"type": "session", "version": CURRENT_SESSION_VERSION, "id": "target", "cwd": str(tmp_path), "timestamp": "2026-10-05T00:00:00Z"},
        {"type": "message", "id": "first", "parentId": None, "timestamp": "2026-10-05T00:00:01Z", "message": {"role": "user", "content": [{"type": "text", "text": "visible"}], "timestamp": 1000}},
    ]) + "\n", encoding="utf-8")
    output = io.StringIO()
    runtime = MockRuntimeHost()
    runtime.lastSwitchTimings = {"abortMs": 1.5, "shutdownMs": 2.0, "disposeMs": 0.1, "prepareMs": 10.0, "bindMs": 3.0}

    async def switch(target: str) -> dict[str, bool]:
        envelopes = [json.loads(line) for line in output.getvalue().splitlines()]
        assert any(item.get("event", {}).get("type") == "session_preview" for item in envelopes)
        runtime.session.sessionManager = SessionManager.open(target)
        runtime.session.sessionId = "target"
        runtime.session.sessionFile = target
        await runtime.rebind_handler()
        return {"cancelled": False}

    runtime.switchSession = switch
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"type": "load_session", "requestId": "load-1", "path": str(path), "preview": True}) + "\n" + json.dumps({"type": "shutdown", "requestId": "bye"}) + "\n"))
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)
    assert await run_desktop_bridge(runtime) == 0
    lines = [json.loads(line) for line in output.getvalue().splitlines()]
    preview = next(item["event"] for item in lines if item.get("event", {}).get("type") == "session_preview")
    assert preview["requestId"] == "load-1"
    assert preview["session"]["sessionId"] == "target"
    assert preview["messages"][0]["content"] == "visible"
    assert isinstance(preview["historyVersion"], str)
    start = next(item["event"] for item in lines if item.get("event", {}).get("type") == "session_started")
    assert start["requestId"] == "load-1"
    ack = next(item for item in lines if item.get("requestId") == "load-1" and item.get("type") == "ack")
    assert ack["historyUnchanged"] is True
    assert ack["historyVersion"] == preview["historyVersion"]
    assert "messages" not in ack and "messages" not in ack["data"]
    assert all(isinstance(value, (int, float)) for value in ack["timings"].values())
    assert {"queueMs", "fileMs", "historyMs", "runtimeMs"} <= ack["timings"].keys()
    assert ack["timings"]["prepareMs"] == 10.0


@pytest.mark.asyncio
async def test_opt_in_load_sends_changed_history_after_runtime_startup(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import misaka.cli.desktop_bridge as bridge_mod
    from misaka.core.session_manager import CURRENT_SESSION_VERSION, SessionManager
    path = tmp_path / "history.jsonl"
    path.write_text(json.dumps({"type": "session", "version": CURRENT_SESSION_VERSION,
                                "id": "target", "cwd": str(tmp_path), "timestamp": "2026-10-05T00:00:00Z"}) + "\n", encoding="utf-8")
    runtime = MockRuntimeHost()
    output = io.StringIO()

    async def switch(target: str) -> dict[str, bool]:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"type": "message", "id": "new", "parentId": None,
                                     "message": {"role": "user", "content": "new from startup", "timestamp": 10}}) + "\n")
        runtime.session.sessionManager = SessionManager.open(target)
        runtime.session.sessionId = "target"
        runtime.session.sessionFile = target
        await runtime.rebind_handler()
        return {"cancelled": False}

    runtime.switchSession = switch
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"type": "load_session", "requestId": "changed", "path": str(path), "preview": True}) + "\n" + json.dumps({"type": "shutdown"}) + "\n"))
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)
    assert await run_desktop_bridge(runtime) == 0
    lines = [json.loads(line) for line in output.getvalue().splitlines()]
    preview = next(item["event"] for item in lines if item.get("event", {}).get("type") == "session_preview")
    ack = next(item for item in lines if item.get("type") == "ack" and item.get("requestId") == "changed")
    assert preview["messages"] == []
    assert ack["messages"][0]["content"] == "new from startup"
    assert ack["historyVersion"] != preview["historyVersion"]
    assert "historyUnchanged" not in ack


@pytest.mark.asyncio
@pytest.mark.parametrize("command_type", ["load_session", "switch_workspace"])
async def test_append_during_preview_never_marks_stale_snapshot_unchanged(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, command_type: str,
) -> None:
    import misaka.cli.desktop_bridge as bridge_mod
    from misaka.core.session_manager import CURRENT_SESSION_VERSION, SessionManager

    path = tmp_path / "history.jsonl"
    path.write_text(json.dumps({"type": "session", "version": CURRENT_SESSION_VERSION,
                                "id": "target", "cwd": str(tmp_path), "timestamp": "2026-10-05T00:00:00Z"}) + "\n", encoding="utf-8")
    runtime = MockRuntimeHost()
    output = io.StringIO()
    real_serialize = bridge_mod._serialize_session_entries
    calls = 0

    def append_while_serializing(entries: list[Any]) -> list[dict[str, Any]]:
        nonlocal calls
        calls += 1
        projected = real_serialize(entries)
        if calls == 1:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"type": "message", "id": "late", "parentId": None,
                                         "message": {"role": "user", "content": "appended during preview", "timestamp": 20}}) + "\n")
        return projected

    async def switch(target: str) -> dict[str, bool]:
        runtime.session.sessionManager = SessionManager.open(target)
        runtime.session.sessionId = "target"
        runtime.session.sessionFile = target
        await runtime.rebind_handler()
        return {"cancelled": False}

    runtime.switchSession = switch
    monkeypatch.setattr(bridge_mod, "_serialize_session_entries", append_while_serializing)
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)
    command = {"type": command_type, "requestId": "race", "path": str(path) if command_type == "load_session" else str(tmp_path), "preview": True}
    if command_type == "switch_workspace":
        command["sessionPath"] = str(path)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(command) + "\n" + json.dumps({"type": "shutdown"}) + "\n"))
    assert await run_desktop_bridge(runtime) == 0
    lines = [json.loads(line) for line in output.getvalue().splitlines()]
    preview = next(item["event"] for item in lines if item.get("event", {}).get("type") == "session_preview")
    ack = next(item for item in lines if item.get("type") == "ack" and item.get("requestId") == "race")
    assert preview["messages"] == []
    assert ack["messages"][0]["content"] == "appended during preview"
    assert "historyUnchanged" not in ack


@pytest.mark.asyncio
async def test_queued_switches_coalesce_only_adjacent_pending_requests(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import misaka.cli.desktop_bridge as bridge_mod
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    output = io.StringIO()
    runtime = MockRuntimeHost()
    started = asyncio.Event()
    release = asyncio.Event()
    calls: list[str] = []

    async def new_session(options: Any) -> dict[str, bool]:
        calls.append(options["cwd"])
        if len(calls) == 1:
            started.set()
            await release.wait()
        return {"cancelled": False}

    runtime.newSession = new_session
    commands = [
        {"type": "switch_workspace", "requestId": "first", "path": str(workspace)},
        {"type": "switch_workspace", "requestId": "old", "path": str(workspace)},
        {"type": "switch_workspace", "requestId": "latest", "path": str(workspace)},
        {"type": "shutdown", "requestId": "bye"},
    ]
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(item) + "\n" for item in commands)))
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)
    task = asyncio.create_task(run_desktop_bridge(runtime))
    await asyncio.wait_for(started.wait(), timeout=5)
    for _ in range(100):
        if '"requestId":"old"' in output.getvalue():
            break
        await asyncio.sleep(0.01)
    release.set()
    assert await asyncio.wait_for(task, timeout=5) == 0
    lines = [json.loads(line) for line in output.getvalue().splitlines()]
    old = next(item for item in lines if item.get("type") == "ack" and item.get("requestId") == "old")
    assert old["ok"] is False and old["cancelled"] is True
    assert len(calls) == 2
    assert [item["requestId"] for item in lines if item.get("type") == "ack" and item.get("requestId") in {"first", "latest"}] == ["first", "latest"]


@pytest.mark.asyncio
async def test_queued_prompt_starts_on_old_session_before_switch(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import misaka.cli.desktop_bridge as bridge_mod
    from misaka.core.session_manager import CURRENT_SESSION_VERSION
    path = tmp_path / "target.jsonl"
    path.write_text(json.dumps({"type": "session", "version": CURRENT_SESSION_VERSION,
                                "id": "target", "cwd": str(tmp_path), "timestamp": "2026-10-05T00:00:00Z"}) + "\n", encoding="utf-8")
    runtime = MockRuntimeHost()
    old_session = runtime.session
    calls: list[str] = []

    async def old_prompt(text: str, options: Any = None) -> None:
        calls.append("old prompt")

    old_session.prompt = old_prompt

    async def switch(target: str) -> dict[str, bool]:
        calls.append("switch")
        runtime.session = MockSession("target")
        runtime.session.prompt = lambda *args, **kwargs: calls.append("new prompt")
        await runtime.rebind_handler()
        return {"cancelled": False}

    runtime.switchSession = switch
    output = io.StringIO()
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)

    async def immediate_read(fn, *args, **kwargs):
        return fn(*args, **kwargs)

    monkeypatch.setattr(bridge_mod.asyncio, "to_thread", immediate_read)
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(item) + "\n" for item in [
        {"type": "prompt", "requestId": "p", "text": "belongs to old"},
        {"type": "load_session", "requestId": "load", "path": str(path)},
        {"type": "shutdown"},
    ])))
    assert await run_desktop_bridge(runtime) == 0
    assert calls[:2] == ["old prompt", "switch"]


@pytest.mark.asyncio
async def test_two_queued_prompts_reject_second_before_streaming_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    import misaka.cli.desktop_bridge as bridge_mod
    runtime = MockRuntimeHost()
    started = asyncio.Event()
    release = asyncio.Event()
    calls: list[str] = []

    async def prompt(text: str, options: Any = None) -> None:
        calls.append(text)
        started.set()
        await release.wait()

    runtime.session.prompt = prompt
    output = io.StringIO()
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)

    async def immediate_read(fn, *args, **kwargs):
        return fn(*args, **kwargs)

    monkeypatch.setattr(bridge_mod.asyncio, "to_thread", immediate_read)
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(item) + "\n" for item in [
        {"type": "prompt", "requestId": "first", "text": "first"},
        {"type": "prompt", "requestId": "second", "text": "second"},
        {"type": "shutdown", "requestId": "bye"},
    ])))
    task = asyncio.create_task(run_desktop_bridge(runtime))
    await asyncio.wait_for(started.wait(), timeout=5)
    for _ in range(100):
        if '"requestId":"second"' in output.getvalue():
            break
        await asyncio.sleep(0.01)
    release.set()
    assert await asyncio.wait_for(task, timeout=5) == 0
    acks = {item.get("requestId"): item for item in map(json.loads, output.getvalue().splitlines()) if item.get("type") == "ack"}
    assert acks["first"]["ok"] is True
    assert acks["second"]["ok"] is False
    assert calls == ["first"]


@pytest.mark.asyncio
async def test_prepare_attachments_command_returns_prepared_file_results(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    file_path = tmp_path / "fixture.md"
    file_path.write_text("fixture text", encoding="utf-8")
    runtime = MockRuntimeHost()
    output = io.StringIO()
    command = {"type": "prepare_attachments", "requestId": "prepare", "paths": [str(file_path)]}
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(command) + "\n" + json.dumps({"type": "shutdown"}) + "\n"))
    import misaka.cli.desktop_bridge as bridge_mod
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)

    assert await run_desktop_bridge(runtime) == 0
    ack = next(item for item in map(json.loads, output.getvalue().splitlines()) if item.get("requestId") == "prepare")
    assert ack["ok"] is True
    assert ack["data"]["attachments"][0]["text"].endswith("fixture text\n</file>\n")


@pytest.mark.asyncio
async def test_explicit_missing_workspace_session_does_not_create_new_session(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import misaka.cli.desktop_bridge as bridge_mod
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runtime = MockRuntimeHost()
    output = io.StringIO()
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({
        "type": "switch_workspace", "requestId": "missing", "path": str(workspace),
        "sessionPath": str(tmp_path / "not-there.jsonl"), "preview": True,
    }) + "\n" + json.dumps({"type": "shutdown"}) + "\n"))
    assert await run_desktop_bridge(runtime) == 0
    ack = next(item for item in map(json.loads, output.getvalue().splitlines()) if item.get("requestId") == "missing")
    assert ack["ok"] is False
    assert runtime.new_session_calls == [] and runtime.switch_session_calls == []


@pytest.mark.asyncio
async def test_explicit_missing_load_session_fails_before_runtime_switch(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import misaka.cli.desktop_bridge as bridge_mod
    runtime = MockRuntimeHost()
    output = io.StringIO()
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({
        "type": "load_session", "requestId": "missing", "path": str(tmp_path / "no.jsonl"),
    }) + "\n" + json.dumps({"type": "shutdown"}) + "\n"))
    assert await run_desktop_bridge(runtime) == 0
    ack = next(item for item in map(json.loads, output.getvalue().splitlines()) if item.get("requestId") == "missing")
    assert ack["ok"] is False and runtime.switch_session_calls == []


@pytest.mark.asyncio
async def test_explicit_workspace_session_rejects_another_cwd(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import misaka.cli.desktop_bridge as bridge_mod
    from misaka.core.session_manager import CURRENT_SESSION_VERSION
    workspace = tmp_path / "workspace"
    other = tmp_path / "other"
    workspace.mkdir()
    other.mkdir()
    path = tmp_path / "other.jsonl"
    path.write_text(json.dumps({"type": "session", "version": CURRENT_SESSION_VERSION, "id": "other", "cwd": str(other), "timestamp": "2026-10-05T00:00:00Z"}) + "\n", encoding="utf-8")
    runtime = MockRuntimeHost()
    output = io.StringIO()
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({
        "type": "switch_workspace", "requestId": "wrong", "path": str(workspace),
        "sessionPath": str(path), "preview": True,
    }) + "\n" + json.dumps({"type": "shutdown"}) + "\n"))
    assert await run_desktop_bridge(runtime) == 0
    ack = next(item for item in map(json.loads, output.getvalue().splitlines()) if item.get("requestId") == "wrong")
    assert ack["ok"] is False
    assert runtime.switch_session_calls == []


@pytest.mark.asyncio
async def test_pending_switch_does_not_coalesce_across_settings_command(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import misaka.cli.desktop_bridge as bridge_mod
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runtime = MockRuntimeHost()
    started, release = asyncio.Event(), asyncio.Event()
    calls: list[str] = []

    async def new_session(options: Any) -> dict[str, bool]:
        calls.append(options["cwd"])
        if len(calls) == 1:
            started.set()
            await release.wait()
        return {"cancelled": False}

    runtime.newSession = new_session
    output = io.StringIO()
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)
    commands = [
        {"type": "switch_workspace", "requestId": "first", "path": str(workspace)},
        {"type": "switch_workspace", "requestId": "second", "path": str(workspace)},
        {"type": "get_stats", "requestId": "settings"},
        {"type": "switch_workspace", "requestId": "third", "path": str(workspace)},
        {"type": "shutdown", "requestId": "bye"},
    ]
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(item) + "\n" for item in commands)))
    task = asyncio.create_task(run_desktop_bridge(runtime))
    await asyncio.wait_for(started.wait(), timeout=5)
    await asyncio.sleep(0.05)
    release.set()
    assert await asyncio.wait_for(task, timeout=5) == 0
    lines = [json.loads(line) for line in output.getvalue().splitlines()]
    assert len(calls) == 3
    assert [item["requestId"] for item in lines if item.get("type") == "ack" and item.get("requestId") in {"first", "second", "settings", "third"}] == ["first", "second", "settings", "third"]


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


def test_serialize_session_entries_preserves_ordered_assistant_blocks_and_metadata() -> None:
    """Reopening must not group reasoning, prose and tools into a different visual order.

    This catches replacing the ordered projection with the old three independent accumulators,
    and catches assigning block indices after filtering instead of using persisted content indices.
    """
    from misaka.cli.desktop_bridge import _serialize_session_entries

    result_content = [
        {"type": "text", "text": "contents"},
        {"type": "image", "data": "raw-image-data", "mimeType": "image/png"},
    ]
    entries = [{
        "type": "message",
        "id": "answer",
        "timestamp": "2026-10-05T00:00:03+00:00",
        "message": {
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "inspect first"},
                {"type": "text", "text": "Before. "},
                {"type": "toolCall", "id": "call-read", "name": "read", "arguments": {"path": "a.md"}},
                {"type": "text", "text": "After."},
            ],
            "usage": {"input": 11, "output": 7, "totalTokens": 18},
            "stopReason": "toolUse",
            "errorMessage": "provider note",
            "timestamp": 1234,
        },
    }, {
        "type": "message",
        "id": "result",
        "message": {
            "role": "toolResult",
            "toolCallId": "call-read",
            "toolName": "read",
            "content": result_content,
            "details": {"bytes": 8},
            "isError": False,
            "timestamp": 1235,
        },
    }]

    out = _serialize_session_entries(entries)
    assert len(out) == 1
    message = out[0]
    assert message["id"] == "msg-answer-0"
    assert message["entryId"] == "answer"
    assert message["timestamp"] == 1234
    assert message["stopReason"] == "toolUse"
    assert message["errorMessage"] == "provider note"
    assert message["tokens"] == {"input": 11, "output": 7, "total": 18}
    assert [block["type"] for block in message["blocks"]] == ["thinking", "text", "toolCall", "text"]
    assert [block["id"] for block in message["blocks"]] == [
        "msg-answer-0:block:0",
        "msg-answer-0:block:1",
        "msg-answer-0:block:2",
        "msg-answer-0:block:3",
    ]
    assert [block["contentIndex"] for block in message["blocks"]] == [0, 1, 2, 3]
    assert message["blocks"][0] == {
        "type": "thinking", "id": "msg-answer-0:block:0", "contentIndex": 0,
        "thinking": "inspect first", "isStreaming": False,
    }
    assert message["blocks"][1] == {
        "type": "text", "id": "msg-answer-0:block:1", "contentIndex": 1,
        "text": "Before. ", "isStreaming": False,
    }
    assert message["content"] == "Before. After."
    assert message["thinking"] == "inspect first"

    tool_block = message["blocks"][2]
    tool_call = tool_block["toolCall"]
    assert tool_block["id"] == "msg-answer-0:block:2"
    assert tool_call == {
        "id": "call-read",
        "name": "read",
        "arguments": {"path": "a.md"},
        "status": "success",
        "result": result_content,
        "details": {"bytes": 8},
    }
    assert message["toolCalls"][0] is tool_call, "legacy and ordered projections share one canonical tool object"


def test_serialize_session_entries_associates_results_and_never_invents_success() -> None:
    """Each persisted result updates only its call; incomplete and aborted calls stay honest."""
    from misaka.cli.desktop_bridge import _serialize_session_entries

    entries = [
        {"type": "message", "id": "a1", "message": {
            "role": "assistant", "timestamp": 10, "stopReason": "toolUse", "content": [
                {"type": "toolCall", "id": "ok", "name": "first", "arguments": {"n": 1}},
                {"type": "toolCall", "id": "waiting", "name": "second", "arguments": {"n": 2}},
            ],
        }},
        {"type": "message", "id": "r1", "message": {
            "role": "toolResult", "toolCallId": "ok", "toolName": "first",
            "content": [{"type": "text", "text": "done"}], "details": {"attempt": 1},
            "isError": False, "timestamp": 11,
        }},
        {"type": "message", "id": "a2", "message": {
            "role": "assistant", "timestamp": 12, "stopReason": "toolUse", "content": [
                {"type": "text", "text": "next"},
                {"type": "toolCall", "id": "bad", "name": "third", "arguments": {}},
            ],
        }},
        {"type": "message", "id": "r2", "message": {
            "role": "toolResult", "toolCallId": "bad", "toolName": "third",
            "content": [{"type": "text", "text": "stderr"}], "details": {"exitCode": 2},
            "error": "command failed", "isError": True, "timestamp": 13,
        }},
        {"type": "message", "id": "a3", "message": {
            "role": "assistant", "timestamp": 14, "stopReason": "aborted", "errorMessage": "Stopped",
            "content": [{"type": "toolCall", "id": "stopped", "name": "fourth", "arguments": {}}],
        }},
    ]

    out = _serialize_session_entries(entries)
    calls = {
        call["id"]: call
        for message in out
        for call in message.get("toolCalls", [])
    }
    assert calls["ok"] == {
        "id": "ok", "name": "first", "arguments": {"n": 1}, "status": "success",
        "result": [{"type": "text", "text": "done"}], "details": {"attempt": 1},
    }
    assert calls["bad"] == {
        "id": "bad", "name": "third", "arguments": {}, "status": "error",
        "result": [{"type": "text", "text": "stderr"}], "details": {"exitCode": 2},
        "error": "command failed",
    }
    assert calls["waiting"]["status"] == "cancelled"
    assert calls["stopped"]["status"] == "cancelled"
    assert "result" not in calls["waiting"] and "result" not in calls["stopped"]

    incomplete = _serialize_session_entries(entries[:1])
    assert [call["status"] for call in incomplete[0]["toolCalls"]] == ["pending", "pending"]
    assert all("result" not in call for call in incomplete[0]["toolCalls"])

    reopened = _serialize_session_entries(entries)
    assert reopened == out, "the same persisted transcript must reopen with identical content and states"

def test_serialize_session_entries_provider_error_cancels_unfinished_calls() -> None:
    """A durable provider error closes its unfinished tools just like the live reducer."""
    from misaka.cli.desktop_bridge import _serialize_session_entries

    entries = [{
        "type": "message",
        "id": "provider-error",
        "timestamp": "2026-10-05T00:00:09+00:00",
        "message": {
            "role": "assistant",
            "timestamp": 2009,
            "content": [
                {"type": "thinking", "thinking": "Trying the request."},
                {"type": "text", "text": "Starting lookup."},
                {"type": "toolCall", "id": "failed-before-result", "name": "lookup", "arguments": {"q": "x"}},
            ],
            "stopReason": "error",
            "errorMessage": "Provider connection closed",
        },
    }]

    out = _serialize_session_entries(entries)
    assert len(out) == 1
    message = out[0]
    assert [block["type"] for block in message["blocks"]] == ["thinking", "text", "toolCall"]
    assert message["thinking"] == "Trying the request."
    assert message["content"] == "Starting lookup."
    assert message["stopReason"] == "error"
    assert message["errorMessage"] == "Provider connection closed"
    assert message["toolCalls"][0]["status"] == "cancelled"
    assert "result" not in message["toolCalls"][0]
    assert message["blocks"][2]["toolCall"] is message["toolCalls"][0]

def test_persisted_fixture_reopens_with_the_same_completed_turn_as_live_events() -> None:
    """The approved shared turn has one canonical content sequence live and after reopen."""
    from misaka.cli.desktop_bridge import _serialize_session_entries

    fixture = json.loads(
        (Path(__file__).parent / "fixtures" / "desktop_conversation.json").read_text(encoding="utf-8")
    )
    reopened = _serialize_session_entries(fixture["entries"])
    assistants = [message for message in reopened if message["role"] == "assistant"]
    live_assistants = [
        envelope["event"]["message"]
        for envelope in fixture["events"]
        if envelope["event"].get("type") == "message_end"
        and envelope["event"].get("message", {}).get("role") == "assistant"
    ]

    expected_text = [
        "先读取文件。读取请求已发出。",
        "读取完成，继续检索。",
        "总结：\n\n| 文件 | 状态 |\n| --- | --- |\n| fixture.md | 已读取 |",
    ]
    assert [message["content"] for message in assistants] == expected_text
    assert [
        "".join(block.get("text", "") for block in message["content"] if block.get("type") == "text")
        for message in live_assistants
    ] == expected_text
    assert [[block["type"] for block in message["blocks"]] for message in assistants] == [
        ["thinking", "text", "toolCall", "text"],
        ["text", "toolCall"],
        ["text"],
    ]
    assert [[block["type"] for block in message["content"]] for message in live_assistants] == [
        ["thinking", "text", "toolCall", "text"],
        ["text", "toolCall"],
        ["text"],
    ]
    assert assistants[0]["toolCalls"][0] == {
        "id": "call-a", "name": "read", "arguments": {"path": "fixture.md"},
        "status": "success", "result": [{"type": "text", "text": "文件内容"}],
        "details": {"lines": 2},
    }
    assert assistants[1]["toolCalls"][0] == {
        "id": "call-b", "name": "grep", "arguments": {"query": "fixture"},
        "status": "error", "result": [{"type": "text", "text": "未找到匹配项"}],
        "details": {"matches": 0}, "error": "未找到匹配项",
    }
    assert assistants[2]["tokens"] == {"input": 10, "output": 20, "total": 30}
    assert [message["stopReason"] for message in assistants] == ["toolUse", "toolUse", "stop"]


def test_serialize_session_entries_preserves_images_on_user_messages() -> None:
    from misaka.cli.desktop_bridge import _serialize_session_entries

    image = {"type": "image", "mimeType": "image/png", "data": "cG5n"}
    entries = [{
        "type": "message", "id": "user-image", "timestamp": 1,
        "message": {"role": "user", "timestamp": 1, "content": [
            {"type": "text", "text": "请查看此图片"}, image,
        ]},
    }]
    assert _serialize_session_entries(entries)[0] == {
        "id": "msg-user-image-0", "entryId": "user-image", "role": "user",
        "content": "请查看此图片", "images": [image], "timestamp": 1,
    }

def test_shared_fixture_tool_start_matches_the_real_jsonl_wire_projection() -> None:
    """The live fixture records the bounded wire delta, while reopen uses the full snapshot."""
    from misaka.cli.desktop_bridge import _serialize_event

    fixture = json.loads(
        (Path(__file__).parent / "fixtures" / "desktop_conversation.json").read_text(encoding="utf-8")
    )
    expected = next(
        envelope for envelope in fixture["events"]
        if envelope["event"].get("assistantMessageEvent", {}).get("type") == "toolcall_start"
    )
    first_assistant = fixture["entries"][1]["message"]
    raw_event = {
        "type": "message_update",
        "message": {"role": "assistant", "usage": None},
        "assistantMessageEvent": {
            "type": "toolcall_start",
            "contentIndex": 2,
            "partial": first_assistant,
        },
    }

    actual = json.loads(_serialize_event(expected["seq"], fixture["sessionId"], raw_event))
    assert actual == expected
    assert "partial" not in actual["event"]["assistantMessageEvent"]
    assert actual["event"]["assistantMessageEvent"]["id"] == "call-a"
    assert actual["event"]["assistantMessageEvent"]["toolName"] == "read"


@pytest.mark.asyncio
async def test_delete_active_session_starts_a_new_session_before_removing_its_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import misaka.cli.desktop_bridge as bridge_mod

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    old_file = tmp_path / "active.jsonl"
    old_file.write_text("{}\n", encoding="utf-8")
    runtime = MockRuntimeHost()
    runtime.session.sessionFile = str(old_file)
    runtime.session.sessionManager.getCwd = lambda: str(workspace)
    output = io.StringIO()
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)

    async def replace_session(options: Any = None) -> dict[str, bool]:
        runtime.new_session_calls.append(options)
        fresh = MockSession("fresh-session")
        fresh.sessionFile = str(tmp_path / "fresh.jsonl")
        fresh.sessionManager.getCwd = lambda: str(workspace)
        runtime.session = fresh
        assert runtime.rebind_handler is not None
        await runtime.rebind_handler(fresh)
        return {"cancelled": False}

    runtime.newSession = replace_session
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(item) + "\n" for item in [
        {"type": "delete_session", "requestId": "delete-active", "path": str(old_file)},
        {"type": "shutdown", "requestId": "bye"},
    ])))

    assert await run_desktop_bridge(runtime) == 0

    lines = [json.loads(line) for line in output.getvalue().splitlines()]
    ack = next(item for item in lines if item.get("requestId") == "delete-active")
    started = next(item["event"] for item in lines if item.get("event", {}).get("type") == "session_started")
    assert runtime.new_session_calls == [{"cwd": str(workspace), "carryOverContext": False}]
    assert old_file.exists() is False
    assert ack["ok"] is True and ack["data"]["path"] == str(old_file)
    assert ack["data"]["session"]["file"] == str(tmp_path / "fresh.jsonl")
    assert started["requestId"] == "delete-active" and started["file"] == str(tmp_path / "fresh.jsonl")


@pytest.mark.asyncio
async def test_delete_active_session_refuses_to_replace_a_running_task(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import misaka.cli.desktop_bridge as bridge_mod

    old_file = tmp_path / "active.jsonl"
    old_file.write_text("{}\n", encoding="utf-8")
    runtime = MockRuntimeHost()
    runtime.session.sessionFile = str(old_file)
    runtime.session.isStreaming = True
    output = io.StringIO()
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)
    monkeypatch.setattr(sys, "stdin", io.StringIO(
        json.dumps({"type": "delete_session", "requestId": "busy-delete", "path": str(old_file)}) + "\n"
        + json.dumps({"type": "shutdown"}) + "\n"
    ))

    assert await run_desktop_bridge(runtime) == 0

    ack = next(item for item in map(json.loads, output.getvalue().splitlines()) if item.get("requestId") == "busy-delete")
    assert ack["ok"] is False and "停止" in ack["error"]
    assert old_file.exists() and runtime.new_session_calls == []


@pytest.mark.asyncio
async def test_delete_active_session_retains_file_if_unlink_fails_after_replacement(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import misaka.cli.desktop_bridge as bridge_mod

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    old_file = tmp_path / "active.jsonl"
    old_file.write_text("{}\n", encoding="utf-8")
    runtime = MockRuntimeHost()
    runtime.session.sessionFile = str(old_file)
    runtime.session.sessionManager.getCwd = lambda: str(workspace)
    output = io.StringIO()
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)

    async def replace_session(options: Any = None) -> dict[str, bool]:
        fresh = MockSession("fresh-session")
        fresh.sessionFile = str(tmp_path / "fresh.jsonl")
        fresh.sessionManager.getCwd = lambda: str(workspace)
        runtime.session = fresh
        assert runtime.rebind_handler is not None
        await runtime.rebind_handler(fresh)
        return {"cancelled": False}

    runtime.newSession = replace_session
    original_remove = bridge_mod.os.remove

    def fail_active_unlink(path: str) -> None:
        if os.path.realpath(path) == os.path.realpath(old_file):
            raise PermissionError("file is busy")
        original_remove(path)

    monkeypatch.setattr(bridge_mod.os, "remove", fail_active_unlink)
    monkeypatch.setattr(sys, "stdin", io.StringIO(
        json.dumps({"type": "delete_session", "requestId": "partial-delete", "path": str(old_file)}) + "\n"
        + json.dumps({"type": "shutdown"}) + "\n"
    ))

    assert await run_desktop_bridge(runtime) == 0

    lines = [json.loads(line) for line in output.getvalue().splitlines()]
    ack = next(item for item in lines if item.get("requestId") == "partial-delete")
    started = next(item["event"] for item in lines if item.get("event", {}).get("type") == "session_started")
    assert ack["ok"] is False and "file is busy" in ack["error"]
    assert ack.get("data", {}).get("session", {}).get("file") == str(tmp_path / "fresh.jsonl")
    assert started["file"] == str(tmp_path / "fresh.jsonl") and old_file.exists()


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


@pytest.mark.asyncio
async def test_research_detail_and_global_activity_commands_keep_workspace_scope(monkeypatch, tmp_path):
    from contextlib import closing

    import misaka.cli.desktop_bridge as bridge_module
    from misaka.core.platform import tasks
    from misaka.core.research import runs

    workspace = tmp_path / "project"
    other_workspace = tmp_path / "other"
    workspace.mkdir()
    other_workspace.mkdir()
    board = tmp_path / "board.db"
    with closing(tasks.connect(str(board))) as con:
        runs.init(con)
        run = runs.create(con, workspace=str(workspace), question="Scoped desktop details")
        runs.set_state(con, run["id"], status="waiting_input", phase="waiting_input")
        node = runs.root(con, run["id"])
    monkeypatch.setattr(bridge_module, "_open_research_readonly", lambda: tasks.connect(str(board)))
    output = io.StringIO()
    session = MockSession()
    session.moments = type("Moments", (), {"parts": []})()
    commands = [
        {"type": "get_active_research_runs", "requestId": "active"},
        {"type": "get_research_details", "requestId": "details", "runId": run["id"], "workspace": str(workspace)},
        {"type": "get_research_node", "requestId": "node", "runId": run["id"],
         "nodeId": node["id"], "workspace": str(other_workspace)},
        {"type": "shutdown", "requestId": "bye"},
    ]
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(item) + "\n" for item in commands)))
    monkeypatch.setattr(bridge_module, "writeRawStdout", output.write)

    assert await run_desktop_bridge(MockRuntimeHost(session)) == 0

    acknowledgements = {
        item["requestId"]: item
        for item in map(json.loads, output.getvalue().splitlines())
        if item.get("type") == "ack"
    }
    assert acknowledgements["active"]["data"]["runs"][0]["id"] == run["id"]
    assert acknowledgements["details"]["ok"], acknowledgements["details"]
    detail = acknowledgements["details"]["data"]
    assert detail["run"]["id"] == run["id"]
    assert detail["pending_questions"] == []
    assert acknowledgements["node"]["data"]["detail"] is None


@pytest.mark.asyncio
async def test_normal_conversation_bridge_cannot_start_an_independent_research_run(monkeypatch):
    import misaka.cli.desktop_bridge as bridge_module

    session = MockSession()
    session.moments = type("Moments", (), {"parts": []})()
    output = io.StringIO()
    commands = [
        {"type": "start_research", "requestId": "not-research", "question": "topic", "limits": {}},
        {"type": "shutdown"},
    ]
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(item) + "\n" for item in commands)))
    monkeypatch.setattr(bridge_module, "writeRawStdout", output.write)

    assert await run_desktop_bridge(MockRuntimeHost(session)) == 0
    ack = next(item for item in map(json.loads, output.getvalue().splitlines()) if item.get("requestId") == "not-research")
    assert ack["ok"] is False
    assert "independent research session" in ack["error"]


@pytest.mark.asyncio
async def test_ordinary_session_cannot_compact_a_live_research_root(monkeypatch, tmp_path):
    import sqlite3
    from contextlib import closing

    import misaka.cli.desktop_bridge as bridge_module
    from misaka.core.platform import tasks
    from misaka.core.research import runs

    workspace = tmp_path / "project"
    workspace.mkdir()
    board = tmp_path / "board.db"
    root_session = workspace / "root.jsonl"
    with closing(tasks.connect(str(board))) as con:
        runs.init(con)
        run = runs.create(con, workspace=str(workspace), question="Live project research")
        runs.set_state(con, run["id"], status="active", root_session=str(root_session))
    def open_readonly():
        con = sqlite3.connect(board.as_uri() + "?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA query_only=ON")
        return con

    monkeypatch.setattr(bridge_module, "_open_research_readonly", open_readonly)
    session = MockSession()
    session.sessionManager.sessionFile = str(root_session)
    output = io.StringIO()
    commands = [
        {"type": "compact_session", "requestId": "compact-live-root"},
        {"type": "shutdown"},
    ]
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(item) + "\n" for item in commands)))
    monkeypatch.setattr(bridge_module, "writeRawStdout", output.write)

    assert await run_desktop_bridge(MockRuntimeHost(session)) == 0
    ack = next(item for item in map(json.loads, output.getvalue().splitlines())
               if item.get("requestId") == "compact-live-root")
    assert ack["ok"] is False
    assert "Stop the owning research run" in ack["error"]


def test_session_mutation_guard_detects_active_research_root_and_node_sessions(tmp_path):
    from contextlib import closing

    from misaka.cli.desktop_bridge import session_belongs_to_active_research
    from misaka.core.platform import tasks
    from misaka.core.research import runs

    workspace = tmp_path / "project"
    workspace.mkdir()
    root_path = workspace / "root.jsonl"
    node_path = workspace / "node.jsonl"
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        runs.init(con)
        run = runs.create(con, workspace=str(workspace), question="Protect live research")
        root = runs.root(con, run["id"])
        node = runs.create_node(con, run["id"], question="Branch", parents=[root["id"]])
        runs.set_state(con, run["id"], status="waiting_input", root_session=str(root_path))
        runs.set_node(con, node["id"], session_file=str(node_path))

        assert session_belongs_to_active_research(con, str(root_path))
        assert session_belongs_to_active_research(con, str(node_path))
        runs.set_state(con, run["id"], status="done")
        assert session_belongs_to_active_research(con, str(root_path)) is False


def test_bridge_direct_entry_installs_meter_before_opening_session(monkeypatch, tmp_path):
    from types import SimpleNamespace

    from misaka.ai import api_registry
    from misaka.cli import desktop_bridge
    from misaka.core import wiring
    from misaka.core.platform import metering, session

    monkeypatch.setattr(api_registry, "_request_meter", None)
    monkeypatch.setattr(wiring, "bundled", wiring.bundled)

    installed = []
    async def capture(flags, cwd, assembly=None):
        installed.append(api_registry._request_meter is metering.meter)
        return None, None, "captured"

    monkeypatch.setattr(session, "open_session", capture)
    assert desktop_bridge.main(SimpleNamespace(cwd=str(tmp_path))) == 1
    assert installed == [True]
