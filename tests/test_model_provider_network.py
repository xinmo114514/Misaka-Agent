"""Model-provider boundaries preserve the effective request route."""

import asyncio
import base64
import json

import httpx
import pytest

from misaka.ai.providers import (
    anthropic,
    azure_openai_responses,
    openai_completions,
    openai_responses,
)
from misaka.ai.providers import openai_codex_responses as codex
from misaka.ai.types import Model, TranscriptContext


@pytest.fixture(autouse=True)
def clean_network_env(monkeypatch):
    for name in ("http_proxy", "https_proxy", "all_proxy", "no_proxy", "ssl_cert_file", "ssl_cert_dir"):
        monkeypatch.delenv(name, raising=False)
        monkeypatch.delenv(name.upper(), raising=False)


def model(base_url="https://model.invalid/v1", api="openai-responses"):
    return Model(id="fixture", name="Fixture", provider="openai", api=api, baseUrl=base_url,
                 reasoning=False, input=["text"], cost={"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                 contextWindow=4096, maxTokens=128)


@pytest.mark.parametrize("adapter", [openai_completions, openai_responses, anthropic, azure_openai_responses])
@pytest.mark.parametrize("use_proxy", [False, True])
async def test_sdk_factory_sends_only_to_effective_direct_or_proxy_route(adapter, use_proxy, monkeypatch):
    requests = []
    async def handle(reader, writer):
        requests.append(await reader.readuntil(b"\r\n\r\n"))
        payload = b'{"data": [], "object": "list"}'
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + str(len(payload)).encode() + b"\r\nConnection: close\r\n\r\n" + payload)
        await writer.drain()
        writer.close()
        await writer.wait_closed()
    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    async with server:
        port = server.sockets[0].getsockname()[1]
        endpoint = "http://model.invalid/v1" if use_proxy else f"http://127.0.0.1:{port}/v1"
        if adapter is anthropic:
            endpoint = endpoint.removesuffix("/v1")
        monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
        scoped = {"HTTP_PROXY": f"http://127.0.0.1:{port}" if use_proxy else ""}
        if adapter is anthropic:
            client, _ = adapter.create_client(model(endpoint), "fixture-key", False, False, env=scoped)
        elif adapter is azure_openai_responses:
            client = adapter.create_client(model(endpoint), "fixture-key", {"env": scoped})
        else:
            client = adapter.create_client(model(endpoint), TranscriptContext(messages=[]), "fixture-key", env=scoped)
        try:
            assert (await client.models.list()).data == []
        finally:
            await client.close()
    assert requests[0].startswith(b"GET http://model.invalid/v1/models" if use_proxy else b"GET /v1/models")


@pytest.mark.parametrize("env,want", [({}, None), ({"HTTPS_PROXY": "socks5h://USER:SECRET@proxy.example:31337"}, "socks5h://USER:SECRET@proxy.example:31337")])
async def test_websocket_connector_explicit_route_disables_implicit_proxy(monkeypatch, env, want):
    seen = []
    socket = object()
    async def connector(url, **kwargs):
        seen.append((url, kwargs))
        return socket
    monkeypatch.setattr(codex, "_cached_websocket_connector", connector)
    assert await codex._connect_websocket("wss://model.invalid/v1", {}, env=env) is socket
    assert seen[0][1]["proxy"] == want


@pytest.mark.parametrize("scheme", ["socks5", "socks5h"])
async def test_websocket_socks_omitted_port_is_standard_1080(monkeypatch, scheme):
    from websockets.asyncio.client import parse_proxy
    seen = []
    async def connector(url, **kwargs):
        seen.append(kwargs)
        return object()
    monkeypatch.setattr(codex, "_cached_websocket_connector", connector)
    await codex._connect_websocket("wss://model.invalid/v1", {}, env={"HTTPS_PROXY": f"{scheme}://USER:SECRET@[::1]"})
    selected = parse_proxy(seen[0]["proxy"])
    assert selected.port == 1080
    assert selected.scheme == scheme
    assert selected.username == "USER"


@pytest.mark.parametrize("adapter", [openai_completions, openai_responses, anthropic])
async def test_stream_entry_passes_scoped_env_to_sdk_transport(adapter, monkeypatch):
    requests = []
    async def handle(reader, writer):
        requests.append(await reader.readuntil(b"\r\n\r\n"))
        payload = b'{"error":{"message":"fixture boundary reached"}}'
        writer.write(b"HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: " + str(len(payload)).encode() + b"\r\nConnection: close\r\n\r\n" + payload)
        await writer.drain()
        writer.close()
        await writer.wait_closed()
    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    async with server:
        port = server.sockets[0].getsockname()[1]
        monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
        stream_fn = adapter.stream_openai_completions if adapter is openai_completions else adapter.stream_anthropic if adapter is anthropic else adapter.stream_openai_responses
        endpoint = "http://model.invalid" if adapter is anthropic else "http://model.invalid/v1"
        stream = stream_fn(model(endpoint), TranscriptContext(messages=[]), {"apiKey": "fixture-key", "env": {"HTTP_PROXY": f"http://127.0.0.1:{port}"}, "maxRetries": 0})
        result = await asyncio.wait_for(stream.result(), 5)
        await stream.settled()
    assert result.stopReason == "error"
    assert "fixture boundary reached" in result.errorMessage
    suffix = b"chat/completions" if adapter is openai_completions else b"messages" if adapter is anthropic else b"responses"
    assert requests[0].startswith(b"POST http://model.invalid/v1/" + suffix + b" ")


@pytest.mark.parametrize("use_proxy", [False, True])
async def test_real_codex_websocket_uses_direct_or_http_connect_proxy(monkeypatch, use_proxy):
    from websockets.asyncio.client import connect
    from websockets.asyncio.server import serve
    requests = []
    tasks = set()
    async def echo(socket):
        await socket.send(await socket.recv())
    async def pipe(reader, writer):
        try:
            while data := await reader.read(65536):
                writer.write(data)
                await writer.drain()
        finally:
            writer.close()
    async with serve(echo, "127.0.0.1", 0) as websocket_server:
        target_port = websocket_server.sockets[0].getsockname()[1]
        async def proxy(reader, writer):
            tasks.add(asyncio.current_task())
            try:
                requests.append(await reader.readuntil(b"\r\n\r\n"))
                remote_reader, remote_writer = await asyncio.open_connection("127.0.0.1", target_port)
                writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
                await writer.drain()
                await asyncio.gather(pipe(reader, remote_writer), pipe(remote_reader, writer))
            finally:
                tasks.discard(asyncio.current_task())
        proxy_server = await asyncio.start_server(proxy, "127.0.0.1", 0)
        async with proxy_server:
            proxy_port = proxy_server.sockets[0].getsockname()[1]
            monkeypatch.setattr(codex, "_cached_websocket_connector", connect)
            monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
            endpoint = f"ws://127.0.0.1:{target_port}/responses"
            socket = await codex._connect_websocket(endpoint, {}, env={"HTTP_PROXY": f"http://127.0.0.1:{proxy_port}" if use_proxy else ""})
            try:
                await socket.send("fixture")
                assert await socket.recv() == "fixture"
            finally:
                await socket.close()
        if tasks:
            await asyncio.wait_for(asyncio.gather(*tasks), 2)
    assert len(requests) == int(use_proxy)
    if use_proxy:
        assert requests[0].startswith(f"CONNECT 127.0.0.1:{target_port} ".encode())


class Socket:
    closed = False
    def close(self, *args, **kwargs):
        self.closed = True


@pytest.mark.parametrize("change", ["proxy", "endpoint", "ca"])
async def test_cached_websocket_is_not_reused_after_route_change(monkeypatch, change, tmp_path):
    sockets = []
    async def connector(url, **kwargs):
        socket = Socket()
        sockets.append(socket)
        return socket
    monkeypatch.setattr(codex, "_cached_websocket_connector", connector)
    monkeypatch.setattr(codex, "_websocket_session_cache", {})
    url, env = "wss://model.invalid/v1", {"HTTPS_PROXY": "http://proxy:31337"}
    first, _, reused, release = await codex._acquire_websocket(url, {}, "fixture-session", env=env)
    assert reused is False
    release(True)
    if change == "proxy":
        env = {"HTTPS_PROXY": "http://proxy:31338"}
    elif change == "endpoint":
        url = "wss://other.invalid/v1"
    else:
        env = {**env, "SSL_CERT_DIR": str(tmp_path)}
    second, _, reused, release = await codex._acquire_websocket(url, {}, "fixture-session", env=env)
    assert reused is False
    assert second is not first
    assert first.closed is True
    release(False)


def codex_key():
    claims = base64.urlsafe_b64encode(json.dumps({codex.JWT_CLAIM_PATH: {"chatgpt_account_id": "fixture-account"}}).encode()).decode().rstrip("=")
    return f"fixture.{claims}.fixture"


async def test_codex_fallback_freezes_scoped_route_and_reports_failure(monkeypatch):
    from misaka.ai.utils.network_route import resolve_network_route
    selected = "http://USER:SECRET@proxy.example:31337"
    seen = []
    async def fail_ws(url, body, headers, output, stream, current_model, on_start, options):
        seen.append(resolve_network_route(url, options.get("env")).proxy_url)
        # A process environment update during fallback must not alter this request.
        monkeypatch.setenv("HTTPS_PROXY", "http://wrong.example:31338")
        raise OSError(f"connection to {selected} failed")
    real_client = httpx.AsyncClient
    def client_factory(**kwargs):
        seen.append(kwargs)
        return real_client(transport=httpx.MockTransport(lambda request: httpx.Response(502, text="controlled upstream failure", request=request)), trust_env=False)
    monkeypatch.setattr(codex, "process_websocket_stream", fail_ws)
    monkeypatch.setattr(codex.httpx, "AsyncClient", client_factory)
    stream = codex.stream_openai_codex_responses(model("https://model.invalid/backend-api", "openai-codex-responses"), TranscriptContext(messages=[]), {"apiKey": codex_key(), "env": {"HTTPS_PROXY": selected}, "maxRetries": 0})
    result = await stream.result()
    await stream.settled()
    assert seen[0] == selected
    assert seen[1]["trust_env"] is False
    assert seen[1]["proxy"] == selected
    diagnostics = [item for item in result.diagnostics or [] if item.type == "provider_network_failure"]
    assert diagnostics[0].details["route"]["mode"] == "proxy"
    public = result.model_dump_json()
    assert "SECRET" not in public
    assert "USER" not in public


@pytest.mark.parametrize("scheme", ["socks5", "socks5h"])
async def test_httpx_socks_runtime_is_installed_and_constructible(scheme):
    from misaka.ai.utils.network_route import httpx_client_options
    async with httpx.AsyncClient(**httpx_client_options("https://target.invalid", {"HTTPS_PROXY": f"{scheme}://localhost:31337"})):
        pass
    from python_socks.async_.asyncio import Proxy
    assert Proxy.from_url("socks5://localhost:31337") is not None


async def test_anthropic_factory_never_calls_sdk_os_proxy_discovery(monkeypatch):
    from anthropic import _base_client as sdk_base
    monkeypatch.setattr(sdk_base, "get_environment_proxies", lambda: pytest.fail("SDK OS discovery invoked"))
    client, _ = anthropic.create_client(model("https://model.invalid"), "fixture-key", False, False)
    await client.close()


@pytest.mark.parametrize('adapter,stream_name,api', [
    (openai_completions, 'stream_openai_completions', 'openai-completions'),
    (openai_responses, 'stream_openai_responses', 'openai-responses'),
    (azure_openai_responses, 'stream_azure_openai_responses', 'azure-openai-responses'),
])
async def test_provider_closes_its_owned_http_client_when_request_fails(adapter, stream_name, api, monkeypatch):
    clients = []
    connection_closed = asyncio.Event()
    create = adapter.create_client

    def capture(*args, **kwargs):
        client = create(*args, **kwargs)
        clients.append(client)
        return client

    async def reject(reader, writer):
        headers = await reader.readuntil(b'\r\n\r\n')
        size = next((int(line.split(b':', 1)[1]) for line in headers.split(b'\r\n') if line.lower().startswith(b'content-length:')), 0)
        if size:
            await reader.readexactly(size)
        body = b'{"error":{"message":"fixture authentication error","type":"authentication_error"}}'
        writer.write(b'HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ' + str(len(body)).encode() + b'\r\nConnection: keep-alive\r\n\r\n' + body)
        await writer.drain()
        await reader.read()
        writer.close()
        await writer.wait_closed()
        connection_closed.set()

    monkeypatch.setattr(adapter, 'create_client', capture)
    server = await asyncio.start_server(reject, '127.0.0.1', 0)
    async with server:
        port = server.sockets[0].getsockname()[1]
        stream = getattr(adapter, stream_name)(model(f'http://127.0.0.1:{port}/v1', api), TranscriptContext(messages=[]),
            {'apiKey': 'fixture-key', 'maxRetries': 0})
        try:
            reply = await stream.result()
            await stream.settled()
            assert reply.stopReason == 'error'
            assert clients[0].is_closed(), 'owned SDK client must close before the producer settles'
            await asyncio.wait_for(connection_closed.wait(), timeout=2)
        finally:
            for client in clients:
                await client.close()


async def test_https_proxy_uses_the_scoped_ca_context_for_its_tls_handshake(tmp_path):
    import ipaddress
    import ssl
    from datetime import UTC, datetime, timedelta

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    from misaka.ai.utils.network_route import httpx_client_options
    private_key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'fixture local proxy')])
    now = datetime.now(UTC)
    certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(private_key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), critical=False)
        .sign(private_key, hashes.SHA256()))
    certfile, keyfile = tmp_path / 'proxy-ca.pem', tmp_path / 'proxy-key.pem'
    certfile.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    keyfile.write_bytes(private_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(certfile), str(keyfile))
    requests = []

    async def proxy(reader, writer):
        requests.append(await reader.readuntil(b'\r\n\r\n'))
        writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(proxy, '127.0.0.1', 0, ssl=context)
    async with server:
        port = server.sockets[0].getsockname()[1]
        options = httpx_client_options('http://model.invalid/v1', {'HTTP_PROXY': f'https://127.0.0.1:{port}',
                                      'SSL_CERT_FILE': str(certfile)})
        assert isinstance(options['proxy'], httpx.Proxy)
        assert options['proxy'].ssl_context is options['verify']
        async with httpx.AsyncClient(**options) as client:
            transport = client._transport_for_url(httpx.URL('http://model.invalid/v1'))
            assert transport._pool._proxy_ssl_context is options['verify']
            assert (await client.get('http://model.invalid/v1')).text == 'ok'
    assert requests[0].startswith(b'GET http://model.invalid/v1 HTTP/1.1')


async def test_completion_stream_does_not_close_the_callers_client():
    from openai import AsyncOpenAI
    client = AsyncOpenAI(api_key='fixture-key', base_url='http://model.invalid/v1',
        http_client=httpx.AsyncClient(trust_env=False, transport=httpx.MockTransport(lambda request: httpx.Response(401,
            json={'error': {'message': 'fixture error', 'type': 'authentication_error'}}, request=request))))
    try:
        stream = openai_completions.stream_openai_completions(model('http://model.invalid/v1', 'openai-completions'),
            TranscriptContext(messages=[]), {'client': client, 'maxRetries': 0})
        assert (await stream.result()).stopReason == 'error'
        await stream.settled()
        assert client.is_closed() is False
    finally:
        await client.close()


async def test_websocket_https_proxy_scoped_ca_preserves_string_route(monkeypatch):
    import certifi
    seen = []

    async def connector(url, **kwargs):
        seen.append(kwargs)
        return object()

    monkeypatch.setattr(codex, '_cached_websocket_connector', connector)
    await codex._connect_websocket('wss://model.invalid/v1', {}, env={
        'HTTPS_PROXY': 'https://proxy.invalid:38417', 'SSL_CERT_FILE': certifi.where()})
    assert seen[0]['proxy'] == 'https://proxy.invalid:38417'
    assert seen[0]['proxy_ssl'] is seen[0]['ssl']
