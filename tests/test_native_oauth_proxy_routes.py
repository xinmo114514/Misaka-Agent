"""OAuth fetch requests use the live application proxy policy."""
import httpx
import pytest
from misaka.config import proxy_settings
from misaka.utils.whatwg_fetch import fetch

@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [True, False])
async def test_oauth_fetch_uses_application_policy(monkeypatch, direct):
    policy = {**proxy_settings.DEFAULT_PROXY_SETTINGS, "whenDisabled": "direct" if direct else "environment"}
    monkeypatch.setattr(proxy_settings, "get_proxy_settings", lambda: policy)
    monkeypatch.setenv("HTTPS_PROXY", "http://ambient.invalid:3128")
    captured = []
    real = httpx.AsyncClient
    def client(**kwargs):
        captured.append(kwargs)
        return real(**(kwargs | {"proxy": None, "transport": httpx.MockTransport(lambda r: httpx.Response(200, json={}, request=r))}))
    monkeypatch.setattr(httpx, "AsyncClient", client)
    response = await fetch("https://auth.invalid/token", {"method": "POST", "body": "{}"})
    assert await response.json() == {}
    assert captured[-1]["trust_env"] is False
    assert captured[-1]["proxy"] == (None if direct else "http://ambient.invalid:3128")
