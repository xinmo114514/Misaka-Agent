"""A stop taken while the desktop root waits for input must settle the run, not strand it."""
import asyncio
import hashlib

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
    from misaka.ai.auth.types import ApiKeyCredential
    from misaka.ai.providers.openai_models import OPENAI_MODELS
    from misaka.ai.types import AssistantMessage, DoneEvent
    from misaka.ai.utils.event_stream import AssistantMessageEventStream
    from misaka.core import wiring
    from misaka.core.auth_storage import AuthStorage
    from misaka.core.model_runtime import ModelRuntime
    from misaka.core.research import runs
    from misaka.core.resource_loader import DefaultResourceLoader
    from misaka.core.sdk import createAgentSession as create_agent_session
    from misaka.core.session_manager import SessionManager
    from misaka.core.settings_manager import SettingsManager
    from misaka.desktop_research.runtime import DesktopResearchController

    workspace = prompt_home / 'workspace'
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

    session.agent.streamFunction = stream
    from misaka.config.product import current_config
    controller = DesktopResearchController(session, lambda payload: None,
        {**current_config(), 'lo_model': f'{model.provider}/{model.id}'}).attach()
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


async def test_reopened_original_session_settles_orphaned_stop_without_model_turn(prompt_home):  # noqa: F811
    """Reopen a persisted stopping run; terminal card evidence survives its partial report."""
    from misaka.ai.auth.types import ApiKeyCredential
    from misaka.ai.providers.openai_models import OPENAI_MODELS
    from misaka.core import wiring
    from misaka.core.auth_storage import AuthStorage
    from misaka.core.model_runtime import ModelRuntime
    from misaka.core.platform import cards, tasks
    from misaka.core.research import runs
    from misaka.core.resource_loader import DefaultResourceLoader
    from misaka.core.sdk import createAgentSession as create_agent_session
    from misaka.core.session_manager import SessionManager
    from misaka.core.settings_manager import SettingsManager
    from misaka.desktop_research.runtime import DesktopResearchController

    workspace = prompt_home / 'workspace'
    workspace.mkdir()
    manager = SessionManager.create(str(workspace), str(prompt_home / 'sessions'))
    manager.appendCustomEntry('persisted-fixture', {'run': 'stopping'})
    manager.rewrite_file()
    original_file, original_id = manager.sessionFile, manager.sessionId
    reopened = SessionManager.open(original_file)
    assert reopened.sessionId == original_id

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
        'sessionManager': reopened, 'parts': assembly.parts, 'customTools': assembly.custom_tools})
    session = result['session']
    session.research_host = True
    calls = []

    def no_model(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError('A persisted stop must not enter a provider window')

    session.agent.streamFunction = no_model
    from misaka.config.product import current_config
    controller = DesktopResearchController(session, lambda payload: None,
        {**current_config(), 'lo_model': f'{model.provider}/{model.id}'}).attach()
    await session.bindExtensions({'mode': 'json'})
    con = controller.scope.native.module('misaka.core.research.wiring.research')._con()
    try:
        run = runs.create(con, workspace=str(workspace), question='Compare preserved outputs',
                          origin_session=original_id)
        root = runs.root(con, run['id'])
        runs.set_state(con, run['id'], status='stopping', phase='waiting_input', root_session=original_file)
        runs.request_stop(con, run['id'])
        completed = cards.create(con, str(workspace), 'Completed evidence', 'Preserved result', '10032')
        failed = cards.create(con, str(workspace), 'Failed evidence', 'Preserved failure', '10033')
        runs.link_task(con, run['id'], completed, kind='research', node=root, local_id='success')
        runs.link_task(con, run['id'], failed, kind='research', node=root, local_id='failure')
        con.execute("UPDATE tasks SET status='done',generation=2 WHERE id=?", (completed,))
        con.execute("UPDATE tasks SET status='failed',generation=3,last_failure_error=? WHERE id=?",
                    ('source unavailable', failed))
        tasks.add_event(con, completed, 'research_v2_settled', {'submitted_event': None}, generation=2)
        evidence = workspace / 'successful-evidence.md'
        evidence.write_text('# Preserved evidence\n', encoding='utf-8')
        artifact_id, _ = runs.register_file(con, run['id'], 'research', 'Completed evidence', str(evidence),
            sha256=hashlib.sha256(evidence.read_bytes()).hexdigest(), task_id=completed, branch_id=root['id'])

        ack = await controller.send_message({'sessionId': original_id, 'requestId': 'fresh-stop-after-reopen',
            'runId': run['id'], 'text': f"/research stop {run['id']}"}, con)
        assert ack['mode'] == 'stop' and ack['requestId'] == 'fresh-stop-after-reopen'
        seen = await _settle(runs, con, run['id'], 'stopped', 30)
        assert seen[-1] == 'stopped', (seen, dict(runs.get(con, run['id'])))
        deadline = asyncio.get_running_loop().time() + 10
        while runs.get(con, run['id'])['driver_lock'] is not None and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(.05)
        current = runs.get(con, run['id'])
        assert current['driver_lock'] is None and current['driver_expires'] is None
        assert [(t['id'], t['status'], t['generation']) for t in runs.tasks(con, run['id'])] == [
            (completed, 'done', 2), (failed, 'failed', 3)]
        assert tasks.get(con, failed)['last_failure_error'] == 'source unavailable'
        assert runs.artifact(con, artifact_id)['path'] == str(evidence.resolve())
        assert evidence.read_text(encoding='utf-8') == '# Preserved evidence\n'
        partial = runs.artifact_text(runs.artifact(con, current['final_artifact']))
        assert 'Completed evidence' in partial and 'successful-evidence.md' in partial
        assert calls == []
    finally:
        await controller.close()
        await session.moments.session_shutdown({'type': 'session_shutdown', 'reason': 'test'})
        session.dispose()
