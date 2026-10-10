"""Submission identity stays in native history, never in provider payloads."""
import asyncio
import io
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from misaka.ai.providers.openai_completions import convert_messages, get_compat
from misaka.ai.types import Model, TranscriptContext, validate_message
from misaka.core.agent_session import AgentSession
from misaka.core.session_control import SessionControl


def test_user_delivery_identity_survives_native_validation_but_not_provider_wire():
    session = object.__new__(AgentSession)
    message = session._build_user_message('正文\n\n1. 证据', request_id='input-1', delivery_id='research:s:input-1')
    native = validate_message(message)
    assert native.requestId == 'input-1'
    assert native.deliveryId == 'research:s:input-1'
    model = Model(id='fixture', name='fixture', api='openai-completions', provider='deepseek',
                  baseUrl='https://fixture.invalid', reasoning=False, input=['text'],
                  contextWindow=64000, maxTokens=1024,
                  cost={'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0})
    wire = convert_messages(model, TranscriptContext(messages=[native]), get_compat(model))
    assert wire == [{'role': 'user', 'content': [{'type': 'text', 'text': '正文\n\n1. 证据'}]}]


async def test_session_control_preserves_followup_mode_and_delivery_identity(tmp_path):
    record = tmp_path / 'owner.json'
    record.write_text(json.dumps({'id': 's', 'instance': 'owner'}), encoding='utf-8')
    session = SimpleNamespace(sessionId='s')
    received = []

    async def prompt(text, options):
        received.append((text, options))
        options['preflightResult'](True)

    session.prompt = prompt
    control = SessionControl(session, SimpleNamespace(instance='owner', record=str(record), spec=None))
    try:
        await control._execute({'operation': 'input', 'session': 's', 'instance': 'owner',
                                'text': '补充', 'requestId': 'input',
                                'deliveryId': 'research:s:input', 'streamingBehavior': 'followUp'})
        await asyncio.gather(*control.inputs)
        assert received[0][1]['streamingBehavior'] == 'followUp'
        assert received[0][1]['requestId'] == 'input'
        assert received[0][1]['deliveryId'] == 'research:s:input'
    finally:
        control.close()


def test_research_host_exposes_receipts_without_private_fingerprints():
    from misaka.cli.desktop_bridge import research_host_payload
    from misaka.core.research import submissions
    from misaka.core.session_manager import SessionManager
    manager = SessionManager.inMemory('C:/fixture')
    session = SimpleNamespace(sessionId=manager.getSessionId(), sessionManager=manager,
                              moments=SimpleNamespace(parts=[]), getSessionStats=dict, getContextUsage=dict)
    submissions.record(session, 'input', 'prepared', textHash='private', mode='resume', runId='r_fixture')
    snapshot = research_host_payload(session)
    assert snapshot['submissionReceipts'] == [{'requestId': 'input', 'state': 'prepared',
                                              'mode': 'resume', 'runId': 'r_fixture'}]


def test_history_serializer_keeps_request_identity_on_native_user_messages():
    from misaka.cli.desktop_bridge import _serialize_session_entries
    messages = _serialize_session_entries([{'type': 'message', 'id': 'native-user', 'timestamp': 1,
        'message': {'role': 'user', 'content': '中文', 'timestamp': 1,
                    'requestId': 'input', 'deliveryId': 'research:s:input'}}])
    assert messages[0]['requestId'] == 'input'


def test_submission_diagnostics_log_shapes_not_prompt_or_credentials(caplog):
    from misaka.core.research import submissions
    caplog.set_level('INFO', logger=submissions.__name__)
    submissions.trace_input({'text': 'PRIVATE_PROMPT_正文', 'requestId': 'input', 'sessionId': 's',
                             'apiKey': 'SECRET_KEY', 'images': ['SECRET_IMAGE']}, stage='controller')
    assert 'PRIVATE_PROMPT' not in caplog.text and 'SECRET' not in caplog.text
    assert 'textType' in caplog.text and 'chars' in caplog.text


@pytest.mark.parametrize('structured', [True, False])
async def test_bridge_returns_structured_correlated_error_not_provider_secrets(monkeypatch, caplog, structured):
    from test_desktop_bridge import MockRuntimeHost

    from misaka.cli import desktop_bridge as bridge
    from misaka.core.research import submissions

    async def fail(_self, _obj, _con):
        if structured:
            raise submissions.ResearchInputError('草稿已保留', 'RESEARCH_TEXT_TYPE')
        error = ValueError('SECRET_PROVIDER_AUTH_DATA')
        error.errorCode = 'SECRET_PROVIDER_CODE'
        error.errorStage = 'SECRET_PROVIDER_STAGE'
        raise error

    monkeypatch.setattr(bridge.ResearchMessageIngress, 'send', fail)
    caplog.set_level('INFO', logger=submissions.__name__)
    output = io.StringIO()
    monkeypatch.setattr(bridge, 'writeRawStdout', output.write)
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({
        'type': 'send_research_message', 'requestId': 'input', 'sessionId': 'test-session-123',
        'text': 'PRIVATE_PROMPT'}) + '\n'))
    await bridge.run_desktop_bridge(MockRuntimeHost())
    ack = next(row for row in map(json.loads, output.getvalue().splitlines()) if row.get('requestId') == 'input')
    assert ack['errorCode'] == ('RESEARCH_TEXT_TYPE' if structured else 'RESEARCH_SUBMISSION_FAILED')
    assert ack['errorStage'] == ('validation' if structured else 'submission')
    assert ack['sessionId'] == 'test-session-123' and ack['streamId']
    assert 'PRIVATE_PROMPT' not in json.dumps(ack)
    assert 'SECRET_PROVIDER' not in json.dumps(ack) and 'SECRET_PROVIDER' not in caplog.text


def test_prepared_receipt_is_durable_before_native_input_starts(tmp_path):
    from misaka.core.research import submissions
    from misaka.core.session_manager import SessionManager
    manager = SessionManager.create(str(tmp_path), str(tmp_path / 'sessions'))
    session = SimpleNamespace(sessionId=manager.getSessionId(), sessionManager=manager)
    submissions.record(session, 'crash-window', 'prepared', textHash='hash', mode='start')
    assert Path(manager.sessionFile).is_file()
    reopened = SessionManager.open(manager.sessionFile)
    assert submissions.lookup(SimpleNamespace(sessionId=session.sessionId, sessionManager=reopened),
                              'crash-window')['state'] == 'prepared'
    assert reopened.buildSessionContext().messages == []


def test_snapshot_does_not_claim_a_lost_in_memory_queue_was_applied(tmp_path):
    from misaka.core.research import submissions
    from misaka.core.session_manager import SessionManager
    manager = SessionManager.inMemory(str(tmp_path))
    session = SimpleNamespace(sessionId=manager.getSessionId(), sessionManager=manager,
                              moments=SimpleNamespace(parts=[]))
    submissions.record(session, 'queued', 'accepted', mode='followUp', instance='old-host',
                       deliveryId='research:s:queued')
    assert submissions.public_receipts(session)[0]['state'] == 'unconfirmed'


def test_unconfirmed_receipt_recovers_from_persisted_native_delivery(tmp_path):
    from misaka.core.research import submissions
    from misaka.core.session_manager import SessionManager
    manager = SessionManager.inMemory(str(tmp_path))
    session = SimpleNamespace(sessionId=manager.getSessionId(), sessionManager=manager,
                              moments=SimpleNamespace(parts=[]))
    submissions.record(session, 'queued', 'unconfirmed', mode='followUp', deliveryId='research:s:queued')
    entry_id = manager.appendMessage({'role': 'user', 'content': '补充', 'timestamp': 1,
                                     'requestId': 'queued', 'deliveryId': 'research:s:queued'})
    assert submissions.public_receipts(session)[0]['state'] == 'applied'
    assert submissions.public_receipts(session)[0]['entryId'] == entry_id


def test_snapshot_history_restores_original_start_parameters_after_renderer_reload():
    from misaka.cli.desktop_bridge import _serialize_session_entries
    original = {'text': '中文研究问题', 'sessionId': 's', 'requestId': 'first',
                'limits': {'max_depth': 2, 'plan_approval': False}}
    history = _serialize_session_entries([
        {'type': 'custom', 'customType': 'research-delivery', 'id': 'receipt', 'data': {
            'version': 1, 'sessionId': 's', 'requestId': 'first', 'state': 'prepared', 'input': original}},
        {'type': 'custom', 'customType': 'research-delivery', 'id': 'receipt-end', 'data': {
            'version': 1, 'sessionId': 's', 'requestId': 'first', 'state': 'rejected'}},
        {'type': 'custom_message', 'id': 'question', 'customType': 'research-question',
         'timestamp': 1, 'display': True, 'content': 'Research question | 中文研究问题',
         'details': {'question': '中文研究问题', 'requestId': 'first'}},
    ])
    assert len(history) == 1
    assert history[0]['researchSubmission'] == original


def test_host_reconstructs_input_from_full_history_not_compaction_projection(tmp_path):
    from misaka.cli.desktop_bridge import research_host_payload
    from misaka.core.research import submissions
    from misaka.core.session_manager import SessionManager
    manager = SessionManager.inMemory(str(tmp_path))
    session = SimpleNamespace(sessionId=manager.getSessionId(), sessionManager=manager,
                              moments=SimpleNamespace(parts=[]), getSessionStats=dict, getContextUsage=dict)
    original = {'text': '原问题', 'sessionId': session.sessionId, 'requestId': 'compacted',
                'limits': {'max_depth': 2}}
    submissions.record(session, 'compacted', 'prepared', input=original)
    manager.appendCustomMessageEntry('research-question', 'Research question | 原问题', True,
                                    {'question': '原问题', 'requestId': 'compacted'})
    submissions.record(session, 'compacted', 'rejected', retryable=True)
    kept = manager.getEntries()[1:]
    manager.buildContextEntries = lambda: kept
    snapshot = research_host_payload(session)
    assert snapshot['messages'][0]['researchSubmission'] == original


def test_delivery_identity_is_claimed_only_once_the_message_is_written(tmp_path):
    """A turn that dies before its user message lands must stay retryable under the same deliveryId."""
    from misaka.core.session_manager import SessionManager
    manager = SessionManager.inMemory(str(tmp_path))
    session = object.__new__(AgentSession)
    session.sessionManager = manager
    session._promptDeliveryIds = set()
    message = session._build_user_message('研究正文', None, request_id='input-1',
                                          delivery_id='research:s:input-1')
    assert 'research:s:input-1' not in session._promptDeliveryIds
    session._persist_message(message)
    assert 'research:s:input-1' in session._promptDeliveryIds


def test_text_fingerprint_survives_a_lone_surrogate():
    from misaka.core.research import submissions
    broken = '研究问题\ud800尾巴'
    digest = submissions.text_fingerprint(broken)
    assert digest == submissions.text_fingerprint(broken)
    assert digest != submissions.text_fingerprint('研究问题\ud801尾巴')


def test_rejected_receipt_projects_a_fixed_reason_and_never_the_prompt(tmp_path):
    from misaka.core.research import submissions
    from misaka.core.session_manager import SessionManager
    manager = SessionManager.inMemory(str(tmp_path))
    session = SimpleNamespace(sessionId=manager.getSessionId(), sessionManager=manager,
                              moments=SimpleNamespace(parts=[]))
    submissions.record(session, 'startup-fail', 'prepared', textHash='hash', mode='start',
                       input={'text': 'PRIVATE_PROMPT_正文', 'requestId': 'startup-fail'})
    submissions.record(session, 'startup-fail', 'rejected', errorCode='RESEARCH_STARTUP_FAILED',
                       errorStage='startup', retryable=True)
    receipt = submissions.public_receipts(session)[0]
    assert receipt['error'] == submissions.ERROR_MESSAGES['RESEARCH_STARTUP_FAILED']
    assert receipt['state'] == 'rejected'
    assert 'PRIVATE_PROMPT' not in json.dumps(receipt, ensure_ascii=False)
