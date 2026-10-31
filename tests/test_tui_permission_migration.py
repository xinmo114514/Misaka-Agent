from types import SimpleNamespace

from misaka.modes.interactive import interactive_mode as module


def test_permission_selector_uses_current_session_mode(monkeypatch):
    assert module.PermissionSelectorComponent is not None
    captured = {}
    monkeypatch.setattr(module, "PermissionSelectorComponent",
        lambda current, select, cancel: captured.update(mode=current, select=select, cancel=cancel) or captured)
    selected, done = [], []
    host = SimpleNamespace(session=SimpleNamespace(getPermissionMode=lambda: "plan"),
        ui=SimpleNamespace(requestRender=lambda: None), handlePermissionModeSwitch=selected.append,
        showSelector=lambda factory: factory(lambda: done.append(True)))
    module.InteractiveMode.showPermissionSelector(host)
    assert captured["mode"] == "plan"
    captured["select"]("acceptEdits")
    assert selected == ["acceptEdits"] and done == [True]


async def test_permission_prompt_session_grant_uses_session_contract():
    grants = []
    async def choose(title, options):
        return "Yes, always allow in this session"
    host = SimpleNamespace(session=SimpleNamespace(addSessionPermission=grants.append), showExtensionSelector=choose)
    assert await module.InteractiveMode.handleAgentPermissionRequest(
        host, None, {"toolName": "bash", "toolInput": {"command": "pwd"}})
    assert grants == ["bash"]
