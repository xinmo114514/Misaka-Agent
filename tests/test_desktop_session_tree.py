"""Tests for the desktop session tree and manual compaction bridge commands."""

from __future__ import annotations

import asyncio
import io
import json
import os
import sys
from typing import Any

import pytest

from misaka.cli.desktop_bridge import run_desktop_bridge


class FakeAgent:
    def __init__(self) -> None:
        self.listeners: list[Any] = []

    def subscribe(self, fn: Any) -> Any:
        self.listeners.append(fn)
        return lambda: self.listeners.remove(fn) if fn in self.listeners else None

    def abort(self) -> None:
        pass


class FakeTreeNode:
    def __init__(self, entry: dict[str, Any], children: list[Any] | None = None,
                 label: str | None = None, label_timestamp: str | None = None) -> None:
        self.entry = entry
        self.children = children or []
        self.label = label
        self.labelTimestamp = label_timestamp


class FakeSettingsManager:
    def __init__(self) -> None:
        self.tree_filter_mode = "default"
        self.skip_prompt = False
        self.filter_writes: list[str] = []

    def getTreeFilterMode(self) -> str:
        return self.tree_filter_mode

    def setTreeFilterMode(self, mode: str) -> None:
        self.filter_writes.append(mode)
        self.tree_filter_mode = mode

    def getBranchSummarySkipPrompt(self) -> bool:
        return self.skip_prompt


def message_entry(entry_id: str, role: str, text: str, timestamp: int = 1) -> dict[str, Any]:
    return {"type": "message", "id": entry_id, "parentId": None, "timestamp": timestamp,
            "message": {"role": role, "content": [{"type": "text", "text": text}]}}


class FakeSessionManager:
    """The slice of SessionManager the tree and label commands touch."""

    def __init__(self) -> None:
        self.leaf_id: str | None = "a1"
        self.labels: dict[str, str] = {}
        self.labelTimestampsById: dict[str, str] = {}
        self.label_writes: list[tuple[str, str | None]] = []
        self.tree = [
            FakeTreeNode(
                message_entry("a1", "user", "第一问"),
                [FakeTreeNode(message_entry("a2", "assistant", "第一答"))],
            ),
        ]

    def getCwd(self) -> str:
        return os.getcwd()

    def getTree(self) -> list[Any]:
        """Rebuild the nodes so labels set after construction show up, as the real manager does."""
        def relabel(node: Any) -> Any:
            entry_id = node.entry.get("id")
            return FakeTreeNode(
                node.entry,
                [relabel(child) for child in node.children],
                label=self.labels.get(entry_id),
                label_timestamp=self.labelTimestampsById.get(entry_id),
            )
        return [relabel(root) for root in self.tree]

    def getLeafId(self) -> str | None:
        return self.leaf_id

    def getEntries(self) -> list[Any]:
        entries: list[Any] = []
        def walk(nodes: list[Any]) -> None:
            for node in nodes:
                entries.append(node.entry)
                walk(node.children)
        walk(self.tree)
        return entries

    def buildContextEntries(self) -> list[Any]:
        return self.getEntries()

    def appendLabelChange(self, target_id: str, label: str | None) -> str:
        if target_id not in {entry.get("id") for entry in self.getEntries()}:
            raise ValueError(f"Entry {target_id} not found")
        self.label_writes.append((target_id, label))
        if label:
            self.labels[target_id] = label
            self.labelTimestampsById[target_id] = "2026-10-06T00:00:00.000Z"
        else:
            self.labels.pop(target_id, None)
            self.labelTimestampsById.pop(target_id, None)
        return f"label-{len(self.label_writes)}"


class FakeSession:
    def __init__(self, session_id: str = "sess-tree") -> None:
        self.sessionId = session_id
        self.sessionFile = None
        self.isStreaming = False
        self.isCompacting = False
        self.agent = FakeAgent()
        self.sessionManager = FakeSessionManager()
        self.settingsManager = FakeSettingsManager()
        self.listeners: list[Any] = []
        self.abort_count = 0
        self.branch_abort_count = 0
        self.compaction_abort_count = 0
        self.navigate_calls: list[tuple[str, Any]] = []
        self.navigate_result: dict[str, Any] = {"cancelled": False}
        self.navigate_gate: asyncio.Event | None = None
        self.compact_calls: list[Any] = []
        self.compact_error: Exception | None = None

    def subscribe(self, fn: Any) -> Any:
        self.listeners.append(fn)
        return lambda: self.listeners.remove(fn) if fn in self.listeners else None

    async def prompt(self, text: str, options: Any = None) -> None:
        if options and options.get("preflightResult"):
            options["preflightResult"](True)

    async def steer(self, text: str, images: Any = None) -> None:
        pass

    async def followUp(self, text: str, images: Any = None) -> None:
        pass

    async def abort(self) -> None:
        self.abort_count += 1
        self.isStreaming = False

    async def waitForIdle(self) -> None:
        pass

    def abortBranchSummary(self) -> None:
        self.branch_abort_count += 1

    def abortCompaction(self) -> None:
        self.compaction_abort_count += 1

    async def navigateTree(self, target_id: str, options: Any = None) -> dict[str, Any]:
        self.navigate_calls.append((target_id, options))
        if self.navigate_gate is not None:
            await self.navigate_gate.wait()
        return dict(self.navigate_result)

    async def compact(self, custom_instructions: str | None = None) -> dict[str, Any]:
        self.compact_calls.append(custom_instructions)
        if self.compact_error is not None:
            raise self.compact_error
        return {"tokensBefore": 120000, "summary": "compressed"}

    def getPermissionMode(self) -> str:
        return "default"

    async def bindExtensions(self, ext: Any) -> None:
        pass


class FakeRuntimeHost:
    def __init__(self, session: Any) -> None:
        self.session = session
        self.rebind_handler: Any = None

    def setRebindSession(self, fn: Any) -> None:
        self.rebind_handler = fn

    async def dispose(self) -> None:
        pass

def bridge_lines(output: io.StringIO) -> list[dict[str, Any]]:
    return [json.loads(line) for line in output.getvalue().splitlines() if line.strip()]


def acks_for(output: io.StringIO, request_id: str) -> list[dict[str, Any]]:
    return [line for line in bridge_lines(output) if line.get("requestId") == request_id]


def events_named(output: io.StringIO, name: str) -> list[dict[str, Any]]:
    found = []
    for line in bridge_lines(output):
        event = line.get("event")
        if isinstance(event, dict) and event.get("type") == name:
            found.append(event)
    return found


async def run_bridge(monkeypatch, session: FakeSession, commands: list[dict[str, Any]]):
    """Drive the bridge over stdin and collect everything it wrote."""
    import misaka.cli.desktop_bridge as bridge_mod

    output = io.StringIO()
    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)
    payload = "".join(json.dumps(command) + "\n" for command in commands)
    monkeypatch.setattr(sys, "stdin", io.StringIO(payload))
    assert await run_desktop_bridge(FakeRuntimeHost(session)) == 0
    return output


async def wait_for_event(output: io.StringIO, name: str, request_id: str | None = None) -> dict[str, Any]:
    """Poll the captured output, since the bridge only flushes at process end."""
    for _ in range(200):
        for event in events_named(output, name):
            if request_id is None or event.get("requestId") == request_id:
                return event
        await asyncio.sleep(0.01)
    raise AssertionError(f"{name} for {request_id} never arrived")


@pytest.mark.asyncio
async def test_get_session_tree_returns_the_nested_tree_leaf_and_settings(monkeypatch):
    session = FakeSession()
    session.sessionManager.labels["a2"] = "关键回答"
    session.sessionManager.labelTimestampsById["a2"] = "2026-10-05T10:00:00.000Z"
    session.settingsManager.tree_filter_mode = "no-tools"
    session.settingsManager.skip_prompt = True

    output = await run_bridge(monkeypatch, session, [
        {"type": "get_session_tree", "requestId": "tree-1"},
        {"type": "shutdown"},
    ])

    ack = acks_for(output, "tree-1")[0]
    assert ack["ok"] is True
    data = ack["data"]
    assert data["sessionId"] == "sess-tree"
    assert data["leafId"] == "a1"
    assert [node["entry"]["id"] for node in data["tree"]] == ["a1"]
    child = data["tree"][0]["children"][0]
    assert child["entry"]["id"] == "a2"
    assert child["label"] == "关键回答"
    assert child["labelTimestamp"] == "2026-10-05T10:00:00.000Z"
    assert data["settings"] == {"treeFilterMode": "no-tools", "branchSummarySkipPrompt": True}


@pytest.mark.asyncio
async def test_set_entry_label_persists_and_clears(monkeypatch):
    session = FakeSession()
    output = await run_bridge(monkeypatch, session, [
        {"type": "set_entry_label", "requestId": "lbl-1", "targetId": "a1", "label": "  起点  "},
        {"type": "shutdown"},
    ])
    ack = acks_for(output, "lbl-1")[0]
    assert ack["ok"] is True and ack["data"]["label"] == "起点"
    assert session.sessionManager.label_writes == [("a1", "起点")]

    session2 = FakeSession()
    session2.sessionManager.labels["a1"] = "旧标签"
    output2 = await run_bridge(monkeypatch, session2, [
        {"type": "set_entry_label", "requestId": "lbl-2", "targetId": "a1", "label": "   "},
        {"type": "shutdown"},
    ])
    assert acks_for(output2, "lbl-2")[0]["ok"] is True
    assert session2.sessionManager.label_writes == [("a1", None)]


@pytest.mark.asyncio
async def test_set_entry_label_rejects_an_unknown_entry(monkeypatch):
    session = FakeSession()
    output = await run_bridge(monkeypatch, session, [
        {"type": "set_entry_label", "requestId": "lbl-3", "targetId": "missing", "label": "x"},
        {"type": "shutdown"},
    ])
    ack = acks_for(output, "lbl-3")[0]
    assert ack["ok"] is False and "not found" in ack["error"]


@pytest.mark.asyncio
async def test_set_tree_filter_mode_writes_through_to_settings(monkeypatch):
    session = FakeSession()
    output = await run_bridge(monkeypatch, session, [
        {"type": "set_tree_filter_mode", "requestId": "flt-1", "mode": "labeled-only"},
        {"type": "set_tree_filter_mode", "requestId": "flt-2", "mode": "bogus"},
        {"type": "shutdown"},
    ])
    assert acks_for(output, "flt-1")[0]["ok"] is True
    assert session.settingsManager.filter_writes == ["labeled-only"]
    bad = acks_for(output, "flt-2")[0]
    assert bad["ok"] is False and "mode" in bad["error"]


@pytest.mark.asyncio
async def test_navigate_tree_accepts_immediately_then_reports_the_new_branch(monkeypatch):
    session = FakeSession()
    session.navigate_result = {"cancelled": False, "editorText": "第一问"}
    output = await run_bridge(monkeypatch, session, [
        {"type": "navigate_tree", "requestId": "nav-1", "targetId": "a1",
         "summarize": True, "customInstructions": "只留结论"},
        {"type": "shutdown"},
    ])

    accepted = acks_for(output, "nav-1")[0]
    assert accepted == {"type": "ack", "requestId": "nav-1", "ok": True,
                        "data": {"accepted": True, "operation": "navigate_tree"}}
    assert session.navigate_calls[0][0] == "a1"
    assert session.navigate_calls[0][1]["summarize"] is True
    assert session.navigate_calls[0][1]["customInstructions"] == "只留结论"

    ends = events_named(output, "session_operation_end")
    assert len(ends) == 1
    end = ends[0]
    assert end["status"] == "done" and end["requestId"] == "nav-1"
    assert end["editorText"] == "第一问"
    assert end["leafId"] == "a1"
    assert [message["entryId"] for message in end["messages"]] == ["a1", "a2"]


@pytest.mark.asyncio
async def test_navigate_tree_aborts_a_live_turn_before_switching(monkeypatch):
    session = FakeSession()
    session.isStreaming = True
    await run_bridge(monkeypatch, session, [
        {"type": "navigate_tree", "requestId": "nav-2", "targetId": "a1"},
        {"type": "shutdown"},
    ])
    assert session.abort_count == 1
    assert len(session.navigate_calls) == 1


@pytest.mark.asyncio
async def test_cancelled_navigation_reports_cancelled_without_messages(monkeypatch):
    session = FakeSession()
    session.navigate_result = {"cancelled": True}
    output = await run_bridge(monkeypatch, session, [
        {"type": "navigate_tree", "requestId": "nav-3", "targetId": "a2"},
        {"type": "shutdown"},
    ])
    end = events_named(output, "session_operation_end")[0]
    assert end["status"] == "cancelled"
    assert "messages" not in end


@pytest.mark.asyncio
async def test_aborted_navigation_reports_aborted(monkeypatch):
    session = FakeSession()
    session.navigate_result = {"cancelled": True, "aborted": True}
    output = await run_bridge(monkeypatch, session, [
        {"type": "navigate_tree", "requestId": "nav-4", "targetId": "a2"},
        {"type": "shutdown"},
    ])
    assert events_named(output, "session_operation_end")[0]["status"] == "aborted"


@pytest.mark.asyncio
async def test_compact_session_success_then_failure_then_cancel(monkeypatch):
    session = FakeSession()
    output = await run_bridge(monkeypatch, session, [
        {"type": "compact_session", "requestId": "cmp-1", "customInstructions": "保留实验"},
        {"type": "shutdown"},
    ])
    assert acks_for(output, "cmp-1")[0]["data"] == {"accepted": True, "operation": "compact_session"}
    assert session.compact_calls == ["保留实验"]
    end = events_named(output, "session_operation_end")[0]
    assert end["status"] == "done" and end["compaction"]["summary"] == "compressed"

    nothing = FakeSession()
    nothing.compact_error = RuntimeError("Nothing to compact")
    out2 = await run_bridge(monkeypatch, nothing, [
        {"type": "compact_session", "requestId": "cmp-2"},
        {"type": "shutdown"},
    ])
    failed = events_named(out2, "session_operation_end")[0]
    assert failed["status"] == "error" and failed["error"] == "Nothing to compact"

    cancelled = FakeSession()
    cancelled.compact_error = RuntimeError("Compaction cancelled")
    out3 = await run_bridge(monkeypatch, cancelled, [
        {"type": "compact_session", "requestId": "cmp-3"},
        {"type": "shutdown"},
    ])
    aborted = events_named(out3, "session_operation_end")[0]
    assert aborted["status"] == "aborted"


@pytest.mark.asyncio
async def test_a_long_operation_accepts_a_cancel_while_it_is_still_running(monkeypatch):
    session = FakeSession()
    session.navigate_gate = asyncio.Event()
    output = io.StringIO()
    import misaka.cli.desktop_bridge as bridge_mod

    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(command) + "\n" for command in [
        {"type": "navigate_tree", "requestId": "nav-5", "targetId": "a1"},
        {"type": "cancel_session_operation", "requestId": "cancel-1", "operationRequestId": "nav-5"},
        {"type": "shutdown"},
    ])))

    bridge_task = asyncio.create_task(run_desktop_bridge(FakeRuntimeHost(session)))
    try:
        # The command loop must stay free to serve the cancel while the navigation awaits.
        await wait_for_event(output, "session_operation_start", "nav-5")
        for _ in range(200):
            if acks_for(output, "cancel-1"):
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("the cancel command was never served")
        assert acks_for(output, "cancel-1")[0]["ok"] is True
        assert session.branch_abort_count == 1
    finally:
        session.navigate_gate.set()
        assert await asyncio.wait_for(bridge_task, 10) == 0


@pytest.mark.asyncio
async def test_cancel_without_an_operation_is_refused(monkeypatch):
    session = FakeSession()
    output = await run_bridge(monkeypatch, session, [
        {"type": "cancel_session_operation", "requestId": "cancel-2"},
        {"type": "shutdown"},
    ])
    ack = acks_for(output, "cancel-2")[0]
    assert ack["ok"] is False and "No session operation" in ack["error"]


@pytest.mark.asyncio
async def test_mutating_commands_wait_for_the_running_operation(monkeypatch):
    session = FakeSession()
    session.navigate_gate = asyncio.Event()
    output = io.StringIO()
    import misaka.cli.desktop_bridge as bridge_mod

    monkeypatch.setattr(bridge_mod, "writeRawStdout", output.write)
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(command) + "\n" for command in [
        {"type": "navigate_tree", "requestId": "nav-6", "targetId": "a1"},
        {"type": "prompt", "requestId": "blocked-prompt", "text": "你好"},
        {"type": "set_entry_label", "requestId": "blocked-label", "targetId": "a2", "label": "x"},
        {"type": "navigate_tree", "requestId": "blocked-nav", "targetId": "a2"},
        {"type": "shutdown"},
    ])))

    bridge_task = asyncio.create_task(run_desktop_bridge(FakeRuntimeHost(session)))
    try:
        await wait_for_event(output, "session_operation_start", "nav-6")
        for _ in range(300):
            if acks_for(output, "blocked-nav"):
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("guarded commands were never answered")
        for request_id in ("blocked-prompt", "blocked-label", "blocked-nav"):
            ack = acks_for(output, request_id)[0]
            assert ack["ok"] is False
            assert "session operation" in ack["error"]
        assert session.sessionManager.label_writes == []
    finally:
        session.navigate_gate.set()
        assert await asyncio.wait_for(bridge_task, 10) == 0


@pytest.mark.asyncio
async def test_a_settled_operation_releases_the_guard(monkeypatch):
    session = FakeSession()
    output = await run_bridge(monkeypatch, session, [
        {"type": "navigate_tree", "requestId": "nav-7", "targetId": "a1"},
        {"type": "set_entry_label", "requestId": "after-label", "targetId": "a2", "label": "收尾"},
        {"type": "shutdown"},
    ])
    assert acks_for(output, "nav-7")[0]["ok"] is True
    after = acks_for(output, "after-label")[0]
    assert after["ok"] is True, after
    assert session.sessionManager.label_writes == [("a2", "收尾")]
