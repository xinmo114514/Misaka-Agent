"""The desktop's read model for what a research sub-agent actually did.

A card's drawer must show the real commands, arguments, output and errors of the instance that ran
them -- read out of the transcript the runtime already writes. Nothing here invents a duration, a
command, or a successful empty run: an absent history says so, and a task of another research reads
nothing at all.
"""
import json
import time
from contextlib import closing
from datetime import UTC, datetime

import pytest

from misaka.core.platform import repo, tasks
from misaka.core.research import desktop_view, runs


def _iso(moment_ms):
    return datetime.fromtimestamp(moment_ms / 1000, tz=UTC).isoformat()


def transcript(path, calls):
    """Write a child transcript the runtime would have written: calls, then their results."""
    lines = [json.dumps({"type": "session", "version": 3, "id": "child-1",
                         "timestamp": _iso(1_760_000_000_000), "cwd": str(path.parent)})]
    started = 1_760_000_100_000
    for index, call in enumerate(calls):
        lines.append(json.dumps({"type": "message", "id": f"e{index * 2}", "parentId": None,
          "timestamp": _iso(started + index * 1000), "message": {"role": "assistant", "content": [
            {"type": "toolCall", "id": call["id"], "name": call["name"], "arguments": call["arguments"]}]}}))
        lines.append(json.dumps({"type": "message", "id": f"e{index * 2 + 1}", "parentId": None,
          "timestamp": _iso(started + index * 1000 + 500), "message": {"role": "toolResult",
            "toolCallId": call["id"], "toolName": call["name"], "isError": call.get("failed", False),
            "content": [{"type": "text", "text": call["output"]}]}}))
    path.write_text("".join(line + "\n" for line in lines), encoding="utf-8")
    return path


@pytest.fixture
def board(tmp_path, monkeypatch):
    monkeypatch.setattr(repo, "enabled", lambda *a: False)
    monkeypatch.setattr(tasks, "task_state_dir", lambda tid: str(tmp_path / "state" / tid))
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        runs.init(con)
        yield con


def card_with_instance(board, tmp_path, calls, *, status="completed", with_transcript=True):
    tmp_path.mkdir(parents=True, exist_ok=True)
    run = runs.create(board, workspace=str(tmp_path), question="How was the salt monopoly run?")
    root = runs.root(board, run["id"])
    task_id = tasks.create_task(board, "licences", assignee="10032", workspace=str(tmp_path))
    runs.link_task(board, run["id"], task_id, kind="research", node=root, local_id="licences")
    run_id = tasks._start_run(board, task_id, 1, "worker", "claim-1", assignee="10032")
    session_file = tmp_path / "child.jsonl"
    if with_transcript and calls:
        transcript(session_file, calls)
    board.execute(
        "UPDATE task_runs SET session_file=?, status=?, completed_at=? WHERE id=?",
        (str(session_file) if with_transcript and calls else None, status, int(time.time()), run_id),
    )
    board.execute("UPDATE tasks SET status=?, current_run_id=?, agent_id=?, session_file=? WHERE id=?",
                  ("done" if status == "completed" else status, run_id, "agent-1",
                   str(session_file) if with_transcript and calls else None, task_id))
    return run, task_id, run_id


def test_a_card_reads_the_real_commands_and_results_of_its_instance(board, tmp_path):
    calls = [
        {"id": "call-1", "name": "bash", "arguments": {"command": "ls /srv/archives"}, "output": "ledger-1805.txt"},
        {"id": "call-2", "name": "read", "arguments": {"path": "/srv/archives/ledger-1805.txt"},
         "output": "no licence records before 1811", "failed": True},
    ]
    run, task_id, run_id = card_with_instance(board, tmp_path, calls)

    detail = desktop_view.execution_detail(board, run["id"], task_id)

    assert detail["availability"] == "available"
    assert [item["instanceId"] for item in detail["instances"]] == [run_id]
    assert detail["instances"][0]["status"] == "completed"
    assert detail["instances"][0]["endedAt"]
    first, second = detail["entries"]
    assert first["toolName"] == "bash"
    assert json.loads(first["arguments"])["command"] == "ls /srv/archives"
    assert first["result"] == "ledger-1805.txt"
    assert first["status"] == "success"
    assert first["endedAt"] > first["startedAt"]
    assert second["status"] == "error"
    assert second["error"] == "no licence records before 1811"


def test_a_credential_never_reaches_the_response(board, tmp_path):
    secret = "sk-live-abcdef0123456789"
    calls = [{"id": "call-1", "name": "web_fetch",
              "arguments": {"url": "https://x.test/a", "api_key": secret},
              "output": f"Authorization: Bearer {secret}"}]
    run, task_id, _run_id = card_with_instance(board, tmp_path, calls)

    detail = desktop_view.execution_detail(board, run["id"], task_id)

    body = json.dumps(detail, ensure_ascii=False)
    assert secret not in body
    entry = detail["entries"][0]
    assert json.loads(entry["arguments"])["api_key"] != secret
    assert secret not in entry["result"]


def test_a_cursor_pages_without_repeating_or_losing_records(board, tmp_path):
    calls = [{"id": f"call-{index}", "name": "read", "arguments": {"path": f"/a/{index}"},
              "output": f"body {index}"} for index in range(5)]
    run, task_id, _run_id = card_with_instance(board, tmp_path, calls)

    page = desktop_view.execution_detail(board, run["id"], task_id, limit=2)
    assert [item["toolCallId"] for item in page["entries"]] == ["call-0", "call-1"]
    assert page["hasMore"] is True
    nxt = desktop_view.execution_detail(board, run["id"], task_id, cursor=page["nextCursor"], limit=2)
    assert [item["toolCallId"] for item in nxt["entries"]] == ["call-2", "call-3"]
    last = desktop_view.execution_detail(board, run["id"], task_id, cursor=nxt["nextCursor"], limit=2)
    assert [item["toolCallId"] for item in last["entries"]] == ["call-4"]
    assert last["hasMore"] is False


def test_history_that_was_never_written_says_which_kind_of_absence_it_is(board, tmp_path):
    calls = [{"id": "call-1", "name": "read", "arguments": {}, "output": "x"}]
    run, task_id, _run_id = card_with_instance(board, tmp_path, calls, with_transcript=False)
    missing = desktop_view.execution_detail(board, run["id"], task_id)
    assert missing["availability"] == "not_started"
    assert missing["entries"] == []
    assert missing["reason"]

    run2, task2, run_id2 = card_with_instance(board, tmp_path / "other", calls)
    gone = str(tmp_path / "gone.jsonl")
    # Both pointers name the same transcript; clearing it from disk is what "missing" means.
    board.execute("UPDATE task_runs SET session_file=? WHERE id=?", (gone, run_id2))
    board.execute("UPDATE tasks SET session_file=? WHERE id=?", (gone, task2))
    gone_detail = desktop_view.execution_detail(board, run2["id"], task2)
    assert gone_detail["availability"] == "missing"
    assert gone_detail["instances"][0]["instanceId"] == run_id2


def test_an_instance_that_ended_with_an_open_call_is_reported_interrupted(board, tmp_path):
    run = runs.create(board, workspace=str(tmp_path), question="How was the salt monopoly run?")
    root = runs.root(board, run["id"])
    task_id = tasks.create_task(board, "licences", assignee="10032", workspace=str(tmp_path))
    runs.link_task(board, run["id"], task_id, kind="research", node=root, local_id="licences")
    run_id = tasks._start_run(board, task_id, 1, "worker", "claim-1", assignee="10032")
    path = tmp_path / "half.jsonl"
    transcript(path, [{"id": "call-1", "name": "bash", "arguments": {"command": "sleep 999"}, "output": ""}])
    # The result line never landed: the child was cut off mid-call.
    lines = path.read_text(encoding="utf-8").splitlines()
    path.write_text("\n".join(line for line in lines if '"toolResult"' not in line) + "\n", encoding="utf-8")
    board.execute("UPDATE task_runs SET session_file=?, status='completed', completed_at=? WHERE id=?",
                  (str(path), int(time.time()), run_id))

    detail = desktop_view.execution_detail(board, run["id"], task_id)

    assert detail["availability"] == "interrupted"
    assert detail["reason"]
    assert detail["entries"][0]["status"] == "running"


def test_a_card_of_another_research_reads_nothing(board, tmp_path):
    calls = [{"id": "call-1", "name": "read", "arguments": {}, "output": "x"}]
    run, task_id, _run_id = card_with_instance(board, tmp_path, calls)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    other = runs.create(board, workspace=str(elsewhere), question="Another question")

    assert desktop_view.execution_detail(board, other["id"], task_id) is None
    assert desktop_view.execution_detail(board, run["id"], "t_does_not_exist") is None


def test_an_unanswered_card_without_a_runtime_has_no_instances(board, tmp_path):
    run = runs.create(board, workspace=str(tmp_path), question="How was the salt monopoly run?")
    root = runs.root(board, run["id"])
    task_id = tasks.create_task(board, "waiting", assignee="10032", workspace=str(tmp_path))
    runs.link_task(board, run["id"], task_id, kind="research", node=root, local_id="waiting")

    detail = desktop_view.execution_detail(board, run["id"], task_id)

    assert detail["instances"] == []
    assert detail["availability"] == "not_started"
    assert detail["entries"] == []


async def test_the_bridge_answers_get_research_execution_from_the_board(monkeypatch, tmp_path):
    """The desktop asks by identifier only; the board decides which transcript that names."""
    import io
    import json
    import sys
    from types import SimpleNamespace

    from misaka.cli import desktop_bridge
    from misaka.config import home
    from tests.test_desktop_bridge import MockRuntimeHost, MockSession

    workspace = tmp_path / "project"
    workspace.mkdir()
    with closing(tasks.connect(str(home.path("db")))) as con:
        runs.init(con)
        run = runs.create(con, workspace=str(workspace), question="How was the salt monopoly run?")
        root = runs.root(con, run["id"])
        task_id = tasks.create_task(con, "licences", assignee="10032", workspace=str(workspace))
        runs.link_task(con, run["id"], task_id, kind="research", node=root, local_id="licences")
        run_id = tasks._start_run(con, task_id, 1, "worker", "claim-1", assignee="10032")
        path = transcript(workspace / "child.jsonl", [
            {"id": "call-1", "name": "bash", "arguments": {"command": "ls"}, "output": "ledger.txt"}])
        con.execute("UPDATE task_runs SET session_file=?, status='completed', completed_at=? WHERE id=?",
                    (str(path), int(time.time()), run_id))

    session = MockSession()
    session.moments = SimpleNamespace(parts=[])
    session.sessionManager.buildContextEntries = list
    output = io.StringIO()
    monkeypatch.setattr(desktop_bridge, "writeRawStdout", output.write)
    commands = [
        {"type": "get_research_execution", "requestId": "own", "runId": run["id"], "taskId": task_id,
         "workspace": str(workspace), "limit": 100},
        {"type": "get_research_execution", "requestId": "foreign", "runId": run["id"], "taskId": task_id,
         "workspace": str(tmp_path / "elsewhere")},
    ]
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(item) + "\n" for item in commands)))
    await desktop_bridge.run_desktop_bridge(MockRuntimeHost(session), {"desktop_research": False})

    acks = {item.get("requestId"): item for item in
            (json.loads(line) for line in output.getvalue().splitlines()) if item.get("type") == "ack"}
    own = acks["own"]
    assert own["ok"] is True, own
    execution = own["data"]["execution"]
    assert execution["availability"] == "available"
    assert [item["toolCallId"] for item in execution["entries"]] == ["call-1"]
    assert execution["entries"][0]["toolName"] == "bash"
    # The path the board resolved to is never handed back to the page.
    assert "sessionFile" not in json.dumps(execution)
    assert str(path) not in json.dumps(execution, ensure_ascii=False)
    # A workspace that does not own the run reads nothing, not even an empty success.
    assert acks["foreign"]["ok"] is True
    assert acks["foreign"]["data"]["execution"] is None
