"""Desktop-only controller transport: native TUI/controller roots stay distinct."""
import asyncio
import io
import json
import sys
from types import SimpleNamespace
from typing import ClassVar

import pytest

from misaka.cli import desktop_bridge
from tests.test_desktop_bridge import MockRuntimeHost, MockSession


class Controller:
    attached: ClassVar[list] = []
    calls: ClassVar[list] = []
    gate = None

    def __init__(self, session, emit, config=None):
        self.session, self.emit = session, emit
        self.ingress = SimpleNamespace(event=lambda event: event)
    def attach(self):
        self.attached.append(self.session.sessionId)
        return self
    def snapshot(self):
        return {"team": {"teamId": "team-1", "scene": "desktop_research", "members": []},
                "modelBinding": {"effective": {"provider": "fixture", "modelId": "a"},
                                 "target": None, "epoch": 1, "state": "ready"}}
    async def set_team_model(self, provider, model_id, action="switch"):
        self.calls.append(action)
        if action == "switch":
            await self.gate.wait()
        else:
            self.gate.set()
        return self.snapshot()
    async def retain_roles(self, selections, request_id, con):
        self.calls.append(("retain", selections, request_id))
        return self.snapshot()
    async def send_message(self, obj, con):
        self.calls.append(("send", obj["text"]))
        return {"accepted": True, "runId": "run-1", "mode": "start"}
    async def close(self):
        self.calls.append("closed")

async def bridge(monkeypatch, commands, research=True):
    from misaka.desktop_research import runtime
    Controller.attached, Controller.calls = [], []
    Controller.gate = asyncio.Event()
    monkeypatch.setattr(runtime, "DesktopResearchController", Controller)
    session = MockSession()
    session.moments = SimpleNamespace(parts=[])
    session.sessionManager.buildContextEntries = list
    output = io.StringIO()
    monkeypatch.setattr(desktop_bridge, "writeRawStdout", output.write)
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(command) + "\n" for command in commands)))
    await desktop_bridge.run_desktop_bridge(MockRuntimeHost(session), {"desktop_research": research})
    return [json.loads(line) for line in output.getvalue().splitlines()]

@pytest.mark.asyncio
async def test_desktop_root_host_exposes_actual_controller_team_snapshot(monkeypatch):
    result = await bridge(monkeypatch, [{"type": "get_research_host", "requestId": "host"}])
    ack = next(item for item in result if item.get("requestId") == "host")
    assert ack["data"]["team"]["teamId"] == "team-1"
    assert ack["data"]["modelBinding"]["effective"]["modelId"] == "a"
    assert Controller.attached == ["test-session-123"]

@pytest.mark.asyncio
async def test_ordinary_desktop_does_not_install_desktop_team_parts(monkeypatch):
    result = await bridge(monkeypatch, [{"type": "get_stats", "requestId": "stats"}], research=False)
    assert Controller.attached == []
    assert next(item for item in result if item.get("requestId") == "stats")["ok"] is True

@pytest.mark.asyncio
async def test_cancel_model_switch_can_reach_pending_switch_on_same_transport(monkeypatch):
    result = await bridge(monkeypatch, [
        {"type": "desktop_set_team_model", "sessionId": "test-session-123", "provider": "fixture", "modelId": "b", "requestId": "switch"},
        {"type": "desktop_set_team_model", "sessionId": "test-session-123", "action": "cancel", "requestId": "cancel"},
    ])
    replies = {item.get("requestId"): item for item in result if item.get("type") == "ack"}
    assert replies["switch"]["ok"] is True
    assert replies["cancel"]["ok"] is True
    assert Controller.calls[:2] == ["switch", "cancel"]

@pytest.mark.asyncio
async def test_team_commands_reject_mismatched_session_and_preserve_ordinary_roots(monkeypatch):
    result = await bridge(monkeypatch, [{"type": "desktop_retain_roles", "sessionId": "foreign", "requestId": "foreign", "selections": []}])
    ack = next(item for item in result if item.get("requestId") == "foreign")
    assert ack["ok"] is False
    assert not any(isinstance(call, tuple) and call[0] == "retain" for call in Controller.calls)

@pytest.mark.asyncio
async def test_retention_is_forwarded_with_explicit_selection_only(monkeypatch):
    monkeypatch.setattr(desktop_bridge, "session_run", lambda *_args: {"id": "run-1", "status": "done", "phase": "done"})
    selected = [{"id": "new-role", "name": "evidence-reviewer"}]
    result = await bridge(monkeypatch, [{"type": "desktop_retain_roles", "sessionId": "test-session-123", "requestId": "save", "runId": "run-1", "selections": selected}])
    ack = next(item for item in result if item.get("requestId") == "save")
    assert ack["ok"] is True
    assert ("retain", selected, "save") in Controller.calls

@pytest.mark.asyncio
async def test_legacy_desktop_start_also_uses_team_intake(monkeypatch):
    result = await bridge(monkeypatch, [{"type": "start_research", "requestId": "legacy", "question": "Compare sources", "limits": {"max_depth": 1}}])
    ack = next(item for item in result if item.get("requestId") == "legacy")
    assert ack["ok"] is True
    assert ("send", "Compare sources") in Controller.calls

@pytest.mark.asyncio
async def test_desktop_research_prompt_question_also_uses_team_intake(monkeypatch):
    result = await bridge(monkeypatch, [{"type": "prompt", "requestId": "slash-start", "text": "/research Compare sources"}])
    ack = next(item for item in result if item.get("requestId") == "slash-start")
    assert ack["ok"] is True
    assert ("send", "Compare sources") in Controller.calls


@pytest.mark.parametrize("research", [True, False])
def test_bridge_prepares_only_research_assembly_before_opening(monkeypatch, tmp_path, research):
    from misaka.core import wiring
    from misaka.core.platform import session as platform_session
    from misaka.desktop_research import runtime

    assembly = SimpleNamespace(prepared=False)
    calls = []
    monkeypatch.setattr(desktop_bridge, "_clean_broken_local_proxies", lambda: None)
    monkeypatch.setattr(wiring, "role_session_setup", lambda *_args, **_kwargs: ([], assembly, {}))
    def prepare(value):
        assert value is assembly
        calls.append("prepare")
        value.prepared = True
        return value
    monkeypatch.setattr(runtime, "prepare_desktop_assembly", prepare)
    async def open_session(_flags, _cwd, value):
        assert value.prepared is research
        calls.append("open")
        return SimpleNamespace(), SimpleNamespace(), None
    async def run_bridge(_runtime, options):
        assert options["desktop_research"] is research
        return 0
    monkeypatch.setattr(platform_session, "open_session", open_session)
    monkeypatch.setattr(desktop_bridge, "run_desktop_bridge", run_bridge)
    args = SimpleNamespace(cwd=str(tmp_path), research_context=research)
    assert desktop_bridge.main(args) == 0
    assert calls == (["prepare", "open"] if research else ["open"])

