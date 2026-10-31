"""Desktop bridge for JSONL stdio communication with Electron frontend."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import time
import uuid
from collections import deque
from typing import Any

from misaka.ai.models import getSupportedThinkingLevels as get_supported_thinking_levels
from misaka.cli.desktop_attachments import prepare_attachments
from misaka.config import get_agent_dir, get_auth_path, get_sessions_dir, home
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
from misaka.core.research import submissions
from misaka.core.research.ingress import (
    ResearchMessageIngress,
    normalize_research_command,
    parse_research_control,
    render_research_command,
    research_command_body,
    session_run,
    split_research_command,
)
from misaka.core.session_manager import (
    SessionInfo,
    SessionManager,
    encode_cwd,
    session_entry_to_display_messages,
    sessions_root_of,
)
from misaka.core.session_manager import (
    findMostRecentSession as find_most_recent_session,
)
from misaka.core.session_manager import (
    readSessionHeader as read_session_header,
)
from misaka.modes.interactive.theme.theme import (
    getResolvedThemeColors as get_resolved_theme_colors,
)
from misaka.modes.interactive.theme.theme import (
    loadThemeJson as load_theme_json,
)
from misaka.modes.json_event import to_jsonable
from misaka.modes.json_event import toJsonEvent as to_json_event
from misaka.utils.shell import killTrackedDetachedChildren
from misaka.utils.values import read_field


def research_start_prompt(question: str, limits: dict[str, Any] | None = None) -> str:
    """Validate the backend-owned limits and create the ResearchPart's slash-command input."""
    from misaka.core.research import runs

    if not isinstance(question, str) or not question.strip():
        raise ValueError("A research question is required.")
    raw = dict(limits or {})
    approval = raw.pop("plan_approval", None)
    if approval is not None and not isinstance(approval, bool):
        raise ValueError("plan_approval must be a boolean")
    chosen = runs.normalize_limits(raw)
    flags = (
        ("--depth", "max_depth"), ("--parallel", "parallel"),
        ("--sister-parallel", "sister_parallel"), ("--followups", "max_followups"),
        ("--revisions", "max_revisions"), ("--max-nodes", "max_nodes"),
    )
    options = " ".join(f"{flag} {chosen[key]}" for flag, key in flags)
    for flag, key in (("--context-threshold", "context_threshold"), ("--max-output-tokens", "max_output_tokens")):
        if key in chosen:
            options += f" {flag} {chosen[key]}"
    if approval is None:
        from misaka.core.research import planner
        approval = planner.plan_waits_for_user(current_config())
    policy = "required" if approval else "automatic"
    return f"/research {options} --plan-approval {policy} -- {question.strip()}"


def research_options_payload(config: dict[str, Any] | None = None) -> dict[str, Any]:
    """Expose the research engine's own limits/defaults to the workbench form."""
    from misaka.core.research import options as research_options
    from misaka.core.research import planner, runs

    cfg = config if config is not None else current_config()
    sisters = planner.sister_catalog(cfg.get("profiles_root"))
    return {
        "questions": research_options.questions(cfg),
        "defaults": {**runs.DEFAULT_LIMITS, "context_threshold": None, "max_output_tokens": None,
                     "plan_approval": planner.plan_waits_for_user(cfg)},
        "constraints": {"max_depth": {"min": 0, "max": 12},
                        "max_nodes": {"min": 1, "max": runs.MAX_NODES_CEILING},
                        "parallel": {"min": 1}, "sister_parallel": {"min": 1},
                        "max_followups": {"min": 0, "max": 6},
                        "max_revisions": {"min": 0, "max": 6},
                        "context_threshold": {"min": runs.MIN_CONTEXT_THRESHOLD, "max": runs.MAX_CONTEXT_THRESHOLD},
                        "max_output_tokens": {"min": 1024}},
        "sisters": [{"id": str(item["id"]), "name": str(item.get("name") or item["id"]),
                     "description": str(item.get("description") or "")}
                    for item in sisters],
    }


async def recover_research_report(session: Any, con: Any = None) -> str | None:
    """The get_host/reconnect lane asks its owning native part to settle the report outbox."""
    for part in getattr(getattr(session, 'moments', None), 'parts', ()):
        recover = getattr(part, 'recover_final_report', None)
        if recover is not None and getattr(part, 'session', None) is session:
            return await recover(con)
    return None


def research_host_payload(session: Any, con: Any = None, *, last_event_seq: int = 0,
                          stream_id: str | None = None) -> dict[str, Any]:
    """The live coordinator's root transcript, not a board/artifact projection."""
    from misaka.core.research.wiring.research import ResearchPart

    manager = session.sessionManager
    entries = manager.buildContextEntries() if hasattr(manager, "buildContextEntries") else []
    path = getattr(manager, "sessionFile", None)
    version = (_history_version(path) if path and os.path.isfile(path)
               else f"{session.sessionId}:{getattr(manager, 'getLeafId', lambda: None)()}:{len(entries)}")
    run = session_run(session, con)
    from misaka.core.research.delivery import snapshot as delivery_snapshot
    report_delivery = delivery_snapshot(con, run['id']) if con is not None and run is not None else None
    return {"reportDelivery": report_delivery, "enabled": any(isinstance(part, ResearchPart) for part in session.moments.parts),
            "session": _session_started_payload(session),
            "stats": to_jsonable(session.getSessionStats()),
            "contextUsage": to_jsonable(session.getContextUsage()),
            "isStreaming": bool(getattr(session, "isStreaming", False)),
            "isIdle": bool(getattr(session, "isIdle", not getattr(session, "isStreaming", False))),
            "messages": _serialize_session_entries(entries, submission_entries=submissions.entries(session)), "historyVersion": version,
            "submissionReceipts": submissions.public_receipts(session),
            "lastEventSeq": last_event_seq, **({"streamId": stream_id} if stream_id else {}),
            "run": {"id": run["id"], "status": run["status"], "phase": run["phase"]} if run is not None else None}

# Commands that must not run while a session tree or compaction operation owns the session.
# The filter modes the tree setting accepts; mirrors the TUI's valid set.
TREE_FILTER_MODES = ("default", "no-tools", "user-only", "labeled-only", "all")

SESSION_OPERATION_GUARDED_COMMANDS = frozenset({
    "prompt", "steer", "follow_up", "followup", "set_model", "setmodel",
    "set_thinking", "setthinking", "load_session", "loadsession",
    "switch_workspace", "switchworkspace", "set_workspace", "setworkspace",
    "new_session", "newsession", "fork_session", "forksession",
    "send_research_message", "sendresearchmessage",
})

RESEARCH_SESSION_MUTATING_COMMANDS = frozenset({
    "prompt", "steer", "follow_up", "followup",
    "set_model", "setmodel", "set_thinking", "setthinking",
    "fork_session", "forksession", "navigate_tree", "compact_session",
})

# Aliases collapse so the guard reads one name per capability.
SESSION_COMMAND_ALIASES = {
    "followup": "follow_up",
    "setmodel": "set_model",
    "setthinking": "set_thinking",
    "loadsession": "load_session",
    "switchworkspace": "switch_workspace",
    "setworkspace": "switch_workspace",
    "newsession": "new_session",
    "forksession": "fork_session",
}

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
        **({'desktopResearch': True} if getattr(s, 'desktopResearch', False) else {}),
        "fileRevision": _history_version(s.path) if os.path.isfile(s.path) else None,
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


def _serialize_session_entries(entries: list[Any], *, submission_entries: list[Any] | None = None) -> list[dict[str, Any]]:
    """Turn persisted entries into stable, ordered desktop timeline messages.

    Assistant ``blocks`` retain the persisted content order and raw content indices. Tool results
    are folded into the canonical tool-call object shared by both ``blocks`` and the legacy
    ``toolCalls`` projection, so old consumers and ordered renderers cannot disagree after reopen.
    """
    messages: list[dict[str, Any]] = []
    original_inputs = {row['requestId']: row['input'] for row in submissions.receipts_from_entries(
                       entries if submission_entries is None else submission_entries)
                       if isinstance(row.get('input'), dict)}
    tool_calls_by_id: dict[str, dict[str, Any]] = {}
    unresolved_tool_calls: dict[str, dict[str, Any]] = {}

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
                images = [
                    to_jsonable(block)
                    for block in (read_field(message, "content") if isinstance(read_field(message, "content"), list) else [])
                    if read_field(block, "type") == "image"
                ]
                messages.append({
                    "id": message_id,
                    "entryId": entry_id,
                    "role": "user",
                    "content": _content_text(read_field(message, "content")),
                    **({'requestId': read_field(message, 'requestId')} if read_field(message, 'requestId') else {}),
                    **({"images": images} if images else {}),
                    "timestamp": timestamp,
                })
            elif role == "assistant":
                content = read_field(message, "content")
                blocks: list[dict[str, Any]] = []

                # Old or hand-written histories can contain a plain assistant string. It is still
                # one persisted content position, not a synthetic projection outside ``blocks``.
                source_blocks = [content] if isinstance(content, str) else content
                if isinstance(source_blocks, list):
                    for content_index, block in enumerate(source_blocks):
                        block_id = f"{message_id}:block:{content_index}"
                        if isinstance(block, str):
                            blocks.append({
                                "type": "text",
                                "id": block_id,
                                "contentIndex": content_index,
                                "text": block,
                                "isStreaming": False,
                            })
                            continue

                        block_type = read_field(block, "type")
                        if block_type == "text":
                            text = str(read_field(block, "text") or "")
                            blocks.append({
                                "type": "text",
                                "id": block_id,
                                "contentIndex": content_index,
                                "text": text,
                                "isStreaming": False,
                            })
                        elif block_type == "thinking":
                            thinking = str(read_field(block, "thinking") or "")
                            blocks.append({
                                "type": "thinking",
                                "id": block_id,
                                "contentIndex": content_index,
                                "thinking": thinking,
                                "isStreaming": False,
                            })
                        elif block_type == "toolCall":
                            tool_call_id = str(read_field(block, "id") or f"{message_id}-tc-{content_index}")
                            arguments = read_field(block, "arguments")
                            tool_call = {
                                "id": tool_call_id,
                                "name": str(read_field(block, "name") or "tool"),
                                "arguments": to_jsonable(arguments) if arguments is not None else {},
                                # A persisted call has not succeeded until its matching result says so.
                                "status": "pending",
                            }
                            tool_calls_by_id[tool_call_id] = tool_call
                            unresolved_tool_calls[tool_call_id] = tool_call
                            blocks.append({
                                "type": "toolCall",
                                "id": block_id,
                                "contentIndex": content_index,
                                "toolCall": tool_call,
                            })

                # Compatibility fields are projections of the canonical ordered blocks, not a
                # second interpretation of persisted content.
                text_parts = [block["text"] for block in blocks if block["type"] == "text"]
                thinking_parts = [
                    block["thinking"] for block in blocks if block["type"] == "thinking"
                ]
                tool_calls = [
                    block["toolCall"] for block in blocks if block["type"] == "toolCall"
                ]
                serialized: dict[str, Any] = {
                    "id": message_id,
                    "entryId": entry_id,
                    "role": "assistant",
                    "content": "".join(text_parts),
                    "blocks": blocks,
                    "timestamp": timestamp,
                }
                thinking_text = "".join(thinking_parts)
                if thinking_text:
                    serialized["thinking"] = thinking_text
                if tool_calls:
                    serialized["toolCalls"] = tool_calls

                stop_reason = read_field(message, "stopReason")
                if stop_reason is not None:
                    serialized["stopReason"] = stop_reason
                error_message = read_field(message, "errorMessage")
                if error_message is not None:
                    serialized["errorMessage"] = error_message

                usage = read_field(message, "usage")
                if isinstance(usage, dict) or hasattr(usage, "input"):
                    serialized["tokens"] = {
                        "input": read_field(usage, "input"),
                        "output": read_field(usage, "output"),
                        "total": read_field(usage, "totalTokens"),
                    }
                messages.append(serialized)

                # A durable failed/aborted reply closes every execution still open in this turn.
                # A truncated history without either terminal reason stays pending; a later matching
                # tool result still overwrites cancellation with its authoritative outcome.
                if stop_reason in {"aborted", "error"}:
                    for pending in unresolved_tool_calls.values():
                        pending["status"] = "cancelled"
            elif role == "custom":
                details = read_field(message, "details")
                if read_field(message, "customType") == "research-input":
                    messages.append({"id": message_id, "entryId": entry_id, "role": "user",
                        "content": _content_text(read_field(message, "content")), "timestamp": timestamp,
                        "requestId": read_field(details, "requestId"), "researchRunId": read_field(details, "run_id")})
                    continue
                messages.append({
                    "id": message_id,
                    "entryId": entry_id,
                    "role": "custom",
                    "customType": str(read_field(message, "customType") or ""),
                    "content": _content_text(read_field(message, "content")),
                    # The engine decides what the feed shows; the desktop must not decide again.
                    "display": bool(read_field(message, "display")),
                    "details": to_jsonable(details) if details is not None else {},
                    "timestamp": timestamp,
                })
            elif role == "toolResult":
                tool_call_id = str(read_field(message, "toolCallId") or "")
                tool_call = tool_calls_by_id.get(tool_call_id)
                if tool_call is not None:
                    is_error = bool(read_field(message, "isError"))
                    result_content = read_field(message, "content")
                    tool_call["status"] = "error" if is_error else "success"
                    tool_call["result"] = to_jsonable(result_content)
                    details = read_field(message, "details")
                    if details is not None:
                        tool_call["details"] = to_jsonable(details)
                    result_error = read_field(message, "error")
                    if result_error is None:
                        result_error = read_field(message, "errorMessage")
                    if result_error is None and is_error:
                        result_error = _content_text(result_content)
                    if result_error is not None:
                        tool_call["error"] = str(result_error)
                    unresolved_tool_calls.pop(tool_call_id, None)

    for message in messages:
        request_id = message.get('requestId') or (message.get('details') or {}).get('requestId')
        original = original_inputs.get(request_id)
        if original is not None and (message.get('role') == 'user'
                                    or message.get('customType') in {'research-question', 'research-input'}):
            message['researchSubmission'] = {key: original[key] for key in
                ('text', 'sessionId', 'requestId', 'runId', 'limits', 'startNew') if key in original}
    from misaka.desktop_research.recruitment import project_history
    return project_history(messages, entries if submission_entries is None else submission_entries)

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



def _navigated_session_snapshot(session: Any, owner_session_id: str | None) -> dict[str, Any]:
    """Fresh projection for an operation that already reported done.

    Read through the session the operation started on, so a switch that happened mid-flight is
    detected instead of reporting another session's messages under this request id.
    """
    manager = getattr(session, "sessionManager", None)
    if manager is None or owner_session_id != getattr(session, "sessionId", None):
        return {}

    snapshot: dict[str, Any] = {}
    get_leaf = getattr(manager, "getLeafId", None)
    if callable(get_leaf):
        snapshot["leafId"] = get_leaf()
    session_file = getattr(session, "sessionFile", None)
    if session_file and os.path.isfile(str(session_file)):
        snapshot["historyVersion"] = _history_version(str(session_file))
    build_context = getattr(manager, "buildContextEntries", None)
    if callable(build_context):
        snapshot["messages"] = _serialize_session_entries(build_context())
    return snapshot


def _serialize_session_tree(node: Any) -> dict[str, Any]:
    """One SessionTreeNode as plain JSON, children first-class.

    Entries go through to_jsonable so an entry that carries a non-serializable value degrades
    to a string instead of failing the whole tree read.
    """
    children = getattr(node, "children", None) or []
    return {
        "entry": to_jsonable(getattr(node, "entry", None)),
        "label": getattr(node, "label", None),
        "labelTimestamp": getattr(node, "labelTimestamp", None),
        "children": [_serialize_session_tree(child) for child in children],
    }


def _session_tree_payload(session: Any) -> dict[str, Any]:
    """The whole branch structure plus the settings both front ends share.

    Kept cheap: this is re-read after every navigation, so it only stats the session file.
    """
    manager = getattr(session, "sessionManager", None)
    get_tree = getattr(manager, "getTree", None) if manager is not None else None
    if not callable(get_tree):
        raise TypeError("Session tree is unavailable")

    tree = [_serialize_session_tree(node) for node in (get_tree() or [])]
    session_file = getattr(session, "sessionFile", None) or getattr(manager, "getSessionFile", lambda: None)()
    history_version = None
    if session_file and os.path.isfile(str(session_file)):
        history_version = _history_version(str(session_file))

    settings_manager = getattr(session, "settingsManager", None)
    tree_filter_mode = None
    skip_prompt = None
    if settings_manager is not None:
        read_filter = getattr(settings_manager, "getTreeFilterMode", None)
        if callable(read_filter):
            tree_filter_mode = read_filter()
        read_skip = getattr(settings_manager, "getBranchSummarySkipPrompt", None)
        if callable(read_skip):
            skip_prompt = bool(read_skip())

    get_leaf = getattr(manager, "getLeafId", None)
    return {
        "sessionId": getattr(session, "sessionId", None),
        "sessionFile": session_file,
        "historyVersion": history_version,
        "leafId": get_leaf() if callable(get_leaf) else None,
        "tree": tree,
        "settings": {"treeFilterMode": tree_filter_mode, "branchSummarySkipPrompt": skip_prompt},
    }


def _session_operation_payload(
    operation: str,
    status: str,
    *, error: str | None = None,
    editor_text: str | None = None,
    summary_entry: Any = None,
    compaction: Any = None,
    **snapshot: Any,
) -> dict[str, Any]:
    """The terminal report for one long session operation; absent keys stay absent.

    The desktop correlates this by requestId, so the shape must not drift between statuses.
    ``snapshot`` carries whatever the finished operation produced (messages, leafId, and so on)
    and is passed through only when it has a value.
    """
    payload: dict[str, Any] = {"operation": operation, "status": status}
    if error:
        payload["error"] = error
    if editor_text:
        payload["editorText"] = editor_text
    if summary_entry is not None:
        payload["summaryEntry"] = to_jsonable(summary_entry)
    if compaction is not None:
        payload["compaction"] = compaction
    for key, value in snapshot.items():
        if value is not None:
            payload[key] = to_jsonable(value)
    return payload
def _history_version(path: str) -> str:
    stat = os.stat(path)
    return f"{stat.st_mtime_ns}:{stat.st_size}"


def _preview_session(path: str) -> tuple[dict[str, Any], list[dict[str, Any]], str, float, float]:
    """Inspect the target without opening a writable manager or starting extensions."""
    started = time.perf_counter()
    before_version = _history_version(path)
    manager = SessionManager.openInMemory(path)
    info = {
        "type": "session_started", "sessionId": manager.getSessionId(),
        "cwd": manager.getCwd(), "name": manager.getSessionName(),
        "file": os.path.realpath(path), "permissionMode": "default",
    }
    file_ms = round((time.perf_counter() - started) * 1000, 3)
    started = time.perf_counter()
    messages = _serialize_session_entries(manager.buildContextEntries())
    history_ms = round((time.perf_counter() - started) * 1000, 3)
    after_version = _history_version(path)
    # A concurrent append during reading/projection means this preview is not a
    # snapshot of either durable revision. Force the ready ACK to send fresh history.
    version = before_version if before_version == after_version else f"unstable:{uuid.uuid4().hex}"
    return info, messages, version, file_ms, history_ms


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


def _read_research_session_query(obj: dict[str, Any], workspace: str | None) -> Any:
    """Open/read/close on the I/O worker; large histories never block the model event loop."""
    from misaka.core.research import desktop_view, runs
    con = _open_research_readonly()
    try:
        run_id = str(obj.get("runId") or "")
        run = runs.get(con, run_id) if con is not None else None
        if run is None or os.path.normcase(os.path.realpath(run["workspace"])) != os.path.normcase(os.path.realpath(workspace or "")):
            raise ValueError("No research run matches this project.")
        if obj["type"] == "get_research_sessions":
            result = desktop_view.sessions_payload(con, run_id)
        elif obj["type"] == "get_research_session_history":
            result = desktop_view.session_history(con, run_id, str(obj.get("executorId") or ""), cursor=obj.get("cursor"), limit=obj.get("limit") or 50)
        else:
            result = desktop_view.session_content(con, run_id, str(obj.get("executorId") or ""), str(obj.get("entryId") or ""),
                field=obj.get("field") or "content", offset=obj.get("offset") or 0, limit=obj.get("limit") or desktop_view.EXECUTION_PREVIEW_BYTES)
        if result is None:
            raise ValueError("No execution instance belongs to this research run.")
        return result
    finally:
        if con is not None:
            con.close()


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


def find_session_active_research_run(con: Any, session_path: str | None) -> dict[str, Any] | None:
    """Returns the active research run row if session_path belongs to one."""
    if not session_path:
        return None
    from misaka.config import home
    from misaka.core.research import runs

    target = os.path.normcase(os.path.realpath(str(session_path)))
    for run in runs.listing(con):
        if run["status"] not in runs.ACTIVE:
            continue
        candidates = [run["root_session"]]
        candidates.extend(node["session_file"] for node in runs.nodes(con, run["id"]))
        if any(value and os.path.normcase(os.path.realpath(str(home.from_stored(value)))) == target
               for value in candidates):
            return dict(run)
    return None


def session_belongs_to_active_research(con: Any, session_path: str | None) -> bool:
    """True when editing this transcript could change the context of a live research driver."""
    return find_session_active_research_run(con, session_path) is not None


def find_root_session_research_run(con: Any, session_path: str | None,
                                   workspace: str | None, *, status: str | None = None) -> dict[str, Any] | None:
    """Find the run owned by this exact root transcript and workspace.

    This intentionally differs from the mutation guard above: node transcripts
    must stay protected, but prose typed into one must never resume the root.
    """
    if not session_path or not workspace:
        return None
    from misaka.config import home
    from misaka.core.research import runs

    target = os.path.normcase(os.path.realpath(str(session_path)))
    project = os.path.normcase(os.path.realpath(str(workspace)))
    for run in runs.listing(con):
        if status is not None and run["status"] != status:
            continue
        root = run["root_session"]
        if not root:
            continue
        root_path = os.path.normcase(os.path.realpath(str(home.from_stored(root))))
        run_workspace = os.path.normcase(os.path.realpath(str(home.from_stored(run["workspace"]))))
        if root_path == target and run_workspace == project:
            return dict(run)
    return None


def find_research_prompt_replay(con: Any, session: Any, request_id: Any) -> dict[str, Any] | None:
    """A root clarification remains replayable after its resume makes the run active."""
    if not isinstance(request_id, str) or not request_id:
        return None
    receipt = submissions.lookup(session, request_id)
    if receipt is None or receipt.get('mode') != 'resume':
        return None
    manager = getattr(session, 'sessionManager', None)
    owned = find_root_session_research_run(con, getattr(manager, 'sessionFile', None),
                                          _research_workspace({}, session))
    return owned if owned and receipt.get('runId') == owned['id'] else None


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

    # v0.19 stores ownership and driver leases in the graph backing this run.
    # Read through the run projection even when the caller passed a raw SQL row.
    row = runs.get(con, str(row["id"])) or row
    summary = runs.summary(con, str(row["id"])) or {"id": str(row["id"])}
    summary["question"] = row["question"]
    summary["createdAt"] = row["created_at"]
    summary["updatedAt"] = row["updated_at"]

    lock = row["driver_lock"]
    expires = row["driver_expires"]
    # Share the stop/recovery and lease takeover rule: an expired/dead owner is resumable now.
    driving = runs.driver_is_live(row)
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
    runtime_path = getattr(getattr(registry, "modelRuntime", None), "_modelsPath", None)
    if isinstance(runtime_path, str) and runtime_path:
        return runtime_path
    for attribute in ("_modelsJsonPath", "modelsJsonPath"):
        candidate = getattr(registry, attribute, None)
        if isinstance(candidate, str) and candidate:
            return candidate
    from misaka.config import home

    return str(home.path("models"))


def _custom_model_ids(session: Any, provider_id: str) -> set[str]:
    """Model ids this provider declares in models.json, used to tag them as custom."""
    providers, error = load_custom_providers(_resolve_models_json_path(session))
    entry = providers.get(provider_id, {}) if not error else {}
    if isinstance(entry, dict):
        return {str(model["id"]) for model in entry.get("models", []) if isinstance(model, dict) and model.get("id")}
    return set()


def _thinking_state(session: Any) -> dict[str, Any]:
    """The thinking ladder the session actually holds, after any clamping.

    The desktop paints the level the user asked for before the reply lands. Without the
    resolved state in the ack it can sit on a level the model does not offer:
    ``setThinkingLevel`` clamps silently, and a model switch may resolve a level of its
    own from the role or per-model default tables.
    """
    levels = (
        session.getAvailableThinkingLevels()
        if hasattr(session, "getAvailableThinkingLevels")
        else ["off"]
    )
    supports = session.supportsThinking() if hasattr(session, "supportsThinking") else False
    result = {
        "level": getattr(session, "thinkingLevel", "off"),
        "levels": list(levels),
        "supportsThinking": bool(supports),
    }
    model = getattr(session, "model", None)
    if model is not None and hasattr(model, "baseUrl") and hasattr(model, "reasoning"):
        from misaka.ai.thinking_compat import thinking_capability
        capability = thinking_capability(model)
        result["thinkingCapability"] = capability
        result["levels"] = capability["levels"]
    return result


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


def _ordinary_model_network_context(session: Any) -> tuple[str, dict[str, str] | None]:
    """Current chat model endpoint and already-loaded env, with no auth operation."""
    model = getattr(session, "model", None)
    endpoint = str(getattr(model, "baseUrl", None) or "")
    env = None
    registry = _model_registry_of(session)
    storage = getattr(registry, "authStorage", None)
    provider = getattr(model, "provider", None)
    runtime_overrides = getattr(storage, "runtimeOverrides", {}) if storage is not None else {}
    loaded_api_key = runtime_overrides.get(provider)
    stored = None
    if storage is not None and provider and not runtime_overrides.get(provider):
        stored = getattr(getattr(storage, "readState", None), "data", {}).get(provider)
        if isinstance(stored, dict):
            if stored.get("type") == "api_key":
                loaded_api_key = stored.get("key")
            candidate = stored.get("env")
            if isinstance(candidate, dict):
                env = {str(key): str(value) for key, value in candidate.items()}
            if stored.get("type") == "oauth" and provider == "github-copilot":
                from misaka.ai.auth.oauth.github_copilot import _getBaseUrlFromToken
                endpoint = _getBaseUrlFromToken(stored.get("access", "")) or endpoint
    if not endpoint and getattr(model, "api", None) == "openai-codex-responses":
        from misaka.ai.api.openai_codex_responses import (
            _resolveCodexUrl as resolve_codex_url,
        )

        endpoint = resolve_codex_url(endpoint)
    api = getattr(model, "api", None)
    if api in {"google-generative-ai", "google-vertex"}:
        from misaka.ai.utils.google_endpoint import resolve_google_endpoint

        # Match the adapter's actual constructor branch, without resolving auth:
        # express API keys use global; ADC uses the process location, not env
        # stored on a credential (resolve_location currently does not read it).
        location = os.environ.get("GOOGLE_CLOUD_LOCATION") or "global"
        if api == "google-vertex":
            from misaka.ai.api.google_vertex import _resolveApiKey as resolve_api_key
            from misaka.core.resolve_config_value import (
                isCommandConfigValue as is_command_config_value,
            )
            from misaka.core.resolve_config_value import (
                resolveConfigValue as resolve_config_value,
            )

            # Registry auth gives a configured key priority over ambient auth only
            # when neither a runtime override nor a stored credential owns it.
            # Expand non-command templates in memory to apply the stream's
            # placeholder/marker filtering; never execute a configured command.
            if not loaded_api_key and stored is None:
                providers, _ = load_custom_providers(_resolve_models_json_path(session))
                config = providers.get(provider, {})
                raw_key = config.get("apiKey") if isinstance(config, dict) else None
                if isinstance(raw_key, str):
                    loaded_api_key = raw_key if is_command_config_value(raw_key) else resolve_config_value(raw_key)

            if resolve_api_key({"apiKey": loaded_api_key}):
                location = "global"
        endpoint = resolve_google_endpoint(endpoint, vertexai=api == "google-vertex", location=location)
    return endpoint, env


def _proxy_settings_snapshot(session: Any, settings: Any = None) -> dict[str, Any]:
    from misaka.ai.utils.network_route import resolve_network_route
    from misaka.config.proxy_settings import (
        get_proxy_settings,
        proxy_request_env,
        validate_proxy_settings,
    )

    policy = validate_proxy_settings(settings) if settings is not None else get_proxy_settings()
    endpoint, provider_env = _ordinary_model_network_context(session)
    result: dict[str, Any] = {"settings": policy, "route": None}
    if not endpoint:
        return result
    try:
        effective_env = proxy_request_env(provider_env, settings=policy)
        result["route"] = resolve_network_route(endpoint, effective_env).public_details()
    except ValueError as error:
        result["routeError"] = str(error)
    return result


async def _test_model_connectivity(session: Any, provider_id: str, model_id: str | None) -> dict[str, Any]:
    """Send one tiny real request through the registry's own auth and stream path.

    This is the same seam ``misaka setup model`` verifies with: resolve auth, then ask the
    provider for a couple of tokens. The error text separates an unreachable endpoint (a
    transport error) from a rejected credential (the provider answered with an auth error).
    """
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
        reply = await registry.streamSimple(
            model,
            Context(messages=[UserMessage(content="Reply with the single word OK.", timestamp=0)]),
            SimpleStreamOptions(
                maxTokens=8,
            ),
        ).result()
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


def _serialize_event(seq_num: int, session_id: str, raw_event: Any, *, stream_id: str | None = None) -> str:
    payload = {
        "seq": seq_num,
        "sessionId": session_id,
        "event": _safe_to_json_event(raw_event),
        **({"streamId": stream_id} if stream_id else {}),
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
    session = runtime_host.session
    unsubscribe = None
    unsubscribe_backpressure = None
    disposed = False
    signal_cleanup_handlers: list[tuple[int, Any]] = []
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    seq = 0
    stream_id = uuid.uuid4().hex
    prompt_tasks: set[asyncio.Task[None]] = set()
    preparing_prompts: dict[asyncio.Task[None], Any] = {}
    prompt_preflight_lock = asyncio.Lock()
    research_ingress = ResearchMessageIngress(session)
    research_controller = None
    research_observers = {}
    desktop_research = bool(read_field(options, "desktop_research") or getattr(session, "research_host", False))
    desktop_tasks: set[asyncio.Task[None]] = set()
    research_input_tasks: set[asyncio.Task[None]] = set()
    took_over = False
    pending_permissions: dict[str, asyncio.Future[Any]] = {}
    pending_permission_tool_names: dict[str, str] = {}
    commands: deque[tuple[str, float] | None] = deque()
    commands_available = asyncio.Event()
    # One long session operation at a time, so a command never interleaves with a navigation or
    # a compaction and cancellation stays unambiguous.
    session_operation: dict[str, Any] | None = None
    session_operation_task: asyncio.Task[None] | None = None

    def begin_session_operation(operation: str, request_id: str | None) -> bool:
        nonlocal session_operation
        if session_operation is not None:
            return False
        session_operation = {
            "requestId": request_id,
            "operation": operation,
            "sessionId": getattr(session, "sessionId", None),
        }
        return True

    def end_session_operation(request_id: str | None = None) -> None:
        nonlocal session_operation
        if request_id is not None and session_operation is not None and session_operation.get("requestId") != request_id:
            return
        session_operation = None

    def session_operation_blocks(command: str) -> bool:
        """Whether this command must wait for the running session operation to finish."""
        if session_operation is None:
            return False
        return command in SESSION_OPERATION_GUARDED_COMMANDS

    def track_session_operation_task(task: asyncio.Task[None]) -> None:
        """Keep a strong reference so a long operation is not collected mid-flight."""
        nonlocal session_operation_task
        session_operation_task = task
    def report_session_operation(
        operation: str,
        status: str,
        *,
        request_id: str | None = None,
        session_id: str | None = None,
        **payload: Any,
    ) -> None:
        """Emit the one terminal event the desktop waits for, for this session only."""
        if session_id is None or session_id != getattr(session, "sessionId", None):
            return
        handle_event({
            "type": "session_operation_end",
            "requestId": request_id,
            "sessionId": session_id,
            **_session_operation_payload(operation, status, **payload),
        })


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
        except Exception:  # noqa: BLE001 - failed permission resolves as denied
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
        line = _serialize_event(seq, session.sessionId, research_ingress.event(event), stream_id=stream_id)
        writeRawStdout(line)
        message = read_field(event, "message")
        if (research_controller is not None and read_field(event, "type") == "message_end"
                and read_field(message, "customType") in {
                    "research-progress", "research-final", "research-error", "research-clarification"}):
            # Board facts are projected after genuine native phase progress,
            # not fabricated from the coordinator's prose or role definitions.
            seq += 1
            writeRawStdout(_serialize_event(seq, session.sessionId, {
                "type": "message_end", "message": {"role": "custom", "customType": "desktop-team",
                    "display": False, "content": "", "details": research_controller.snapshot()}},
                stream_id=stream_id))

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
        for observer in tuple(research_observers.values()):
            await observer.close()
        research_observers.clear()
        for task in tuple(desktop_tasks):
            task.cancel()
        if desktop_tasks:
            await asyncio.gather(*tuple(desktop_tasks), return_exceptions=True)
        if research_controller is not None:
            await research_controller.close()
        await runtime_host.dispose()

    async def rebind_session(_session: Any = None) -> None:
        nonlocal session, unsubscribe, unsubscribe_backpressure, prompt_preflight_lock, research_ingress, research_controller
        session = runtime_host.session
        research_ingress = ResearchMessageIngress(session)
        end_session_operation()
        # A new session never waits on input hooks still preparing in the retired owner.
        prompt_preflight_lock = asyncio.Lock()

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
        if desktop_research:
            from misaka.desktop_research.runtime import DesktopResearchController

            if research_controller is not None and research_controller.session is not session:
                await research_controller.close()
                research_controller = None
            if research_controller is None:
                session.research_host = True

                def emit_team(payload):
                    kind = payload.get("type", "desktop-team")
                    handle_event({"type": "message_end", "message": {
                        "role": "custom", "customType": kind, "display": False,
                        "content": "", "details": payload}})

                research_controller = DesktopResearchController(session, emit_team)
                research_controller.attach()
            research_ingress = research_controller.ingress

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
    async def dispatch_command(obj: dict[str, Any], queued_at: float | None = None) -> None:
        queue_ms = round((time.perf_counter() - queued_at) * 1000, 3) if queued_at is not None else 0.0
        req_id = obj.get("requestId")
        cmd_type = obj.get("type") or obj.get("command") or obj.get("action")
        if not cmd_type and "text" in obj and "path" not in obj:
            cmd_type = "prompt"

        if not cmd_type:
            write_ack(req_id, ok=False, error="Missing command type")
            return

        cmd = str(cmd_type).lower()
        if cmd in RESEARCH_SESSION_MUTATING_COMMANDS:
            manager = getattr(session, "sessionManager", None)
            candidates = [getattr(manager, "sessionFile", None), obj.get("path"), obj.get("sessionPath")]
            text = str(obj.get("text") or "")
            research_board = _open_research_readonly()
            try:
                active_owner = (next((value for value in candidates
                                      if value and research_board is not None
                                      and session_belongs_to_active_research(research_board, value)), None))
                waiting_root_prompt = bool(
                    cmd == "prompt" and active_owner and text.strip() and not text.lstrip().startswith("/")
                    and research_board is not None and (find_root_session_research_run(
                        research_board, getattr(manager, "sessionFile", None),
                        _research_workspace({}, session), status="waiting_input")
                        or find_research_prompt_replay(research_board, session, req_id)))
            finally:
                if research_board is not None:
                    research_board.close()
            if active_owner:
                keyword = split_research_command(text) if cmd == "prompt" else None
                research_control = keyword is not None and keyword[0] in {"stop", "resume", "status", "help"}
                if not research_control and not waiting_root_prompt:
                    write_ack(req_id, ok=False,
                              error="Stop the owning research run before editing, forking, navigating, or compacting this conversation.")
                    return
        if session_operation_blocks(SESSION_COMMAND_ALIASES.get(cmd, cmd)):
            write_ack(
                req_id,
                ok=False,
                error="Finish or cancel the session operation first",
            )
            return

        if cmd in ("desktop_set_team_model", "desktop_retain_roles"):
            if research_controller is None:
                write_ack(req_id, ok=False, error="Desktop team commands require the independent research host.")
                return
            if obj.get("sessionId") != session.sessionId:
                write_ack(req_id, ok=False, error="The original research coordinator changed; reopen its conversation.")
                return

            async def run_team_command() -> None:
                con = None
                try:
                    if cmd == "desktop_set_team_model":
                        result = await research_controller.set_team_model(
                            obj.get("provider"), obj.get("modelId"), obj.get("action", "switch"), role=obj.get("role", "all"))
                    else:
                        if not isinstance(obj.get("selections"), list):
                            raise ValueError("Role retention requires an explicit selections list.")
                        con = _open_research_readonly()
                        owned = session_run(session, con)
                        if obj.get("runId") and (owned is None or owned["id"] != obj["runId"]):
                            raise ValueError("The selected research does not belong to this coordinator.")
                        result = await research_controller.retain_roles(obj["selections"], req_id, con)
                    write_ack(req_id, ok=True, data=result)
                except Exception as error:  # noqa: BLE001 - correlated desktop command failure
                    write_ack(req_id, ok=False, error=str(error),
                              data=research_controller.snapshot())
                finally:
                    if con is not None:
                        con.close()

            task = loop.create_task(run_team_command())
            desktop_tasks.add(task)
            task.add_done_callback(desktop_tasks.discard)
            # The next Cancel command must reach a barrier waiting on live requests.
            await asyncio.sleep(0)
            return

        if cmd == "prepare_attachments":
            paths = obj.get("paths")
            if not isinstance(paths, list):
                write_ack(req_id, ok=False, error="prepare_attachments requires a 'paths' array")
                return
            try:
                attachments = await prepare_attachments(paths)
                write_ack(req_id, ok=True, data={"attachments": attachments})
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd == "prompt":
            text = obj.get("text")
            if not isinstance(text, str):
                write_ack(req_id, ok=False, error="prompt requires 'text' string")
                return
            manager = getattr(session, "sessionManager", None)
            session_file = getattr(manager, "sessionFile", None)
            research_board = _open_research_readonly()
            active_run = None
            replay_run = None
            try:
                if research_board is not None and session_file:
                    active_run = find_root_session_research_run(
                        research_board, session_file, _research_workspace({}, session), status="waiting_input")
                    replay_run = find_research_prompt_replay(research_board, session, req_id)
            finally:
                if research_board is not None:
                    research_board.close()

            from misaka.core.research.wiring.research import ResearchPart
            coordinator = any(isinstance(part, ResearchPart)
                              for part in getattr(getattr(session, 'moments', None), 'parts', ()))
            root_reply = active_run or replay_run
            if coordinator and root_reply and text.strip() and not text.lstrip().startswith('/'):
                # Use the same durable ingress as the research transport, rather
                # than a bare slash prompt that can record a clarification twice.
                await dispatch_command({'type': 'send_research_message', 'sessionId': session.sessionId,
                    'runId': root_reply['id'], 'text': text, 'requestId': req_id}, queued_at)
                return

            if active_run and research_command_body(text) is None:
                text = render_research_command("resume", active_run["id"], text.strip())
                obj["text"] = text

            normalized = normalize_research_command(text)
            if normalized is not None:
                text = obj["text"] = normalized
            control_spec = parse_research_control(text)
            if coordinator and research_controller is None and control_spec is not None:
                await dispatch_command({'type': 'send_research_message', 'sessionId': session.sessionId,
                    'runId': control_spec.get('run_id'), 'text': text, 'requestId': req_id}, queued_at)
                return
            if research_controller is not None and research_command_body(text) is not None:
                from misaka.core.research.wiring.research import parse_command
                try:
                    if control_spec is not None:
                        await dispatch_command({"type": "send_research_message", "sessionId": session.sessionId,
                            "runId": control_spec.get("run_id"), "text": text,
                            "requestId": req_id}, queued_at)
                        return
                    specification = parse_command(research_command_body(text))
                    if specification.get("question"):
                        await dispatch_command({"type": "send_research_message", "sessionId": session.sessionId,
                            "text": specification["question"], "limits": specification.get("limits"),
                            "requestId": req_id}, queued_at)
                        return
                except Exception as error:  # noqa: BLE001 - preserve correlated command diagnostics
                    write_ack(req_id, ok=False, error=str(error))
                    return
            images = obj.get("images")
            streaming_behavior = obj.get("streamingBehavior")

            if (session.isStreaming or any(not task.done() for task in prompt_tasks)) and not streaming_behavior:
                write_ack(
                    req_id,
                    ok=False,
                    error="Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
                )
                return

            prompt_session = session
            preflight_lock = prompt_preflight_lock

            async def _run_prompt() -> None:
                acknowledged = False
                owns_preflight = False

                def release_preflight() -> None:
                    nonlocal owns_preflight
                    if owns_preflight:
                        owns_preflight = False
                        preflight_lock.release()

                def acknowledge(ok: bool, error: str | None = None) -> None:
                    nonlocal acknowledged
                    if acknowledged:
                        return
                    acknowledged = True
                    current_task = asyncio.current_task()
                    preparing_prompts.pop(current_task, None)
                    write_ack(req_id, ok=ok, **({"error": error} if error else {}))

                def on_preflight(success: bool) -> None:
                    # A failed preflight raises next; let its exception supply the reason.
                    if success:
                        acknowledge(True)
                        release_preflight()

                try:
                    # Serialize preparation, not the whole run. Otherwise two idle prompts
                    # can both pass isStreaming before the first finishes its async hooks.
                    await preflight_lock.acquire()
                    owns_preflight = True
                    if prompt_session is not session:
                        acknowledge(False, "Session changed before acceptance")
                        return
                    prompt_opts: dict[str, Any] = {"images": images, "preflightResult": on_preflight}
                    if streaming_behavior:
                        prompt_opts["streamingBehavior"] = streaming_behavior
                    await prompt_session.prompt(text, prompt_opts)
                    # Compatibility with session adapters that do not report preflight.
                    acknowledge(True)
                except asyncio.CancelledError:
                    acknowledge(False, "Prompt cancelled before acceptance")
                    raise
                except Exception as exc:  # noqa: BLE001
                    acknowledge(False, str(exc))
                    print(f"Prompt error: {exc}", file=sys.stderr)
                finally:
                    release_preflight()

            task = loop.create_task(_run_prompt())
            prompt_tasks.add(task)
            preparing_prompts[task] = prompt_session
            task.add_done_callback(prompt_tasks.discard)
            # Let prompt preparation begin on its captured owner before a queued
            # replacement can invalidate that owner in the same worker turn.
            await asyncio.sleep(0)

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
            if obj.get('sessionId') is not None and obj['sessionId'] != session.sessionId:
                write_ack(req_id, ok=False, error='研究会话已变更，取消请求未发送到新会话。',
                          errorCode='RESEARCH_SESSION_CHANGED', errorStage='validation', retryable=False,
                          sessionId=session.sessionId, streamId=stream_id)
                return
            if obj.get('streamId') is not None and obj['streamId'] != stream_id:
                write_ack(req_id, ok=False, error='研究连接已变更，取消请求未发送到新连接。',
                          errorCode='RESEARCH_STREAM_CHANGED', errorStage='validation', retryable=False,
                          sessionId=session.sessionId, streamId=stream_id)
                return
            try:
                abort_session = session
                intakes = [task for task in research_input_tasks if not task.done()]
                for task in intakes:
                    task.cancel()
                if intakes:
                    await asyncio.gather(*intakes, return_exceptions=True)
                preparations = [task for task, owner in preparing_prompts.items() if owner is abort_session]
                for task in preparations:
                    task.cancel()
                if preparations:
                    await asyncio.gather(*preparations, return_exceptions=True)
                for fut in list(pending_permissions.values()):
                    if not fut.done():
                        fut.set_result({"approved": False, "reason": "aborted"})
                pending_permissions.clear()
                pending_permission_tool_names.clear()
                await abort_session.abort()
                # A run may have been created just before the renderer received its
                # discipline notice. Cancel that owned startup via the native stop door.
                if research_controller is not None:
                    await research_controller.cancel_startup()
                    con = _open_research_readonly()
                    try:
                        owned = session_run(abort_session, con)
                        if owned and owned['status'] not in {'done', 'stopped', 'failed'}:
                            await research_controller.ingress.send({
                                'sessionId': abort_session.sessionId, 'runId': owned['id'],
                                'text': render_research_command('stop', owned['id']),
                                'requestId': req_id or f'cancel-startup-{uuid.uuid4().hex}'}, con)
                    finally:
                        if con is not None:
                            con.close()
                # Cancelling an idle preflight never enters the engine's run-finally path.
                if preparations and abort_session is session and not abort_session.isStreaming:
                    handle_event({"type": "agent_settled"})
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
                if research_controller is not None:
                    if persist:
                        raise ValueError("Desktop research model selection is task-local; saved role settings stay unchanged.")
                    team_result = await research_controller.set_team_model(provider, model_id)
                    policy = team_result.get("modelBinding", {})
                    if policy.get("state") != "ready":
                        raise RuntimeError(policy.get("error") or "The desktop team model switch is pending.")
                else:
                    await session.setModel(model, {"persist": persist})
                cur = getattr(session, "model", None)
                payload = {
                    **_thinking_state(session),
                    "currentModel": None
                    if cur is None
                    else {
                        "provider": cur.provider,
                        "modelId": cur.id,
                        "name": cur.name or cur.id,
                        "thinking": getattr(session, "thinkingLevel", "off"),
                    },
                }
                write_ack(req_id, ok=True, data=payload, **payload)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("set_thinking", "setthinking"):
            level = obj.get("level")
            if not level:
                write_ack(req_id, ok=False, error="set_thinking requires 'level'")
                return
            try:
                if research_controller is not None and obj.get("role"):
                    payload = await research_controller.set_team_thinking(level, role=obj["role"])
                else:
                    session.setThinkingLevel(level)
                    payload = _thinking_state(session)
                write_ack(req_id, ok=True, data=payload, **payload)
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
            if not os.path.isfile(str(path)):
                write_ack(req_id, ok=False, error=f"Session file not found: {path}")
                return
            try:
                preview = bool(obj.get("preview"))
                timings: dict[str, float] = {"queueMs": queue_ms}
                if preview:
                    preview_info, preview_messages, preview_version, file_ms, history_ms = await asyncio.to_thread(_preview_session, str(path))
                    timings.update(fileMs=file_ms, historyMs=history_ms)
                    handle_event({"type": "session_preview", "requestId": req_id,
                                  "session": preview_info, "messages": preview_messages,
                                  "historyVersion": preview_version})
                started = time.perf_counter()
                result = await runtime_host.switchSession(path)
                timings["runtimeMs"] = round((time.perf_counter() - started) * 1000, 3)
                timings.update({key: value for key, value in getattr(runtime_host, "lastSwitchTimings", {}).items()
                                if isinstance(value, (int, float)) and not isinstance(value, bool)})
                if read_field(result, "cancelled"):
                    write_ack(req_id, ok=False, error="Session switch cancelled", cancelled=True)
                    return
                # switchSession rebinds `session` via rebind_session; read the fresh one.
                mgr = getattr(session, "sessionManager", None)
                started = time.perf_counter()
                version = _history_version(str(path)) if preview else None
                unchanged = preview and version == preview_version
                messages_payload = None if unchanged else _serialize_session_entries(
                    mgr.buildContextEntries() if mgr is not None and hasattr(mgr, "buildContextEntries") else []
                )
                timings["historyMs"] = timings.get("historyMs", 0.0) + round((time.perf_counter() - started) * 1000, 3)
                session_info = _session_started_payload(session)
                session_info["requestId"] = req_id
                handle_event(session_info)
                data = {"session": session_info}
                if preview:
                    data["historyVersion"] = version
                    if unchanged:
                        data["historyUnchanged"] = True
                    else:
                        data["messages"] = messages_payload
                else:
                    data["messages"] = messages_payload
                write_ack(
                    req_id,
                    ok=True,
                    data=data,
                    **({"historyVersion": version, "historyUnchanged": True, "timings": timings}
                       if unchanged else {"messages": messages_payload, **({"historyVersion": version, "timings": timings} if preview else {})}),
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
            if session_path and not os.path.isfile(str(session_path)):
                write_ack(req_id, ok=False, error=f"Session file not found: {session_path}")
                return
            if session_path:
                target_cwd = read_session_header(str(session_path)).get("cwd")
                if not isinstance(target_cwd, str) or os.path.normcase(os.path.realpath(target_cwd)) != os.path.normcase(workspace_path):
                    write_ack(req_id, ok=False, error="Session workspace does not match target workspace")
                    return
            try:
                preview = bool(obj.get("preview"))
                timings = {"queueMs": queue_ms}
                if not session_path:
                    manager = getattr(session, "sessionManager", None)
                    session_dir = manager.getSessionDir() if manager is not None and hasattr(manager, "getSessionDir") else None
                    root = sessions_root_of(session_dir) or get_sessions_dir()
                    started = time.perf_counter()
                    bucket = os.path.join(root, encode_cwd(workspace_path))
                    session_path = await asyncio.to_thread(find_most_recent_session, bucket, workspace_path)
                    if session_path is None:
                        # Legacy flat stores can coexist with cwd buckets.
                        session_path = await asyncio.to_thread(find_most_recent_session, root, workspace_path)
                    timings["fileMs"] = round((time.perf_counter() - started) * 1000, 3)
                if preview and session_path:
                    preview_info, preview_messages, preview_version, file_ms, history_ms = await asyncio.to_thread(_preview_session, str(session_path))
                    timings["fileMs"] = timings.get("fileMs", 0.0) + file_ms
                    timings["historyMs"] = history_ms
                    handle_event({"type": "session_preview", "requestId": req_id,
                                  "session": preview_info, "messages": preview_messages,
                                  "historyVersion": preview_version})
                started = time.perf_counter()
                if session_path:
                    result = await runtime_host.switchSession(str(session_path))
                    if read_field(result, "cancelled"):
                        write_ack(req_id, ok=False, error="Session switch cancelled", cancelled=True)
                        return
                else:
                    new_result = await runtime_host.newSession({"cwd": workspace_path})
                    if read_field(new_result, "cancelled"):
                        write_ack(req_id, ok=False, error="New session cancelled", cancelled=True)
                        return
                timings["runtimeMs"] = round((time.perf_counter() - started) * 1000, 3)
                if session_path:
                    timings.update({key: value for key, value in getattr(runtime_host, "lastSwitchTimings", {}).items()
                                    if isinstance(value, (int, float)) and not isinstance(value, bool)})

                # The role assembly is built once, at process start, so switching the session does
                # not rebuild the Parts with a new workspace. Most read it per call (ResearchPart
                # takes ctx.cwd), but MISAKA_WORKSPACE was captured from the role env and some code
                # reads it lazily; left stale it would point a Sister's hand-off at the folder the
                # desktop opened first.
                os.environ["MISAKA_WORKSPACE"] = workspace_path

                mgr = getattr(session, "sessionManager", None)
                started = time.perf_counter()
                version = (
                    _history_version(str(session_path)) if session_path
                    else f"new:{getattr(session, 'sessionId', '')}"
                ) if preview else None
                unchanged = preview and session_path and version == preview_version
                messages_payload = None if unchanged else _serialize_session_entries(
                    mgr.buildContextEntries() if mgr is not None and hasattr(mgr, "buildContextEntries") else []
                )
                timings["historyMs"] = timings.get("historyMs", 0.0) + round((time.perf_counter() - started) * 1000, 3)
                session_info = _session_started_payload(session)
                session_info["requestId"] = req_id
                handle_event(session_info)
                data = {"workspace": workspace_path, "session": session_info}
                if preview:
                    data["historyVersion"] = version
                if unchanged:
                    data["historyUnchanged"] = True
                else:
                    data["messages"] = messages_payload
                write_ack(
                    req_id,
                    ok=True,
                    data=data,
                    workspace=workspace_path,
                    session=session_info,
                    **({"historyVersion": version, "historyUnchanged": True, "timings": timings}
                       if unchanged else {"messages": messages_payload, **({"historyVersion": version, "timings": timings} if preview else {})}),
                )
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("get_active_research_runs", "getactiveresearchruns"):
            from misaka.core.research import desktop_view

            con = _open_research_readonly()
            active = desktop_view.active_runs(con) if con is not None else []
            if con is not None:
                con.close()
            write_ack(req_id, ok=True, data={"runs": active})

        elif cmd in ("get_research_host", "getresearchhost"):
            con = None
            try:
                await recover_research_report(session)
                con = _open_research_readonly()
                payload = research_host_payload(session, con, last_event_seq=seq, stream_id=stream_id)
                if research_controller is not None:
                    payload.update(research_controller.snapshot())
                write_ack(req_id, ok=True, data=payload)
            except Exception as error:  # noqa: BLE001 - preserve correlated command failures
                write_ack(req_id, ok=False, error=str(error))
            finally:
                if con is not None:
                    con.close()

        elif cmd == 'check_research_connection':
            if obj.get('sessionId') != session.sessionId or (obj.get('streamId') is not None and obj['streamId'] != stream_id):
                write_ack(req_id, ok=False, error='研究连接已变更，请重新打开原研究会话。',
                          errorCode='RESEARCH_STREAM_CHANGED', errorStage='validation', retryable=False,
                          sessionId=session.sessionId, streamId=stream_id)
                return
            try:
                from misaka.ai.utils.network_route import diagnose_connection
                from misaka.desktop_research.recruitment import latest_network_context
                endpoint, environment = latest_network_context(session)
                if not endpoint:
                    raise ValueError('当前模型尚无可检查的连接地址，请先检查模型配置。')
                result = await diagnose_connection(endpoint, environment)
                write_ack(req_id, ok=True, data=result, sessionId=session.sessionId, streamId=stream_id)
            except Exception as error:  # noqa: BLE001 - a diagnostic failure stays on its correlated ACK
                from misaka.desktop_research.recruitment import _clean
                write_ack(req_id, ok=False, error=_clean(session, error),
                          errorCode='RESEARCH_CONNECTION_CHECK_FAILED', errorStage='connection', retryable=True,
                          sessionId=session.sessionId, streamId=stream_id)

        elif cmd in ("send_research_message", "sendresearchmessage"):
            submissions.trace_input(obj, stage='bridge', session_id=session.sessionId, stream_id=stream_id,
                                    model=getattr(session, 'model', None))
            if obj.get('streamId') is not None and obj['streamId'] != stream_id:
                write_ack(req_id, ok=False, error='研究连接已变更，请重新打开原研究会话。',
                          errorCode='RESEARCH_STREAM_CHANGED', errorStage='validation', retryable=False,
                          sessionId=session.sessionId, streamId=stream_id)
                return

            def submission_failure(error):
                submissions.trace_failure(obj, error, session_id=session.sessionId, stream_id=stream_id,
                                          model=getattr(session, 'model', None))
                known = isinstance(error, submissions.ResearchInputError)
                return {'error': str(error) if known else '研究消息暂未接收，请检查连接后重试。',
                        'errorCode': error.errorCode if known else 'RESEARCH_SUBMISSION_FAILED',
                        'errorStage': error.errorStage if known else 'submission',
                        'retryable': error.retryable if known else True,
                        **({'errorDetails': error.errorDetails} if known and error.errorDetails is not None else {}),
                        'sessionId': session.sessionId, 'streamId': stream_id}

            if research_controller is not None:
                async def send_desktop_input() -> None:
                    con = _open_research_readonly()
                    try:
                        payload = await research_controller.send_message(obj, con)
                        write_ack(req_id, ok=True, data=payload, sessionId=session.sessionId, streamId=stream_id)
                    except asyncio.CancelledError:
                        write_ack(req_id, ok=False, error='研究启动已取消，原始问题已保留。',
                                  errorCode='RESEARCH_STARTUP_CANCELLED', errorStage='startup', retryable=True,
                                  sessionId=session.sessionId, streamId=stream_id)
                        raise
                    except Exception as error:  # noqa: BLE001 - true correlated input failures
                        write_ack(req_id, ok=False, **submission_failure(error))
                    finally:
                        if con is not None:
                            con.close()

                task = loop.create_task(send_desktop_input())
                desktop_tasks.add(task)
                research_input_tasks.add(task)
                task.add_done_callback(desktop_tasks.discard)
                task.add_done_callback(research_input_tasks.discard)
                await asyncio.sleep(0)
                return
            con = _open_research_readonly()
            try:
                payload = await research_ingress.send(obj, con)
                write_ack(req_id, ok=True, data=payload, sessionId=session.sessionId, streamId=stream_id)
            except Exception as error:  # noqa: BLE001 - input acceptance is not run creation
                write_ack(req_id, ok=False, **submission_failure(error))
            finally:
                if con is not None:
                    con.close()

        elif cmd in ("get_research_options", "getresearchoptions"):
            try:
                payload = research_options_payload()
                write_ack(req_id, ok=True, data=payload, **payload)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("start_research", "startresearch", "resume_research", "resumeresearch",
                     "stop_research", "stopresearch"):
            from misaka.core.research.wiring.research import ResearchPart

            if research_controller is not None and cmd in ("start_research", "startresearch"):
                await dispatch_command({"type": "send_research_message", "sessionId": session.sessionId,
                    "text": obj.get("question"), "limits": obj.get("limits"), "requestId": req_id}, queued_at)
                return

            if not any(isinstance(part, ResearchPart) for part in getattr(session.moments, "parts", ())):
                write_ack(req_id, ok=False, error="This bridge is not the independent research session.")
                return
            try:
                if cmd in ("start_research", "startresearch"):
                    text = research_start_prompt(obj.get("question"), obj.get("limits"))
                    con = _open_research_readonly()
                    if con is not None:
                        try:
                            from misaka.core.research import runs
                            active = [item for item in runs.listing(con) if item["status"] in runs.ACTIVE]
                            if active:
                                raise ValueError(f"Research run {active[0]['id']} is already active; finish or resume it first.")
                        finally:
                            con.close()
                elif cmd in ("resume_research", "resumeresearch"):
                    run_id = str(obj.get("runId") or "").strip()
                    if not run_id:
                        raise ValueError("resume_research requires runId")
                    clarification = str(obj.get("clarification") or "").strip()
                    text = render_research_command("resume", run_id, clarification)
                else:
                    run_id = str(obj.get("runId") or "").strip()
                    if not run_id:
                        raise ValueError("stop_research requires runId")
                    text = render_research_command("stop", run_id)
                prompt_command = {"type": "prompt", "text": text, "requestId": req_id}
                if cmd not in ("start_research", "startresearch"):
                    # Slash commands are handled before the model turn. Steering lets Stop/Resume
                    # reach that parser even when a plan or report request is currently streaming.
                    prompt_command["streamingBehavior"] = "steer"
                await dispatch_command(prompt_command, queued_at)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("get_research_sessions", "get_research_session_history", "get_research_session_content",
                     "watch_research_sessions", "unwatch_research_sessions"):
            from misaka.core.research import desktop_view, runs
            from misaka.desktop_research.session_observer import ResearchSessionObserver
            if cmd == "unwatch_research_sessions":
                observer = research_observers.pop(str(obj.get("subscriptionId") or ""), None)
                if observer is not None:
                    await observer.close()
                write_ack(req_id, ok=True, data={"stopped": True})
                return
            if cmd != "watch_research_sessions":
                try:
                    payload = await asyncio.to_thread(_read_research_session_query, obj, _research_workspace(obj, session))
                    write_ack(req_id, ok=True, data=payload)
                except Exception as error:  # noqa: BLE001 - send correlated read failure without affecting live agents
                    write_ack(req_id, ok=False, error=str(error))
                return
            con = _open_research_readonly()
            try:
                run_id = str(obj.get("runId") or "")
                run = runs.get(con, run_id) if con is not None else None
                if run is None or os.path.normcase(os.path.realpath(run["workspace"])) != os.path.normcase(
                        os.path.realpath(_research_workspace(obj, session) or "")):
                    raise ValueError("No research run matches this project.")
                if cmd == "watch_research_sessions":
                    root_path = getattr(session.sessionManager, "sessionFile", None)
                    owned = (run["root_session"] and root_path and
                        os.path.normcase(os.path.realpath(str(home.from_stored(run["root_session"])))) ==
                        os.path.normcase(os.path.realpath(root_path)))
                    pending_owner = not run["root_session"] and run["origin_session"] == session.sessionId
                    if not desktop_research or not (owned or pending_owner):
                        raise ValueError("Open the run's original research coordinator before watching live sessions.")
                    visible = obj.get("visibleExecutorIds") or []
                    if not isinstance(visible, list) or len(visible) > 64 or not all(isinstance(v, str) for v in visible):
                        raise ValueError("Invalid visible session identifiers")
                    for old in tuple(research_observers.values()):
                        await old.close()
                    research_observers.clear()
                    observer = ResearchSessionObserver(run_id, _open_research_readonly, handle_event,
                        visible_executor_ids=visible)
                    research_observers[observer.subscription_id] = observer
                    observer.start()
                    payload = {"subscriptionId": observer.subscription_id, "runId": run_id}
                elif cmd == "get_research_sessions":
                    payload = desktop_view.sessions_payload(con, run_id)
                elif cmd == "get_research_session_history":
                    payload = desktop_view.session_history(con, run_id, str(obj.get("executorId") or ""),
                        cursor=obj.get("cursor"), limit=obj.get("limit") or 50)
                else:
                    payload = desktop_view.session_content(con, run_id, str(obj.get("executorId") or ""),
                        str(obj.get("entryId") or ""), field=obj.get("field") or "content",
                        offset=obj.get("offset") or 0, limit=obj.get("limit") or desktop_view.EXECUTION_PREVIEW_BYTES)
                if payload is None:
                    raise ValueError("No execution instance belongs to this research run.")
                write_ack(req_id, ok=True, data=payload)
            except Exception as error:  # noqa: BLE001 - correlated read/control errors cross IPC as acknowledgements
                write_ack(req_id, ok=False, error=str(error))
            finally:
                if con is not None:
                    con.close()

        elif cmd in ("get_research_details", "getresearchdetails"):
            from misaka.core.research import desktop_intervene, desktop_view, runs

            con = _open_research_readonly()
            if con is None:
                write_ack(req_id, ok=True, data={"run": None, "graph": None})
                return
            try:
                run_id = str(obj.get("runId") or "")
                run = runs.get(con, run_id)
                if run is None or os.path.realpath(str(run["workspace"])) != _research_workspace(obj, session):
                    write_ack(req_id, ok=True, data={"run": None, "graph": None})
                    return
                detail = desktop_view.run_detail(con, run_id)
                detail["run"] = _serialize_research_run(runs, con, run, session)
                detail["root_context"] = None
                owner = desktop_intervene.resolve_owner(runs, con, run, session)
                if owner.kind == "remote":
                    from misaka.core import session_control

                    try:
                        detail["root_context"] = await session_control.request(owner.record, "stats")
                    except Exception:  # noqa: BLE001, S110 - a closed owner should not block graph reading
                        pass
                elif owner.kind == "desktop":
                    detail["root_context"] = {
                        "stats": to_jsonable(session.getSessionStats()),
                        "contextUsage": to_jsonable(session.getContextUsage()),
                    }
                write_ack(req_id, ok=True, data=detail)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))
            finally:
                con.close()

        elif cmd in ("get_research_node", "getresearchnode", "get_research_task", "getresearchtask",
                     "get_research_artifact", "getresearchartifact"):
            from misaka.core.research import desktop_intervene, desktop_view, runs

            con = _open_research_readonly()
            if con is None:
                write_ack(req_id, ok=True, data={"detail": None})
                return
            try:
                run_id = str(obj.get("runId") or "")
                run = runs.get(con, run_id)
                if run is None or os.path.realpath(str(run["workspace"])) != _research_workspace(obj, session):
                    write_ack(req_id, ok=True, data={"detail": None})
                    return
                if cmd in ("get_research_node", "getresearchnode"):
                    detail = desktop_view.node_detail(con, run_id, str(obj.get("nodeId") or ""))
                    if detail is not None:
                        _, plan_action = runs.current_plan(con, run_id, str(obj["nodeId"]))
                        detail["plan_tool_call_id"] = plan_action["tool_call_id"] if plan_action else None
                        detail["available_tools"] = await desktop_intervene.published_tools(
                            session, runs, con, run, str(obj["nodeId"]))
                elif cmd in ("get_research_task", "getresearchtask"):
                    detail = desktop_view.task_detail(con, run_id, str(obj.get("taskId") or ""))
                else:
                    detail = desktop_view.artifact_detail(con, run_id, str(obj.get("artifactId") or ""))
                write_ack(req_id, ok=True, data={"detail": detail})
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))
            finally:
                con.close()

        elif cmd in ("get_research_execution", "getresearchexecution"):
            from misaka.core.research import desktop_view, runs

            con = _open_research_readonly()
            if con is None:
                write_ack(req_id, ok=True, data={"execution": {
                    "instances": [], "entries": [], "nextCursor": None, "hasMore": False,
                    "availability": "missing", "reason": "研究板尚未建立，没有可读取的执行记录。"}})
                return
            try:
                run_id = str(obj.get("runId") or "")
                run = runs.get(con, run_id)
                # Same ownership gate as the card itself: an identifier from another research, or
                # from another workspace, reads nothing.
                if run is None or os.path.realpath(str(run["workspace"])) != _research_workspace(obj, session):
                    write_ack(req_id, ok=True, data={"execution": None})
                    return
                execution = desktop_view.execution_detail(
                    con, run_id, str(obj.get("taskId") or ""),
                    instance_id=str(obj["instanceId"]) if obj.get("instanceId") else None,
                    cursor=obj.get("cursor"),
                    limit=obj.get("limit") or desktop_view.EXECUTION_MAX_LIMIT)
                write_ack(req_id, ok=True, data={"execution": execution})
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))
            finally:
                con.close()

        elif cmd in ("control_research", "controlresearch"):
            from misaka.core import session_control
            from misaka.core.research import desktop_intervene, runs

            con = _open_research_write()
            if con is None:
                write_ack(req_id, ok=False, error="No persistent research board is available.")
                return
            try:
                run_id = str(obj.get("runId") or "")
                node_id = obj.get("nodeId")
                action = str(obj.get("action") or "")
                run = runs.get(con, run_id)
                if run is None or os.path.realpath(str(run["workspace"])) != _research_workspace(obj, session):
                    raise ValueError("No research run matches this project.")
                if action in {"approve_plan", "approve_reconcile", "skip_node", "consent"}:
                    payload = dict(obj.get("payload") or {})
                    if action == "approve_plan":
                        _, current_plan = runs.current_plan(con, run_id, str(node_id or ""))
                        expected_plan_id = obj.get("expectedPlanId")
                        if current_plan is None or not expected_plan_id or current_plan["tool_call_id"] != expected_plan_id:
                            raise ValueError("This plan changed since it was displayed. Refresh and review the current version.")
                        payload["expected_plan_id"] = expected_plan_id
                    if action == "approve_reconcile":
                        expected_round = obj.get("expectedRound")
                        pending_rounds = [item for item in runs.reconcile_rounds(con, run_id)
                                          if item["applied_at"] is None]
                        if not expected_round or not pending_rounds or pending_rounds[-1]["round"] != expected_round:
                            raise ValueError("This reconciliation changed since it was displayed. Refresh and review the current version.")
                        payload["expected_reconcile_round"] = expected_round
                    result = await desktop_intervene.invoke(
                        session, runs, con, run_id=run_id, action=action, node_id=node_id,
                        payload=payload, call_id=str(req_id or "desktop"),
                    )
                    write_ack(req_id, ok=True, data=result)
                    return
                owner_node_id = None if action in {"answer_question", "stop", "resume"} else str(node_id) if node_id else None
                owner = desktop_intervene.resolve_owner(runs, con, run, session, owner_node_id)
                if owner.kind == "none":
                    raise ValueError("Open or resume this run's saved Last Order session before sending research input.")
                if action == "return_plan":
                    published = await desktop_intervene.published_tools(session, runs, con, run,
                                                                         str(node_id) if node_id else None)
                    if "misaka_research_assign" not in published:
                        raise ValueError("This plan is no longer waiting for revision.")
                    feedback = str((obj.get("payload") or {}).get("feedback") or "").strip()
                    if not feedback:
                        raise ValueError("Enter revision feedback for this plan.")
                    text = ("The user returned the current research plan with this requested revision. "
                            "Revise and record the complete plan with misaka_research_assign; keep the run waiting "
                            "for explicit approval and do not start its cards. Revision request: " + feedback)
                    result = await session_control.request(owner.record, "input", text=text) if owner.kind == "remote" else None
                    if owner.kind == "desktop":
                        await session.prompt(text)
                        result = {"accepted": True}
                elif action == "answer_question":
                    waiting_nodes = {str(item["id"]) for item in runs.nodes(con, run_id)
                                     if item["status"] == "waiting_input"}
                    if not waiting_nodes or node_id is not None and str(node_id) not in waiting_nodes:
                        raise ValueError("The selected question is no longer waiting for an answer.")
                    answer = str((obj.get("payload") or {}).get("answer") or "").strip()
                    if not answer:
                        raise ValueError("Enter an answer to the pending research question.")
                    text = f"/research resume {run_id} {answer}"
                    result = await session_control.request(owner.record, "input", text=text) if owner.kind == "remote" else None
                    if owner.kind == "desktop":
                        await session.prompt(text)
                        result = {"accepted": True}
                elif action in {"stop", "resume"}:
                    text = f"/research {action} {run_id}"
                    clarification = str((obj.get("payload") or {}).get("clarification") or "").strip()
                    if action == "resume" and clarification:
                        text += " " + clarification
                    result = await session_control.request(owner.record, "input", text=text) if owner.kind == "remote" else None
                    if owner.kind == "desktop":
                        await session.prompt(text)
                        result = {"accepted": True}
                else:
                    raise ValueError(f"Unknown research action: {action}")
                write_ack(req_id, ok=True, data=result or {"accepted": True})
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))
            finally:
                con.close()

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
                from misaka.core.research import runs
                from misaka.core.research import views as graph

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
                from misaka.core.session_export import (
                    exportSessionToJsonl as export_session_to_jsonl,
                )

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
                session_info["requestId"] = req_id
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
                resolved = os.path.realpath(str(path))
                if not os.path.isfile(resolved):
                    write_ack(req_id, ok=False, error=f"Session file not found: {resolved}")
                    return
                current_file = session.sessionFile
                is_active = bool(current_file) and os.path.realpath(str(current_file)) == resolved
                if is_active:
                    active_session = session
                    preparing = any(owner is active_session for owner in preparing_prompts.values())
                    busy = (
                        bool(getattr(active_session, "isStreaming", False))
                        or bool(getattr(active_session, "isAborting", False))
                        or preparing
                        or bool(pending_permissions)
                        or session_operation is not None
                    )
                    if busy:
                        write_ack(req_id, ok=False, error="当前会话仍有任务或会话操作，请先停止后再删除。")
                        return
                    manager = getattr(active_session, "sessionManager", None)
                    workspace = manager.getCwd() if manager is not None and hasattr(manager, "getCwd") else None
                    replacement = await runtime_host.newSession({"cwd": workspace, "carryOverContext": False})
                    if read_field(replacement, "cancelled"):
                        write_ack(req_id, ok=False, error="新会话创建已取消，原会话仍保留。")
                        return
                    if session is active_session:
                        write_ack(req_id, ok=False, error="新会话尚未就绪，原会话仍保留。")
                        return
                    session_info = _session_started_payload(session)
                    session_info["requestId"] = req_id
                    handle_event(session_info)
                    try:
                        os.remove(resolved)
                    except Exception as error:  # noqa: BLE001
                        write_ack(req_id, ok=False, error=str(error),
                                  data={"path": resolved, "session": session_info})
                        return
                    write_ack(req_id, ok=True, data={"path": resolved, "session": session_info})
                    return
                os.remove(resolved)
                write_ack(req_id, ok=True, data={"path": resolved})
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
                session_info["requestId"] = req_id
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

        elif cmd in ("get_session_tree", "getsessiontree"):
            try:
                write_ack(req_id, ok=True, data=_session_tree_payload(session))
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("set_tree_filter_mode", "settreefiltermode"):
            mode = obj.get("mode")
            if mode not in TREE_FILTER_MODES:
                write_ack(req_id, ok=False, error="set_tree_filter_mode requires a known 'mode'")
                return
            try:
                settings_manager = getattr(session, "settingsManager", None)
                setter = getattr(settings_manager, "setTreeFilterMode", None) if settings_manager is not None else None
                if not callable(setter):
                    write_ack(req_id, ok=False, error="Session has no settings manager")
                    return
                setter(str(mode))
                write_ack(req_id, ok=True, data={"mode": str(mode)})
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("set_entry_label", "setentrylabel"):
            target_id = obj.get("targetId") or obj.get("target_id")
            if not target_id:
                write_ack(req_id, ok=False, error="set_entry_label requires 'targetId'")
                return
            if session_operation is not None:
                write_ack(req_id, ok=False, error="Another session operation is in progress")
                return
            raw_label = obj.get("label")
            label = str(raw_label).strip() if isinstance(raw_label, str) and str(raw_label).strip() else None
            try:
                manager = getattr(session, "sessionManager", None)
                append = getattr(manager, "appendLabelChange", None) if manager is not None else None
                if not callable(append):
                    write_ack(req_id, ok=False, error="Session tree is unavailable")
                    return
                append(str(target_id), label)
                timestamps = getattr(manager, "labelTimestampsById", None)
                label_timestamp = None
                if label and isinstance(timestamps, dict):
                    label_timestamp = timestamps.get(str(target_id))
                write_ack(req_id, ok=True, data={"targetId": str(target_id), "label": label, "labelTimestamp": label_timestamp})
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))
        elif cmd in ("navigate_tree", "navigatetree"):
            target_id = obj.get("targetId") or obj.get("target_id")
            if not target_id:
                write_ack(req_id, ok=False, error="navigate_tree requires 'targetId'")
                return
            if not begin_session_operation("navigate_tree", req_id):
                write_ack(req_id, ok=False, error="Another session operation is in progress")
                return

            summarize = bool(obj.get("summarize", False))
            custom_instructions = obj.get("customInstructions")
            if not isinstance(custom_instructions, str):
                custom_instructions = None
            owner_session_id = getattr(session, "sessionId", None)
            write_ack(req_id, ok=True, data={"accepted": True, "operation": "navigate_tree"})
            handle_event({"type": "session_operation_start", "requestId": req_id,
                    "sessionId": owner_session_id, "operation": "navigate_tree"})

            async def _run_navigate() -> None:
                status = "error"
                failure: str | None = None
                editor_text: str | None = None
                summary_entry: Any = None
                try:
                    if bool(getattr(session, "isStreaming", False)):
                        await session.abort()
                    result = await session.navigateTree(str(target_id), {
                        "summarize": summarize,
                        "customInstructions": custom_instructions,
                        "replaceInstructions": obj.get("replaceInstructions"),
                        "label": obj.get("label"),
                    })
                    # An aborted branch summary reports both flags; the abort is the useful one.
                    if read_field(result, "aborted"):
                        status = "aborted"
                    elif read_field(result, "cancelled"):
                        status = "cancelled"
                    else:
                        status = "done"
                        raw_editor = read_field(result, "editorText")
                        if isinstance(raw_editor, str) and raw_editor.strip():
                            editor_text = raw_editor
                        summary_entry = read_field(result, "summaryEntry")
                except asyncio.CancelledError:
                    raise
                except Exception as error:  # noqa: BLE001
                    failure = str(error)
                finally:
                    end_session_operation(req_id)
                    if status == "done" and failure is None:
                        report_session_operation(
                            "navigate_tree", status,
                            request_id=req_id,
                            session_id=owner_session_id,
                            editor_text=editor_text,
                            summary_entry=summary_entry,
                            **_navigated_session_snapshot(session, owner_session_id),
                        )
                    else:
                        report_session_operation(
                            "navigate_tree", status,
                            request_id=req_id,
                            session_id=owner_session_id,
                            error=failure,
                        )

            track_session_operation_task(loop.create_task(_run_navigate()))

        elif cmd in ("compact_session", "compactsession"):
            if not begin_session_operation("compact_session", req_id):
                write_ack(req_id, ok=False, error="Another session operation is in progress")
                return

            custom_instructions = obj.get("customInstructions")
            if not isinstance(custom_instructions, str):
                custom_instructions = None
            owner_session_id = getattr(session, "sessionId", None)
            write_ack(req_id, ok=True, data={"accepted": True, "operation": "compact_session"})
            handle_event({"type": "session_operation_start", "requestId": req_id,
                    "sessionId": owner_session_id, "operation": "compact_session"})

            async def _run_compact() -> None:
                status = "error"
                failure: str | None = None
                compaction: Any = None
                try:
                    result = await session.compact(custom_instructions)
                    status = "done"
                    compaction = to_jsonable(result)
                except asyncio.CancelledError:
                    raise
                except Exception as error:  # noqa: BLE001
                    failure = str(error)
                    if failure == "Compaction cancelled" or read_field(error, "name") == "AbortError":
                        status = "aborted"
                finally:
                    end_session_operation(req_id)
                    if status == "done":
                        report_session_operation(
                            "compact_session", status,
                            request_id=req_id,
                            session_id=owner_session_id,
                            compaction=compaction,
                            **_navigated_session_snapshot(session, owner_session_id),
                        )
                    else:
                        report_session_operation(
                            "compact_session", status,
                            request_id=req_id,
                            session_id=owner_session_id,
                            error=failure,
                        )

            track_session_operation_task(loop.create_task(_run_compact()))

        elif cmd in ("cancel_session_operation", "cancelsessionoperation"):
            active = session_operation
            if active is None:
                write_ack(req_id, ok=False, error="No session operation to cancel")
                return
            requested = obj.get("operationRequestId") or obj.get("operation_id")
            if requested and requested != active.get("requestId"):
                write_ack(req_id, ok=False, error="That session operation is no longer running")
                return
            try:
                if active.get("operation") == "navigate_tree":
                    abort_branch = getattr(session, "abortBranchSummary", None)
                    if callable(abort_branch):
                        abort_branch()
                    if bool(getattr(session, "isStreaming", False)):
                        await session.abort()
                else:
                    abort_compaction = getattr(session, "abortCompaction", None)
                    if callable(abort_compaction):
                        abort_compaction()
                write_ack(req_id, ok=True, data={"cancelled": True})
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
                known_providers = set(visible_provider_ids())
                reg = getattr(session, "modelRegistry", None)
                oauth_provider_ids = set()
                if reg is not None:
                    for m in reg.getAll():
                        known_providers.add(m.provider)
                    runtime = getattr(reg, "modelRuntime", reg)
                    registered = runtime.getProviders()
                    for p in registered:
                        known_providers.add(p.id)
                    oauth_provider_ids = {p.id for p in registered if getattr(getattr(p, "auth", None), "oauth", None) is not None}

                providers_list = []
                for pid in sorted(known_providers):
                    display_name = reg.getProviderDisplayName(pid) if reg else pid
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
                    custom_ids_by_provider: dict[str, set[str]] = {}
                    for m in reg.getAll():
                        has_auth = reg.hasConfiguredAuth(m)
                        if m.provider not in custom_ids_by_provider:
                            custom_ids_by_provider[m.provider] = _custom_model_ids(session, m.provider)
                        custom_ids = custom_ids_by_provider[m.provider]
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
                            # Resolved here rather than in the client: the map has three
                            # distinct meanings (null disables, absent allows, xhigh/max are
                            # opt-in) and mirroring it wrong would put stops on the slider
                            # that the provider then rejects.
                            "thinkingLevels": get_supported_thinking_levels(m),
                            "thinkingCapability": __import__("misaka.ai.thinking_compat", fromlist=["thinking_capability"]).thinking_capability(m),
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

        elif cmd in ("get_proxy_settings", "getproxysettings"):
            try:
                snapshot = _proxy_settings_snapshot(session)
                write_ack(req_id, ok=True, data=snapshot, **snapshot)
            except Exception as error:  # noqa: BLE001 - correlated configuration failure
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("set_proxy_settings", "setproxysettings"):
            try:
                from misaka.config.proxy_settings import validate_proxy_settings

                settings = validate_proxy_settings(obj.get("settings"))
                sm = getattr(session, "settingsManager", None)
                if sm is None:
                    raise RuntimeError("Session has no settings manager")

                def _replace_proxy(target: dict) -> None:
                    target["proxy"] = settings

                sm.updateSection("network", _replace_proxy)
                snapshot = _proxy_settings_snapshot(session)
                write_ack(req_id, ok=True, data=snapshot, **snapshot)
            except Exception as error:  # noqa: BLE001 - failed saves keep the prior object
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("check_proxy_connection", "checkproxyconnection"):
            try:
                from misaka.ai.utils.network_route import diagnose_connection
                from misaka.config.proxy_settings import (
                    get_proxy_settings,
                    proxy_request_env,
                    validate_proxy_settings,
                )

                policy = (
                    validate_proxy_settings(obj["settings"])
                    if obj.get("settings") is not None
                    else get_proxy_settings()
                )
                endpoint, provider_env = _ordinary_model_network_context(session)
                if endpoint:
                    result = await diagnose_connection(
                        endpoint, proxy_request_env(provider_env, settings=policy)
                    )
                else:
                    result = {
                        "route": None,
                        "reachable": False,
                        "check": "tcp",
                        "error": "Current model has no connection endpoint",
                    }
                write_ack(req_id, ok=True, data=result, **result)
            except Exception as error:  # noqa: BLE001 - correlated validation/check failure
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
                payload = _thinking_state(session)
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
                if reg and getattr(reg, "authStorage", None) is not None:
                    from misaka.ai.auth.types import ApiKeyCredential

                    async def replace_credential(_previous):
                        return ApiKeyCredential(key=api_key)

                    await reg.authStorage.modify(provider, replace_credential)
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
                if reg and getattr(reg, "authStorage", None) is not None:
                    await reg.authStorage.delete(provider)
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
                if section == "network" and key == "proxy":
                    from misaka.config.proxy_settings import validate_proxy_settings

                    val = validate_proxy_settings(val)
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
                session._cwd = resolved
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
    async def process_line(line: str, queued_at: float) -> None:
        try:
            obj = json.loads(line)
        except Exception as error:  # noqa: BLE001
            write_ack(None, ok=False, error=f"Invalid JSON: {error}")
            return

        if not isinstance(obj, dict):
            write_ack(None, ok=False, error="Command must be a JSON object")
            return

        await dispatch_command(obj, queued_at)

    async def command_worker() -> None:
        while True:
            await commands_available.wait()
            item = commands.popleft()
            if not commands:
                commands_available.clear()
            if item is None:
                if desktop_tasks:
                    await asyncio.gather(*tuple(desktop_tasks), return_exceptions=True)
                if prompt_tasks:
                    # A steer/follow-up submission can finish before the run it targets.
                    # EOF drains every owner, not merely the latest short queue operation.
                    await asyncio.gather(*tuple(prompt_tasks), return_exceptions=True)
                stop_event.set()
                return
            await process_line(*item)
            if stop_event.is_set():
                return

    async def stdin_reader() -> None:
        while not stop_event.is_set():
            try:
                line = await asyncio.to_thread(sys.stdin.readline)
            except Exception:  # noqa: BLE001
                break
            if line == "":
                commands.append(None)
                commands_available.set()
                break
            stripped = line.strip()
            if not stripped:
                continue
            queued_at = time.perf_counter()
            if commands:
                try:
                    incoming = json.loads(stripped)
                    previous = json.loads(commands[-1][0]) if commands[-1] else None
                    switches = {"load_session", "loadsession", "switch_workspace", "switchworkspace", "set_workspace", "setworkspace"}
                    if (isinstance(incoming, dict) and isinstance(previous, dict)
                            and str(incoming.get("type") or incoming.get("command") or incoming.get("action", "")).lower() in switches
                            and str(previous.get("type") or previous.get("command") or previous.get("action", "")).lower() in switches):
                        commands.pop()
                        write_ack(previous.get("requestId"), ok=False,
                                  error="Superseded by newer switch", cancelled=True)
                except (ValueError, TypeError):
                    pass
            commands.append((stripped, queued_at))
            commands_available.set()

    reader_task: asyncio.Task[None] | None = None
    worker_task: asyncio.Task[None] | None = None
    try:
        register_signal_handlers()
        runtime_host.setRebindSession(rebind_session)
        await rebind_session()

        reader_task = loop.create_task(stdin_reader())
        worker_task = loop.create_task(command_worker())
        await stop_event.wait()
        return 0
    except Exception as error:  # noqa: BLE001
        print(f"Bridge error: {error}", file=sys.stderr)
        return 1
    finally:
        if reader_task and not reader_task.done():
            reader_task.cancel()
        if worker_task and not worker_task.done():
            worker_task.cancel()
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
    from misaka.cli import bootstrap
    bootstrap.install()
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
        receive_messages=False, workflow_context=bool(getattr(args, "research_context", False)),
        research_host=bool(getattr(args, "research_context", False)))
    if getattr(args, "research_context", False):
        from misaka.desktop_research.runtime import prepare_desktop_assembly
        assembly = prepare_desktop_assembly(assembly)
    os.environ.update(role_env)
    flags = role_flags + flags

    async def _run() -> int:
        runtime, _session, error = await open_session(flags, cwd, assembly)
        if error:
            print(f"Error opening bridge session: {error}", file=sys.stderr)
            if runtime is not None:
                await runtime.dispose()
            return 1
        _session.research_host = bool(getattr(args, "research_context", False))
        return await run_desktop_bridge(runtime, {"cwd": cwd, "desktop_research": _session.research_host})

    try:
        return asyncio.run(_run())
    except Exception as error:  # noqa: BLE001
        print(f"Bridge runtime fatal error: {error}", file=sys.stderr)
        return 1


__all__ = ["main", "run_desktop_bridge"]
