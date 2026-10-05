"""Desktop bridge for JSONL stdio communication with Electron frontend."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import socket
import sys
import time
import urllib.parse
import uuid
from typing import Any

from misaka.config import get_agent_dir, get_auth_path, get_sessions_dir
from misaka.config.product import current_config
from misaka.core.custom_providers import (
    delete_custom_provider as remove_custom_provider,
)
from misaka.core.custom_providers import (
    fetch_remote_models,
    load_custom_providers,
    reorder_custom_providers,
    upsert_custom_provider,
)
from misaka.core.output_guard import (
    flushRawStdout,
    isStdoutTakenOver,
    restoreStdout,
    takeOverStdout,
    waitForRawStdoutBackpressure,
    writeRawStdout,
)
from misaka.core.provider_brands import build_provider_groups, visible_provider_ids
from misaka.core.provider_display_names import BUILT_IN_PROVIDER_DISPLAY_NAMES
from misaka.core.session_manager import (
    SessionInfo,
    SessionManager,
    session_entry_to_display_messages,
    sessions_root_of,
)
from misaka.modes.jsonl import to_json_event, to_jsonable
from misaka.ui.tui.interactive.theme.theme import (
    get_resolved_theme_colors,
    load_theme_json,
)
from misaka.utils.shell import killTrackedDetachedChildren
from misaka.utils.values import read_field


def _clean_broken_local_proxies() -> None:
    for var in ("ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"):
        val = os.environ.get(var)
        if val and ("127.0.0.1" in val or "localhost" in val):
            try:
                parsed = urllib.parse.urlparse(val)
                port = parsed.port or (7890 if "7890" in val else 8080)
                host = parsed.hostname or "127.0.0.1"
                with socket.create_connection((host, port), timeout=0.1):
                    pass
            except Exception:  # noqa: BLE001
                os.environ.pop(var, None)


def _serialize_session_info(s: SessionInfo) -> dict[str, Any]:
    created_str = (
        s.created.isoformat()
        if hasattr(s.created, "isoformat")
        else str(s.created)
    )
    modified_str = (
        s.modified.isoformat()
        if hasattr(s.modified, "isoformat")
        else str(s.modified)
    )
    return {
        "path": s.path,
        "id": s.id,
        "cwd": s.cwd,
        "created": created_str,
        "modified": modified_str,
        "messageCount": s.messageCount,
        "firstMessage": s.firstMessage,
        "allMessagesText": s.allMessagesText,
        "name": s.name,
        "parentSessionPath": s.parentSessionPath,
    }


def _timestamp_ms_from(value: Any, fallback_ms: int = 0) -> int:
    if isinstance(value, bool):
        return fallback_ms
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str) and value:
        try:
            from datetime import datetime
            return int(datetime.fromisoformat(value).timestamp() * 1000)
        except ValueError:
            return fallback_ms
    return fallback_ms


def _content_text(blocks: Any) -> str:
    """Flatten a message content value (string, or content blocks) to text."""
    if isinstance(blocks, str):
        return blocks
    if not isinstance(blocks, list):
        return ""
    parts: list[str] = []
    for block in blocks:
        if read_field(block, "type") == "text":
            parts.append(str(read_field(block, "text") or ""))
    return "".join(parts)


def _serialize_session_entries(entries: list[Any]) -> list[dict[str, Any]]:
    """Turn persisted session entries into the desktop timeline shape.

    Reuses the transcript projection (``session_entry_to_display_messages``) so a reopened
    session shows exactly what the TUI shows. Assistant ``toolCall`` blocks stay on their
    message; the matching ``toolResult`` is folded into ``toolCall.result`` instead of
    becoming a row of its own.

    ``custom_message`` entries are included because that is how a research run reports itself
    to its own conversation (``research-progress`` and friends, wiring/research.py:256). Leaving
    them out would leave a run's feed invisible on reopen, with only the live turn to show it.
    """
    messages: list[dict[str, Any]] = []
    tool_calls_by_id: dict[str, dict[str, Any]] = {}

    for entry in entries:
        if not isinstance(entry, dict) or entry.get("type") not in ("message", "custom_message"):
            continue
        entry_id = str(entry.get("id") or "entry")
        entry_ms = _timestamp_ms_from(entry.get("timestamp"))
        try:
            display_messages = session_entry_to_display_messages(entry)
        except Exception as error:  # noqa: BLE001 - a single bad entry must not kill the history
            print(f"Warning: skipping session entry {entry_id}: {error}", file=sys.stderr)
            continue

        for index, message in enumerate(display_messages):
            role = read_field(message, "role")
            message_id = f"msg-{entry_id}-{index}"
            timestamp = _timestamp_ms_from(read_field(message, "timestamp"), entry_ms)

            if role == "user":
                messages.append({
                    "id": message_id,
                    "entryId": entry_id,
                    "role": "user",
                    "content": _content_text(read_field(message, "content")),
                    "timestamp": timestamp,
                })
            elif role == "assistant":
                content = read_field(message, "content")
                text_parts: list[str] = []
                thinking_parts: list[str] = []
                tool_calls: list[dict[str, Any]] = []
                if isinstance(content, str):
                    text_parts.append(content)
                elif isinstance(content, list):
                    for block in content:
                        block_type = read_field(block, "type")
                        if block_type == "text":
                            text_parts.append(str(read_field(block, "text") or ""))
                        elif block_type == "thinking":
                            thinking_parts.append(str(read_field(block, "thinking") or ""))
                        elif block_type == "toolCall":
                            tool_call = {
                                "id": str(read_field(block, "id") or f"{message_id}-tc"),
                                "name": str(read_field(block, "name") or "tool"),
                                "arguments": read_field(block, "arguments") or {},
                                "status": "success",
                            }
                            tool_calls.append(tool_call)
                            tool_calls_by_id[tool_call["id"]] = tool_call

                serialized: dict[str, Any] = {
                    "id": message_id,
                    "entryId": entry_id,
                    "role": "assistant",
                    "content": "".join(text_parts),
                    "timestamp": timestamp,
                }
                thinking_text = "".join(thinking_parts)
                if thinking_text:
                    serialized["thinking"] = thinking_text
                if tool_calls:
                    serialized["toolCalls"] = tool_calls
                usage = read_field(message, "usage")
                if isinstance(usage, dict) or hasattr(usage, "input"):
                    serialized["tokens"] = {
                        "input": read_field(usage, "input"),
                        "output": read_field(usage, "output"),
                        "total": read_field(usage, "totalTokens"),
                    }
                messages.append(serialized)
            elif role == "custom":
                details = read_field(message, "details")
                messages.append({
                    "id": message_id,
                    "entryId": entry_id,
                    "role": "custom",
                    "customType": str(read_field(message, "customType") or ""),
                    "content": _content_text(read_field(message, "content")),
                    # The engine decides what the feed shows; the desktop must not decide again.
                    "display": bool(read_field(message, "display")),
                    "details": details if isinstance(details, dict) else {},
                    "timestamp": timestamp,
                })
            elif role == "toolResult":
                tool_call_id = str(read_field(message, "toolCallId") or "")
                tool_call = tool_calls_by_id.get(tool_call_id)
                if tool_call is not None:
                    content = read_field(message, "content")
                    tool_call["status"] = "error" if read_field(message, "isError") else "success"
                    tool_call["result"] = _content_text(content) if isinstance(content, list) else content

    return messages


def _session_started_payload(session: Any) -> dict[str, Any]:
    manager = getattr(session, "sessionManager", None)
    get_perm = getattr(session, "getPermissionMode", None)
    perm_mode = get_perm() if callable(get_perm) else "default"
    return {
        "type": "session_started",
        "sessionId": getattr(session, "sessionId", None),
        "cwd": manager.getCwd() if manager is not None else None,
        "name": getattr(session, "sessionName", None),
        "file": getattr(session, "sessionFile", None),
        "permissionMode": perm_mode or "default",
    }


def _open_research_readonly() -> Any:
    """A read-only connection to the product board, or None when there is nothing to read.

    The desktop only ever inspects runs another process drives, so this never creates or
    migrates: a board that has no research tables yet is reported as "no runs" rather than
    being written to.
    """
    import sqlite3
    from pathlib import Path

    try:
        db_path = current_config().get("db")
    except Exception:  # noqa: BLE001 - an unreadable config means the same thing as no runs
        return None
    if not db_path or not os.path.isfile(str(db_path)):
        return None
    try:
        con = sqlite3.connect(Path(str(db_path)).expanduser().resolve().as_uri() + "?mode=ro", uri=True)
    except sqlite3.Error:
        return None
    con.row_factory = sqlite3.Row
    try:
        con.execute("PRAGMA query_only=ON")
        if not con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_runs'"
        ).fetchone():
            con.close()
            return None
    except sqlite3.Error:
        con.close()
        return None
    return con


def _open_research_write() -> Any:
    """A writable connection to an existing product board, or None when there is nothing to write.

    Only stop, resume and retry write through here; every read keeps the read-only handle, so the
    desktop stays what ``_open_research_readonly`` says it is -- a process that inspects runs others
    drive, and occasionally asks one to stop. Like that helper this never creates or migrates: a
    board with no research tables is reported as absent rather than built.

    The handle is a ``SerializedConnection`` whose ``Row`` expands ``HOME_POINTERS`` on named
    access, unlike the read-only handle's plain ``sqlite3.Row``.
    """
    from pathlib import Path

    from misaka.core.platform import tasks

    try:
        db_path = current_config().get("db")
    except Exception:  # noqa: BLE001 - an unreadable config means the same thing as no board
        return None
    if not db_path or not os.path.isfile(str(db_path)):
        return None
    try:
        con = tasks.connect(str(Path(str(db_path)).expanduser().resolve()))
    except Exception:  # noqa: BLE001 - locked or unreadable board
        return None
    try:
        if not con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_runs'"
        ).fetchone():
            con.close()
            return None
    except Exception:  # noqa: BLE001
        con.close()
        return None
    return con


def _research_workspace(obj: dict[str, Any], session: Any) -> str | None:
    explicit = obj.get("workspace")
    if isinstance(explicit, str) and explicit:
        return os.path.realpath(explicit)
    manager = getattr(session, "sessionManager", None)
    cwd = manager.getCwd() if manager is not None and hasattr(manager, "getCwd") else None
    return os.path.realpath(cwd) if cwd else None


def _latest_run_row(runs: Any, con: Any, workspace: str | None) -> Any:
    """Newest run in the workspace (newest overall when none is given), or None."""
    for candidate in runs.listing(con):
        if workspace is None or os.path.realpath(str(candidate["workspace"])) == workspace:
            return candidate
    return None


def _serialize_research_run(runs: Any, con: Any, row: Any, session: Any = None) -> dict[str, Any]:
    """``runs.summary`` plus the fields the desktop lists with (question, timestamps, ownership).

    Ownership is the desktop's real question: which interventions are legal depends on who holds
    the run. ``runs.summary`` does not report it, so it comes off the row. The board handle here is
    a plain ``sqlite3.Row`` (``_open_research_readonly``), not ``platform.tasks.Row``, so it does
    not expand the home-relative ``HOME_POINTERS`` on named access -- the bridge has to, or it
    compares a stored name against a live session's absolute file and never matches.
    """
    from misaka.config import home

    summary = runs.summary(con, str(row["id"])) or {"id": str(row["id"])}
    summary["question"] = row["question"]
    summary["createdAt"] = row["created_at"]
    summary["updatedAt"] = row["updated_at"]

    lock = row["driver_lock"]
    expires = row["driver_expires"]
    # The same liveness the engine applies before it lets a second driver take over (runs.py:753),
    # and the same crash reclamation (runs.py:331), so the desktop never offers a button whose
    # write the driver would refuse.
    driving = bool(lock) and (expires is None or expires >= time.time()) and not runs._lease_holder_is_dead(lock)
    summary["driverLock"] = lock
    summary["driverExpires"] = expires
    summary["driving"] = driving

    root = row["root_session"]
    origin = row["origin_session"]
    summary["rootSession"] = str(home.from_stored(root)) if root else None
    summary["originSession"] = str(home.from_stored(origin)) if origin else None
    manager = getattr(session, "sessionManager", None)
    own = getattr(manager, "sessionFile", None) if manager is not None else None
    summary["ownedByThisProcess"] = bool(
        root and own and os.path.realpath(str(home.from_stored(root))) == os.path.realpath(own))
    return summary


def _check_update_status() -> dict[str, Any]:
    """Whether this install is behind the tracked branch, in the desktop's own shape.

    Mirrors how the CLI decides (a git checkout compares itself offline; anything else asks
    GitHub), but reports a reason instead of printing, so the GUI can show it in a toast.
    """
    from misaka.cli import update as update_cli

    try:
        install = update_cli.describe()
    except Exception as error:  # noqa: BLE001 - describe() reads only local metadata; a failure is still reportable
        return {"version": None, "kind": None, "behind": None, "upToDate": None, "reason": str(error)}

    behind: int | None = None
    reason: str | None = None
    if install.kind == "checkout":
        try:
            state = update_cli._checkout_state(install)
        except Exception as error:  # noqa: BLE001
            state = {"reason": str(error)}
        behind = state.get("behind")
        # A reason only explains why a *distance* could not be reported; when a distance is
        # known (including 0, where a dirty tree may still be the reason) it is not surfaced.
        reason = state.get("reason") if behind is None else None
    elif install.commit:
        behind, failure = update_cli._behind(install.commit)
        reason = failure
    else:
        reason = "this install is not made from the repository"

    return {
        "version": install.version,
        "kind": install.kind,
        "behind": behind,
        "upToDate": None if behind is None else behind == 0,
        "reason": reason,
    }


def _model_registry_of(session: Any) -> Any:
    return getattr(session, "modelRegistry", None) or getattr(session, "registry", None)


def _resolve_models_json_path(session: Any) -> str:
    """The file the desktop edits: the registry's own models.json when it has one.

    A registry built elsewhere (an extension, a test) may hold a different path; reading it
    back off the registry keeps the editor pointed at the file that is actually loaded.
    """
    registry = _model_registry_of(session)
    for attribute in ("_modelsJsonPath", "modelsJsonPath"):
        candidate = getattr(registry, attribute, None)
        if isinstance(candidate, str) and candidate:
            return candidate
    from misaka.config import home

    return str(home.path("models"))


def _custom_model_ids(session: Any, provider_id: str) -> set[str]:
    """Model ids this provider declares in models.json, used to tag them as custom."""
    registry = _model_registry_of(session)
    overrides = getattr(registry, "_modelOverrides", None)
    if isinstance(overrides, dict):
        provider_overrides = overrides.get(provider_id)
        if isinstance(provider_overrides, dict):
            return {str(model_id) for model_id in provider_overrides}
    return set()


def _serialize_custom_provider(provider_id: str, config: Any) -> dict[str, Any]:
    entry = config if isinstance(config, dict) else {}
    models = entry.get("models")
    return {
        "providerId": provider_id,
        "name": str(entry.get("name") or provider_id),
        "baseUrl": str(entry.get("baseUrl") or ""),
        "api": str(entry.get("api") or ""),
        "hasApiKey": bool(entry.get("apiKey")),
        "headers": entry.get("headers") if isinstance(entry.get("headers"), dict) else {},
        "models": [model for model in models if isinstance(model, dict)] if isinstance(models, list) else [],
    }


async def _test_model_connectivity(session: Any, provider_id: str, model_id: str | None) -> dict[str, Any]:
    """Send one tiny real request through the registry's own auth and stream path.

    This is the same seam ``misaka setup model`` verifies with: resolve auth, then ask the
    provider for a couple of tokens. The error text separates an unreachable endpoint (a
    transport error) from a rejected credential (the provider answered with an auth error).
    """
    from misaka.ai.stream import complete_simple
    from misaka.ai.types import Context, SimpleStreamOptions, UserMessage

    registry = _model_registry_of(session)
    if registry is None:
        return {"ok": False, "error": "Session has no model registry"}
    model = registry.find(provider_id, model_id) if model_id else None
    if model is None:
        candidates = [m for m in registry.getAll() if getattr(m, "provider", None) == provider_id]
        model = candidates[0] if candidates else None
        model_id = getattr(model, "id", None) if model is not None else model_id
    if model is None:
        return {"ok": False, "error": f"No model found for provider {provider_id}"}

    started = time.monotonic()
    try:
        auth = await registry.getApiKeyAndHeaders(model)
    except Exception as error:  # noqa: BLE001 - reported verbatim to the page
        return {"ok": False, "error": f"{type(error).__name__}: {error}"}
    if not auth.get("ok"):
        return {"ok": False, "error": str(auth.get("error") or "no credential resolved")}

    try:
        reply = await complete_simple(
            model,
            Context(messages=[UserMessage(content="Reply with the single word OK.", timestamp=0)]),
            SimpleStreamOptions(apiKey=auth.get("apiKey"), headers=auth.get("headers"), maxTokens=8),
        )
    except Exception as error:  # noqa: BLE001 - transport failure, not a provider reply
        return {"ok": False, "error": f"{type(error).__name__}: {error}"}
    latency_ms = int((time.monotonic() - started) * 1000)
    if reply.stopReason == "error":
        return {"ok": False, "error": str(reply.errorMessage or "request failed"), "latencyMs": latency_ms}
    text = "".join(str(getattr(part, "text", "")) for part in reply.content)
    return {"ok": True, "latencyMs": latency_ms, "responseText": text.strip()[:200], "modelId": model.id}


def _get_desktop_theme_colors(theme_name: str | None = None) -> dict[str, Any]:
    name = theme_name or "dark"
    colors = get_resolved_theme_colors(name)
    try:
        theme_json = load_theme_json(name)
    except Exception:  # noqa: BLE001
        theme_json = {}
    raw_desktop = theme_json.get("desktop") if isinstance(theme_json, dict) else {}
    if not isinstance(raw_desktop, dict):
        raw_desktop = {}
    variables = theme_json.get("vars") if isinstance(theme_json, dict) else {}
    if not isinstance(variables, dict):
        variables = {}

    is_light = name == "light"
    default_desktop = {
        "surface0": "#faf4f6" if is_light else "#18181e",
        "surface1": "#ffffff" if is_light else "#1e1e24",
        "surface2": "#f3e9ee" if is_light else "#25252d",
        "surface3": "#e9dde4" if is_light else "#2c2c36",
        "surfaceHover": "#f7eef3" if is_light else "#232329",
        "borderSubtle": "#ede0e6" if is_light else colors.get("borderMuted", "#2a2a33"),
        "border": "#dcc8d1" if is_light else colors.get("border", "#37373f"),
        "borderStrong": "#c4a4b1" if is_light else colors.get("borderMuted", "#4a3d42"),
        "borderAccent": "#e0a9bd" if is_light else colors.get("borderAccent", "#8f2545"),
        "disabled": "#b8a6ad" if is_light else "#6e5f64",
        "focusRing": colors.get("accent", "#b12a55" if is_light else "#e8698c"),
        "chart": (
            ["#b12a55", "#a56a1e", "#3f7a3f", "#2f7a68", "#4f5fa8", "#8d4470"]
            if is_light
            else ["#cb3862", "#e0b23e", "#acd39c", "#3c9a80", "#4f70c4", "#c191d4"]
        ),
    }
    # A theme's desktop block may hold variable references (e.g. "surface0": "surface0"),
    # so each entry is resolved against vars before it reaches the desktop client.
    resolved_desktop: dict[str, Any] = {}
    for key, value in raw_desktop.items():
        if key == "chart" and isinstance(value, list):
            resolved_desktop[key] = [
                variables.get(item, item) if isinstance(item, str) else item for item in value
            ]
        elif isinstance(value, str) and value in variables:
            resolved_desktop[key] = variables[value]
        else:
            resolved_desktop[key] = value
    merged_desktop = {**default_desktop, **resolved_desktop}
    return {**colors, "desktop": merged_desktop}


def _safe_to_json_event(event: Any) -> Any:
    try:
        return to_json_event(event)
    except Exception as error:  # noqa: BLE001
        print(f"Warning: to_json_event fallback: {error}", file=sys.stderr)
        return to_jsonable(event)


def _serialize_event(seq_num: int, session_id: str, raw_event: Any) -> str:
    payload = {
        "seq": seq_num,
        "sessionId": session_id,
        "event": _safe_to_json_event(raw_event),
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"


def _serialize_ack(
    request_id: str | None,
    ok: bool,
    error: str | None = None,
    data: Any = None,
    **extra: Any,
) -> str:
    payload: dict[str, Any] = {
        "type": "ack",
        "requestId": request_id,
        "ok": ok,
    }
    if error is not None:
        payload["error"] = error
    if data is not None:
        payload["data"] = data
    payload.update(extra)
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
async def run_desktop_bridge(runtime_host: Any, options: Any = None) -> int:
    """Run the desktop bridge loop transferring stdio commands and JSONL events."""
    _clean_broken_local_proxies()
    session = runtime_host.session
    unsubscribe = None
    unsubscribe_backpressure = None
    disposed = False
    signal_cleanup_handlers: list[tuple[int, Any]] = []
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    seq = 0
    active_prompt_task: asyncio.Task[None] | None = None
    took_over = False
    pending_permissions: dict[str, asyncio.Future[Any]] = {}
    pending_permission_tool_names: dict[str, str] = {}

    async def bridge_permission_resolver(task: Any, event: dict[str, Any]) -> bool:
        perm_id = f"perm_{uuid.uuid4().hex[:8]}"
        future = loop.create_future()
        pending_permissions[perm_id] = future
        tool_name = str(event.get("toolName") or "tool")
        pending_permission_tool_names[perm_id] = tool_name
        req_event = {
            "type": "permission:request",
            "requestId": perm_id,
            "agentId": getattr(task, "id", None),
            "toolName": tool_name,
            "toolInput": event.get("toolInput", {}),
            "reason": event.get("reason"),
            "mode": session.getPermissionMode() or "default",
        }
        handle_event(req_event)
        try:
            res = await future
            return bool(res.get("approved")) if isinstance(res, dict) else bool(res)
        except Exception:
            return False
        finally:
            pending_permissions.pop(perm_id, None)
            pending_permission_tool_names.pop(perm_id, None)

    if not isStdoutTakenOver():
        takeOverStdout()
        took_over = True

    def write_ack(
        request_id: str | None,
        ok: bool,
        error: str | None = None,
        data: Any = None,
        **extra: Any,
    ) -> None:
        writeRawStdout(_serialize_ack(request_id, ok, error, data, **extra))

    def handle_event(event: Any) -> None:
        nonlocal seq
        seq += 1
        line = _serialize_event(seq, session.sessionId, event)
        writeRawStdout(line)

    async def dispose_runtime() -> None:
        nonlocal disposed, unsubscribe, unsubscribe_backpressure
        if disposed:
            return
        disposed = True
        if callable(unsubscribe):
            unsubscribe()
            unsubscribe = None
        if callable(unsubscribe_backpressure):
            unsubscribe_backpressure()
            unsubscribe_backpressure = None
        await runtime_host.dispose()

    async def rebind_session(_session: Any = None) -> None:
        nonlocal session, unsubscribe, unsubscribe_backpressure
        session = runtime_host.session

        async def _fork(entry_id: str, fork_options: Any = None) -> dict[str, Any]:
            result = await runtime_host.fork(entry_id, fork_options)
            return {"cancelled": read_field(result, "cancelled")}

        async def _navigate_tree(target_id: str, navigate_options: Any = None) -> dict[str, Any]:
            result = await session.navigateTree(
                target_id,
                {
                    "summarize": read_field(navigate_options, "summarize"),
                    "customInstructions": read_field(navigate_options, "customInstructions"),
                    "replaceInstructions": read_field(navigate_options, "replaceInstructions"),
                    "label": read_field(navigate_options, "label"),
                },
            )
            return {"cancelled": read_field(result, "cancelled")}

        async def _reload() -> None:
            await session.reload()

        await session.bindExtensions(
            {
                "mode": "json",
                "commandContextActions": {
                    "waitForIdle": lambda: session.waitForIdle(),
                    "newSession": lambda new_session_options=None: runtime_host.newSession(new_session_options),
                    "fork": _fork,
                    "navigateTree": _navigate_tree,
                    "switchSession": lambda session_path, switch_options=None: runtime_host.switchSession(
                        session_path,
                        switch_options,
                    ),
                    "reload": _reload,
                },
                "onError": lambda error: print(
                    f"Extension error ({read_field(error, 'extensionPath', '<unknown>')}): "
                    f"{read_field(error, 'error', error)}",
                    file=sys.stderr,
                ),
            }
        )

        if callable(unsubscribe):
            unsubscribe()
        if callable(unsubscribe_backpressure):
            unsubscribe_backpressure()
        if hasattr(session, "setAgentPermissionResolver"):
            session.setAgentPermissionResolver(bridge_permission_resolver)
        unsubscribe = session.subscribe(handle_event)
        unsubscribe_backpressure = session.agent.subscribe(
            lambda _event, _signal=None: waitForRawStdoutBackpressure()
        )

    def register_signal_handlers() -> None:
        signals = [signal.SIGTERM]
        sighup = getattr(signal, "SIGHUP", None)
        if sys.platform != "win32" and sighup is not None:
            signals.append(sighup)

        for current_signal in signals:
            previous_handler = signal.getsignal(current_signal)

            def _handler(_signum: int, _frame: Any, *, current_signal: int = current_signal) -> None:
                killTrackedDetachedChildren()
                exit_code = 129 if sighup is not None and current_signal == sighup else 143
                task = loop.create_task(dispose_runtime())
                task.add_done_callback(lambda _task, exit_code=exit_code: sys.exit(exit_code))

            signal.signal(current_signal, _handler)
            signal_cleanup_handlers.append((current_signal, previous_handler))
    async def dispatch_command(obj: dict[str, Any]) -> None:
        nonlocal active_prompt_task
        req_id = obj.get("requestId")
        cmd_type = obj.get("type") or obj.get("command") or obj.get("action")
        if not cmd_type and "text" in obj and "path" not in obj:
            cmd_type = "prompt"

        if not cmd_type:
            write_ack(req_id, ok=False, error="Missing command type")
            return

        cmd = str(cmd_type).lower()
        if cmd == "prompt":
            text = obj.get("text")
            if not isinstance(text, str):
                write_ack(req_id, ok=False, error="prompt requires 'text' string")
                return
            images = obj.get("images")
            streaming_behavior = obj.get("streamingBehavior")

            if session.isStreaming and not streaming_behavior:
                write_ack(
                    req_id,
                    ok=False,
                    error="Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
                )
                return

            write_ack(req_id, ok=True)

            async def _run_prompt() -> None:
                try:
                    prompt_opts: dict[str, Any] = {"images": images}
                    if streaming_behavior:
                        prompt_opts["streamingBehavior"] = streaming_behavior
                    await session.prompt(text, prompt_opts)
                except Exception as exc:  # noqa: BLE001
                    print(f"Prompt error: {exc}", file=sys.stderr)

            task = loop.create_task(_run_prompt())
            active_prompt_task = task

        elif cmd == "steer":
            text = obj.get("text")
            if not isinstance(text, str):
                write_ack(req_id, ok=False, error="steer requires 'text' string")
                return
            try:
                await session.steer(text, obj.get("images"))
                write_ack(req_id, ok=True)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("follow_up", "followup"):
            text = obj.get("text")
            if not isinstance(text, str):
                write_ack(req_id, ok=False, error="follow_up requires 'text' string")
                return
            try:
                await session.followUp(text, obj.get("images"))
                write_ack(req_id, ok=True)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd == "abort":
            try:
                for fut in list(pending_permissions.values()):
                    if not fut.done():
                        fut.set_result({"approved": False, "reason": "aborted"})
                pending_permissions.clear()
                pending_permission_tool_names.clear()
                await session.abort()
                write_ack(req_id, ok=True)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("get_permission_mode", "getpermissionmode"):
            try:
                mode = session.getPermissionMode() or "default"
                write_ack(req_id, ok=True, data={"mode": mode}, mode=mode)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("set_permission_mode", "setpermissionmode"):
            mode = obj.get("mode")
            if not mode:
                write_ack(req_id, ok=False, error="set_permission_mode requires 'mode'")
                return
            try:
                session.setPermissionMode(str(mode))
                write_ack(req_id, ok=True, data={"mode": str(mode)}, mode=str(mode))
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("permission_response", "permissionresponse"):
            perm_id = obj.get("requestId")
            decision = obj.get("decision", "deny")
            scope = obj.get("scope", "once")
            feedback = obj.get("feedback")
            fut = pending_permissions.pop(perm_id, None)
            tool_name = pending_permission_tool_names.pop(perm_id, None)
            if fut is not None and not fut.done():
                if decision == "allow" and scope == "session" and tool_name:
                    session.addSessionPermission(tool_name)
                fut.set_result({
                    "approved": decision == "allow",
                    "scope": scope,
                    "feedback": feedback,
                })
                write_ack(req_id, ok=True)
            else:
                write_ack(req_id, ok=False, error="No pending permission request found for requestId")

        elif cmd in ("set_model", "setmodel"):
            provider = obj.get("provider")
            model_id = obj.get("modelId") or obj.get("model")
            if not provider or not model_id:
                write_ack(req_id, ok=False, error="set_model requires 'provider' and 'modelId'")
                return
            reg = getattr(session, "modelRegistry", None)
            if reg is None:
                write_ack(req_id, ok=False, error="Session has no model registry")
                return
            model = reg.find(provider, model_id)
            if model is None:
                write_ack(req_id, ok=False, error=f"Model not found: {provider}/{model_id}")
                return
            persist = bool(obj.get("persist", False))
            try:
                await session.setModel(model, persist=persist)
                write_ack(req_id, ok=True)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("set_thinking", "setthinking"):
            level = obj.get("level")
            if not level:
                write_ack(req_id, ok=False, error="set_thinking requires 'level'")
                return
            try:
                session.setThinkingLevel(level)
                write_ack(req_id, ok=True)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("get_stats", "getstats"):
            try:
                stats = session.getSessionStats()
                context_usage = session.getContextUsage()
                stats_payload = {
                    "stats": to_jsonable(stats),
                    "contextUsage": to_jsonable(context_usage),
                }
                write_ack(req_id, ok=True, data=stats_payload, **stats_payload)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("get_tools", "gettools"):
            try:
                tools = session.getAllTools()
                slash_commands = session.getSlashCommands()
                tools_payload = {
                    "tools": to_jsonable(tools),
                    "slashCommands": to_jsonable(slash_commands),
                }
                write_ack(req_id, ok=True, data=tools_payload, **tools_payload)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("list_sessions", "listsessions"):
            try:
                # Enumerate every session in the product store (all cwd buckets), not just
                # the current cwd: the desktop groups them into projects itself.
                manager = getattr(session, "sessionManager", None)
                session_dir = (
                    manager.getSessionDir()
                    if manager is not None and hasattr(manager, "getSessionDir")
                    else None
                )
                root = sessions_root_of(session_dir) or get_sessions_dir()
                sessions_list = await SessionManager.listAll(root)
                sessions_data = [_serialize_session_info(s) for s in sessions_list]
                write_ack(req_id, ok=True, data={"sessions": sessions_data}, sessions=sessions_data)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("load_session", "loadsession"):
            path = obj.get("path")
            if not path:
                write_ack(req_id, ok=False, error="load_session requires 'path'")
                return
            try:
                await runtime_host.switchSession(path)
                # switchSession rebinds `session` via rebind_session; read the fresh one.
                mgr = getattr(session, "sessionManager", None)
                entries = mgr.buildContextEntries() if mgr is not None and hasattr(mgr, "buildContextEntries") else []
                messages_payload = _serialize_session_entries(entries)
                session_info = _session_started_payload(session)
                handle_event(session_info)
                write_ack(
                    req_id,
                    ok=True,
                    data={"session": session_info, "messages": messages_payload},
                    messages=messages_payload,
                )
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("switch_workspace", "switchworkspace", "set_workspace", "setworkspace"):
            workspace_path = obj.get("path") or obj.get("workspace") or obj.get("cwd")
            if not workspace_path or not os.path.isdir(str(workspace_path)):
                write_ack(req_id, ok=False, error=f"Invalid workspace path: {workspace_path}")
                return
            workspace_path = os.path.realpath(str(workspace_path))
            session_path = obj.get("sessionPath")
            try:
                if session_path and os.path.isfile(str(session_path)):
                    await runtime_host.switchSession(str(session_path))
                else:
                    manager = getattr(session, "sessionManager", None)
                    session_dir = (
                        manager.getSessionDir()
                        if manager is not None and hasattr(manager, "getSessionDir")
                        else None
                    )
                    root = sessions_root_of(session_dir) or get_sessions_dir()
                    all_sessions = await SessionManager.listAll(root)
                    matching = [
                        s for s in all_sessions
                        if s.cwd and os.path.realpath(str(s.cwd)) == workspace_path
                    ]
                    if matching:
                        matching.sort(key=lambda s: s.modified.timestamp(), reverse=True)
                        await runtime_host.switchSession(str(matching[0].path))
                    else:
                        new_result = await runtime_host.newSession({"cwd": workspace_path})
                        if read_field(new_result, "cancelled"):
                            write_ack(req_id, ok=False, error="New session cancelled")
                            return

                # The role assembly is built once, at process start, so switching the session does
                # not rebuild the Parts with a new workspace. Most read it per call (ResearchPart
                # takes ctx.cwd), but MISAKA_WORKSPACE was captured from the role env and some code
                # reads it lazily; left stale it would point a Sister's hand-off at the folder the
                # desktop opened first.
                os.environ["MISAKA_WORKSPACE"] = workspace_path

                mgr = getattr(session, "sessionManager", None)
                entries = mgr.buildContextEntries() if mgr is not None and hasattr(mgr, "buildContextEntries") else []
                messages_payload = _serialize_session_entries(entries)
                session_info = _session_started_payload(session)
                handle_event(session_info)
                write_ack(
                    req_id,
                    ok=True,
                    data={
                        "workspace": workspace_path,
                        "session": session_info,
                        "messages": messages_payload,
                    },
                    workspace=workspace_path,
                    session=session_info,
                    messages=messages_payload,
                )
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("list_research_runs", "listresearchruns"):
            con = _open_research_readonly()
            if con is None:
                write_ack(req_id, ok=True, data={"runs": []}, runs=[])
                return
            try:
                from misaka.core.research import runs

                workspace = _research_workspace(obj, session)
                rows = runs.listing(con, workspace=workspace) if workspace else runs.listing(con)
                runs_data = [_serialize_research_run(runs, con, row, session) for row in rows]
                write_ack(req_id, ok=True, data={"runs": runs_data, "workspace": workspace}, runs=runs_data)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))
            finally:
                con.close()

        elif cmd in ("get_research_graph", "getresearchgraph"):
            con = _open_research_readonly()
            if con is None:
                write_ack(req_id, ok=True, data={"run": None, "graph": None})
                return
            try:
                from misaka.core.research import graph, runs

                run_id = obj.get("runId")
                run = runs.get(con, str(run_id)) if run_id else _latest_run_row(runs, con, _research_workspace(obj, session))
                if run is None:
                    write_ack(req_id, ok=True, data={"run": None, "graph": None})
                    return
                data = graph.snapshot(con, run)
                # The snapshot's cards carry no assignee; the desktop shows one, so fold it in
                # from the run's task rows (read-only, no schema change).
                assignee_by_task = {
                    str(t["id"]): t["assignee"] for t in runs.tasks(con, run["id"])
                }
                for node in data.get("nodes", []):
                    for card in node.get("cards", []):
                        card["assignee"] = assignee_by_task.get(str(card.get("id")), None)
                write_ack(req_id, ok=True, data={"run": _serialize_research_run(runs, con, run, session),
                                                 "graph": data})
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))
            finally:
                con.close()

        elif cmd in ("export_session", "exportsession"):
            path = obj.get("path")
            output = obj.get("output")
            if not path:
                write_ack(req_id, ok=False, error="export_session requires 'path'")
                return
            try:
                from misaka.core.session_export import export_session_to_jsonl

                manager = SessionManager.open(str(path))
                written = export_session_to_jsonl(manager, str(output) if output else None)
                write_ack(req_id, ok=True, data={"path": written})
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("check_update", "checkupdate"):
            try:
                result = await asyncio.to_thread(_check_update_status)
                write_ack(req_id, ok=True, data=result)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("new_session", "newsession"):
            try:
                new_options: dict[str, Any] = {"carryOverContext": bool(obj.get("carryOverContext", False))}
                if obj.get("cwd"):
                    new_options["cwd"] = obj["cwd"]
                result = await runtime_host.newSession(new_options)
                if read_field(result, "cancelled"):
                    write_ack(req_id, ok=False, error="New session cancelled")
                    return
                session_info = _session_started_payload(session)
                handle_event(session_info)
                write_ack(req_id, ok=True, data={"session": session_info}, session=session_info)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("rename_session", "renamesession"):
            path = obj.get("path")
            name = obj.get("name")
            if not path or not isinstance(name, str) or not name.strip():
                write_ack(req_id, ok=False, error="rename_session requires 'path' and 'name'")
                return
            try:
                current_file = session.sessionFile
                is_active = bool(current_file) and os.path.realpath(str(current_file)) == os.path.realpath(str(path))
                if is_active:
                    session.setSessionName(name.strip())
                else:
                    manager = SessionManager.open(str(path))
                    manager.appendSessionInfo(name.strip())
                write_ack(req_id, ok=True)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("delete_session", "deletesession"):
            path = obj.get("path")
            if not path:
                write_ack(req_id, ok=False, error="delete_session requires 'path'")
                return
            try:
                current_file = session.sessionFile
                if current_file and os.path.realpath(str(current_file)) == os.path.realpath(str(path)):
                    write_ack(req_id, ok=False, error="Cannot delete the active session")
                    return
                resolved = os.path.realpath(str(path))
                if not os.path.isfile(resolved):
                    write_ack(req_id, ok=False, error=f"Session file not found: {resolved}")
                    return
                os.remove(resolved)
                write_ack(req_id, ok=True)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("fork_session", "forksession"):
            entry_id = obj.get("entryId")
            try:
                if entry_id:
                    result = await runtime_host.fork(str(entry_id), {"position": obj.get("position", "before")})
                else:
                    result = await runtime_host.newSession({"parentSession": session.sessionFile})
                if read_field(result, "cancelled"):
                    write_ack(req_id, ok=False, error="Fork cancelled")
                    return
                session_info = _session_started_payload(session)
                handle_event(session_info)
                mgr = getattr(session, "sessionManager", None)
                entries = mgr.buildContextEntries() if mgr is not None and hasattr(mgr, "buildContextEntries") else []
                messages_payload = _serialize_session_entries(entries)
                write_ack(
                    req_id,
                    ok=True,
                    data={"session": session_info, "messages": messages_payload},
                    messages=messages_payload,
                )
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("set_theme", "settheme"):
            name = obj.get("name")
            if not name:
                write_ack(req_id, ok=False, error="set_theme requires 'name'")
                return
            try:
                colors = _get_desktop_theme_colors(name)
                sm = getattr(session, "settingsManager", None)
                if sm is not None and hasattr(sm, "setTheme"):
                    sm.setTheme(name)
                write_ack(req_id, ok=True, data=colors, colors=colors)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("get_providers", "getproviders"):
            try:
                known_providers = set(BUILT_IN_PROVIDER_DISPLAY_NAMES.keys())
                reg = getattr(session, "modelRegistry", None)
                oauth_provider_ids = set()
                if reg is not None:
                    for m in reg.getAll():
                        known_providers.add(m.provider)
                    for p in reg.getProviders():
                        known_providers.add(p.id)
                    oauth_provider_ids = {p.id for p in reg.getOAuthProviders()}

                providers_list = []
                for pid in sorted(known_providers):
                    display_name = reg.getProviderDisplayName(pid) if reg else BUILT_IN_PROVIDER_DISPLAY_NAMES.get(pid, pid)
                    status = reg.getProviderAuthStatus(pid) if reg else None
                    is_configured = bool(status and (status.configured or status.source))
                    providers_list.append({
                        "id": pid,
                        "name": display_name,
                        "configured": is_configured,
                        "source": getattr(status, "source", None) or "",
                        "label": getattr(status, "label", None) or "",
                        "isOAuth": pid in oauth_provider_ids,
                    })
                write_ack(req_id, ok=True, data=providers_list, providers=providers_list)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("get_provider_groups", "getprovidergroups"):
            try:
                reg = getattr(session, "modelRegistry", None)
                groups = build_provider_groups(reg)
                visible = visible_provider_ids()
                write_ack(
                    req_id,
                    ok=True,
                    data={"groups": groups, "visibleProviderIds": visible},
                    groups=groups,
                    visibleProviderIds=visible,
                )
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("get_custom_providers", "getcustomproviders"):
            try:
                path = _resolve_models_json_path(session)
                providers, load_error = load_custom_providers(path)
                drafts = [
                    _serialize_custom_provider(str(provider_id), config)
                    for provider_id, config in providers.items()
                ]
                write_ack(
                    req_id,
                    ok=True,
                    data={"providers": drafts, "path": path, "error": load_error},
                    providers=drafts,
                )
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("upsert_custom_provider", "upsertcustomprovider"):
            provider_id = obj.get("providerId")
            if not provider_id:
                write_ack(req_id, ok=False, error="providerId is required")
                return
            try:
                path = _resolve_models_json_path(session)
                draft = {
                    "providerId": provider_id,
                    "name": obj.get("name"),
                    "baseUrl": obj.get("baseUrl"),
                    "api": obj.get("api") or obj.get("apiFormat"),
                    "apiKey": obj.get("apiKey"),
                    "headers": obj.get("headers"),
                    "models": obj.get("models"),
                }
                error = upsert_custom_provider(path, draft)
                if error:
                    write_ack(req_id, ok=False, error=error)
                    return
                reg = getattr(session, "modelRegistry", None)
                if reg is not None and hasattr(reg, "refresh"):
                    await reg.refresh()
                providers, load_error = load_custom_providers(path)
                refreshed = [
                    _serialize_custom_provider(str(pid), config)
                    for pid, config in providers.items()
                ]
                write_ack(
                    req_id,
                    ok=True,
                    data={"providers": refreshed, "path": path, "error": load_error},
                    providers=refreshed,
                )
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("delete_custom_provider", "deletecustomprovider"):
            provider_id = obj.get("providerId")
            if not provider_id:
                write_ack(req_id, ok=False, error="providerId is required")
                return
            try:
                path = _resolve_models_json_path(session)
                removed = remove_custom_provider(path, str(provider_id))
                reg = getattr(session, "modelRegistry", None)
                if reg is not None and hasattr(reg, "refresh"):
                    await reg.refresh()
                providers, load_error = load_custom_providers(path)
                refreshed = [
                    _serialize_custom_provider(str(pid), config)
                    for pid, config in providers.items()
                ]
                write_ack(
                    req_id,
                    ok=True,
                    data={"removed": removed, "providers": refreshed, "path": path, "error": load_error},
                    providers=refreshed,
                )
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("test_provider_connectivity", "testproviderconnectivity"):
            provider_id = obj.get("providerId")
            if not provider_id:
                write_ack(req_id, ok=False, error="providerId is required")
                return
            try:
                result = await _test_model_connectivity(session, str(provider_id), obj.get("modelId"))
                if result.get("ok"):
                    write_ack(req_id, ok=True, data=result)
                else:
                    write_ack(req_id, ok=False, error=str(result.get("error") or "connectivity test failed"), data=result)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("reorder_custom_providers", "reordercustomproviders"):
            order = obj.get("order")
            if not isinstance(order, list) or not all(isinstance(item, str) for item in order):
                write_ack(req_id, ok=False, error="order must be a list of provider ids")
                return
            try:
                path = _resolve_models_json_path(session)
                reorder_custom_providers(path, [str(item) for item in order])
                providers, load_error = load_custom_providers(path)
                refreshed = [
                    _serialize_custom_provider(str(pid), config)
                    for pid, config in providers.items()
                ]
                write_ack(
                    req_id,
                    ok=True,
                    data={"providers": refreshed, "path": path, "error": load_error},
                    providers=refreshed,
                )
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("fetch_remote_models", "fetchremotemodels"):
            base_url = obj.get("baseUrl")
            if not base_url:
                write_ack(req_id, ok=False, error="baseUrl is required")
                return
            try:
                api_key = obj.get("apiKey")
                provider_id = obj.get("providerId")
                if (not api_key or not str(api_key).strip()) and provider_id:
                    path = _resolve_models_json_path(session)
                    existing_providers, _ = load_custom_providers(path)
                    if str(provider_id) in existing_providers:
                        existing_entry = existing_providers[str(provider_id)]
                        if isinstance(existing_entry, dict) and existing_entry.get("apiKey"):
                            api_key = existing_entry.get("apiKey")
                models, err = await fetch_remote_models(
                    base_url=str(base_url),
                    api_format=str(obj.get("api") or obj.get("apiFormat") or "openai-completions"),
                    api_key=api_key,
                    headers=obj.get("headers"),
                )
                if err:
                    write_ack(req_id, ok=False, error=err, models=[])
                else:
                    write_ack(req_id, ok=True, data={"models": models}, models=models)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("get_models", "getmodels"):
            try:
                reg = getattr(session, "modelRegistry", None)
                models_list = []
                if reg is not None:
                    for m in reg.getAll():
                        has_auth = reg.hasConfiguredAuth(m)
                        custom_ids = _custom_model_ids(session, m.provider)
                        models_list.append({
                            "id": m.id,
                            "name": m.name or m.id,
                            "provider": m.provider,
                            "api": getattr(m, "api", ""),
                            "reasoning": bool(getattr(m, "reasoning", False)),
                            "input": list(m.input) if getattr(m, "input", None) else ["text"],
                            "contextWindow": getattr(m, "contextWindow", 0),
                            "maxTokens": getattr(m, "maxTokens", 0),
                            "configured": has_auth,
                            "thinkingLevelMap": getattr(m, "thinkingLevelMap", None) or {},
                            "source": "custom" if m.id in custom_ids else "builtin",
                        })

                models_list.sort(key=lambda m: (str(m.get("name") or m.get("id") or "")).lower())

                current_model_info = None
                cur = getattr(session, "model", None)
                if cur is not None:
                    current_model_info = {
                        "provider": cur.provider,
                        "modelId": cur.id,
                        "name": cur.name or cur.id,
                        "thinking": getattr(session, "thinkingLevel", "off"),
                    }

                sm = getattr(session, "settingsManager", None)
                default_provider = sm.getDefaultProvider() if sm else None
                default_model = sm.getDefaultModel() if sm else None

                payload = {
                    "models": models_list,
                    "currentModel": current_model_info,
                    "defaultProvider": default_provider,
                    "defaultModel": default_model,
                }
                write_ack(req_id, ok=True, data=payload, **payload)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("get_config", "getconfig"):
            try:
                sm = getattr(session, "settingsManager", None)
                mgr = getattr(session, "sessionManager", None)
                cwd = getattr(session, "_cwd", None) or (mgr.getCwd() if mgr else os.getcwd())
                product_cfg = current_config()
                cfg_data = {
                    "cwd": cwd,
                    "agentDir": get_agent_dir(),
                    "authPath": get_auth_path(),
                    "sessionsDir": get_sessions_dir(),
                    "theme": (sm.getTheme() if sm else "dark") or "dark",
                    "defaultProvider": sm.getDefaultProvider() if sm else None,
                    "defaultModel": sm.getDefaultModel() if sm else None,
                    "defaultThinkingLevel": sm.getDefaultThinkingLevel() if sm else "off",
                    "product": product_cfg,
                }
                write_ack(req_id, ok=True, data=cfg_data, config=cfg_data)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("set_default_model", "setdefaultmodel"):
            provider = obj.get("provider")
            model_id = obj.get("modelId") or obj.get("model")
            if not provider or not model_id:
                write_ack(req_id, ok=False, error="provider and modelId required")
                return
            try:
                sm = getattr(session, "settingsManager", None)
                if sm is not None:
                    sm.setDefaultModelAndProvider(provider, model_id)
                    write_ack(req_id, ok=True)
                else:
                    write_ack(req_id, ok=False, error="Session has no settings manager")
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("get_thinking_levels", "getthinkinglevels"):
            try:
                levels = session.getAvailableThinkingLevels() if hasattr(session, "getAvailableThinkingLevels") else ["off"]
                supports = session.supportsThinking() if hasattr(session, "supportsThinking") else False
                current_level = getattr(session, "thinkingLevel", "off")
                payload = {
                    "levels": levels,
                    "supportsThinking": supports,
                    "current": current_level,
                }
                write_ack(req_id, ok=True, data=payload, **payload)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("set_provider_credential", "setprovidercredential"):
            provider = obj.get("provider")
            api_key = obj.get("apiKey") or obj.get("key")
            if not provider or not api_key:
                write_ack(req_id, ok=False, error="provider and apiKey required")
                return
            try:
                reg = getattr(session, "modelRegistry", None)
                if reg and hasattr(reg, "authStorage"):
                    reg.authStorage.set(provider, {"type": "api_key", "key": api_key})
                    write_ack(req_id, ok=True)
                else:
                    write_ack(req_id, ok=False, error="Session has no auth storage")
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("delete_provider_credential", "deleteprovidercredential"):
            provider = obj.get("provider")
            if not provider:
                write_ack(req_id, ok=False, error="provider required")
                return
            try:
                reg = getattr(session, "modelRegistry", None)
                if reg and hasattr(reg, "authStorage"):
                    reg.authStorage.remove(provider)
                    write_ack(req_id, ok=True)
                else:
                    write_ack(req_id, ok=False, error="Session has no auth storage")
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("refresh_models", "refreshmodels"):
            try:
                reg = getattr(session, "modelRegistry", None)
                if reg and hasattr(reg, "refresh"):
                    await reg.refresh()
                    write_ack(req_id, ok=True)
                else:
                    write_ack(req_id, ok=True)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("get_settings_section", "getsettingssection"):
            section = obj.get("section")
            if not section:
                write_ack(req_id, ok=False, error="section required")
                return
            try:
                sm = getattr(session, "settingsManager", None)
                sec_data = sm.getSection(section) if sm else {}
                write_ack(req_id, ok=True, data=sec_data, section=sec_data)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("set_setting", "setsetting"):
            section = obj.get("section")
            key = obj.get("key")
            val = obj.get("value")
            if not section or not key:
                write_ack(req_id, ok=False, error="section and key required")
                return
            try:
                sm = getattr(session, "settingsManager", None)
                if sm:
                    def _mutate(target: dict) -> None:
                        target[key] = val
                    sm.updateSection(section, _mutate)
                    write_ack(req_id, ok=True)
                else:
                    write_ack(req_id, ok=False, error="Session has no settings manager")
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("set_cwd", "setcwd"):
            new_cwd = obj.get("path") or obj.get("cwd")
            if not new_cwd or not os.path.isdir(str(new_cwd)):
                write_ack(req_id, ok=False, error=f"Invalid directory path: {new_cwd}")
                return
            try:
                resolved = os.path.realpath(str(new_cwd))
                os.chdir(resolved)
                setattr(session, "_cwd", resolved)
                manager = getattr(session, "sessionManager", None)
                if manager is not None and hasattr(manager, "setCwd"):
                    manager.setCwd(resolved)
                write_ack(req_id, ok=True, data={"cwd": resolved}, cwd=resolved)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("set_default_thinking_level", "setdefaultthinkinglevel"):
            level = obj.get("level")
            if not level:
                write_ack(req_id, ok=False, error="level is required")
                return
            try:
                sm = getattr(session, "settingsManager", None)
                if sm is not None and hasattr(sm, "setDefaultThinkingLevel"):
                    sm.setDefaultThinkingLevel(str(level))
                    write_ack(req_id, ok=True)
                else:
                    write_ack(req_id, ok=False, error="Session has no settings manager")
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("get_diagnostics", "getdiagnostics"):
            try:
                import platform
                import shutil
                reg = getattr(session, "modelRegistry", None)
                models_count = len(reg.getAll()) if reg else 0
                configured_count = len([m for m in reg.getAll() if reg.hasConfiguredAuth(m)]) if reg else 0
                manager = getattr(session, "sessionManager", None)
                session_dir = manager.getSessionDir() if manager and hasattr(manager, "getSessionDir") else None
                root = sessions_root_of(session_dir) or get_sessions_dir()
                session_files_count = 0
                if os.path.isdir(root):
                    session_files_count = len([f for f in os.listdir(root) if f.endswith(".jsonl")])
                cur_cwd = getattr(session, "_cwd", None) or os.getcwd()
                cwd_writable = os.access(cur_cwd, os.W_OK)

                diagnostics_data = {
                    "pythonVersion": platform.python_version(),
                    "platform": f"{platform.system()} {platform.release()} ({platform.machine()})",
                    "uvPath": shutil.which("uv") or "not found",
                    "cwd": cur_cwd,
                    "cwdWritable": cwd_writable,
                    "modelsTotal": models_count,
                    "modelsConfigured": configured_count,
                    "sessionFilesCount": session_files_count,
                    "agentDir": get_agent_dir(),
                    "authPath": get_auth_path(),
                    "sessionsDir": root,
                    "bridgeStatus": "connected",
                    "timestamp": time.time(),
                }
                write_ack(req_id, ok=True, data=diagnostics_data, **diagnostics_data)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("shutdown", "exit", "quit"):
            write_ack(req_id, ok=True)
            stop_event.set()

        else:
            write_ack(req_id, ok=False, error=f"Unknown command: {cmd_type}")
    async def process_line(line: str) -> None:
        try:
            obj = json.loads(line)
        except Exception as error:  # noqa: BLE001
            write_ack(None, ok=False, error=f"Invalid JSON: {error}")
            return

        if not isinstance(obj, dict):
            write_ack(None, ok=False, error="Command must be a JSON object")
            return

        await dispatch_command(obj)

    async def stdin_reader() -> None:
        while not stop_event.is_set():
            try:
                line = await asyncio.to_thread(sys.stdin.readline)
            except Exception:  # noqa: BLE001
                break
            if line == "":
                # EOF reached on stdin
                if active_prompt_task and not active_prompt_task.done():
                    try:
                        await active_prompt_task
                    except Exception:  # noqa: BLE001, S110
                        pass
                stop_event.set()
                break
            stripped = line.strip()
            if not stripped:
                continue
            await process_line(stripped)

    reader_task: asyncio.Task[None] | None = None
    try:
        register_signal_handlers()
        runtime_host.setRebindSession(rebind_session)
        await rebind_session()

        reader_task = loop.create_task(stdin_reader())
        await stop_event.wait()
        return 0
    except Exception as error:  # noqa: BLE001
        print(f"Bridge error: {error}", file=sys.stderr)
        return 1
    finally:
        if reader_task and not reader_task.done():
            reader_task.cancel()
        for current_signal, previous_handler in signal_cleanup_handlers:
            signal.signal(current_signal, previous_handler)
        await dispose_runtime()
        await flushRawStdout()
        if took_over and isStdoutTakenOver():
            restoreStdout()


def main(args: Any = None) -> int:
    """Entry point for desktop bridge CLI command."""
    from misaka.windows_bootstrap import apply_windows_utf8_bootstrap

    apply_windows_utf8_bootstrap()
    _clean_broken_local_proxies()

    cwd = getattr(args, "cwd", None) or os.getcwd()
    flags: list[str] = ["--mode", "json"]
    if getattr(args, "no_session", False):
        flags.append("--no-session")
    if getattr(args, "session", None):
        flags.extend(["--session", str(args.session)])
    if getattr(args, "theme", None):
        theme_str = str(args.theme)
        if theme_str.endswith(".json") or os.path.exists(theme_str):
            flags.extend(["--theme", theme_str])
        else:
            flags.extend(["--use-theme", theme_str])

    from misaka.core.platform.session import open_session
    from misaka.core.wiring import role_session_setup

    # Without the role assembly this is a bare engine session: no Parts, so no ResearchPart and no
    # /research command, and no TOOL_MODULES, so no misaka_research_* and no doc_* -- the desktop
    # would be talking to an unnamed model that cannot act. Model comes from the role setup, so it
    # is not repeated here; a second --model would leave the last one silently winning.
    profile_dir = os.path.join(current_config()["roles_root"], "last_order")
    role_flags, assembly, role_env = role_session_setup(
        profile_dir, cwd, model=getattr(args, "model", None),
        receive_messages=False, research_context=False)
    os.environ.update(role_env)
    flags = role_flags + flags

    async def _run() -> int:
        runtime, _session, error = await open_session(flags, cwd, assembly)
        if error:
            print(f"Error opening bridge session: {error}", file=sys.stderr)
            if runtime is not None:
                await runtime.dispose()
            return 1
        return await run_desktop_bridge(runtime, {"cwd": cwd})

    try:
        return asyncio.run(_run())
    except Exception as error:  # noqa: BLE001
        print(f"Bridge runtime fatal error: {error}", file=sys.stderr)
        return 1


__all__ = ["main", "run_desktop_bridge"]
