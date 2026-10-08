"""The desktop's intervention lanes: ask the owner to record, never record for it.

``resolve_owner`` classification is the decision the GUI's buttons rest on, and Lane D must clear
the real ownership gate in ``research.commands`` -- not a stub of it -- or the tests would pass
while the desktop silently lost every approval.
"""

import json
import os
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace

import pytest

from misaka.config import home
from misaka.core import session_control
from misaka.core.platform import repo, tasks
from misaka.core.research import commands, desktop_intervene, runs

pytestmark = pytest.mark.asyncio

PLAN = {"status": "ready", "plan_markdown": "Fixture plan",
        "red_team": {"assignee": "10032", "reason": "reads both jobs from her profile"},
        "tasks": [{"local_id": "a", "title": "A", "question": "What does A establish?",
                   "rationale": "Because the conclusion needs it.",
                   "deliverable": "a.md -- what A establishes", "assignee": "10032",
                   "assignee_reason": "She works on this period.", "dependencies": []}]}


@pytest.fixture
def board(tmp_path, monkeypatch):
    home_root = tmp_path / "home"
    home_root.mkdir()
    monkeypatch.setenv("MISAKA_HOME", str(home_root))
    monkeypatch.setattr(repo, "enabled", lambda *a: False)
    monkeypatch.setattr(tasks, "task_state_dir", lambda tid: str(tmp_path / "state" / tid))
    workspace = tmp_path / "project"
    workspace.mkdir()
    directory = home.path("sessions") / "last_order" / "window"
    directory.mkdir(parents=True, exist_ok=True)
    window = directory / "own.jsonl"
    window.write_text("", encoding="utf-8")
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        runs.init(con)
        yield SimpleNamespace(con=con, workspace=workspace, window=str(window))


def owned_run(board, *, awaiting_plan=True):
    run = runs.create(board.con, workspace=str(board.workspace), question="Lanes")
    node = runs.nodes(board.con, run["id"])[0]
    runs.set_state(board.con, run["id"], root_session=board.window)
    runs.set_node(board.con, node["id"], session_file=board.window,
                  status="awaiting_approval" if awaiting_plan else "executing")
    if awaiting_plan:
        runs.record_action(board.con, runs.get(board.con, run["id"]), runs.node(board.con, node["id"]),
                           runs.plan_key(1), PLAN, session_file=board.window, tool_call_id="tc-plan")
    return runs.get(board.con, run["id"]), runs.node(board.con, node["id"])


def make_control(session_file, tools, record_path, *, session_id="sess-1", instance="inst-1"):
    """A SessionControl that behaves like a live owning conversation."""
    session = SimpleNamespace(
        sessionId=session_id,
        isIdle=True,
        agent=SimpleNamespace(signal=None),
        extensionRunner=SimpleNamespace(
            # The real thing: this is what the ownership gate reads, and it must not be handed
            # the answer from outside.
            create_context=lambda: SimpleNamespace(
                sessionManager=SimpleNamespace(sessionFile=session_file))))
    catalog = SimpleNamespace(record=str(record_path), instance=instance, spec=None)
    Path(record_path).write_text(json.dumps({"id": session_id, "instance": instance}), encoding="utf-8")
    control = session_control.SessionControl(session, catalog)
    control.review_tools = tools
    return control


def review_tools_for(board, run, node):
    current = runs.node(board.con, node["id"])
    return commands.review_tools(board.con, run, current,
                                 session_file=current["session_file"] or run["root_session"],
                                 round=1, forks=False, validate=lambda value: value)


async def test_resolve_owner_calls_the_bridge_session_the_desktop_lane(board, monkeypatch):
    run, node = owned_run(board)
    session = SimpleNamespace(sessionManager=SimpleNamespace(sessionFile=board.window))
    owner = desktop_intervene.resolve_owner(runs, board.con, run, session, node["id"])
    assert owner.kind == "desktop"
    assert os.path.realpath(owner.session_file) == os.path.realpath(board.window)


async def test_resolve_owner_finds_a_live_terminal_as_remote(board, monkeypatch):
    run, node = owned_run(board)
    monkeypatch.setattr("misaka.core.session_catalog.owner_record",
                        lambda path: {"id": "other", "instance": "i", "control": "\\\\.\\pipe\\x",
                                      "state": "live"})
    owner = desktop_intervene.resolve_owner(runs, board.con, run, None, node["id"])
    assert owner.kind == "remote"
    assert owner.record["control"]


async def test_resolve_owner_reads_a_released_owner_as_unreachable(board, monkeypatch):
    """A terminal that exited leaves a record behind; it must not read as someone to command."""
    run, node = owned_run(board)
    monkeypatch.setattr("misaka.core.session_catalog.owner_record",
                        lambda path: {"id": "other", "instance": "i", "control": "\\\\.\\pipe\\x",
                                      "state": "saved"})
    owner = desktop_intervene.resolve_owner(runs, board.con, run, None, node["id"])
    assert owner.kind == "none" and owner.reachable is False


async def test_invoke_refuses_a_run_nobody_drives_and_says_to_adopt(board, monkeypatch):
    run, node = owned_run(board)
    monkeypatch.setattr("misaka.core.session_catalog.owner_record", lambda path: {})
    with pytest.raises(ValueError, match="Adopt it first"):
        await desktop_intervene.invoke(None, runs, board.con, run_id=run["id"],
                                       action="approve_plan", node_id=node["id"])
    assert runs.action(board.con, run["id"], node["id"], runs.start_key(1)) is None


async def test_invoke_rejects_an_action_that_is_not_a_phase_command(board):
    run, node = owned_run(board)
    with pytest.raises(ValueError, match="Unknown research action"):
        await desktop_intervene.invoke(None, runs, board.con, run_id=run["id"],
                                       action="write_my_own_plan", node_id=node["id"])


async def test_lane_d_approves_a_plan_through_the_real_gate(board, tmp_path, monkeypatch):
    """The whole point: a desktop button lands the same row a terminal turn would."""
    run, node = owned_run(board)
    control = make_control(board.window, review_tools_for(board, run, node), tmp_path / "record.json")
    monkeypatch.setattr(session_control, "for_session", lambda _s: control)
    session = SimpleNamespace(sessionManager=SimpleNamespace(sessionFile=board.window))

    result = await desktop_intervene.invoke(session, runs, board.con, run_id=run["id"],
                                            action="approve_plan", node_id=node["id"])

    assert "Started" in result["text"]
    recorded = runs.action(board.con, run["id"], node["id"], runs.start_key(1))
    assert recorded is not None
    # The row names the conversation that actually made the call -- observed, not supplied.
    assert os.path.realpath(str(home.from_stored(recorded["session_file"]))) == os.path.realpath(board.window)
    assert recorded["payload"]["plan_tool_call_id"] == "tc-plan"


async def test_plan_approval_rejects_a_stale_plan_revision(board, tmp_path, monkeypatch):
    run, node = owned_run(board)
    control = make_control(board.window, review_tools_for(board, run, node), tmp_path / "record.json")
    monkeypatch.setattr(session_control, "for_session", lambda _session: control)
    session = SimpleNamespace(sessionManager=SimpleNamespace(sessionFile=board.window))

    with pytest.raises(ValueError, match="changed since it was displayed"):
        await desktop_intervene.invoke(
            session, runs, board.con, run_id=run["id"], action="approve_plan", node_id=node["id"],
            payload={"summary": "Approve", "expected_plan_id": "stale-plan-call"},
        )

    assert runs.action(board.con, run["id"], node["id"], runs.start_key(1)) is None


async def test_lane_d_refuses_a_tool_the_owner_has_not_published(board, tmp_path, monkeypatch):
    """An action the driver did not offer must fail loudly, not record anything.

    ``misaka_research_skip`` is absent for the root's first plan (commands.py:391-394), so asking
    for it is the desktop reaching past the wait state.
    """
    run, node = owned_run(board)
    control = make_control(board.window, review_tools_for(board, run, node), tmp_path / "record.json")
    monkeypatch.setattr(session_control, "for_session", lambda _s: control)
    with pytest.raises(ValueError, match="no research command"):
        await desktop_intervene.invoke(
            SimpleNamespace(sessionManager=SimpleNamespace(sessionFile=board.window)),
            runs, board.con, run_id=run["id"], action="skip_node", node_id=node["id"])
    assert runs.action(board.con, run["id"], node["id"], runs.SKIP_KEY) is None


async def test_lane_d_refuses_when_the_run_no_longer_waits(board, tmp_path):
    """The node moved on: the tool's own state gate must be what says so."""
    run, node = owned_run(board, awaiting_plan=False)
    tools = review_tools_for(board, run, node)
    control = make_control(board.window, tools, tmp_path / "record.json")
    with pytest.raises(ValueError, match="go-ahead"):
        await control._research_command({"session": "sess-1", "instance": "inst-1",
                                         "operation": "research_tool",
                                         "tool": "misaka_research_start", "payload": {"summary": "go"}},
                                        "research_tool")


async def test_a_stranger_may_not_command_a_live_owner_through_the_socket(board, tmp_path):
    """The control socket fences by session identity; a wrong instance is refused, not executed."""
    run, node = owned_run(board)
    control = make_control(board.window, review_tools_for(board, run, node), tmp_path / "record.json")
    command = {"session": "sess-1", "instance": "not-the-instance", "operation": "research_tool",
               "tool": "misaka_research_start", "payload": {"summary": "go"}}
    with pytest.raises(ValueError, match="ended before it could record"):
        await control._research_command(command, "research_tool")
    assert runs.action(board.con, run["id"], node["id"], runs.start_key(1)) is None


async def test_research_tools_lists_only_what_is_waiting(board, tmp_path):
    """The GUI draws its buttons from this, so it must go empty when the wait ends."""
    run, node = owned_run(board)
    control = make_control(board.window, review_tools_for(board, run, node), tmp_path / "record.json")
    listed = await control._research_command({"session": "sess-1", "instance": "inst-1",
                                              "operation": "research_tools"}, "research_tools")
    assert listed["tools"] == ["misaka_research_assign", "misaka_research_start"]

    control.review_tools = ()
    listed = await control._research_command({"session": "sess-1", "instance": "inst-1",
                                              "operation": "research_tools"}, "research_tools")
    assert listed["tools"] == []


async def test_the_action_map_names_only_session_gated_phase_tools():
    """An action belongs here only if recording it is what the ownership gate exists to restrict.

    stop / resume / retry are deliberately absent -- the engine guards none of them with session
    ownership, so the bridge writes those itself and routing them here would only obscure that.
    """
    assert set(desktop_intervene.ACTION_TOOLS) == {
        "approve_plan", "withdraw_round", "skip_node",
        "revise_reconcile", "approve_reconcile", "consent"}
    assert not {"stop", "resume", "retry"} & set(desktop_intervene.ACTION_TOOLS)
