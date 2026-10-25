import io
import json
import os
import sys
from types import SimpleNamespace

import pytest

from tests.test_desktop_bridge import MockRuntimeHost


async def test_bridge_preserves_configured_proxy_environment_even_if_port_is_closed(monkeypatch):
    from misaka.cli import desktop_bridge as bridge
    values = {'HTTP_PROXY': 'http://127.0.0.1:63147', 'HTTPS_PROXY': 'http://localhost:63148',
              'ALL_PROXY': 'socks5://[::1]:63149', 'NO_PROXY': 'localhost,127.0.0.1'}
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    output = io.StringIO()
    monkeypatch.setattr(bridge, 'writeRawStdout', output.write)
    monkeypatch.setattr(sys, 'stdin', io.StringIO('{"type":"shutdown"}\n'))
    await bridge.run_desktop_bridge(MockRuntimeHost())
    assert {key: os.environ.get(key) for key in values} == values


async def test_recruitment_error_details_survive_real_jsonl_ack(monkeypatch):
    from misaka.cli import desktop_bridge as bridge
    from misaka.core.research.submissions import ResearchInputError

    async def fail(self, obj, con):
        raise ResearchInputError('连接主控模型服务失败', 'RESEARCH_RECRUITMENT_MODEL_ERROR', stage='recruitment',
            details={'role': 'last_order', 'provider': 'fixture', 'modelId': 'local-model',
                     'message': 'Connection refused', 'route': {'mode': 'direct'}})

    monkeypatch.setattr(bridge.ResearchMessageIngress, 'send', fail)
    output = io.StringIO()
    monkeypatch.setattr(bridge, 'writeRawStdout', output.write)
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({'type': 'send_research_message', 'text': 'question',
        'sessionId': 'test-session-123', 'requestId': 'error-details'}) + '\n'))
    await bridge.run_desktop_bridge(MockRuntimeHost())
    ack = next(row for row in map(json.loads, output.getvalue().splitlines()) if row.get('requestId') == 'error-details')
    assert ack['errorStage'] == 'recruitment'
    assert ack['errorDetails']['message'] == 'Connection refused'
    assert ack['errorDetails']['route']['mode'] == 'direct'
    assert ack['sessionId'] == 'test-session-123'
    assert ack['streamId']


@pytest.mark.parametrize('foreign', [False, True])
async def test_connection_probe_uses_only_current_model_and_checks_owner(monkeypatch, foreign):
    from misaka.ai.utils import network_route
    from misaka.cli import desktop_bridge as bridge
    called = []

    async def probe(endpoint, env=None, timeout=3.0):
        called.append((endpoint, env))
        return {'route': {'mode': 'direct', 'endpoint': endpoint}, 'reachable': True, 'check': 'tcp'}

    monkeypatch.setattr(network_route, 'diagnose_connection', probe)
    host = MockRuntimeHost()
    host.session.model = SimpleNamespace(baseUrl='http://localhost:34219/v1')
    output = io.StringIO()
    monkeypatch.setattr(bridge, 'writeRawStdout', output.write)
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({'type': 'check_research_connection',
        'sessionId': 'foreign' if foreign else host.session.sessionId, 'requestId': 'probe',
        'endpoint': 'http://unrelated.invalid:1', 'text': 'PRIVATE_TOPIC'}) + '\n'))
    await bridge.run_desktop_bridge(host)
    ack = next(row for row in map(json.loads, output.getvalue().splitlines()) if row.get('requestId') == 'probe')
    assert ack['ok'] is not foreign
    if foreign:
        assert called == []
        assert ack['errorCode'] == 'RESEARCH_STREAM_CHANGED'
    else:
        from misaka.config.proxy_settings import proxy_request_env
        assert called == [('http://localhost:34219/v1', proxy_request_env())]
        assert ack['data']['check'] == 'tcp'
    assert 'PRIVATE_TOPIC' not in json.dumps(ack)
