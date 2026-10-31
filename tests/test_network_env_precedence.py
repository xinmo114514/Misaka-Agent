"""Caller proxy/certificate aliases override credential layers before flattening."""

from types import SimpleNamespace

import pytest

from misaka.ai.auth.resolve import AuthResolutionOverrides, resolveProviderAuth
from misaka.ai.auth.types import (
    ApiKeyAuth,
    ApiKeyCredential,
    AuthResult,
    ModelAuth,
    ProviderAuth,
)
from misaka.ai.models import _ModelsImpl as ModelsImpl

NETWORK_KEYS = ["http_proxy", "https_proxy", "all_proxy", "no_proxy", "ssl_cert_file", "ssl_cert_dir"]


@pytest.fixture(autouse=True)
def isolated_home(monkeypatch, tmp_path):
    monkeypatch.setenv("MISAKA_HOME", str(tmp_path))
    for name in NETWORK_KEYS:
        monkeypatch.delenv(name, raising=False)
        monkeypatch.delenv(name.upper(), raising=False)


@pytest.mark.parametrize("name", NETWORK_KEYS)
@pytest.mark.parametrize("caller_upper", [False, True])
@pytest.mark.parametrize("value", ["", "caller-value"])
@pytest.mark.parametrize("with_policy", [False, True])
async def test_runtime_caller_network_alias_wins_over_opposite_credential_case(name, caller_upper, value, with_policy):
    runtime = ModelsImpl()
    runtime.setProvider(SimpleNamespace(id="fixture"))
    caller_key = name.upper() if caller_upper else name
    credential_key = name if caller_upper else name.upper()

    async def get_auth(_model, _overrides):
        return AuthResult(auth=ModelAuth(apiKey="fixture"), env={credential_key: "credential-value", "CREDENTIAL_ONLY": "preserved"})

    runtime.getAuth = get_auth
    options = {"env": {caller_key: value, "CALLER_ONLY": "preserved"}}
    if with_policy:
        options["_misakaProxyPolicy"] = {
            "ambient": {name: "admission-value"},
            "settings": {"enabled": False, "whenDisabled": "environment", "protocol": "http", "host": "127.0.0.1", "port": None},
        }
    _, request = await runtime._applyAuth(SimpleNamespace(provider="fixture"), options)
    assert request.env[name] == value
    assert request.env[name.upper()] == value
    assert request.env["CREDENTIAL_ONLY"] == request.env["CALLER_ONLY"] == "preserved"


@pytest.mark.parametrize("name", NETWORK_KEYS)
@pytest.mark.parametrize("caller_upper", [False, True])
@pytest.mark.parametrize("value", ["", "caller-value"])
async def test_auth_credential_merge_preserves_caller_alias_precedence(name, caller_upper, value):
    caller_key = name.upper() if caller_upper else name
    credential_key = name if caller_upper else name.upper()
    credential = ApiKeyCredential(key="fixture", env={credential_key: "credential-value", "KEEP": "stored"})

    async def read(*_args):
        return credential

    async def resolve(*, ctx, credential, signal):
        return AuthResult(auth=ModelAuth(apiKey=credential.key), env=credential.env)

    provider = SimpleNamespace(id="fixture", auth=ProviderAuth(apiKey=ApiKeyAuth(name="fixture", resolve=resolve)))
    result = await resolveProviderAuth(provider, SimpleNamespace(read=read), SimpleNamespace(),
        AuthResolutionOverrides(env={caller_key: value, "EXTRA": "caller"}))
    assert result.env[name] == result.env[name.upper()] == value
    assert result.env["KEEP"] == "stored"
    assert result.env["EXTRA"] == "caller"
    assert credential.env == {credential_key: "credential-value", "KEEP": "stored"}


@pytest.mark.parametrize("value", ["", "caller-value"])
async def test_auth_context_reads_caller_alias_and_empty_without_ambient_fallthrough(value):
    async def read(*_args):
        return None

    async def ambient_env(_name):
        return "ambient-value"

    async def resolve(*, ctx, credential, signal):
        return AuthResult(auth=ModelAuth(apiKey="fixture"), env={"https_proxy": await ctx.env("https_proxy")})

    provider = SimpleNamespace(id="fixture", auth=ProviderAuth(apiKey=ApiKeyAuth(name="fixture", resolve=resolve)))
    result = await resolveProviderAuth(provider, SimpleNamespace(read=read), SimpleNamespace(env=ambient_env),
        AuthResolutionOverrides(env={"HTTPS_PROXY": value}))
    assert result.env["https_proxy"] == value
