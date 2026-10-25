"""Native OAuth HTTP calls read current global policy at each actual endpoint."""

import json
import os

import httpx
import pytest

from misaka.ai.utils.oauth import (
    anthropic,
    github_copilot,
    kimi_coding,
    meta,
    openai_codex,
    openrouter,
    radius,
    xai,
)


@pytest.fixture(autouse=True)
def isolated_home(monkeypatch, tmp_path):
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
    return tmp_path


CASES = [
    "anthropic",
    "copilot",
    "copilot_policy",
    "copilot_retry",
    "kimi",
    "meta",
    "codex_exchange",
    "codex_refresh",
    "codex_device",
    "codex_poll",
    "openrouter",
    "radius_get",
    "radius_post",
    "xai",
]


async def oauth_call(case, endpoint, monkeypatch):
    if case == "anthropic":
        return await anthropic._post_json(endpoint, {"grant_type": "refresh_token"})
    if case == "copilot":
        return await github_copilot._fetch_json(endpoint)
    if case == "copilot_policy":
        monkeypatch.setattr(
            github_copilot, "get_github_copilot_base_url", lambda *_: endpoint
        )
        return await github_copilot._enable_github_copilot_model("token", "model")
    if case == "copilot_retry":
        return await github_copilot._fetch_with_rate_limit_retry(
            endpoint, {}, None, 0, 1000
        )
    if case == "kimi":
        return await kimi_coding._default_post_form(endpoint, {}, None)
    if case == "meta":
        return await meta._default_post(endpoint, {}, "{}", None)
    if case.startswith("codex_"):
        attr = {
            "codex_exchange": "TOKEN_URL",
            "codex_refresh": "TOKEN_URL",
            "codex_device": "DEVICE_USER_CODE_URL",
            "codex_poll": "DEVICE_TOKEN_URL",
        }[case]
        monkeypatch.setattr(openai_codex, attr, endpoint)
        if case == "codex_exchange":
            return await openai_codex._exchange_authorization_code("code", "verifier")
        if case == "codex_refresh":
            return await openai_codex._refresh_access_token("refresh")
        if case == "codex_device":
            return await openai_codex._start_device_auth()
        return await openai_codex._poll_device_auth(
            {"deviceAuthId": "device", "userCode": "user", "intervalSeconds": 0}
        )
    if case == "openrouter":
        return await openrouter._post_json(endpoint, "{}", {})
    if case == "radius_get":
        return await radius._default_get_json(endpoint, {}, None)
    if case == "radius_post":
        return await radius._default_post_form(endpoint, {}, None)
    if case == "xai":
        return await xai._http_post_form(endpoint, {})


def write_policy(home, mode):
    settings = {
        "enabled": mode == "custom",
        "whenDisabled": "direct" if mode == "direct" else "environment",
        "protocol": "socks5h",
        "host": "proxy.invalid",
        "port": 31337,
    }
    (home / "settings.json").write_text(
        json.dumps({"network": {"proxy": settings}}), encoding="utf-8"
    )


@pytest.mark.parametrize("case", CASES)
async def test_every_oauth_http_path_uses_live_endpoint_policy(
    case, monkeypatch, isolated_home
):
    captured = []
    real = httpx.AsyncClient

    def client(**kwargs):
        captured.append(dict(kwargs))
        return real(
            **(
                kwargs
                | {
                    "proxy": None,
                    "transport": httpx.MockTransport(
                        lambda request: httpx.Response(
                            200,
                            json={
                                "access_token": "access",
                                "refresh_token": "refresh",
                                "expires_in": 100,
                                "device_auth_id": "device",
                                "user_code": "user",
                                "interval": 0,
                                "authorization_code": "code",
                                "code_verifier": "verifier",
                            },
                            request=request,
                        )
                    ),
                }
            )
        )

    monkeypatch.setattr(httpx, "AsyncClient", client)
    monkeypatch.setenv("HTTPS_PROXY", "http://inherited.invalid:1")
    before = dict(os.environ)
    endpoint = "https://auth.invalid/token"
    for mode, want in [
        ("custom", "socks5h://proxy.invalid:31337"),
        ("direct", None),
        ("environment", "http://inherited.invalid:1"),
    ]:
        write_policy(isolated_home, mode)
        await oauth_call(case, endpoint, monkeypatch)
        assert captured[-1].get("trust_env") is False
        assert captured[-1].get("proxy") == want
    assert dict(os.environ) == before


@pytest.mark.parametrize("case", CASES)
async def test_oauth_no_proxy_matches_actual_token_host(
    case, monkeypatch, isolated_home
):
    write_policy(isolated_home, "custom")
    monkeypatch.setenv("NO_PROXY", "auth.invalid")
    captured = []
    real = httpx.AsyncClient

    def client(**kwargs):
        captured.append(dict(kwargs))
        return real(
            **(
                kwargs
                | {
                    "proxy": None,
                    "transport": httpx.MockTransport(
                        lambda request: httpx.Response(
                            200,
                            json={
                                "access_token": "access",
                                "refresh_token": "refresh",
                                "expires_in": 100,
                                "device_auth_id": "device",
                                "user_code": "user",
                                "interval": 0,
                                "authorization_code": "code",
                                "code_verifier": "verifier",
                            },
                            request=request,
                        )
                    ),
                }
            )
        )

    monkeypatch.setattr(httpx, "AsyncClient", client)
    await oauth_call(case, "https://auth.invalid/token", monkeypatch)
    assert captured[-1].get("trust_env") is False
    assert captured[-1].get("proxy") is None


async def test_copilot_retry_reads_policy_for_each_actual_http_call(
    monkeypatch, isolated_home
):
    write_policy(isolated_home, "custom")
    captured = []
    real = httpx.AsyncClient

    def reply(request):
        if len(captured) == 1:
            write_policy(isolated_home, "direct")
            return httpx.Response(429, headers={"retry-after": "0"}, request=request)
        return httpx.Response(200, json={}, request=request)

    def client(**kwargs):
        captured.append(dict(kwargs))
        return real(
            **(kwargs | {"proxy": None, "transport": httpx.MockTransport(reply)})
        )

    monkeypatch.setattr(httpx, "AsyncClient", client)
    response = await github_copilot._fetch_with_rate_limit_retry(
        "https://auth.invalid/models", {}, None, 1, 1000
    )
    assert response.status_code == 200
    assert [options["proxy"] for options in captured] == [
        "socks5h://proxy.invalid:31337",
        None,
    ]
