"""Append-only research delivery receipts, separate from model-visible messages.

An intent entry is not a preflight receipt. Unknown crash windows are reported,
never automatically replayed. Existing JSONL custom entries carry these records.
"""
from __future__ import annotations

import hashlib
import json
import logging
import traceback
from copy import deepcopy
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from misaka.utils.values import read_field

logger = logging.getLogger(__name__)
KIND = 'research-delivery'
try:
    RUNTIME_VERSION = version('misaka')
except PackageNotFoundError:
    RUNTIME_VERSION = 'development'
try:
    DIAGNOSTIC_BUILD = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()[:12]
except OSError:
    # A bytecode-only or frozen install has no readable source file next to the module.
    DIAGNOSTIC_BUILD = 'unknown'

class ResearchInputError(ValueError):
    def __init__(self, message, code, *, stage='validation', retryable=True):
        super().__init__(message)
        self.errorCode, self.errorStage, self.retryable = code, stage, retryable


# A retried input that names an already used requestId must never look retryable: the
# desktop would replay an intent the engine has already recorded under a different input.
REQUEST_CONFLICT_MESSAGE = '该请求标识属于另一条研究输入，请重新发送。'


def request_conflict():
    return ResearchInputError(REQUEST_CONFLICT_MESSAGE, 'RESEARCH_REQUEST_CONFLICT', retryable=False)


# Receipts carry codes, never exception text; the desktop renders these fixed strings.
ERROR_MESSAGES = {
    'RESEARCH_STARTUP_FAILED': '研究启动失败，原始问题已记录，可重试。',
    'RESEARCH_STARTUP_CANCELLED': '研究启动已取消，原始问题已保留。',
    'RESEARCH_PREFLIGHT_FAILED': '研究消息未通过前置校验，原始内容已保留。',
    'RESEARCH_DELIVERY_UNCONFIRMED': '发送结果尚未确认，请先核对研究记录。',
    'RESEARCH_REQUEST_CONFLICT': REQUEST_CONFLICT_MESSAGE,
    'RESEARCH_SESSION_CHANGED': '研究会话已变更，请刷新后重试。',
    'RESEARCH_STREAM_CHANGED': '研究连接已变更，请重新打开原研究会话。',
    'RESEARCH_TEXT_TYPE': '研究消息需要文字内容；原始草稿已保留。',
    'RESEARCH_TEXT_EMPTY': '请先输入研究问题或补充内容。',
    'RESEARCH_CONTROL_REQUIRED': '请通过研究控制入口执行命令；正文仍保留在草稿中。',
    'RESEARCH_REQUEST_ID': '研究请求缺少标识，请重新发送。',
    'RESEARCH_SUBMISSION_FAILED': '研究消息暂未接收，请检查连接后重试。',
}


def input_metadata(obj, *, stage, session_id=None, stream_id=None, model=None):
    """Diagnostic whitelist: no prompt text, attachments, credentials or headers."""
    text = obj.get('text')
    return {'stage': stage, 'runtimeVersion': RUNTIME_VERSION, 'diagnosticBuild': DIAGNOSTIC_BUILD,
            'requestId': str(obj.get('requestId') or '')[:128],
            'sessionId': str(session_id or obj.get('sessionId') or '')[:128],
            'streamId': str(stream_id or '')[:128], 'textType': type(text).__name__,
            'chars': len(text) if isinstance(text, str) else None,
            'blank': not text.strip() if isinstance(text, str) else None,
            'startsWithSlash': text.lstrip().startswith('/') if isinstance(text, str) else None,
            **({key: str(read_field(model, source) or '')[:160]
                for key, source in (('provider', 'provider'), ('modelId', 'id'), ('api', 'api'))} if model else {})}


def trace_input(obj, *, stage, session_id=None, stream_id=None, model=None):
    """Record where one submission entered, so a requestId can be followed across stages.

    The root file handler sits at WARNING (``misaka/config/engine.py``), so an INFO line
    never reaches ``<MISAKA_HOME>/logs/misaka.log`` -- a start that hung left no trace at
    all. The receipt itself is a warning-level, metadata-only record: ``input_metadata``
    keeps request/session/stream identity, text shape and the model reference, and carries
    no prompt body, attachment, header or credential.
    """
    logger.warning('research_submission %s', json.dumps(input_metadata(
        obj, stage=stage, session_id=session_id, stream_id=stream_id, model=model), ensure_ascii=True))


def trace_failure(obj, error, *, session_id=None, stream_id=None, model=None):
    metadata = input_metadata(obj, stage='failure', session_id=session_id, stream_id=stream_id, model=model)
    known = isinstance(error, ResearchInputError)
    metadata.update(errorClass=type(error).__name__,
                    errorCode=error.errorCode if known else 'RESEARCH_SUBMISSION_FAILED',
                    errorStage=error.errorStage if known else 'submission',
                    frames=[{'file': Path(frame.filename).name, 'line': frame.lineno, 'function': frame.name}
                            for frame in traceback.extract_tb(error.__traceback__)[-8:]])
    logger.warning('research_submission %s', json.dumps(metadata, ensure_ascii=True))


def text_fingerprint(text):
    # A lone surrogate reaches here through json.loads of a bridge payload; the transcript
    # writer already tolerates it, so the identity hash must not be the first thing to raise.
    return hashlib.sha256(text.strip().encode('utf-8', 'surrogatepass')).hexdigest()


def entries(session):
    manager = getattr(session, 'sessionManager', None)
    return manager.getEntries() if manager is not None and hasattr(manager, 'getEntries') else []


def receipts_from_entries(source, session_id=None):
    latest = {}
    for entry in source:
        if entry.get('type') != 'custom' or entry.get('customType') != KIND:
            continue
        data = entry.get('data')
        if (isinstance(data, dict) and data.get('version') == 1
                and isinstance(data.get('requestId'), str)
                and (session_id is None or data.get('sessionId') == session_id)):
            latest[data['requestId']] = {**latest.get(data['requestId'], {}), **data}
    return list(latest.values())


def receipts(session):
    return receipts_from_entries(entries(session), session.sessionId)


def lookup(session, request_id):
    return next((row for row in reversed(receipts(session)) if row['requestId'] == request_id), None)


def record(session, request_id, state, **fields):
    previous = lookup(session, request_id) or {}
    if previous.get('state') == 'applied' and state != 'applied':
        return previous
    data = {**previous, **fields, 'version': 1, 'sessionId': session.sessionId,
            'requestId': request_id, 'state': state}
    manager = getattr(session, 'sessionManager', None)
    if manager is not None and hasattr(manager, 'appendCustomEntry') and data != previous:
        # Store the long original envelope once; subsequent state transitions are deltas.
        delta = {key: value for key, value in data.items() if key not in previous or previous[key] != value}
        delta.update(version=1, sessionId=session.sessionId, requestId=request_id, state=state)
        manager.appendCustomEntry(KIND, deepcopy(delta))
    return data


def recorded_input(session, request_id, kind):
    return next((entry for entry in reversed(entries(session))
                 if entry.get('type') == 'custom_message' and entry.get('customType') == kind
                 and (entry.get('details') or {}).get('requestId') == request_id), None)


def native_delivery(session, delivery_id):
    if not delivery_id:
        return None
    return next((entry for entry in reversed(entries(session))
                 if entry.get('type') == 'message'
                 and read_field(entry.get('message'), 'deliveryId') == delivery_id), None)


def assert_identity(receipt, text, requested_run_id, *, control_action=None, limits=None, start_new=False):
    valid_runs = {receipt.get('initialRunId'), receipt.get('runId')}
    if (receipt.get('textHash') != text_fingerprint(text)
            or requested_run_id not in valid_runs
            or receipt.get('controlAction') != control_action
            or receipt.get('limits') != limits
            or bool((receipt.get('input') or {}).get('startNew')) != bool(start_new)):
        raise request_conflict()


def public_receipts(session):
    from misaka.core import session_control
    control = session_control.for_session(session)
    keys = ('requestId', 'state', 'runId', 'mode', 'entryId', 'errorCode', 'errorStage', 'retryable')
    output = []
    for row in receipts(session):
        delivery = native_delivery(session, row.get('deliveryId'))
        projected = {key: row[key] for key in keys if key in row and (key == 'runId' or row[key] is not None)}
        if row.get('state') in {'prepared', 'unconfirmed'} and delivery:
            projected.update(state='applied', entryId=delivery.get('id'))
        elif (row.get('state') == 'accepted' and row.get('mode') in {'steer', 'followUp'} and not delivery
              and (control is None or row.get('instance') != control.catalog.instance)):
            projected['state'] = 'unconfirmed'
            projected['retryable'] = False
        if projected.get('state') in {'rejected', 'unconfirmed'}:
            projected['error'] = ERROR_MESSAGES.get(projected.get('errorCode') or '',
                                                    ERROR_MESSAGES['RESEARCH_SUBMISSION_FAILED'])
        output.append(projected)
    return output


def original_input(obj):
    return deepcopy({key: obj[key] for key in ('text', 'sessionId', 'requestId', 'runId', 'limits', 'startNew') if key in obj})
