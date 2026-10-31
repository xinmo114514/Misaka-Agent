"""Read-only multi-pane projection of real research executions."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_desktop_research_execution import (
    board as board,  # noqa: PLC0414 - explicit pytest fixture re-export
)
from test_desktop_research_execution import card_with_instance
from test_session_streaming_snapshot import assistant, fixture_session

from misaka.core.platform import tasks
from misaka.core.research import desktop_view, runs
from misaka.core.session_control import SessionControl


def test_inventory_keeps_coordinator_and_independent_card_identity(board, tmp_path):
    run, task_id, execution_id = card_with_instance(board, tmp_path, [
        {"id": "web-1", "name": "web_search", "arguments": {"query": "salt"}, "output": "source"}])
    inventory = desktop_view.sessions_payload(board, run["id"])
    assert inventory["runId"] == run["id"]
    assert len(inventory["sessions"]) == 2
    coordinator, card = inventory["sessions"]
    assert coordinator["role"] == "last_order"
    assert card["executorId"] == execution_id and card["taskId"] == task_id
    assert card["sessionId"] == "child-1" and card["nodeId"] == coordinator["nodeId"]
    assert card["status"] == "done"


def test_completed_coordinator_does_not_project_a_previous_stops_error_as_current(board, tmp_path):
    run, _, _ = card_with_instance(board, tmp_path, [
        {"id": "c", "name": "read", "arguments": {}, "output": "source"}])
    root = runs.root(board, run['id'])
    board.execute("UPDATE research_execution SET status='closed',last_error='previous quota stop' WHERE id=?", (root['id'],))
    runs.set_state(board, run['id'], status='done')
    coordinator = desktop_view.session_descriptors(board, run['id'])[0]
    assert coordinator['status'] == 'done'
    assert coordinator['error'] is None


def test_node_queue_exposes_native_card_dependencies_without_title_matching(board, tmp_path):
    from misaka.core.platform import cards, tasks
    run, parent, _ = card_with_instance(board, tmp_path, [
        {"id": "c", "name": "read", "arguments": {}, "output": "source"}])
    node = runs.root(board, run['id'])
    child = cards.create(board, str(tmp_path), 'licences', 'Research comparison', 'fixture')
    runs.link_task(board, run['id'], child, kind='research', node=node, local_id='follow-up')
    tasks.link_dependencies(board, [parent], child)
    cards = desktop_view.sessions_payload(board, run['id'])['graph']['nodes'][0]['cards']
    projected = next(card for card in cards if card['id'] == child)
    assert projected['local_id'] == 'follow-up'
    assert projected['dependencies'] == [parent]


@pytest.mark.parametrize("previous_status", ["completed", "failed"])
def test_reopened_card_has_current_pending_generation_beside_historical_execution(board, tmp_path, previous_status):
    run, task_id, old_execution = card_with_instance(board, tmp_path,
        [{"id": "read", "name": "read", "arguments": {}, "output": "old evidence"}], status=previous_status)
    old = tasks.get(board, task_id)
    assert tasks.reopen_task(board, task_id, target_status="ready", expected_generation=old["generation"])
    current = tasks.get(board, task_id)
    descriptors = [item for item in desktop_view.session_descriptors(board, run["id"])
                   if item["taskId"] == task_id]
    assert len(descriptors) == 2
    history, pending = descriptors
    assert history["executorId"] == old_execution and history["isCurrent"] is False
    assert history["sessionId"] == "child-1"
    assert pending["executorId"] == f"card:{task_id}:g{current['generation']}:pending"
    assert pending["generation"] == current["generation"] and pending["isCurrent"] is True
    assert pending["status"] == "ready" and pending["sessionId"] is None
    assert pending["sessionFile"] is None
    assert desktop_view.session_history(board, run["id"], pending["executorId"])["availability"] == "not_started"


def test_transcript_pages_show_actual_tools_and_keep_large_result_retrievable(board, tmp_path):
    result = "evidence " * 9000
    run, _, execution_id = card_with_instance(board, tmp_path, [
        {"id": "web-1", "name": "web_search", "arguments": {"query": "salt"}, "output": result},
        {"id": "read-2", "name": "read", "arguments": {"path": "notes.md"}, "output": "uncertain"}])
    page = desktop_view.session_history(board, run["id"], execution_id, limit=1)
    assert len(page["messages"]) == 1 and page["hasMore"]
    assert page["messages"][0]["toolCalls"][0]["name"] == "read"
    next_page = desktop_view.session_history(board, run["id"], execution_id, cursor=page["nextCursor"], limit=1)
    assert next_page["messages"][0]["id"] != page["messages"][0]["id"]
    assert next_page["messages"][0]["toolCalls"][0]["name"] == "web_search"
    assert len(next_page["messages"][0]["toolCalls"][0]["result"].encode()) <= 32768
    body = desktop_view.session_content(board, run["id"], execution_id, "web-1", field="result", limit=100)
    assert body["content"] == result[:100] and body["nextOffset"] == 100 and body["hasMore"]


def test_session_reads_reject_an_execution_from_another_run(board, tmp_path):
    _run, _, execution_id = card_with_instance(board, tmp_path, [
        {"id": "c", "name": "read", "arguments": {}, "output": "belongs to first"}])
    foreign = runs.create(board, workspace=str(tmp_path), question="another run")
    assert desktop_view.session_history(board, foreign["id"], execution_id) is None
    assert desktop_view.session_content(board, foreign["id"], execution_id, "c", field="result") is None
    assert desktop_view.sessions_payload(board, "r_missing") is None


async def test_observation_snapshot_omits_history_and_exposes_real_stream_and_telemetry(tmp_path):
    session, emit, _ = fixture_session(tmp_path)
    control = SessionControl(session, None)
    emit("message_start", assistant("independent live preview"))
    payload = await control._execute({"operation": "snapshot", "include_entries": False, "telemetry": True})
    assert payload["entries"] is None
    assert payload["streaming"]["content"][1]["text"] == "independent live preview"
    assert payload["telemetry"]["compactionCount"] == 0
    assert payload["telemetry"]["cwd"] == str(tmp_path)


def test_telemetry_counts_cache_as_cache_not_reasoning_and_includes_compaction_cost():
    from misaka.core.session_telemetry import entries_telemetry
    entries = [
        {"type": "message", "message": {"role": "assistant", "provider": "fixture", "model": "m",
          "usage": {"input": 20, "output": 10, "cacheRead": 70, "cacheWrite": 10,
                    "reasoning": 5, "cost": {"total": .25}}}},
        {"type": "compaction", "usage": {"input": 4, "output": 2, "cost": {"total": .05}}},
    ]
    telemetry = entries_telemetry(entries, cwd="C:/research")
    assert telemetry["tokens"]["cacheRead"] == 70 and telemetry["tokens"]["reasoning"] == 5
    assert telemetry["cacheHitRate"] == 70
    assert telemetry["compactionCount"] == 1 and telemetry["cost"] == pytest.approx(.30)
    assert telemetry["contextUsage"]["percent"] is None and telemetry["subscription"] is None
    assert telemetry["thinkingLevel"] is None and telemetry["permissionMode"] is None
    assert telemetry["autoCompact"] is None


def test_saved_observation_keeps_known_live_runtime_fields_with_new_file_usage(tmp_path, monkeypatch):
    from misaka.desktop_research.session_observer import ResearchSessionObserver
    path = tmp_path / 'child.jsonl'
    path.write_text('{}', encoding='utf-8')
    monkeypatch.setattr(desktop_view, '_session_version', lambda _: 'v2')
    monkeypatch.setattr(desktop_view, '_read_session', lambda *_: [
        {"type": "message", "message": {"role": "assistant", "provider": "real", "model": "m",
         "usage": {"input": 90, "output": 10, "cacheRead": 0, "cacheWrite": 0}}},
    ])
    observer = ResearchSessionObserver('r', lambda: None, lambda _: None)
    observer.states['e'] = {'historyVersion': 'v1', 'runtimeSource': 'live', 'telemetry': {
        'cwd': str(tmp_path), 'tokens': {'input': 1, 'output': 1, 'cacheRead': 0, 'cacheWrite': 0},
        'cost': None, 'cacheHitRate': None, 'contextUsage': {'tokens': 1, 'contextWindow': 1000, 'percent': .1},
        'model': {'provider': 'real', 'modelId': 'switched-before-new-reply'}, 'thinkingLevel': 'high', 'permissionMode': 'bypassPermissions',
        'autoCompact': False, 'compactionCount': 0, 'subscription': True,
    }}
    _, telemetry, availability = observer._saved({'executorId': 'e', 'sessionFile': str(path), 'workspace': str(tmp_path)})
    assert availability == 'available'
    assert telemetry['tokens']['input'] == 90
    assert telemetry['thinkingLevel'] == 'high' and telemetry['permissionMode'] == 'bypassPermissions'
    assert telemetry['autoCompact'] is False and telemetry['subscription'] is True
    assert telemetry['model']['modelId'] == 'switched-before-new-reply'
    assert telemetry['contextUsage']['tokens'] == 1


async def test_live_context_nulls_clear_previous_values_and_survive_later_saved_refresh(tmp_path, monkeypatch):
    from misaka.core.session_telemetry import entries_telemetry
    from misaka.desktop_research import session_observer
    path = tmp_path / 'session.jsonl'
    path.write_text('{}', encoding='utf-8')
    version = ['v1']
    monkeypatch.setattr(desktop_view, '_session_version', lambda _: version[0])
    monkeypatch.setattr(desktop_view, '_read_session', lambda *_: [])
    telemetry = entries_telemetry([], cwd=str(tmp_path), model={'provider':'real','id':'new-model'},
        thinking_level='high', permission_mode='default', auto_compact=False, subscription=True)
    telemetry['contextUsage'] = {'tokens':900,'contextWindow':1000,'percent':90}
    owner = [{'id':'sid','control':'socket'}]
    async def request(*_args, **_kwargs):
        return {'telemetry':telemetry,'stream_cursor':'cursor','streaming':None,'error':None}
    monkeypatch.setattr(session_observer.session_control, 'request', request)
    observer = session_observer.ResearchSessionObserver('r', lambda: None, lambda _: None, owner_resolver=lambda _: owner[0])
    descriptor = {'executorId':'e','sessionId':'sid','sessionFile':str(path),'workspace':str(tmp_path),
        'nodeId':'n','taskId':None,'generation':1,'attempt':1,'error':'old error'}
    await observer.sample(descriptor)
    telemetry = {**telemetry, 'contextUsage':{'tokens':None,'contextWindow':1000,'percent':None}}
    descriptor['error'] = None
    await observer.sample(descriptor)
    assert observer.states['e']['telemetry']['contextUsage']['tokens'] is None
    assert observer.states['e']['error'] is None
    owner[0] = None
    version[0] = 'v2'
    await observer.sample(descriptor)
    assert observer.states['e']['runtimeSource'] == 'live'
    assert observer.states['e']['telemetry']['model']['modelId'] == 'new-model'
    assert observer.states['e']['telemetry']['contextUsage']['tokens'] is None
    assert observer.states['e']['telemetry']['subscription'] is True


def test_live_telemetry_reports_missing_runtime_settings_as_unknown(tmp_path):
    from misaka.core.session_telemetry import collect_session_telemetry
    session, _, _ = fixture_session(tmp_path)
    telemetry = collect_session_telemetry(session)
    assert telemetry['permissionMode'] is None and telemetry['autoCompact'] is None
    assert telemetry['subscription'] is None


def test_independent_transcript_preserves_cumulative_compaction_dividers():
    entries = [
        {"id": "first", "type": "compaction", "timestamp": "2026-10-15T01:00:00Z", "summary": "earlier context"},
        {"id": "reply", "type": "message", "message": {"role": "assistant", "content": "continued research"}},
        {"id": "second", "type": "compaction", "timestamp": "2026-10-15T02:00:00Z", "summary": "later context"},
    ]
    messages = desktop_view._safe_messages(entries)
    assert [m['content'] for m in messages] == [
        'Session compacted 1 times', 'continued research', 'Session compacted 2 times']
    assert messages[0]['entryId'] == 'first' and messages[-1]['entryId'] == 'second'


async def test_observer_uses_the_real_owner_socket_and_emits_each_native_revision_once(board, tmp_path):
    from misaka.desktop_research.session_observer import ResearchSessionObserver
    session, emit_native, _ = fixture_session(tmp_path)
    record_file = tmp_path / "owner.json"
    record = {"id": session.sessionId, "instance": "owner-instance"}
    record_file.write_text(json.dumps(record), encoding="utf-8")
    catalog = SimpleNamespace(record=str(record_file), instance="owner-instance", spec=None)
    control = SessionControl(session, catalog)
    await control.start()
    try:
        run, task_id, _ = card_with_instance(board, tmp_path / "board-work", [
            {"id": "c", "name": "read", "arguments": {}, "output": "saved"}], status="running")
        board.execute("UPDATE tasks SET session_file=? WHERE id=?", (session.sessionManager.sessionFile, task_id))
        snapshots = []
        observer = ResearchSessionObserver(run["id"], lambda: None, snapshots.append,
            owner_resolver=lambda path: {**record, "control": control.path})
        descriptor = next(item for item in desktop_view.session_descriptors(board, run["id"]) if item["taskId"] == task_id)
        emit_native("message_start", assistant("live source"))
        await observer.sample(descriptor)
        await observer.sample(descriptor)
        assert len(snapshots) == 1
        assert snapshots[0]["snapshot"]["executorId"] == descriptor["executorId"]
        assert snapshots[0]["snapshot"]["streaming"]["content"] == "live source"
        emit_native("message_update", assistant("live source, updated"))
        await observer.sample(descriptor)
        assert len(snapshots) == 2
        assert snapshots[-1]["snapshot"]["revision"] > snapshots[0]["snapshot"]["revision"]
        assert snapshots[-1]["snapshot"]["streaming"]["content"] == "live source, updated"
    finally:
        control.close()


async def test_bridge_session_read_commands_are_workspace_fenced(board, tmp_path, monkeypatch):
    import io
    import sys

    from misaka.cli import desktop_bridge
    from tests.test_desktop_bridge import MockRuntimeHost, MockSession
    run, _, executor = card_with_instance(board, tmp_path, [
        {"id": "read-card", "name": "read", "arguments": {}, "output": "evidence"}])
    monkeypatch.setattr(desktop_bridge, "_open_research_readonly", lambda: board)
    # Keep the fixture connection open while individual read commands release their handles.
    original_close = board.close
    monkeypatch.setattr(board, "close", lambda: None)
    output = io.StringIO()
    monkeypatch.setattr(desktop_bridge, "writeRawStdout", output.write)
    commands = [
        {"type": "get_research_sessions", "requestId": "inventory", "runId": run["id"], "workspace": str(tmp_path)},
        {"type": "get_research_session_history", "requestId": "history", "runId": run["id"],
         "executorId": executor, "workspace": str(tmp_path)},
        {"type": "get_research_sessions", "requestId": "foreign", "runId": run["id"], "workspace": str(tmp_path / "foreign")},
    ]
    session = MockSession()
    session.moments = SimpleNamespace(parts=[])
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(c) + "\n" for c in commands)))
    await desktop_bridge.run_desktop_bridge(MockRuntimeHost(session))
    acks = {item["requestId"]: item for item in map(json.loads, output.getvalue().splitlines()) if item.get("type") == "ack"}
    assert acks["inventory"]["ok"] and len(acks["inventory"]["data"]["sessions"]) == 2
    assert acks["history"]["ok"] and acks["history"]["data"]["messages"][0]["toolCalls"][0]["name"] == "read"
    assert not acks["foreign"]["ok"]
    monkeypatch.setattr(board, "close", original_close)


def test_full_dispatch_trace_is_redacted_and_retrievable_beyond_the_summary(board, tmp_path):
    from misaka.core.network import dispatch
    from misaka.core.platform import tasks
    run, task_id, executor = card_with_instance(board, tmp_path, [
        {"id": "read", "name": "read", "arguments": {}, "output": "source"}], status="failed")
    try:
        raise RuntimeError("upstream fault " + "x" * 3500 + "\nAuthorization: Bearer secret-provider-token")
    except RuntimeError as error:
        dispatch.record_dispatch_error(board, task_id, tasks.get(board, task_id)["generation"], error)
    descriptor = next(d for d in desktop_view.session_descriptors(board, run["id"]) if d["taskId"] == task_id)
    assert "Traceback" in descriptor["error"] and len(descriptor["error"]) > 3500
    assert "secret-provider-token" not in descriptor["error"]
    full = desktop_view.session_content(board, run["id"], executor, "", field="error")
    assert "Traceback" in full["content"] and "secret-provider-token" not in full["content"]


def test_tool_error_content_reads_that_tool_not_the_task_error(board, tmp_path):
    run, _, executor = card_with_instance(board, tmp_path, [
        {"id": "download-failed", "name": "download_file", "arguments": {},
         "output": "Network failure " + "x" * 4000, "failed": True}])
    body = desktop_view.session_content(board, run["id"], executor, "download-failed", field="error")
    assert body["content"] == "Network failure " + "x" * 4000


def test_native_provider_failure_preserves_full_redacted_error(board, tmp_path, monkeypatch):
    from misaka.core.network.todo import TodoPart
    from misaka.core.platform import tasks
    run, tid, executor = card_with_instance(board, tmp_path, [
        {"id": "read", "name": "read", "arguments": {}, "output": "source"}], status="running")
    board.execute("UPDATE tasks SET claim_lock='owner',claim_expires=? WHERE id=?", (10**12, tid))
    row = tasks.get(board, tid)
    for key, value in {"MISAKA_SISTER_OWNER_TASK_ID": tid, "MISAKA_SISTER_OWNER_GENERATION": str(row["generation"]),
                       "MISAKA_SISTER_OWNER_CLAIM_LOCK": "owner"}.items():
        monkeypatch.setenv(key, value)
    part = TodoPart(tid, "fixture")
    part._con = board
    reason = "429 usage_limit_reached " + "x" * 4000 + "\nAuthorization: Bearer secret-provider-token"
    part._settle_failure("error", reason)
    assert tasks.get(board, tid)["status"] == "failed"
    detail = desktop_view.session_content(board, run["id"], executor, executor, field="error")["content"]
    assert len(detail) > 4000 and "usage_limit_reached" in detail
    assert "secret-provider-token" not in detail


async def test_historical_execution_never_reads_the_continued_generations_stream(board, tmp_path):
    from misaka.desktop_research.session_observer import ResearchSessionObserver
    run, _, _ = card_with_instance(board, tmp_path, [{"id": "c", "name": "read", "arguments": {}, "output": "source"}])
    historical = next(d for d in desktop_view.session_descriptors(board, run["id"]) if d["taskId"])
    historical["isCurrent"] = False
    resolved = []
    observer = ResearchSessionObserver(run["id"], lambda: None, lambda event: None,
        owner_resolver=lambda path: resolved.append(path) or {"control": "another-generation"})
    await observer.sample(historical)
    assert resolved == []
    assert observer.states[historical["executorId"]]["streaming"] is None


def test_cjk_content_pages_advance_even_with_one_byte_budget(board, tmp_path):
    text = "中🙂文"
    run, _, execution = card_with_instance(board, tmp_path, [{"id": "c", "name": "read", "arguments": {}, "output": text}])
    combined, cursor = "", 0
    for _ in range(5):
        page = desktop_view.session_content(board, run["id"], execution, "c", field="result", offset=cursor, limit=1)
        combined += page["content"]
        if not page["hasMore"]:
            break
        assert page["nextOffset"] > cursor
        cursor = page["nextOffset"]
    assert combined == text


async def test_card_session_start_records_native_context_on_the_owned_attempt(board, tmp_path, monkeypatch):
    from misaka.core.network.todo import TodoPart
    from misaka.core.platform import tasks
    run, tid, execution = card_with_instance(board, tmp_path, [{"id": "c", "name": "read", "arguments": {}, "output": "source"}], status="running")
    board.execute("UPDATE tasks SET session_file=NULL,agent_id=NULL,claim_lock='owner',claim_expires=? WHERE id=?", (10**12, tid))
    board.execute("UPDATE task_runs SET session_file=NULL WHERE id=?", (execution,))
    row = tasks.get(board, tid)
    for key, value in {"MISAKA_SISTER_OWNER_TASK_ID": tid, "MISAKA_SISTER_OWNER_GENERATION": str(row["generation"]),
                       "MISAKA_SISTER_OWNER_CLAIM_LOCK": "owner"}.items():
        monkeypatch.setenv(key, value)
    session, _, _ = fixture_session(tmp_path / "native")
    part = TodoPart(tid, "fixture")
    part._con = board
    part.attach(session)
    await part.session_start({}, SimpleNamespace(sessionManager=session.sessionManager))
    assert tasks.get(board, tid)["session_file"]
    saved = desktop_view.resolve_session(board, run["id"], execution)
    assert saved["sessionId"] == session.sessionId
    assert Path(saved["sessionFile"]).samefile(session.sessionManager.sessionFile)
