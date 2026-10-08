"""Desktop research runtime: native workflow with task-local recruitment and model fencing."""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import time
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import ClassVar

from misaka.core.research.ingress import session_run
from misaka.utils.values import read_field

from .auxiliary import prepare_desktop_assembly
from .model_policy import ModelPolicyPaused, atomic_json
from .native_scope import NativeScope
from .team import DesktopResearchTeam

logger = logging.getLogger(__name__)
__all__ = ['DesktopExecutionScope', 'DesktopResearchController', 'prepare_desktop_assembly']


async def _maybe(value):
    return await value if inspect.isawaitable(value) else value


def pinned_flags(flags, binding):
    """Remove every model override; put the exact validated pair last."""
    flags, out, index = list(flags), [], 0
    while index < len(flags):
        flag = str(flags[index])
        if flag in {'--provider', '--model', '-m'}:
            index += 2
        elif flag.startswith(('--provider=', '--model=')):
            index += 1
        else:
            out.append(flags[index])
            index += 1
    return [*out, '--provider', binding['provider'], '--model', binding['modelId']]


def desktop_child_argv(argv, policy_path, binding, *, launch_id=None):
    argv = list(argv)
    if argv[1:3] != ['-m', 'misaka.cli.research_node'] and argv[1:3] != ['-m', 'misaka.cli.subagent_child'] and argv[1:3] != ['-m', 'misaka']:
        return argv
    module = argv[2]
    if module == 'misaka.cli.subagent_child':
        lane, args = 'agent', pinned_flags(argv[3:], binding)
    elif module == 'misaka.cli.research_node':
        lane, args = 'card', argv[3:]
    elif len(argv) > 3 and argv[3] == 'research' and '--node' in argv:
        lane, args = 'node', argv[4:]
    else:
        return argv
    return [argv[0], '-m', 'misaka.desktop_research.worker_entry', '--policy', str(policy_path),
            '--epoch', str(binding['epoch']), '--provider', binding['provider'], '--model', binding['modelId'],
            *(['--launch-id', launch_id] if launch_id else []), '--lane', lane, '--', *args]


class _BoundStream:
    def __init__(self, stream, release):
        self.stream, self.release = stream, release

    def __getattr__(self, name):
        return getattr(self.stream, name)

    def __aiter__(self):
        return self._events()

    async def _events(self):
        try:
            async for event in self.stream:
                yield event
        finally:
            await self._drain_release()

    async def result(self):
        try:
            return await _maybe(self.stream.result())
        finally:
            await self._drain_release()

    async def _drain_release(self):
        from misaka.utils.async_lifecycle import settle
        async def drain():
            try:
                settled = getattr(self.stream, 'settled', None)
                if settled:
                    await _maybe(settled())
            finally:
                await self.release()
        _value, cancelled = await settle(asyncio.create_task(drain()))
        if cancelled is not None:
            raise cancelled

    async def aclose(self):
        try:
            close = getattr(self.stream, 'aclose', None)
            if close:
                await _maybe(close())
        finally:
            await self._drain_release()


class DeferredBoundStream:
    """Native synchronous stream door with async admission beneath it."""
    def __init__(self, opening):
        self.opening = asyncio.create_task(opening)

    async def result(self):
        stream = await self.opening
        return await stream.result()

    def __aiter__(self):
        return self._events()

    async def _events(self):
        stream = await self.opening
        try:
            async for event in stream:
                yield event
        finally:
            await stream._drain_release()

    async def settled(self):
        stream = await self.opening
        await stream._drain_release()


class DesktopModelRegistry:
    """Instance-local registry facade; catalog/auth stay with the native owner."""
    def __init__(self, source, bound_stream):
        self.source, self.bound_stream = source, bound_stream

    def __getattr__(self, name):
        return getattr(self.source, name)

    def streamSimple(self, model, context, options=None):
        from misaka.ai.types import SimpleStreamOptions
        def transport(selected, content, parameters):
            return self.source.streamSimple(selected, content, SimpleStreamOptions.model_validate(parameters))
        return DeferredBoundStream(self.bound_stream(model, context, options, _transport=transport))

    def stream(self, model, context, options=None):
        from misaka.ai.types import ProviderStreamOptions
        def transport(selected, content, parameters):
            return self.source.stream(selected, content, ProviderStreamOptions.model_validate(parameters))
        return DeferredBoundStream(self.bound_stream(model, context, options, _transport=transport))

    async def complete(self, model, context, options=None):
        return await self.stream(model, context, options).result()


def install_model_binding(session, policy, executor_id):
    if getattr(session, '_desktop_model_policy', None) is policy:
        return
    inner = session.agent.streamFn
    source_registry = session.modelRegistry

    async def prepare(provider, model_id, _epoch):
        registry = source_registry
        refresh = getattr(registry, 'refresh', None)
        if refresh:
            await _maybe(refresh())
        model = registry.find(provider, model_id)
        if model is None:
            raise ValueError(f'Team model is missing from the native registry: {provider}/{model_id}')
        if read_field(model, 'api') == 'moa' or read_field(model, 'provider') == 'moa':
            raise ValueError('The selected virtual MoA provider emits heterogeneous physical model requests; strict team binding requires a native physical model.')
        if not await registry.checkConfiguredAuth(model):
            raise ValueError(f'Team model credentials are missing: {provider}/{model_id}')
        if read_field(session.model, 'provider') != provider or read_field(session.model, 'id') != model_id:
            await session.setModel(model, persist=False)
        return model

    policy.register_executor(executor_id, prepare)

    async def bound_stream(_override_model, context, options=None, *, _transport=None):
        from misaka.core.sdk import _to_dict
        request_options = _to_dict(options)
        signal = request_options.get('signal')
        while True:
            await wait_model_ready(policy, signal)
            await policy.synchronize_executor(executor_id)
            try:
                binding = policy.begin_request(executor_id)
                break
            except ModelPolicyPaused:
                # A switch raced the readiness read. Rejoin it, keeping abort
                # responsive rather than entering policy.request's blind wait.
                await asyncio.sleep(.01)
        released = False

        async def release():
            nonlocal released
            if not released:
                released = True
                policy.end_request(binding)

        try:
            model = await prepare(binding['provider'], binding['modelId'], binding['epoch'])
            # Caller/compaction/hook options may have been built under an older
            # model. Re-resolve auth AFTER admission, using native registry only.
            from misaka.core.sdk import _to_dict
            request_options = _to_dict(options)
            auth_resolver = getattr(session.modelRegistry, 'getAuth', None)
            if auth_resolver is not None:
                from misaka.ai.auth.resolve import AuthResolutionOverrides
                from misaka.ai.utils.headers import provider_headers_to_record
                resolution = await auth_resolver(model, AuthResolutionOverrides(signal=request_options.get('signal')))
                if resolution is None:
                    raise ValueError('Team model provider has no configured authentication')
                request_options['apiKey'] = resolution.auth.apiKey
                request_options['headers'] = provider_headers_to_record(resolution.auth.headers) or {}
                request_options['env'] = resolution.env or {}
                if resolution.auth.baseUrl and hasattr(model, 'model_copy'):
                    model = model.model_copy(update={'baseUrl': resolution.auth.baseUrl})
            stream = await _maybe((_transport or inner)(model, context, request_options))
            return _BoundStream(stream, release)
        except BaseException:
            await release()
            raise

    proxy = DesktopModelRegistry(source_registry, bound_stream)
    if hasattr(session, '_modelRegistry'):
        session._modelRegistry = proxy
    else:
        session.modelRegistry = proxy
    runner = getattr(session, '_extensionRunner', None)
    if runner is not None:
        runner.modelRegistry = proxy
    warmer = getattr(session, '_cacheWarmer', None)
    if warmer is not None:
        warmer.models = proxy
    session.agent.streamFn = bound_stream
    session._desktop_model_policy = policy
    session._desktop_executor_id = executor_id
    session._desktop_model_prepare = prepare


async def wait_model_ready(policy, signal=None):
    from misaka.utils.values import signal_aborted
    # Failed targets remain paused until the user explicitly retries or cancels;
    # a native abort still exits promptly without requiring a model decision.
    while True:
        if signal_aborted(signal):
            raise asyncio.CancelledError('Request aborted during team model boundary')
        try:
            return policy.guard_model()
        except ModelPolicyPaused:
            await asyncio.sleep(.01)


class DesktopScenePart:
    """System-only scene/role overlay; original user text is never rewritten."""
    def __init__(self, scope, *, member_name=None, root=False):
        self.scope, self.member_name, self.root = scope, member_name, root
        self.tools, self.commands = [], []
        self.session = None
        self.intake = False

    def attach(self, session):
        self.session = session
        self.scope.bind_session(session)

    async def before_agent_start(self, event, _context):
        role = 'ORIGINAL root coordinator' if self.root else 'task-local member ' + (self.member_name or 'helper')
        text = ('## Desktop research scene\nScene: desktop_research. You are the ' + role + '. '
                'All root, node, Sister and nested requests use the team model binding. '
                'Native research phases, board ownership, budgets and evidence artifacts remain authoritative. '
                'Ground claims in source artifacts, state uncertainty, and communicate evidence gaps to peers.\n')
        if self.intake:
            text += ('\n## Desktop research team intake\nBefore the native planner starts, identify the expertise '
                'this user question genuinely needs and call desktop_recruit_agent for each specialized role, '
                'including an independent critic when needed. Choose roles and counts yourself; no default pair '
                'is injected. You may borrow existing Sisters by source_id. Each role needs a concrete '
                'responsibility, goal, instructions, evidence standard and peer-messaging boundary. '
                'Do not execute cards or claim completed research. End with a short handoff after recruitment.\n')
        else:
            text += ('Recruitment remains available to the root whenever evidence reveals missing expertise.\n')
        if self.root:
            from misaka.core.platform.prompt_guard import untrusted
            from misaka.core.research.planner import sister_catalog
            sources = sister_catalog(str(self.scope.team.shared_root), workspace=self.session.sessionManager.getCwd())
            previews = [{key: str(item.get(key) or '') for key in ('id', 'name', 'description', 'profile_preview')}
                        for item in sources]
            text += ('\n## Shared Sister sources for optional borrowing\nThese are source definitions, not task assignees. '
                     'Call desktop_recruit_agent with source_id to create a task-local borrowed view before assigning it.\n'
                     + untrusted('shared-sister-sources', json.dumps(previews, ensure_ascii=False)))
        member = next((m for m in self.scope.team.snapshot()['team']['members']
                       if m['name'] == self.member_name), None)
        if member:
            text += ('\nResponsibility: ' + member['responsibility'] + '\nTask goal: ' + member['goal']
                     + '\nRole instructions: ' + member['instructions'] + '\n')
        return {'systemPrompt': event['systemPrompt'].rstrip() + '\n\n' + text}

    async def session_shutdown(self, _event, _context):
        await self.scope.release_session(self.session)


class DeferredDesktopProcess:
    def __init__(self, scope, spawner, argv, kwargs, loop):
        self.scope, self.spawner, self.argv, self.kwargs, self.loop = scope, spawner, argv, kwargs, loop
        self.process = None
        self.cancelled = False
        self.error = None
        self.job = asyncio.run_coroutine_threadsafe(self._launch(), loop)

    async def _launch(self):
        from misaka.core.research.node import ProcessSpawner
        try:
            binding = await wait_model_ready(self.scope.policy)
            if self.cancelled:
                return
            argv = desktop_child_argv(self.argv, self.scope.policy.path, binding,
                                      launch_id=self.scope.record_launch(binding))
            from misaka.utils.async_lifecycle import settle_thread_call
            self.process, cancelled = await settle_thread_call(
                ProcessSpawner.spawn, self.spawner, argv, **self.kwargs)
            if self.cancelled or cancelled is not None:
                self.cancelled = True
                await settle_thread_call(ProcessSpawner.stop, self.spawner, self.process)
            if cancelled is not None:
                raise cancelled
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        except (OSError, ValueError, RuntimeError) as error:
            self.error = error

    @property
    def pid(self):
        return self.process.pid if self.process is not None else None

    def poll(self):
        if self.process is not None:
            return self.process.poll()
        return -15 if self.cancelled else (1 if self.error else None)

    def wait(self, timeout=None):
        self.job.result(timeout)
        return self.process.wait(timeout) if self.process is not None else self.poll()

    def stop(self, spawner):
        from misaka.core.research.node import ProcessSpawner
        self.cancelled = True
        if self.process is None:
            self.job.cancel()
        else:
            ProcessSpawner.stop(spawner, self.process)


class DesktopExecutionScope:
    """One root's private factories; no native object or interpreter is patched."""
    MODULES: ClassVar[set[str]] = {
        'misaka.core.research.node', 'misaka.core.research.window', 'misaka.core.research.workflow',
        'misaka.core.research.wiring.research', 'misaka.core.network.worker',
        'misaka.core.network.dispatch', 'misaka.core.platform.session',
        'misaka.core.subagent.runtime', 'misaka.core.subagent.extension', 'misaka.core.subagent.child',
        'misaka.core.research.ingress', 'misaka.core.wiring',
        'misaka.core.network.sister_runtime', 'misaka.core.network.wiring.network',
        'misaka.core.network.messages', 'misaka.core.network.wiring.messages',
    }
    CLASSES: ClassVar[set[tuple[str, str]]] = {
        ('misaka.core.research.node', 'HeadlessRunner'),
        ('misaka.core.research.wiring.research', 'ResearchPart'),
        ('misaka.core.subagent.extension', 'SubagentPart'),
        ('misaka.core.subagent.runtime', 'SubagentManager'),
        ('misaka.core.wiring', 'Assembly'),
        ('misaka.core.network.sister_runtime', '_SisterManager'),
        ('misaka.core.network.sister_runtime', 'SisterRuntime'),
        ('misaka.core.network.wiring.network', 'NetworkPart'),
        ('misaka.core.network.messages', 'MessagesPart'),
    }

    def __init__(self, team, config, *, controller=None):
        self.team, self.policy = team, team.model_policy
        self.base_config = dict(config)
        atomic_json(self.team.directory / 'runtime-config.json', self.base_config)
        self.controller = controller
        self.sessions, self.idle_jobs = {}, {}
        self.catalog_views = []
        self.counter = 0
        self.adapted_extensions = set()
        from .auxiliary import AUXILIARY_DIAGNOSTIC
        self.runtime_diagnostics = [dict(AUXILIARY_DIAGNOSTIC)]
        atomic_json(self.team.directory / 'runtime-diagnostics.json', self.runtime_diagnostics)
        import misaka.core.platform.session as platform_session
        from misaka.core.research import node, planner

        owner = self

        class DesktopSpawner(node.ProcessSpawner):
            def spawn(self, argv, **kwargs):
                if owner.policy.snapshot()['state'] != 'ready':
                    return owner.defer_spawn(self, argv, kwargs)
                try:
                    binding = owner.launch_binding()
                except ModelPolicyPaused:
                    return owner.defer_spawn(self, argv, kwargs)
                launch_id = owner.record_launch(binding)
                return super().spawn(desktop_child_argv(argv, owner.policy.path, binding, launch_id=launch_id), **kwargs)

            def stop(self, process):
                if isinstance(process, DeferredDesktopProcess):
                    process.stop(self)
                else:
                    super().stop(process)

        async def create_subprocess_exec(*argv, **kwargs):
            binding = await wait_model_ready(owner.policy)
            launch_id = owner.record_launch(binding)
            return await asyncio.create_subprocess_exec(
                *desktop_child_argv(argv, owner.policy.path, binding, launch_id=launch_id), **kwargs)

        async def resolve_task_model(_manager, _context, _call_model, _definition_model):
            signal = read_field(_context, 'signal') or getattr(_manager.session.agent, 'signal', None)
            binding = await wait_model_ready(owner.policy, signal)
            await owner.ensure_session(_manager.session, binding)
            return binding['provider'], binding['modelId']

        async def open_session(flags, cwd, assembly=None):
            binding = await wait_model_ready(owner.policy)
            if assembly is not None:
                owner.adapt_assembly(assembly)
            runtime, session, error = await platform_session.open_session(pinned_flags(flags, binding), cwd, assembly)
            if session is not None and not error:
                owner.bind_session(session)
                await owner.ensure_session(session, binding)
            return runtime, session, error

        async def dispose(runtime):
            session = getattr(runtime, 'session', None)
            try:
                await platform_session.dispose(runtime)
            finally:
                if session is not None:
                    await owner.release_session(session)

        def ensure_roster(root=None):
            catalog = planner.sister_catalog(root or str(owner.team.profile_root))
            if not catalog:
                raise ValueError('Recruit task-specific roles before starting the research planner.')
            return catalog

        overrides = {
            'misaka.config': {'CFG': self.current_config(), 'current_config': self.current_config,
                              'sisters': lambda: {m['name'] for m in self.team.snapshot()['team']['members']}},
            'misaka.config.product': {'CFG': self.current_config(), 'current_config': self.current_config},
            'misaka.config.profiles': {'explicit_model_override': lambda *_args, **_kwargs:
                f"{self.policy.snapshot()['effective']['provider']}/{self.policy.snapshot()['effective']['modelId']}"},
            'misaka.core.research.node': {'ProcessSpawner': DesktopSpawner, 'PaneSpawner': DesktopSpawner,
                'PaneRunner': lambda con, cfg, *_args: self.native.module('misaka.core.research.node').HeadlessRunner(con, cfg)},
            'misaka.core.platform.session': {'open_session': open_session, 'dispose': dispose},
            'misaka.core.network.roster': {'ensure_research_sisters': ensure_roster},
            'misaka.core.subagent.runtime': {'asyncio': SimpleNamespace(**{**vars(asyncio), 'create_subprocess_exec': create_subprocess_exec})},
        }
        from .auxiliary import install_auxiliary_factories
        modules, classes = set(self.MODULES), set(self.CLASSES)
        install_auxiliary_factories(self, overrides, modules, classes)
        self.native = NativeScope(overrides, modules=modules, classes=classes)
        # Only this scope's subclass is modified. Native SubagentManager remains identical.
        manager_class = self.native.module('misaka.core.subagent.runtime').SubagentManager
        manager_class._resolve_task_model = resolve_task_model
        self.SubagentManager = manager_class
        self.open_session = open_session
        self.native.overrides['misaka.core.research.planner'] = {
            '_roster': self.catalog, 'validate_plan': planner.validate_plan,
            '_validate_tasks': planner._validate_tasks, '_validate_decisions': planner._validate_decisions}
        self.native.modules.add('misaka.core.research.planner')
        # No commands/phase validators are cloned: their native module is deliberately absent.

    def current_config(self):
        pair = self.policy.snapshot()['effective']
        return {**self.base_config, 'profiles_root': str(self.team.profile_root),
                'provider': pair['provider'], 'default_model': pair['modelId'],
                'lo_model': f"{pair['provider']}/{pair['modelId']}"}

    def launch_binding(self):
        return self.policy.guard_model()

    def record_launch(self, binding):
        launch_id = uuid.uuid4().hex
        atomic_json(self.team.directory / 'launches' / (launch_id + '.json'), binding)
        return launch_id

    def defer_spawn(self, spawner, argv, kwargs):
        # HeadlessRunner calls synchronous spawn inside its async loop. Returning
        # a process-shaped pending handle keeps that loop responsive to cancel.
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = getattr(self, 'loop', None)
        if loop is None or not loop.is_running():
            # Native node spawns use an off-loop thread; no event loop is blocked.
            while self.policy.snapshot()['state'] != 'ready':
                time.sleep(.01)
            return spawner.spawn(argv, **kwargs)
        return DeferredDesktopProcess(self, spawner, argv, kwargs, loop)

    def catalog(self, cfg):
        from misaka.core.research.planner import _roster
        catalog = _roster({**cfg, 'profiles_root': str(self.team.profile_root)})
        self.catalog_views.append(catalog)
        return catalog

    def refresh_catalog(self):
        from misaka.core.research.planner import sister_catalog
        catalog = sister_catalog(str(self.team.profile_root))
        for view in self.catalog_views:
            view[:] = catalog
        for session in self.sessions.values():
            for part in session.moments.parts:
                if type(part).__name__ == 'SisterCapabilitiesPart':
                    if part.catalog is None:
                        part.catalog = list(catalog)
                    else:
                        part.catalog[:] = catalog
        return catalog

    def adapt_assembly(self, assembly):
        from .auxiliary import adapt_extension_factories
        adapt_extension_factories(self, assembly)
        parts = assembly.parts
        for index, part in enumerate(parts):
            path = type(part).__module__
            if path == 'misaka.core.research.wiring.research':
                parts[index] = self.native.module(path).ResearchPart()
            elif path == 'misaka.core.network.wiring.network':
                parts[index] = self.native.module(path).NetworkPart(
                    receive_notifications=part.receive_notifications)
            elif path == 'misaka.core.network.messages':
                parts[index] = self.native.module(path).MessagesPart(sender=part.sender,
                    route=part.route, receive=part.receive, card_task=part.card_task, contact=part.contact)
            elif path == 'misaka.core.web':
                parts[index] = self.native.module(path).WebPart(assembly.spec)
            elif path == 'misaka.core.subagent.extension':
                parts[index] = self.native.module(path).SubagentPart(
                    part.role_context, part.manager is not None,
                    disallowed_tools=tuple(part._disallowed_tools))
        if not any(isinstance(part, DesktopScenePart) for part in parts):
            member_name = read_field(read_field(assembly, 'spec'), 'role', '').rsplit('/', 1)[-1]
            parts.append(DesktopScenePart(self, member_name=member_name))
        assembly._parts = parts
        assembly._custom_tools = None
        return assembly

    async def ensure_session(self, session, binding):
        await session._desktop_model_prepare(binding['provider'], binding['modelId'], binding['epoch'])

    def bind_session(self, session):
        if id(session) in self.sessions:
            return
        self.counter += 1
        self.loop = asyncio.get_running_loop()
        executor_id = f'{session.sessionId}:{self.counter}'
        install_model_binding(session, self.policy, executor_id)
        self.sessions[id(session)] = session
        from .auxiliary import adapt_live_extensions
        adapt_live_extensions(self, session)
        self.idle_jobs[id(session)] = asyncio.create_task(self._idle_sync(session))

    async def _idle_sync(self, session):
        while True:
            try:
                await self.policy.synchronize_executor(session._desktop_executor_id)
            except Exception:  # noqa: BLE001 - registry/provider callbacks persist a sticky failed boundary
                logger.warning('Desktop executor preparation failed; the recorded model boundary remains paused')
            await asyncio.sleep(.05)

    async def release_session(self, session):
        job = self.idle_jobs.pop(id(session), None)
        if job:
            job.cancel()
            await asyncio.gather(job, return_exceptions=True)
        self.sessions.pop(id(session), None)
        executor_id = getattr(session, '_desktop_executor_id', None)
        if executor_id:
            self.policy.unregister_executor(executor_id)


class DesktopResearchController:
    def __init__(self, session, emit, config=None):
        from misaka.config.product import current_config
        self.session, self.emit = session, emit
        self.config = dict(config if config is not None else current_config())
        manager = session.sessionManager
        from .storage import root_team_directory
        directory = root_team_directory(manager, session.sessionId)
        model = session.model
        self.team = DesktopResearchTeam(directory, self.config['profiles_root'], model.provider, model.id,
            team_id=session.sessionId, allowed_tools=session.getActiveToolNames())
        self.scope = DesktopExecutionScope(self.team, self.config, controller=self)
        self.ingress = self.scope.native.module('misaka.core.research.ingress').ResearchMessageIngress(
            session, config=self.scope.current_config())
        self.lock = asyncio.Lock()
        self.intake_requests = set()
        self.attached = False
        self.manager = None
        self._event_jobs = set()
        self._unsubscribe_model_events = lambda: None

    def attach(self):
        if not getattr(self.session, 'research_host', False):
            raise ValueError('Desktop recruitment requires the independent research host.')
        if self.attached:
            return self
        from misaka.core.research.wiring.research import ResearchPart
        from misaka.core.subagent.runtime import RoleContext
        from misaka.core.wiring import SessionSpec

        from .tools import desktop_team_tools
        catalog = next((part for part in self.session.moments.parts if type(part).__name__ == 'CatalogPart'), None)
        root_spec = getattr(catalog, 'spec', None) or SessionSpec(
            profile_dir=str(Path(self.config['roles_root']) / 'last_order'), role='last_order',
            workspace=self.session.sessionManager.getCwd(), kind='foreground',
            research_context=True, research_host=True)
        for index, part in enumerate(tuple(self.session.moments.parts)):
            path = type(part).__module__
            replacement = None
            if isinstance(part, ResearchPart):
                replacement = self.scope.native.module('misaka.core.research.wiring.research').ResearchPart()
            elif path == 'misaka.core.network.messages':
                replacement = self.scope.native.module(path).MessagesPart(
                    sender=part.sender, route=part.route, receive=part.receive,
                    card_task=part.card_task, contact=part.contact)
            elif path == 'misaka.core.network.wiring.network':
                replacement = self.scope.native.module(path).NetworkPart(
                    receive_notifications=part.receive_notifications)
                watch = getattr(part, '_pending_watch', None)
                if watch is not None:
                    watch.cancel()
                job = asyncio.create_task(part.runtime.close())
                self._event_jobs.add(job)
                job.add_done_callback(self._event_jobs.discard)
            elif path == 'misaka.core.web':
                replacement = self.scope.native.module(path).WebPart(root_spec)
                job = asyncio.create_task(part.runtime.close())
                self._event_jobs.add(job)
                job.add_done_callback(self._event_jobs.discard)
            if replacement is not None:
                if part.tools:
                    self.session.unregisterCustomTools(part.tools)
                attach = getattr(replacement, 'attach', None)
                if attach is not None:
                    attach(self.session)
                self.session.moments.parts[index] = replacement
                if replacement.tools:
                    self.session.registerCustomTools(replacement.tools)
        self.manager = self.scope.SubagentManager(self.session, RoleContext.capture(workspace=self.session.sessionManager.getCwd()))
        self.session.registerCustomTools(desktop_team_tools(self))
        self.scene = DesktopScenePart(self.scope, root=True)
        self.scene.attach(self.session)
        self.session.moments.parts.append(self.scene)
        self.scope.refresh_catalog()
        self._subscribe_model_events()
        self.attached = True
        self.session._desktop_research_controller = self
        return self

    def snapshot(self):
        from .task_state import project_controller_snapshot
        return project_controller_snapshot(self)

    async def _emit(self, kind, binding=None):
        payload = {'type': kind, **self.snapshot()}
        if binding is not None:
            payload['modelBinding'] = binding
        if self.emit is not None:
            await _maybe(self.emit(payload))
        else:
            await self.session.sendCustomMessage({'customType': kind, 'display': True,
                'content': json.dumps(payload, ensure_ascii=False), 'details': payload}, {'triggerTurn': False})
        return payload

    async def recruit(self, **arguments):
        member = self.team.recruit(**arguments)
        self.scope.refresh_catalog()
        await self._emit('desktop-team')
        return member

    async def send_message(self, obj, con):
        async with self.lock:
            # Validate before the recruitment turn, not only after changing the transcript.
            if obj.get('sessionId') != self.session.sessionId:
                raise ValueError('Research session changed; refresh before sending.')
            text, request_id = obj.get('text'), obj.get('requestId')
            if not isinstance(text, str) or not text.strip() or text.lstrip().startswith('/'):
                raise ValueError('Enter prose in this research conversation.')
            if not isinstance(request_id, str) or not request_id.strip():
                raise ValueError('send_research_message requires requestId')
            if obj.get('runId') and session_run(self.session, con) is None:
                raise ValueError('The research run does not belong to this root session.')
            if session_run(self.session, con) is None and not self.ingress.starting and request_id not in self.intake_requests:
                from misaka.core.session_control import for_session
                control = for_session(self.session)
                if control is None or not control.accepting:
                    raise ValueError('The research coordinator has no live original control endpoint.')
                command = {'session': self.session.sessionId, 'instance': control.catalog.instance,
                    'operation': 'input', 'requestId': request_id}
                if not control._owns(command):
                    raise ValueError('The original research session changed owners.')
                control._check_input_owner()
                from misaka.core.research.ingress import current_request_id
                self.scene.intake = True
                token = current_request_id.set(request_id)
                try:
                    # Hidden native custom intake preserves the user's exact input once;
                    # the workflow publishes its existing research-question entry on start.
                    await self.session.sendCustomMessage({'customType': 'desktop-intake',
                        'display': False, 'content': text.strip(),
                        'details': {'requestId': request_id}},
                        {'triggerTurn': True, 'prepareTurn': True,
                         '_deliveryId': f'desktop-intake:{self.session.sessionId}:{request_id}'})
                    await self.session.waitForIdle()
                finally:
                    current_request_id.reset(token)
                    self.scene.intake = False
                if not self.team.snapshot()['team']['members']:
                    raise ValueError('The coordinator has not recruited any task-specific roles; research has not started.')
                self.intake_requests.add(request_id)
            self.ingress.config = self.scope.current_config()
            return await self.ingress.send(obj, con)

    def _subscribe_model_events(self):
        def changed(binding):
            job = asyncio.create_task(self._emit('desktop-model-switch', binding=dict(binding)))
            self._event_jobs.add(job)
            job.add_done_callback(self._event_jobs.discard)
        self._unsubscribe_model_events = self.team.model_policy.subscribe(changed)

    async def set_team_model(self, provider, model_id, action='switch'):
        try:
            if action == 'cancel':
                await self.team.model_policy.cancel_switch()
            elif action in {'switch', 'retry'}:
                binding = await self.team.model_policy.switch(provider, model_id)
                if binding['state'] == 'ready':
                    pair = binding['effective']
                    self.team.pin_profiles(pair['provider'], pair['modelId'])
            else:
                raise ValueError('Unknown team model action')
        finally:
            # Subscribers report genuine persisted transitions, including failed targets.
            if self._event_jobs:
                await asyncio.gather(*tuple(self._event_jobs))
        return self.snapshot()

    async def retain_roles(self, selections, request_id, con):
        run = session_run(self.session, con)
        terminal = run is not None and run['status'] in {'done', 'stopped', 'failed'}
        self.team.retain_roles(selections, terminal=terminal, request_id=request_id)
        await self._emit('desktop-team')
        return self.snapshot()

    async def close(self):
        self._unsubscribe_model_events()
        if self._event_jobs:
            await asyncio.gather(*tuple(self._event_jobs), return_exceptions=True)
        if self.manager:
            await self.manager.close()
        for session in list(self.scope.sessions.values()):
            await self.scope.release_session(session)



