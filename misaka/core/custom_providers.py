"""Read/write helpers for the user's own providers in ``~/.misaka/models.json``.

The model registry already reads this file (``core/model_registry.py``); what it never had
was a writer, so the desktop could only configure keys for providers that ship in the
catalog. These helpers edit the ``providers`` object in place, leaving every other key and
every unrelated provider untouched, and validate the shape the registry expects before the
file is written.

The accepted shape is the one documented in ``docs/guide/models.md``::

    {"providers": {"<id>": {"baseUrl": ..., "api": ..., "apiKey": ..., "models": [...]}}}
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

import httpx

from misaka.config.proxy_settings import proxy_httpx_options

API_FORMATS = ("openai-completions", "openai-responses", "anthropic-messages")


def _strip_json_comments(value: str) -> str:
    """Drop ``//`` comments and trailing commas, keeping quoted strings intact."""
    without_comments = re.sub(
        r'"(?:\\.|[^"\\])*"|//[^\n]*',
        lambda match: match.group(0) if match.group(0).startswith('"') else "",
        value,
    )
    return re.sub(
        r'"(?:\\.|[^"\\])*"|,(\s*[}\]])',
        lambda match: match.group(0) if match.group(0).startswith('"') else match.group(1),
        without_comments,
    )


def _read_document(path: str | Path) -> tuple[dict[str, Any], str | None]:
    """The parsed document, or ``({}, None)`` when there is no file yet.

    Returns an error string rather than raising: a malformed file is a state the settings
    page has to display, not a crash.
    """
    target = Path(path)
    if not target.exists():
        return {}, None
    try:
        raw = target.read_text(encoding="utf-8").removeprefix("\ufeff")
        parsed = json.loads(_strip_json_comments(raw)) if raw.strip() else {}
    except (OSError, ValueError) as error:
        return {}, f"Invalid models.json: {error}"
    if not isinstance(parsed, dict):
        return {}, "models.json must contain a JSON object"
    return parsed, None


def _write_document(path: str | Path, document: dict[str, Any]) -> None:
    """Atomically replace the file, preserving ``models.json`` if the write fails.

    Writing into a temp file in the same directory and renaming means a crash mid-write can
    never leave a truncated file behind. The home directory is created if missing, which also
    covers the case where the registry had not yet materialised it.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(dict(document), indent=2, ensure_ascii=False) + "\n"
    handle, temp_path = tempfile.mkstemp(dir=str(target.parent), prefix=".models-", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(text)
        os.replace(temp_path, target)
    except BaseException:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def _validate_provider_id(provider_id: Any) -> str | None:
    if not isinstance(provider_id, str) or not provider_id.strip():
        return "providerId is required"
    cleaned = provider_id.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", cleaned):
        return "providerId may contain letters, digits, dot, underscore and hyphen only"
    return None


def _validate_model(model: Any, index: int) -> str | None:
    if not isinstance(model, dict):
        return f"models[{index}] must be an object"
    if not isinstance(model.get("id"), str) or not model["id"].strip():
        return f"models[{index}].id is required"
    for numeric in ("contextWindow", "maxTokens"):
        value = model.get(numeric)
        if value is not None and (isinstance(value, bool) or not isinstance(value, int | float)):
            return f"models[{index}].{numeric} must be a number"
    api = model.get("api")
    if api is not None and api not in API_FORMATS:
        return f"models[{index}].api must be one of {', '.join(API_FORMATS)}"
    return None


def validate_custom_provider(draft: dict[str, Any]) -> str | None:
    """The same shape the registry's ``_validateProviderConfig`` insists on."""
    error = _validate_provider_id(draft.get("providerId"))
    if error:
        return error
    base_url = draft.get("baseUrl")
    if not isinstance(base_url, str) or not base_url.strip():
        return "baseUrl is required"
    if not re.match(r"^https?://", base_url.strip(), re.IGNORECASE):
        return "baseUrl must start with http:// or https://"
    if draft.get("api") not in API_FORMATS:
        return f"api must be one of {', '.join(API_FORMATS)}"
    models = draft.get("models")
    if not isinstance(models, list) or not models:
        return "At least one model is required"
    for index, model in enumerate(models):
        error = _validate_model(model, index)
        if error:
            return error
    return None


def _normalize_models(models: list[Any]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for model in models:
        entry: dict[str, Any] = {"id": str(model["id"]).strip()}
        for key in ("name", "api"):
            value = model.get(key)
            if isinstance(value, str) and value.strip():
                entry[key] = value.strip()
        for key in ("reasoning", "contextWindow", "maxTokens"):
            value = model.get(key)
            if isinstance(value, bool):
                entry[key] = value
            elif isinstance(value, int | float) and not isinstance(value, bool):
                entry[key] = int(value)
        normalized.append(entry)
    return normalized


def load_custom_providers(path: str | Path) -> tuple[dict[str, Any], str | None]:
    """The ``providers`` object of ``models.json``, plus a parse error if there is one."""
    document, error = _read_document(path)
    if error:
        return {}, error
    providers = document.get("providers")
    return (providers if isinstance(providers, dict) else {}), None


def upsert_custom_provider(path: str | Path, draft: dict[str, Any]) -> str | None:
    """Create or replace one provider. Returns a human-readable error, or ``None`` on success."""
    provider_id = str(draft.get("providerId") or "").strip()
    if not provider_id:
        return "providerId is required"
    document, read_error = _read_document(path)
    if read_error:
        return read_error
    providers = document.get("providers")
    if not isinstance(providers, dict):
        providers = {}

    effective = dict(draft)
    effective["providerId"] = provider_id

    # Normalize baseUrl protocol if omitted (only when no scheme is present)
    base_url = str(effective.get("baseUrl") or "").strip()
    if base_url and not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", base_url):
        base_url = f"http://{base_url}"
    effective["baseUrl"] = base_url

    # An edit that leaves the key blank keeps the stored one: the draft handed back to the
    # page carries only ``hasApiKey``, never the secret, so a blank field is "unchanged".
    if not str(effective.get("apiKey") or "").strip():
        existing = providers.get(provider_id)
        if isinstance(existing, dict) and isinstance(existing.get("apiKey"), str):
            effective["apiKey"] = existing["apiKey"]
        else:
            # Local servers (e.g. Ollama/vLLM) may have no auth at all
            effective["apiKey"] = "none"

    # Filter out empty model rows if valid models are present; leave invalid/empty models
    # for validate_custom_provider to report clear error paths
    raw_models = effective.get("models")
    if isinstance(raw_models, list) and any(isinstance(m, dict) and str(m.get("id") or "").strip() for m in raw_models):
        effective["models"] = [
            m for m in raw_models if isinstance(m, dict) and str(m.get("id") or "").strip()
        ]

    error = validate_custom_provider(effective)
    if error:
        return error

    api_format = effective.get("api") or "openai-completions"
    if api_format not in API_FORMATS:
        api_format = "openai-completions"

    normalized_models = _normalize_models(effective["models"])
    # Sort in English alphabetical order (case-insensitive A-Z)
    normalized_models.sort(key=lambda m: (str(m.get("name") or m.get("id") or "")).lower())

    entry: dict[str, Any] = {
        "baseUrl": str(effective["baseUrl"]).strip(),
        "api": api_format,
        "apiKey": str(effective.get("apiKey") or "none").strip(),
        "models": normalized_models,
    }
    name = effective.get("name")
    if isinstance(name, str) and name.strip():
        entry["name"] = name.strip()
    headers = effective.get("headers")
    if isinstance(headers, dict) and headers:
        entry["headers"] = {str(key): str(value) for key, value in headers.items()}

    providers[provider_id] = entry
    document["providers"] = providers
    _write_document(path, document)
    return None



def delete_custom_provider(path: str | Path, provider_id: str) -> bool:
    """Remove one provider. Returns whether anything was actually removed."""
    if not isinstance(provider_id, str) or not provider_id.strip():
        return False
    document, read_error = _read_document(path)
    if read_error:
        return False
    providers = document.get("providers")
    if not isinstance(providers, dict) or provider_id not in providers:
        return False
    providers.pop(provider_id, None)
    document["providers"] = providers
    _write_document(path, document)
    return True


def reorder_custom_providers(path: str | Path, order: list[str]) -> bool:
    """Rewrite the ``providers`` object so its keys follow ``order``.

    JSON objects preserve insertion order, and the desktop renders them in file order, so
    rewriting the mapping in the requested sequence is the whole operation. Ids absent from
    ``order`` keep their relative position after the ones that are named, which makes a
    partial order safe rather than destructive.
    """
    document, read_error = _read_document(path)
    if read_error:
        return False
    providers = document.get("providers")
    if not isinstance(providers, dict):
        return False
    ordered: dict[str, Any] = {}
    for provider_id in order:
        if isinstance(provider_id, str) and provider_id in providers and provider_id not in ordered:
            ordered[provider_id] = providers[provider_id]
    for provider_id, config in providers.items():
        if provider_id not in ordered:
            ordered[provider_id] = config
    if list(ordered) == list(providers):
        return False
    document["providers"] = ordered
    _write_document(path, document)
    return True


async def fetch_remote_models(
    base_url: str,
    api_format: str = "openai-completions",
    api_key: str | None = None,
    headers: dict[str, str] | None = None,
    timeout_seconds: float = 10.0,
) -> tuple[list[dict[str, Any]], str | None]:
    """Discover and retrieve available models from a remote endpoint.

    Works against standard OpenAI /models, Anthropic /v1/models, and Ollama /api/tags.
    """
    url = base_url.strip().rstrip("/")
    if not url:
        return [], "Base URL 不能为空"
    if not re.match(r"^https?://", url, re.IGNORECASE):
        url = f"http://{url}"

    req_headers: dict[str, str] = {
        "User-Agent": "Misaka-Agent/0.18.5",
        "Accept": "application/json",
    }
    if headers:
        req_headers.update({str(k): str(v) for k, v in headers.items()})

    clean_key = str(api_key).strip() if api_key and str(api_key).strip() and str(api_key).strip() != "none" else ""
    root_url = url.removesuffix("/v1")

    if api_format == "anthropic-messages":
        if clean_key:
            req_headers["x-api-key"] = clean_key
            req_headers["anthropic-version"] = "2023-06-01"
            req_headers["Authorization"] = f"Bearer {clean_key}"
        candidate_urls = [
            f"{url}/models",
            f"{root_url}/v1/models" if url != root_url else f"{url}/v1/models",
        ]
    else:
        if clean_key:
            req_headers["Authorization"] = f"Bearer {clean_key}"
        if url.endswith("/v1"):
            candidate_urls = [
                f"{url}/models",
                f"{root_url}/models",
                f"{root_url}/api/tags",
            ]
        else:
            candidate_urls = [
                f"{url}/models",
                f"{url}/v1/models",
                f"{url}/api/tags",
            ]

    last_error: str | None = None
    async with httpx.AsyncClient(
        timeout=timeout_seconds,
        follow_redirects=True,
        **proxy_httpx_options(url),
    ) as client:
        for probe_url in candidate_urls:
            try:
                resp = await client.get(probe_url, headers=req_headers)
                if resp.status_code == 200:
                    try:
                        data = resp.json()
                    except Exception:  # noqa: BLE001, S112
                        continue

                    raw_items = (
                        data.get("data")
                        if isinstance(data, dict) and isinstance(data.get("data"), list)
                        else data.get("models")
                        if isinstance(data, dict) and isinstance(data.get("models"), list)
                        else data
                        if isinstance(data, list)
                        else []
                    )

                    parsed: list[dict[str, Any]] = []
                    for item in raw_items:
                        m_id = None
                        m_name = None
                        context_win = 128000
                        max_tok = 16384
                        reasoning = False
                        if isinstance(item, dict):
                            m_id = item.get("id") or item.get("name") or item.get("model")
                            m_name = item.get("display_name") or item.get("name") or m_id
                            if "context_window" in item:
                                context_win = int(item["context_window"])
                            elif "max_context_length" in item:
                                context_win = int(item["max_context_length"])
                            if "max_tokens" in item:
                                max_tok = int(item["max_tokens"])
                            elif "max_output_tokens" in item:
                                max_tok = int(item["max_output_tokens"])
                            lowered = str(m_id).lower()
                            reasoning = any(kw in lowered for kw in ("r1", "reasoner", "thinking", "reasoning", "o1", "o3"))
                        elif isinstance(item, str):
                            m_id = item
                            m_name = item

                        if m_id and str(m_id).strip():
                            parsed.append({
                                "id": str(m_id).strip(),
                                "name": str(m_name).strip() if m_name else str(m_id).strip(),
                                "contextWindow": context_win,
                                "maxTokens": max_tok,
                                "reasoning": reasoning,
                            })

                    if parsed:
                        # Sort in English alphabetical order (case-insensitive A-Z)
                        parsed.sort(key=lambda m: (str(m.get("name") or m.get("id") or "")).lower())
                        return parsed, None
                elif resp.status_code in (401, 403):
                    last_error = f"鉴权失败 (HTTP {resp.status_code}): 请检查 API Key 是否正确"
                else:
                    last_error = f"HTTP {resp.status_code}: {resp.text[:120]}"
            except httpx.ConnectError:
                last_error = f"连接失败: 无法连接到 {url}，请确认服务已启动且地址正确"
            except httpx.TimeoutException:
                last_error = f"请求超时: {url} 响应超过 {int(timeout_seconds)} 秒"
            except Exception as e:  # noqa: BLE001
                last_error = str(e)

    return [], (last_error or "未能从目标服务发现可用模型列表")



__all__ = [
    "API_FORMATS",
    "delete_custom_provider",
    "fetch_remote_models",
    "load_custom_providers",
    "reorder_custom_providers",
    "upsert_custom_provider",
    "validate_custom_provider",
]
