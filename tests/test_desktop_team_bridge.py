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
    async def set_team_model(self, provider, model_id, action="switch", role="all"):
        self.calls.append(action)
        self.calls.append(("model-role", role))
        if action == "switch":
            await self.gate.wait()
        else:
            self.gate.set()
        return self.snapshot()
    async def set_team_thinking(self, level, role="last_order"):
        self.calls.append(("thinking-role", role, level))
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
    assert [call for call in Controller.calls if isinstance(call, str)][:2] == ["switch", "cancel"]
    assert ("model-role", "all") in Controller.calls


@pytest.mark.parametrize("role", ["last_order", "sister"])
async def test_role_model_and_thinking_are_forwarded_without_changing_scope(monkeypatch, role):
    result = await bridge(monkeypatch, [
        {"type": "desktop_set_team_model", "sessionId": "test-session-123", "role": role,
         "action": "cancel", "requestId": "role-model"},
        {"type": "set_thinking", "sessionId": "test-session-123", "role": role,
         "level": "medium", "requestId": "role-thinking"},
    ])
    acks = {row.get("requestId"): row for row in result if row.get("type") == "ack"}
    assert acks["role-model"]["ok"] and acks["role-thinking"]["ok"]
    assert ("model-role", role) in Controller.calls
    assert ("thinking-role", role, "medium") in Controller.calls

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


async def test_abort_cancels_pending_research_intake_before_a_run_can_start(monkeypatch):
    async def intake(self, obj, con):
        self.calls.append('intake-entered')
        try:
            await self.gate.wait()
        except asyncio.CancelledError:
            self.calls.append('intake-cancelled')
            raise
        self.calls.append('unintended-run-start')
        return {'accepted': True, 'mode': 'start'}

    monkeypatch.setattr(Controller, 'send_message', intake)
    replies = await bridge(monkeypatch, [
        {'type': 'send_research_message', 'requestId': 'pending-input',
         'sessionId': 'test-session-123', 'text': '研究要求'},
        {'type': 'abort', 'requestId': 'cancel-intake'},
        {'type': 'desktop_set_team_model', 'sessionId': 'test-session-123',
         'action': 'cancel', 'requestId': 'release-fixture'},
    ])
    assert 'intake-entered' in Controller.calls
    assert 'intake-cancelled' in Controller.calls
    assert 'unintended-run-start' not in Controller.calls
    original = next(row for row in replies if row.get('requestId') == 'pending-input')
    assert original['ok'] is False
    assert original['errorCode'] == 'RESEARCH_STARTUP_CANCELLED'


@pytest.mark.parametrize('scope,code', [('sessionId', 'RESEARCH_SESSION_CHANGED'), ('streamId', 'RESEARCH_STREAM_CHANGED')])
async def test_foreign_abort_does_not_cancel_the_current_research_host(monkeypatch, scope, code):
    async def intake(self, obj, con):
        await self.gate.wait()
        return {'accepted': True, 'mode': 'start'}

    monkeypatch.setattr(Controller, 'send_message', intake)
    result = await bridge(monkeypatch, [
        {'type': 'send_research_message', 'requestId': 'owned-input',
         'sessionId': 'test-session-123', 'text': '本会话研究'},
        {'type': 'abort', 'requestId': 'foreign-abort', 'sessionId': 'test-session-123', scope: 'foreign-owner'},
        {'type': 'desktop_set_team_model', 'sessionId': 'test-session-123',
         'action': 'cancel', 'requestId': 'release-fixture'},
    ])
    ack = next(row for row in result if row.get('requestId') == 'foreign-abort')
    assert ack['ok'] is False and ack['errorCode'] == code
    assert next(row for row in result if row.get('requestId') == 'owned-input')['ok'] is True

@pytest.mark.asyncio
async def test_desktop_research_prompt_question_also_uses_team_intake(monkeypatch):
    result = await bridge(monkeypatch, [{"type": "prompt", "requestId": "slash-start", "text": "/research Compare sources"}])
    ack = next(item for item in result if item.get("requestId") == "slash-start")
    assert ack["ok"] is True
    assert ("send", "Compare sources") in Controller.calls


@pytest.mark.parametrize("research", [True, False])
def test_bridge_prepares_only_research_assembly_before_opening(monkeypatch, tmp_path, research):
    import os

    from misaka.core import wiring
    from misaka.core.platform import session as platform_session
    from misaka.desktop_research import runtime

    assembly = SimpleNamespace(prepared=False)
    calls = []
    proxy = "http://configured-proxy.test:43129"
    monkeypatch.setenv("HTTP_PROXY", proxy)
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
    assert os.environ["HTTP_PROXY"] == proxy
