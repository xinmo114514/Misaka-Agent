"""The user speaks to a running research run (GitHub issue #9).

Every live session opens an input socket (``misaka chat --attach``), a research node's Last Order
included, but nothing named the node's conversation to the user: a word for a node meant finding
its session file by hand. `/research tell` and `misaka research --tell` find it."""
import asyncio
from contextlib import closing

import pytest

from misaka.core import session_catalog, session_control
from misaka.core.platform import repo, tasks
from misaka.core.research import runs, window
from misaka.core.research.wiring import research


@pytest.fixture
def board(tmp_path, monkeypatch):
    monkeypatch.setattr(repo, "enabled", lambda *a: False)
    monkeypatch.setattr(tasks, "task_state_dir", lambda tid: str(tmp_path / "state" / tid))
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        runs.init(con)
        yield con


@pytest.fixture
def graph(board, tmp_path, monkeypatch):
    """A run whose root and one child are running, and a second child that is not."""
    run = runs.create(board, workspace=str(tmp_path), question="How was the salt monopoly run?")
    root = runs.root(board, run["id"])
    with tasks.write_txn(board):
        child = runs.create_node(board, run["id"], question="Who bought the licences?", parents=[root["id"]])
        idle = runs.create_node(board, run["id"], question="Who smuggled?", parents=[root["id"]])
    sessions = {root["id"]: str(tmp_path / "root.jsonl"), child["id"]: str(tmp_path / "child.jsonl"),
                idle["id"]: str(tmp_path / "idle.jsonl")}
    runs.set_state(board, run["id"], root_session=sessions[root["id"]])
    for node_id in (child["id"], idle["id"]):
        runs.set_node(board, node_id, session_file=sessions[node_id])
    live = {sessions[root["id"]]: "root-session", sessions[child["id"]]: "child-session"}
    monkeypatch.setattr(session_catalog, "owner_record",
                        lambda path: {"id": live.get(path, "gone"), "path": path, "control": f"{path}.sock"})
    monkeypatch.setattr(session_catalog, "live_session",
                        lambda sid: {"id": sid, "path": next(p for p, s in live.items() if s == sid),
                                     "control": "socket"} if sid in live.values() else None)
    sent = []

    async def request(record, operation, **arguments):
        sent.append((record["id"], operation, arguments))
        return "Delivered"

    monkeypatch.setattr(session_control, "request", request)
    return runs.get(board, run["id"]), root, child, idle, sent


def test_the_root_hears_when_no_node_is_named(board, graph):
    run, _root, _child, _idle, sent = graph
    path = asyncio.run(window.tell(board, run, "  Only two Sisters per node, please.  "))
    assert sent == [("root-session", "input", {"text": "Only two Sisters per node, please."})]
    assert path.endswith("root.jsonl")


def test_a_named_node_hears(board, graph):
    run, _root, child, _idle, sent = graph
    asyncio.run(window.tell(board, run, "Look at the Lianghuai salt yards first.", node_id=child["id"]))
    assert sent == [("child-session", "input", {"text": "Look at the Lianghuai salt yards first."})]


def test_a_node_that_is_not_running_says_who_is(board, graph):
    run, root, child, idle, sent = graph
    with pytest.raises(ValueError, match=f"node {idle['id']} is not running now") as refused:
        asyncio.run(window.tell(board, run, "Hello", node_id=idle["id"]))
    assert root["id"] in str(refused.value) and child["id"] in str(refused.value)
    with pytest.raises(ValueError, match="has no node b_nothere"):
        asyncio.run(window.tell(board, run, "Hello", node_id="b_nothere"))
    with pytest.raises(ValueError, match="Say what"):
        asyncio.run(window.tell(board, run, "   "))
    assert sent == []


@pytest.mark.parametrize("line, expected", [
    ("tell Only two Sisters, please.", {"run_id": None, "node_id": None, "text": "Only two Sisters, please."}),
    ("tell r_0123456789 --to b_abcdef0123 Don't open more forks.",
     {"run_id": "r_0123456789", "node_id": "b_abcdef0123", "text": "Don't open more forks."}),
    ("tell --to b_abcdef0123 What's slowing you?", {"run_id": None, "node_id": "b_abcdef0123", "text": "What's slowing you?"}),
])
def test_the_panel_command(line, expected):
    assert research.parse_command(line) == {"action": "tell", **expected}


@pytest.mark.parametrize("line", ["tell", "tell r_0123456789", "tell --to", "tell --to b_abcdef0123"])
def test_the_panel_command_wants_words(line):
    with pytest.raises(ValueError):
        research.parse_command(line)


def test_the_cli_tells_and_says_where_the_answer_is(board, graph, monkeypatch, capsys):
    from types import SimpleNamespace

    from misaka.cli import app
    run, _root, child, _idle, sent = graph
    monkeypatch.setattr(app, "current_config", lambda: {"db": "board.db", "profiles_root": "no-profiles"})
    monkeypatch.setattr(app.db, "connect", lambda path: board)
    app._cmd_research(SimpleNamespace(node=None, runner_key=None, tell=run["id"], to=child["id"],
                                      goal="Look at the salt yards.", limits=None, resume=None))
    assert sent == [("child-session", "input", {"text": "Look at the salt yards."})]
    assert "misaka chat --attach --session" in capsys.readouterr().out
