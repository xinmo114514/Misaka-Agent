"""Verified report outbox over native custom-message persistence receipts."""
from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

KIND = "research_report_delivery"


def snapshot(con, run_id):
    row = con.execute("SELECT payload FROM events WHERE task_id=? AND kind=? ORDER BY id DESC LIMIT 1",
                      (run_id, KIND)).fetchone()
    return json.loads(row[0]) if row else None


def record(con, run, state, *, artifact_id=None, delivery_id=None, error_code=None, **fields):
    value = {"artifactId": artifact_id or run.get("final_artifact"), "state": state,
             "deliveryId": delivery_id, "rootSession": run.get("root_session"),
             "workspace": run["workspace"], **fields}
    if error_code:
        value["errorCode"] = error_code
    con.execute("INSERT INTO events(task_id,kind,payload,run_id,created_at) VALUES(?,?,?,?,?)",
                (run["id"], KIND, json.dumps(value), run["id"], int(time.time())))
    return value


def prepare_final_delivery(con, run, session):
    from misaka.core.research import runs
    artifact_id = run.get("final_artifact")
    if not artifact_id:
        raise ValueError("The run has no registered final artifact")
    row = runs.artifact(con, artifact_id)
    if row is None or str(row["run_id"]) != str(run["id"]):
        raise ValueError("The registered report does not belong to this run")
    path = Path(row["path"]).resolve()
    workspace = Path(run["workspace"]).resolve()
    if not path.is_relative_to(workspace):
        raise ValueError("The report is outside its saved workspace")
    manager = getattr(session, "sessionManager", None)
    if manager is not None:
        root = run.get("root_session")
        here = getattr(manager, "sessionFile", None)
        if root and (not here or os.path.realpath(root) != os.path.realpath(here)):
            raise ValueError("The report belongs to its saved root session")
        cwd = getattr(manager, "getCwd", lambda: None)()
        if cwd and Path(cwd).resolve() != workspace:
            raise ValueError("The report belongs to its saved workspace")
    body = runs.artifact_text(row)  # verifies bytes/digest even when caller supplied content
    incomplete = run["status"] != "done"
    if incomplete:
        header = f"# Incomplete research report - {run['id']}\n\nThis report is incomplete; research has not completed.\n"
    else:
        header = f"# Delivered final report - {run['id']}\n\nThis is the authoritative version; it supersedes this run's working drafts.\n"
    return {"artifactId": artifact_id, "path": str(path), "sha256": row["sha256"],
            "body": body, "content": header + f"Report: {path}\n\n---\n\n" + body,
            "incomplete": incomplete}


def _persisted(session, delivery_id):
    manager = getattr(session, "sessionManager", None)
    if manager is None or not getattr(manager, "flushed", False):
        return None
    return next((entry for entry in reversed(manager.getEntries())
                 if entry.get("type") == "custom_message"
                 and (entry.get("details") or {}).get("delivery_id") == delivery_id), None)


def persist_final_delivery(con, run, prepared, session, send):
    """Queue the exact native delivery ID; only _onPersist records delivered.

    A lost ACK is reconstructed from flushed JSONL. An old mismatched placeholder
    receives one digest-scoped repair identity; retries reuse it, not the polluted ID.
    """
    prefix = "research-partial" if prepared["incomplete"] else "research-final"
    delivery_id = f"{prefix}:{run['id']}:{prepared['artifactId']}"
    original_id = delivery_id
    old = _persisted(session, delivery_id)
    repaired = old is not None and prepared["body"] not in str(old.get("content") or "")
    if repaired:
        delivery_id = f"research-final-repair:{run['id']}:{prepared['artifactId']}:{prepared['sha256']}"
        old = _persisted(session, delivery_id)
    fields = {"artifact_id": prepared["artifactId"], "delivery_id": delivery_id,
              "sha256": prepared["sha256"], "incomplete": prepared["incomplete"]}
    if repaired:
        fields["supersededDeliveryId"] = original_id
    future = None
    if getattr(session, "sessionManager", None) is not None:
        future = asyncio.get_running_loop().create_future()
    def confirmed():
        previous = snapshot(con, run['id'])
        expected = {'artifactId': fields['artifact_id'], 'state': 'delivered',
                    'deliveryId': delivery_id, 'rootSession': run.get('root_session'),
                    'workspace': run['workspace'], 'sha256': prepared['sha256'],
                    'incomplete': prepared['incomplete']}
        if repaired:
            expected['supersededDeliveryId'] = original_id
        if previous != expected:
            record(con, run, "delivered", **fields)
        if future is not None and not future.done():
            future.set_result("delivered")
    def failed(error):
        record(con, run, "failed", error_code="RESEARCH_REPORT_PERSIST_FAILED", **fields)
        if future is not None and not future.done():
            future.set_result("failed")
    if old is not None:
        confirmed()
        return future
    record(con, run, "pending", **fields)
    from misaka.core.research import runs
    payload = {"customType": "research-final", "display": True, "content": prepared["content"],
               "details": {"run_id": run["id"], "result": runs.summary(con, run['id']),
                           "status": run['status'], "final_artifact": prepared["artifactId"],
                           "report_path": prepared["path"], "artifactSha256": prepared["sha256"],
                           "incomplete": prepared["incomplete"],
                           **({"supersedesDeliveryId": original_id} if repaired else {})}}
    options = {"deliverAs": "followUp", "triggerTurn": False, "_deliveryId": delivery_id,
               "_onPersist": confirmed, "_onError": failed}
    try:
        send(payload, options)
    except BaseException as error:
        failed(error)
        raise
    return future


async def wait_for_persistence(future, timeout=30):
    if future is None:
        return None
    try:
        return await asyncio.wait_for(asyncio.shield(future), timeout)
    except TimeoutError:
        return "pending"
