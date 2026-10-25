"""Explicit request-scoped model routes, without platform proxy discovery.

Only environment mappings are consulted. An empty scoped value clears the
corresponding ambient value, and lowercase wins within each environment layer.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import re
import ssl
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import SplitResult, parse_qsl, unquote, urlsplit

_PORTS = {"http": 80, "https": 443, "ws": 80, "wss": 443, "socks5": 1080, "socks5h": 1080}
_ENV_NAMES = ("http_proxy", "https_proxy", "all_proxy", "no_proxy", "ssl_cert_file", "ssl_cert_dir")


def _env_value(name: str, env: Mapping[str, str] | None = None) -> str:
    for layer in (env, os.environ):
        if layer is not None:
            for key in (name.lower(), name.upper()):
                if key in layer:
                    return layer[key] or ""
    return ""


def snapshot_network_env(env: Mapping[str, str] | None = None) -> dict[str, str]:
    """Freeze network configuration across retries and WS-to-SSE fallback."""
    return {name: _env_value(name, env) for name in _ENV_NAMES}


def _parse_url(value: str, *, proxy: bool = False) -> SplitResult:
    label = "proxy" if proxy else "endpoint"
    try:
        if not isinstance(value, str) or not value or re.search(r"[\s\\\x00-\x1f\x7f]", value):
            raise ValueError()
        parsed = urlsplit(value)
        allowed = {"http", "https", "socks5", "socks5h"} if proxy else {"http", "https", "ws", "wss"}
        if parsed.scheme not in allowed or not parsed.hostname or not parsed.netloc:
            raise ValueError()
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError()
        # A trailing empty port is almost always malformed configuration.
        if parsed.netloc.rsplit("@", 1)[-1].endswith(":"):
            raise ValueError()
        host = parsed.hostname
        if ":" in host:
            ipaddress.IPv6Address(host)
        else:
            ascii_host = host.encode("idna").decode("ascii").rstrip(".")
            if len(ascii_host) > 253 or any(not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label) for label in ascii_host.split(".")):
                raise ValueError()
        if proxy and (parsed.path not in {"", "/"} or "?" in value or "#" in value):
            raise ValueError()
        return parsed
    except (ValueError, UnicodeError, TypeError):
        # Never echo the URL: it can contain proxy passwords and model API keys.
        raise ValueError(f"Invalid {label} URL: check scheme, host, port and path") from None


def _origin(parsed: SplitResult) -> str:
    host = parsed.hostname or ""
    if ":" in host:
        host = f"[{host}]"
    port = f":{parsed.port}" if parsed.port is not None else ""
    return f"{parsed.scheme}://{host}{port}"


def _bypasses_proxy(endpoint: SplitResult, no_proxy: str) -> bool:
    # Match HTTPX domain conventions: bare names include subdomains, leading
    # dots / '*.name' exclude the apex, IPs and localhost match exactly.
    scheme = {"ws": "http", "wss": "https"}.get(endpoint.scheme, endpoint.scheme)
    host = (endpoint.hostname or "").lower().rstrip(".")
    port = endpoint.port or _PORTS[endpoint.scheme]
    for token in no_proxy.split(","):
        token = token.strip().lower()
        if token == "*":
            return True
        if not token:
            continue
        try:
            qualified = "://" in token
            if qualified:
                parsed = urlsplit(token)
                if parsed.scheme not in {scheme, "all"}:
                    continue
                pattern, pattern_port = parsed.hostname or "", parsed.port
                # Explicit standard ports still restrict bypass to that port.
            else:
                try:
                    ipaddress.ip_address(token)
                    pattern, pattern_port = token, None
                except ValueError:
                    parsed = urlsplit(f"all://{token}")
                    pattern, pattern_port = parsed.hostname or "", parsed.port
            if pattern_port is not None and pattern_port != port:
                continue
            try:
                address = ipaddress.ip_address(pattern)
            except ValueError:
                pattern = pattern.rstrip(".")
                if pattern == "*":
                    matched = True
                elif pattern == "localhost" or (qualified and not pattern.startswith(("*", "."))):
                    matched = host == pattern
                elif pattern.startswith(("*.", ".")):
                    domain = pattern.removeprefix("*").lstrip(".")
                    matched = host.endswith(f".{domain}")
                else:
                    domain = pattern.removeprefix("*")
                    matched = host == domain or host.endswith(f".{domain}")
            else:
                try:
                    matched = address == ipaddress.ip_address(host)
                except ValueError:
                    matched = False
            if matched:
                return True
        except ValueError:
            # Like HTTPX, an unrelated bypass entry must not select another route.
            continue
    return False


@dataclass(frozen=True, slots=True, repr=False)
class NetworkRoute:
    endpoint: str = field(repr=False)
    proxy_url: str | None = field(default=None, repr=False)

    def public_details(self) -> dict[str, str]:
        details = {"mode": "proxy" if self.proxy_url else "direct", "endpoint": _origin(_parse_url(self.endpoint))}
        if self.proxy_url:
            details["proxy"] = _origin(_parse_url(self.proxy_url, proxy=True))
        return details

    def __repr__(self) -> str:
        return f"NetworkRoute({self.public_details()!r})"


def resolve_network_route(endpoint: str, env: Mapping[str, str] | None = None) -> NetworkRoute:
    target = _parse_url(endpoint)
    if _bypasses_proxy(target, _env_value("no_proxy", env)):
        return NetworkRoute(endpoint)
    key = "https_proxy" if target.scheme in {"https", "wss"} else "http_proxy"
    proxy = _env_value(key, env) or _env_value("all_proxy", env)
    if proxy:
        if "://" not in proxy:
            proxy = f"http://{proxy}"
        _parse_url(proxy, proxy=True)
    return NetworkRoute(endpoint, proxy or None)


def httpx_client_options(endpoint: str, env: Mapping[str, str] | None = None) -> dict[str, Any]:
    route = resolve_network_route(endpoint, env)
    options: dict[str, Any] = {"trust_env": False, "proxy": route.proxy_url, "verify": True}
    cafile, capath = _env_value("ssl_cert_file", env), _env_value("ssl_cert_dir", env)
    if cafile or capath:
        try:
            options["verify"] = ssl.create_default_context(cafile=cafile) if cafile else ssl.create_default_context(capath=capath)
        except (OSError, ValueError, ssl.SSLError) as error:
            raise ValueError(f"Invalid TLS CA configuration ({type(error).__name__})") from None
    if route.proxy_url and urlsplit(route.proxy_url).scheme == 'https' and isinstance(options['verify'], ssl.SSLContext):
        import httpx
        options['proxy'] = httpx.Proxy(route.proxy_url, ssl_context=options['verify'])
    return options


def sanitize_network_error(error: Any, route: NetworkRoute | None = None, *, secrets: tuple[str, ...] = ()) -> str:
    """Retain useful original error text, stripping URLs and known credentials."""
    message = str(error) or type(error).__name__
    sensitive = list(secrets)
    if route is not None:
        for value in (route.endpoint, route.proxy_url):
            if not value:
                continue
            parsed = urlsplit(value)
            message = message.replace(value, _origin(parsed))
            for part in (parsed.username, parsed.password, parsed.query, parsed.fragment):
                if part:
                    sensitive.extend((part, unquote(part)))
            sensitive.extend(value for _, value in parse_qsl(parsed.query) if value)
    # Third-party libraries may reformat a proxy URL in an exception.
    def redact_url(match: re.Match[str]) -> str:
        try:
            return _origin(urlsplit(match.group()))
        except ValueError:
            return "[redacted URL]"
    message = re.sub(r"(?:https?|wss?|socks5h?)://[^\s\"'<>]+", redact_url, message)
    for secret in sorted(set(sensitive), key=len, reverse=True):
        if secret:
            message = message.replace(secret, "[redacted]")
    return message


async def diagnose_connection(endpoint: str, env: Mapping[str, str] | None = None, timeout: float = 3.0) -> dict[str, Any]:
    """TCP reachability only: no TLS, authentication, HTTP or model payload."""
    route: NetworkRoute | None = None
    try:
        route = resolve_network_route(endpoint, env)
        target = _parse_url(route.proxy_url, proxy=True) if route.proxy_url else _parse_url(endpoint)
        _, writer = await asyncio.wait_for(asyncio.open_connection(target.hostname, target.port or _PORTS[target.scheme]), timeout=timeout)
        try:
            writer.close()
            await writer.wait_closed()
        finally:
            writer.close()
        return {"route": route.public_details(), "reachable": True, "check": "tcp"}
    except (OSError, ValueError) as error:
        return {"route": route.public_details() if route else None, "reachable": False, "check": "tcp", "error": sanitize_network_error(error, route)}
