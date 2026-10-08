"""Provider registry for stream-capable AI APIs."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from misaka.ai.types import (
    Api,
    Model,
    SimpleStreamOptions,
    StreamOptions,
    TranscriptContext,
)
from misaka.ai.utils.event_stream import AssistantMessageEventStream

ApiStreamFunction = Callable[[Model, TranscriptContext, StreamOptions | None], AssistantMessageEventStream]
ApiStreamSimpleFunction = Callable[[Model, TranscriptContext, SimpleStreamOptions | None], AssistantMessageEventStream]


@dataclass(slots=True)
class ApiProvider:
    api: Api
    stream: ApiStreamFunction
    streamSimple: ApiStreamSimpleFunction


@dataclass(slots=True)
class RegisteredApiProvider:
    provider: ApiProvider
    source_id: str | None = None


_api_provider_registry: dict[str, RegisteredApiProvider] = {}


# MISAKA: every request to a provider passes the wrappers below, so this is where it is metered
# against the token cap (``misaka.core.platform.metering``, installed by the process entry). The
# meter is ``meter(model, context, options, send)``, ``send(options)`` the provider's own call.
# Pi has no such seam; without one installed the wrappers are pi's.
_request_meter = None


def set_request_meter(meter) -> None:
    global _request_meter
    _request_meter = meter


def _metered(model, context, options, send):
    meter = _request_meter
    return send(options) if meter is None else meter(model, context, options, send)


def _wrap_stream(api: Api, stream: ApiStreamFunction) -> ApiStreamFunction:
    def wrapped(model: Model, context: TranscriptContext, options: StreamOptions | None = None) -> AssistantMessageEventStream:
        if model.api != api:
            raise ValueError(f"Mismatched api: {model.api} expected {api}")
        from misaka.ai.thinking_compat import stream_with_thinking_compatibility
        # Each physical attempt (including thinking negotiation) owns its lease.
        def metered_attempt(selected, content, parameters):
            return _metered(selected, content, parameters,
                            lambda sent: stream(selected, content, sent))
        return stream_with_thinking_compatibility(metered_attempt, model, context, options)

    return wrapped


def _wrap_stream_simple(api: Api, stream_simple: ApiStreamSimpleFunction) -> ApiStreamSimpleFunction:
    def wrapped(
        model: Model,
        context: TranscriptContext,
        options: SimpleStreamOptions | None = None,
    ) -> AssistantMessageEventStream:
        if model.api != api:
            raise ValueError(f"Mismatched api: {model.api} expected {api}")
        from misaka.ai.thinking_compat import stream_with_thinking_compatibility
        # Each physical attempt (including thinking negotiation) owns its lease.
        def metered_attempt(selected, content, parameters):
            return _metered(selected, content, parameters,
                            lambda sent: stream_simple(selected, content, sent))
        return stream_with_thinking_compatibility(metered_attempt, model, context, options)

    return wrapped


def register_api_provider(provider: ApiProvider, source_id: str | None = None) -> None:
    _api_provider_registry[provider.api] = RegisteredApiProvider(
        provider=ApiProvider(
            api=provider.api,
            stream=_wrap_stream(provider.api, provider.stream),
            streamSimple=_wrap_stream_simple(provider.api, provider.streamSimple),
        ),
        source_id=source_id,
    )


def get_api_provider(api: Api) -> ApiProvider | None:
    entry = _api_provider_registry.get(api)
    return entry.provider if entry else None


def get_api_providers() -> list[ApiProvider]:
    """Every registered api provider, in registration order."""
    return [entry.provider for entry in _api_provider_registry.values()]


def unregister_api_providers(source_id: str) -> None:
    """Remove only what ``source_id`` registered.

    ``register_api_provider`` has always recorded the source; nothing read it, so an
    extension that registered an api had no way to take just its own back out -- the only
    lever was ``clear_api_providers``, which takes everyone's.
    """
    for api in [api for api, entry in _api_provider_registry.items() if entry.source_id == source_id]:
        del _api_provider_registry[api]


def clear_api_providers() -> None:
    _api_provider_registry.clear()


