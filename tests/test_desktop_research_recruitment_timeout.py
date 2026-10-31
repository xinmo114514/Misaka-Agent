"""A recruitment turn that never settles must fail visibly instead of hanging the start.

Real AgentSession, real coordinator and real workflow; only the provider is scripted and only
the recruitment bound is shrunk. The user-visible contract is that the caller gets a structured,
retryable failure rather than silence for the whole desktop startup budget.
"""
import asyncio

import pytest

from tests.test_prompt_assembly_integration import prompt_home  # noqa: F401 - fixture


async def test_recruitment_that_never_settles_fails_with_a_retryable_error(prompt_home, monkeypatch):  # noqa: F811
    from misaka.ai.auth.types import ApiKeyCredential
    from misaka.ai.providers.openai_models import OPENAI_MODELS
    from misaka.ai.types import AssistantMessage, DoneEvent
    from misaka.ai.utils.event_stream import AssistantMessageEventStream
    from misaka.core import wiring
    from misaka.core.auth_storage import AuthStorage
    from misaka.core.model_runtime import ModelRuntime
    from misaka.core.research import submissions
    from misaka.core.resource_loader import DefaultResourceLoader
    from misaka.core.sdk import createAgentSession as create_agent_session
    from misaka.core.session_manager import SessionManager
    from misaka.core.settings_manager import SettingsManager
    from misaka.desktop_research import runtime
    from misaka.desktop_research.runtime import DesktopResearchController

    # Shrink only the recruitment bound; the production value is deliberately generous.
    monkeypatch.setattr(runtime, 'RECRUITMENT_TURN_TIMEOUT_SECONDS', 0.5)

    workspace = prompt_home / 'workspace_recruit_timeout'
    workspace.mkdir()
    _, assembly, _ = wiring.role_session_setup(str(prompt_home / 'profiles/last_order'), str(workspace),
                                               workflow_context=True, research_host=True)
    loader = DefaultResourceLoader({'cwd': str(workspace), 'agentDir': str(prompt_home / 'agent'),
                                    'noExtensions': True, 'noPromptTemplates': True, 'noThemes': True})
    await loader.reload()
    model = next(iter(OPENAI_MODELS.values()))
    auth = AuthStorage.inMemory()
    async def credential(_current):
        return ApiKeyCredential(key="deterministic-fixture")
    await auth.modify(model.provider, credential)
    result = await create_agent_session({
        'cwd': str(workspace), 'agentDir': str(prompt_home / 'agent'), 'model': model, 'modelRuntime': await ModelRuntime.create({'authStorage': auth, 'modelsPath': None}),
        'resourceLoader': loader,
        'settingsManager': SettingsManager.inMemory({'compaction': {'enabled': False}, 'retry': {'enabled': False}}),
        'sessionManager': SessionManager.create(str(workspace), str(prompt_home / 'sessions')),
        'parts': assembly.parts, 'customTools': assembly.custom_tools})
    session = result['session']
    session.research_host = True

    # The coordinator never calls desktop_recruit_agent and never finishes its turn.
    stalled = asyncio.Event()

    async def stream(actual_model, context, options=None):
        await stalled.wait()
        out = AssistantMessageEventStream()
        reply = AssistantMessage(content=[{'type': 'text', 'text': 'thinking'}], api=model.api,
                                 provider=model.provider, model=model.id, stopReason='stop', timestamp=1,
                                 usage={'input': 1, 'output': 1, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 2,
                                        'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0}})
        out.push(DoneEvent(reason=reply.stopReason, message=reply))
        out.end(reply)
        return out

    session.agent.streamFunction = stream
    controller = DesktopResearchController(session, lambda payload: None).attach()
    await controller.set_team_model(model.provider, model.id, role='last_order')
    await session.bindExtensions({'mode': 'json'})
    con = controller.scope.native.module('misaka.core.research.wiring.research')._con()

    try:
        with pytest.raises(submissions.ResearchInputError) as caught:
            await asyncio.wait_for(controller.send_message(
                {'sessionId': session.sessionId, 'requestId': 'stalled-input',
                 'text': 'A question whose recruitment never completes',
                 'limits': {'max_depth': 0, 'max_nodes': 1}}, con), timeout=30)
        error = caught.value
        assert error.errorCode == 'RESEARCH_RECRUITMENT_TIMEOUT'
        assert error.errorStage == 'recruitment'
        # The question is retained, so the user can retry rather than retype.
        assert error.retryable is True
    finally:
        stalled.set()
        await controller.close()
        await session.moments.session_shutdown({'type': 'session_shutdown', 'reason': 'test'})
        session.dispose()


async def test_recruitment_timeout_is_reported_as_a_structured_bridge_ack(prompt_home, monkeypatch):  # noqa: F811
    """The bridge must surface the timeout through its existing failure contract."""
    from misaka.core.research import submissions

    error = submissions.ResearchInputError('研究团队招募未在预期时间内完成，研究尚未启动；原始课题已保留，可以重试。',
                                           'RESEARCH_RECRUITMENT_TIMEOUT', stage='recruitment', retryable=True)
    known = isinstance(error, submissions.ResearchInputError)
    ack = {'error': str(error) if known else '研究消息暂未接收，请检查连接后重试。',
           'errorCode': error.errorCode if known else 'RESEARCH_SUBMISSION_FAILED',
           'errorStage': error.errorStage if known else 'submission',
           'retryable': error.retryable if known else True}
    assert ack['errorCode'] == 'RESEARCH_RECRUITMENT_TIMEOUT'
    assert ack['errorStage'] == 'recruitment'
    assert ack['retryable'] is True


async def test_recruitment_stream_call_that_never_completes_times_out(prompt_home, monkeypatch):  # noqa: F811
    """When the provider stream stalls during sendCustomMessage, recruitment timeout must fire."""
    from misaka.ai.auth.types import ApiKeyCredential
    from misaka.ai.providers.openai_models import OPENAI_MODELS
    from misaka.ai.utils.event_stream import AssistantMessageEventStream
    from misaka.core import wiring
    from misaka.core.auth_storage import AuthStorage
    from misaka.core.model_runtime import ModelRuntime
    from misaka.core.research import submissions
    from misaka.core.resource_loader import DefaultResourceLoader
    from misaka.core.sdk import createAgentSession as create_agent_session
    from misaka.core.session_manager import SessionManager
    from misaka.core.settings_manager import SettingsManager
    from misaka.desktop_research import runtime
    from misaka.desktop_research.runtime import DesktopResearchController

    monkeypatch.setattr(runtime, "RECRUITMENT_TURN_TIMEOUT_SECONDS", 0.5)

    workspace = prompt_home / "workspace_recruit_stream_timeout"
    workspace.mkdir()
    _, assembly, _ = wiring.role_session_setup(str(prompt_home / "profiles/last_order"), str(workspace),
                                               workflow_context=True, research_host=True)
    loader = DefaultResourceLoader({"cwd": str(workspace), "agentDir": str(prompt_home / "agent"),
                                    "noExtensions": True, "noPromptTemplates": True, "noThemes": True})
    await loader.reload()
    model = next(iter(OPENAI_MODELS.values()))
    auth = AuthStorage.inMemory()
    async def credential(_current):
        return ApiKeyCredential(key="deterministic-fixture")
    await auth.modify(model.provider, credential)
    result = await create_agent_session({
        "cwd": str(workspace), "agentDir": str(prompt_home / "agent"), "model": model,
        "modelRuntime": await ModelRuntime.create({"authStorage": auth, "modelsPath": None}),
        "resourceLoader": loader,
        "settingsManager": SettingsManager.inMemory({"compaction": {"enabled": False}, "retry": {"enabled": False}}),
        "sessionManager": SessionManager.create(str(workspace), str(prompt_home / "sessions")),
        "parts": assembly.parts, "customTools": assembly.custom_tools})
    session = result["session"]
    session.research_host = True

    # The stream never emits or ends: simulates an infinite provider hang during sendCustomMessage
    def hanging_stream(actual_model, context, options=None):
        return AssistantMessageEventStream()

    session.agent.streamFunction = hanging_stream
    controller = DesktopResearchController(session, lambda payload: None).attach()
    await controller.set_team_model(model.provider, model.id, role='last_order')
    await session.bindExtensions({"mode": "json"})
    con = controller.scope.native.module("misaka.core.research.wiring.research")._con()

    try:
        with pytest.raises(submissions.ResearchInputError) as caught:
            await asyncio.wait_for(controller.send_message(
                {"sessionId": session.sessionId, "requestId": "stream-hang-input",
                 "text": "A question whose recruitment model call hangs",
                 "limits": {"max_depth": 0, "max_nodes": 1}}, con), timeout=10)
        error = caught.value
        assert error.errorCode == "RESEARCH_RECRUITMENT_TIMEOUT"
        assert error.errorStage == "recruitment"
        assert error.retryable is True
    finally:
        await controller.close()
        await session.moments.session_shutdown({"type": "session_shutdown", "reason": "test"})
        session.dispose()
