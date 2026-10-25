"""Constructor-only Google endpoint/routing regressions; never issue requests."""

from types import SimpleNamespace
from urllib.parse import urlsplit

import httpx
import pytest
from google.genai import _base_url

from misaka.ai.providers import google, google_vertex
from misaka.ai.types import Model


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("MISAKA_HOME", str(tmp_path))
    for name in (
        "http_proxy", "https_proxy", "all_proxy", "no_proxy", "ssl_cert_file", "ssl_cert_dir",
        "GOOGLE_VERTEX_BASE_URL", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_CLOUD_LOCATION",
        "GOOGLE_CLOUD_PROJECT", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_ENTERPRISE",
        "GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
        monkeypatch.delenv(name.upper(), raising=False)
    monkeypatch.setattr(_base_url, "_default_base_gemini_url", None)
    monkeypatch.setattr(_base_url, "_default_base_vertex_url", None)
    import google.auth

    monkeypatch.setattr(google.auth, "default", lambda *_args, **_kwargs: pytest.fail("Unexpected ADC lookup"))
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", lambda *_args, **_kwargs: pytest.fail("Unexpected HTTP request"))
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", lambda *_args, **_kwargs: pytest.fail("Unexpected async HTTP request"))


def model(base_url="", vertex=True):
    return Model(id="fixture", name="Fixture", provider="google-vertex" if vertex else "google",
        api="google-vertex" if vertex else "google-generative-ai", baseUrl=base_url,
        reasoning=False, input=["text"], cost={"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        contextWindow=4096, maxTokens=128)


@pytest.mark.parametrize("vertex,base_url,location,default_url,env_url,want", [
    (True, "https://explicit.invalid/v1", "us-central1", "https://sdk.invalid", "http://env.invalid", "https://explicit.invalid/v1"),
    (True, "https://{location}-aiplatform.googleapis.com", "global", None, None, "https://aiplatform.googleapis.com"),
    (True, "", "us", None, None, "https://aiplatform.us.rep.googleapis.com"),
    (True, "", "eu", None, None, "https://aiplatform.eu.rep.googleapis.com"),
    (True, "", "us-central1", None, None, "https://us-central1-aiplatform.googleapis.com"),
    (True, "", "global", "http://sdk.invalid/v2", "https://env.invalid", "http://sdk.invalid/v2"),
    (True, "", "us-central1", None, "http://env.invalid/v2", "http://env.invalid/v2"),
    (False, "https://explicit.invalid/v1", "global", "http://sdk.invalid", "http://env.invalid", "https://explicit.invalid/v1"),
    (False, "", "global", None, None, "https://generativelanguage.googleapis.com"),
    (False, "", "global", "http://sdk.invalid", "https://env.invalid", "http://sdk.invalid"),
    (False, "", "global", None, "http://env.invalid", "http://env.invalid"),
])
@pytest.mark.parametrize("bypass", [False, True])
async def test_sdk_effective_endpoint_and_frozen_transport_route_agree(vertex, base_url, location, default_url, env_url, want, bypass, monkeypatch):
    if default_url:
        _base_url.set_default_base_urls(None if vertex else default_url, default_url if vertex else None)
    if env_url:
        monkeypatch.setenv("GOOGLE_VERTEX_BASE_URL" if vertex else "GOOGLE_GEMINI_BASE_URL", env_url)
    scoped = {"HTTP_PROXY": "http://http-proxy.invalid:3128", "HTTPS_PROXY": "http://https-proxy.invalid:3129",
              "NO_PROXY": urlsplit(want).hostname if bypass else ""}
    if vertex:
        client = google_vertex.create_client(model(base_url), "fixture-project", location, env=scoped)
    else:
        client = google.create_client(model(base_url, False), "fixture-key", env=scoped)
    try:
        options = client._api_client._http_options
        assert options.base_url.rstrip("/") == want
        expected_proxy = None if bypass else scoped["HTTP_PROXY" if want.startswith("http:") else "HTTPS_PROXY"]
        assert options.client_args["proxy"] == expected_proxy
        assert options.client_args["trust_env"] is False
        assert options.async_client_args["trust_env"] is False
        assert options.async_client_args["transport"]._pool.__class__.__name__ == ("AsyncConnectionPool" if bypass else "AsyncHTTPProxy")
        if vertex:
            assert options.api_version == ("" if base_url.endswith("/v1") else "v1")
            assert options.base_url_resource_scope == ("COLLECTION" if base_url and "{location}" not in base_url else None)
        else:
            assert options.api_version == ("" if base_url else "v1beta")
    finally:
        client.close()
        await client.aio.aclose()


@pytest.mark.parametrize("location,want", [("global", "https://aiplatform.googleapis.com"), ("us", "https://aiplatform.us.rep.googleapis.com"), ("asia-east1", "https://asia-east1-aiplatform.googleapis.com")])
def test_saved_route_resolves_real_vertex_catalog_template_without_auth(location, want, monkeypatch):
    from misaka.ai.models import get_model
    from misaka.cli.desktop_bridge import _proxy_settings_snapshot

    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", location)
    catalog_model = get_model("google-vertex", "gemini-2.5-flash")
    assert "{location}" in catalog_model.baseUrl
    storage = SimpleNamespace(runtimeOverrides={}, get=lambda _provider: None)
    session = SimpleNamespace(model=catalog_model, modelRegistry=SimpleNamespace(authStorage=storage))
    snapshot = _proxy_settings_snapshot(session, {"enabled": False, "whenDisabled": "direct", "protocol": "http", "host": "127.0.0.1", "port": None})
    assert "routeError" not in snapshot
    assert snapshot["route"] == {"mode": "direct", "endpoint": want}


@pytest.mark.parametrize("vertex", [True, False])
async def test_endpoint_is_pinned_before_transport_construction(vertex, monkeypatch):
    _base_url.set_default_base_urls("http://original.invalid", "http://original.invalid")
    real_transport = google.httpx.AsyncHTTPTransport

    def change_default_during_transport_setup(**kwargs):
        _base_url.set_default_base_urls("https://changed.invalid", "https://changed.invalid")
        return real_transport(**kwargs)

    monkeypatch.setattr(google.httpx, "AsyncHTTPTransport", change_default_during_transport_setup)
    if vertex:
        client = google_vertex.create_client_with_api_key(model(), "fixture-key")
    else:
        client = google.create_client(model(vertex=False), "fixture-key")
    try:
        assert client._api_client._http_options.base_url == "http://original.invalid"
    finally:
        client.close()
        await client.aio.aclose()


@pytest.mark.parametrize("key_source,want", [
    ("adc", "https://us-central1-aiplatform.googleapis.com"),
    ("stored", "https://aiplatform.googleapis.com"),
    ("runtime", "https://aiplatform.googleapis.com"),
    ("ambient", "https://aiplatform.googleapis.com"),
])
async def test_vertex_saved_route_matches_api_key_global_or_adc_process_location(key_source, want, monkeypatch):
    from misaka.cli.desktop_bridge import _proxy_settings_snapshot

    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "fixture-project")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "us-central1")
    stored = {"type": "api_key", "env": {"GOOGLE_CLOUD_LOCATION": "europe-west1"}}
    runtime_keys = {}
    if key_source == "stored":
        stored["key"] = "fixture-key"
    elif key_source == "runtime":
        runtime_keys["google-vertex"] = "fixture-key"
    elif key_source == "ambient":
        monkeypatch.setenv("GOOGLE_CLOUD_API_KEY", "fixture-key")
    storage = SimpleNamespace(runtimeOverrides=runtime_keys, get=lambda _provider: stored)
    selected = model("https://{location}-aiplatform.googleapis.com")
    session = SimpleNamespace(model=selected, modelRegistry=SimpleNamespace(authStorage=storage))
    snapshot = _proxy_settings_snapshot(session, {"enabled": False, "whenDisabled": "direct", "protocol": "http", "host": "127.0.0.1", "port": None})
    assert snapshot["route"] == {"mode": "direct", "endpoint": want}
    # Exercise the actual constructor branch selected by stream_google_vertex,
    # without entering auth resolution or opening a model stream.
    api_key = google_vertex.resolve_api_key({"apiKey": "fixture-key" if key_source in {"stored", "runtime"} else None})
    if api_key:
        client = google_vertex.create_client_with_api_key(selected, api_key)
    else:
        client = google_vertex.create_client(selected, google_vertex.resolve_project(), google_vertex.resolve_location())
    try:
        assert client._api_client._http_options.base_url == want
    finally:
        client.close()
        await client.aio.aclose()


@pytest.mark.parametrize("configured_key", ["fixture-configured-key", "$FIXTURE_VERTEX_KEY"])
async def test_vertex_saved_route_uses_loaded_configured_key_before_adc_location(configured_key, monkeypatch):
    from misaka.cli.desktop_bridge import _proxy_settings_snapshot

    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "fixture-project")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "us-central1")
    monkeypatch.setenv("FIXTURE_VERTEX_KEY", "fixture-configured-key")
    monkeypatch.setenv("NO_PROXY", "aiplatform.googleapis.com")
    storage = SimpleNamespace(runtimeOverrides={}, get=lambda _provider: None)
    registry = SimpleNamespace(
        authStorage=storage,
        _providerRequestConfigs={"google-vertex": SimpleNamespace(apiKey=configured_key)},
    )
    selected = model("https://{location}-aiplatform.googleapis.com")
    session = SimpleNamespace(model=selected, modelRegistry=registry)
    snapshot = _proxy_settings_snapshot(session, {
        "enabled": True, "whenDisabled": "direct", "protocol": "http", "host": "proxy.invalid", "port": 3128,
    })
    assert snapshot["route"] == {
        "mode": "direct", "endpoint": "https://aiplatform.googleapis.com",
    }

    # The configured auth plan hands the resolved key to this exact stream branch;
    # inspect the real SDK constructor without invoking auth or issuing a request.
    client = google_vertex.create_client_with_api_key(selected, "fixture-configured-key")
    try:
        assert client._api_client._http_options.base_url == snapshot["route"]["endpoint"]
    finally:
        client.close()
        await client.aio.aclose()


@pytest.mark.parametrize("configured_key,env_value", [
    ("<fixture-placeholder>", None),
    ("$FIXTURE_VERTEX_KEY", "<fixture-placeholder>"),
])
def test_vertex_configured_placeholder_does_not_select_express_endpoint(configured_key, env_value, monkeypatch):
    from misaka.cli.desktop_bridge import _ordinary_model_network_context

    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "us-central1")
    if env_value is not None:
        monkeypatch.setenv("FIXTURE_VERTEX_KEY", env_value)
    storage = SimpleNamespace(runtimeOverrides={}, get=lambda _provider: None)
    registry = SimpleNamespace(
        authStorage=storage,
        _providerRequestConfigs={"google-vertex": SimpleNamespace(apiKey=configured_key)},
    )
    session = SimpleNamespace(model=model("https://{location}-aiplatform.googleapis.com"), modelRegistry=registry)
    endpoint, _ = _ordinary_model_network_context(session)
    assert endpoint == "https://us-central1-aiplatform.googleapis.com"
