"""Small, on-demand read models for the desktop research workbench."""

from __future__ import annotations

import os
from pathlib import Path

from misaka.core.research import graph, ledger, runs
from misaka.core.platform import tasks as task_store


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
