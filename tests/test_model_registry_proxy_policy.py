"""Provider-runtime network snapshots preserve typed options and caller input."""
import pytest
from misaka.ai.models import createModels
from misaka.ai.providers.faux import fauxProvider, fauxAssistantMessage
from misaka.ai.types import Context, SimpleStreamOptions, ThinkingBudgets
from misaka.config import proxy_settings

@pytest.mark.asyncio
async def test_models_boundary_applies_direct_policy_without_mutating_options(monkeypatch):
    monkeypatch.setattr(proxy_settings, "get_proxy_settings", lambda: {**proxy_settings.DEFAULT_PROXY_SETTINGS, "whenDisabled": "direct"})
    models = createModels()
    faux = fauxProvider()
    original = faux.provider.streamSimple
    captured = []
    def stream(model, context, options):
        captured.append(options)
        return original(model, context, options)
    faux.provider.streamSimple = stream
    models.setProvider(faux.provider)
    faux.setResponses([fauxAssistantMessage("ok")])
    budgets = ThinkingBudgets(high=4096)
    options = SimpleStreamOptions(env={"HTTPS_PROXY": "http://ambient.invalid:3128"}, thinkingBudgets=budgets)
    model = faux.getModel().model_copy(update={"reasoning": True})
    result = await models.completeSimple(model, Context(messages=[]), options)
    assert result.stopReason == "stop"
    assert captured[0].env["HTTPS_PROXY"] == ""
    assert captured[0].thinkingBudgets is budgets
    assert options.env["HTTPS_PROXY"] == "http://ambient.invalid:3128"
