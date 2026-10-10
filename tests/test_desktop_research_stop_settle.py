"""A stop taken while the desktop root waits for input must settle the run, not strand it."""
import asyncio

from tests.test_prompt_assembly_integration import prompt_home  # noqa: F401 - fixture


async def _settle(runs, con, run_id, expected, seconds):
    """Poll the board until the run reaches `expected`; returns the sampled statuses."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + seconds
    seen = []
    while loop.time() < deadline:
        status = runs.get(con, run_id)["status"]
        if not seen or seen[-1] != status:
            seen.append(status)
        if status == expected:
            return seen
        await asyncio.sleep(.05)
    return seen


async def test_stop_taken_while_the_root_waits_for_input_settles_the_run(prompt_home):  # noqa: F811
    """Real AgentSession, real coordinator and real workflow; only the provider is scripted."""
    from misaka.ai.models import get_models
    from misaka.ai.types import AssistantMessage, DoneEvent
    from misaka.ai.utils.event_stream import AssistantMessageEventStream
    from misaka.core import wiring
    from misaka.core.auth_storage import AuthStorage
    from misaka.core.research import runs
    from misaka.core.resource_loader import DefaultResourceLoader
    from misaka.core.sdk import create_agent_session
    from misaka.core.session_manager import SessionManager
    from misaka.core.settings_manager import SettingsManager
    from misaka.desktop_research.runtime import DesktopResearchController

    workspace = prompt_home / 'workspace'
    workspace.mkdir()
    _, assembly, _ = wiring.role_session_setup(str(prompt_home / 'profiles/last_order'), str(workspace),
                                               research_context=True, research_host=True)
    loader = DefaultResourceLoader({'cwd': str(workspace), 'agentDir': str(prompt_home / 'agent'),
                                    'noExtensions': True, 'noPromptTemplates': True, 'noThemes': True})
    await loader.reload()
    model = next(iter(get_models('openai')))
    auth = AuthStorage.inMemory()
    auth.setRuntimeApiKey(model.provider, 'deterministic-fixture')
    result = await create_agent_session({
        'cwd': str(workspace), 'agentDir': str(prompt_home / 'agent'), 'model': model, 'authStorage': auth,
        'resourceLoader': loader,
        'settingsManager': SettingsManager.inMemory({'compaction': {'enabled': False}, 'retry': {'enabled': False}}),
        'sessionManager': SessionManager.create(str(workspace), str(prompt_home / 'sessions')),
        'parts': assembly.parts, 'customTools': assembly.custom_tools})
    session = result['session']
    session.research_host = True
    replies = [
        [{'type': 'toolCall', 'id': 'recruit-1', 'name': 'desktop_recruit_agent', 'arguments': {
            'name': 'archive-specialist', 'responsibility': 'Archive provenance',
            'goal': 'Establish reliable sources',
            'instructions': 'Cite page evidence, report uncertainties, message peers'}}],
        [{'type': 'text', 'text': 'Team recruited; native planner owns the handoff.'}],
        [{'type': 'toolCall', 'id': 'plan-clarify', 'name': 'misaka_research_assign', 'arguments': {
            'status': 'clarify', 'plan_markdown': 'Original question: compare archives. Goal: provenance.',
            'tasks': [], 'clarifying_questions': ['Which century?']}}],
        [{'type': 'text', 'text': 'Which century should the archive comparison cover?'}],
    ]
    observed = []

    def stream(actual_model, context, options=None):
        observed.append(context)
        content = replies.pop(0) if replies else [{'type': 'text', 'text': 'Stop recorded; the run is winding down.'}]
        reply = AssistantMessage(content=content, api=model.api, provider=model.provider, model=model.id,
                                 stopReason='toolUse' if content[0]['type'] == 'toolCall' else 'stop', timestamp=1,
                                 usage={'input': 1, 'output': 1, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 2,
                                        'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0}})
        out = AssistantMessageEventStream()
        out.push(DoneEvent(reason=reply.stopReason, message=reply))
        out.end(reply)
        return out

    session.agent.streamFn = stream
    controller = DesktopResearchController(session, lambda payload: None).attach()
    await session.bindExtensions({'mode': 'json'})
    con = controller.scope.native.module('misaka.core.research.wiring.research')._con()
    try:
        started = await controller.send_message({'sessionId': session.sessionId, 'requestId': 'start-input',
                                                 'text': 'Compare the archival evidence',
                                                 'limits': {'max_depth': 0, 'max_nodes': 1}}, con)
        assert started['mode'] == 'start'
        deadline = asyncio.get_running_loop().time() + 30
        while not runs.listing(con) and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(.05)
        run = runs.listing(con)[0]
        seen = await _settle(runs, con, run['id'], 'waiting_input', 30)
        assert seen[-1] == 'waiting_input', seen

        stopped = await controller.send_message({'sessionId': session.sessionId, 'requestId': 'stop-input',
                                                 'runId': run['id'], 'text': f"/research stop {run['id']}"}, con)
        assert stopped['mode'] == 'stop' and stopped['runId'] == run['id']
        seen = await _settle(runs, con, run['id'], 'stopped', 30)
        assert seen[-1] == 'stopped', (seen, dict(runs.get(con, run['id'])))
    finally:
        await controller.close()
        await session.moments.session_shutdown({'type': 'session_shutdown', 'reason': 'test'})
        session.dispose()
