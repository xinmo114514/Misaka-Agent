"""Live, global application proxy policy for native model requests.

The policy is deliberately separate from :mod:`misaka.ai.utils.network_route`:
that module remains a pure interpreter of an already-frozen environment, while
this module reads the application setting and produces that environment once at
a request boundary.
"""

from __future__ import annotations

import ipaddress
import json
import re
from collections.abc import Mapping
from typing import Any

from misaka.config import home

DEFAULT_PROXY_SETTINGS: dict[str, Any] = {
    "enabled": False,
    "whenDisabled": "environment",
    "protocol": "http",
    "host": "127.0.0.1",
    "port": None,
}

_FIELDS = frozenset(DEFAULT_PROXY_SETTINGS)
_PROTOCOLS = frozenset({"http", "https", "socks5", "socks5h"})
_PROXY_NAMES = ("http_proxy", "https_proxy", "all_proxy")
_NETWORK_NAMES = (*_PROXY_NAMES, "no_proxy", "ssl_cert_file", "ssl_cert_dir")
_DNS_LABEL = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?")


def _valid_host(value: str) -> bool:
    if not value or value != value.strip() or re.search(r"[\s\\/@?#\x00-\x1f\x7f]", value):
        return False
    # Brackets belong to a URL, not the editable host field.
    if value.startswith("[") or value.endswith("]"):
        return False
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        pass
    try:
        ascii_host = value.encode("idna").decode("ascii").rstrip(".")
    except UnicodeError:
        return False
    return bool(ascii_host) and len(ascii_host) <= 253 and all(
        _DNS_LABEL.fullmatch(label) is not None for label in ascii_host.split(".")
    )


def validate_proxy_settings(value: Any) -> dict[str, Any]:
    """Validate and copy one complete ``network.proxy`` object."""
    if not isinstance(value, Mapping):
        raise ValueError("network.proxy must be an object")  # noqa: TRY004 - configuration error
    missing = _FIELDS.difference(value)
    extra = set(value).difference(_FIELDS)
    if missing or extra:
        detail = "missing " + ", ".join(sorted(missing)) if missing else "unknown " + ", ".join(sorted(extra))
        raise ValueError(f"network.proxy has {detail} fields")

    enabled = value["enabled"]
    if not isinstance(enabled, bool):
        raise ValueError("network.proxy.enabled must be a boolean")  # noqa: TRY004 - configuration error
    when_disabled = value["whenDisabled"]
    if not isinstance(when_disabled, str) or when_disabled not in {"direct", "environment"}:
        raise ValueError("network.proxy.whenDisabled must be direct or environment")
    protocol = value["protocol"]
    if not isinstance(protocol, str) or protocol not in _PROTOCOLS:
        raise ValueError("network.proxy.protocol must be http, https, socks5 or socks5h")
    host = value["host"]
    if not isinstance(host, str) or not _valid_host(host):
        raise ValueError("network.proxy.host must be an IPv4, IPv6 or DNS host without URL syntax")
    port = value["port"]
    if port is not None and (isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535):
        raise ValueError("network.proxy.port must be an integer from 1 to 65535 or null")
    if enabled and port is None:
        raise ValueError("network.proxy.port is required while the proxy is enabled")
    return {
        "enabled": enabled,
        "whenDisabled": when_disabled,
        "protocol": protocol,
        "host": host,
        "port": port,
    }


def get_proxy_settings() -> dict[str, Any]:
    """Read the global settings file now; malformed saved policy is an error."""
    target = home.path("settings")
    try:
        with open(target, encoding="utf-8-sig") as handle:
            document = json.load(handle)
    except FileNotFoundError:
        return dict(DEFAULT_PROXY_SETTINGS)
    except (OSError, ValueError) as error:
        raise ValueError(f"Invalid global settings.json: {type(error).__name__}") from None
    if not isinstance(document, dict):
        raise ValueError("Invalid global settings.json: root must be an object")  # noqa: TRY004
    network = document.get("network")
    if network is None:
        return dict(DEFAULT_PROXY_SETTINGS)
    if not isinstance(network, dict):
        raise ValueError("network must be an object")  # noqa: TRY004 - configuration error
    if "proxy" not in network:
        return dict(DEFAULT_PROXY_SETTINGS)
    return validate_proxy_settings(network["proxy"])


def _effective_environment(env: Mapping[str, str] | None) -> dict[str, str]:
    from misaka.ai.utils.network_route import snapshot_network_env

    result = dict(env or {})
    frozen = snapshot_network_env(env)
    # Populate both spellings so SDKs which inspect one spelling directly and the
    # shared resolver which applies lowercase precedence see the same frozen route.
    for name in _NETWORK_NAMES:
        value = frozen[name]
        result[name] = value
        result[name.upper()] = value
    return result


def _proxy_url(settings: Mapping[str, Any]) -> str:
    host = settings["host"]
    rendered_host = f"[{host}]" if ":" in host else host
    return f"{settings['protocol']}://{rendered_host}:{settings['port']}"


def proxy_request_env(
    env: Mapping[str, str] | None = None, *, settings: Mapping[str, Any] | None = None
) -> dict[str, str]:
    """Freeze ``env`` and apply the current application proxy policy once."""
    policy = validate_proxy_settings(settings) if settings is not None else get_proxy_settings()
    result = _effective_environment(env)
    if policy["enabled"]:
        proxy = _proxy_url(policy)
    elif policy["whenDisabled"] == "direct":
        proxy = ""
    else:
        return result
    for name in _PROXY_NAMES:
        result[name] = proxy
        result[name.upper()] = proxy
    return result


def proxy_httpx_options(
    endpoint: str,
    env: Mapping[str, str] | None = None,
    *,
    settings: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """HTTPX options for the request-scoped effective application route."""
    from misaka.ai.utils.network_route import httpx_client_options

    return httpx_client_options(endpoint, proxy_request_env(env, settings=settings))


__all__ = [
    "DEFAULT_PROXY_SETTINGS",
    "get_proxy_settings",
    "proxy_httpx_options",
    "proxy_request_env",
    "validate_proxy_settings",
]
