"""Desktop adapters execute native mechanics without editing their shared modules."""
import asyncio
import sys
from types import SimpleNamespace

import pytest


def test_private_native_facade_preserves_original_objects():
    import misaka.core.research.node as native
    from misaka.config import product
    from misaka.desktop_research.native_scope import NativeScope

    original = native.ProcessSpawner
    original_cfg = product.current_config
    fake = type("PrivateSpawner", (original,), {})
    scope = NativeScope({"misaka.core.research.node": {"ProcessSpawner": fake}})
    facade = scope.module("misaka.core.research.node")
    assert facade.ProcessSpawner is fake
    assert native.ProcessSpawner is original
    assert product.current_config is original_cfg
    assert facade.main_card.__code__ is native.main_card.__code__


def test_desktop_child_argv_rewrites_every_native_lane():
    from misaka.desktop_research.runtime import desktop_child_argv
    policy = {"provider": "openai", "modelId": "gpt-fixture", "epoch": 3}
    inputs = [
        [sys.executable, "-m", "misaka.cli.research_node", "--run-card", "t1"],
        [sys.executable, "-m", "misaka", "research", "--node", "r1", "n1", "--runner-key", "k1"],
        [sys.executable, "-m", "misaka.cli.subagent_child", "--provider", "other", "--model", "other/model"],
    ]
    for argv in inputs:
        out = desktop_child_argv(argv, "POLICY", policy)
        assert out[:3] == [sys.executable, "-m", "misaka.desktop_research.worker_entry"]
        assert out[3:7] == ["--policy", "POLICY", "--epoch", "3"]
        assert "--provider" in out and "--model" in out
        assert "gpt-fixture" in out
        assert "other/model" not in out


async def test_exact_binding_stream_holds_barrier_through_stream_completion(tmp_path):
    from misaka.desktop_research.model_policy import DesktopTeamModelPolicy
    from misaka.desktop_research.runtime import install_model_binding
    policy = DesktopTeamModelPolicy(tmp_path / "policy.json", "openai", "pinned")
    selected = SimpleNamespace(provider="openai", id="pinned")
    wrong = SimpleNamespace(provider="other", id="override")
    calls = []

    class Registry:
        def find(self, provider, model):
            return selected if (provider, model) == (selected.provider, selected.id) else None
        async def checkConfiguredAuth(self, model):
            return True

    class Stream:
        def __aiter__(self):
            return self.events()
        async def events(self):
            yield "start"
            yield "done"
        async def result(self):
            return "result"

    def inner(model, context, options):
        calls.append((model.provider, model.id))
        return Stream()

    async def set_model(model, persist=False):
        assert persist is False
        session.model = model
        session.agent.state.model = model

    session = SimpleNamespace(model=wrong, modelRegistry=Registry(),
        agent=SimpleNamespace(streamFn=inner,state=SimpleNamespace(model=wrong)), setModel=set_model)
    install_model_binding(session, policy, "root")
    stream = await session.agent.streamFn(wrong, {}, {})
    assert calls == [("openai", "pinned")]
    assert session.model is selected
    assert len(__import__("json").loads(policy.path.read_text())["requests"]) == 1
    assert [event async for event in stream] == ["start", "done"]
    assert len(__import__("json").loads(policy.path.read_text())["requests"]) == 0


async def test_recruitment_tool_creates_model_chosen_native_roster_role(tmp_path):
    from misaka.config.product import current_config
    from misaka.core.research.planner import sister_catalog
    from misaka.desktop_research.runtime import DesktopExecutionScope
    from misaka.desktop_research.team import DesktopResearchTeam
    from misaka.desktop_research.tools import desktop_team_tools
    team = DesktopResearchTeam(tmp_path / 'session', tmp_path / 'shared', 'openai', 'fixture')
    scope = DesktopExecutionScope(team, current_config())
    events = []
    async def recruit(**arguments):
        member = team.recruit(**arguments)
        scope.refresh_catalog()
        events.append(member)
        return member
    controller = SimpleNamespace(recruit=recruit, team=team)
    tools = desktop_team_tools(controller)
    tool = next(t for t in tools if t.name == 'desktop_recruit_agent')
    result = await tool.execute('recruit-1', {'name':'archival-linguist', 'responsibility':'Compare source languages',
        'goal':'Resolve translation disputes', 'instructions':'Cite source pages and message peers about contradictions'}, None, None, None)
    assert result['details']['member']['name'] == 'archival-linguist'
    assert [row['id'] for row in sister_catalog(str(team.profile_root))] == ['archival-linguist']
    assert team.snapshot()['team']['members'][0]['status'] == 'ready'
    assert len(events) == 1


def test_execution_scope_injects_desktop_children_without_native_namespace_leaks(tmp_path):
    from misaka.config.product import current_config
    from misaka.core.research import commands, node, planner, workflow
    from misaka.core.wiring import SessionSpec, assemble
    from misaka.desktop_research.runtime import DesktopExecutionScope
    from misaka.desktop_research.team import DesktopResearchTeam
    before_cfg = current_config()
    before_roster = planner.sister_catalog()
    original_spawner, original_runner, original_run = node.ProcessSpawner, node.HeadlessRunner, workflow.run
    team = DesktopResearchTeam(tmp_path / 'session', tmp_path / 'shared', 'openai', 'fixture')
    scope = DesktopExecutionScope(team, before_cfg)
    view = scope.native.module('misaka.core.research.node')
    runner = view.HeadlessRunner(None, scope.current_config())
    assert isinstance(runner, node.HeadlessRunner)
    assert type(runner._processes) is view.ProcessSpawner
    adapted = scope.native.module('misaka.core.research.workflow').run
    assert adapted.__code__ is workflow.run.__code__
    assert scope.native.module('misaka.core.research.planner').commands is commands
    assert scope.native.module('misaka.core.research.planner').validate_plan is planner.validate_plan
    assert node.ProcessSpawner is original_spawner
    assert node.HeadlessRunner is original_runner
    assert workflow.run is original_run
    assert current_config() == before_cfg
    assert planner.sister_catalog() == before_roster
    normal = assemble(SessionSpec(profile_dir=str(tmp_path/'profiles/last_order'),role='last_order',workspace=str(tmp_path),kind='bare'))
    assert normal.spec.research_host is False

def test_private_scope_imported_cfg_and_functions_use_local_dependencies(tmp_path):
    from misaka.config.product import current_config
    from misaka.desktop_research.runtime import DesktopExecutionScope
    from misaka.desktop_research.team import DesktopResearchTeam
    team = DesktopResearchTeam(tmp_path / 'session', tmp_path / 'shared', 'openai', 'fixture')
    scope = DesktopExecutionScope(team, {**current_config(), 'db': str(tmp_path/'isolated.db')})
    native = scope.native.module('misaka.core.research.wiring.research')
    assert native._cfg()['profiles_root'] == str(team.profile_root)
    assert native.CFG['db'] == str(tmp_path/'isolated.db')
    scope.native.module('misaka.core.research.node')._run.__globals__['CFG'] == native.CFG


def test_worker_bootstrap_validates_argv_pair_and_epoch(tmp_path):
    from misaka.desktop_research.model_policy import DesktopTeamModelPolicy
    from misaka.desktop_research.worker_entry import (
        parse_worker_args,
        validate_worker_binding,
    )
    policy = DesktopTeamModelPolicy(tmp_path/'policy.json', 'openai', 'fixture')
    args = parse_worker_args(['--policy', str(policy.path), '--epoch', '0', '--provider','openai',
        '--model','fixture','--lane','agent','--','--provider','override','--model','override/model'])
    assert validate_worker_binding(args, policy)['modelId'] == 'fixture'
    args.model = 'different'
    with pytest.raises(ValueError, match='pair'):
        validate_worker_binding(args, policy)
    args.model = 'fixture'
    args.epoch = 100
    with pytest.raises(ValueError, match='epoch'):
        validate_worker_binding(args, policy)

from tests.test_prompt_assembly_integration import (
    prompt_home,  # noqa: F401 - fixture
)


async def test_real_original_agent_recruits_roles_before_native_planner(prompt_home):  # noqa: F811
    """Actual AgentSession+native ingress+native workflow+phase tool; no provider spend."""
    from misaka.ai.models import get_models
    from misaka.ai.types import AssistantMessage, DoneEvent
    from misaka.ai.utils.event_stream import AssistantMessageEventStream
    from misaka.core import wiring
    from misaka.core.auth_storage import AuthStorage
    from misaka.core.research import runs
    from misaka.core.research.wiring.research import ResearchPart
    from misaka.core.resource_loader import DefaultResourceLoader
    from misaka.core.sdk import create_agent_session
    from misaka.core.session_manager import SessionManager
    from misaka.core.settings_manager import SettingsManager
    from misaka.desktop_research.runtime import DesktopResearchController
    workspace = prompt_home / 'workspace'
    workspace.mkdir()
    _, assembly, _ = wiring.role_session_setup(str(prompt_home/'profiles/last_order'), str(workspace),
        research_context=True, research_host=True)
    loader = DefaultResourceLoader({'cwd':str(workspace),'agentDir':str(prompt_home/'agent'),
        'noExtensions':True,'noPromptTemplates':True,'noThemes':True})
    await loader.reload()
    model = next(iter(get_models('openai')))
    auth = AuthStorage.inMemory()
    auth.setRuntimeApiKey(model.provider, 'deterministic-fixture')
    result = await create_agent_session({'cwd':str(workspace),'agentDir':str(prompt_home/'agent'),
        'model':model,'authStorage':auth,'resourceLoader':loader,
        'settingsManager':SettingsManager.inMemory({'compaction':{'enabled':False},'retry':{'enabled':False}}),
        'sessionManager':SessionManager.create(str(workspace),str(prompt_home/'sessions')),
        'parts':assembly.parts,'customTools':assembly.custom_tools})
    session = result['session']
    session.research_host = True
    observed = []
    replies = [
        [{'type':'toolCall','id':'recruit-1','name':'desktop_recruit_agent','arguments':{
          'name':'archive-specialist','responsibility':'Archive provenance','goal':'Establish reliable sources',
          'instructions':'Cite page evidence, report uncertainties, message peers'}}],
        [{'type':'text','text':'Team recruited; native planner owns the handoff.'}],
        [{'type':'toolCall','id':'plan-clarify','name':'misaka_research_assign','arguments':{
            'status':'clarify','plan_markdown':'Original question: compare archives. Goal: provenance.',
            'tasks':[], 'clarifying_questions':['Which century?']}}],
        [{'type':'text','text':'Which century should the archive comparison cover?'}],
    ]
    def stream(actual_model, context, options=None):
        assert (actual_model.provider,actual_model.id) == (model.provider,model.id)
        observed.append(context)
        assert replies, 'Unexpected native model request'
        content = replies.pop(0)
        reply = AssistantMessage(content=content,api=model.api,provider=model.provider,model=model.id,
          stopReason='toolUse' if content[0]['type']=='toolCall' else 'stop',timestamp=1,
          usage={'input':1,'output':1,'cacheRead':0,'cacheWrite':0,'totalTokens':2,
          'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0,'total':0}})
        out = AssistantMessageEventStream()
        out.push(DoneEvent(reason=reply.stopReason,message=reply))
        out.end(reply)
        return out
    session.agent.streamFn = stream
    events = []
    controller = DesktopResearchController(session, events.append,
        config={**__import__('misaka.config.product', fromlist=['current_config']).current_config(),
                'lo_model': f'{model.provider}/{model.id}'}).attach()
    await session.bindExtensions({'mode':'json'})
    part = next(p for p in session.moments.parts if isinstance(p,ResearchPart))
    con = controller.scope.native.module('misaka.core.research.wiring.research')._con()
    try:
        ack = await controller.send_message({'sessionId':session.sessionId,'requestId':'first',
           'text':'Compare the archival evidence','limits':{'max_depth':0,'max_nodes':1}},con)
        assert ack['mode']=='start'
        from misaka.core.web import WebPart
        from misaka.core.network.wiring.network import NetworkPart
        assert type(next(p for p in session.moments.parts if isinstance(p,WebPart))) is controller.scope.native.module('misaka.core.web').WebPart
        assert type(next(p for p in session.moments.parts if isinstance(p,NetworkPart))) is controller.scope.native.module('misaka.core.network.wiring.network').NetworkPart
        assert session.extensionRunner.create_context().modelRegistry is session.modelRegistry
        async with asyncio.timeout(15):
            while not runs.listing(con) or runs.listing(con)[0]['status'] not in {'waiting_input','failed'}:
                await asyncio.sleep(.02)
        run = runs.listing(con)[0]
        assert run['status']=='waiting_input', dict(run)
        async with asyncio.timeout(5):
            while part.is_driving(run['id']):
                await asyncio.sleep(.02)
        assert len(observed)==4
        entries = session.sessionManager.buildContextEntries()
        intake = next(e for e in entries if e.get('type') == 'custom_message' and e.get('customType') == 'desktop-intake')
        assert intake['display'] is False
        assert intake['content'] == 'Compare the archival evidence'
        assert 'Desktop research team intake' in str(observed[0].messages[0].content)
        assert runs.action(con,run['id'],runs.root(con,run['id'])['id'],'plan')['payload']['status']=='clarify'
        assert [m['name'] for m in controller.snapshot()['team']['members']] == ['archive-specialist']
        assert 'archive-specialist' in str(observed[2].messages[0].content)
        assert any(e['type']=='desktop-team' for e in events)
        assert not any(p.name == 'desktop_recruit_agent' for p in wiring.tools_for(wiring.SessionSpec(
          profile_dir=str(prompt_home/'profiles/last_order'),role='last_order',workspace=str(workspace),kind='foreground')))
    finally:
        await controller.close()
        await session.moments.session_shutdown({'type':'session_shutdown','reason':'test'})
        session.dispose()


async def test_a_failed_recruitment_intake_retries_the_start_without_redelivering_it(prompt_home):  # noqa: F811
    """One requestId records one intake turn; its retry continues the start, it never re-recruits."""
    from misaka.ai.models import get_models
    from misaka.ai.types import AssistantMessage, DoneEvent
    from misaka.ai.utils.event_stream import AssistantMessageEventStream
    from misaka.core import wiring
    from misaka.core.auth_storage import AuthStorage
    from misaka.core.resource_loader import DefaultResourceLoader
    from misaka.core.sdk import create_agent_session
    from misaka.core.session_manager import SessionManager
    from misaka.core.settings_manager import SettingsManager
    from misaka.desktop_research.runtime import DesktopResearchController
    workspace = prompt_home / 'workspace'
    workspace.mkdir()
    _, assembly, _ = wiring.role_session_setup(str(prompt_home/'profiles/last_order'), str(workspace),
        research_context=True, research_host=True)
    loader = DefaultResourceLoader({'cwd':str(workspace),'agentDir':str(prompt_home/'agent'),
        'noExtensions':True,'noPromptTemplates':True,'noThemes':True})
    await loader.reload()
    model = next(iter(get_models('openai')))
    auth = AuthStorage.inMemory()
    auth.setRuntimeApiKey(model.provider, 'deterministic-fixture')
    result = await create_agent_session({'cwd':str(workspace),'agentDir':str(prompt_home/'agent'),
        'model':model,'authStorage':auth,'resourceLoader':loader,
        'settingsManager':SettingsManager.inMemory({'compaction':{'enabled':False},'retry':{'enabled':False}}),
        'sessionManager':SessionManager.create(str(workspace),str(prompt_home/'sessions')),
        'parts':assembly.parts,'customTools':assembly.custom_tools})
    session = result['session']
    session.research_host = True
    observed = []
    replies = [
        [{'type':'toolCall','id':'recruit-1','name':'desktop_recruit_agent','arguments':{
          'name':'archive-specialist','responsibility':'Archive provenance','goal':'Establish reliable sources',
          'instructions':'Cite page evidence, report uncertainties, message peers'}}],
        [{'type':'text','text':'Team recruited; native planner owns the handoff.'}],
        [{'type':'toolCall','id':'plan-clarify','name':'misaka_research_assign','arguments':{
            'status':'clarify','plan_markdown':'Original question: compare archives. Goal: provenance.',
            'tasks':[], 'clarifying_questions':['Which century?']}}],
        [{'type':'text','text':'Which century should the archive comparison cover?'}],
    ]
    transient = [True]

    def stream(actual_model, context, options=None):
        observed.append(context)
        if transient[0]:
            transient[0] = False
            raise RuntimeError('fixture transient failure')
        assert replies, 'Unexpected native model request'
        content = replies.pop(0)
        reply = AssistantMessage(content=content,api=model.api,provider=model.provider,model=model.id,
          stopReason='toolUse' if content[0]['type']=='toolCall' else 'stop',timestamp=1,
          usage={'input':1,'output':1,'cacheRead':0,'cacheWrite':0,'totalTokens':2,
          'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0,'total':0}})
        out = AssistantMessageEventStream()
        out.push(DoneEvent(reason=reply.stopReason,message=reply))
        out.end(reply)
        return out
    session.agent.streamFn = stream
    controller = DesktopResearchController(session, lambda payload: None,
        config={**__import__('misaka.config.product', fromlist=['current_config']).current_config(),
                'lo_model': f'{model.provider}/{model.id}'}).attach()
    await session.bindExtensions({'mode':'json'})
    con = controller.scope.native.module('misaka.core.research.wiring.research')._con()
    payload = {'sessionId':session.sessionId,'requestId':'same-start','text':'Compare the archival evidence',
               'limits':{'max_depth':0,'max_nodes':1}}
    try:
        from misaka.core.research import submissions
        with pytest.raises(submissions.ResearchInputError) as caught:
            await controller.send_message(dict(payload), con)
        assert caught.value.errorCode == 'RESEARCH_RECRUITMENT_MODEL_ERROR'
        assert caught.value.errorDetails['message'] == 'fixture transient failure'
        ack = await controller.send_message(dict(payload), con)
        assert ack['accepted'] is True and ack['mode'] == 'start'
        intakes = [entry for entry in session.sessionManager.buildContextEntries()
                   if entry.get('type') == 'custom_message' and entry.get('customType') == 'desktop-intake'
                   and (entry.get('details') or {}).get('requestId') == 'same-start']
        assert len(intakes) == 1
    finally:
        await controller.close()
        await session.moments.session_shutdown({'type':'session_shutdown','reason':'test'})
        session.dispose()


def test_scoped_subagent_part_uses_scoped_manager_not_native_manager(tmp_path):
    from misaka.config.product import current_config
    from misaka.core.subagent.runtime import RoleContext, SubagentManager
    from misaka.desktop_research.runtime import DesktopExecutionScope
    from misaka.desktop_research.team import DesktopResearchTeam
    team = DesktopResearchTeam(tmp_path/'session',tmp_path/'shared','openai','fixture')
    scope = DesktopExecutionScope(team,current_config())
    part = scope.native.module('misaka.core.subagent.extension').SubagentPart(
        RoleContext(role='sisters/archive',profile_dir='',workspace=str(tmp_path),mcp_role='sisters/archive'),True)
    assert type(part.manager) is scope.SubagentManager
    assert isinstance(part.manager,SubagentManager)

from tests.test_agent_model_runtime import local_models  # noqa: F401 - fixture
from tests.test_subagent_native_startup import isolated  # noqa: F401 - fixture


async def test_real_native_agent_child_uses_desktop_bootstrap_and_exact_team_pair(local_models, monkeypatch):  # noqa: F811 - pytest fixture import
    import json

    from misaka.config.product import current_config
    from misaka.core.subagent.agents import AgentDefinition
    from misaka.core.subagent.runtime import RoleContext
    from misaka.desktop_research.runtime import DesktopExecutionScope
    from misaka.desktop_research.team import DesktopResearchTeam
    from tests.test_agent_model_runtime import opened
    from tests.test_subagent_native_startup import _complete_native_turn
    root, requests = local_models
    monkeypatch.setenv('MISAKA_SUBAGENT_MODEL', 'fixture-b/different')
    team = DesktopResearchTeam(root/'team-session',root/'profiles/sisters','fixture-lo','shared')
    scope = DesktopExecutionScope(team,current_config())
    async with opened(root,'sisters/10032','foreground') as (_, session):
        scope.bind_session(session)
        manager = scope.SubagentManager(session,RoleContext(role='sisters/10032',mcp_role='sisters/10032',
            workspace=str(root/'workspace'),profile_dir=str(root/'profiles/sisters/10032')))
        try:
            task = await manager.create_task(definition=AgentDefinition(name='fixture-helper',description='Fixture helper',
                prompt='Evidence-minded test helper',source='inline',model='fixture-b/different'),
                description='Desktop child binding',prompt='CHILD_MODEL_MARKER',model='fixture-global/global',
                background=False,name=None,isolation=None,cwd=None,tool_call_id='',
                context=session.extensionRunner.create_context())
            assert (task.model_provider,task.model_id)==('fixture-lo','shared')
            failures=[]
            run_turn=manager._run_turn
            async def traced_turn(*args,**kwargs):
                import traceback
                try:
                    return await run_turn(*args,**kwargs)
                except BaseException:
                    failures.append(traceback.format_exc())
                    raise
            manager._run_turn=traced_turn
            # Match the native startup contract: up to 45s before the real model
            # request, then the unchanged 20s response/teardown budget.
            await _complete_native_turn(manager._drive(task, 'CHILD_MODEL_MARKER', notify=False), task, requests)
            assert task.status=='completed',(task.error,list(task.stderr),failures)
            assert 'Loopback fixture answer.' in str(task.result)
            assert [(provider,payload['model']) for provider,payload in requests] == [('fixture-lo','shared')]
            team.model_policy.snapshot(role='last_order')  # reconcile this role's ended native workers
            state = json.loads(team.model_policy._policy('last_order').path.read_text())
            # Only root remains after the native child disposal, never a leaked worker lease.
            assert not state['requests']
            assert len(state['executors'])==1
        finally:
            await manager.close()
            await scope.release_session(session)




async def test_model_switch_emits_persisted_switching_and_failed_state(tmp_path):
    from misaka.desktop_research.runtime import DesktopResearchController
    from misaka.desktop_research.team import DesktopResearchTeam
    team = DesktopResearchTeam(tmp_path/'session',tmp_path/'shared','openai','fixture')
    controller = DesktopResearchController.__new__(DesktopResearchController)
    controller.team = team
    controller.emit = lambda event: events.append(event)
    controller._event_jobs = set()
    events = []
    async def fail_prepare(*args):
        raise ValueError('deterministic provider failure')
    team.model_policy.register_executor('root',fail_prepare)
    controller._subscribe_model_events()
    result = await controller.set_team_model('other','replacement')
    await asyncio.gather(*tuple(controller._event_jobs))
    assert result['modelBinding']['state']=='failed'
    assert [e['modelBinding']['state'] for e in events]==['switching','failed']
    assert events[0]['modelBinding']['target']=={'provider':'other','modelId':'replacement'}
    assert 'deterministic provider failure' in events[1]['modelBinding']['error']
    controller._unsubscribe_model_events()


def test_scoped_peer_routing_catalog_uses_only_task_local_roster(tmp_path):
    from misaka.config.product import current_config
    from misaka.core.network import messages
    from misaka.desktop_research.runtime import DesktopExecutionScope
    from misaka.desktop_research.team import DesktopResearchTeam
    shared = tmp_path/'shared'
    (shared/'unrelated').mkdir(parents=True)
    team = DesktopResearchTeam(tmp_path/'session',shared,'openai','fixture')
    team.recruit('evidence-peer','Provenance','Verify sources','Message peer about discrepancies')
    scope = DesktopExecutionScope(team,current_config())
    view = scope.native.module('misaka.core.network.messages')
    assert view.sisters()=={'evidence-peer'}
    assert messages.sisters()!=view.sisters()

async def test_request_pauses_on_failed_boundary_until_explicit_cancel(tmp_path):
    from misaka.desktop_research.model_policy import DesktopTeamModelPolicy
    from misaka.desktop_research.runtime import install_model_binding
    policy = DesktopTeamModelPolicy(tmp_path/'policy.json','fixture','old')
    old = SimpleNamespace(provider='fixture',id='old')
    session = SimpleNamespace(model=old,modelRegistry=SimpleNamespace(
       find=lambda p,m: old if (p,m)==('fixture','old') else None,
       checkConfiguredAuth=lambda model: asyncio.sleep(0,result=True)),
       agent=SimpleNamespace(state=SimpleNamespace(model=old),streamFn=lambda *args: None),
       setModel=lambda *args,**kwargs: asyncio.sleep(0))
    install_model_binding(session,policy,'root')
    failed = await policy.switch('missing','model')
    assert failed['state']=='failed'
    request = asyncio.create_task(session.agent.streamFn(old,{},{}))
    await asyncio.sleep(.03)
    assert not request.done()
    await policy.cancel_switch()
    stream = await asyncio.wait_for(request,1)
    await stream.aclose()


def test_recorded_launch_may_join_new_epoch_but_still_validates_argv_pair(tmp_path):
    from misaka.config.product import current_config
    from misaka.desktop_research.runtime import (
        DesktopExecutionScope,
        desktop_child_argv,
    )
    from misaka.desktop_research.team import DesktopResearchTeam
    from misaka.desktop_research.worker_entry import (
        parse_worker_args,
        validate_worker_binding,
    )
    team = DesktopResearchTeam(tmp_path/'session',tmp_path/'shared','fixture','old')
    scope = DesktopExecutionScope(team,current_config())
    binding = team.model_policy.guard_model()
    launch_id = scope.record_launch(binding)
    argv = desktop_child_argv([sys.executable,'-m','misaka.cli.subagent_child'],team.model_policy.path,
                             binding,launch_id=launch_id)
    args = parse_worker_args(argv[3:])
    asyncio.run(team.model_policy.switch('fixture','new'))
    assert validate_worker_binding(args,team.model_policy)['modelId']=='new'
    args.model='wrong'
    with pytest.raises(ValueError,match='pair'):
        validate_worker_binding(args,team.model_policy)

async def test_request_binding_rebuilds_native_auth_after_model_override(tmp_path):
    from misaka.desktop_research.model_policy import DesktopTeamModelPolicy
    from misaka.desktop_research.runtime import install_model_binding
    policy = DesktopTeamModelPolicy(tmp_path/'policy.json','fixture','pinned')
    pinned = SimpleNamespace(provider='fixture',id='pinned')
    actual = []
    resolution = SimpleNamespace(auth=SimpleNamespace(apiKey='RIGHT_KEY',headers={'authorization':'Bearer RIGHT'},baseUrl=None),
        env={'RIGHT_ENV':'right'})
    async def get_auth(model,overrides):
        assert model is pinned
        return resolution
    session = SimpleNamespace(model=pinned,modelRegistry=SimpleNamespace(
       find=lambda p,m:pinned,checkConfiguredAuth=lambda m:asyncio.sleep(0,result=True),getAuth=get_auth),
       agent=SimpleNamespace(state=SimpleNamespace(model=pinned),streamFn=lambda m,c,o:actual.append(o)),
       setModel=lambda *a,**kw:asyncio.sleep(0))
    install_model_binding(session,policy,'root')
    out = await session.agent.streamFn(SimpleNamespace(provider='wrong',id='wrong'),{},
        {'apiKey':'WRONG_KEY','headers':{'authorization':'Bearer WRONG'},'env':{'WRONG_ENV':'wrong'},'maxTokens':321})
    await out.aclose()
    assert actual[0]['apiKey']=='RIGHT_KEY'
    assert actual[0]['headers']=={'authorization':'Bearer RIGHT'}
    assert actual[0]['env']=={'RIGHT_ENV':'right'}
    assert actual[0]['maxTokens']==321


async def test_request_binding_diagnostics_use_stream_effective_network_env(tmp_path):
    from misaka.desktop_research.model_policy import DesktopTeamModelPolicy
    from misaka.desktop_research.runtime import install_model_binding

    policy = DesktopTeamModelPolicy(tmp_path / 'policy.json', 'fixture', 'pinned')
    pinned = SimpleNamespace(
        provider='fixture', id='pinned', api='fixture', baseUrl='https://model.test/v1'
    )
    resolution = SimpleNamespace(
        auth=SimpleNamespace(apiKey='KEY', headers={}, baseUrl=None),
        env={'HTTPS_PROXY': 'http://credential.test:3128'},
    )

    expected_env = {
        'https_proxy': 'http://application.test:43129',
        'HTTPS_PROXY': 'http://application.test:43129',
        'no_proxy': '',
    }

    class Stream:
        def __init__(self):
            self.effectiveNetworkEnv = dict(expected_env)

        async def aclose(self):
            return None

    async def get_auth(_model, _overrides):
        return resolution

    session = SimpleNamespace(
        model=pinned,
        modelRegistry=SimpleNamespace(
            find=lambda _provider, _model: pinned,
            checkConfiguredAuth=lambda _model: asyncio.sleep(0, result=True),
            getAuth=get_auth,
        ),
        agent=SimpleNamespace(
            state=SimpleNamespace(model=pinned),
            streamFn=lambda _model, _context, _options: Stream(),
        ),
        setModel=lambda *args, **kwargs: asyncio.sleep(0),
    )
    install_model_binding(session, policy, 'root')
    stream = await session.agent.streamFn(pinned, {}, {})
    try:
        assert session._desktop_network_context['env'] == expected_env
    finally:
        await stream.aclose()

async def test_provider_finalizer_drains_before_ticket_release(tmp_path):
    import json

    from misaka.ai.types import AssistantMessage, DoneEvent
    from misaka.ai.utils.event_stream import (
        AssistantMessageEventStream,
        spawn_stream_task,
    )
    from misaka.desktop_research.model_policy import DesktopTeamModelPolicy
    from misaka.desktop_research.runtime import install_model_binding
    policy = DesktopTeamModelPolicy(tmp_path/'policy.json','fixture','old')
    model = SimpleNamespace(provider='fixture',id='old')
    output = AssistantMessageEventStream()
    finalizer_entered, finalizer_release = asyncio.Event(),asyncio.Event()
    async def producer():
        reply=AssistantMessage(content=[{'type':'text','text':'Done'}],api='anthropic-messages',provider='fixture',
            model='old',stopReason='stop',timestamp=1,usage={'input':1,'output':1,'totalTokens':2,
            'cacheRead':0,'cacheWrite':0,'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0,'total':0}})
        output.push(DoneEvent(reason='stop',message=reply))
        output.end(reply)
        finalizer_entered.set()
        await finalizer_release.wait()
    spawn_stream_task(producer(),stream=output)
    session = SimpleNamespace(model=model,modelRegistry=SimpleNamespace(find=lambda p,m:model,
        checkConfiguredAuth=lambda m:asyncio.sleep(0,result=True)),
        agent=SimpleNamespace(state=SimpleNamespace(model=model),streamFn=lambda *a:output),
        setModel=lambda *a,**kw:asyncio.sleep(0))
    install_model_binding(session,policy,'root')
    stream=await session.agent.streamFn(model,{},{})
    terminal=asyncio.create_task(stream.result())
    await finalizer_entered.wait()
    await asyncio.sleep(.01)
    try:
        assert not terminal.done()
        assert len(json.loads(policy.path.read_text())['requests'])==1
    finally:
        finalizer_release.set()
        await terminal
    assert not json.loads(policy.path.read_text())['requests']

async def test_deferred_spawn_stop_drains_inflight_popen_thread(tmp_path, monkeypatch):
    import asyncio, threading
    from misaka.desktop_research.runtime import DeferredDesktopProcess,DesktopExecutionScope
    from misaka.desktop_research.team import DesktopResearchTeam
    from misaka.config.product import current_config
    from misaka.core.research.node import ProcessSpawner
    team=DesktopResearchTeam(tmp_path/'session',tmp_path/'shared','fixture','old')
    scope=DesktopExecutionScope(team,current_config())
    entered, release = threading.Event(), threading.Event()
    stopped=[]
    process=SimpleNamespace(pid=123,poll=lambda:None)
    def blocked_spawn(*args,**kwargs):
        entered.set()
        release.wait(3)
        return process
    monkeypatch.setattr(ProcessSpawner,'spawn',blocked_spawn)
    monkeypatch.setattr(ProcessSpawner,'stop',lambda self,p:stopped.append(p))
    spawner=scope.native.module('misaka.core.research.node').ProcessSpawner()
    handle=DeferredDesktopProcess(scope,spawner,[sys.executable,'-m','misaka.cli.research_node','--run-card','t1'],
        {'cwd':str(tmp_path)},asyncio.get_running_loop())
    async with asyncio.timeout(3):
        while not entered.is_set():
            await asyncio.sleep(.01)
    handle.stop(spawner)
    release.set()
    async with asyncio.timeout(3):
        while not stopped:
            await asyncio.sleep(.01)
    assert stopped==[process]


def test_team_snapshot_derives_formal_card_lifecycle_from_owned_native_run(tmp_path):
    from misaka.desktop_research.runtime import DesktopResearchController
    from misaka.desktop_research.team import DesktopResearchTeam
    from misaka.core.platform import tasks
    from misaka.core.research import runs
    from misaka.core.session_manager import SessionManager
    con=tasks.connect(str(tmp_path/'board.db'))
    runs.init(con)
    manager=SessionManager.inMemory(str(tmp_path))
    session=SimpleNamespace(sessionManager=manager,sessionId=manager.getSessionId())
    team=DesktopResearchTeam(tmp_path/'session',tmp_path/'shared','fixture','old')
    member=team.recruit('source-critic','Critic','Check evidence','Review provenance')
    team.update_member(member['id'],status='ready',instances=['native-helper-instance'])
    controller=DesktopResearchController.__new__(DesktopResearchController)
    controller.team,controller.session,controller._research_con=team,session,con
    run=runs.create(con,workspace=str(tmp_path),question='Evidence',origin_session=session.sessionId)
    node=runs.root(con,run['id'])
    tid=tasks.create_task(con,'Native evidence card',assignee=member['name'],workspace=str(tmp_path))
    runs.link_task(con,run['id'],tid,kind='research',node=node,local_id='sources')
    con.execute("UPDATE tasks SET status='running',session_file='native-session.jsonl' WHERE id=?",(tid,))
    snapshot=controller.snapshot()['team']['members'][0]
    assert snapshot['status']=='running'
    assert snapshot['taskIds']==[tid]
    assert 'native-helper-instance' in snapshot['instances']
    con.execute("UPDATE tasks SET status='done' WHERE id=?",(tid,))
    assert controller.snapshot()['team']['members'][0]['status']=='done'
    assert team.snapshot()['team']['members'][0]['taskIds']==[]  # no board projection is persisted as fake work
    con.close()

async def test_aborted_request_exits_paused_barrier_without_model_cancel(tmp_path):
    import asyncio
    from misaka.agent.agent import AbortController
    from misaka.desktop_research.runtime import wait_model_ready
    from misaka.desktop_research.model_policy import DesktopTeamModelPolicy
    policy=DesktopTeamModelPolicy(tmp_path/'policy.json','fixture','old')
    async def fail(*args):
        raise ValueError('fixture unavailable')
    policy.register_executor('root',fail)
    await policy.switch('fixture','new')
    signal=AbortController()
    waiting=asyncio.create_task(wait_model_ready(policy,signal.signal))
    await asyncio.sleep(.01)
    signal.abort()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(waiting,.5)
    assert policy.snapshot()['state']=='failed'

async def test_raw_registry_and_warmer_requests_use_same_bound_native_model(local_models):  # noqa: F811
    from tests.test_agent_model_runtime import opened
    from misaka.ai.types import Context,UserMessage
    from misaka.core.cache_warmer import CacheWarmer
    from misaka.desktop_research.runtime import install_model_binding
    from misaka.desktop_research.model_policy import DesktopTeamModelPolicy
    root,requests=local_models
    async with opened(root,'sisters/10032','foreground') as (_,session):
        original_registry=session.modelRegistry
        warmer=CacheWarmer(original_registry,session.sessionManager,lambda:'streaming')
        session._cacheWarmer=warmer
        policy=DesktopTeamModelPolicy(root/'policy.json','fixture-lo','shared')
        install_model_binding(session,policy,'root')
        wrong=original_registry.find('fixture-b','different')
        context=Context(messages=[UserMessage(content='RAW_AUX_MARKER',timestamp=1)])
        await session.modelRegistry.streamSimple(wrong,context,{'apiKey':'WRONG'}).result()
        await warmer.models.streamSimple(wrong,context,{'apiKey':'WRONG','maxTokens':1}).result()
        assert [(p,data['model']) for p,data in requests]==[('fixture-lo','shared'),('fixture-lo','shared')]
        assert original_registry.find('fixture-b','different') is not None
        assert session.modelRegistry is not original_registry

async def test_private_decorated_native_context_manager_keeps_defining_globals():
    from misaka.desktop_research.native_scope import NativeScope
    from misaka.core.platform import session
    scope=NativeScope(modules={'misaka.core.platform.session'})
    entered=False
    async with scope.module('misaka.core.platform.session')._env_window():
        entered=True
    assert entered
    assert scope.module('misaka.core.platform.session')._env_window is not session._env_window


def test_private_module_assignment_updates_cloned_function_globals_only():
    from misaka.desktop_research.native_scope import NativeScope
    from misaka.core.research import node
    scope=NativeScope(modules={'misaka.core.research.node'})
    view=scope.module('misaka.core.research.node')
    original=node.CARD_ARGV
    view.CARD_ARGV=['desktop-only']
    assert view.main_card.__globals__['CARD_ARGV']==['desktop-only']
    assert node.CARD_ARGV is original


async def test_root_scene_lists_shared_sources_separately_from_task_assignees(tmp_path):
    from misaka.config.product import current_config
    from misaka.core.network import roster
    from misaka.core.research.planner import sister_catalog
    from misaka.desktop_research.runtime import DesktopScenePart,DesktopExecutionScope
    from misaka.desktop_research.team import DesktopResearchTeam
    shared=tmp_path/'shared'
    roster.create_sister('historical-source',root=str(shared),specialty='Archive and language expertise')
    team=DesktopResearchTeam(tmp_path/'session',shared,'fixture','chosen')
    scope=DesktopExecutionScope(team,current_config())
    scene=DesktopScenePart(scope,root=True)
    scene.session=SimpleNamespace(sessionManager=SimpleNamespace(getCwd=lambda:str(tmp_path)))
    prompt=await scene.before_agent_start({'systemPrompt':'Root'},None)
    assert 'historical-source' in prompt['systemPrompt']
    assert 'borrow' in prompt['systemPrompt'].lower()
    assert sister_catalog(str(team.profile_root))==[]
    member=team.recruit('local-historian','Analyze provenance','Resolve archival uncertainty',
        'Report evidence and gaps',source_id='historical-source')
    assert [item['id'] for item in sister_catalog(str(team.profile_root))]==[member['name']]

async def test_moa_semantic_transport_is_rejected_before_any_fanout(tmp_path):
    from misaka.desktop_research.runtime import install_model_binding
    from misaka.desktop_research.model_policy import DesktopTeamModelPolicy
    virtual=SimpleNamespace(provider='moa',id='preset',api='moa')
    calls=[]
    policy=DesktopTeamModelPolicy(tmp_path/'policy.json','physical','moa-display-name')
    physical=SimpleNamespace(provider='physical',id='moa-display-name',api='openai-completions')
    models={('physical','moa-display-name'):physical,('moa','preset'):virtual}
    session=SimpleNamespace(model=physical,modelRegistry=SimpleNamespace(find=lambda p,m:models.get((p,m)),
        checkConfiguredAuth=lambda model:asyncio.sleep(0,result=True)),
        agent=SimpleNamespace(state=SimpleNamespace(model=physical),streamFn=lambda *a:calls.append(a)),
        setModel=lambda *a,**kw:asyncio.sleep(0))
    install_model_binding(session,policy,'root')
    state=await policy.switch('moa','preset')
    assert state['state']=='failed'
    assert state['effective']=={'provider':'physical','modelId':'moa-display-name'}
    assert 'heterogeneous' in state['error']
    assert not calls
    await policy.cancel_switch()
    stream=await session.agent.streamFn(virtual,{},{})
    await stream.aclose()
    assert calls[0][0] is physical  # model/display name is not blacklisted


def test_authoritative_desktop_pin_precedes_sister_task_override_validation(tmp_path):
    from misaka.config.product import current_config
    from misaka.config import profiles
    from misaka.desktop_research.runtime import DesktopExecutionScope
    from misaka.desktop_research.team import DesktopResearchTeam
    team=DesktopResearchTeam(tmp_path/'session',tmp_path/'shared','physical','selected')
    scope=DesktopExecutionScope(team,current_config())
    view=scope.native.module('misaka.config.profiles')
    assert view.explicit_model_override(str(tmp_path/'invalid-profile'),'unknown/override')=='physical/selected'
    assert profiles.explicit_model_override(str(tmp_path/'invalid-profile'),'unknown/override')=='unknown/override'
