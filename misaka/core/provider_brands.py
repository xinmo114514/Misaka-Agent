"""Desktop-visible brand grouping for the model settings page.

The registry carries ~40 built-in providers; the settings page shows a curated set of
brands instead. This module is the single source of truth for that mapping, so the desktop
client renders whatever it is handed rather than hard-coding provider ids of its own.

Nothing here changes the provider catalog: every provider stays registered and reachable
from the CLI. Only what the desktop page lists is narrowed.
"""

from __future__ import annotations

import os
from typing import Any

# A connection is one provider id the desktop can configure credentials for. ``kind`` says
# how the credential is obtained: an API key typed into the page, or a subscription/OAuth
# login that has to happen in the CLI (``misaka setup model`` / ``/login``).
BRAND_GROUPS: list[dict[str, Any]] = [
    {
        "brandId": "zhipu",
        "displayName": "智谱",
        "subtitle": "GLM 系列",
        "connections": [
            {"providerId": "zai", "kind": "api-key", "label": "Z.AI API Key", "detail": "api.z.ai"},
            {
                "providerId": "zai-coding-cn",
                "kind": "compat",
                "label": "Z.AI 编码兼容入口",
                "detail": "open.bigmodel.cn",
            },
        ],
    },
    {
        "brandId": "deepseek",
        "displayName": "DeepSeek",
        "subtitle": "深度求索",
        "connections": [
            {"providerId": "deepseek", "kind": "api-key", "label": "DeepSeek API Key", "detail": "api.deepseek.com"},
        ],
    },
    {
        "brandId": "anthropic",
        "displayName": "Claude",
        "subtitle": "Anthropic",
        "connections": [
            {"providerId": "anthropic", "kind": "api-key", "label": "Anthropic API Key", "detail": "api.anthropic.com"},
            {
                "providerId": "anthropic",
                "kind": "oauth",
                "label": "Claude 账号登录",
                "detail": "订阅制，按额外用量计费",
            },
        ],
    },
    {
        "brandId": "openai",
        "displayName": "OpenAI",
        "subtitle": "GPT 系列",
        "connections": [
            {"providerId": "openai", "kind": "api-key", "label": "OpenAI API Key", "detail": "api.openai.com"},
            {
                "providerId": "openai-codex",
                "kind": "oauth",
                "label": "ChatGPT 订阅 (Codex)",
                "detail": "ChatGPT Plus / Pro",
            },
        ],
    },
    {
        "brandId": "kimi",
        "displayName": "Kimi",
        "subtitle": "Moonshot AI",
        "connections": [
            {"providerId": "moonshotai", "kind": "api-key", "label": "Moonshot API Key", "detail": "api.moonshot.ai"},
            {"providerId": "moonshotai-cn", "kind": "compat", "label": "Moonshot 中国站", "detail": "api.moonshot.cn"},
            {
                "providerId": "kimi-coding",
                "kind": "oauth",
                "label": "Kimi Code 订阅",
                "detail": "api.kimi.com/coding",
            },
        ],
    },
    {
        "brandId": "xiaomi",
        "displayName": "小米",
        "subtitle": "MiMo",
        "connections": [
            {"providerId": "xiaomi", "kind": "api-key", "label": "Xiaomi MiMo API Key", "detail": "api.xiaomimimo.com"},
            {
                "providerId": "xiaomi-token-plan-cn",
                "kind": "compat",
                "label": "Token Plan 中国站",
                "detail": "token-plan-cn.xiaomimimo.com",
            },
            {
                "providerId": "xiaomi-token-plan-ams",
                "kind": "compat",
                "label": "Token Plan 阿姆斯特丹",
                "detail": "token-plan-ams.xiaomimimo.com",
            },
            {
                "providerId": "xiaomi-token-plan-sgp",
                "kind": "compat",
                "label": "Token Plan 新加坡",
                "detail": "token-plan-sgp.xiaomimimo.com",
            },
        ],
    },
    {
        "brandId": "qwen",
        "displayName": "千问",
        "subtitle": "Qwen",
        "connections": [
            {
                "providerId": "qwen-token-plan",
                "kind": "api-key",
                "label": "Qwen Token Plan",
                "detail": "ap-southeast-1.maas.aliyuncs.com",
            },
            {
                "providerId": "qwen-token-plan-cn",
                "kind": "compat",
                "label": "Token Plan 中国站",
                "detail": "cn-beijing.maas.aliyuncs.com",
            },
            {
                "providerId": "qwen-token-plan-individual",
                "kind": "compat",
                "label": "Token Plan 个人版",
                "detail": "ap-southeast-1.maas.aliyuncs.com",
            },
        ],
    },
]


def visible_provider_ids() -> list[str]:
    """Every provider id the desktop page can show (custom providers excluded)."""
    ids: list[str] = []
    for group in BRAND_GROUPS:
        for connection in group["connections"]:
            provider_id = str(connection["providerId"])
            if provider_id not in ids:
                ids.append(provider_id)
    return ids


def _connection_status(registry: Any, provider_id: str) -> dict[str, Any]:
    configured = False
    source = ""
    label = ""
    try:
        status = registry.getProviderAuthStatus(provider_id) if registry is not None else None
    except Exception:  # noqa: BLE001 - an unreadable status is simply "not configured"
        status = None
    if status is not None:
        configured = bool(getattr(status, "configured", False) or getattr(status, "source", None))
        source = str(getattr(status, "source", "") or "")
        label = str(getattr(status, "label", "") or "")
    return {"configured": configured, "source": source, "authLabel": label}


def _model_count(registry: Any, provider_id: str) -> int:
    if registry is None:
        return 0
    try:
        return sum(1 for model in registry.getAll() if getattr(model, "provider", None) == provider_id)
    except Exception:  # noqa: BLE001 - a broken catalog reports zero models
        return 0


def build_provider_groups(registry: Any) -> list[dict[str, Any]]:
    """The brand view the desktop renders, with live credential status per connection."""
    groups: list[dict[str, Any]] = []
    for group in BRAND_GROUPS:
        connections: list[dict[str, Any]] = []
        for connection in group["connections"]:
            provider_id = str(connection["providerId"])
            entry = {
                "providerId": provider_id,
                "kind": connection["kind"],
                "label": connection["label"],
                "detail": connection.get("detail", ""),
                "modelCount": _model_count(registry, provider_id),
            }
            entry.update(_connection_status(registry, provider_id))
            connections.append(entry)
        groups.append(
            {
                "brandId": group["brandId"],
                "displayName": group["displayName"],
                "subtitle": group.get("subtitle", ""),
                "connections": connections,
                "configured": any(connection["configured"] for connection in connections),
            }
        )
    return groups


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


__all__ = ["BRAND_GROUPS", "build_provider_groups", "visible_provider_ids"]
