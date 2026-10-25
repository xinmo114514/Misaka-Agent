from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

DEFAULTS = {
    "enabled": False,
    "whenDisabled": "environment",
    "protocol": "http",
    "host": "127.0.0.1",
    "port": None,
}


@pytest.fixture
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("MISAKA_HOME", str(tmp_path))
    return tmp_path


def test_absent_settings_use_environment_compatible_defaults(isolated_home):
    from misaka.config.proxy_settings import get_proxy_settings

    assert get_proxy_settings() == DEFAULTS


@pytest.mark.parametrize(
    "settings",
    [
        {**DEFAULTS, "enabled": "yes"},
        {**DEFAULTS, "whenDisabled": "system"},
        {**DEFAULTS, "whenDisabled": []},
        {**DEFAULTS, "protocol": "ftp"},
        {**DEFAULTS, "protocol": {}},
        {**DEFAULTS, "host": "http://proxy.test"},
        {**DEFAULTS, "host": "user:pass@proxy.test"},
        {**DEFAULTS, "host": "proxy.test/path"},
        {**DEFAULTS, "enabled": True, "port": None},
        {**DEFAULTS, "enabled": True, "port": 0},
        {**DEFAULTS, "enabled": True, "port": 65536},
        {**DEFAULTS, "enabled": True, "port": True},
    ],
)
def test_validation_rejects_invalid_values_without_coercion(settings):
    from misaka.config.proxy_settings import validate_proxy_settings

    with pytest.raises(ValueError):
        validate_proxy_settings(settings)


@pytest.mark.parametrize("host", ["proxy.test", "127.0.0.1", "2001:db8::1"])
@pytest.mark.parametrize("port", [1, 32181, 65535])
def test_validation_accepts_dns_ip_and_arbitrary_ports(host, port):
    from misaka.config.proxy_settings import validate_proxy_settings

    value = {**DEFAULTS, "enabled": True, "protocol": "socks5h", "host": host, "port": port}
    assert validate_proxy_settings(value) == value


def test_direct_mode_clears_both_proxy_cases_but_preserves_other_values(monkeypatch):
    from misaka.config.proxy_settings import proxy_request_env

    monkeypatch.setenv("HTTPS_PROXY", "http://ambient.test:3128")
    result = proxy_request_env(
        {"https_proxy": "http://scoped.test:3129", "SSL_CERT_FILE": "fixture.pem", "PROVIDER_REGION": "moon"},
        settings={**DEFAULTS, "whenDisabled": "direct"},
    )
    for name in ("http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
        assert result[name] == ""
    assert result["SSL_CERT_FILE"] == "fixture.pem"
    assert result["PROVIDER_REGION"] == "moon"


def test_environment_mode_freezes_scoped_precedence_and_authenticated_url(monkeypatch):
    from misaka.config.proxy_settings import proxy_request_env

    monkeypatch.setenv("HTTPS_PROXY", "http://ambient.test:3128")
    value = "http://user:secret@scoped.test:4567"
    frozen = proxy_request_env({"https_proxy": value}, settings=DEFAULTS)
    monkeypatch.setenv("HTTPS_PROXY", "http://changed.test:9999")
    assert frozen["https_proxy"] == value
    assert frozen["HTTPS_PROXY"] == value


def test_custom_proxy_overrides_all_proxy_cases_and_honors_effective_no_proxy(monkeypatch):
    from misaka.ai.utils.network_route import resolve_network_route
    from misaka.config.proxy_settings import proxy_request_env

    monkeypatch.setenv("NO_PROXY", "model.test")
    settings = {**DEFAULTS, "enabled": True, "protocol": "socks5h", "host": "2001:db8::1", "port": 32183}
    result = proxy_request_env({"HTTPS_PROXY": "http://old.test:1"}, settings=settings)
    for name in ("http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
        assert result[name] == "socks5h://[2001:db8::1]:32183"
    assert resolve_network_route("https://model.test/v1", result).proxy_url is None
    assert resolve_network_route("https://other.test/v1", result).proxy_url == "socks5h://[2001:db8::1]:32183"


def test_invalid_persisted_proxy_is_a_configuration_error(isolated_home):
    from misaka.config.proxy_settings import get_proxy_settings

    (isolated_home / "settings.json").write_text(
        json.dumps({"network": {"proxy": {**DEFAULTS, "enabled": True, "port": None}}}), encoding="utf-8"
    )
    with pytest.raises(ValueError, match="network.proxy"):
        get_proxy_settings()


def test_reader_observes_cross_instance_file_updates(isolated_home):
    from misaka.config.proxy_settings import get_proxy_settings

    path = isolated_home / "settings.json"
    path.write_text(json.dumps({"unrelated": {"keep": True}}), encoding="utf-8")
    assert get_proxy_settings() == DEFAULTS
    changed = {**DEFAULTS, "whenDisabled": "direct"}
    path.write_text(json.dumps({"unrelated": {"keep": True}, "network": {"proxy": changed}}), encoding="utf-8")
    assert get_proxy_settings() == changed


def test_httpx_options_use_effective_application_policy(monkeypatch):
    from misaka.config.proxy_settings import proxy_httpx_options

    monkeypatch.setenv("HTTPS_PROXY", "http://ambient.test:3128")
    options = proxy_httpx_options(
        "https://model.test/v1", settings={**DEFAULTS, "enabled": True, "host": "proxy.test", "port": 45678}
    )
    assert options["trust_env"] is False
    assert options["proxy"] == "http://proxy.test:45678"


@pytest.mark.parametrize(
    "imports",
    [
        "import misaka.config.proxy_settings; import misaka.ai.utils.network_route",
        "import misaka.ai.utils.network_route; import misaka.config.proxy_settings",
    ],
)
def test_proxy_module_import_order_has_no_ai_config_cycle(tmp_path, imports):
    env = {**os.environ, "MISAKA_HOME": str(tmp_path)}
    # Keep the active virtual environment: the base interpreter does not have
    # this project's dependencies and would test a different installation.
    try:
        result = subprocess.run(
            [sys.executable, "-c", imports],
            env=env,
            timeout=30,
            close_fds=True,
            check=False,
        )
    except PermissionError as error:
        if os.name == "nt" and getattr(error, "winerror", None) == 5:
            pytest.skip(f"Windows host denied this fresh interpreter launch: {error}")
        raise
    assert result.returncode == 0
