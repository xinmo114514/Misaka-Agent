"""Desktop picker contract: metadata and resolved ACKs without any inference calls."""
from __future__ import annotations

import io
import json
import sys
from types import SimpleNamespace

import pytest
from test_desktop_bridge import MockRuntimeHost, MockSession

from misaka.cli.desktop_bridge import _thinking_state, run_desktop_bridge


@pytest.mark.parametrize("levels,supports,level", [
    (["high"], True, "high"), ([], True, "off"), (["off"], False, "off"),
    (["low", "high"], True, "high"),
])
def test_picker_state_preserves_fixed_empty_and_nonreasoning_capabilities(levels, supports, level):
    session = SimpleNamespace(thinkingLevel=level, getAvailableThinkingLevels=lambda: levels,
                              supportsThinking=lambda: supports)
    assert _thinking_state(session) == {"level": level, "levels": levels, "supportsThinking": supports}


@pytest.mark.asyncio
async def test_picker_commands_ack_the_resolved_session_and_keep_session_selection_nonpersistent(monkeypatch):
    import misaka.cli.desktop_bridge as bridge

    session = MockSession()
    selected = SimpleNamespace(provider="fixture", id="fixed", name="Fixed high")
    session.modelRegistry = SimpleNamespace(find=lambda provider, model_id: selected)
    session.thinkingLevel = "off"
    session.getAvailableThinkingLevels = lambda: ["high"]
    session.supportsThinking = lambda: True
    selections = []

    async def set_model(model, options=None):
        selections.append((model, bool((options or {}).get("persist"))))
        session.model = model
        session.thinkingLevel = "high"

    session.setModel = set_model
    # A bridge test double supplies an already-clamped engine outcome.
    session.setThinkingLevel = lambda requested: setattr(session, "thinkingLevel", "high")
    commands = [
        {"type": "set_model", "requestId": "req_sm_fixture", "provider": "fixture", "modelId": "fixed", "persist": False},
        {"type": "set_thinking", "requestId": "req_st_fixture", "level": "max"},
        {"type": "get_thinking_levels", "requestId": "req_thinking_fixture"},
        {"type": "shutdown", "requestId": "shutdown"},
    ]
    output = io.StringIO()
    monkeypatch.setattr(sys, "stdin", io.StringIO("\n".join(json.dumps(c) for c in commands) + "\n"))
    monkeypatch.setattr(bridge, "writeRawStdout", output.write)
    assert await run_desktop_bridge(MockRuntimeHost(session)) == 0
    acks = {item["requestId"]: item for item in map(json.loads, output.getvalue().splitlines()) if item.get("type") == "ack"}
    assert selections == [(selected, False)]
    for request_id in ("req_sm_fixture", "req_st_fixture", "req_thinking_fixture"):
        assert acks[request_id]["ok"] is True
        assert acks[request_id]["data"]["levels"] == ["high"]
        assert acks[request_id]["data"]["level"] == "high"
    assert acks["req_sm_fixture"]["data"]["currentModel"] == {
        "provider": "fixture", "modelId": "fixed", "name": "Fixed high", "thinking": "high",
    }
