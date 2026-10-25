"""A read-only multi-session viewer over the original native control endpoints.

The observer owns no agent, task claim or transcript writer. Detaching this viewer
only cancels its reads; original research executions keep their own lifecycles.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import time
import uuid
from pathlib import Path

from misaka.core import session_catalog, session_control
from misaka.core.research import desktop_view
from misaka.core.session_telemetry import entries_telemetry, merge_saved_telemetry
from misaka.utils.redact import redact


class ResearchSessionObserver:
    def __init__(self, run_id, open_board, emit, *, visible_executor_ids=(), owner_resolver=None):
        self.run_id, self.open_board, self.emit = str(run_id), open_board, emit
        self.visible = set(visible_executor_ids)
        self.subscription_id = uuid.uuid4().hex
        self.owner_resolver = owner_resolver or session_catalog.owner_record
        self.states, self.cursors = {}, {}
        self.job = None
        self._inventory = None
        self._inventory_at = 0
        self._hidden_at = {}
        self._semaphore = asyncio.Semaphore(8)

    async def _emit(self, event):
        result = self.emit(event)
        if inspect.isawaitable(result):
            await result

    def _board_payload(self):
        con = self.open_board()
        if con is None:
            return None
        try:
            return desktop_view.sessions_payload(con, self.run_id)
        finally:
            con.close()

    def _saved(self, descriptor):
        path = descriptor.get("sessionFile")
        if not path:
            return None, None, "not_started"
        if not Path(path).is_file():
            return None, None, "missing"
        try:
            version = desktop_view._session_version(path)
            previous = self.states.get(descriptor["executorId"])
            if previous and any(previous.get(key) != descriptor.get(key) for key in ("sessionId", "generation", "attempt")):
                previous = None
            if previous and previous.get("historyVersion") == version:
                return version, previous.get("telemetry"), "available"
            telemetry = entries_telemetry(desktop_view._read_session(path, version), cwd=descriptor["workspace"])
            if previous and previous.get("runtimeSource") == "live":
                telemetry = merge_saved_telemetry(telemetry, previous.get("telemetry"))
            return version, telemetry, "available"
        except (OSError, ValueError, TypeError):
            return None, None, "interrupted"

    async def sample(self, descriptor):
        executor = descriptor["executorId"]
        previous = self.states.get(executor)
        if previous and any(previous.get(key) != descriptor.get(key) for key in ("sessionId", "generation", "attempt")):
            previous = None
            self.states.pop(executor, None)
            self.cursors.pop(executor, None)
        runtime_source = previous.get("runtimeSource", "saved") if previous else "saved"
        version, telemetry, availability = await asyncio.to_thread(self._saved, descriptor)
        preview, error = None, descriptor.get("error")
        native_cursor = None
        path = descriptor.get("sessionFile")
        record = (await asyncio.to_thread(self.owner_resolver, path)
                  if path and descriptor.get("isCurrent", True) else None)
        if record and (record.get("id") != descriptor.get("sessionId") or
                       record.get("task_id", descriptor.get("taskId")) != descriptor.get("taskId")):
            record = None
        if record and record.get("control"):
            # The native endpoint validates both the saved session and live instance.
            # A bounded read failure is observation loss, never a stopped card.
            try:
                async with asyncio.timeout(.8):
                    live = await session_control.request(record, "snapshot", include_entries=False,
                        telemetry=True, stream_cursor=self.cursors.get(executor))
                native_cursor = live.get("stream_cursor")
                if native_cursor == self.cursors.get(executor):
                    preview = self.states.get(executor, {}).get("streaming")
                elif live.get("streaming"):
                    preview = desktop_view._safe_messages([{"type": "message", "id": f"live:{executor}",
                        "message": live["streaming"]}])[0]
                    preview["isStreaming"] = True
                if live.get("telemetry") is not None:
                    telemetry = live["telemetry"]
                    runtime_source = "live"
                error = redact(live.get("error", error) or "") or None
                availability = "available"
            except (OSError, ValueError, TimeoutError, ConnectionError) as failure:
                availability = "interrupted"
                error = error or f"会话观测连接中断：{redact(str(failure))}"
        snapshot = {"runId": self.run_id, "executorId": executor, "sessionId": descriptor.get("sessionId"),
            "nodeId": descriptor["nodeId"], "taskId": descriptor.get("taskId"),
            "generation": descriptor["generation"], "attempt": descriptor["attempt"],
            "historyVersion": version, "streaming": preview, "telemetry": telemetry,
            "runtimeSource": runtime_source,
            "error": error, "availability": availability}
        changed = (not previous or native_cursor is not None and native_cursor != self.cursors.get(executor)
                   or any(previous.get(key) != value for key, value in snapshot.items()))
        if changed:
            snapshot["revision"] = (previous.get("revision", 0) if previous else 0) + 1
            self.states[executor] = snapshot
            await self._emit({"type": "research_session_snapshot", "snapshot": snapshot})
        if native_cursor is not None:
            self.cursors[executor] = native_cursor

    async def _bounded_sample(self, descriptor):
        async with self._semaphore:
            try:
                await self.sample(descriptor)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - a read-only viewer error must not affect the agent
                await self._emit({"type": "research_session_observation_error", "runId": self.run_id,
                    "executorId": descriptor["executorId"], "error": redact(str(error))})

    async def _run(self):
        inventory = None
        while True:
            now = time.monotonic()
            if inventory is None or now - self._inventory_at >= 1:
                inventory = await asyncio.to_thread(self._board_payload)
                self._inventory_at = now
                if inventory is None:
                    return
                stamp = json.dumps(inventory, sort_keys=True, ensure_ascii=False)
                if stamp != self._inventory:
                    self._inventory = stamp
                    await self._emit({"type": "research_sessions_changed", "payload": inventory})
            due = []
            for descriptor in inventory["sessions"]:
                executor = descriptor["executorId"]
                if executor in self.visible or now - self._hidden_at.get(executor, 0) >= 1:
                    due.append(descriptor)
                    self._hidden_at[executor] = now
            await asyncio.gather(*(self._bounded_sample(item) for item in due))
            await asyncio.sleep(.25)

    def start(self):
        if self.job is None or self.job.done():
            self.job = asyncio.create_task(self._run(), name=f"research-view:{self.run_id}")
        return self

    async def close(self):
        if self.job is not None:
            self.job.cancel()
            await asyncio.gather(self.job, return_exceptions=True)
            self.job = None
