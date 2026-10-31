"""Google SDK and injected pi transports preserve explicit route ownership."""
from types import SimpleNamespace
from misaka.ai.api import google_generative_ai as google, google_vertex
from misaka.ai.utils.request_network import request_network
from misaka.config import proxy_settings
import pytest

@pytest.mark.parametrize("module", [google, google_vertex])
def test_google_sdk_http_options_follow_effective_route(monkeypatch, module):
    monkeypatch.setattr(proxy_settings, "get_proxy_settings", lambda: {**proxy_settings.DEFAULT_PROXY_SETTINGS, "whenDisabled": "environment"})
    captured = []
    monkeypatch.setattr(module, "GoogleGenAI", lambda **kwargs: captured.append(kwargs) or object())
    model = SimpleNamespace(baseUrl="https://model.invalid", headers=None)
    with request_network({"HTTPS_PROXY": "http://credential.invalid:3128"}):
        if module is google:
            module._createClient(model, "fixture")
        else:
            module._createClientWithApiKey(model, "fixture")
    options = captured[0]["http_options"]
    assert options["clientArgs"]["proxy"] == "http://credential.invalid:3128"
    assert options["asyncClientArgs"]["trust_env"] is False
