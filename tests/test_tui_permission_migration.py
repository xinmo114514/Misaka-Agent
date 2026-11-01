from types import SimpleNamespace
import asyncio

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


async def test_permission_prompt_returns_native_suggestion_scope():
    label = "Yes, allow npm run commands in this project"
    async def choose(title, options):
        assert options == ["Yes, allow once", label, "No, deny"]
        return label
    host = SimpleNamespace(showExtensionSelector=choose)
    assert await module.InteractiveMode.handleAgentPermissionRequest(
        host, None, {"toolName": "bash", "toolInput": {"command": "npm run build"},
                     "suggestions": [{"type": "addRules"}], "suggestionLabel": label}) == {
                         "approved": True, "scope": "suggested"}


async def test_permission_prompt_without_suggestions_can_cancel():
    async def choose(title, options):
        assert options == ["Yes, allow once", "No, deny"]
        return None
    result = await module.InteractiveMode.handleAgentPermissionRequest(
        SimpleNamespace(showExtensionSelector=choose), None,
        {"toolName": "bash", "suggestionLabel": "Do not offer without rules"})
    assert result == {"approved": False, "scope": "once"}


async def test_replaced_session_cannot_reopen_a_tui_approval():
    callbacks, shown = [], []
    old = SimpleNamespace(setAgentPermissionResolver=lambda callback: callbacks.append(callback))
    async def noop():
        pass
    async def approve(task, event):
        shown.append(event)
        return {"approved": True, "scope": "suggested"}
    host = SimpleNamespace(session=old, unsubscribe=None,
        programStatus=SimpleNamespace(reset=lambda: None), applyRuntimeSettings=lambda: None,
        bindCurrentSessionExtensions=noop, subscribeToAgent=lambda: None,
        updateAvailableProviderCount=lambda: None, updateEditorBorderColor=lambda: None,
        updateTerminalTitle=lambda: None, handleAgentPermissionRequest=approve)
    await module.InteractiveMode.rebindCurrentSession(host)
    retained = callbacks[-1]
    host.session = SimpleNamespace()
    await module.InteractiveMode.rebindCurrentSession(host)
    result = await retained(None, {"toolName": "bash"})
    assert result == {"approved": False, "scope": "once"}
    assert shown == []
    assert callbacks[-1] is None


async def test_tui_approval_result_is_denied_when_owner_changes_while_open():
    callbacks = []
    old = SimpleNamespace(setAgentPermissionResolver=lambda callback: callbacks.append(callback))
    answer = asyncio.get_running_loop().create_future()
    async def noop():
        pass
    async def approve(task, event):
        return await answer
    host = SimpleNamespace(session=old, unsubscribe=None,
        programStatus=SimpleNamespace(reset=lambda: None), applyRuntimeSettings=lambda: None,
        bindCurrentSessionExtensions=noop, subscribeToAgent=lambda: None,
        updateAvailableProviderCount=lambda: None, updateEditorBorderColor=lambda: None,
        updateTerminalTitle=lambda: None, handleAgentPermissionRequest=approve)
    await module.InteractiveMode.rebindCurrentSession(host)
    pending = asyncio.create_task(callbacks[-1](None, {"toolName": "bash"}))
    await asyncio.sleep(0)
    host.session = SimpleNamespace()
    await module.InteractiveMode.rebindCurrentSession(host)
    answer.set_result({"approved": True, "scope": "suggested"})
    assert await pending == {"approved": False, "scope": "once"}
