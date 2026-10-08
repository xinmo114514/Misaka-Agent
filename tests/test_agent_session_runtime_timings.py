"""Replacement phases expose numeric durations without logging conversation data."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from misaka.core.agent_session_runtime import AgentSessionRuntime


@pytest.mark.asyncio
async def test_teardown_records_abort_shutdown_and_disposal_timings() -> None:
    events: list[str] = []

    async def abort() -> None:
        events.append("abort")

    async def emit(event) -> None:
        events.append("extension shutdown")

    async def shutdown(event) -> None:
        events.append("moment shutdown")

    session = SimpleNamespace(
        abort=abort,
        extensionRunner=SimpleNamespace(emit=emit, has_handlers=lambda _: True),
        moments=SimpleNamespace(session_shutdown=shutdown),
        dispose=lambda: events.append("dispose"),
    )
    runtime = AgentSessionRuntime(session, SimpleNamespace(cwd="."), lambda _: None)
    await runtime.teardownCurrent("resume")
    assert events == ["abort", "moment shutdown", "extension shutdown", "dispose"]
    assert {"abortMs", "shutdownMs", "disposeMs"} <= runtime.lastSwitchTimings.keys()
    assert all(isinstance(value, (int, float)) and value >= 0 for value in runtime.lastSwitchTimings.values())
