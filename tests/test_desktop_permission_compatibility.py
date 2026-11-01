"""Exercise real JSONL approvals against the native policy and server-owned rules."""
import asyncio
import io
import json
import queue
import sys

import pytest

from misaka.cli import desktop_bridge
from misaka.core.agent_session import AgentSession
from tests.test_ccb_permission_modes import _part
from tests.test_desktop_bridge import MockRuntimeHost, MockSession


@pytest.mark.parametrize("scope", ["suggested", "session", "once"])
@pytest.mark.parametrize("has_suggestions", [True, False])
async def test_bridge_applies_only_original_suggestions(monkeypatch, tmp_path, scope, has_suggestions):
    part, native, _ = _part(tmp_path, monkeypatch, mode="default")
    native.settingsManager.trusted = False
    session = MockSession()
    session.settingsManager, session.moments = native.settingsManager, native.moments
    part.policy.session = session
    for name in ("getPermissionMode", "requestAgentPermission", "setAgentPermissionResolver"):
        setattr(session, name, getattr(AgentSession, name).__get__(session))
    inbox = queue.Queue()
    def send(obj):
        inbox.put(json.dumps(obj) + "\n")
    stdin = type("Input", (), {"readline": lambda self: inbox.get(timeout=10)})()
    output = io.StringIO()
    label = "Yes, allow npm run commands"
    suggestions = [{"type": "addRules", "destination": "session", "behavior": "allow",
                    "rules": [{"toolName": "Bash", "ruleContent": "npm run:*"}]}]
    requests, approvals = [], []
    def write(text):
        output.write(text)
        for line in text.splitlines():
            payload = json.loads(line)
            event = payload.get("event", {})
            if event.get("type") == "permission:request":
                requests.append(event)
                response = {"type": "permission_response", "requestId": event["requestId"],
                            "decision": "allow", "scope": scope,
                            "suggestions": [{"type": "setMode", "mode": "bypassPermissions"}]}
                send(response)
                send(response)  # A response is consumed exactly once.
    async def prompt(text, options=None):
        approvals.append(await session.requestAgentPermission(None, {
            "toolName": "bash", "toolInput": {"command": "npm run build"},
            "suggestions": suggestions if has_suggestions else [], "suggestionLabel": label,
        }))
        send({"type": "shutdown"})
    session.prompt = prompt
    monkeypatch.setattr(sys, "stdin", stdin)
    monkeypatch.setattr(desktop_bridge, "writeRawStdout", write)
    send({"type": "prompt", "requestId": "start", "text": "test"})
    assert await asyncio.wait_for(desktop_bridge.run_desktop_bridge(MockRuntimeHost(session)), 10) == 0
    assert approvals == [True]
    assert requests[0].get("canApplySuggestions") is has_suggestions
    assert requests[0].get("suggestionLabel") == (label if has_suggestions else None)
    expected = ["Bash(npm run:*)"] if has_suggestions and scope != "once" else []
    assert part.policy.session_rules == expected
    assert part.get_permission_mode() == "default"
    acks = [json.loads(line) for line in output.getvalue().splitlines()
            if json.loads(line).get("type") == "ack"
            and json.loads(line).get("requestId") == requests[0]["requestId"]]
    assert [ack["ok"] for ack in acks] == [True, False]


@pytest.mark.parametrize("ending", ["deny", "abort", "rebind", "cancel", "shutdown", "eof"])
async def test_retired_permission_cannot_grant_late_response(monkeypatch, tmp_path, ending):
    part, native, _ = _part(tmp_path, monkeypatch, mode="default")
    session = MockSession()
    session.settingsManager, session.moments = native.settingsManager, native.moments
    part.policy.session = session
    for name in ("getPermissionMode", "requestAgentPermission", "setAgentPermissionResolver"):
        setattr(session, name, getattr(AgentSession, name).__get__(session))
    host = MockRuntimeHost(session)
    inbox = queue.Queue()
    send = lambda obj: inbox.put(json.dumps(obj) + "\n")
    approvals, requests, pending_tasks, actions = [], [], [], []
    output = io.StringIO()

    async def retire(request):
        response = {"type": "permission_response", "requestId": request["requestId"],
                    "decision": "allow", "scope": "suggested"}
        if ending == "deny":
            send({**response, "decision": "deny"})
        elif ending == "abort":
            send({"type": "abort", "requestId": "abort"})
            send(response)
        elif ending == "rebind":
            host.session = MockSession("replacement")
            await host.rebind_handler(host.session)
            send(response)
        elif ending == "cancel":
            pending_tasks[0].cancel()
            await asyncio.sleep(0)
            send(response)
        elif ending == "shutdown":
            send({"type": "shutdown"})
        else:
            inbox.put("")

    def write(text):
        output.write(text)
        for line in text.splitlines():
            event = json.loads(line).get("event", {})
            if event.get("type") == "permission:request":
                requests.append(event)
                actions.append(asyncio.create_task(retire(event)))

    async def prompt(text, options=None):
        pending = asyncio.create_task(session.requestAgentPermission(None, {
            "toolName": "bash", "toolInput": {"command": "npm run build"},
            "suggestions": [{"type": "setMode", "mode": "acceptEdits"}],
            "suggestionLabel": "Allow edits for this session",
        }))
        pending_tasks.append(pending)
        try:
            approvals.append(await pending)
        except asyncio.CancelledError:
            approvals.append(False)
        if ending not in ("shutdown", "eof"):
            send({"type": "shutdown"})

    session.prompt = prompt
    monkeypatch.setattr(sys, "stdin", type("Input", (), {"readline": lambda self: inbox.get(timeout=5)})())
    monkeypatch.setattr(desktop_bridge, "writeRawStdout", write)
    send({"type": "prompt", "text": "test", "requestId": "start"})
    assert await asyncio.wait_for(desktop_bridge.run_desktop_bridge(host), 5) == 0
    await asyncio.gather(*actions)
    await asyncio.gather(*pending_tasks, return_exceptions=True)
    assert approvals == [False]
    assert part.get_permission_mode() == "default"
    assert session._agentPermissionResolver is None
    if ending in ("abort", "rebind", "cancel"):
        stale_ack = [json.loads(line) for line in output.getvalue().splitlines()
                     if json.loads(line).get("type") == "ack"
                     and json.loads(line).get("requestId") == requests[0]["requestId"]]
        assert stale_ack and stale_ack[0]["ok"] is False
