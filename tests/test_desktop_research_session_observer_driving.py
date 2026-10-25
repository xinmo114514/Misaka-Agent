"""The live session observer is the desktop's only push channel for a run's ownership.

A run whose driver lease changes must reach the desktop even when nothing else about the run
moved: the resume entry is decided from that push, so a driver appearing or dying while the
card counts stay still has to produce a `research_sessions_changed` event carrying the new
`driving` value.
"""
import asyncio
from contextlib import closing

from misaka.core.platform import tasks
from misaka.core.research import desktop_view, runs
from misaka.desktop_research.session_observer import ResearchSessionObserver


def _observer(tmp_path, run_id, events):
    def open_board():
        return tasks.connect(str(tmp_path / "board.db"))

    async def emit(event):
        events.append(event)

    return ResearchSessionObserver(run_id, open_board, emit, visible_executor_ids=[])


async def _settle(seconds=0.05):
    await asyncio.sleep(seconds)


async def _wait_for(predicate, *, timeout=5.0):
    """Wait until the observer has pushed what the test is about, instead of guessing a delay."""
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.02)
    return False


async def test_only_the_driver_lease_changing_still_pushes_a_session_list_event(tmp_path):
    workspace = tmp_path / "project"
    workspace.mkdir()
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        runs.init(con)
        run = runs.create(con, workspace=str(workspace), question="A question")
    events = []
    observer = _observer(tmp_path, run["id"], events)

    # The observer publishes its inventory once a second; the lease changes in between.
    observer.job = asyncio.create_task(observer._run())
    assert await _wait_for(lambda: any(e["type"] == "research_sessions_changed" for e in events))
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        con.execute("UPDATE research_runs SET driver_lock=?, driver_expires=? WHERE id=?",
                    ("driver:elsewhere:4242:lease", 9999999999, run["id"]))
        con.commit()
    assert await _wait_for(lambda: sum(e["type"] == "research_sessions_changed" for e in events) >= 2)
    await observer.close()

    listings = [event for event in events if event["type"] == "research_sessions_changed"]
    assert listings, events
    assert [item["payload"]["run"]["driving"] for item in listings] == [False, True]
    # The board row itself did not change: same task/node counts, same status and phase.
    first, second = listings[0]["payload"]["run"], listings[-1]["payload"]["run"]
    assert {key: first[key] for key in ("status", "phase", "tasks", "nodes")} == \
        {key: second[key] for key in ("status", "phase", "tasks", "nodes")}
    assert second["driving"] is True


async def test_the_list_event_reports_the_board_value_never_a_derived_one(tmp_path):
    workspace = tmp_path / "project"
    workspace.mkdir()
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        runs.init(con)
        run = runs.create(con, workspace=str(workspace), question="A question")
        runs.set_state(con, run["id"], status="active", phase="executing")
        # A lease that has already expired is not a driver: resumable, not "driving".
        con.execute("UPDATE research_runs SET driver_lock=?, driver_expires=1 WHERE id=?",
                    ("driver:elsewhere:4242:stale", run["id"]))
        con.commit()
        expected = runs.driver_is_live(runs.get(con, run["id"]))

    events = []
    observer = _observer(tmp_path, run["id"], events)
    observer.job = asyncio.create_task(observer._run())
    assert await _wait_for(lambda: any(e["type"] == "research_sessions_changed" for e in events))
    await observer.close()

    listing = next(event for event in events if event["type"] == "research_sessions_changed")
    assert listing["payload"]["run"]["driving"] is expected is False
    assert desktop_view.sessions_payload(
        tasks.connect(str(tmp_path / "board.db")), run["id"])["run"]["driving"] is expected
