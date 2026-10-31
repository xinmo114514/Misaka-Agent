"""The research ownership gates compare two absolute paths, and one contract makes that true.

``runs.set_state``/``set_node``/``record_action`` write ``root_session`` and ``session_file``
through ``home.stored``, so the board holds a home-relative POSIX path -- every research
conversation lives under the home (``config/sessions.py`` -> ``home.path("sessions")``).
``platform.tasks.Row`` then expands exactly those columns (``HOME_POINTERS``) back to absolute on
*named* access, which is how ``research.commands`` reads them.

That expansion is the only thing reconciling the stored pointer with
``ctx.sessionManager.sessionFile``, which ``SessionManager.setSessionFile`` runs through
``resolve_path``. Lose it and every plan approval, skip, reconciliation and consent raises
"must come from the owning Last Order conversation" the moment a run is driven from the project
directory rather than the home -- which is how runs actually get driven
(``research.window`` -> ``role_session_setup(..., run["workspace"], ...)``).

These tests therefore hold under ``chdir(workspace)``, which older tests never do: they hand the
gates a bare ``"fixture.jsonl"`` name, where both sides resolve identically whatever cwd is, so
the question never arises. Positional row access is asserted alongside named access because it
returns the *raw* value -- the trap for any bridge that reads a pointer by index.
"""

import os
from contextlib import closing
from types import SimpleNamespace

import pytest

from misaka.config import home
from misaka.core.extensions.types import ToolDefinition
from misaka.core.platform import repo, tasks
from misaka.core.research import commands, planner, runs

PLAN = {"status": "ready", "plan_markdown": "Fixture plan",
        "red_team": {"assignee": "10032", "reason": "reads both jobs from her profile"},
        "tasks": [{"local_id": "a", "title": "A", "question": "What does A establish?",
                   "rationale": "Because the conclusion needs it.",
                   "deliverable": "a.md -- what A establishes", "assignee": "10032",
                   "assignee_reason": "She works on this period.", "dependencies": []}]}


@pytest.fixture
def env(tmp_path, monkeypatch):
    """A home, a project directory the driver runs in, a board, and a root conversation."""
    home_root, workspace = tmp_path / "home", tmp_path / "project"
    home_root.mkdir()
    workspace.mkdir()
    monkeypatch.setenv("MISAKA_HOME", str(home_root))
    monkeypatch.setattr(repo, "enabled", lambda *a: False)
    monkeypatch.setattr(tasks, "task_state_dir", lambda tid: str(tmp_path / "state" / tid))

    directory = home.path("sessions") / "last_order" / "window"
    directory.mkdir(parents=True, exist_ok=True)
    window = directory / "root.jsonl"
    window.write_text("", encoding="utf-8")

    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        runs.init(con)
        yield SimpleNamespace(con=con, workspace=workspace, window=str(window),
                              stranger=str(directory / "stranger.jsonl"))


def awaiting(con, env, *, node_level):
    """A run whose plan waits for the user, owned by the root window, as the driver leaves it."""
    run = runs.create(con, workspace=str(env.workspace), question="Pointer form",
                      limits={"plan_approval": True})
    node = runs.nodes(con, run["id"])[0]
    if node_level:
        node = runs.create_node(con, run["id"], question="Child", parents=[node["id"]])
    runs.set_state(con, run["id"], root_session=env.window)
    runs.set_node(con, node["id"], session_file=env.window, status="awaiting_approval")
    runs.record_action(con, runs.get(con, run["id"]), runs.node(con, node["id"]), runs.plan_key(1),
                       PLAN, session_file=env.window, tool_call_id="tc-plan")
    return runs.get(con, run["id"]), runs.node(con, node["id"])


def ctx_for(path):
    """What a tool call sees as its own conversation, in the shape SessionManager produces."""
    return SimpleNamespace(sessionManager=SimpleNamespace(sessionFile=path))


def named(tools, name):
    tool = next((item for item in tools if item.name == name), None)
    assert tool is not None, f"{name} is not among {[item.name for item in tools]}"
    return tool


def review_tools_for(con, run, node, *, validate=lambda value: value, round=1, forks=False):
    """``session_file`` exactly as ``workflow._await_approval`` derives it (workflow.py:1551)."""
    current = runs.node(con, node["id"])
    return commands.review_tools(con, run, current,
                                 session_file=current["session_file"] or run["root_session"],
                                 round=round, forks=forks, validate=validate)


def test_pointers_are_stored_relative_and_read_absolute(env):
    """The contract the ownership gates rest on."""
    run, node = awaiting(env.con, env, node_level=False)
    stored_run = env.con.execute("SELECT root_session FROM research_runs WHERE id=?",
                                 (run["id"],)).fetchone()[0]
    stored_node = env.con.execute("SELECT session_file FROM research_execution WHERE id=?",
                                  (node["id"],)).fetchone()[0]
    # The board keeps the portable home-relative name...
    assert stored_run and not os.path.isabs(stored_run)
    assert stored_node and not os.path.isabs(stored_node)
    # ...and named access hands back something that compares with an absolute ctx path.
    assert run["root_session"] == os.path.realpath(env.window)
    assert node["session_file"] == os.path.realpath(env.window)


def test_positional_access_is_the_raw_pointer_not_the_window(env):
    """Reading a HOME_POINTERS column by index skips the expansion: the bridge must read by name."""
    run, _ = awaiting(env.con, env, node_level=False)
    row = env.con.execute("SELECT * FROM research_runs WHERE id=?", (run["id"],)).fetchone()
    index = row.keys().index("root_session")
    assert row[index] != run["root_session"]
    assert not os.path.isabs(row[index])


async def test_root_plan_gate_accepts_the_owning_conversation(env, monkeypatch):
    run, node = awaiting(env.con, env, node_level=False)
    monkeypatch.chdir(env.workspace)          # a run is driven from the project, not the home

    start = named(review_tools_for(env.con, run, node), "misaka_research_start")
    result = await start.execute("tc-start", {"summary": "go"}, None, None, ctx_for(env.window))

    assert "Started" in result["content"][0]["text"]
    recorded = runs.action(env.con, run["id"], node["id"], runs.start_key(1))
    assert recorded["tool_call_id"] == "tc-start"
    # The causal linkage the driver re-checks (runs.py:1441, workflow.py:1591).
    assert recorded["payload"]["plan_tool_call_id"] == "tc-plan"


async def test_root_revise_gate_accepts_the_owning_conversation(env, monkeypatch):
    run, node = awaiting(env.con, env, node_level=False)
    monkeypatch.chdir(env.workspace)

    revise = named(review_tools_for(env.con, run, node), "misaka_research_assign")
    result = await revise.execute("tc-plan-2", {**PLAN, "plan_markdown": "Revised"},
                                  None, None, ctx_for(env.window))

    assert "keeps waiting" in result["content"][0]["text"]
    assert runs.action(env.con, run["id"], node["id"], runs.plan_key(1))["payload"]["plan_markdown"] == "Revised"


async def test_node_level_skip_gate_accepts_the_owning_conversation(env, monkeypatch):
    """``misaka_research_skip`` exists only for a non-root node's first plan (commands.py:391-394)."""
    run, node = awaiting(env.con, env, node_level=True)
    monkeypatch.chdir(env.workspace)

    skip = named(review_tools_for(env.con, run, node), "misaka_research_skip")
    result = await skip.execute("tc-skip", {"reason": "not this path"}, None, None, ctx_for(env.window))

    assert "Skipped" in result["content"][0]["text"]
    assert runs.action(env.con, run["id"], node["id"], runs.SKIP_KEY) is not None


async def test_reconcile_and_consent_gates_accept_the_run_root_window(env, monkeypatch):
    """Both take ``run["root_session"]`` straight from the row (workflow.py:2162, :2209)."""
    run, node = awaiting(env.con, env, node_level=False)
    monkeypatch.chdir(env.workspace)
    ctx = ctx_for(env.window)

    tools = commands.reconcile_review_tools(env.con, run, round=1, validate=lambda value: value,
                                            session_file=run["root_session"])
    with pytest.raises(ValueError, match="No reconciliation is waiting"):
        await named(tools, "misaka_research_start").execute("tc-x", {"summary": "go"}, None, None, ctx)

    consent = commands.consent_tool(env.con, run, session_file=run["root_session"])
    result = await consent.execute("tc-consent", {"agreed": True, "note": "user agreed"}, None, None, ctx)
    assert "the user agreed" in result["content"][0]["text"]


async def test_recorded_command_gate_checks_the_conversation_directory_too(env, monkeypatch):
    """The generic ``tool()`` compares ``dirname`` against ``session_dir`` as well (commands.py:294),
    and for the root that directory is ``os.path.dirname(run["root_session"])``."""
    run, node = awaiting(env.con, env, node_level=False)
    current = runs.node(env.con, node["id"])
    monkeypatch.chdir(env.workspace)

    tool = commands.tool(
        env.con, run, current, key="probe", name="misaka_research_probe",
        description="probe", model=commands.Start, validate=lambda value: value,
        session_dir=planner._lo_session(run, current),
        session_file=planner.lo_session_file(run, current))
    result = await tool.execute("tc-probe", {"summary": "go"}, None, None, ctx_for(env.window))
    assert "Accepted" in result["content"][0]["text"]


async def test_erratum_gate_accepts_the_owning_conversation(env, monkeypatch):
    run, node = awaiting(env.con, env, node_level=True)
    root = runs.nodes(env.con, run["id"])[0]
    monkeypatch.chdir(env.workspace)

    tool = commands.erratum_tool(env.con, run, runs.node(env.con, node["id"]),
                                 session_file=run["root_session"])
    result = await tool.execute("tc-erratum", {"node": root["id"], "claim": "said X",
                                               "correction": "actually Y", "grounds": "the source says Y"},
                                None, None, ctx_for(env.window))
    assert "Recorded the correction" in result["content"][0]["text"]


async def test_a_stranger_conversation_is_still_refused(env, monkeypatch):
    """The gate still discriminates: only the owning conversation may command a run."""
    run, node = awaiting(env.con, env, node_level=True)
    open(env.stranger, "w", encoding="utf-8").close()
    monkeypatch.chdir(env.workspace)
    tools = review_tools_for(env.con, run, node)

    with pytest.raises(ValueError, match="owning Last Order conversation"):
        await named(tools, "misaka_research_start").execute(
            "tc-start", {"summary": "go"}, None, None, ctx_for(env.stranger))

    with pytest.raises(ValueError, match="owning Last Order conversation"):
        await named(tools, "misaka_research_skip").execute(
            "tc-skip", {"reason": "no"}, None, None, ctx_for(env.stranger))

    assert runs.action(env.con, run["id"], node["id"], runs.start_key(1)) is None
    assert runs.action(env.con, run["id"], node["id"], runs.SKIP_KEY) is None


async def test_a_missing_conversation_path_is_refused(env, monkeypatch):
    run, node = awaiting(env.con, env, node_level=False)
    monkeypatch.chdir(env.workspace)
    tools = review_tools_for(env.con, run, node)

    with pytest.raises(ValueError, match="owning Last Order conversation"):
        await named(tools, "misaka_research_start").execute(
            "tc-start", {"summary": "go"}, None, None, SimpleNamespace(sessionManager=None))
    with pytest.raises(ValueError, match="owning Last Order conversation"):
        await named(tools, "misaka_research_start").execute(
            "tc-start", {"summary": "go"}, None, None, SimpleNamespace())


async def test_a_home_cwd_process_is_not_a_special_case(env, monkeypatch):
    """The same pointer must pass when the process happens to sit in the home, too."""
    run, node = awaiting(env.con, env, node_level=False)
    monkeypatch.chdir(str(home.home()))

    start = named(review_tools_for(env.con, run, node), "misaka_research_start")
    result = await start.execute("tc-start", {"summary": "go"}, None, None, ctx_for(env.window))
    assert "Started" in result["content"][0]["text"]


def test_review_tools_publish_only_the_actions_legal_for_this_node(env):
    """Which buttons a GUI may draw is decided by node kind and round, not by the caller.

    ``_await_approval`` hands back this list and un-registers it when the wait ends
    (workflow.py:1577-1603), so it is the only honest source of affordances.
    """
    root_run, root = awaiting(env.con, env, node_level=False)
    assert {t.name for t in review_tools_for(env.con, root_run, root, round=1)} == {
        "misaka_research_assign", "misaka_research_start"}

    child_run, child = awaiting(env.con, env, node_level=True)
    assert {t.name for t in review_tools_for(env.con, child_run, child, round=1)} == {
        "misaka_research_assign", "misaka_research_start", "misaka_research_skip"}
    # Withdrawing a follow-up round is only offered once there is a round to withdraw.
    assert {t.name for t in review_tools_for(env.con, child_run, child, round=2)} >= {
        "misaka_research_withdraw"}
    assert all(isinstance(t, ToolDefinition) for t in review_tools_for(env.con, child_run, child, round=2))
