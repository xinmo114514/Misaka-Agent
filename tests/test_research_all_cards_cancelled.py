"""Every card of a round cancelled while they ran (0.18.10 sweep). Planned again, a first round
closed the node as a branch point, with no conclusion; a follow-up round was kept as one she had
asked for, and her conclusion was dropped as a request for it."""
import asyncio
import hashlib
from pathlib import Path

from test_research_plan_change import ROSTER, change, executing, task  # noqa: F401

from misaka.core.research import commands, planner, runs, workflow


def _expand(con, run, root):
    try:
        return asyncio.run(workflow._expand(con, {"workspace": run["workspace"]}, None, None, runs.get(con, run["id"]),
                                            runs.node(con, root["id"]), context=None, tool_call_id="t",
                                            poll_seconds=0, progress=None))
    except RuntimeError as error:
        return error


def test_a_first_round_whose_cards_were_all_cancelled_fails_the_node(executing, monkeypatch):  # noqa: F811
    con, run, root, tool, ctx = executing
    cards = workflow._round_cards(con, run, root, 1)
    con.execute("UPDATE tasks SET status='ready' WHERE id=?", (cards["a"]["id"],))
    change(tool, ctx, cancel=[{"card": "a", "reason": "x"}, {"card": "b", "reason": "x"}, {"card": "c", "reason": "x"}])
    asyncio.run(workflow._apply_plan_changes(con, run, root, 1, [0], None, (run, root)))
    con.execute("UPDATE research_branches SET status='failed' WHERE id=?", (root["id"],))
    runs.resume(con, run["id"], driver_lock="driver")
    monkeypatch.setattr(planner, "plan_needs_user", lambda *a, **k: False)
    monkeypatch.setattr(planner, "publish_project_brief", lambda *a, **k: None)
    monkeypatch.setattr(workflow, "_views", lambda *a, **k: asyncio.sleep(0))
    _expand(con, run, root)
    assert runs.node(con, root["id"])["status"] == "failed"


def test_a_follow_up_round_whose_cards_were_all_cancelled_is_withdrawn(executing, monkeypatch):  # noqa: F811
    con, run, root, _tool, ctx = executing
    con.execute("UPDATE tasks SET status='done'")
    # The original round has real accepted material; a done status alone is
    # intentionally insufficient for the workspace's zero-output guard.
    from misaka.core.platform import tasks
    for original in runs.tasks(con, run["id"], kind="research"):
        output = Path(original["output_dir"], "accepted.md")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text("Verified source comparison.\n", encoding="utf-8")
        relative = str(output.relative_to(run["workspace"]))
        tasks.add_event(con, original["id"], "submitted", {"summary": "Verified comparison", "findings": [],
            "artifacts": [relative], "artifact_digests": {relative: hashlib.sha256(output.read_bytes()).hexdigest()}},
            generation=original["generation"])
    workflow.settle_done_tasks(con, run_id=run["id"])
    plan = planner.validate_plan({"status": "ready", "plan_markdown": "more", "tasks": [task("x"), task("y")]},
                                 ROSTER, red_team_required=False)
    runs.record_action(con, run, root, runs.plan_key(2), plan, session_file=ctx.sessionManager.sessionFile,
                       tool_call_id="p2")
    asyncio.run(workflow._submit_tasks(con, run, root, plan["tasks"], kind="research", round=2))
    tool = commands.plan_change_tool(con, run, root, round=2, session_file=ctx.sessionManager.sessionFile,
                                     validate=lambda c: workflow._check_plan_change(con, run, root, 2, ROSTER, c))
    change(tool, ctx, cancel=[{"card": "x", "reason": "z"}, {"card": "y", "reason": "z"}])
    assert asyncio.run(workflow._apply_plan_changes(con, run, root, 2, [0], None, (run, root)))
    runs.set_node(con, root["id"], status="synthesizing")
    monkeypatch.setattr(workflow, "_views", lambda *a, **k: asyncio.sleep(0))
    monkeypatch.setattr(planner, "_call", lambda *a, **k: (None, "A real conclusion.", None))
    written = []
    real = workflow._write

    def write(con_, run_, node_, kind, title, name, content, **more):
        if kind == "synthesis":
            written.append(content)
            raise RuntimeError("stop here")
        return real(con_, run_, node_, kind, title, name, content, **more)

    monkeypatch.setattr(workflow, "_write", write)
    _expand(con, run, root)
    assert written == ["A real conclusion.\n"]
    assert runs.plan_round(con, run["id"], root["id"]) == 1
    assert runs.plan_changes(con, run["id"], root["id"], 2) == []
