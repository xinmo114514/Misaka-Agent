"""Read-only session accounting shared by terminal and desktop views."""
from __future__ import annotations

from misaka.core.usage_totals import addUsageToTotals, createUsageTotals
from misaka.utils.values import read_field


def usage_snapshot(entries):
    totals, hit_rate, compacted, reasoning = createUsageTotals(), None, 0, None
    for entry in entries:
        kind = read_field(entry, "type")
        usage = None
        if kind == "message":
            message = read_field(entry, "message")
            role = read_field(message, "role")
            if role == "assistant":
                usage = read_field(message, "usage") or {}
                prompt = sum(int(read_field(usage, k, 0) or 0) for k in ("input", "cacheRead", "cacheWrite"))
                hit_rate = 100 * int(read_field(usage, "cacheRead", 0) or 0) / prompt if prompt else None
            elif role == "toolResult":
                usage = read_field(message, "usage")
        elif kind in ("compaction", "branch_summary"):
            usage = read_field(entry, "usage")
        if kind == "compaction":
            compacted += 1
        if usage is not None:
            addUsageToTotals(totals, usage)
            value = read_field(usage, "reasoning", read_field(usage, "reasoningTokens"))
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                reasoning = (reasoning or 0) + int(value)
    return totals, hit_rate, compacted, reasoning


def entries_telemetry(entries, *, cwd, model=None, context_usage=None, thinking_level=None,
                      permission_mode=None, auto_compact=None, subscription=None):
    totals, hit, compacted, reasoning = usage_snapshot(entries)
    if model is None:
        for entry in reversed(entries):
            message = read_field(entry, "message")
            if read_field(message, "role") == "assistant" and read_field(message, "model"):
                model = {"provider": read_field(message, "provider", ""), "id": read_field(message, "model")}
                break
    pair = ({"provider": str(read_field(model, "provider", "")),
             "modelId": str(read_field(model, "id", read_field(model, "modelId", "")))} if model else None)
    context = context_usage or {}
    return {"cwd": str(cwd), "tokens": {"input": totals.input, "output": totals.output,
            "cacheRead": totals.cacheRead, "cacheWrite": totals.cacheWrite, "reasoning": reasoning},
            "cost": totals.cost, "cacheHitRate": hit,
            "contextUsage": {"tokens": read_field(context, "tokens"),
                "contextWindow": read_field(context, "contextWindow", read_field(model, "contextWindow")),
                "percent": read_field(context, "percent")},
            "model": pair, "thinkingLevel": thinking_level, "permissionMode": permission_mode,
            "autoCompact": None if auto_compact is None else bool(auto_compact), "compactionCount": compacted,
            "subscription": None if subscription is None else bool(subscription)}


def merge_saved_telemetry(saved, observed):
    """Refresh file accounting without rewriting already observed runtime facts."""
    if not observed:
        return saved
    return {**saved, **{key: observed[key] for key in (
        "model", "contextUsage", "thinkingLevel", "permissionMode", "autoCompact", "subscription")}}


def collect_session_telemetry(session):
    manager = session.sessionManager
    model = getattr(session, "model", read_field(getattr(session, "state", None), "model"))
    thinking = getattr(session, "thinkingLevel", read_field(getattr(session, "state", None), "thinkingLevel"))
    permission = getattr(session, "getPermissionMode", lambda: None)()
    settings = getattr(session, "settingsManager", None)
    compact = getattr(settings, "getCompactionSettings", lambda: None)()
    auto_compact = read_field(compact, "enabled")
    registry = getattr(session, "modelRegistry", None)
    subscription = (True if read_field(model, "provider") == "kimi-coding" else
                    bool(registry.isUsingSubscription(model)) if model and registry else None)
    key = (id(manager), manager.getLeafId(), manager.getEntryCount(),
           read_field(model, "provider"), read_field(model, "id"), thinking, permission, auto_compact, subscription)
    cached = getattr(session, "_research_telemetry_cache", None)
    if cached and cached[0] == key:
        return cached[1]
    value = entries_telemetry(manager.getEntries(), cwd=manager.getCwd(), model=model,
        context_usage=getattr(session, "getContextUsage", lambda: None)(),
        thinking_level=thinking, permission_mode=permission,
        auto_compact=auto_compact, subscription=subscription)
    session._research_telemetry_cache = (key, value)
    return value
