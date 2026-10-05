"""Unit and integration tests for unified agent permission modes and approval flow."""

from __future__ import annotations

import asyncio
import json
import pytest
from types import SimpleNamespace

from misaka.cli.desktop_bridge import run_desktop_bridge
from misaka.core.agent_session import AgentSession
from misaka.core.settings_manager import SettingsManager
from misaka.core.subagent.configuration import validate_permission_mode
from misaka.core.subagent.policy import _permission_action


def test_permission_mode_validation():
    for mode in ("default", "plan", "acceptEdits", "bypassPermissions"):
        assert validate_permission_mode(mode) == mode
    with pytest.raises(ValueError):
        validate_permission_mode("invalid_mode")


def test_plan_mode_denies_mutating_tools(tmp_path):
    action, reason = _permission_action("plan", [], "write", {"path": str(tmp_path / "note.txt")}, str(tmp_path))
    assert action == "deny"
    assert "plan" in reason

    action, reason = _permission_action("plan", [], "edit", {"path": str(tmp_path / "note.txt")}, str(tmp_path))
    assert action == "deny"

    # Read-only tools must be allowed in plan mode
    action, reason = _permission_action("plan", [], "read", {"path": str(tmp_path / "note.txt")}, str(tmp_path))
    assert action == "allow"
    assert reason is None


def test_accept_edits_allows_workspace_writes(tmp_path):
    action, reason = _permission_action("acceptEdits", [], "write", {"path": str(tmp_path / "note.txt")}, str(tmp_path))
    assert action == "allow"
    assert reason is None


def test_bypass_permissions_allows_all(tmp_path):
    action, reason = _permission_action("bypassPermissions", [], "write", {"path": str(tmp_path / "note.txt")}, str(tmp_path))
    assert action == "allow"
    assert reason is None


@pytest.mark.asyncio
async def test_session_permission_resolver_and_session_grants():
    # Test AgentSession requestAgentPermission and addSessionPermission
    session = SimpleNamespace(
        moments=SimpleNamespace(parts=[]),
        settingsManager=SimpleNamespace(
            getPermissionMode=lambda: "default",
            setPermissionMode=lambda m: None,
        ),
        _eventListeners=[],
    )
    # Bind methods from AgentSession
    session.setAgentPermissionResolver = AgentSession.setAgentPermissionResolver.__get__(session, AgentSession)
    session.requestAgentPermission = AgentSession.requestAgentPermission.__get__(session, AgentSession)
    session.addSessionPermission = AgentSession.addSessionPermission.__get__(session, AgentSession)
    session.getPermissionMode = AgentSession.getPermissionMode.__get__(session, AgentSession)

    # When no resolver, returns False
    assert await session.requestAgentPermission(None, {"toolName": "bash"}) is False

    # When resolver attached
    async def mock_resolver(task, event):
        return event.get("toolName") == "bash"

    session.setAgentPermissionResolver(mock_resolver)
    assert await session.requestAgentPermission(None, {"toolName": "bash"}) is True
    assert await session.requestAgentPermission(None, {"toolName": "write"}) is False

    # Session permission grants
    session.addSessionPermission("write")
    assert "write" in session._sessionPermissions


@pytest.mark.asyncio
async def test_subagent_part_session_permissions():
    from misaka.core.subagent.extension import SubagentPart
    from misaka.core.subagent.runtime import RoleContext

    ctx = RoleContext(role="general", profile_dir="", mcp_role="", workspace=".")
    part = SubagentPart(ctx, permitted=False)
    assert part.get_permission_settings() is None

    part.add_session_permission("write")
    assert part.get_permission_settings() == {"allow": ["write"]}
    part.add_session_permission("bash")
    assert part.get_permission_settings() == {"allow": ["write", "bash"]}
