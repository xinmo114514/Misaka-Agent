from misaka.ai.utils import request_network as network
from misaka.config import proxy_settings


def test_request_route_preserves_credential_env_and_freezes_live_policy(monkeypatch):
    policy = {**proxy_settings.DEFAULT_PROXY_SETTINGS, "whenDisabled": "environment"}
    monkeypatch.setattr(proxy_settings, "get_proxy_settings", lambda: dict(policy))
    monkeypatch.setenv("HTTPS_PROXY", "http://ambient.invalid:3128")
    with network.request_network({"HTTPS_PROXY": "http://credential.invalid:3128"}):
        policy["whenDisabled"] = "direct"
        assert network.proxy_httpx_options("https://example.com")["proxy"] == "http://credential.invalid:3128"
    assert network.proxy_httpx_options("https://example.com")["proxy"] is None


def test_request_route_resets_context_after_failure(monkeypatch):
    policy = {**proxy_settings.DEFAULT_PROXY_SETTINGS, "whenDisabled": "direct"}
    monkeypatch.setattr(proxy_settings, "get_proxy_settings", lambda: policy)
    try:
        with network.request_network({"HTTPS_PROXY": "http://ignored.invalid:3128"}):
            assert network.proxy_httpx_options("https://example.com")["proxy"] is None
            raise RuntimeError("fixture")
    except RuntimeError:
        pass
    assert network._environment.get() is None
