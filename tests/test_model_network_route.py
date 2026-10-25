"""Request-scoped routing; all network fixtures bind OS-assigned loopback ports."""

import asyncio
import importlib
import json
import os
import ssl

import certifi
import httpx
import pytest


@pytest.fixture(autouse=True)
def clean_network_env(monkeypatch):
    for name in ("http_proxy", "https_proxy", "all_proxy", "no_proxy", "ssl_cert_file", "ssl_cert_dir"):
        monkeypatch.delenv(name, raising=False)
        monkeypatch.delenv(name.upper(), raising=False)


def routing():
    return importlib.import_module("misaka.ai.utils.network_route")


@pytest.mark.parametrize("endpoint,env,want", [
    ("https://model.example/v1", {}, None),
    ("https://model.example/v1", {"HTTP_PROXY": "http://wrong:3128"}, None),
    ("http://model.example/v1", {"HTTP_PROXY": "http://proxy:32181"}, "http://proxy:32181"),
    ("https://model.example/v1", {"HTTPS_PROXY": "https://proxy:32182"}, "https://proxy:32182"),
    ("wss://model.example/v1", {"HTTPS_PROXY": "socks5h://proxy:32183"}, "socks5h://proxy:32183"),
    ("ws://model.example/v1", {"HTTP_PROXY": "socks5://proxy:32184"}, "socks5://proxy:32184"),
    ("https://model.example", {"ALL_PROXY": "socks5://[::1]:32185"}, "socks5://[::1]:32185"),
    ("https://model.example", {"HTTPS_PROXY": "http://USER:PASSWORD@remote.example:32186"}, "http://USER:PASSWORD@remote.example:32186"),
    ("https://model.example", {"HTTPS_PROXY": "http://upper", "https_proxy": "http://lower"}, "http://lower"),
    ("https://model.example", {"HTTPS_PROXY": "http://upper", "https_proxy": ""}, None),
    ("https://model.example", {"HTTPS_PROXY": "proxy.example:31337"}, "http://proxy.example:31337"),
    ("https://model.example", {"HTTPS_PROXY": "[::1]:31338"}, "http://[::1]:31338"),
])
def test_selects_proxy_by_actual_endpoint(endpoint, env, want):
    assert routing().resolve_network_route(endpoint, env).proxy_url == want


@pytest.mark.parametrize("scoped,want", [
    ({}, "http://ambient-lower:3128"),
    ({"HTTPS_PROXY": "http://scoped:3129"}, "http://scoped:3129"),
    ({"HTTPS_PROXY": ""}, None),
    ({"https_proxy": "", "HTTPS_PROXY": "http://ignored:3130"}, None),
])
def test_scoped_presence_overrides_process_even_when_empty(monkeypatch, scoped, want):
    # Windows os.environ is case-insensitive; use a mapping to exercise both keys.
    monkeypatch.setattr(os, "environ", {"https_proxy": "http://ambient-lower:3128", "HTTPS_PROXY": "http://ambient-upper:3127"})
    assert routing().resolve_network_route("https://target.example", scoped).proxy_url == want


@pytest.mark.parametrize("endpoint,bypass,want_direct", [
    ("https://example.com", "example.com", True),
    ("https://sub.example.com", "example.com", True),
    ("https://notexample.com", "example.com", False),
    ("https://example.com", ".example.com", False),
    ("https://sub.example.com", ".example.com", True),
    ("https://sub.example.com", "*.example.com", True),
    ("https://example.com", "*.example.com", False),
    ("https://example.com", "other, *", True),
    ("https://example.com", "example.com:443", True),
    ("https://example.com:444", "example.com:443", False),
    ("https://127.0.0.1:32345", "127.0.0.1:32345", True),
    ("https://127.0.0.1:32346", "127.0.0.1:32345", False),
    ("https://sub.127.0.0.1", "127.0.0.1", False),
    ("https://[::1]", "::1", True),
    ("https://[::1]:32345", "[::1]:32345", True),
    ("https://[::1]:32346", "[::1]:32345", False),
    ("wss://example.com", "https://example.com:443", True),
    ("http://sub.page.invalid", "http://page.invalid", False),
    ("http://page.invalid", "http://page.invalid", True),
    ("https://page.invalid", "http://page.invalid", False),
    ("http://sub.page.invalid", "http://*.page.invalid", True),
    ("http://page.invalid", "http://*.page.invalid", False),
    ("https://sub.localhost", "localhost", False),
])
def test_no_proxy_httpx_domain_address_port_conventions(endpoint, bypass, want_direct):
    route = routing().resolve_network_route(endpoint, {"ALL_PROXY": "http://proxy", "NO_PROXY": bypass})
    assert (route.proxy_url is None) == want_direct


def test_empty_scoped_no_proxy_clears_ambient_bypass(monkeypatch):
    monkeypatch.setenv("NO_PROXY", "*")
    route = routing().resolve_network_route("https://model.example", {"ALL_PROXY": "http://proxy", "no_proxy": ""})
    assert route.proxy_url == "http://proxy"


@pytest.mark.parametrize("bad", [
    "ftp://host:3131", "http://", "http://host:notaport", "http://host:65536",
    "http://host:0", "http://host:3131/path", "http://host?token=SECRET", "http://host#SECRET",
    "http://host name:3131", "http://USER:SECRET@[::zz]:3131", "http://host:3131\\SECRET",
    "http://host..example", "http://-host", "http://.",
])
def test_invalid_proxy_errors_never_echo_credentials(bad):
    with pytest.raises(ValueError) as caught:
        routing().resolve_network_route("https://model.example", {"HTTPS_PROXY": bad})
    assert "SECRET" not in str(caught.value)
    assert bad not in str(caught.value)


@pytest.mark.parametrize("endpoint", ["", "file:///SECRET", "https:///missing", "https://host:abc", "https://host:0", "https://bad host/v1"])
def test_invalid_endpoint_is_explicit_and_redacted(endpoint):
    with pytest.raises(ValueError) as caught:
        routing().resolve_network_route(endpoint)
    assert "SECRET" not in str(caught.value)


def test_public_details_and_repr_never_include_url_credentials_or_query():
    route = routing().resolve_network_route("https://MODELUSER:MODELPASS@model.example/v1?token=TOKEN#FRAGMENT", {"ALL_PROXY": "http://USER:SECRET@proxy.example:3128/"})
    details = route.public_details()
    assert details["mode"] == "proxy"
    assert "model.example" in details["endpoint"]
    assert "proxy.example:3128" in details["proxy"]
    public = json.dumps(details) + repr(route)
    for secret in ("MODELUSER", "MODELPASS", "TOKEN", "FRAGMENT", "USER", "SECRET"):
        assert secret not in public


def test_explicit_direct_options_disable_os_discovery(monkeypatch):
    import urllib.request

    import httpx._utils
    monkeypatch.setattr(urllib.request, "getproxies", lambda: pytest.fail("OS discovery invoked"))
    monkeypatch.setattr(httpx._utils, "getproxies", lambda: pytest.fail("HTTPX OS discovery invoked"))
    options = routing().httpx_client_options("https://target.example")
    assert options["trust_env"] is False
    assert options.get("proxy") is None
    with httpx.Client(**options):
        pass


def test_ca_file_and_directory_honor_presence_and_lowercase(monkeypatch, tmp_path):
    monkeypatch.setenv("SSL_CERT_FILE", str(tmp_path / "ambient-secret-missing.pem"))
    assert isinstance(routing().httpx_client_options("https://target", {"SSL_CERT_FILE": certifi.where()})["verify"], ssl.SSLContext)
    # Empty explicitly clears ambient CA file; directory remains usable.
    assert isinstance(routing().httpx_client_options("https://target", {"ssl_cert_file": "", "SSL_CERT_DIR": str(tmp_path)})["verify"], ssl.SSLContext)
    assert routing().httpx_client_options("https://target", {"ssl_cert_file": ""})["verify"] is True


@pytest.mark.parametrize("proxy,port", [("http://localhost", 80), ("https://localhost", 443), ("socks5://localhost", 1080), ("socks5h://localhost", 1080)])
async def test_diagnostic_uses_protocol_standard_proxy_port(monkeypatch, proxy, port):
    seen = []
    async def fail(host, actual_port):
        seen.append((host, actual_port))
        raise OSError("controlled unreachable")
    monkeypatch.setattr(asyncio, "open_connection", fail)
    result = await routing().diagnose_connection("https://model.example", {"HTTPS_PROXY": proxy})
    assert seen == [("localhost", port)]
    assert result["reachable"] is False
    assert result["check"] == "tcp"


async def test_diagnostic_tcp_connect_sends_no_credentials_or_application_bytes():
    received = asyncio.Future()
    async def handle(reader, writer):
        received.set_result(await reader.read())
        writer.close()
        await writer.wait_closed()
    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    async with server:
        port = server.sockets[0].getsockname()[1]
        result = await routing().diagnose_connection("https://model.invalid/PRIVATE_TOPIC", {"HTTPS_PROXY": f"http://USER:SECRET@127.0.0.1:{port}"})
        assert result["reachable"] is True
        assert result["route"]["mode"] == "proxy"
        assert await asyncio.wait_for(received, 1) == b""
        assert "SECRET" not in json.dumps(result)
        assert "PRIVATE_TOPIC" not in json.dumps(result)


async def test_diagnostic_keeps_original_error_redacted(monkeypatch):
    async def fail(*args):
        raise OSError("connection to http://USER:p%40ss@proxy.example:3128 failed; p@ss; USER")
    monkeypatch.setattr(asyncio, "open_connection", fail)
    result = await routing().diagnose_connection("https://model.example", {"HTTPS_PROXY": "http://USER:p%40ss@proxy.example:3128"})
    assert result["reachable"] is False
    assert "failed" in result["error"]
    assert all(secret not in result["error"] for secret in ("USER", "p@ss", "p%40ss"))


async def test_diagnostic_redacts_endpoint_query_values_from_original_error(monkeypatch):
    async def fail(*args):
        raise OSError("connect failed for key QUERY_SECRET")
    monkeypatch.setattr(asyncio, "open_connection", fail)
    result = await routing().diagnose_connection("https://model.example/v1?api_key=QUERY_SECRET")
    assert "connect failed" in result["error"]
    assert "QUERY_SECRET" not in json.dumps(result)


@pytest.mark.parametrize("endpoint,host,port", [("http://model.example", "model.example", 80), ("https://model.example", "model.example", 443), ("ws://model.example", "model.example", 80), ("wss://[::1]", "::1", 443)])
async def test_direct_diagnostic_uses_target_standard_port(monkeypatch, endpoint, host, port):
    seen = []
    async def fail(actual_host, actual_port):
        seen.append((actual_host, actual_port))
        raise OSError("controlled unreachable")
    monkeypatch.setattr(asyncio, "open_connection", fail)
    result = await routing().diagnose_connection(endpoint)
    assert seen == [(host, port)]
    assert result["route"]["mode"] == "direct"


@pytest.mark.parametrize("use_proxy", [False, True])
async def test_real_http_flow_uses_direct_or_selected_loopback_proxy(use_proxy):
    requests = []
    async def handle(reader, writer):
        requests.append(await reader.readuntil(b"\r\n\r\n"))
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
        await writer.drain()
        writer.close()
        await writer.wait_closed()
    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    async with server:
        port = server.sockets[0].getsockname()[1]
        endpoint = "http://model.invalid/v1" if use_proxy else f"http://127.0.0.1:{port}/v1"
        env = {"HTTP_PROXY": f"http://127.0.0.1:{port}"} if use_proxy else {}
        async with httpx.AsyncClient(**routing().httpx_client_options(endpoint, env)) as client:
            response = await client.get(endpoint)
        assert response.text == "ok"
        assert requests[0].startswith(b"GET http://model.invalid/v1 " if use_proxy else b"GET /v1 ")
