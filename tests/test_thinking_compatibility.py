from __future__ import annotations

import inspect
from types import SimpleNamespace

import pytest

from misaka.ai import api_registry
from misaka.ai.api_registry import ApiProvider, get_api_provider, register_api_provider
from misaka.ai.models import get_supported_thinking_levels
from misaka.ai.types import AssistantMessage, Context, DoneEvent, ErrorEvent, Model, ModelCost, SimpleStreamOptions, StartEvent, TextContent, Usage, UsageCost
from misaka.ai.utils.event_stream import AssistantMessageEventStream, spawn_stream_task
from misaka.cli.desktop_bridge import _thinking_state


class ParameterError(Exception):
    def __init__(self, message="Unsupported parameter: reasoning_effort", *, status=400, param="reasoning_effort"):
        super().__init__(message)
        self.status_code = status
        self.body = {"error": {"message": message, "param": param, "code": "unsupported_parameter"}}


@pytest.fixture
def model(request, monkeypatch):
    monkeypatch.setattr(api_registry, "_api_provider_registry", {})
    return Model(id=request.node.name, name="Trial", api="openai-completions", provider="fixture", baseUrl="http://fixture.invalid/v1",
                 reasoning=True, input=["text"], cost=ModelCost(input=0, output=0, cacheRead=0, cacheWrite=0), contextWindow=8000, maxTokens=1000)


def message(model, *, error=None, text=""):
    return AssistantMessage(api=model.api, provider=model.provider, model=model.id, timestamp=1,
        content=[TextContent(text=text)] if text else [], stopReason="error" if error else "stop", errorMessage=str(error) if error else None,
        usage=Usage(input=0, output=0, cacheRead=0, cacheWrite=0, totalTokens=0, cost=UsageCost(input=0, output=0, cacheRead=0, cacheWrite=0, total=0)))


def adapter(requests, decide, *, partial=False):
    def invoke(model, _context, options):
        stream = AssistantMessageEventStream()
        async def run():
            try:
                payload = {"model": model.id, "reasoning_effort": options.reasoning or "medium", "temperature": 0.25,
                           "extra_body": {"route": "keep", "enable_thinking": bool(options.reasoning)}}
                if callable(options.onPayload):
                    value = options.onPayload(payload, model)
                    value = await value if inspect.isawaitable(value) else value
                    if value is not None:
                        payload = value
                requests.append(payload)
                error = decide(payload, model)
                if partial:
                    stream.push(StartEvent(partial=message(model, text="already generated")))
                if error:
                    stream.push(ErrorEvent(reason="error", error=message(model, error=error)), cause=error)
                else:
                    stream.push(DoneEvent(reason="stop", message=message(model, text="ok")))
            finally:
                stream.end()
        spawn_stream_task(run(), stream=stream)
        return stream
    return invoke


def session(model, level="high"):
    return SimpleNamespace(model=model, thinkingLevel=level, getAvailableThinkingLevels=lambda: get_supported_thinking_levels(model),
                           supportsThinking=lambda: model.reasoning)


def register(invoke):
    register_api_provider(ApiProvider(api="openai-completions", stream=invoke, streamSimple=invoke))
    return get_api_provider("openai-completions").streamSimple


def test_generic_levels_are_not_reported_as_confirmed(model):
    state = _thinking_state(session(model))
    assert state.get("thinkingCapability", {}).get("status") == "unknown"
    assert state["thinkingCapability"]["adjustable"] is True


@pytest.mark.asyncio
async def test_unknown_effort_retries_once_without_controls_and_remembers_model_default(model):
    requests = []
    call = register(adapter(requests, lambda payload, _model: ParameterError() if "reasoning_effort" in payload else None))
    stream = call(model, Context(messages=[]), SimpleStreamOptions(reasoning="high"))
    events = [event async for event in stream]
    result = await stream.result()
    await stream.settled()
    assert result.stopReason == "stop"
    assert len(requests) == 2
    assert requests[1] == {"model": model.id, "temperature": 0.25, "extra_body": {"route": "keep"}}
    assert all(event.type != "error" for event in events)
    assert model.reasoning is True
    state = _thinking_state(session(model))
    assert state["level"] == "high"  # User preference is not rewritten to off.
    assert state["thinkingCapability"]["status"] == "default"
    again = call(model, Context(messages=[]), SimpleStreamOptions(reasoning="low"))
    assert (await again.result()).stopReason == "stop"
    await again.settled()
    assert len(requests) == 3
    assert "reasoning_effort" not in requests[-1]
    assert result.diagnostics[-1].type == "thinking_compatibility"


@pytest.mark.asyncio
async def test_explicit_allowed_values_keep_adjustment_and_use_nearest_supported_level(model):
    requests = []
    def decide(payload, _model):
        if payload.get("reasoning_effort") not in ("low", "high"):
            return ParameterError("Invalid reasoning_effort. Supported values are: 'low', 'high'.")
        return None
    call = register(adapter(requests, decide))
    stream = call(model, Context(messages=[]), SimpleStreamOptions(reasoning="max"))
    result = await stream.result()
    await stream.settled()
    assert result.stopReason == "stop"
    assert len(requests) == 2
    assert requests[-1]["reasoning_effort"] == "high"
    assert get_supported_thinking_levels(model) == ["low", "high"]
    assert _thinking_state(session(model))["thinkingCapability"]["status"] == "known"


@pytest.mark.parametrize("status,param", [(401,"reasoning_effort"), (429,"reasoning_effort"), (500,"reasoning_effort"), (400,"messages")])
@pytest.mark.asyncio
async def test_other_errors_are_preserved_without_thinking_retry(model, status, param):
    requests = []
    failure = ParameterError(status=status, param=param, message=f"Unsupported parameter: {param}")
    call = register(adapter(requests, lambda _payload, _model: failure))
    stream = call(model, Context(messages=[]), SimpleStreamOptions(reasoning="high"))
    assert (await stream.result()).stopReason == "error"
    await stream.settled()
    assert len(requests) == 1
    assert stream.error_cause is failure


@pytest.mark.asyncio
async def test_feedback_after_stream_start_never_replays_a_generated_request(model):
    requests = []
    failure = ParameterError()
    call = register(adapter(requests, lambda _payload, _model: failure, partial=True))
    stream = call(model, Context(messages=[]), SimpleStreamOptions(reasoning="high"))
    assert (await stream.result()).stopReason == "error"
    await stream.settled()
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_default_feedback_is_scoped_to_model_endpoint_and_failed_retry_is_not_cached(model):
    requests = []
    failure = ParameterError()
    call = register(adapter(requests, lambda _payload, _model: failure))
    stream = call(model, Context(messages=[]), SimpleStreamOptions(reasoning="high"))
    assert (await stream.result()).stopReason == "error"
    await stream.settled()
    assert len(requests) == 2
    assert _thinking_state(session(model))["thinkingCapability"]["status"] == "unknown"
