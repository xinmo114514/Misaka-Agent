"""Desktop research runtime: native workflow with task-local recruitment and model fencing."""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import threading
import time
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import ClassVar

from misaka.core.research import submissions
from misaka.core.research.ingress import (
    adoptable_run,
    session_run,
    validate_research_input,
)
from misaka.utils.values import read_field

from .auxiliary import prepare_desktop_assembly
from .card_control import DesktopCardControl
from .model_policy import DesktopRoleModelPolicy, ModelPolicyPaused, atomic_json
from .native_scope import NativeScope
from .team import DesktopResearchTeam

logger = logging.getLogger(__name__)
__all__ = ['DesktopExecutionScope', 'DesktopResearchController', 'prepare_desktop_assembly']


async def retry_end_request(policy, ticket, *, attempts=5, delay=0.2):
    """Release one model request, retrying a transient store failure a bounded number of times.

    Task 2: the request ticket is the barrier's record. A release that fails once (a concurrent
    policy write, a briefly held lock) must not leave the ticket behind forever; the final failure
    still propagates so the caller keeps a retryable settlement instead of a silent leak.
    """
    last = None
    for _ in range(max(1, attempts)):
        try:
            policy.end_request(ticket)
            return
        except Exception as error:  # noqa: BLE001 - a retryable release failure
            last = error
            await asyncio.sleep(delay)
    raise last

# A recruitment turn is a real model conversation (it inspects the question, then recruits each
# role), so it is slow by design. The bound exists only to turn "never settles" into a visible,
# retryable failure; it is far above a healthy recruitment and does not limit a started run.
RECRUITMENT_TURN_TIMEOUT_SECONDS = 600.0


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
    role = binding.get('role') or ('last_order' if lane == 'node' else 'sister')
    return [argv[0], '-m', 'misaka.desktop_research.worker_entry', '--policy', str(policy_path),
            '--epoch', str(binding['epoch']), '--provider', binding['provider'], '--model', binding['modelId'],
            *(['--launch-id', launch_id] if launch_id else []), '--role', role, '--lane', lane, '--', *args]


class _BoundStream:
    """One admitted model request plus the cleanup its producer owns (Task 2).

    Cancellation now asks this request's own transport to stop before joining its producer, so
    停止研究 settles a blocked stream instead of hanging on it (2026-10-19: a stop left the root
    waiting on its own model request, the ticket unreleased). The abort door belongs to this
    request alone -- the caller's upstream signal is never touched -- and the request ticket
    still releases only after the producer's finalizers have drained.
    """

    def __init__(self, stream, release, abort=None):
        self.stream, self.release, self.abort = stream, release, abort

    def __getattr__(self, name):
        return getattr(self.stream, name)

    def _request_abort(self):
        """Raise this request's own door; the turn's abort belongs to its caller."""
        if self.abort is not None:
            self.abort()

    def __aiter__(self):
        return self._events()

    async def _events(self):
        cancelled = None
        try:
            async for event in self.stream:
                yield event
        except (asyncio.CancelledError, GeneratorExit) as error:
            # The consumer gave up: end the provider wait first, then join its cleanup below.
            cancelled = error
            self._request_abort()
        finally:
            await self._drain_release(cancelled)

    async def result(self):
        cancelled = None
        try:
            return await _maybe(self.stream.result())
        except (asyncio.CancelledError, GeneratorExit) as error:
            cancelled = error
            self._request_abort()
        finally:
            await self._drain_release(cancelled)

    async def _drain_release(self, cancelled=None):
        from misaka.utils.async_lifecycle import settle
        async def drain():
            try:
                settled = getattr(self.stream, 'settled', None)
                if settled:
                    await _maybe(settled())
            finally:
                await self.release()
        task = asyncio.create_task(drain())
        if cancelled is None:
            try:
                await asyncio.shield(task)
                return
            except asyncio.CancelledError as error:
                # Cancelled mid-join: raise the door so a cooperative producer can end...
                self._request_abort()
                cancelled = error
        else:
            self._request_abort()
        # ...then finish the one cleanup task anyway, so the ticket releases only after its
        # finalizers. A second cancellation is still waited through (settle), never abandoned.
        _value, late = await settle(task)
        raise late or cancelled

    async def aclose(self):
        # An explicit close is an explicit stop of THIS request: signal it before waiting on
        # the underlying close or its finalizers.
        self._request_abort()
        try:
            close = getattr(self.stream, 'aclose', None)
            if close:
                await _maybe(close())
        finally:
            await self._drain_release(None)


class DeferredBoundStream:
    """Native synchronous stream door with async admission beneath it."""
    def __init__(self, opening):
        self.opening = asyncio.create_task(opening)

    async def _open(self):
        """Await admission; a consumer that gives up takes the request down with it.

        Cancelling this waiter does not cancel the admission task on its own, so a stop landing
        mid-admission left the opened request registered with nobody to release it (2026-10-19
        停止研究 hang). Aborting here cancels the opening task -- whose failure path releases
        the request ticket -- and the join survives a second cancellation (settle). A stream
        that finished opening after the cancellation is closed through its own request-local door.
        """
        cancelled = None
        while not self.opening.done():
            try:
                await asyncio.shield(self.opening)
            except asyncio.CancelledError as error:
                if cancelled is None:
                    cancelled = error
                    self.opening.cancel()
        if cancelled is None:
            return self.opening.result()
        if not self.opening.cancelled():
            try:
                opened = self.opening.result()
            except BaseException:  # noqa: BLE001 - the stored failure belongs to the cancelled waiter
                opened = None
            if isinstance(opened, _BoundStream):
                await opened._drain_release(cancelled)
        raise cancelled

    async def result(self):
        stream = await self._open()
        return await stream.result()

    def __aiter__(self):
        return self._events()

    async def _events(self):
        stream = await self._open()
        try:
            async for event in stream:
                yield event
        finally:
            await stream._drain_release(None)

    async def settled(self):
        stream = await self._open()
        await stream._drain_release(None)


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


def install_model_binding(session, policy, executor_id, scope=None, *, role='sister'):
    if getattr(session, '_desktop_model_policy', None) is policy:
        return
    inner = session.agent.streamFunction
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
        if not await getattr(registry, "modelRuntime", registry).checkAuth(provider):
            raise ValueError(f'Team model credentials are missing: {provider}/{model_id}')
        if read_field(session.model, 'provider') != provider or read_field(session.model, 'id') != model_id:
            await session.setModel(model, {"persist": False})
        return model

    if isinstance(policy, DesktopRoleModelPolicy):
        policy.register_executor(executor_id, prepare, role=role)
    else:
        policy.register_executor(executor_id, prepare)

    async def open_bound_stream(_override_model, context, options=None, *, _transport=None):
        from misaka.utils.js import AbortController, AbortSignal
        from misaka.core.sdk import _toDict as _to_dict
        request_options = _to_dict(options)
        # Every admitted request owns one cancellation door. It composes over the caller's
        # signal so a consumer who gives up can end exactly this transport (停止研究), while a
        # turn-wide abort still reaches the request as before; the caller's signal itself is
        # never raised from here.
        door = AbortController()
        signal = AbortSignal.any([item for item in (request_options.get('signal'), door.signal) if item is not None])
        while True:
            if getattr(session, '_desktop_closing', False):
                raise asyncio.CancelledError('Executor closing')
            await wait_model_ready(policy, signal, role=role)
            await policy.synchronize_executor(executor_id)
            try:
                binding = policy.begin_request(executor_id)
                break
            except ModelPolicyPaused:
                # A switch raced the readiness read. Rejoin it, keeping abort
                # responsive rather than entering policy.request's blind wait.
                await asyncio.sleep(.01)
        released = False
        bound = None
        tickets = getattr(session, '_desktop_release_tickets', None)
        if tickets is None:
            tickets = session._desktop_release_tickets = {}
        release_lock = asyncio.Lock()

        async def release():
            nonlocal released
            async with release_lock:
                if not released:
                    await retry_end_request(policy, binding)
                    released = True
                    tickets.pop(binding['requestId'], None)
                    if scope is not None and bound is not None:
                        scope.stream_closed(session, bound)

        tickets[binding['requestId']] = release

        try:
            model = await prepare(binding['provider'], binding['modelId'], binding['epoch'])
            if scope is not None:
                scope.apply_thinking(session)
            # Caller/compaction/hook options may have been built under an older
            # model. Re-resolve auth AFTER admission, using native registry only.
            from misaka.core.sdk import _toDict as _to_dict
            request_options = _to_dict(options)
            request_options['signal'] = signal
            auth_resolver = getattr(getattr(source_registry, 'modelRuntime', source_registry), 'getAuth', None)
            if auth_resolver is not None:
                from misaka.ai.auth.resolve import AuthResolutionOverrides
                from misaka.ai.utils.headers import providerHeadersToRecord as provider_headers_to_record
                resolution = await auth_resolver(model, AuthResolutionOverrides(signal=request_options.get('signal')))
                if resolution is None:
                    raise ValueError('Team model provider has no configured authentication')
                request_options['apiKey'] = resolution.auth.apiKey
                request_options['headers'] = provider_headers_to_record(resolution.auth.headers) or {}
                request_options['env'] = resolution.env or {}
                if resolution.auth.baseUrl and hasattr(model, 'model_copy'):
                    model = model.model_copy(update={'baseUrl': resolution.auth.baseUrl})
            # Keep effective routing only in memory for diagnostics. The registry fills
            # ``effectiveNetworkEnv`` after auth and application policy merge; retain that
            # same in-memory mapping so a later setup failure still reports the route the
            # request actually used. Never persist auth or routing data here.
            network_context = {'endpoint': read_field(model, 'baseUrl'),
                'provider': read_field(model, 'provider'), 'modelId': read_field(model, 'id'),
                'modelBaseUrl': read_field(session.model, 'baseUrl'),
                'secrets': [request_options.get('apiKey'), *(request_options.get('headers') or {}).values()]}
            session._desktop_network_context = None
            stream = await _maybe((_transport or inner)(model, context, request_options))
            effective_env = getattr(stream, 'effectiveNetworkEnv', None)
            if effective_env is None:
                from misaka.ai.utils.network_route import snapshot_network_env
                effective_env = snapshot_network_env(request_options.get('env'))
            network_context['env'] = effective_env
            session._desktop_network_context = network_context
            bound = _BoundStream(stream, release, abort=door.abort)
            if scope is not None:
                scope.stream_opened(session, bound)
            return bound
        except BaseException:
            await release()
            raise

    async def bound_stream(_override_model, context, options=None, *, _transport=None):
        if getattr(session, '_desktop_closing', False):
            raise asyncio.CancelledError('Executor closing')
        opening = asyncio.current_task()
        openings = getattr(session, '_desktop_opening_streams', None)
        if openings is None:
            openings = session._desktop_opening_streams = set()
        openings.add(opening)
        try:
            return await open_bound_stream(_override_model, context, options, _transport=_transport)
        finally:
            openings.discard(opening)

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
    session.agent.streamFunction = bound_stream
    session._desktop_model_policy = policy
    session._desktop_executor_id = executor_id
    session._desktop_model_role = role
    session._desktop_model_prepare = prepare


async def wait_model_ready(policy, signal=None, *, role=None):
    from misaka.utils.values import signal_aborted
    # Failed targets remain paused until the user explicitly retries or cancels;
    # a native abort still exits promptly without requiring a model decision.
    while True:
        if signal_aborted(signal):
            raise asyncio.CancelledError('Request aborted during team model boundary')
        try:
            return policy.guard_model(role=role) if role and isinstance(policy, DesktopRoleModelPolicy) else policy.guard_model()
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
        self.started = False
        self.settled = threading.Event()
        if not hasattr(scope, 'pending_launches'):
            scope.pending_launches = set()
        scope.pending_launches.add(self)
        self.job = asyncio.run_coroutine_threadsafe(self._launch(), loop)
        self.job.add_done_callback(self._before_start_cancelled)

    def _before_start_cancelled(self, future):
        if future.cancelled() and not self.started:
            self.scope.pending_launches.discard(self)
            self.settled.set()

    async def _launch(self):
        self.started = True
        from misaka.core.research.node import ProcessSpawner
        try:
            if getattr(self.scope, '_launch_closed', False):
                raise asyncio.CancelledError('Launch admission closed')
            binding = await wait_model_ready(self.scope.policy, role=self.scope.launch_role(self.argv))
            binding = {**binding, 'role': self.scope.launch_role(self.argv)}
            if self.cancelled or getattr(self.scope, '_launch_closed', False):
                self.cancelled = True
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
        finally:
            self.scope.pending_launches.discard(self)
            self.settled.set()

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

    def __init__(self, team, config, role='last_order', *, controller=None):
        self.team, self.policy = team, team.model_policy
        self.role = role
        self.base_config = dict(config)
        atomic_json(self.team.directory / 'runtime-config.json', self.base_config)
        self.controller = controller
        self.sessions, self.idle_jobs = {}, {}
        # Registered model streams per session: close drains them before the executor settles
        # (Task 2). A stream registers itself in install_model_binding's bound_stream.
        self.releasing = {}
        self.pending_launches = set()
        self.pending_launch_jobs = set()
        self._launch_closed = False
        self._startup_settlement = None
        # Task 1: the desktop-owned continuation owner. The scope's cloned messages module uses
        # this hook, so a finished card of this run is woken through the private team/policy
        # chain instead of the global panel continuation.
        self.card_control = DesktopCardControl(self)
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
                role = owner.launch_role(argv)
                if owner.policy.snapshot(role=role)['state'] != 'ready':
                    return owner.defer_spawn(self, argv, kwargs)
                try:
                    binding = owner.launch_binding(role=role)
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
            return await owner.launch_subprocess(argv, kwargs)

        async def resolve_task_model(_manager, _context, _call_model, _definition_model):
            signal = read_field(_context, 'signal') or getattr(_manager.session.agent, 'signal', None)
            binding = await wait_model_ready(owner.policy, signal, role=owner.role)
            await owner.ensure_session(_manager.session, binding)
            return binding['provider'], binding['modelId']

        async def open_session(flags, cwd, assembly=None):
            binding = await wait_model_ready(owner.policy, role=owner.role)
            if assembly is not None:
                owner.adapt_assembly(assembly)
            runtime, session, error = await platform_session.open_session(pinned_flags(flags, binding), cwd, assembly)
            if session is not None and not error:
                owner.bind_session(session)
                await owner.ensure_session(session, binding)
                owner.apply_thinking(session)
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
                f"{self.policy.snapshot(role=self.role)['effective']['provider']}/{self.policy.snapshot(role=self.role)['effective']['modelId']}"},
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
        # Task 1: scope-local continuation hook. The cloned messages module reads this from its
        # private namespace, so a finished card of this run is woken through the desktop worker
        # chain (private team, policy and profiles) instead of the global panel route.
        self.native.namespace('misaka.core.network.messages')['_SCOPE_WAKE_HOOK'] = self.card_control.wake_card
        self.native.namespace('misaka.core.network.dispatch')['_SCOPE_CONTINUATION_CLAIMING'] = self.card_control.claiming
        self.native.namespace('misaka.core.network.dispatch')['_SCOPE_CONTINUATION_CLAIMED'] = self.card_control.claimed
        # Only this scope's subclass is modified. Native SubagentManager remains identical.
        manager_class = self.native.module('misaka.core.subagent.runtime').SubagentManager
        manager_class._resolve_task_model = resolve_task_model
        self.SubagentManager = manager_class
        self.open_session = open_session
        self.native.overrides['misaka.core.research.planner'] = {
            '_roster': self.catalog, 'validate_plan': planner.validate_plan,
            '_validate_tasks': planner._validate_tasks, '_validate_decisions': planner._validate_decisions}
        self.native.modules.add('misaka.core.research.planner')

    def stream_opened(self, session, stream):
        """Track one live model stream so session settlement can close it (Task 2)."""
        streams = getattr(session, '_desktop_active_streams', None)
        if streams is None:
            streams = set()
            session._desktop_active_streams = streams
        streams.add(stream)

    def stream_closed(self, session, stream):
        streams = getattr(session, '_desktop_active_streams', None)
        if streams is not None:
            streams.discard(stream)

    async def cancel_startup_now(self):
        """Cancel every owned research startup and wait for it to actually stop.

        Task 2: ``task.cancel()`` only requests cancellation; the caller must be able to say the
        startup has settled. Returns the gather results, whose cancelled entries are the settled
        cancellations.
        """
        job = getattr(self, '_startup_settlement', None)
        if job is None or (job.done() and (job.cancelled() or job.exception() is not None)):
            self._launch_closed = True
            job = asyncio.create_task(self._settle_startup_now())
            self._startup_settlement = job
        return await asyncio.shield(job)

    async def _settle_startup_now(self):
        sessions = list(getattr(self, 'sessions', {}).values())
        root = getattr(getattr(self, 'controller', None), 'session', None)
        if root is None:
            root = getattr(self, 'session', None)  # legacy standalone scopes
        if root is not None:
            sessions.append(root)
        owned = set()
        for session in sessions:
            for part in getattr(getattr(session, 'moments', None), 'parts', ()):
                owned.update(getattr(part, '_starts', ()) or ())
        owned.update(getattr(self, 'pending_launch_jobs', ()))
        owned.discard(asyncio.current_task())
        deferred = [handle for handle in list(getattr(self, 'pending_launches', ()))
                    if isinstance(handle, DeferredDesktopProcess)]
        for handle in deferred:
            handle.stop(handle.spawner)
        for task in owned:
            task.cancel()
        control = getattr(self, 'card_control', None)
        if control is not None:
            await asyncio.to_thread(control.stop_all)
        results = await asyncio.gather(*owned, return_exceptions=True) if owned else []
        for handle in deferred:
            if not await asyncio.to_thread(handle.settled.wait, 30):
                raise RuntimeError('Native launch settlement remains pending')
        return results
        # No commands/phase validators are cloned: their native module is deliberately absent.

    async def launch_subprocess(self, argv, kwargs):
        """Own nested model-boundary and subprocess creation through cancellation settlement."""
        from misaka.utils.async_lifecycle import settle
        if self._launch_closed:
            raise asyncio.CancelledError('Launch admission closed')
        job = asyncio.current_task()
        self.pending_launch_jobs.add(job)
        try:
            binding = await wait_model_ready(self.policy, role=self.role)
            binding = {**binding, 'role': self.role}
            if self._launch_closed:
                raise asyncio.CancelledError('Launch admission closed')
            launch_id = self.record_launch(binding)
            process, cancelled = await settle(asyncio.create_task(asyncio.create_subprocess_exec(
                *desktop_child_argv(argv, self.policy.path, binding, launch_id=launch_id), **kwargs)))
            if cancelled is not None or self._launch_closed:
                if process.returncode is None:
                    process.terminate()
                    try:
                        await asyncio.wait_for(process.wait(), 5)
                    except TimeoutError:
                        process.kill()
                        await process.wait()
                raise cancelled or asyncio.CancelledError('Launch admission closed')
            return process
        finally:
            self.pending_launch_jobs.discard(job)

    def begin_launch_admission(self):
        settlement = getattr(self, '_startup_settlement', None)
        if settlement is not None and not settlement.done():
            raise ValueError('Previous startup cancellation is still settling')
        self._launch_closed = False
        self._startup_settlement = None

    def current_config(self):
        pair = self.policy.snapshot(role=self.role)['effective']
        lo = self.policy.snapshot(role='last_order')['effective']
        return {**self.base_config, 'profiles_root': str(self.team.profile_root),
                'provider': pair['provider'], 'default_model': pair['modelId'],
                'lo_model': f"{lo['provider']}/{lo['modelId']}"}

    def launch_role(self, argv):
        argv = list(argv)
        if argv[1:3] == ['-m', 'misaka.cli.research_node']:
            return 'sister'
        if argv[1:3] == ['-m', 'misaka'] and len(argv) > 3 and argv[3] == 'research':
            return 'last_order'
        return self.role

    def launch_binding(self, *, role=None):
        role = role or self.role
        return {**self.policy.guard_model(role=role), 'role': role}

    def record_launch(self, binding):
        launch_id = uuid.uuid4().hex
        atomic_json(self.team.directory / 'launches' / (launch_id + '.json'), binding)
        return launch_id

    def defer_spawn(self, spawner, argv, kwargs):
        if getattr(self, '_launch_closed', False):
            raise asyncio.CancelledError('Launch admission closed')
        # HeadlessRunner calls synchronous spawn inside its async loop. Returning
        # a process-shaped pending handle keeps that loop responsive to cancel.
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = getattr(self, 'loop', None)
        if loop is None or not loop.is_running():
            # Native node spawns use an off-loop thread; no event loop is blocked.
            while self.policy.snapshot(role=self.launch_role(argv))['state'] != 'ready':
                if getattr(self, '_launch_closed', False):
                    raise asyncio.CancelledError('Launch admission closed')
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

    def apply_thinking(self, session):
        level = self.team.role_thinking(self.role)
        if level is not None:
            session.setThinkingLevel(level)

    def bind_session(self, session):
        if id(session) in self.sessions:
            return
        self.counter += 1
        self.loop = asyncio.get_running_loop()
        executor_id = f'{session.sessionId}:{self.counter}'
        install_model_binding(session, self.policy, executor_id, scope=self, role=self.role)
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

    async def release_session(self, session, *, timeout=30.0):
        """Close one session's executor: drain its requests, then release it (Task 2).

        The old shape unregistered immediately and raised ``Executor still has active requests``
        when a stream was still finishing, which surfaced as a worker crash even though the card
        had settled (2026-10-11). Now: stop new admission, close registered streams, wait a bounded
        time for the barrier to drain, and keep a still-pending settlement registered so a later
        call (or process exit) can finish it. A clean release removes the session from the scope.
        """
        executor_id = getattr(session, '_desktop_executor_id', None)
        if not executor_id:
            self.sessions.pop(id(session), None)
            return 'settled'
        session._desktop_closing = True
        key = id(session)
        job = self.releasing.get(key)
        if job is None or (job.done() and (job.cancelled() or job.exception() is not None)):
            job = asyncio.create_task(self._settle_session(session, executor_id))
            self.releasing[key] = job
        try:
            result = await asyncio.wait_for(asyncio.shield(job), max(.001, timeout))
        except TimeoutError:
            return 'cleanup_pending'
        except Exception:
            logger.warning('Desktop executor settlement remains retryable', exc_info=True)
            return 'cleanup_pending'
        self.releasing.pop(key, None)
        return result

    async def _settle_session(self, session, executor_id):
        self.policy.begin_closing(executor_id)
        key = id(session)
        idle = self.idle_jobs.pop(key, None)
        opening = set(getattr(session, '_desktop_opening_streams', ()))
        opening.discard(asyncio.current_task())
        if idle is not None:
            opening.add(idle)
        for job in opening:
            job.cancel()
        if opening:
            await asyncio.gather(*opening, return_exceptions=True)
        while True:
            for stream in list(getattr(session, '_desktop_active_streams', ())):
                try:
                    await _maybe(stream.aclose())
                except Exception:
                    logger.warning('Desktop stream release remains retryable', exc_info=True)
            for release in list(getattr(session, '_desktop_release_tickets', {}).values()):
                try:
                    await release()
                except Exception:
                    logger.warning('Desktop request release remains retryable', exc_info=True)
            status = self.policy.settle_executor(executor_id)
            if status in ('settled', 'absent'):
                self.sessions.pop(key, None)
                return 'settled'
            await asyncio.sleep(.05)


class DesktopResearchController:
    def __init__(self, session, emit, config=None):
        from misaka.config.product import current_config
        self.session, self.emit = session, emit
        self.config = dict(config if config is not None else current_config())
        manager = session.sessionManager
        from .storage import root_team_directory
        directory = root_team_directory(manager, session.sessionId)
        model = session.model
        lo_reference = str(self.config.get('lo_model') or '').strip()
        lo_pair = {'provider': model.provider, 'modelId': model.id}
        if lo_reference and not (Path(directory) / 'desktop-team' / 'model-policy.json').exists():
            from misaka.config.profiles import resolve_model_reference
            canonical = resolve_model_reference(lo_reference, getattr(session.modelRegistry, "modelRuntime", session.modelRegistry),
                                                fallback_provider=self.config.get('provider') or model.provider)
            lo_pair = dict(zip(('provider', 'modelId'), canonical.split('/', 1)))
        self.team = DesktopResearchTeam(directory, self.config['profiles_root'], model.provider, model.id,
            team_id=session.sessionId, allowed_tools=session.getActiveToolNames(),
            lo_provider=lo_pair['provider'], lo_model=lo_pair['modelId'])
        self.scope = DesktopExecutionScope(self.team, self.config, controller=self)
        # The continuation owner needs to know which root conversation this team serves: a card
        # of another root must be continued in that root's window, never here (Task 1).
        atomic_json(self.scope.team.directory / 'owner.json', {
            'teamId': self.team.snapshot()['team']['teamId'],
            'rootSession': str(manager.sessionFile or ''),
            'workspace': str(manager.getCwd() or ''),
        })
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
            workflow_context=True, research_host=True)
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
            submissions.trace_input(obj, stage='controller', session_id=self.session.sessionId,
                                    model=getattr(self.session, 'model', None))
            stripped, control_spec = validate_research_input(obj, self.session.sessionId)
            if control_spec is None or control_spec.get('action') == 'resume':
                self.scope.begin_launch_admission()
            request_id = obj['requestId']
            obj = {**obj, 'text': stripped}
            if obj.get('runId') and session_run(self.session, con) is None:
                raise ValueError('The research run does not belong to this root session.')
            if (control_spec is None and adoptable_run(self.session, con, obj, run_lookup=session_run) is None
                    and not self.ingress.starting and submissions.lookup(self.session, request_id) is None):
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

                from . import recruitment
                previous_attempt = recruitment.original_attempt(self.session, obj)
                attempt = previous_attempt.get('attempt', 0) + 1
                previous = submissions.recorded_input(self.session, request_id, 'desktop-intake')
                if previous and str(previous.get('content') or '').strip() != stripped:
                    raise submissions.request_conflict()
                self.scene.intake = True
                token = current_request_id.set(request_id)
                before = getattr(self.session, '_findLastAssistantMessage', lambda: None)()
                self.session._desktop_network_context = None
                recruitment.record(self.session, obj, 'preparing', attempt=attempt)
                intake_task = None
                try:
                    # Hidden native custom intake preserves the user's exact input once;
                    # the workflow publishes its existing research-question entry on start.
                    members = self.team.snapshot()['team']['members']
                    last = getattr(self.session, '_findLastAssistantMessage', lambda: None)()
                    interrupted = last is not None and read_field(last, 'stopReason') != 'stop'
                    async def _run_intake():
                        if previous is None and request_id not in self.intake_requests:
                            await self.session.sendCustomMessage({'customType': 'desktop-intake',
                                'display': False, 'content': stripped,
                                'details': {'requestId': request_id}},
                                {'triggerTurn': True, 'prepareTurn': True,
                                 '_deliveryId': f'desktop-intake:{self.session.sessionId}:{request_id}'})
                        elif not members or interrupted:
                            # This is an internal continuation, not another copy of user intent.
                            attempt = 1 + sum(entry.get('customType') == 'desktop-intake-resume'
                                and (entry.get('details') or {}).get('requestId') == request_id
                                for entry in submissions.entries(self.session))
                            await self.session.sendCustomMessage({'customType': 'desktop-intake-resume',
                                'display': False,
                                'content': 'Continue preparing the task-specific research team for the original '
                                           'desktop-intake question already recorded in this conversation. '
                                           'Complete recruitment before handing off to the native planner.',
                                'details': {'requestId': request_id, 'kind': 'recruitment-continuation'}},
                                {'triggerTurn': True, 'prepareTurn': True,
                                 '_deliveryId': f'desktop-intake-resume:{self.session.sessionId}:{request_id}:{attempt}'})
                        await self.session.waitForIdle()

                    # The intake turn and model prompt are bounded by the recruitment timeout.
                    # wait_for cancels and drains BEFORE returning its timeout. A provider's
                    # finalizer may itself need native abort, so signal abort before draining.
                    intake_task = asyncio.create_task(_run_intake())
                    done, _ = await asyncio.wait({intake_task}, timeout=RECRUITMENT_TURN_TIMEOUT_SECONDS)
                    if not done:
                        raise TimeoutError('Research recruitment deadline exceeded')
                    await intake_task
                    after = getattr(self.session, '_findLastAssistantMessage', lambda: None)()
                    if after is not None and after is not before and read_field(after, 'stopReason') in {'error', 'aborted'}:
                        raise recruitment.failure(self.session, after, attempt=attempt)
                    if not self.team.snapshot()['team']['members']:
                        raise recruitment.failure(self.session, 'No research roles were recruited.', attempt=attempt,
                            code='RESEARCH_RECRUITMENT_INCOMPLETE')
                except TimeoutError as error:
                    await recruitment.abort_and_settle(self.session, intake_task)
                    failure = recruitment.failure(self.session, error, attempt=attempt, code='RESEARCH_RECRUITMENT_TIMEOUT')
                    recruitment.record(self.session, obj, 'failed', attempt=attempt, error=failure)
                    raise failure from error
                except asyncio.CancelledError:
                    await recruitment.abort_and_settle(self.session, intake_task)
                    failure = recruitment.failure(self.session, 'Research startup cancelled', attempt=attempt,
                        code='RESEARCH_STARTUP_CANCELLED')
                    recruitment.record(self.session, obj, 'failed', attempt=attempt, error=failure)
                    raise
                except Exception as error:  # noqa: BLE001 - preserve any native recruitment failure
                    failure = error if isinstance(error, submissions.ResearchInputError) else recruitment.failure(
                        self.session, error, attempt=attempt)
                    recruitment.record(self.session, obj, 'failed', attempt=attempt, error=failure)
                    raise failure from (None if failure is error else error)
                finally:
                    current_request_id.reset(token)
                    self.scene.intake = False
                recruitment.record(self.session, obj, 'completed', attempt=attempt)
                self.intake_requests.add(request_id)
            self.ingress.config = self.scope.current_config()
            return await self.ingress.send(obj, con)

    def _subscribe_model_events(self):
        def changed(binding):
            job = asyncio.create_task(self._emit('desktop-model-switch', binding=dict(binding)))
            self._event_jobs.add(job)
            job.add_done_callback(self._event_jobs.discard)
        self._unsubscribe_model_events = self.team.model_policy.subscribe(changed)

    async def set_team_model(self, provider, model_id, action='switch', role='all'):
        try:
            if action == 'cancel':
                await self.team.model_policy.cancel_switch(role=role)
            elif action in {'switch', 'retry'}:
                if role in {'sister', 'last_order'}:
                    # A role may have no live executor yet (for example Sisters
                    # while the plan awaits approval). Validate its selection
                    # without changing the other role's session/model.
                    registry = self.session.modelRegistry
                    refresh = getattr(registry, 'refresh', None)
                    if refresh:
                        await _maybe(refresh())
                    selected = registry.find(provider, model_id)
                    if selected is None:
                        raise ValueError(f'Team model is missing from the native registry: {provider}/{model_id}')
                    if read_field(selected, 'api') == 'moa' or provider == 'moa':
                        raise ValueError('Strict role binding requires a native physical model.')
                    if not await getattr(registry, "modelRuntime", registry).checkAuth(selected.provider):
                        raise ValueError(f'Team model credentials are missing: {provider}/{model_id}')
                binding = await self.team.model_policy.switch(provider, model_id, role=role)
                sister = self.team.model_policy.snapshot(role='sister')
                if binding['state'] == 'ready' and sister['state'] == 'ready':
                    pair = sister['effective']
                    self.team.pin_profiles(pair['provider'], pair['modelId'])
            else:
                raise ValueError('Unknown team model action')
            if role in {'last_order', 'all'} and self.team.model_policy.snapshot(role='last_order')['state'] == 'ready':
                self.session._desktop_network_context = None
        finally:
            # Subscribers report genuine persisted transitions, including failed targets.
            if self._event_jobs:
                await asyncio.gather(*tuple(self._event_jobs))
        return self.snapshot()

    async def set_team_thinking(self, level, *, role='last_order'):
        if role not in ('last_order', 'sister'):
            raise ValueError('Unknown desktop thinking role')
        if level not in ('off', 'minimal', 'low', 'medium', 'high', 'xhigh'):
            raise ValueError('Unknown thinking level')
        if role == 'last_order':
            if getattr(self.session, '_desktop_model_prepare', None) is not None:
                await self.scope.ensure_session(self.session,
                    self.team.model_policy.guard_model(role='last_order'))
            self.session.setThinkingLevel(level)
            level = self.session.thinkingLevel
        else:
            for session in self.scope.sessions.values():
                if getattr(session, '_desktop_model_role', None) == 'sister':
                    session.setThinkingLevel(level)
        self.team.set_role_thinking(role, level)
        return {'role': role, 'thinkingLevel': level}

    async def cancel_startup(self):
        """Cancel every owned startup and WAIT for it to settle (Task 2).

        task.cancel() only requests cancellation; the abort door must be able to treat the
        startup as stopped before it reports the cancel as settled. ``cancel_startup_now``
        below returns the gather results; this keeps the historical signature used by
        ``desktop_bridge`` while gaining the settle wait.
        """
        await self.scope.cancel_startup_now()

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
        await asyncio.to_thread(self.scope.card_control.stop_all)
        if self.manager:
            await self.manager.close()
        for session in list(self.scope.sessions.values()):
            await self.scope.release_session(session)
