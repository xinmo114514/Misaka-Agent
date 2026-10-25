"""Task 2 contract: executors close, settle and retry; no request is dropped or leaked.

The 2026-10-11 regression: release_session unregistered a live executor whose request had not
been released yet, raising "Executor still has active requests" inside dispose, which surfaced as
a worker crash even though the card's own work had settled. The contract here: mark closing, drain
the request, unregister only after a clean release, keep a pending settlement retryable, and never
turn a successful business result into a crash.
"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from misaka.desktop_research.model_policy import (
    DesktopTeamModelPolicy,
    ModelPolicyPaused,
)
from misaka.desktop_research.runtime import DesktopExecutionScope, retry_end_request


def policy(tmp_path):
    return DesktopTeamModelPolicy(tmp_path / "model-policy.json", "a", "same")


def scope_over(monkeypatch, tmp_path):
    p = policy(tmp_path)
    scope = DesktopExecutionScope.__new__(DesktopExecutionScope)
    scope.policy = p
    scope.sessions = {}
    scope.idle_jobs = {}
    scope.releasing = {}
    return scope


async def test_closing_stops_new_admission_and_releases_after_drain(tmp_path):
    p = policy(tmp_path)
    p.register_executor("worker")
    ticket = p.begin_request("worker")

    assert p.begin_closing("worker") is True
    with pytest.raises(ModelPolicyPaused):
        p.begin_request("worker")
    # Still drained: the settlement must report pending while the request is live.
    assert p.settle_executor("worker") == "pending"
    p.end_request(ticket)
    assert p.settle_executor("worker") == "settled"
    assert json.loads(p.path.read_text(encoding="utf-8"))["executors"] == {}
    with pytest.raises(ValueError):
        p.begin_request("worker")


async def test_release_session_reports_pending_and_retries(tmp_path):
    scope = scope_over(None, tmp_path)
    p = scope.policy
    p.register_executor("root")
    ticket = p.begin_request("root")
    session = SimpleNamespace(_desktop_executor_id="root", _desktop_active_streams=set())
    scope.sessions[id(session)] = session

    status = await scope.release_session(session, timeout=0.3)
    assert status == "cleanup_pending"
    assert id(session) in scope.sessions  # a pending settlement keeps its object for the retry

    p.end_request(ticket)
    status = await scope.release_session(session, timeout=1.0)
    assert status == "settled"
    assert id(session) not in scope.sessions
    assert json.loads(p.path.read_text(encoding="utf-8"))["executors"] == {}


async def test_release_retries_a_transient_end_request_failure():
    calls = []

    class FlakyPolicy:
        def end_request(self, ticket):
            calls.append(ticket)
            if len(calls) == 1:
                raise ValueError("transient")

    await retry_end_request(FlakyPolicy(), {"requestId": "r1"}, attempts=3, delay=0.01)
    assert len(calls) == 2


async def test_release_session_closes_registered_streams_before_settling(tmp_path):
    scope = scope_over(None, tmp_path)
    p = scope.policy
    p.register_executor("root")
    closed = []

    class Stream:
        async def aclose(self):
            closed.append(True)

    session = SimpleNamespace(_desktop_executor_id="root", _desktop_active_streams={Stream()})
    scope.sessions[id(session)] = session
    status = await scope.release_session(session, timeout=1.0)
    assert status == "settled" and closed == [True]


async def test_cancel_startup_cancels_and_gathers_every_owned_task(tmp_path):
    scope = scope_over(None, tmp_path)
    cancelled = []

    async def long_running():
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            cancelled.append(True)
            raise

    tasks = [asyncio.create_task(long_running()) for _ in range(2)]
    await asyncio.sleep(0)   # let both coroutines actually start before the cancel
    part = SimpleNamespace(_starts=set(tasks))
    scope.session = SimpleNamespace(moments=SimpleNamespace(parts=[part]))

    results = await scope.cancel_startup_now()
    assert len(cancelled) == 2
    assert all(task.done() for task in tasks)
    assert all(isinstance(item, asyncio.CancelledError) for item in results)
