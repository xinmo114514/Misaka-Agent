"""A follow-up round whose cards all failed, concluded without (0.18.10 sweep): the node went
planning -> executing -> synthesizing for ever, the CPU busy and plan-2.md rewritten each pass."""
import asyncio

from test_research_node_routine import (  # noqa: F401
    RESEARCHER,
    _expand,
    _Runner,
    _script,
    lab,
)

from misaka.core.platform import cards, tasks
from misaka.core.research import planner, runs, workflow


async def test_a_failed_follow_up_round_concluded_without_closes_the_node(lab):  # noqa: F811
    con, run = lab.con, lab.run
    runs.update_limits(con, run["id"], {"max_followups": 1})
    _script(lab, reviews={1: []}, alternatives=[], dispositions=None,
            decide=lambda c: {"decisions": [], "declined": []},
            cards_failed=lambda c, key: {"decision": "conclude", "reason": "round 1 suffices"})
    scripted_drive = workflow._drive_tasks
    scripted_synth = planner.synthesize
    calls = {"synth": 0, "drive": 0, "states": []}

    def synthesize(con_, run_, cfg, worker, node, rows, *, followup=None, **kw):
        calls["synth"] += 1
        if followup is not None and calls["synth"] == 1:
            plan2 = {"status": "ready", "plan_markdown": "More", "decisions": [], "clarifying_questions": [],
                     "reframed_question": "", "methods": [], "extensions": {}, "red_team": None,
                     "tasks": [{"local_id": "extra", "title": "Extra", "question": "q", "rationale": "r",
                                "deliverable": "extra.md", "assignee": RESEARCHER, "dependencies": []}]}
            runs.record_action(con, run_, node, runs.plan_key(2), plan2, session_file=run_["root_session"], tool_call_id="p2")
            return "ignored"
        return scripted_synth(con_, run_, cfg, worker, node, rows, **kw)

    async def drive(con_, cfg, runner, run_id, *, scope, **kw):
        calls["drive"] += 1
        for row in runs.tasks(con, run_id):
            if row["id"] in scope and (row["local_id"] or "").startswith("r2/") and row["status"] != "failed":
                con.execute("UPDATE tasks SET status='failed' WHERE id=?", (row["id"],))
                cards.set_fields(row["workspace"], row["id"], status="failed", generation=row["generation"])
                tasks.add_event(con, row["id"], "failed", {"reason": "502"}, generation=row["generation"])
                return "failed"
        return await scripted_drive(con_, cfg, runner, run_id, scope=scope, **kw)

    orig_set_node = runs.set_node
    def set_node(con_, nid, **kw):
        if kw.get("status"):
            calls["states"].append(kw["status"])
        return orig_set_node(con_, nid, **kw)
    lab.monkeypatch.setattr(runs, "set_node", set_node)
    lab.monkeypatch.setattr(planner, "synthesize", synthesize)
    lab.monkeypatch.setattr(workflow, "_drive_tasks", drive)
    result = await asyncio.wait_for(_expand(lab, _Runner(con)), timeout=5)
    assert result == "closed" and calls["states"].count("planning") == 2
