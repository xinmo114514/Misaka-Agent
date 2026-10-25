"""Recruitment failures must retain the real cause and the immutable retry identity."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from misaka.core.research import submissions
from misaka.core.session_manager import SessionManager
from misaka.desktop_research import runtime


def coordinator(tmp_path, monkeypatch, outcomes, *, members=None):
    manager = SessionManager.create(str(tmp_path), str(tmp_path / 'sessions'))
    messages = []
    session = SimpleNamespace(sessionId=manager.getSessionId(), sessionManager=manager,
        model=SimpleNamespace(provider='fixture', id='research-model', baseUrl='http://localhost:45678/v1'),
        messages=messages, isStreaming=False, isIdle=True)
    team_members = members if members is not None else []
    replies = iter(outcomes)

    async def send(message, options):
        manager.appendCustomMessageEntry(message['customType'], message['content'], message['display'], message.get('details'))
        outcome = next(replies)
        if callable(outcome):
            await outcome(session, team_members)
        elif outcome is not None:
            messages.append({'role': 'assistant', 'stopReason': outcome[0], 'errorMessage': outcome[1],
                             'provider': 'fixture', 'model': 'research-model'})

    session.sendCustomMessage = send
    session.waitForIdle = AsyncMock()
    session.abort = AsyncMock()
    session._find_last_assistant_message = lambda: next((m for m in reversed(messages) if m['role'] == 'assistant'), None)
    controller = object.__new__(runtime.DesktopResearchController)
    controller.lock = asyncio.Lock()
    controller.session = session
    controller.scope = SimpleNamespace(current_config=dict, begin_launch_admission=lambda: None)
    controller.team = SimpleNamespace(snapshot=lambda: {'team': {'members': team_members}})
    controller.scene = SimpleNamespace(intake=False)
    controller.ingress = SimpleNamespace(starting=False, send=AsyncMock(return_value={'accepted': True, 'runId': 'r_fixture'}))
    controller.intake_requests = set()
    control = SimpleNamespace(accepting=True, catalog=SimpleNamespace(instance='instance-fixture'),
                              _owns=lambda command: True, _check_input_owner=lambda: None)
    from misaka.core import session_control
    monkeypatch.setattr(session_control, 'for_session', lambda s: control if s is session else None)
    monkeypatch.setattr(runtime, 'session_run', lambda *_: None)
    return controller


def request(controller):
    return {'sessionId': controller.session.sessionId, 'requestId': 'original-request',
            'text': 'Original question', 'startNew': True, 'limits': {'max_depth': 2, 'parallel': 1}}


@pytest.mark.parametrize('members', [[], [{'id': 'recruited-before-failure'}]])
async def test_model_error_precedes_empty_or_partial_team_check(tmp_path, monkeypatch, members):
    controller = coordinator(tmp_path, monkeypatch, [('error', 'All connection attempts failed')], members=members)
    with pytest.raises(submissions.ResearchInputError) as caught:
        await controller.send_message(request(controller), None)
    failure = caught.value
    assert failure.errorCode == 'RESEARCH_RECRUITMENT_MODEL_ERROR'
    assert failure.errorStage == 'recruitment'
    assert failure.errorDetails['message'] == 'All connection attempts failed'
    assert failure.errorDetails['role'] == 'last_order'
    assert failure.errorDetails['modelId'] == 'research-model'
    assert '提交' not in str(failure)
    assert controller.ingress.send.await_count == 0
    assert submissions.lookup(controller.session, 'original-request') is None
    records = [e['data'] for e in controller.session.sessionManager.getEntries()
               if e.get('customType') == 'desktop-recruitment']
    assert records[-1]['state'] == 'failed'
    assert records[0]['input'] == request(controller)
    assert sum('input' in row for row in records) == 1


async def test_same_id_retry_ignores_previous_error_and_keeps_one_intake(tmp_path, monkeypatch):
    async def success(session, members):
        members.append({'id': 'recruited'})
        session.messages.append({'role': 'assistant', 'stopReason': 'stop'})

    controller = coordinator(tmp_path, monkeypatch, [('error', 'Connection refused'), success])
    original = request(controller)
    with pytest.raises(submissions.ResearchInputError):
        await controller.send_message(original, None)
    assert await controller.send_message(original, None) == {'accepted': True, 'runId': 'r_fixture'}
    entries = controller.session.sessionManager.getEntries()
    assert sum(e.get('customType') == 'desktop-intake' for e in entries) == 1
    assert sum(e.get('customType') == 'desktop-intake-resume' for e in entries) == 1
    assert controller.ingress.send.await_count == 1
    assert controller.ingress.send.await_args.args[0] == original
    records = [e['data'] for e in entries if e.get('customType') == 'desktop-recruitment']
    assert max(row.get('attempt', 0) for row in records) == 2
    assert records[-1]['state'] == 'completed'


async def test_retry_checks_full_original_envelope_not_only_text(tmp_path, monkeypatch):
    controller = coordinator(tmp_path, monkeypatch, [('error', 'Connection refused'), ('stop', None)])
    original = request(controller)
    with pytest.raises(submissions.ResearchInputError):
        await controller.send_message(original, None)
    with pytest.raises(submissions.ResearchInputError) as caught:
        await controller.send_message({**original, 'limits': {'max_depth': 5, 'parallel': 1}}, None)
    assert caught.value.errorCode == 'RESEARCH_REQUEST_CONFLICT'
    assert controller.ingress.send.await_count == 0


async def test_error_from_old_turn_is_not_attributed_to_new_attempt(tmp_path, monkeypatch):
    controller = coordinator(tmp_path, monkeypatch, [None])
    controller.session.messages.append({'role': 'assistant', 'stopReason': 'error', 'errorMessage': 'old failure'})
    with pytest.raises(submissions.ResearchInputError) as caught:
        await controller.send_message(request(controller), None)
    assert caught.value.errorCode == 'RESEARCH_RECRUITMENT_INCOMPLETE'
    assert 'old failure' not in str(caught.value)


async def test_timeout_aborts_and_settles_before_exposing_retry(tmp_path, monkeypatch):
    async def hang(session, members):
        session.isStreaming = True
        await asyncio.Event().wait()

    controller = coordinator(tmp_path, monkeypatch, [hang])
    monkeypatch.setattr(runtime, 'RECRUITMENT_TURN_TIMEOUT_SECONDS', .03)

    async def abort():
        await asyncio.sleep(.01)
        controller.session.isStreaming = False

    controller.session.abort = AsyncMock(side_effect=abort)
    with pytest.raises(submissions.ResearchInputError) as caught:
        await controller.send_message(request(controller), None)
    assert caught.value.errorCode == 'RESEARCH_RECRUITMENT_TIMEOUT'
    assert controller.session.abort.await_count == 1
    assert controller.session.isStreaming is False


async def test_failure_history_restores_original_parameters_without_delivery_receipt(tmp_path, monkeypatch):
    from misaka.cli.desktop_bridge import _serialize_session_entries
    controller = coordinator(tmp_path, monkeypatch, [('error', 'Connection refused')])
    original = request(controller)
    with pytest.raises(submissions.ResearchInputError):
        await controller.send_message(original, None)
    messages = _serialize_session_entries(controller.session.sessionManager.getEntries())
    users = [m for m in messages if m['role'] == 'user']
    assert len(users) == 1
    assert users[0]['content'] == original['text']
    assert users[0]['researchSubmission'] == original
    assert users[0]['deliveryStatus'] == 'failed'
    assert users[0]['errorDetails']['message'] == 'Connection refused'


async def test_completed_intake_is_not_duplicated_by_history_projection(tmp_path, monkeypatch):
    from misaka.cli.desktop_bridge import _serialize_session_entries

    async def success(session, members):
        members.append({'id': 'recruited'})
        session.messages.append({'role': 'assistant', 'stopReason': 'stop'})

    controller = coordinator(tmp_path, monkeypatch, [success])
    original = request(controller)
    await controller.send_message(original, None)
    controller.session.sessionManager.appendCustomMessageEntry('research-question', original['text'], True,
        {'question': original['text'], 'requestId': original['requestId']})
    messages = _serialize_session_entries(controller.session.sessionManager.getEntries())
    assert sum((m.get('requestId') or (m.get('details') or {}).get('requestId')) == original['requestId'] and
               (m['role'] == 'user' or m.get('customType') == 'research-question') for m in messages) == 1


def test_legacy_failed_intake_is_visible_but_does_not_invent_parameters(tmp_path):
    from misaka.cli.desktop_bridge import _serialize_session_entries
    manager = SessionManager.create(str(tmp_path), str(tmp_path / 'sessions'))
    manager.appendCustomMessageEntry('desktop-intake', 'legacy question', False, {'requestId': 'legacy-id'})
    manager.appendMessage({'role': 'assistant', 'content': [], 'stopReason': 'error', 'errorMessage': 'Network error',
                           'provider': 'fixture', 'model': 'fixture', 'api': 'fixture', 'timestamp': 1, 'usage': {}})
    messages = _serialize_session_entries(manager.getEntries())
    assert messages[0]['role'] == 'user'
    assert messages[0]['content'] == 'legacy question'
    assert messages[0]['deliveryStatus'] == 'failed'
    assert messages[0].get('researchSubmission') is None
    assert messages[0]['researchNeedsConfiguration'] is True


def test_provider_details_mask_proxy_password_even_when_echoed_outside_url():
    from misaka.desktop_research.recruitment import failure
    session = SimpleNamespace(model=SimpleNamespace(provider='fixture', id='model', baseUrl='https://model.invalid/v1'),
        _desktop_network_context={'endpoint': 'https://model.invalid/v1',
            'env': {'https_proxy': 'http://fixture-user:fixture-password@proxy.invalid:38127', 'no_proxy': ''}})
    error = failure(session, 'Connection failed: password fixture-password at http://fixture-user:fixture-password@proxy.invalid:38127', attempt=1)
    assert 'fixture-password' not in str(error.errorDetails)
    assert error.errorDetails['route']['mode'] == 'proxy'
    assert error.errorDetails['category'] == 'network'
    assert '代理失败' not in str(error)


@pytest.mark.parametrize('cancel', [False, True])
async def test_timeout_signals_abort_before_cancelling_intake_finalizer(tmp_path, monkeypatch, cancel):
    finalizer_released = asyncio.Event()
    entered = asyncio.Event()

    async def hang_until_abort(session, members):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            await finalizer_released.wait()

    controller = coordinator(tmp_path, monkeypatch, [hang_until_abort])
    monkeypatch.setattr(runtime, 'RECRUITMENT_TURN_TIMEOUT_SECONDS', 10 if cancel else .01)
    controller.session.abort = AsyncMock(side_effect=finalizer_released.set)
    task = asyncio.create_task(controller.send_message(request(controller), None))
    await asyncio.wait_for(entered.wait(), timeout=1)
    if cancel:
        task.cancel()
    done, _ = await asyncio.wait({task}, timeout=.2)
    try:
        assert task in done, 'Timeout cancellation waited for a finalizer before sending abort'
        if cancel:
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            with pytest.raises(submissions.ResearchInputError) as caught:
                await task
            assert caught.value.errorCode == 'RESEARCH_RECRUITMENT_TIMEOUT'
        assert controller.session.abort.await_count == 1
    finally:
        finalizer_released.set()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


def test_journal_alone_is_durable_and_restores_pre_intake_failures(tmp_path):
    from pathlib import Path

    from misaka.cli.desktop_bridge import _serialize_session_entries
    from misaka.desktop_research import recruitment
    manager = SessionManager.create(str(tmp_path), str(tmp_path / 'sessions'))
    session = SimpleNamespace(sessionId=manager.getSessionId(), sessionManager=manager,
        model=SimpleNamespace(provider='fixture', id='model', baseUrl='http://localhost:38127/v1'))
    original = {'sessionId': session.sessionId, 'requestId': 'early-failure', 'text': 'Original early question',
                'limits': {'max_depth': 2}, 'startNew': True}
    recruitment.record(session, original, 'preparing', attempt=1)
    error = recruitment.failure(session, ValueError('pre-intake failure'), attempt=1)
    recruitment.record(session, original, 'failed', attempt=1, error=error)
    assert Path(manager.sessionFile).is_file()
    reopened = SessionManager.open(manager.sessionFile)
    users = [m for m in _serialize_session_entries(reopened.getEntries()) if m['role'] == 'user']
    assert len(users) == 1
    assert users[0]['content'] == original['text']
    assert users[0]['researchSubmission'] == original
    assert users[0]['deliveryStatus'] == 'failed'


def test_proxy_407_is_not_classified_as_model_authentication():
    from misaka.desktop_research.recruitment import failure
    session = SimpleNamespace(model=SimpleNamespace(provider='fixture', id='model', baseUrl='http://localhost:38127'))
    error = failure(session, 'Proxy authentication required (407)', attempt=1)
    assert error.errorDetails['category'] == 'proxy'


async def test_committed_coordinator_switch_drops_previous_request_network_context():
    from misaka.desktop_research.recruitment import network_context
    session = SimpleNamespace(model=SimpleNamespace(provider='old', id='old', baseUrl='http://old.invalid/v1'),
        _desktop_network_context={'endpoint': 'http://old.invalid/v1', 'env': {'http_proxy': 'http://old-proxy.invalid:3128'}})
    new_model = SimpleNamespace(provider='new', id='new', baseUrl='http://new.invalid/v1')

    async def switch(provider, model_id, role):
        session.model = new_model
        return {'state': 'ready', 'effective': {'provider': provider, 'modelId': model_id}}

    session.modelRegistry = SimpleNamespace(find=lambda *_: new_model, checkConfiguredAuth=AsyncMock(return_value=True))
    controller = object.__new__(runtime.DesktopResearchController)
    controller.session = session
    controller.team = SimpleNamespace(model_policy=SimpleNamespace(switch=switch,
        snapshot=lambda **_: {'state': 'ready', 'effective': {'provider': 'sister', 'modelId': 'sister'}}), pin_profiles=lambda *_: None)
    controller._event_jobs = set()
    controller.snapshot = dict
    await controller.set_team_model('new', 'new', role='last_order')
    assert network_context(session) == ('http://new.invalid/v1', None)


def test_reopened_diagnostic_reads_stored_env_and_pure_oauth_endpoint_without_refresh(monkeypatch):
    from misaka.ai.utils import oauth
    from misaka.core.auth_storage import AuthStorage
    from misaka.desktop_research.recruitment import network_context
    storage = AuthStorage.inMemory()
    storage.set('fixture', {'type': 'oauth', 'access': 'fixture-access', 'refresh': 'fixture-refresh', 'expires': 0,
                            'enterpriseUrl': 'http://enterprise.invalid:31271/v1',
                            'env': {'https_proxy': 'http://proxy.invalid:38129'}})
    flow = SimpleNamespace(getBaseUrl=lambda credentials: credentials.enterpriseUrl)
    monkeypatch.setattr(oauth, 'getOAuthProvider', lambda provider: flow)
    session = SimpleNamespace(model=SimpleNamespace(provider='fixture', id='fixture', baseUrl='https://placeholder.invalid'),
        modelRegistry=SimpleNamespace(authStorage=storage))
    assert network_context(session) == ('http://enterprise.invalid:31271/v1', {'https_proxy': 'http://proxy.invalid:38129'})


@pytest.mark.parametrize('legacy', [False, True])
def test_session_summary_identifies_desktop_research_before_a_run_exists(tmp_path, legacy):
    from misaka.cli.desktop_bridge import _serialize_session_info
    from misaka.core.session_manager import _build_session_info_uncached
    from misaka.desktop_research import recruitment
    manager = SessionManager.create(str(tmp_path), str(tmp_path / 'sessions'))
    session = SimpleNamespace(sessionId=manager.getSessionId(), sessionManager=manager)
    if legacy:
        manager.appendCustomMessageEntry('desktop-intake', 'Original failed topic', False, {'requestId': 'legacy'})
    else:
        recruitment.record(session, {'sessionId': session.sessionId, 'requestId': 'new',
            'text': 'Original failed topic', 'limits': {'max_depth': 5}}, 'preparing', attempt=1)
    summary = _serialize_session_info(_build_session_info_uncached(manager.sessionFile))
    assert summary['desktopResearch'] is True
    assert summary['firstMessage'] == 'Original failed topic'
    assert summary['messageCount'] >= 1
    assert summary['id'] == session.sessionId


def test_ordinary_session_summary_does_not_get_research_marker(tmp_path):
    from misaka.cli.desktop_bridge import _serialize_session_info
    from misaka.core.session_manager import _build_session_info_uncached
    manager = SessionManager.create(str(tmp_path), str(tmp_path / 'sessions'))
    manager.appendCustomMessageEntry('ordinary-fixture', 'Ordinary note', True)
    summary = _serialize_session_info(_build_session_info_uncached(manager.sessionFile))
    assert not summary.get('desktopResearch')


def test_unreadable_route_metadata_does_not_replace_the_original_model_error():
    from misaka.desktop_research.recruitment import failure

    def unreadable():
        raise OSError('fixture policy file temporarily unavailable')

    session = SimpleNamespace(model=SimpleNamespace(provider='fixture', id='model', baseUrl='https://model.invalid'),
        modelRegistry=SimpleNamespace(find=lambda *_: None),
        _desktop_model_policy=SimpleNamespace(snapshot=unreadable))
    error = failure(session, 'All connection attempts failed', attempt=1)
    assert error.errorStage == 'recruitment'
    assert error.errorDetails['message'] == 'All connection attempts failed'
