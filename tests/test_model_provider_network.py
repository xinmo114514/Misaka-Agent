"""SDK construction shares the effective request route."""
from types import SimpleNamespace
import pytest
from misaka.ai.api import _openai_sdk
from misaka.ai.utils.request_network import request_network
from misaka.config import proxy_settings

@pytest.mark.asyncio
async def test_openai_sdk_uses_frozen_route(monkeypatch):
    policy = {**proxy_settings.DEFAULT_PROXY_SETTINGS, "whenDisabled": "environment"}
    monkeypatch.setattr(proxy_settings, "get_proxy_settings", lambda: policy)
    captured = []
    real_client = _openai_sdk.httpx.AsyncClient
    def client(**kwargs):
        captured.append(kwargs)
        return real_client(**(kwargs | {"proxy": None}))
    monkeypatch.setattr(_openai_sdk.httpx, "AsyncClient", client)
    monkeypatch.setattr(_openai_sdk, "AsyncOpenAI", lambda **kwargs: SimpleNamespace(**kwargs))
    with request_network({"HTTPS_PROXY": "http://credential.invalid:3128"}):
        sdk, _ = _openai_sdk._sdk_client(apiKey="fixture", baseURL="https://api.invalid", defaultHeaders={})
    try:
        assert captured[-1]["proxy"] == "http://credential.invalid:3128"
        assert captured[-1]["trust_env"] is False
    finally:
        await sdk.http_client.aclose()


@pytest.mark.asyncio
async def test_anthropic_sdk_does_not_restore_ambient_proxy_mounts(monkeypatch):
    from misaka.ai.api import _anthropic_sdk

    if _anthropic_sdk.DefaultAsyncHttpxClient is None:
        pytest.skip("optional Anthropic SDK absent")
    monkeypatch.setenv("HTTP_PROXY", "http://ambient.invalid:3128")
    monkeypatch.setenv("HTTPS_PROXY", "http://ambient.invalid:3128")
    monkeypatch.setattr(proxy_settings, "get_proxy_settings", lambda: {
        **proxy_settings.DEFAULT_PROXY_SETTINGS, "whenDisabled": "direct",
    })
    with request_network():
        client = _anthropic_sdk._routed_http_client("http://model.invalid")
    try:
        assert not client._mounts
        assert type(client._transport._pool).__name__ == "AsyncConnectionPool"
    finally:
        await client.aclose()
