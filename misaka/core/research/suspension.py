"""Durable, model-free stop confirmations in the existing research action ledger."""
from __future__ import annotations

import hashlib
import json
import time

from misaka.core import graph
from misaka.core.platform import tasks as task_store
from misaka.core.research import ledger, runs
from misaka.utils.redact import redact

PREFIX = "system:all-cards-stopped:"


def active_suspensions(con, run_id):
    values = [graph.thaw(entry.payload) for entry in graph.entries(
        con, run_id, key_prefix=PREFIX, status=runs._LIVE)]
    return [value for value in values if value.get("resolvedAt") is None]


def resolve_suspensions(con, run_id, node_id=None):
    for entry in graph.entries(con, run_id, key_prefix=PREFIX, status=runs._LIVE):
        payload = graph.thaw(entry.payload)
        if node_id is not None and (payload.get("scope") != "node" or payload.get("nodeId") != node_id):
            continue
        if payload.get("resolvedAt") is None:
            payload["resolvedAt"] = int(time.time() * 1000)
            graph.propose(con, run_id, "action", payload, key=entry.key, scope=entry.scope,
                          proposer=entry.proposer, supersede=True)


def has_accepted_output(con, run_id, node_id=None):
    if ledger.findings(con, run_id, branch_id=node_id):
        return True
    for task in runs.tasks(con, run_id, node_id=node_id):
        if task["status"] != "done":
            continue
        for artifact in runs.artifacts(con, run_id, task_id=task["id"]):
            if artifact["kind"] != "task_output":
                continue
            try:
                runs.artifact_text(artifact)
                return True
            except (OSError, ValueError):
                continue
    return False


def _save(con, run, node, scope, confirmations, has_output, *, kind="research"):
    identity = json.dumps([scope, node["id"], kind,
                          [(item["taskId"], item["generation"]) for item in confirmations]], sort_keys=True)
    halt_id = "h_" + hashlib.sha256(identity.encode()).hexdigest()[:16]
    key = PREFIX + halt_id
    prior = runs.action(con, run["id"], node["id"], key)
    if prior:
        return prior["payload"]
    resume = f"/research resume {run['id']}"
    lines = [f"卡片停止确认：{item['taskId']}（{item['title']}，第 {item['generation']} 代）· {item['status']}"
             + (f"：{item['error'][:500]}" if item['error'] else "") for item in confirmations]
    summary = (f"{len(confirmations)} 张卡片全部确认终止，均无验收产出。" if not has_output else
               f"{len(confirmations)} 张卡片已确认终止；已验收产物保持保存。")
    message = "\n".join([*lines, summary, f"{'运行' if scope == 'run' else '当前节点'}保持挂起状态；继续研究请用 {resume}。"])
    payload = {"id": halt_id, "runId": run["id"], "nodeId": node["id"] if scope == "node" else None,
        "scope": scope, "reason": "all_cards_stopped", "hasAcceptedOutput": bool(has_output),
        "confirmations": confirmations, "resumeCommand": resume, "message": message,
        "createdAt": int(time.time() * 1000), "resolvedAt": None}
    # Existing action uniqueness is the durable dedup fence. All callers hold the native owner.
    with runs.owned_txn(con, run, node if scope == "node" else None, allow_stop=True):
        graph.propose(con, run["id"], "action", payload, key=key, scope=node["id"],
                      proposer={"session_file": node["session_file"] or run["root_session"] or "",
                                "tool_call_id": key})
    return runs.action(con, run["id"], node["id"], key)["payload"]


def record_node_stop(con, run, node, *, kind="research", scope_ids=None):
    cards = [row for row in runs.tasks(con, run["id"], kind=kind, node_id=node["id"])
             if scope_ids is None or row["id"] in scope_ids]
    if not cards or any(row["status"] not in {"failed", "stopped", "done"} and not runs.parked(con, row)
                        for row in cards):
        return None
    accepted = has_accepted_output(con, run["id"], node["id"])
    if accepted and any(row["status"] == "done" for row in cards):
        return None
    if not accepted:
        for card in cards:
            if card["status"] == "done" and not task_store.latest_payload(con, card["id"], "research_review_missing", generation=card["generation"]):
                task_store.add_event(con, card["id"], "research_review_missing",
                    {"reason": "The card has no verified accepted output; explicit resume must redeclare it."},
                    generation=card["generation"])
    confirmations = []
    for card in sorted(cards, key=lambda item: item["id"]):
        error = card["last_failure_error"] or card["block_reason"]
        raw = (task_store.latest_payload(con, card["id"], "dispatch_error", generation=card["generation"])
               or task_store.latest_payload(con, card["id"], "failed", generation=card["generation"]))
        if raw:
            try:
                failure = json.loads(raw)
                error = failure.get("traceback") or failure.get("reason") or error
            except (ValueError, AttributeError):
                pass
        confirmations.append({"taskId": card["id"], "title": card["title"],
            "generation": int(card["generation"]), "status": card["status"],
            "error": redact(str(error)) if error else None})
    return _save(con, run, node, "node", confirmations, accepted, kind=kind)


def suspend_run(con, run):
    halts = active_suspensions(con, run["id"])
    confirmations = {item["taskId"]: item for halt in halts for item in halt["confirmations"]}
    if not confirmations:
        return None
    root = runs.root(con, run["id"])
    payload = _save(con, run, root, "run", sorted(confirmations.values(), key=lambda item: item["taskId"]),
                    has_accepted_output(con, run["id"]))
    with runs.owned_txn(con, run, allow_stop=True):
        runs.set_state(con, run["id"], status="stopped", error=payload["message"], final_artifact=None,
                       driver_lock=run["driver_lock"])
        if not payload["hasAcceptedOutput"]:
            con.execute("UPDATE research_runs SET final_artifact=NULL WHERE id=?", (run["id"],))
    return payload
