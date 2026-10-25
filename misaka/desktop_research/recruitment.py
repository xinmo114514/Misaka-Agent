"""Durable intake attempts, separate from native delivery receipts and model output."""
from __future__ import annotations

import asyncio
import re
import time
import traceback
from copy import deepcopy

from misaka.core.research import submissions
from misaka.utils.redact import redact
from misaka.utils.values import read_field

KIND = 'desktop-recruitment'


def records(entries):
    latest = {}
    for entry in entries:
        data = entry.get('data')
        if (entry.get('type') == 'custom' and entry.get('customType') == KIND
                and isinstance(data, dict) and data.get('version') == 1 and data.get('requestId')):
            key = data['requestId']
            latest[key] = {**latest.get(key, {}), **data}
    return latest


def record(session, obj, state, *, attempt, error=None):
    previous = records(submissions.entries(session)).get(obj['requestId'], {})
    data = {**previous, 'version': 1, 'requestId': obj['requestId'], 'sessionId': session.sessionId,
            'input': submissions.original_input(obj), 'state': state, 'attempt': attempt,
            'createdAt': previous.get('createdAt', int(time.time() * 1000)),
            'updatedAt': int(time.time() * 1000)}
    if error is not None:
        data.update(error=str(error), errorCode=error.errorCode, errorDetails=error.errorDetails,
                    retryable=error.retryable)
    elif state in {'preparing', 'completed'}:
        data.update(error=None, errorCode=None, errorDetails=None)
    manager = getattr(session, 'sessionManager', None)
    if manager is not None and hasattr(manager, 'appendCustomEntry'):
        delta = {key: value for key, value in data.items() if key not in previous or previous[key] != value}
        delta.update(version=1, requestId=obj['requestId'])
        manager.appendCustomEntry(KIND, deepcopy(delta))
    return data


def original_attempt(session, obj):
    previous = records(submissions.entries(session)).get(obj['requestId'])
    if previous and previous.get('input') != submissions.original_input(obj):
        raise submissions.request_conflict()
    return previous or {}


def network_context(session, *, use_cached=True):
    """Use the effective request endpoint/env, never keys or a guessed service address."""
    context = (getattr(session, '_desktop_network_context', None) or {}) if use_cached else {}
    model = getattr(session, 'model', None)
    registry = getattr(session, 'modelRegistry', None)
    policy = getattr(session, '_desktop_model_policy', None)
    if policy is not None and registry is not None:
        from .model_policy import DesktopRoleModelPolicy
        binding = (policy.snapshot(role='last_order') if isinstance(policy, DesktopRoleModelPolicy)
                   else policy.snapshot())['effective']
        model = registry.find(binding['provider'], binding['modelId']) or model
    if context and (context.get('provider', read_field(model, 'provider')) != read_field(model, 'provider')
                    or context.get('modelId', read_field(model, 'id')) != read_field(model, 'id')
                    or context.get('modelBaseUrl', read_field(model, 'baseUrl')) != read_field(model, 'baseUrl')):
        context = {}
    endpoint = context.get('endpoint') or read_field(model, 'baseUrl') or ''
    env = context.get('env')
    if not context and registry is not None:
        storage = getattr(registry, 'authStorage', None)
        provider = read_field(model, 'provider')
        # Read only the already-loaded credential configuration. Never resolve/refresh
        # authentication or run a provider request merely to check a TCP endpoint.
        stored = storage.get(provider) if storage is not None and not storage.runtimeOverrides.get(provider) else None
        if isinstance(stored, dict):
            env = stored.get('env')
            if stored.get('type') == 'oauth':
                from misaka.ai.utils.oauth import getOAuthProvider
                from misaka.ai.utils.oauth.types import OAuthCredentials
                flow = getOAuthProvider(provider)
                get_base = getattr(flow, 'getBaseUrl', None)
                if callable(get_base):
                    endpoint = get_base(OAuthCredentials.model_validate({k: v for k, v in stored.items() if k != 'type'})) or endpoint
    if not endpoint and read_field(model, 'api') == 'openai-codex-responses':
        from misaka.ai.providers.openai_codex_responses import resolve_codex_url
        endpoint = resolve_codex_url()
    return endpoint, env


def latest_network_context(session):
    """Current model route for an explicit check, ignoring a prior failed request."""
    from misaka.config.proxy_settings import proxy_request_env

    endpoint, env = network_context(session, use_cached=False)
    return endpoint, proxy_request_env(env)


def _error_network_context(session):
    """Optional routing diagnostics must never mask the primary provider failure."""
    try:
        return network_context(session)
    except (AttributeError, KeyError, OSError, TypeError, ValueError):
        return '', None


def _clean(session, value):
    from urllib.parse import unquote, urlsplit

    from misaka.ai.utils.network_route import (
        resolve_network_route,
        sanitize_network_error,
        snapshot_network_env,
    )
    endpoint, env = _error_network_context(session)
    secrets = [secret for secret in (getattr(session, '_desktop_network_context', None) or {}).get('secrets', ())
               if isinstance(secret, str) and secret]
    for name, raw in snapshot_network_env(env).items():
        if name.endswith('_proxy') and name != 'no_proxy' and isinstance(raw, str) and '@' in raw:
            try:
                parsed = urlsplit(raw if '://' in raw else 'http://' + raw)
                secrets.extend(unquote(value) for value in (parsed.username, parsed.password) if value)
            except ValueError:
                secrets.append(raw)
    try:
        route = resolve_network_route(endpoint, env) if endpoint else None
    except ValueError:
        route = None
    text = sanitize_network_error(value, route, secrets=tuple(secrets))
    # Error URLs may echo signed queries; the diagnostic endpoint intentionally has none.
    text = re.sub(r'(?i)(https?|socks5h?)://[^\s/@]+:[^\s/@]+@', r'\1://[redacted]@', text)
    text = re.sub(r'(?i)([?&](?:key|api_key|token|access_token|secret|signature|sig)=)[^&\s]+',
                  r'\1[redacted]', text)
    return redact(text)[:24000]


def _clean_tree(session, value, depth=0):
    if depth > 6:
        return '[truncated]'
    if isinstance(value, dict):
        return {str(k): _clean_tree(session, v, depth + 1) for k, v in list(value.items())[:32]}
    if isinstance(value, list):
        return [_clean_tree(session, v, depth + 1) for v in value[:32]]
    return _clean(session, value) if isinstance(value, str) else value


def failure(session, source, *, attempt, code='RESEARCH_RECRUITMENT_MODEL_ERROR'):
    model = getattr(session, 'model', None)
    provider, model_id = read_field(model, 'provider'), read_field(model, 'id')
    policy = getattr(session, '_desktop_model_policy', None)
    if policy is not None:
        try:
            from .model_policy import DesktopRoleModelPolicy
            binding = (policy.snapshot(role='last_order') if isinstance(policy, DesktopRoleModelPolicy)
                       else policy.snapshot())['effective']
            provider, model_id = binding['provider'], binding['modelId']
        except (KeyError, ValueError, TypeError, OSError):
            provider, model_id = read_field(model, 'provider'), read_field(model, 'id')
    raw = read_field(source, 'errorMessage') or str(source)
    details = {'role': 'last_order', 'provider': provider, 'modelId': model_id,
               'attempt': attempt, 'message': _clean(session, raw), 'category': 'upstream'}
    endpoint, env = _error_network_context(session)
    if endpoint:
        try:
            from misaka.ai.utils.network_route import resolve_network_route
            details['route'] = resolve_network_route(endpoint, env).public_details()
        except ValueError as error:
            details.update(category='configuration', configurationError=_clean(session, error))
    lower = str(raw).lower()
    summary = '主控模型执行失败，研究尚未启动；原始课题已保留。'
    if details['category'] == 'configuration':
        summary = '模型网络配置有误，研究尚未启动；请检查配置后重试。'
    elif any(word in lower for word in ('proxyerror', 'proxy authentication', 'proxy connection', 'proxy tunnel', '407')):
        details['category'] = 'proxy'
        summary = '连接已配置的代理失败，研究尚未启动；请检查代理后重试。'
    elif any(word in lower for word in ('401', '403', 'unauthorized', 'authentication', 'credentials', 'api key')):
        details['category'] = 'authentication'
        summary = '主控模型鉴权失败，研究尚未启动；请检查凭证后重试。'
    elif any(word in lower for word in ('429', 'usage_limit', 'rate limit', 'quota', '额度')):
        details['category'] = 'rate_limit'
        summary = '主控模型额度或速率受限，研究尚未启动；原始课题已保留。'
    elif any(word in lower for word in ('getaddrinfo', 'name resolution', 'dns', 'name or service not known')):
        details['category'] = 'dns'
        summary = '模型连接地址解析失败，研究尚未启动；请检查网络后重试。'
    elif any(word in lower for word in ('certificate', 'ssl', 'tls')):
        details['category'] = 'tls'
        summary = '模型连接的 TLS 校验失败，研究尚未启动；请检查证书配置。'
    elif any(word in lower for word in ('connect', 'network', 'timeout', 'timed out', 'unreachable', 'winerror')):
        details['category'] = 'network'
        summary = '连接主控模型服务失败，研究尚未启动；原始课题已保留。'
    if code == 'RESEARCH_RECRUITMENT_TIMEOUT':
        details['category'] = 'timeout'
        summary = '研究团队招募超时，研究尚未启动；原始课题已保留，可以重试。'
    elif code == 'RESEARCH_STARTUP_CANCELLED':
        details['category'] = 'cancelled'
        summary = '研究启动已取消，原始课题已保留。'
    elif code == 'RESEARCH_RECRUITMENT_INCOMPLETE':
        details['category'] = 'recruitment'
        summary = '主控尚未完成研究团队招募，研究尚未启动；原始课题已保留，可以重试。'
    diagnostics = read_field(source, 'diagnostics')
    if diagnostics:
        from misaka.modes.jsonl import to_jsonable
        details['diagnostics'] = _clean_tree(session, to_jsonable(diagnostics))
    if isinstance(source, Exception) and source.__traceback__ is not None:
        details['stack'] = _clean(session, ''.join(traceback.format_exception(source)))
    return submissions.ResearchInputError(summary, code, stage='recruitment', retryable=True, details=details)


async def abort_and_settle(session, intake=None):
    """Retain the controller lock through native abort, even if its caller cancels."""
    from misaka.utils.async_lifecycle import settle
    async def drain():
        abort = getattr(session, 'abort', None)
        stopping = asyncio.create_task(abort()) if abort is not None else None
        # Native abort raises the signal before its first idle wait. Let that happen
        # before cancellation enters a provider finalizer which may require the signal.
        await asyncio.sleep(0)
        if intake is not None and not intake.done():
            intake.cancel()
        try:
            if stopping is not None:
                await stopping
        finally:
            if intake is not None:
                await asyncio.gather(intake, return_exceptions=True)
    await settle(asyncio.create_task(drain()))


def project_history(messages, entries):
    """A failed hidden intake is a user intent, not a fabricated assistant answer."""
    journal = records(entries)
    published = {m.get('requestId') or (m.get('details') or {}).get('requestId') for m in messages
                 if m.get('role') == 'user' or m.get('customType') in {'research-question', 'research-input'}}
    output = []
    for index, message in enumerate(messages):
        key = message.get('requestId') or (message.get('details') or {}).get('requestId')
        row = journal.get(key, {})
        if message.get('customType') == 'desktop-intake-resume':
            continue
        if message.get('customType') == 'desktop-intake':
            if key in published:
                continue
            subsequent = messages[index + 1:]
            next_input = next((i for i, m in enumerate(subsequent) if m.get('customType') == 'desktop-intake'), len(subsequent))
            last = next((m for m in reversed(subsequent[:next_input]) if m.get('role') == 'assistant'), None)
            error = row.get('error') or (last or {}).get('errorMessage') or '上次研究启动未完成，原始课题已保留。'
            message = {**message, 'role': 'user', 'display': True, 'requestId': key,
                       'deliveryStatus': 'failed' if row.get('state') == 'failed' or last else 'unconfirmed',
                       'submissionError': error, 'deliveryRetryable': True,
                       'errorStage': 'recruitment', 'errorCode': row.get('errorCode'),
                       'errorDetails': row.get('errorDetails')}
            if not isinstance(row.get('input'), dict):
                message.update(researchNeedsConfiguration=True, deliveryRetryable=False)
        if isinstance(row.get('input'), dict) and (message.get('role') == 'user'
                or message.get('customType') in {'research-question', 'research-input'}):
            message = {**message, 'researchSubmission': deepcopy(row['input'])}
        output.append(message)
    represented = {m.get('requestId') or (m.get('details') or {}).get('requestId') for m in output
                   if m.get('role') == 'user' or m.get('customType') in {'research-question', 'research-input'}}
    positions = {entry.get('id'): index for index, entry in enumerate(entries)}
    for key, row in journal.items():
        original = row.get('input')
        if key in represented or not isinstance(original, dict):
            continue
        first = next((e for e in entries if e.get('customType') == KIND and (e.get('data') or {}).get('requestId') == key), {})
        message = {'id': f'research-intake-{key}', 'entryId': first.get('id'), 'role': 'user',
                   'requestId': key, 'content': original['text'], 'timestamp': row.get('createdAt', 0),
                   'display': True, 'researchSubmission': deepcopy(original),
                   'deliveryStatus': 'failed' if row.get('state') == 'failed' else 'unconfirmed',
                   'deliveryRetryable': True, 'errorStage': 'recruitment', 'errorCode': row.get('errorCode'),
                   'submissionError': row.get('error') or '上次研究启动未完成，原始课题已保留。',
                   'errorDetails': row.get('errorDetails')}
        position = positions.get(first.get('id'), -1)
        index = next((i for i, item in enumerate(output) if positions.get(item.get('entryId'), -1) > position), len(output))
        output.insert(index, message)
    return output
