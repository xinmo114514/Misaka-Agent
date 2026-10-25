from __future__ import annotations

from types import SimpleNamespace

import pytest

from misaka.ai.types import SimpleStreamOptions, ThinkingBudgets
from misaka.core.model_registry import ModelRegistry

DIRECT = {
    "enabled": False,
    "whenDisabled": "direct",
    "protocol": "http",
    "host": "127.0.0.1",
    "port": None,
}


class _Stream:
    pass


class _Runtime:
    def __init__(self):
        self.calls = []

    def stream(self, model, context, options=None):
        self.calls.append(("stream", options))
        return _Stream()

    async def complete(self, model, context, options=None):
        self.calls.append(("complete", options))
        return "complete"

    async def fetchDeferred(self, model, handle, options=None):
        self.calls.append(("fetch", options))
        return "fetched"

    async def cancelDeferred(self, model, handle, options=None):
        self.calls.append(("cancel", options))


def _registry(runtime):
    registry = ModelRegistry.__new__(ModelRegistry)
    registry._authModels = runtime
    return registry


def test_stream_freezes_proxy_env_without_serializing_typed_or_runtime_options(monkeypatch):
    from misaka.config import proxy_settings

    monkeypatch.setattr(proxy_settings, "get_proxy_settings", lambda: DIRECT)
    runtime = _Runtime()
    registry = _registry(runtime)
    signal = object()
    on_payload = lambda *_: None
    budgets = ThinkingBudgets(high=4096)
    options = SimpleStreamOptions(
        signal=signal,
        onPayload=on_payload,
        thinkingBudgets=budgets,
        env={"HTTPS_PROXY": "http://old.test:3128", "PROVIDER_REGION": "moon"},
    )

    registry.stream(SimpleNamespace(), {}, options)

    sent = runtime.calls[0][1]
    assert sent is not options
    assert sent.signal is signal
    assert sent.onPayload is on_payload
    assert sent.thinkingBudgets is budgets
    assert sent.env["HTTPS_PROXY"] == "http://old.test:3128"
    assert sent.env["PROVIDER_REGION"] == "moon"
    assert sent._misakaProxyPolicy["settings"] == DIRECT
    assert options.env["HTTPS_PROXY"] == "http://old.test:3128"


@pytest.mark.asyncio
@pytest.mark.parametrize("entry", ["complete", "fetchDeferred", "cancelDeferred"])
async def test_non_streaming_native_boundaries_freeze_policy(entry, monkeypatch):
    from misaka.config import proxy_settings

    monkeypatch.setattr(proxy_settings, "get_proxy_settings", lambda: DIRECT)
    runtime = _Runtime()
    registry = _registry(runtime)
    options = {"env": {"ALL_PROXY": "http://old.test:3128"}, "callback": object()}
    if entry == "complete":
        await registry.complete(SimpleNamespace(), {}, options)
    else:
        await getattr(registry, entry)(SimpleNamespace(), SimpleNamespace(), options)
    sent = runtime.calls[0][1]
    assert sent is not options
    assert sent["callback"] is options["callback"]
    assert sent["env"]["ALL_PROXY"] == "http://old.test:3128"
    assert sent["_misakaProxyPolicy"]["settings"] == DIRECT
    assert options["env"]["ALL_PROXY"] == "http://old.test:3128"


def test_each_new_stream_reads_live_policy_but_existing_stream_keeps_snapshot(monkeypatch):
    from misaka.config import proxy_settings

    policy = {**DIRECT, "whenDisabled": "environment"}
    monkeypatch.setattr(proxy_settings, "get_proxy_settings", lambda: dict(policy))
    monkeypatch.setenv("HTTPS_PROXY", "http://ambient.test:3128")
    runtime = _Runtime()
    registry = _registry(runtime)
    registry.stream(SimpleNamespace(), {}, None)
    policy["whenDisabled"] = "direct"
    registry.stream(SimpleNamespace(), {}, None)
    first = runtime.calls[0][1]["_misakaProxyPolicy"]
    second = runtime.calls[1][1]["_misakaProxyPolicy"]
    assert first["settings"]["whenDisabled"] == "environment"
    assert first["ambient"]["https_proxy"] == "http://ambient.test:3128"
    assert second["settings"]["whenDisabled"] == "direct"


def test_stream_simple_without_options_still_sends_typed_provider_options(monkeypatch):
    import misaka.core.model_registry as registry_module
    from misaka.config import proxy_settings

    monkeypatch.setattr(proxy_settings, "get_proxy_settings", lambda: DIRECT)
    sent = []

    def adapter(_model, _context, options):
        # Real simple adapters use attribute access for all of these fields.
        sent.append((options.temperature, options.samplingParams, options.env))
        return _Stream()

    monkeypatch.setattr(
        registry_module,
        "get_api_provider",
        lambda _api: SimpleNamespace(streamSimple=adapter),
    )
    runtime = SimpleNamespace(getProvider=lambda _provider: None)
    registry = _registry(runtime)
    registry._registeredProviders = {}
    registry._nativeProviderIds = {}
    model = SimpleNamespace(provider="fixture", id="model", api="fixture")
    stream = registry.streamSimple(model, {}, None)
    assert sent[0][0:2] == (None, None)
    assert sent[0][2]["HTTPS_PROXY"] == ""
    assert stream.effectiveNetworkEnv["HTTPS_PROXY"] == ""


@pytest.mark.asyncio
async def test_runtime_applies_environment_policy_after_credential_env_precedence(monkeypatch):
    import asyncio

    from misaka.ai.auth.types import AuthResult, ModelAuth
    from misaka.ai.models_runtime import ModelsImpl
    from misaka.ai.utils.event_stream import AssistantMessageEventStream
    from misaka.config import proxy_settings

    policy = {**DIRECT, "whenDisabled": "environment"}
    monkeypatch.setattr(proxy_settings, "get_proxy_settings", lambda: policy)
    monkeypatch.setenv("HTTPS_PROXY", "http://ambient.test:3128")
    captured = []
    called = asyncio.Event()

    def provider_stream(_model, _context, options):
        captured.append(options)
        called.set()
        stream = AssistantMessageEventStream()
        stream.end()
        return stream

    provider = SimpleNamespace(
        id="fixture",
        stream=provider_stream,
        streamSimple=provider_stream,
    )
    runtime = ModelsImpl()
    runtime.setProvider(provider)

    async def get_auth(_model, _overrides=None):
        return AuthResult(
            auth=ModelAuth(apiKey="fixture"),
            env={"HTTPS_PROXY": "http://credential.test:43129", "PROVIDER_REGION": "moon"},
            source="fixture",
        )

    runtime.getAuth = get_auth
    registry = _registry(runtime)
    model = SimpleNamespace(provider="fixture", id="model")
    stream = registry.stream(model, {}, None)
    await asyncio.wait_for(called.wait(), 3)
    assert captured[0].env["HTTPS_PROXY"] == "http://credential.test:43129"
    assert captured[0].env["PROVIDER_REGION"] == "moon"
    assert not hasattr(captured[0], "_misakaProxyPolicy")
    assert stream.effectiveNetworkEnv["HTTPS_PROXY"] == "http://credential.test:43129"


@pytest.mark.asyncio
async def test_stream_freezes_caller_env_before_gated_auth_returns(monkeypatch):
    import asyncio

    from misaka.ai.auth.types import AuthResult, ModelAuth
    from misaka.ai.models_runtime import ModelsImpl
    from misaka.ai.utils.event_stream import AssistantMessageEventStream
    from misaka.config import proxy_settings

    monkeypatch.setattr(
        proxy_settings,
        "get_proxy_settings",
        lambda: {**DIRECT, "whenDisabled": "environment"},
    )
    auth_entered = asyncio.Event()
    auth_release = asyncio.Event()
    provider_called = asyncio.Event()
    captured = []

    def provider_stream(_model, _context, options):
        captured.append(options)
        provider_called.set()
        stream = AssistantMessageEventStream()
        stream.end()
        return stream

    runtime = ModelsImpl()
    runtime.setProvider(
        SimpleNamespace(
            id="fixture", stream=provider_stream, streamSimple=provider_stream
        )
    )

    async def get_auth(_model, _overrides=None):
        auth_entered.set()
        await auth_release.wait()
        return AuthResult(auth=ModelAuth(apiKey="fixture"), source="fixture")

    runtime.getAuth = get_auth
    registry = _registry(runtime)
    options = SimpleStreamOptions(
        env={"HTTPS_PROXY": "http://admitted.test:3128"}
    )
    registry.stream(SimpleNamespace(provider="fixture", id="model"), {}, options)
    await asyncio.wait_for(auth_entered.wait(), 3)
    options.env["HTTPS_PROXY"] = "http://mutated.test:9999"
    auth_release.set()
    await asyncio.wait_for(provider_called.wait(), 3)
    assert captured[0].env["HTTPS_PROXY"] == "http://admitted.test:3128"
