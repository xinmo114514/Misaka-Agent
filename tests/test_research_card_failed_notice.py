"""A research card that failed for good is told of when it lands (GitHub issue #9).

What becomes of it is decided once the phase's other cards are back; until then a card could sit
failed on the board with nobody told -- in the report, until the user stopped the run."""
import asyncio
from contextlib import closing

import pytest

from misaka.core.platform import repo, tasks
from misaka.core.research import runs, workflow


@pytest.fixture
def board(tmp_path, monkeypatch):
    monkeypatch.setattr(repo, "enabled", lambda *a: False)
    monkeypatch.setattr(tasks, "task_state_dir", lambda tid: str(tmp_path / "state" / tid))
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        runs.init(con)
        yield con


def test_a_failed_card_is_told_of_once_and_an_old_failure_not_again(board, tmp_path):
    run = runs.create(board, workspace=str(tmp_path), question="How was the salt monopoly run?")
    root = runs.root(board, run["id"])
    ids = []
    for title in ("licences", "smuggling", "earlier"):
        tid = tasks.create_task(board, title, assignee="10032", workspace=str(tmp_path))
        runs.link_task(board, run["id"], tid, kind="research", node=root, local_id=title)
        ids.append(tid)
    licences, smuggling, earlier = ids
    board.execute("UPDATE tasks SET status='failed' WHERE id=?", (earlier,))
    captured = {row["id"]: row for row in runs.tasks(board, run["id"])}
    told = {(tid, row["generation"]) for tid, row in captured.items() if row["status"] == "failed"}
    tasks.add_event(board, licences, "failed", {"reason": "provider 429 three times"}, generation=1)
    board.execute("UPDATE tasks SET status='failed' WHERE id=?", (licences,))
    board.execute("UPDATE tasks SET status='running' WHERE id=?", (smuggling,))
    events = []

    def look():
        linked = runs.tasks(board, run["id"])
        asyncio.run(workflow._tell_failed(board, runs.get(board, run["id"]), linked, told, events.append))

    look()
    look()
    [event] = events
    assert event["stage"] == "card_failed" and event["task_ids"] == [licences]
    assert "failed: provider 429 three times" in event["message"]
    assert "when the other 1 card(s) of this phase are back" in event["message"]
