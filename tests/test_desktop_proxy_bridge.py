from __future__ import annotations

import io
import json
import sys
from types import SimpleNamespace

import pytest

from tests.test_desktop_bridge import MockRuntimeHost

DEFAULTS = {
    "enabled": False,
    "whenDisabled": "environment",
    "protocol": "http",
    "host": "127.0.0.1",
    "port": None,
}


def _rows(output):
    return [json.loads(line) for line in output.getvalue().splitlines()]


def _host(tmp_path):
    from misaka.core.auth_storage import AuthStorage
    from misaka.core.settings_manager import SettingsManager

    host = MockRuntimeHost()
    host.session.settingsManager = SettingsManager.create(str(tmp_path), str(tmp_path))
    host.session.model = SimpleNamespace(
        provider="fixture", id="model", api="fixture", baseUrl="https://model.test/v1"
    )
    storage = AuthStorage.inMemory()
    host.session.modelRegistry = SimpleNamespace(authStorage=storage)
    return host


@pytest.mark.asyncio
async def test_credential_commands_await_native_storage_without_echoing_the_key(tmp_path, monkeypatch):
    from misaka.cli import desktop_bridge as bridge

    host = _host(tmp_path)
    storage = host.session.modelRegistry.authStorage
    snapshots = {}
    output = io.StringIO()

    def write(line):
        row = json.loads(line)
        if row.get("requestId"):
            snapshots[row["requestId"]] = dict(storage.readState.data)
        return output.write(line)

    monkeypatch.setattr(bridge, "writeRawStdout", write)
    commands = [
        {"type": "set_provider_credential", "requestId": "save", "provider": "fixture", "apiKey": "private-fixture-key"},
        {"type": "delete_provider_credential", "requestId": "delete", "provider": "fixture"},
        {"type": "shutdown"},
    ]
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(row) + "\n" for row in commands)))
    assert await bridge.run_desktop_bridge(host) == 0
    acks = {row["requestId"]: row for row in _rows(output) if row.get("requestId")}
    assert acks["save"]["ok"] and acks["delete"]["ok"]
    assert snapshots["save"]["fixture"]["key"] == "private-fixture-key"
    assert "fixture" not in snapshots["delete"]
    assert "private-fixture-key" not in output.getvalue()


@pytest.mark.asyncio
async def test_proxy_get_and_atomic_set_return_exact_snapshots_and_keep_live_siblings(tmp_path, monkeypatch):
    from misaka.cli import desktop_bridge as bridge

    monkeypatch.setenv("MISAKA_HOME", str(tmp_path))
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"network": {"sibling": "initial"}, "unrelated": {"keep": True}}), encoding="utf-8")
    host = _host(tmp_path)
    # Simulate another process updating an unrelated field after this manager loaded.
    path.write_text(json.dumps({"network": {"sibling": "live"}, "unrelated": {"keep": True}}), encoding="utf-8")
    saved = {**DEFAULTS, "enabled": True, "protocol": "socks5", "host": "::1", "port": 43129}
    output = io.StringIO()
    monkeypatch.setattr(bridge, "writeRawStdout", output.write)
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(row) + "\n" for row in [
        {"type": "get_proxy_settings", "requestId": "get"},
        {"type": "set_proxy_settings", "requestId": "set", "settings": saved},
        {"type": "shutdown"},
    ])))
    await bridge.run_desktop_bridge(host)
    rows = {row.get("requestId"): row for row in _rows(output) if row.get("requestId")}
    assert rows["get"]["data"]["settings"] == DEFAULTS
    assert rows["set"]["data"]["settings"] == saved
    assert rows["set"]["data"]["route"] == {
        "mode": "proxy", "endpoint": "https://model.test", "proxy": "socks5://[::1]:43129"
    }
    document = json.loads(path.read_text(encoding="utf-8"))
    assert document == {"network": {"sibling": "live", "proxy": saved}, "unrelated": {"keep": True}}


@pytest.mark.asyncio
async def test_invalid_dedicated_or_generic_proxy_save_is_rejected_atomically(tmp_path, monkeypatch):
    from misaka.cli import desktop_bridge as bridge

    monkeypatch.setenv("MISAKA_HOME", str(tmp_path))
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"network": {"proxy": DEFAULTS, "keep": 1}}), encoding="utf-8")
    host = _host(tmp_path)
    bad = {**DEFAULTS, "enabled": True, "port": None}
    output = io.StringIO()
    monkeypatch.setattr(bridge, "writeRawStdout", output.write)
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(row) + "\n" for row in [
        {"type": "set_proxy_settings", "requestId": "dedicated", "settings": bad},
        {"type": "set_setting", "requestId": "generic", "section": "network", "key": "proxy", "value": bad},
        {"type": "shutdown"},
    ])))
    await bridge.run_desktop_bridge(host)
    rows = {row["requestId"]: row for row in _rows(output) if row.get("requestId")}
    assert rows["dedicated"]["ok"] is False
    assert rows["generic"]["ok"] is False
    assert json.loads(path.read_text(encoding="utf-8")) == {"network": {"proxy": DEFAULTS, "keep": 1}}


@pytest.mark.asyncio
async def test_draft_connection_check_uses_latest_policy_without_persisting_or_auth(monkeypatch, tmp_path):
    from misaka.ai.utils import network_route
    from misaka.cli import desktop_bridge as bridge

    monkeypatch.setenv("MISAKA_HOME", str(tmp_path))
    (tmp_path / "settings.json").write_text(json.dumps({"network": {"proxy": DEFAULTS}}), encoding="utf-8")
    host = _host(tmp_path)
    draft = {**DEFAULTS, "enabled": True, "host": "proxy.test", "port": 45679}
    calls = []

    async def probe(endpoint, env=None, timeout=3.0):
        calls.append((endpoint, env))
        return {"route": {"mode": "proxy", "endpoint": "https://model.test", "proxy": "http://proxy.test:45679"},
                "reachable": False, "check": "tcp", "error": "fixture refused"}

    monkeypatch.setattr(network_route, "diagnose_connection", probe)
    output = io.StringIO()
    monkeypatch.setattr(bridge, "writeRawStdout", output.write)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({
        "type": "check_proxy_connection", "requestId": "check", "settings": draft,
        "text": "PRIVATE_PROMPT", "apiKey": "PRIVATE_KEY",
    }) + "\n"))
    await bridge.run_desktop_bridge(host)
    row = next(row for row in _rows(output) if row.get("requestId") == "check")
    assert row["ok"] is True and row["data"]["check"] == "tcp"
    assert calls[0][0] == "https://model.test/v1"
    assert calls[0][1]["HTTPS_PROXY"] == "http://proxy.test:45679"
    assert json.loads((tmp_path / "settings.json").read_text(encoding="utf-8"))["network"]["proxy"] == DEFAULTS
    assert "PRIVATE_PROMPT" not in json.dumps(row) and "PRIVATE_KEY" not in json.dumps(row)


@pytest.mark.asyncio
async def test_research_connection_check_ignores_cached_failed_route_and_uses_latest_policy(monkeypatch, tmp_path):
    from misaka.ai.utils import network_route
    from misaka.cli import desktop_bridge as bridge

    monkeypatch.setenv("MISAKA_HOME", str(tmp_path))
    direct = {**DEFAULTS, "whenDisabled": "direct"}
    (tmp_path / "settings.json").write_text(
        json.dumps({"network": {"proxy": direct}}), encoding="utf-8"
    )
    host = _host(tmp_path)
    host.session._desktop_network_context = {
        "endpoint": "https://model.test/v1",
        "provider": "fixture",
        "modelId": "model",
        "modelBaseUrl": "https://model.test/v1",
        "env": {"HTTPS_PROXY": "http://failed-old-route.test:3128"},
    }
    calls = []

    async def probe(endpoint, env=None, timeout=3.0):
        calls.append((endpoint, env))
        return {"route": {"mode": "direct", "endpoint": "https://model.test"},
                "reachable": True, "check": "tcp"}

    monkeypatch.setattr(network_route, "diagnose_connection", probe)
    output = io.StringIO()
    monkeypatch.setattr(bridge, "writeRawStdout", output.write)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({
        "type": "check_research_connection",
        "requestId": "fresh-check",
        "sessionId": host.session.sessionId,
    }) + "\n"))
    await bridge.run_desktop_bridge(host)
    row = next(item for item in _rows(output) if item.get("requestId") == "fresh-check")
    assert row["ok"] is True
    assert calls[0][0] == "https://model.test/v1"
    assert calls[0][1]["HTTPS_PROXY"] == ""


@pytest.mark.asyncio
async def test_provider_connectivity_uses_registry_stream_path_without_manual_auth_resolution():
    from misaka.cli.desktop_bridge import _test_model_connectivity

    model = SimpleNamespace(provider="fixture", id="model")
    reply = SimpleNamespace(stopReason="stop", content=[SimpleNamespace(text="OK")])
    calls = []

    class Stream:
        async def result(self):
            return reply

    class Registry:
        def find(self, provider, model_id):
            return model

        def streamSimple(self, selected, context, options):
            calls.append((selected, context, options))
            return Stream()

        async def getAuth(self, *_args):
            raise AssertionError("The runtime resolves request auth; the bridge must not resolve it twice")

    result = await _test_model_connectivity(SimpleNamespace(modelRegistry=Registry()), "fixture", "model")
    assert result["ok"] is True
    assert result["responseText"] == "OK"
    assert calls[0][2].maxTokens == 8
    assert calls[0][2].apiKey is None
    assert calls[0][2].headers is None
    assert calls[0][2].env is None
