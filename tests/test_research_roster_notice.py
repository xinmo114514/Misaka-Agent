"""Last Order hears when the Sister roster changes while a run works (GitHub issue #9).

Every plan was made with the roster as it stood, but a Sister created or removed between two plans
was news nobody gave her: she had to look at the board to find out."""
import asyncio

from misaka.core.network import roster
from misaka.core.research import workflow
from misaka.core.research.wiring import research


def test_a_sister_added_or_removed_mid_run_is_a_notice(monkeypatch):
    listed = [{"id": "10032", "description": "Ottoman fiscal history"}]
    monkeypatch.setattr(roster, "routing_catalog", lambda root=None: list(listed))
    clock = [1000.0]
    monkeypatch.setattr(workflow.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(workflow, "_rosters", {})
    events = []
    run = {"id": "r_roster"}

    def look(after):
        clock[0] += after
        asyncio.run(workflow._roster_check({}, run, events.append))

    look(0)
    assert events == [], "the first look is the baseline"
    listed[:] = [{"id": "10077", "description": "Economic history:\nlate imperial China"}]
    look(5)
    assert events == [], "looked at most every ROSTER_CHECK_SECONDS"
    look(workflow.ROSTER_CHECK_SECONDS)
    [event] = events
    assert event["stage"] == "roster_changed" and (event["added"], event["removed"]) == (["10077"], ["10032"])
    assert "added 10077 (Economic history: late imperial China); removed 10032" in event["message"]
    look(workflow.ROSTER_CHECK_SECONDS)
    assert len(events) == 1, "said once"


def test_the_notice_is_memory_for_last_order_not_a_tick():
    assert not research._feed_noise("research-progress", {"stage": "roster_changed"})
