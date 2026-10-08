"""Request-time thinking compatibility: trial controls, then provider defaults.

Only explicit parameter-validation feedback before a stream starts is eligible.
No discovery inference requests are made and user defaults are never rewritten.
"""
from __future__ import annotations

import asyncio
import inspect
import re
import time
from collections import OrderedDict
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from misaka.ai.types import AssistantMessage, ErrorEvent, Model, ProviderStreamOptions, Usage, UsageCost
from misaka.ai.utils.diagnostics import AssistantMessageDiagnostic, append_assistant_message_diagnostic
from misaka.ai.utils.event_stream import AssistantMessageEventStream, spawn_stream_task

LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")
_CONTROLS = frozenset({
    "reasoning", "reasoning_effort", "reasoningEffort", "thinking", "thinking_config", "thinkingConfig",
    "thinking_budget", "thinkingBudget", "thinking_token_budget", "thinking_budget_tokens", "thinkingLevel",
    "thinking_level", "enable_thinking", "enableThinking", "includeThoughts", "include_thoughts",
})
_CONTAINERS = frozenset({
    "extra_body", "config", "generationConfig", "generation_config", "output_config", "outputConfig",
    "chat_template_kwargs", "chat_template_args", "parameters", "additionalModelRequestFields",
})
_EFFORT_PARENTS = frozenset({"reasoning", "output_config", "outputConfig"})
_REJECTION = re.compile(r"unsupported|not supported|not allowed|not available|unknown parameter|unrecognized|invalid|supported values|must be", re.I)
_OTHER_ERROR = re.compile(r"authentication|unauthorized|api.?key|credential|rate.?limit|quota|context.?length", re.I)


@dataclass(frozen=True)
class _Feedback:
    status: str
    levels: tuple[str, ...]
    expires: float


_feedback: OrderedDict[tuple, _Feedback] = OrderedDict()


def _key(model: Model) -> tuple:
    return (model.provider, model.api, model.baseUrl, model.id,
            tuple(sorted((model.thinkingLevelMap or {}).items())), getattr(model, "thinkingCapabilityKnown", None))


def get_thinking_feedback(model: Model) -> _Feedback | None:
    key = _key(model)
    item = _feedback.get(key)
    if item is not None and item.expires <= time.monotonic():
        _feedback.pop(key, None)
        return None
    return item


def clear_thinking_feedback(model: Model) -> None:
    _feedback.pop(_key(model), None)


def _remember(model: Model, status: str, levels: tuple[str, ...] = ()) -> None:
    key = _key(model)
    _feedback[key] = _Feedback(status, levels, time.monotonic() + 600)
    _feedback.move_to_end(key)
    while len(_feedback) > 128:
        _feedback.popitem(last=False)


def thinking_capability(model: Model) -> dict[str, Any]:
    from misaka.ai.models import _catalog_supported_thinking_levels

    feedback = get_thinking_feedback(model)
    if feedback:
        levels = list(feedback.levels)
        return {"status": feedback.status, "source": "service", "levels": levels,
                "adjustable": feedback.status == "known" and len(levels) > 1}
    levels = _catalog_supported_thinking_levels(model)
    if not model.reasoning or not levels:
        return {"status": "default", "source": "model", "levels": [], "adjustable": False}
    known = bool(model.thinkingLevelMap) and getattr(model, "thinkingCapabilityKnown", None) is not False
    return {"status": "known" if known else "unknown", "source": "model" if known else "generic",
            "levels": levels, "adjustable": len(levels) > 1}


def _option(options: Any, key: str) -> Any:
    return options.get(key) if isinstance(options, Mapping) else getattr(options, key, None)


def _copy_options(options: Any, changes: dict) -> Any:
    if options is None:
        return ProviderStreamOptions(**changes)
    if isinstance(options, Mapping):
        return {**options, **changes}
    return options.model_copy(update=changes)


def _control(key: str, path: tuple[str, ...]) -> bool:
    return key in _CONTROLS or (key == "effort" and bool(path) and path[-1] in _EFFORT_PARENTS)


def _controls(payload: Mapping, path: tuple[str, ...] = ()) -> list[tuple[tuple[str, ...], Any]]:
    result = []
    for key, value in payload.items():
        if _control(key, path):
            result.append(((*path, key), value))
        if isinstance(value, Mapping) and (key in _CONTAINERS or key in _CONTROLS):
            result.extend(_controls(value, (*path, key)))
    return result


def _without_controls(payload: Mapping, path: tuple[str, ...] = ()) -> dict:
    result = {}
    for key, value in payload.items():
        if _control(key, path):
            continue
        if isinstance(value, Mapping) and key in _CONTAINERS:
            value = _without_controls(value, (*path, key))
        result[key] = value
    return result


def _replace_effort(payload: Mapping, effort: str, path: tuple[str, ...] = ()) -> dict:
    result = {}
    for key, value in payload.items():
        if key in {"reasoning_effort", "reasoningEffort", "thinkingLevel", "thinking_level"} or (key == "effort" and path and path[-1] in _EFFORT_PARENTS):
            value = effort
        elif isinstance(value, Mapping) and (key in _CONTAINERS or key in _CONTROLS):
            value = _replace_effort(value, effort, (*path, key))
        result[key] = value
    return result


def _validation_feedback(cause: BaseException | None, sent: list[tuple[tuple[str, ...], Any]]) -> tuple[str, tuple[str, ...]] | None:
    if cause is None or not sent:
        return None
    status = getattr(cause, "status_code", None) or getattr(cause, "status", None) or getattr(cause, "code", None)
    if status not in (400, 422):
        return None
    body = getattr(cause, "body", None)
    error = body.get("error", body) if isinstance(body, Mapping) else {}
    if not isinstance(error, Mapping):
        error = {}
    message = str(error.get("message") or cause)
    if _OTHER_ERROR.search(message) or not _REJECTION.search(message):
        return None
    param = error.get("param")
    names = {re.sub(r"[^a-z0-9]", "", part.lower()) for path, _ in sent for part in path if part in _CONTROLS or part == "effort"}
    if isinstance(param, str) and param:
        parts = re.findall(r"[A-Za-z_][A-Za-z_0-9]*", param)
        if not parts or parts[0] in {"messages", "tools", "input", "response_format"}:
            return None
        if not any(re.sub(r"[^a-z0-9]", "", part.lower()) in names for part in parts):
            return None
    elif not any(re.search(rf"\b{re.escape(part)}\b", message, re.I) for path, _ in sent for part in path if part in _CONTROLS):
        return None
    allowed = re.search(r"(?:supported|allowed)\s+values(?:\s+are)?\s*[:=]?\s*([^\n]+)|must be one of\s*[:=]?\s*([^\n]+)", message, re.I)
    tokens = re.findall(r"['\"]([a-z]+)['\"]", (allowed.group(1) or allowed.group(2)) if allowed else "")
    levels = tuple(level for level in LEVELS if level in tokens)
    has_effort = any(path[-1] in {"effort", "reasoning_effort", "reasoningEffort", "thinkingLevel", "thinking_level"} for path, _ in sent)
    return ("known", levels) if levels and has_effort else ("default", ())


def _pick(levels: tuple[str, ...], requested: str | None) -> str:
    if requested in levels:
        return requested
    index = LEVELS.index(requested) if requested in LEVELS else LEVELS.index("medium")
    return next((level for level in LEVELS[index:] if level in levels),
                next((level for level in reversed(LEVELS[:index]) if level in levels), levels[0]))


def stream_with_thinking_compatibility(invoke, model: Model, context, options=None):
    # Synchronous already-completed test/extension streams keep their original behavior.
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return invoke(model, context, options)
    capability = thinking_capability(model)
    policy = capability["status"] if capability["status"] == "default" or capability["source"] == "service" else None
    supported = tuple(capability["levels"])
    requested = _option(options, "reasoning") or _option(options, "reasoningEffort")
    original_hook = _option(options, "onPayload")
    sent: list[tuple[tuple[str, ...], Any]] = []

    def attempt(status, available):
        nonlocal sent
        sent = []
        selected = _pick(available, requested) if status == "known" else None
        async def on_payload(payload, *args):
            if callable(original_hook):
                changed = original_hook(payload, *args)
                changed = await changed if inspect.isawaitable(changed) else changed
                if changed is not None:
                    payload = changed
            if not isinstance(payload, Mapping):
                return payload
            if status == "default":
                payload = _without_controls(payload)
            elif selected:
                payload = _replace_effort(payload, (model.thinkingLevelMap or {}).get(selected) or selected)
            sent[:] = _controls(payload)
            return payload
        changes = {"onPayload": on_payload}
        if status == "default":
            changes.update(useModelThinkingDefault=True, reasoning=None, thinkingBudgets=None)
            for key in ("reasoningEffort", "effort", "thinkingEnabled"):
                if _option(options, key) is not None:
                    changes[key] = None
        elif selected:
            changes["reasoning"] = selected
            if _option(options, "reasoningEffort") is not None:
                changes["reasoningEffort"] = selected
        return invoke(model, context, _copy_options(options, changes)), selected

    inner, selected = attempt(policy, supported)  # Preserve synchronous auth failures.
    outer = AssistantMessageEventStream()

    async def run():
        nonlocal inner, policy, supported, selected
        retried = False
        try:
            while True:
                started = False
                retry = None
                async for event in inner:
                    if event.type == "error" and event.reason == "error" and not started and not retried and not policy:
                        retry = _validation_feedback(inner.error_cause, sent)
                        if retry:
                            break
                    if event.type == "done" and policy:
                        if retried:
                            _remember(model, policy, supported if policy == "known" else ())
                        cap = thinking_capability(model)
                        append_assistant_message_diagnostic(event.message, AssistantMessageDiagnostic(
                            type="thinking_compatibility", timestamp=int(time.time() * 1000),
                            details={"thinkingCapability": cap, "resolvedLevel": selected,
                                     "provider": model.provider, "model": model.id, "api": model.api}))
                    started = True
                    outer.push(event, cause=inner.error_cause if event.type == "error" else None)
                await inner.settled()
                if not retry:
                    break
                signal = _option(options, "signal")
                if signal is not None and getattr(signal, "aborted", False):
                    raise asyncio.CancelledError()
                policy, supported = retry
                retried = True
                inner, selected = attempt(policy, supported)
        except (Exception, asyncio.CancelledError) as error:
            aborted = isinstance(error, asyncio.CancelledError)
            if aborted and inner._producer is not None and not inner._producer.done():
                inner._producer.cancel()
            failure = AssistantMessage(api=model.api, provider=model.provider, model=model.id, content=[],
                stopReason="aborted" if aborted else "error", errorMessage=str(error), timestamp=int(time.time() * 1000),
                usage=Usage(input=0, output=0, cacheRead=0, cacheWrite=0, totalTokens=0,
                            cost=UsageCost(input=0, output=0, cacheRead=0, cacheWrite=0, total=0)))
            outer.push(ErrorEvent(reason="aborted" if aborted else "error", error=failure), cause=error)
        finally:
            try:
                await inner.settled()
            except asyncio.CancelledError:
                pass
            outer.end()

    spawn_stream_task(run(), stream=outer)
    return outer
