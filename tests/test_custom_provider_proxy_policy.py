"""The model-discovery button uses the same application route as model requests."""

import asyncio
import json

import httpx
import pytest

from misaka.core.custom_providers import fetch_remote_models


@pytest.mark.parametrize("mode", ["direct", "custom", "environment"])
async def test_remote_models_honors_application_proxy_policy(tmp_path, monkeypatch, mode):
    monkeypatch.setenv("MISAKA_HOME", str(tmp_path))
    received = []

    async def respond(reader, writer):
        try:
            request = await reader.readuntil(b"\r\n\r\n")
            received.append(request)
            body = b'{"data":[{"id":"fixture-model"}]}'
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                         + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(respond, "127.0.0.1", 0)
    async with server:
        port = server.sockets[0].getsockname()[1]
        ambient = f"http://127.0.0.1:{port}" if mode == "environment" else "http://127.0.0.1:1"
        for name in ("http_proxy", "https_proxy", "all_proxy"):
            monkeypatch.setenv(name, ambient)
            monkeypatch.setenv(name.upper(), ambient)
        monkeypatch.setenv("no_proxy", "")
        monkeypatch.setenv("NO_PROXY", "")
        settings = {"enabled": mode == "custom", "whenDisabled": "direct" if mode == "direct" else "environment",
                    "protocol": "http", "host": "127.0.0.1", "port": port if mode == "custom" else None}
        (tmp_path / "settings.json").write_text(json.dumps({"network": {"proxy": settings}}), encoding="utf-8")
        endpoint = f"http://127.0.0.1:{port}/v1" if mode == "direct" else "http://fixture.invalid/v1"
        models, error = await fetch_remote_models(endpoint, timeout_seconds=1)

    assert error is None
    assert [model["id"] for model in models] == ["fixture-model"]
    assert len(received) == 1
    expected_path = b"GET /v1/models " if mode == "direct" else b"GET http://fixture.invalid/v1/models "
    assert received[0].startswith(expected_path)


async def test_discovery_invalid_proxy_never_silently_connects(tmp_path, monkeypatch):
    monkeypatch.setenv("MISAKA_HOME", str(tmp_path))
    (tmp_path / "settings.json").write_text(json.dumps({"network": {"proxy": {"enabled": True}}}), encoding="utf-8")
    def unexpected_client(**_kwargs):
        raise AssertionError("A malformed policy must be rejected before constructing any HTTP client")
    monkeypatch.setattr(httpx, "AsyncClient", unexpected_client)
    with pytest.raises(ValueError, match="network.proxy"):
        await fetch_remote_models("http://fixture.invalid/v1", timeout_seconds=0.1)
