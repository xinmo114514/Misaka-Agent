"""Small, on-demand read models for the desktop research workbench."""

from __future__ import annotations

import json
from datetime import datetime
from functools import lru_cache
from pathlib import Path

from misaka.ai.utils.text import content_text
from misaka.config import home
from misaka.core.platform import tasks as task_store
from misaka.core.research import graph, ledger, runs
from misaka.core.session_manager import load_entries_from_file
from misaka.utils.redact import redact
from misaka.utils.values import read_field

# A preview is a window into a record, never the record: 32 KiB per field, 256 KiB per response,
# and a page of at most 100 entries. Longer output is fetched by moving the cursor, not by one
# response that can outgrow the pipe it travels through.
EXECUTION_PREVIEW_BYTES = 32 * 1024
EXECUTION_RESPONSE_BYTES = 256 * 1024
EXECUTION_MAX_LIMIT = 100

_CLOSED_RUN = frozenset({"completed", "closed", "done", "failed", "error", "cancelled", "canceled", "stopped", "skipped"})


def _session_version(path):
    stat = Path(path).stat()
    return f"{stat.st_mtime_ns}:{stat.st_size}"


@lru_cache(maxsize=32)
def _read_session(path, version):
    # The version is part of the cache key. Reading never repairs or appends JSONL.
    return load_entries_from_file(path, strict=True)


def _session_id(path):
    from misaka.core.session_manager import read_session_header
    return read_session_header(path).get("id") if path else None


def _error_detail(con, task):
    details = task.get("last_failure_error") or task.get("block_reason")
    payload = (task_store.latest_payload(con, task["id"], "dispatch_error", generation=task["generation"])
               or task_store.latest_payload(con, task["id"], "failed", generation=task["generation"]))
    if payload:
        try:
            recorded = json.loads(payload)
            details = recorded.get("traceback") or recorded.get("reason") or details
        except (ValueError, AttributeError):
            pass
    return redact(str(details)) if details else None


def session_descriptors(con, run_id):
    """Resolve identifiers only through this run's saved graph and execution rows."""
    run = runs.get(con, str(run_id))
    if run is None:
        return None
    from misaka.core.network.worker import COMPLETION_INSTRUCTIONS
    values = []
    for node in runs.nodes(con, run_id):
        node = dict(node)
        status = run["status"] if node["depth"] == 0 else node["status"]
        succeeded = status in {"done", "completed", "closed"} or node["status"] == "closed"
        path = _resolved_pointer(run["root_session"] if node["depth"] == 0 else node.get("session_file"))
        sid = _session_id(path)
        values.append({"executorId": f"lo:{node['id']}:{sid or 'pending'}", "sessionId": sid,
            "sessionFile": path, "nodeId": node["id"], "taskId": None, "role": "last_order",
            "label": "Last Order" if node["depth"] == 0 else f"Last Order · {node['id']}",
            "workspace": run["workspace"], "status": status,
            "generation": 0, "attempt": 0, "startedAt": node["created_at"] * 1000,
            "endedAt": node["updated_at"] * 1000 if node["status"] in runs.NODE_TERMINAL else None,
            "error": None if succeeded else redact(node.get("last_error") or "") or None})
    for task in runs.tasks(con, run_id):
        task = dict(task)
        instances = execution_instances(con, task["id"])
        current_id = task.get("current_run_id")
        current_generation = int(task["generation"])
        has_current = any(int(instance["generation"]) == current_generation and
                          (instance["instanceId"] == current_id if current_id else instance is instances[-1])
                          for instance in instances)
        if not has_current:
            instances.append({"instanceId": f"card:{task['id']}:g{task['generation']}:pending",
                "sessionFile": None, "generation": task["generation"], "source": "pending",
                "attempt": 0, "startedAt": None, "endedAt": None, "status": task["status"]})
        for instance in instances:
            current = instance.get("source") == "pending" or (
                int(instance["generation"]) == current_generation and
                (instance["instanceId"] == current_id or not current_id and instance is instances[-1]))
            path = instance.get("sessionFile")
            values.append({"executorId": instance["instanceId"], "sessionId": _session_id(path),
                "sessionFile": path, "nodeId": task["branch_id"], "taskId": task["id"], "role": "sister",
                "label": f"research-generalist·{task['id']}", "cardTitle": task["title"],
                "workspace": run["workspace"], "status": task["status"] if current else instance["status"],
                "generation": int(instance["generation"]), "attempt": int(instance["attempt"]),
                "startedAt": instance["startedAt"], "endedAt": instance["endedAt"],
                "error": _error_detail(con, task) if current else instance.get("summary"),
                "contract": (task.get("body") or task["title"]) + COMPLETION_INSTRUCTIONS,
                "isCurrent": current})
    return values


def sessions_payload(con, run_id):
    run = runs.get(con, str(run_id))
    if run is None:
        return None
    descriptors = session_descriptors(con, run_id)
    try:
        from misaka.core.research.suspension import active_suspensions
        halts = active_suspensions(con, run_id)
    except ImportError:
        halts = []
    # The session list answers the same ownership question as the run detail: a run with no live
    # driver can be resumed, one whose lease is still held must never be taken over. Both reads
    # take the value from the board's own lease rule so they cannot disagree.
    summary = {**runs.summary(con, run_id), "question": run["question"],
               "createdAt": run["created_at"] * 1000, "updatedAt": run["updated_at"] * 1000,
               "driverLock": run["driver_lock"], "driverExpires": run["driver_expires"],
               "driving": runs.driver_is_live(run)}
    snapshot = graph.snapshot(con, run)
    # A plan that waits for the user's go-ahead keeps the run `active` while its driver has
    # legitimately finished its turn: the lease is free, but this is a wait, not an interruption.
    # Publishing the wait separately keeps the resume rule ("no live driver" is not enough) honest.
    summary["awaitingApproval"] = any(node["status"] == "awaiting_approval" for node in snapshot["nodes"]) or any(
        not item["applied"] for item in snapshot["reconciles"])
    linked = {task["id"]: task for task in runs.tasks(con, run_id)}
    for node in snapshot["nodes"]:
        round_, plan = runs.current_plan(con, run_id, node["id"])
        node.update(plan_round=round_, plan_tool_call_id=plan["tool_call_id"] if plan else None)
        for card in node.get("cards", []):
            task = linked.get(card["id"])
            if task is not None:
                card.update(local_id=task["local_id"], dependencies=task_store.parent_ids(con, task["id"]))
    return {"runId": str(run_id), "run": summary, "graph": snapshot,
        "sessions": descriptors, "suspensions": halts,
        "suspension": next((item for item in halts if item["scope"] == "run"), None)}


def resolve_session(con, run_id, executor_id):
    return next((item for item in session_descriptors(con, run_id) or []
                 if item["executorId"] == str(executor_id)), None)


def _safe_messages(entries):
    from misaka.cli.desktop_bridge import _serialize_session_entries
    displayed, compactions = [], 0
    for entry in entries:
        if read_field(entry, "type") == "compaction":
            compactions += 1
            displayed.append({"type": "custom_message", "id": read_field(entry, "id"),
                "timestamp": read_field(entry, "timestamp"), "customType": "session-compacted", "display": True,
                "content": f"Session compacted {compactions} times", "details": {"count": compactions}})
        else:
            displayed.append(entry)
    messages = _serialize_session_entries(displayed)
    # Redact the entire structured payload before selecting a preview, including arguments.
    messages = json.loads(redact(json.dumps(messages, ensure_ascii=False, default=str)))
    for message in messages:
        for key in ("content", "thinking", "errorMessage"):
            if isinstance(message.get(key), str):
                message[key], clipped = _preview(message[key])
                if clipped:
                    message[key + "Truncated"] = True
        for block in message.get("blocks", []):
            for key in ("text", "thinking"):
                if isinstance(block.get(key), str):
                    block[key], _ = _preview(block[key])
        for call in message.get("toolCalls", []):
            for key in ("result", "arguments", "error"):
                if call.get(key) is not None:
                    text, clipped = _preview(call[key])
                    if key == "result" or clipped:
                        call[key] = text
                    if clipped:
                        call[key + "Truncated"] = True
        # Canonical blocks and compatibility tool fields must be the same preview.
        calls = {call["id"]: call for call in message.get("toolCalls", [])}
        for block in message.get("blocks", []):
            if block.get("type") == "toolCall" and block.get("toolCall", {}).get("id") in calls:
                block["toolCall"] = calls[block["toolCall"]["id"]]
    return messages


def session_history(con, run_id, executor_id, *, cursor=None, limit=50):
    descriptor = resolve_session(con, run_id, executor_id)
    if descriptor is None:
        return None
    payload = {"runId": str(run_id), "executorId": str(executor_id), "messages": [],
        "nextCursor": None, "hasMore": False, "availability": "not_started", "historyVersion": None,
        "error": descriptor["error"], "telemetry": None}
    path = descriptor["sessionFile"]
    if not path:
        return payload
    if not Path(path).is_file():
        payload["availability"] = "missing"
        return payload
    try:
        version = _session_version(path)
        entries = _read_session(path, version)
        messages = _safe_messages(entries)
    except (OSError, ValueError, TypeError):
        payload["availability"] = "interrupted"
        return payload
    from misaka.core.session_telemetry import entries_telemetry
    payload.update(availability="available", historyVersion=version,
        telemetry=entries_telemetry(entries, cwd=descriptor["workspace"]))
    # Versioned cursors reset after a transcript replacement or branch navigation.
    count = max(1, min(int(limit or 50), EXECUTION_MAX_LIMIT))
    reset = False
    try:
        stored_version, offset = str(cursor).rsplit("@", 1) if cursor else (version, str(len(messages)))
        if stored_version != version:
            reset = True
        end = max(0, min(len(messages), int(offset))) if stored_version == version else len(messages)
    except (ValueError, TypeError):
        reset, end = True, len(messages)
    start = max(0, end - count)
    taken, used = [], 0
    for message in reversed(messages[start:end]):
        size = len(json.dumps(message, ensure_ascii=False).encode())
        if taken and used + size > EXECUTION_RESPONSE_BYTES:
            break
        taken.insert(0, message)
        used += size
    start = end - len(taken)
    payload.update(messages=taken, hasMore=start > 0, direction="older", reset=reset,
        nextCursor=f"{version}@{start}" if start > 0 else None)
    return payload


def session_content(con, run_id, executor_id, entry_id, *, field="content", offset=0, limit=EXECUTION_PREVIEW_BYTES):
    descriptor = resolve_session(con, run_id, executor_id)
    if descriptor is None:
        return None
    if field not in {"content", "result", "arguments", "error"}:
        raise ValueError("Unknown session content field")
    path = descriptor["sessionFile"]
    body = (descriptor["error"] or "") if field == "error" and entry_id in {"", executor_id} else ""
    if path and Path(path).is_file():
        entries = _read_session(path, _session_version(path))
        for entry in entries:
            message = read_field(entry, "message")
            if (field in {"result", "error"} and read_field(message, "toolCallId") == entry_id
                    and (field == "result" or read_field(message, "isError", False))):
                body = content_text(read_field(message, "content"))
                break
            if field == "arguments":
                for block in read_field(message, "content", []) or []:
                    if isinstance(block, dict) and block.get("type") == "toolCall" and block.get("id") == entry_id:
                        body = json.dumps(block.get("arguments") or {}, ensure_ascii=False, indent=2)
                        break
            if read_field(entry, "id") == entry_id and field == "content":
                source = entry if read_field(entry, "type") == "custom_message" else message
                body = content_text(read_field(source, "content", []))
                break
    body = redact(str(body or ""))
    start = max(0, int(offset or 0))
    size = max(1, min(int(limit or EXECUTION_PREVIEW_BYTES), EXECUTION_PREVIEW_BYTES))
    part = body[start:].encode("utf-8")[:size].decode("utf-8", errors="ignore")
    if not part and start < len(body):
        part = body[start]  # A page budget smaller than a codepoint must still advance.
    end = start + len(part)
    return {"content": part, "nextOffset": end if end < len(body) else None, "hasMore": end < len(body)}


def registered_artifact(row, workspace):
    """Read one registered document, returning its body only while its frozen digest matches."""
    path = Path(row["path"]).resolve()
    root = Path(workspace).resolve()
    base = {"id": str(row["id"]), "kind": str(row["kind"]), "title": str(row["title"]),
            "path": None, "state": "missing", "content": None}
    try:
        base["path"] = path.relative_to(root).as_posix()
    except ValueError:
        base["state"] = "outside_workspace"
        return base
    try:
        content = runs.artifact_text(row)
    except FileNotFoundError:
        return base
    except OSError:
        return base
    except ValueError:
        base["state"] = "changed"
        return base
    base.update(state="available", content=content)
    return base


def _findings(con, run_id, *, node_id=None, task_id=None):
    items = []
    for finding in ledger.findings(con, run_id, branch_id=node_id, task_id=task_id):
        items.append({
            "id": str(finding["id"]),
            "text": str(finding["text"]),
            "claim_type": str(finding["claim_type"]),
            "citations": [{
                "artifact_id": claim["artifact_id"],
                "source_file": claim["source_file"],
                "quote": claim["quote"],
                "evidence_sha": claim["evidence_sha"],
            } for claim in ledger.claims(con, finding["id"])],
        })
    return items


def _artifacts(con, run, *, branch_id=None, task_id=None, run_level=False, kind=None):
    return [registered_artifact(row, run["workspace"])
            for row in runs.artifacts(con, run["id"], branch_id=branch_id, task_id=task_id,
                                      run_level=run_level, kind=kind)]


def run_detail(con, run_id):
    """Snapshot metadata and graph topology; long artifact bodies remain separately addressable."""
    run = runs.get(con, str(run_id))
    if run is None:
        return None
    snapshot = graph.snapshot(con, run)
    snapshot["plans"] = []
    pending_questions = []
    for node in runs.nodes(con, run_id):
        round_number = runs.plan_round(con, run_id, node["id"])
        if not round_number:
            continue
        _, recorded = runs.current_plan(con, run_id, node["id"])
        if recorded:
            snapshot["plans"].append({
                "node_id": str(node["id"]),
                "round": int(round_number),
                "tool_call_id": str(recorded["tool_call_id"]),
                "plan": recorded["payload"],
            })
            if node["status"] == "waiting_input":
                pending_questions.extend({"node_id": str(node["id"]), "question": question}
                                         for question in recorded["payload"].get("clarifying_questions") or [])
    snapshot["final_artifacts"] = [
        {key: value for key, value in item.items() if key != "content"}
        for item in _artifacts(con, run, run_level=True)
    ]
    return {"run": runs.summary(con, run_id), "graph": snapshot, "pending_questions": pending_questions}


def active_runs(con):
    """A compact global activity strip, independent of the currently selected chat project."""
    items = []
    for row in runs.listing(con):
        if row["status"] not in runs.ACTIVE:
            continue
        summary = runs.summary(con, row["id"])
        summary["question"] = row["question"]
        summary["workspace"] = row["workspace"]
        items.append(summary)
    return items


def node_detail(con, run_id, node_id):
    run = runs.get(con, str(run_id))
    node = runs.node(con, str(node_id))
    if run is None or node is None or str(node["run_id"]) != str(run_id):
        return None
    cards = []
    for linked in runs.tasks(con, run_id, node_id=node_id):
        task_id = str(linked["task_id"])
        task = task_store.get(con, task_id)
        cards.append({
            "id": task_id,
            "title": str(task["title"] if task else linked["title"]),
            "body": str(task["body"] if task else ""),
            "status": str(linked["status"]),
            "kind": str(linked["research_kind"]),
            "round": int(linked["round"]),
            "attempt": int(linked["generation"]),
            "assignee": str(task["assignee"] if task else linked["assignee"] or ""),
            "artifacts": _artifacts(con, run, task_id=task_id),
            "findings": _findings(con, run_id, node_id=node_id, task_id=task_id),
        })
    plan_round, plan_action = runs.current_plan(con, run_id, node_id)
    return {
        "node": {"id": str(node["id"]), "question": str(node["question"]),
                 "depth": int(node["depth"]), "status": str(node["status"]),
                 "kind": graph.kind(con, node)},
        "plan_round": int(plan_round),
        "plan": plan_action["payload"] if plan_action else None,
        "cards": cards,
        "artifacts": _artifacts(con, run, branch_id=node_id),
        "findings": _findings(con, run_id, node_id=node_id),
        "issues": [dict(item) for item in runs.issues(con, run_id, node_id=node_id)],
        "errata": [dict(item) for item in runs.errata(con, run_id) if str(item.get("node")) == str(node_id)],
        "red_team": runs.red_team(con, run_id, node_id),
    }


def task_detail(con, run_id, task_id):
    run = runs.get(con, str(run_id))
    task = task_store.get(con, str(task_id))
    link = con.execute(
        "SELECT branch_id FROM research_run_tasks WHERE run_id=? AND task_id=?",
        (str(run_id), str(task_id)),
    ).fetchone()
    if run is None or task is None or link is None:
        return None
    return {
        "id": str(task_id), "title": str(task["title"]), "body": str(task["body"]),
        "status": str(task["status"]), "assignee": str(task["assignee"]),
        "node_id": str(link["branch_id"]),
        "artifacts": _artifacts(con, run, task_id=task_id),
        "findings": _findings(con, run_id, node_id=link["branch_id"], task_id=task_id),
    }


def artifact_detail(con, run_id, artifact_id):
    run = runs.get(con, str(run_id))
    row = runs.artifact(con, str(artifact_id))
    if run is None or row is None or str(row["run_id"]) != str(run_id):
        return None
    return registered_artifact(row, run["workspace"])


def _moment_ms(value):
    """A record's clock in epoch milliseconds, or None when the transcript never carried one."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value * 1000) if value < 1e11 else int(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return int(datetime.fromisoformat(text).timestamp() * 1000)
        except ValueError:
            return None
    return None


def _preview(value, *, cap=EXECUTION_PREVIEW_BYTES):
    """One redacted, size-bounded text field, plus whether the reader is missing the rest."""
    if value is None:
        return None, False
    if isinstance(value, str):
        text = value
    elif isinstance(value, list):
        # A tool's content blocks are prose to a reader; anything else keeps its shape.
        text = content_text(value) or json.dumps(value, ensure_ascii=False, indent=2, default=str)
    elif isinstance(value, dict):
        text = json.dumps(value, ensure_ascii=False, indent=2, default=str)
    else:
        text = str(value)
    text = redact(text)
    if not text:
        return None, False
    if len(text.encode("utf-8")) <= cap:
        return text, False
    clipped = text.encode("utf-8")[:cap].decode("utf-8", errors="ignore")
    return clipped, True


def _resolved_pointer(value):
    """A board pointer column, as a real path. The read-only handle does not expand these itself."""
    if not value:
        return None
    return str(home.from_stored(str(value)))


def execution_instances(con, task_id):
    """Every execution instance recorded for a card, oldest attempt first.

    Identity comes from the board (`task_runs` rows, then the card's own runtime columns), never
    from a path a caller supplied: the transcript behind an instance is looked up here, not there.
    """
    task = task_store.get(con, str(task_id))
    if task is None:
        return []
    rows = con.execute(
        "SELECT id, generation, attempt, phase, status, started_at, completed_at, exit_code,"
        " failure_kind, summary, session_file FROM task_runs WHERE task_id=? "
        "ORDER BY generation, attempt",
        (str(task_id),),
    ).fetchall()
    instances = []
    for row in rows:
        stored = row["session_file"]
        instances.append({
            "instanceId": str(row["id"]),
            "taskId": str(task_id),
            "generation": int(row["generation"] or 0),
            "attempt": int(row["attempt"] or 0),
            "phase": str(row["phase"] or ""),
            "status": str(row["status"] or ""),
            "startedAt": int(row["started_at"] or 0) * 1000 if row["started_at"] else None,
            "endedAt": int(row["completed_at"] or 0) * 1000 if row["completed_at"] else None,
            "exitCode": row["exit_code"],
            "failureKind": row["failure_kind"],
            "summary": redact(row["summary"]) if row["summary"] else None,
            "sessionFile": _resolved_pointer(stored),
            "source": "task_run",
        })
    # A card executed outside a claimed run (a direct member task) still carries its runtime facts.
    if not instances:
        agent_id = str(task["agent_id"] or "")
        session_file = _resolved_pointer(task["session_file"])
        if agent_id or session_file:
            instances.append({
                "instanceId": agent_id or f"card-{task_id}",
                "taskId": str(task_id),
                "generation": int(task["generation"] or 0),
                "attempt": 1,
                "phase": "worker",
                "status": str(task["status"] or ""),
                "startedAt": int(task["started_at"] or 0) * 1000 if task["started_at"] else None,
                "endedAt": int(task["completed_at"] or 0) * 1000 if task["completed_at"] else None,
                "exitCode": None,
                "failureKind": None,
                "summary": None,
                "sessionFile": session_file,
                "source": "card_runtime",
            })
    else:
        # The card's current runtime is the live one even when its run row has not caught up.
        current = str(task["current_run_id"] or "")
        session_file = _resolved_pointer(task["session_file"])
        for instance in instances:
            if instance["instanceId"] == current and session_file:
                instance["sessionFile"] = session_file
    return instances


def _tool_records(entries):
    """Pair each recorded tool call with the result entry that answers it, in transcript order."""
    records = {}
    order = []
    for index, entry in enumerate(entries):
        if entry.get("type") != "message":
            continue
        message = entry.get("message")
        if not isinstance(message, dict):
            continue
        stamp = _moment_ms(entry.get("timestamp")) or _moment_ms(message.get("timestamp"))
        role = message.get("role")
        if role == "assistant":
            for block in message.get("content") or []:
                if not isinstance(block, dict) or block.get("type") != "toolCall":
                    continue
                call_id = str(block.get("id") or f"index-{index}")
                if call_id in records:
                    continue
                record = {
                    "toolCallId": call_id,
                    "toolName": str(block.get("name") or "tool"),
                    "status": "running",
                    "arguments": None,
                    "argumentsTruncated": False,
                    "resultTruncated": False,
                    "result": None,
                    "error": None,
                    "startedAt": stamp,
                    "endedAt": None,
                    "recordIndex": index,
                }
                arguments, truncated = _preview(block.get("arguments") or {})
                record["arguments"] = arguments
                record["argumentsTruncated"] = truncated
                if block.get("argumentsError"):
                    record["error"] = redact(str(block["argumentsError"]))
                    record["status"] = "error"
                records[call_id] = record
                order.append(call_id)
        elif role == "toolResult":
            call_id = str(message.get("toolCallId") or f"index-{index}")
            record = records.get(call_id)
            if record is None:
                record = {
                    "toolCallId": call_id,
                    "toolName": str(message.get("toolName") or "tool"),
                    "status": "running",
                    "arguments": None, "argumentsTruncated": False, "resultTruncated": False,
                    "result": None, "error": None, "startedAt": stamp, "endedAt": None,
                    "recordIndex": index,
                }
                records[call_id] = record
                order.append(call_id)
            failed = bool(message.get("isError"))
            result, truncated = _preview(message.get("content"))
            record["result"] = result
            record["resultTruncated"] = truncated
            record["error"] = redact(content_text(message.get("content"))) if failed else record["error"]
            record["status"] = "error" if failed else "success"
            record["endedAt"] = _moment_ms(message.get("timestamp")) or stamp
    return [records[call_id] for call_id in order]


def execution_detail(con, run_id, task_id, *, instance_id=None, cursor=None, limit=EXECUTION_MAX_LIMIT):
    """Real per-instance tool records for one card of one run.

    Returns ``None`` when the card is not part of the run: an unrelated identifier is not an empty
    execution, and the caller must not be able to read another research's transcript.
    """
    run = runs.get(con, str(run_id))
    link = con.execute(
        "SELECT branch_id FROM research_run_tasks WHERE run_id=? AND task_id=?",
        (str(run_id), str(task_id)),
    ).fetchone() if run is not None else None
    if run is None or link is None:
        return None

    instances = execution_instances(con, task_id)
    if instance_id:
        instances = [item for item in instances if item["instanceId"] == str(instance_id)]
    page_limit = max(1, min(int(limit or EXECUTION_MAX_LIMIT), EXECUTION_MAX_LIMIT))
    try:
        after = int(cursor) if cursor not in (None, "") else -1
    except (TypeError, ValueError):
        after = -1

    if not instances:
        return {"instances": [], "entries": [], "nextCursor": None, "hasMore": False,
                "availability": "not_started",
                "reason": "该任务尚未记录任何执行实例。",
                "runId": str(run_id), "taskId": str(task_id)}
    if instance_id and len(instances) == 0:
        return None

    selected = instances[-1] if not instance_id else instances[0]
    payload = {
        "instances": [{key: value for key, value in item.items() if key != "sessionFile"}
                      for item in instances],
        "runId": str(run_id), "taskId": str(task_id),
        "instanceId": selected["instanceId"],
        "entries": [], "nextCursor": None, "hasMore": False,
        "availability": "available", "reason": None,
    }
    session_file = selected.get("sessionFile")
    if not session_file:
        payload["availability"] = "not_started"
        payload["reason"] = ("该实例尚未开始写入执行记录。" if selected["status"] not in _CLOSED_RUN
                            else "该实例没有留下执行记录文件。")
        return payload
    path = Path(session_file)
    if not path.is_file():
        payload["availability"] = "missing"
        payload["reason"] = "执行记录文件不在这台机器上，可能已被清理或在另一环境执行。"
        return payload
    try:
        entries = load_entries_from_file(str(path))
    except Exception:  # noqa: BLE001 - a half-written transcript is a state to report, not a crash
        payload["availability"] = "interrupted"
        payload["reason"] = "执行记录正在写入或无法解析，请稍后刷新。"
        return payload

    records = _tool_records(entries)
    window = [item for item in records if item["recordIndex"] > after]
    if not window:
        # Nothing new behind the cursor. An instance that finished with an unanswered call did not
        # lose it silently: that is an interrupted record, and it says so.
        payload["availability"] = "available" if records else (
            "interrupted" if selected["status"] in _CLOSED_RUN else "not_started")
        payload["reason"] = None if records else "该实例的执行记录里没有工具调用。"
        return payload

    taken = []
    used = 0
    for record in window:
        if len(taken) >= page_limit:
            break
        body = json.dumps(record, ensure_ascii=False)
        if used + len(body.encode("utf-8")) > EXECUTION_RESPONSE_BYTES and taken:
            break
        used += len(body.encode("utf-8"))
        taken.append(record)
    stopped_early = len(taken) < len(window)
    payload["entries"] = taken
    payload["nextCursor"] = str(taken[-1]["recordIndex"]) if taken else str(after)
    payload["hasMore"] = stopped_early
    if taken and all(item["status"] == "running" for item in taken) and selected["status"] in _CLOSED_RUN:
        payload["availability"] = "interrupted"
        payload["reason"] = "实例结束时仍有未回答的工具调用。"
    return payload
