"""Remaining native transports obey a request-scoped route, without live traffic."""

import asyncio
import os
from contextlib import asynccontextmanager
from types import SimpleNamespace

import httpx
import pytest

from misaka.ai.providers import (
    amazon_bedrock,
    google,
    google_vertex,
    mistral,
    pi_messages,
)
from misaka.ai.types import Model, TranscriptContext, UserMessage


@pytest.fixture(autouse=True)
def isolated_network(monkeypatch, tmp_path):
    monkeypatch.setenv("MISAKA_HOME", str(tmp_path))
    for key in (
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "ssl_cert_file",
        "ssl_cert_dir",
    ):
        monkeypatch.delenv(key, raising=False)
        monkeypatch.delenv(key.upper(), raising=False)


def model(endpoint="https://model.invalid", api="google-generative-ai"):
    return Model(
        id="fixture",
        name="Fixture",
        provider="fixture",
        api=api,
        baseUrl=endpoint,
        reasoning=False,
        input=["text"],
        cost={"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        contextWindow=4096,
        maxTokens=128,
    )


@asynccontextmanager
async def local_http():
    requests = []

    async def handler(reader, writer):
        requests.append(await reader.readuntil(b"\r\n\r\n"))
        body = b'{"error":{"message":"fixture boundary reached"}}'
        writer.write(
            b"HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: "
            + str(len(body)).encode()
            + b"\r\nConnection: close\r\n\r\n"
            + body
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(handler, "127.0.0.1", 0)
    async with server:
        yield server.sockets[0].getsockname()[1], requests


@pytest.mark.parametrize("adapter", ["google", "vertex", "mistral", "pi", "bedrock"])
@pytest.mark.parametrize("route", ["proxy", "direct", "bypass"])
async def test_native_stream_reaches_only_selected_local_route(
    adapter, route, monkeypatch
):
    created = []
    if adapter in {"google", "vertex"}:
        module = google if adapter == "google" else google_vertex
        sdk = module.GoogleGenAI
        if sdk is None:
            pytest.skip("optional google-genai SDK absent")

        def factory(**kwargs):
            client = sdk(**kwargs)
            created.append(client)
            return client

        monkeypatch.setattr(module, "GoogleGenAI", factory)
    elif adapter == "mistral":
        sdk = mistral._MistralClient
        if sdk is None:
            pytest.skip("optional Mistral SDK absent")

        def factory(**kwargs):
            client = sdk(**kwargs)
            created.append(client)
            return client

        monkeypatch.setattr(mistral, "_get_mistral_client_class", lambda: factory)
    elif adapter == "bedrock" and amazon_bedrock.boto3 is None:
        pytest.skip("optional boto3 SDK absent")
    async with local_http() as (port, requests):
        monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
        endpoint = (
            "http://model.invalid" if route == "proxy" else f"http://127.0.0.1:{port}"
        )
        env = {"HTTP_PROXY": f"http://127.0.0.1:{port}" if route == "proxy" else ""}
        if route == "bypass":
            env = {"HTTP_PROXY": "http://127.0.0.1:1", "NO_PROXY": "127.0.0.1"}
        fn = {
            "google": google.stream_google,
            "vertex": google_vertex.stream_google_vertex,
            "mistral": mistral.stream_mistral,
            "pi": pi_messages.stream_pi_messages,
            "bedrock": amazon_bedrock.stream_bedrock,
        }[adapter]
        stream = fn(
            model(endpoint),
            TranscriptContext(messages=[UserMessage(content="fixture", timestamp=0)]),
            {"apiKey": "fixture-key", "env": env, "maxRetries": 0, "timeoutMs": 1000},
        )
        result = await asyncio.wait_for(stream.result(), 15)
        await stream.settled()
    assert result.stopReason == "error"
    assert requests, result.errorMessage
    assert requests[0].startswith(
        b"POST http://model.invalid/" if route == "proxy" else b"POST /"
    )
    for client in created:
        if adapter in {"google", "vertex"}:
            assert client._api_client._httpx_client.is_closed
            assert client._api_client._async_httpx_client.is_closed
        else:
            assert all(item.is_closed for item in client._misaka_http_clients)


@pytest.mark.parametrize("scheme", ["http", "https", "socks5", "socks5h"])
@pytest.mark.parametrize("factory", ["google", "vertex", "mistral"])
async def test_sdk_factories_install_explicit_httpx_route(scheme, factory, monkeypatch):
    captured = {}

    def sdk(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace()

    endpoint = "https://model.invalid"
    env = {"HTTPS_PROXY": f"{scheme}://proxy.invalid:31337"}
    if factory == "mistral":
        monkeypatch.setattr(mistral, "_get_mistral_client_class", lambda: sdk)
        client = mistral.create_client(model(endpoint), "key", env=env)
        clients = client._misaka_http_clients
        try:
            assert captured["async_client"] is clients[1]
            assert clients[1]._trust_env is False
            proxy = (
                clients[1]
                ._mounts[next(k for k in clients[1]._mounts if k.pattern == "all://")]
                ._pool._proxy_url
            )
            assert proxy.host == b"proxy.invalid"
        finally:
            clients[0].close()
            await clients[1].aclose()
    else:
        module = google if factory == "google" else google_vertex
        monkeypatch.setattr(module, "GoogleGenAI", sdk)
        if factory == "google":
            module.create_client(model(endpoint), "key", env=env)
        else:
            module.create_client_with_api_key(model(endpoint), "key", env=env)
        options = captured["http_options"]
        assert options["clientArgs"]["trust_env"] is False
        assert options["clientArgs"]["proxy"] == env["HTTPS_PROXY"]
        async_args = options["asyncClientArgs"]
        assert async_args["trust_env"] is False
        assert async_args["transport"]._pool._proxy_url.host == b"proxy.invalid"
        await async_args["transport"].aclose()


@pytest.mark.parametrize("scheme", ["http", "https"])
def test_bedrock_explicit_proxy_and_direct_settings(scheme, monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://wrong.invalid:1")
    selected = f"{scheme}://proxy.invalid:31337"
    settings = amazon_bedrock.build_client_settings(
        model(), {"env": {"HTTPS_PROXY": selected}}
    )
    assert settings.config_kwargs["proxies"] == {"http": selected, "https": selected}
    direct = amazon_bedrock.build_client_settings(
        model(), {"env": {"HTTPS_PROXY": "", "ALL_PROXY": ""}}
    )
    assert direct.config_kwargs["proxies"] == {}


@pytest.mark.parametrize("scheme", ["socks5", "socks5h"])
def test_bedrock_reports_unsupported_socks_without_falling_back(scheme):
    with pytest.raises(ValueError, match="(?i)bedrock.*SOCKS"):
        amazon_bedrock.build_client_settings(
            model(), {"env": {"HTTPS_PROXY": f"{scheme}://proxy.invalid:31337"}}
        )


def test_bedrock_bypass_uses_actual_region_endpoint():
    settings = amazon_bedrock.build_client_settings(
        model("https://bedrock-runtime.us-east-1.amazonaws.com"),
        {
            "region": "eu-west-1",
            "env": {
                "HTTPS_PROXY": "http://proxy.invalid:31337",
                "NO_PROXY": "bedrock-runtime.eu-west-1.amazonaws.com",
            },
        },
    )
    assert settings.config_kwargs["proxies"] == {}


@pytest.mark.parametrize("adapter", [google, google_vertex])
async def test_google_setup_failure_closes_its_transport(adapter, monkeypatch):
    transports = []

    class Transport:
        closed = False

        def __init__(self, **kwargs):
            transports.append(self)

        async def aclose(self):
            self.closed = True

    def broken_sdk(**kwargs):
        raise RuntimeError("setup failure")

    monkeypatch.setattr(adapter.httpx, "AsyncHTTPTransport", Transport)
    monkeypatch.setattr(adapter, "GoogleGenAI", broken_sdk)
    with pytest.raises(RuntimeError, match="setup failure"):
        if adapter is google:
            adapter.create_client(model(), "key")
        else:
            adapter.create_client_with_api_key(model(), "key")
    await asyncio.sleep(0)
    assert transports[0].closed


async def test_mistral_setup_failure_closes_both_owned_clients(monkeypatch):
    closed = []

    class SyncClient:
        def __init__(self, **kwargs):
            pass

        def close(self):
            closed.append("sync")

    class AsyncClient:
        def __init__(self, **kwargs):
            pass

        async def aclose(self):
            closed.append("async")

    def broken_sdk(**kwargs):
        raise RuntimeError("setup failure")

    monkeypatch.setattr(mistral.httpx, "Client", SyncClient)
    monkeypatch.setattr(mistral.httpx, "AsyncClient", AsyncClient)
    monkeypatch.setattr(mistral, "_get_mistral_client_class", lambda: broken_sdk)
    with pytest.raises(RuntimeError, match="setup failure"):
        mistral.create_client(model(), "key")
    await asyncio.sleep(0)
    assert closed == ["sync", "async"]


@pytest.mark.parametrize("adapter", [google, google_vertex])
async def test_google_does_not_close_injected_client(adapter):
    closed = []

    async def aclose():
        closed.append("async")

    def close():
        closed.append("sync")

    client = SimpleNamespace(aio=SimpleNamespace(aclose=aclose), close=close)
    fn = adapter.stream_google if adapter is google else adapter.stream_google_vertex
    stream = fn(model(), TranscriptContext(messages=[]), {"client": client})
    await stream.result()
    await stream.settled()
    assert closed == []


@pytest.mark.parametrize("adapter", [google, google_vertex, mistral])
async def test_sdk_route_keeps_scoped_ca_context(adapter, monkeypatch, tmp_path):
    import ssl

    captured = {}

    def sdk(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace()

    if adapter is mistral:
        monkeypatch.setattr(adapter, "_get_mistral_client_class", lambda: sdk)
        client = adapter.create_client(
            model(), "key", env={"SSL_CERT_DIR": str(tmp_path)}
        )
        try:
            context = client._misaka_http_clients[1]._transport._pool._ssl_context
            assert isinstance(context, ssl.SSLContext)
        finally:
            client._misaka_http_clients[0].close()
            await client._misaka_http_clients[1].aclose()
    else:
        monkeypatch.setattr(adapter, "GoogleGenAI", sdk)
        if adapter is google:
            adapter.create_client(model(), "key", env={"SSL_CERT_DIR": str(tmp_path)})
        else:
            adapter.create_client_with_api_key(
                model(), "key", env={"SSL_CERT_DIR": str(tmp_path)}
            )
        options = captured["http_options"]
        assert isinstance(options["clientArgs"]["verify"], ssl.SSLContext)
        assert (
            options["asyncClientArgs"]["transport"]._pool._ssl_context
            is options["clientArgs"]["verify"]
        )
        await options["asyncClientArgs"]["transport"].aclose()


def test_bedrock_ca_directory_reports_capability_error(monkeypatch, tmp_path):
    monkeypatch.setattr(
        amazon_bedrock,
        "boto3",
        SimpleNamespace(Session=lambda **kwargs: SimpleNamespace()),
    )
    with pytest.raises(ValueError, match="SSL_CERT_DIR"):
        amazon_bedrock.create_client(model(), {"env": {"SSL_CERT_DIR": str(tmp_path)}})


@pytest.mark.parametrize("adapter", ["google", "vertex", "mistral", "pi"])
@pytest.mark.parametrize("scheme", ["socks5", "socks5h"])
async def test_native_httpx_adapters_reach_real_local_socks_proxy(adapter, scheme):
    requests = []
    peers = []

    async def socks(reader, writer):
        try:
            version, count = await reader.readexactly(2)
            assert version == 5
            await reader.readexactly(count)
            writer.write(b"\x05\x00")
            await writer.drain()
            version, command, _reserved, kind = await reader.readexactly(4)
            assert (version, command) == (5, 1)
            if kind == 3:
                length = (await reader.readexactly(1))[0]
                host = (await reader.readexactly(length)).decode()
            else:
                host = (await reader.readexactly(4 if kind == 1 else 16)).hex()
            port = int.from_bytes(await reader.readexactly(2), "big")
            peers.append((host, port))
            writer.write(b"\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x50")
            await writer.drain()
            requests.append(await reader.readuntil(b"\r\n\r\n"))
            body = b'{"error":{"message":"local SOCKS fixture"}}'
            writer.write(
                b"HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: "
                + str(len(body)).encode()
                + b"\r\nConnection: close\r\n\r\n"
                + body
            )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(socks, "127.0.0.1", 0)
    async with server:
        port = server.sockets[0].getsockname()[1]
        fn = {
            "google": google.stream_google,
            "vertex": google_vertex.stream_google_vertex,
            "mistral": mistral.stream_mistral,
            "pi": pi_messages.stream_pi_messages,
        }[adapter]
        stream = fn(
            model("http://model.invalid"),
            TranscriptContext(messages=[UserMessage(content="fixture", timestamp=0)]),
            {
                "apiKey": "fixture",
                "maxRetries": 0,
                "timeoutMs": 1000,
                "env": {"HTTP_PROXY": f"{scheme}://127.0.0.1:{port}"},
            },
        )
        result = await asyncio.wait_for(stream.result(), 15)
        await stream.settled()
    assert result.stopReason == "error"
    assert peers == [("model.invalid", 80)]
    assert requests[0].startswith(b"POST /")


def test_bedrock_ca_file_takes_precedence_over_ca_directory(monkeypatch, tmp_path):
    captured = {}

    def client(service, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace()

    monkeypatch.setattr(
        amazon_bedrock,
        "boto3",
        SimpleNamespace(Session=lambda **kwargs: SimpleNamespace(client=client)),
    )
    monkeypatch.setattr(
        amazon_bedrock, "Config", lambda **kwargs: SimpleNamespace(**kwargs)
    )
    ca_file = str(tmp_path / "fixture-ca.pem")
    amazon_bedrock.create_client(
        model(), {"env": {"SSL_CERT_FILE": ca_file, "SSL_CERT_DIR": str(tmp_path)}}
    )
    assert captured["verify"] == ca_file
    assert captured["config"].proxies_config == {"proxy_ca_bundle": ca_file}


def test_bedrock_profile_region_bypass_is_resolved_before_socks_capability_check(
    monkeypatch,
):
    monkeypatch.setenv("AWS_PROFILE", "fixture-profile")
    captured = {}

    def client(service, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(
            meta=SimpleNamespace(
                endpoint_url="https://bedrock-runtime.eu-west-1.amazonaws.com"
            ),
            close=lambda: None,
        )

    monkeypatch.setattr(
        amazon_bedrock,
        "boto3",
        SimpleNamespace(
            Session=lambda **kwargs: SimpleNamespace(
                region_name="eu-west-1", client=client
            )
        ),
    )
    monkeypatch.setattr(
        amazon_bedrock, "Config", lambda **kwargs: SimpleNamespace(**kwargs)
    )
    amazon_bedrock.create_client(
        model("https://bedrock-runtime.us-east-1.amazonaws.com"),
        {
            "env": {
                "HTTPS_PROXY": "socks5://proxy.invalid:31337",
                "NO_PROXY": "bedrock-runtime.eu-west-1.amazonaws.com",
            }
        },
    )
    assert captured["config"].proxies == {}


@pytest.mark.parametrize("endpoint_mode", ["service", "global", "fips"])
@pytest.mark.parametrize("proxy_scheme", ["http", "socks5"])
def test_bedrock_no_proxy_uses_sdk_resolved_endpoint(
    endpoint_mode, proxy_scheme, monkeypatch, tmp_path
):
    if amazon_bedrock.boto3 is None:
        pytest.skip("optional boto3 SDK absent")
    for key in [
        "AWS_PROFILE",
        "AWS_ENDPOINT_URL",
        "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
        "AWS_USE_FIPS_ENDPOINT",
        "AWS_USE_DUALSTACK_ENDPOINT",
    ]:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("AWS_CONFIG_FILE", str(tmp_path / "absent-config"))
    monkeypatch.setenv(
        "AWS_SHARED_CREDENTIALS_FILE", str(tmp_path / "absent-credentials")
    )
    if endpoint_mode == "fips":
        monkeypatch.setenv("AWS_USE_FIPS_ENDPOINT", "true")
        endpoint = "https://bedrock-runtime-fips.us-east-1.amazonaws.com"
        no_proxy = "bedrock-runtime-fips.us-east-1.amazonaws.com"
    else:
        monkeypatch.setenv(
            "AWS_ENDPOINT_URL_BEDROCK_RUNTIME"
            if endpoint_mode == "service"
            else "AWS_ENDPOINT_URL",
            "http://127.0.0.1:31337",
        )
        endpoint = "http://127.0.0.1:31337"
        no_proxy = "127.0.0.1"
    env = {
        "AWS_BEDROCK_SKIP_AUTH": "1",
        "HTTP_PROXY": f"{proxy_scheme}://proxy.invalid:1234",
        "HTTPS_PROXY": f"{proxy_scheme}://proxy.invalid:1234",
        "NO_PROXY": no_proxy,
    }
    before = dict(os.environ)
    client = amazon_bedrock.create_client(
        model("https://bedrock-runtime.us-east-1.amazonaws.com"),
        {"region": "us-east-1", "env": env},
    )
    try:
        assert client.meta.endpoint_url == endpoint
        assert client.meta.config.proxies == {}
        assert dict(os.environ) == before
    finally:
        client.close()


@pytest.mark.parametrize(
    "location,host",
    [
        ("global", "aiplatform.googleapis.com"),
        ("us", "aiplatform.us.rep.googleapis.com"),
        ("eu", "aiplatform.eu.rep.googleapis.com"),
        ("us-central1", "us-central1-aiplatform.googleapis.com"),
    ],
)
async def test_vertex_no_proxy_matches_real_sdk_location_host(location, host):
    if google_vertex.GoogleGenAI is None:
        pytest.skip("optional google-genai SDK absent")
    client = google_vertex.create_client(
        model("https://{location}-aiplatform.googleapis.com"),
        "fixture-project",
        location,
        env={"HTTPS_PROXY": "http://proxy.invalid:1234", "NO_PROXY": host},
    )
    try:
        assert (
            client._api_client._http_options.base_url.rstrip("/") == f"https://{host}"
        )
        assert not client._api_client._async_httpx_client._mounts
        assert (
            type(client._api_client._async_httpx_client._transport._pool).__name__
            == "AsyncConnectionPool"
        )
    finally:
        await client.aio.aclose()
        client.close()


async def test_pi_injected_transport_stays_authoritative_and_wrapper_is_closed(
    monkeypatch,
):
    captured = []
    injected_requests = []

    class Borrowed(httpx.MockTransport):
        closed = False

        async def aclose(self):
            self.closed = True

    borrowed = Borrowed(
        lambda request: (
            injected_requests.append(request)
            or httpx.Response(401, json={"error": "injected fixture"}, request=request)
        )
    )
    real = httpx.AsyncClient

    def factory(**kwargs):
        client = real(**kwargs)
        captured.append(client)
        return client

    monkeypatch.setattr(pi_messages.httpx, "AsyncClient", factory)
    async with local_http() as (port, proxy_requests):
        for _ in range(2):
            stream = pi_messages.stream_pi_messages(
                model("http://model.invalid"),
                TranscriptContext(messages=[]),
                {
                    "apiKey": "fixture",
                    "timeoutMs": 1000,
                    "httpTransport": borrowed,
                    "env": {"HTTP_PROXY": f"http://127.0.0.1:{port}"},
                },
            )
            await stream.result()
            await stream.settled()
    assert len(injected_requests) == 2
    assert proxy_requests == []
    assert all(client.is_closed for client in captured)
    assert borrowed.closed is False
