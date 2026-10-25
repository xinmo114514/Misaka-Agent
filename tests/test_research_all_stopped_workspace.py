import asyncio

import pytest
from test_desktop_research_message_entry import (
    waiting_root as waiting_root,  # noqa: PLC0414
)
from test_research_plan_change import ROSTER
from test_research_plan_change import executing as executing  # noqa: PLC0414
from test_research_root_lifecycle import root_run as root_run  # noqa: PLC0414

from misaka.core.platform import tasks
from misaka.core.research import planner, runs, workflow


def test_failed_prerequisites_stop_waiting_cards_instead_of_becoming_a_cycle(executing):
    con, run, root, _, _ = executing
    linked = runs.tasks(con, run["id"], node_id=root["id"])
    for row in linked:
        if row["local_id"] != "b":
            con.execute("UPDATE tasks SET status='failed' WHERE id=?", (row["id"],))
    outcome = asyncio.run(workflow._drive_tasks_inner(con, {}, None, run["id"],
        scope={row["id"] for row in linked}, captured={}, poll_seconds=0))
    assert outcome == "failed"
    assert all(row["status"] in {"failed", "stopped"} for row in runs.tasks(con, run["id"]))


def test_all_failed_node_never_asks_a_model_to_decide_or_conclude(executing, monkeypatch):
    from misaka.core.research.suspension import active_suspensions
    con, run, root, _, _ = executing
    con.execute("UPDATE tasks SET status='failed'")
    monkeypatch.setattr(planner, "sister_catalog", lambda *a, **k: ROSTER)
    async def no_views(*args, **kwargs):
        pass
    monkeypatch.setattr(workflow, "_views", no_views)
    def forbidden(*args, **kwargs):
        raise AssertionError("an all-stopped phase must not request model judgement")
    monkeypatch.setattr(planner, "cards_failed", forbidden)
    notices = []
    outcome = asyncio.run(workflow._expand(con, {}, None, None, runs.get(con, run["id"]),
        runs.node(con, root["id"]), context=None, tool_call_id="workspace-test", progress=notices.append, poll_seconds=0))
    assert outcome == "failed"
    [halt] = active_suspensions(con, run["id"])
    assert halt["scope"] == "node" and not halt["hasAcceptedOutput"]
    assert len(halt["confirmations"]) == 3
    assert halt["resumeCommand"] == f"/research resume {run['id']}"
    assert all(item["taskId"] in halt["message"] for item in halt["confirmations"])
    assert any(notice["stage"] == "all_cards_stopped" for notice in notices)


@pytest.mark.parametrize("parked_status", ["blocked", "triage"])
def test_parked_cards_with_no_help_or_output_suspend_before_model_judgement(executing, monkeypatch, parked_status):
    from misaka.core.research.suspension import active_suspensions
    con, run, root, _, _ = executing
    con.execute("UPDATE tasks SET status='failed'")
    card = runs.tasks(con, run["id"])[0]
    con.execute("UPDATE tasks SET status=?,block_reason='archive login required' WHERE id=?", (parked_status, card["id"]))
    monkeypatch.setattr(planner, "sister_catalog", lambda *a, **k: ROSTER)
    requests = []
    def decide(*args, **kwargs):
        requests.append("cards_failed")
        return {"decision": "fail", "reason": "test detected a request"}
    monkeypatch.setattr(planner, "cards_failed", decide)
    result = asyncio.run(workflow._expand(con, {}, None, None, runs.get(con, run["id"]),
        runs.node(con, root["id"]), context=None, tool_call_id="parked-zero", poll_seconds=0, progress=None))
    assert result == "failed"
    assert requests == []
    [halt] = active_suspensions(con, run["id"])
    assert not halt["hasAcceptedOutput"]
    assert any(item["taskId"] == card["id"] and item["status"] == parked_status for item in halt["confirmations"])
    assert any(item["taskId"] == card["id"] and item["error"] == 'archive login required' for item in halt["confirmations"])


def test_pending_help_card_does_not_count_as_all_stopped(executing):
    from misaka.core.research.suspension import record_node_stop
    con, run, root, _, _ = executing
    con.execute("UPDATE tasks SET status='failed'")
    card = runs.tasks(con, run["id"])[0]
    con.execute("UPDATE tasks SET status='blocked',block_kind='needs_input' WHERE id=?", (card["id"],))
    tasks.add_event(con, card["id"], "blocked", {"message_id": "m_waiting"}, generation=card["generation"])
    assert runs.help_waiting(con, tasks.get(con, card["id"]))
    assert record_node_stop(con, runs.get(con, run["id"]), root) is None


def test_explicit_resume_reopens_parked_confirmed_card(executing):
    from misaka.core.research.suspension import (
        active_suspensions,
        record_node_stop,
        suspend_run,
    )
    con, run, root, _, _ = executing
    con.execute("UPDATE tasks SET status='failed'")
    card = runs.tasks(con, run["id"])[0]
    con.execute("UPDATE tasks SET status='triage' WHERE id=?", (card["id"],))
    old_generation = int(card["generation"])
    assert record_node_stop(con, runs.get(con, run["id"]), root)
    suspend_run(con, runs.get(con, run["id"]))
    runs.resume(con, run["id"], driver_lock="driver")
    reopened = tasks.get(con, card["id"])
    assert reopened["generation"] == old_generation + 1
    assert reopened["status"] in {"ready", "todo"}
    assert active_suspensions(con, run["id"]) == []


def test_resume_resolves_saved_confirmations_and_reuses_the_same_sessions(executing):
    from misaka.core.research.suspension import active_suspensions, record_node_stop
    con, run, root, _, ctx = executing
    con.execute("UPDATE tasks SET status='failed'")
    runs.set_state(con, run["id"], root_session=ctx.sessionManager.sessionFile)
    before = {row["id"]: row["generation"] for row in runs.tasks(con, run["id"])}
    halt = record_node_stop(con, runs.get(con, run["id"]), root, kind="research")
    assert record_node_stop(con, runs.get(con, run["id"]), root, kind="research")["id"] == halt["id"]
    assert len(active_suspensions(con, run["id"])) == 1
    runs.set_state(con, run["id"], status="stopped")
    restored = runs.resume(con, run["id"], driver_lock="driver")
    assert restored["id"] == run["id"] and restored["root_session"] == ctx.sessionManager.sessionFile
    assert active_suspensions(con, run["id"]) == []
    assert all(row["generation"] == before[row["id"]] + 1 for row in runs.tasks(con, run["id"]))


async def test_zero_output_run_returns_stop_confirmation_without_a_report(root_run, monkeypatch):
    from misaka.core.research.suspension import active_suspensions, record_node_stop
    con, run, root, _, events = root_run
    task_id = tasks.create_task(con, "quota-limited", assignee="fixture", workspace=run["workspace"])
    runs.link_task(con, run["id"], task_id, kind="research", node=root)
    con.execute("UPDATE tasks SET status='failed',last_failure_error='429 usage_limit_reached' WHERE id=?", (task_id,))
    async def expand(db, cfg, runner, owner, current, node, **kwargs):
        record_node_stop(db, current, runs.node(db, node["id"]), kind="research")
        runs.set_node(db, node["id"], status="failed")
        return "failed"
    monkeypatch.setattr(workflow, "_expand", expand)
    result = await workflow.run(con, {}, object(), run_id=run["id"])
    assert result["reason"] == "stopped" and result["final"] is None
    assert runs.get(con, run["id"])["status"] == "stopped"
    assert runs.get(con, run["id"])["final_artifact"] is None
    assert result["suspension"]["confirmations"][0]["taskId"] == task_id
    assert "usage_limit_reached" in result["suspension"]["message"]
    assert not {"draft", "review", "final"}.intersection(events)
    assert {item["scope"] for item in active_suspensions(con, run["id"])} == {"node", "run"}


async def test_plain_message_keeps_quota_suspended_run_stopped_and_explicit_resume_is_allowed(waiting_root):
    import pytest

    from misaka.core.research import submissions
    from misaka.core.research.ingress import ResearchMessageIngress
    from misaka.core.research.suspension import record_node_stop, suspend_run
    case = waiting_root
    root = runs.root(case.con, case.run["id"])
    tid = tasks.create_task(case.con, "quota", assignee="fixture", workspace=case.run["workspace"])
    runs.link_task(case.con, case.run["id"], tid, kind="research", node=root)
    case.con.execute("UPDATE tasks SET status='failed' WHERE id=?", (tid,))
    record_node_stop(case.con, runs.get(case.con, case.run["id"]), root)
    suspend_run(case.con, runs.get(case.con, case.run["id"]))
    ingress = ResearchMessageIngress(case.session)
    with pytest.raises(submissions.ResearchInputError) as failure:
        await ingress.send({"sessionId": case.session.sessionId, "requestId": "not-resume", "text": "continue notes"}, case.con)
    assert failure.value.errorCode == "RESEARCH_EXPLICIT_RESUME_REQUIRED"
    assert case.control.commands == []
    assert runs.get(case.con, case.run["id"])["status"] == "stopped"
    ack = await ingress.send({"sessionId": case.session.sessionId, "requestId": "explicit", "text": "/research resume"}, case.con)
    assert ack["mode"] == "resume"


def test_zero_output_suspension_clears_an_old_placeholder_report_pointer(executing):
    from misaka.core.research.suspension import record_node_stop, suspend_run
    con, run, root, _, _ = executing
    con.execute("UPDATE tasks SET status='failed'")
    artifact, _ = runs.write_text(con, run["id"], "partial", "Old incomplete report", "old-partial.md", "No results.")
    runs.set_state(con, run["id"], final_artifact=artifact)
    record_node_stop(con, runs.get(con, run["id"]), root)
    halt = suspend_run(con, runs.get(con, run["id"]))
    assert not halt["hasAcceptedOutput"]
    assert runs.get(con, run["id"])["final_artifact"] is None


def test_native_node_retry_resolves_its_old_confirmation(executing):
    from misaka.core.research.suspension import active_suspensions, record_node_stop
    con, run, root, _, ctx = executing
    con.execute("UPDATE tasks SET status='failed'")
    record_node_stop(con, run, root)
    runs.set_node(con, root["id"], status="failed")
    runs.retry_node(con, run, root["id"], session_file=ctx.sessionManager.sessionFile, tool_call_id="explicit-retry")
    assert active_suspensions(con, run["id"]) == []
    assert runs.node(con, root["id"])["status"] == "planning"


def test_done_status_without_accepted_material_does_not_enable_model_judgement(executing, monkeypatch):
    from misaka.core.research.suspension import active_suspensions
    con, run, root, _, _ = executing
    con.execute("UPDATE tasks SET status='failed'")
    card = runs.tasks(con, run["id"])[0]
    con.execute("UPDATE tasks SET status='done' WHERE id=?", (card["id"],))
    tasks.add_event(con, card["id"], "submitted", {"summary": "No material", "artifacts": [], "artifact_digests": {}, "findings": []}, generation=card["generation"])
    monkeypatch.setattr(planner, "sister_catalog", lambda *a, **k: ROSTER)
    def forbidden(*args, **kwargs):
        raise AssertionError("zero accepted output reached a model")
    monkeypatch.setattr(planner, "cards_failed", forbidden)
    monkeypatch.setattr(planner, "synthesize", forbidden)
    outcome = asyncio.run(workflow._expand(con, {}, None, None, runs.get(con, run["id"]),
        runs.node(con, root["id"]), context=None, tool_call_id="empty-completion", poll_seconds=0, progress=None))
    assert outcome == "failed"
    assert not active_suspensions(con, run["id"])[0]["hasAcceptedOutput"]


def test_resume_at_synthesis_still_checks_actual_accepted_output(executing, monkeypatch):
    from misaka.core.research.suspension import active_suspensions
    con, run, root, _, _ = executing
    con.execute("UPDATE tasks SET status='done'")
    runs.set_node(con, root["id"], status="synthesizing")
    def forbidden(*args, **kwargs):
        raise AssertionError("resumed synthesis used no accepted material")
    monkeypatch.setattr(planner, "synthesize", forbidden)
    result = asyncio.run(workflow._expand(con, {}, None, None, runs.get(con, run["id"]),
        runs.node(con, root["id"]), context=None, tool_call_id="resume-empty", poll_seconds=0, progress=None))
    assert result == "failed"
    assert active_suspensions(con, run["id"])
