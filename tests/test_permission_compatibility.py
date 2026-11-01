"""GUI/TUI approvals preserve the native policy's mode and grant boundaries."""
import asyncio
from types import SimpleNamespace

import pytest

from misaka.core.agent_session import AgentSession
from misaka.core.subagent.runtime import SubagentManager
from tests.test_ccb_permission_modes import _part, _bash, _ui


def _bind_session(session):
    for name in ("getPermissionMode", "setPermissionMode", "requestAgentPermission"):
        setattr(session, name, getattr(AgentSession, name).__get__(session))
    session.events = []
    session._emit = session.events.append


def test_live_mode_does_not_change_new_session_default(tmp_path, monkeypatch):
    part, session, _ = _part(tmp_path, monkeypatch, mode="acceptEdits")
    _bind_session(session)
    # This was the accidental global write made by the desktop integration.
    session.settingsManager.setPermissionMode = lambda mode: session.settingsManager.globalSettings.update(permissionMode=mode)
    session.setPermissionMode("plan")
    assert part.get_permission_mode() == "plan"
    assert session.settingsManager.globalSettings == {}
    assert session.events == [{"type": "permission_mode_change", "mode": "plan", "previousMode": "acceptEdits"}]
    fresh, _, _ = _part(tmp_path, monkeypatch, mode="acceptEdits")
    assert fresh.get_permission_mode() == "acceptEdits"


@pytest.mark.parametrize("answer", [False, {"approved": False, "scope": "suggested"}])
def test_denial_never_becomes_truthy_dict(tmp_path, monkeypatch, answer):
    part, session, _ = _part(tmp_path, monkeypatch, mode="default")
    _bind_session(session)
    session._agentPermissionResolver = lambda task, event: answer
    assert asyncio.run(session.requestAgentPermission(None, {"toolName": "bash"})) is False
    assert part.policy.session_rules == []


def test_suggested_bash_grant_does_not_allow_other_commands(tmp_path, monkeypatch):
    part, session, _ = _part(tmp_path, monkeypatch, mode="default")
    _bind_session(session)
    session.settingsManager.trusted = False
    session._agentPermissionResolver = lambda task, event: {"approved": True, "scope": "suggested"}
    assert _bash(part, "npm run build", None) is None
    assert part.policy.session_rules == ["Bash(npm run:*)"]
    session._agentPermissionResolver = lambda task, event: False
    assert _bash(part, "npm run test", None) is None
    assert _bash(part, "python3 other.py", None)["block"] is True


@pytest.mark.parametrize("answer", [True, {"approved": True, "scope": "once"}])
def test_allow_once_does_not_save_a_rule(tmp_path, monkeypatch, answer):
    part, session, _ = _part(tmp_path, monkeypatch, mode="default")
    _bind_session(session)
    session._agentPermissionResolver = lambda task, event: answer
    assert _bash(part, "npm run build", None) is None
    assert part.policy.session_rules == []
    assert session.settingsManager.saved == []


def test_missing_custom_resolver_keeps_parent_ui_fallback(tmp_path, monkeypatch):
    part, session, _ = _part(tmp_path, monkeypatch, mode="default")
    _bind_session(session)
    ctx, asked = _ui(0)
    manager = SimpleNamespace(session=session, permission_updates=part.policy.apply_permission_updates)
    task = SimpleNamespace(id="child", permission_context=ctx)
    assert asyncio.run(SubagentManager._resolve_permission_request(manager, task,
        {"toolName": "bash", "toolInput": {"command": "npm run build"}})) is True
    assert len(asked) == 1


def test_scoped_directory_grant_does_not_grant_sibling_directory(tmp_path, monkeypatch):
    part, session, _ = _part(tmp_path, monkeypatch, mode="default")
    _bind_session(session)
    outside = tmp_path / "evidence"
    outside.mkdir()
    session._agentPermissionResolver = lambda task, event: {"approved": True, "scope": "suggested"}
    assert _bash(part, f"cat {(outside / 'one.txt').as_posix()}", None) is None
    session._agentPermissionResolver = lambda task, event: False
    assert _bash(part, f"cat {(outside / 'two.txt').as_posix()}", None) is None
    assert _bash(part, f"cat {(tmp_path / 'private' / 'secret.txt').as_posix()}", None)["block"] is True


def test_child_suggested_grant_is_saved_in_parent_policy(tmp_path, monkeypatch):
    part, session, _ = _part(tmp_path, monkeypatch, mode="default")
    _bind_session(session)
    session.settingsManager.trusted = False
    session._agentPermissionResolver = lambda task, event: {"approved": True, "scope": "suggested"}
    manager = SimpleNamespace(session=session)
    event = {"toolName": "bash", "toolInput": {"command": "npm run build"},
             "suggestions": [{"type": "addRules", "destination": "session", "behavior": "allow",
                              "rules": [{"toolName": "Bash", "ruleContent": "npm run:*"}]}],
             "suggestionLabel": "Allow npm run commands"}
    assert asyncio.run(SubagentManager._resolve_permission_request(manager,
        SimpleNamespace(id="child"), event)) is True
    assert part.policy.session_rules == ["Bash(npm run:*)"]


def test_legacy_mode_field_does_not_override_native_managed_default(tmp_path, monkeypatch):
    from misaka.core.subagent.configuration import initial_permission_mode

    _, session, _ = _part(tmp_path, monkeypatch, mode="acceptEdits")
    session.settingsManager.globalSettings.update(permissionMode="bypassPermissions",
        permissions={"defaultMode": "default"})
    session.settingsManager.getManagedSettings = lambda: {"permissions": {"defaultMode": "plan"}}
    assert initial_permission_mode(session) == "plan"
    assert session.settingsManager.globalSettings["permissionMode"] == "bypassPermissions"


def test_revoked_resolver_cannot_apply_its_late_approval(tmp_path, monkeypatch):
    part, session, _ = _part(tmp_path, monkeypatch, mode="default")
    _bind_session(session)
    async def approve(task, event):
        session._agentPermissionResolver = None
        return {"approved": True, "scope": "suggested"}
    session._agentPermissionResolver = approve
    result = asyncio.run(session.requestAgentPermission(None, {
        "toolName": "write", "suggestions": [{"type": "setMode", "mode": "acceptEdits"}],
        "suggestionLabel": "Allow edits for this session"}))
    assert result is False
    assert part.get_permission_mode() == "default"
