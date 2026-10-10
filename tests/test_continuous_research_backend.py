"""Continuous research ingress uses the original coordinator and durable roster."""
import asyncio
import io
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest

from misaka.cli import desktop_bridge as bridge
from misaka.core import session_control, wiring
from misaka.core.network import roster
from misaka.core.platform import tasks
from misaka.core.research import runs
from misaka.core.research.wiring.research import ResearchPart


def test_empty_roster_prepares_durable_default_experts_once(tmp_path):
    assert hasattr(roster, "ensure_research_sisters"), "Research startup needs durable default experts"
    root = tmp_path / "profiles"
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: roster.ensure_research_sisters(str(root)), range(8)))
    assert all(set(result) == {"research-generalist", "research-reviewer"} for result in results)
    assert roster.roster_names(str(root)) == ["research-generalist", "research-reviewer"]
    for sid in results[0]:
        assert (root / sid / "SOUL.md").is_file()
        assert (root / sid / "DESCRIBE.md").is_file()
        assert roster.describe(sid, str(root))[0]
    original = (root / "research-generalist" / "SOUL.md").read_bytes()
    roster.ensure_research_sisters(str(root))
    assert (root / "research-generalist" / "SOUL.md").read_bytes() == original


def test_existing_expert_roster_is_preserved_without_defaults(tmp_path):
    assert hasattr(roster, "ensure_research_sisters"), "Research startup needs roster preparation"
    ok, _ = roster.create_sister("archivist", root=str(tmp_path), specialty="Reads archival evidence")
    assert ok
    before = {p: p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    assert roster.ensure_research_sisters(str(tmp_path)) == ["archivist"]
    assert roster.roster_names(str(tmp_path)) == ["archivist"]
    assert all(p.read_bytes() == content for p, content in before.items())


def test_unusable_existing_profile_does_not_prevent_default_experts(tmp_path):
    malformed = tmp_path / "malformed-specialist"
    malformed.mkdir()
    (malformed / "SOUL.md").write_text("Keep this profile's voice", encoding="utf-8")
    description = malformed / "DESCRIBE.md"
    original = b"---\ndescription: [invalid YAML\n---\n"
    description.write_bytes(original)
    experts = roster.ensure_research_sisters(str(tmp_path))
    assert set(experts) == {"research-generalist", "research-reviewer"}
    assert description.read_bytes() == original


def test_research_host_assembly_keeps_controller_while_nodes_exclude_it(tmp_path, monkeypatch):
    monkeypatch.setenv("MISAKA_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("MISAKA_RESEARCH_NODE", raising=False)
    profile = str(tmp_path / "roles" / "last_order")
    _, host, _ = wiring.role_session_setup(profile, str(tmp_path), research_context=True, research_host=True)
    _, node, _ = wiring.role_session_setup(profile, str(tmp_path), research_context=True)
    assert any(isinstance(part, ResearchPart) for part in host.parts)
    assert not any(isinstance(part, ResearchPart) for part in node.parts)
    assert any(tool.name == "doc_read" for tool in host.custom_tools)


@pytest.fixture
def coordinator(tmp_path):
    con = tasks.connect(str(tmp_path / "board.db"))
    runs.init(con)
    manager = SimpleNamespace(sessionFile=str(tmp_path / "root.jsonl"), getCwd=lambda: str(tmp_path))
    session = SimpleNamespace(sessionId="root-session", sessionFile=manager.sessionFile,
                              sessionManager=manager, isStreaming=False, isIdle=True,
                              moments=SimpleNamespace(parts=[object.__new__(ResearchPart)]))
    record = tmp_path / "catalog.json"
    record.write_text(json.dumps({"id": session.sessionId, "instance": "fixture"}), encoding="utf-8")
    control = session_control.SessionControl(session, SimpleNamespace(instance="fixture", record=str(record), spec=None))
    received = []

    async def prompt(text, options):
        received.append(text)
        options["preflightResult"](True)

    session.prompt = prompt
    session.custom_messages = []

    async def custom(message, options):
        session.custom_messages.append(message)

    session.sendCustomMessage = custom
    session.moments.parts.append(SimpleNamespace(control=control))
    try:
        yield con, session, control, received, tmp_path
    finally:
        control.close()
        con.close()


def ingress_for(session, tmp_path):
    assert hasattr(bridge, "ResearchMessageIngress"), "Desktop needs a validated continuous research lane"
    return bridge.ResearchMessageIngress(session, config={"profiles_root": str(tmp_path / "profiles")})


def own_run(con, session, **kwargs):
    run = runs.create(con, workspace=session.sessionManager.getCwd(), question="Question", origin_session=session.sessionId)
    runs.set_state(con, run["id"], root_session=session.sessionManager.sessionFile, **kwargs)
    return runs.get(con, run["id"])


async def test_first_input_starts_automatic_research_and_prepares_experts(coordinator):
    con, session, control, received, tmp_path = coordinator
    ingress = ingress_for(session, tmp_path)
    ack = await ingress.send({"text": "What is the evidence?", "sessionId": session.sessionId, "requestId": "q1"}, con)
    await asyncio.gather(*control.inputs)
    assert ack == {"accepted": True, "sessionId": session.sessionId, "runId": None, "requestId": "q1", "mode": "start"}
    assert "--plan-approval automatic -- What is the evidence?" in received[0]
    assert set(roster.roster_names(str(tmp_path / "profiles"))) == {"research-generalist", "research-reviewer"}


async def test_start_new_refuses_to_fold_into_a_settled_run(coordinator):
    con, session, control, received, tmp_path = coordinator
    ingress = ingress_for(session, tmp_path)
    own_run(con, session, status="done", phase="done")
    ack = await ingress.send({"text": "A brand new question", "sessionId": session.sessionId,
                              "requestId": "new-1", "startNew": True}, con)
    await asyncio.gather(*control.inputs)
    assert ack["mode"] == "start"
    assert ack["runId"] is None
    assert "--plan-approval automatic -- A brand new question" in received[0]


async def test_start_new_still_yields_to_an_active_run(coordinator):
    con, session, _control, _received, tmp_path = coordinator
    ingress = ingress_for(session, tmp_path)
    own_run(con, session, status="active", phase="active")
    with pytest.raises(ValueError):
        await ingress.send({"text": "second question", "sessionId": session.sessionId,
                            "requestId": "new-2", "startNew": True}, con)


async def test_settled_run_is_adopted_without_start_new(coordinator):
    con, session, control, _received, tmp_path = coordinator
    ingress = ingress_for(session, tmp_path)
    run = own_run(con, session, status="done", phase="done")
    ack = await ingress.send({"text": "Follow up on the finished report", "sessionId": session.sessionId,
                              "requestId": "cont-1"}, con)
    await asyncio.gather(*control.inputs)
    assert ack["runId"] == run["id"]
    assert ack["mode"] == "followUp"


async def test_receipt_write_failure_does_not_leave_a_phantom_start(coordinator):
    con, session, _control, _received, tmp_path = coordinator
    entries = []
    fail = True

    def append(kind, data):
        if fail:
            raise OSError('disk full')
        entries.append({'type': 'custom', 'customType': kind, 'data': data})

    session.sessionManager.getEntries = lambda: entries
    session.sessionManager.appendCustomEntry = append
    ingress = ingress_for(session, tmp_path)
    with pytest.raises(OSError, match='disk full'):
        await ingress.send({'sessionId': session.sessionId, 'requestId': 'failed-write',
                            'text': '原始研究问题'}, con)
    assert ingress.starting is False
    assert ingress.pending == []
    fail = False
    result = await ingress.send({'sessionId': session.sessionId, 'requestId': 'next-input',
                                 'text': '下一个研究问题'}, con)
    assert result['mode'] == 'start'


async def test_stale_active_run_resumes_original_workflow_and_persists_answer(coordinator):
    con, session, control, received, tmp_path = coordinator
    run = own_run(con, session, status="active")
    persisted = []

    async def custom(message, options):
        persisted.append(message)

    session.sendCustomMessage = custom
    ack = await ingress_for(session, tmp_path).send({"text": "More evidence", "sessionId": session.sessionId,
        "runId": run["id"], "requestId": "resume-stale"}, con)
    await asyncio.gather(*control.inputs)
    assert ack["mode"] == "resume" and ack["runId"] == run["id"]
    assert received == [f"/research resume {run['id']} More evidence"]
    assert persisted[0]["content"] == "More evidence"
    assert persisted[0]["details"]["requestId"] == "resume-stale"


async def test_retired_catalog_instance_rejects_before_persisting_clarification(coordinator):
    con, session, control, received, tmp_path = coordinator
    run = own_run(con, session, status="waiting_input")
    await asyncio.to_thread(Path(control.catalog.record).write_text,
        json.dumps({"id": session.sessionId, "instance": "replacement-owner"}), encoding="utf-8")
    with pytest.raises(ValueError):
        await ingress_for(session, tmp_path).send({"text": "Answer", "sessionId": session.sessionId,
            "runId": run["id"], "requestId": "retired"}, con)
    assert session.custom_messages == []
    assert received == []


async def test_waiting_status_with_live_local_driver_steers_instead_of_discarding_answer(coordinator):
    con, session, control, received, tmp_path = coordinator
    run = own_run(con, session, status="waiting_input")
    session.moments.parts[0]._drivers = {run["id"]: asyncio.create_task(asyncio.sleep(60))}
    session.moments.parts[0]._resume_inputs = {run["id"]}
    try:
        ack = await ingress_for(session, tmp_path).send({"text": "Another answer", "sessionId": session.sessionId,
            "runId": run["id"], "requestId": "second-answer"}, con)
        await asyncio.gather(*control.inputs)
        assert ack["mode"] == "steer"
        assert received == ["Another answer"]
    finally:
        driver = session.moments.parts[0]._drivers[run["id"]]
        driver.cancel()
        await asyncio.gather(driver, return_exceptions=True)


async def test_stopped_driver_winding_down_still_receives_a_resume(coordinator):
    con, session, control, received, tmp_path = coordinator
    run = own_run(con, session, status="stopped")
    driver = asyncio.create_task(asyncio.sleep(.02))
    session.moments.parts[0]._drivers = {run["id"]: driver}
    try:
        ack = await ingress_for(session, tmp_path).send({"text": "Continue with new evidence", "sessionId": session.sessionId,
            "runId": run["id"], "requestId": "continue"}, con)
        await asyncio.gather(*control.inputs)
        assert ack["mode"] == "resume"
        assert received == [f"/research resume {run['id']} Continue with new evidence"]
    finally:
        await driver


@pytest.mark.parametrize("status", ["stopped", "waiting_input", "failed"])
async def test_core_resume_waits_for_stopped_local_driver_then_relaunches(coordinator, monkeypatch, status):
    from misaka.core.research.wiring import research as research_module

    con, session, _, received, tmp_path = coordinator
    run = own_run(con, session, status=status)
    monkeypatch.setattr(research_module, "_con", lambda: con)
    monkeypatch.setattr(research_module, "_cfg", lambda: {"db": str(tmp_path / "board.db")})
    monkeypatch.setattr(research_module.session_overrides, "apply", lambda *a: lambda: None)
    session.moments.send_message = lambda *a: None
    calls = []

    async def workflow(db, cfg, spawner, *, run_id, clarification, **options):
        calls.append((run_id, clarification))
        return {"reason": "waiting_input", "questions": ["Next?"], "run": {"id": run_id}}

    async def ordinary_prompt(text, options):
        received.append(text)

    session.prompt = ordinary_prompt
    monkeypatch.setattr(research_module.workflow, "run", workflow)
    part = ResearchPart()
    part.session = session
    old = asyncio.create_task(asyncio.sleep(.02))
    part._drivers[run["id"]] = old
    ctx = SimpleNamespace(sessionManager=SimpleNamespace(sessionId=session.sessionId, sessionFile=session.sessionFile),
                          cwd=str(tmp_path), isIdle=lambda: True, ui=SimpleNamespace(notify=lambda *a: None))
    try:
        await part.commands[0].handler(f"resume {run['id']} More evidence", ctx)
        await asyncio.sleep(.04)
        assert calls == [(run["id"], "More evidence")]
        assert received == []
    finally:
        await old


async def test_initial_waiting_driver_settling_routes_answer_to_resume_not_chat(coordinator):
    con, session, control, received, tmp_path = coordinator
    run = own_run(con, session, status="waiting_input")
    driver = asyncio.create_task(asyncio.sleep(.02))
    session.moments.parts[0]._drivers = {run["id"]: driver}
    try:
        ack = await ingress_for(session, tmp_path).send({"text": "Answer the clarification", "sessionId": session.sessionId,
            "runId": run["id"], "requestId": "settling-answer"}, con)
        await asyncio.gather(*control.inputs)
        assert ack["mode"] == "resume"
        assert received == [f"/research resume {run['id']} Answer the clarification"]
    finally:
        await driver


def test_persisted_clarification_is_projected_as_user_with_request_id():
    messages = bridge._serialize_session_entries([{"type": "custom_message", "id": "accepted-input",
        "customType": "research-input", "content": "Use the nineteenth century", "display": True,
        "details": {"run_id": "r_same", "requestId": "answer-request"}, "timestamp": 2}])
    assert messages[0]["role"] == "user" and messages[0]["content"] == "Use the nineteenth century"
    assert messages[0]["requestId"] == "answer-request"


@pytest.mark.parametrize("status,mode,prefix", [("active", "steer", "Later evidence"),
    ("waiting_input", "resume", "/research resume "), ("stopped", "resume", "/research resume "),
    ("failed", "resume", "/research resume "), ("done", "followUp", "Later evidence")])
async def test_repeated_inputs_keep_original_run_and_coordinator(coordinator, status, mode, prefix):
    con, session, control, received, tmp_path = coordinator
    run = own_run(con, session, status=status)
    if status == "active":
        assert runs.acquire_driver(con, run["id"], "fixture-live-driver")
    ingress = ingress_for(session, tmp_path)
    for n in range(3):
        ack = await ingress.send({"text": "Later evidence", "sessionId": session.sessionId,
                                  "runId": run["id"], "requestId": f"q{n}"}, con)
        assert ack["runId"] == run["id"] and ack["mode"] == mode
    await asyncio.gather(*control.inputs)
    assert all(text.startswith(prefix) for text in received)
    assert len(runs.listing(con)) == 1


@pytest.mark.parametrize("mismatch", ["session", "root", "workspace", "run"])
async def test_ingress_rejects_mismatched_owners_without_delivering(coordinator, mismatch):
    con, session, control, received, tmp_path = coordinator
    run = own_run(con, session)
    obj = {"text": "Later evidence", "sessionId": session.sessionId, "runId": run["id"], "requestId": "q1"}
    if mismatch == "session":
        obj["sessionId"] = "other-session"
    elif mismatch == "root":
        runs.set_state(con, run["id"], root_session=str(tmp_path / "other.jsonl"))
    elif mismatch == "workspace":
        con.execute("UPDATE research_runs SET workspace=? WHERE id=?", (str(tmp_path / "other"), run["id"]))
        con.commit()
    else:
        obj["runId"] = "missing-run"
    ingress = ingress_for(session, tmp_path)
    with pytest.raises(ValueError):
        await ingress.send(obj, con)
    assert received == [] and not control.inputs


def test_host_snapshot_is_true_root_transcript_with_terminal_run(coordinator):
    con, session, _, _, _tmp_path = coordinator
    run = own_run(con, session, status="done")
    session.getPermissionMode = lambda: "default"
    session.getSessionStats = lambda: {"messageCount": 2}
    session.getContextUsage = lambda: {"tokens": 17}
    session.isStreaming = True
    session.isIdle = False
    entries = [{"type": "message", "id": "real-user", "timestamp": 1,
                "message": {"role": "user", "content": [{"type": "text", "text": "Root question"}]}}]
    session.sessionManager.buildContextEntries = lambda: entries
    session.sessionManager.getLeafId = lambda: "real-user"
    session.sessionManager.getEntries = lambda: entries
    assert hasattr(bridge, "research_host_payload"), "Research host snapshots need their own authoritative transcript"
    payload = bridge.research_host_payload(session, con, last_event_seq=7)
    assert payload["messages"][0]["content"] == "Root question"
    assert payload["messages"][0]["entryId"] == "real-user"
    assert payload["run"] == {"id": run["id"], "status": "done", "phase": run["phase"]}
    assert payload["lastEventSeq"] == 7 and payload["historyVersion"]
    assert payload["contextUsage"] == {"tokens": 17}
    assert payload["isStreaming"] is True and payload["isIdle"] is False


async def test_desktop_dispatch_uses_ingress_without_relaxing_generic_prompt_guard(coordinator, monkeypatch):
    from test_desktop_bridge import MockAgent, MockRuntimeHost

    con, session, _control, received, _ = coordinator
    run = own_run(con, session)
    assert runs.acquire_driver(con, run["id"], "fixture-live-driver")
    session.agent = MockAgent()
    session.subscribe = lambda fn: lambda: None
    session.bindExtensions = lambda *_: asyncio.sleep(0)
    output = io.StringIO()
    monkeypatch.setattr(bridge, "writeRawStdout", output.write)
    monkeypatch.setattr(bridge, "_open_research_readonly", lambda: SimpleNamespace(
        execute=con.execute, close=lambda: None))
    monkeypatch.setattr(bridge, "session_belongs_to_active_research", lambda board, path: path == session.sessionFile)
    cmds = [
        {"type": "prompt", "text": "Generic edit", "requestId": "generic"},
        {"type": "set_model", "text": "/research status", "requestId": "guard-bypass"},
        {"type": "send_research_message", "text": "Later evidence", "sessionId": session.sessionId,
         "runId": run["id"], "requestId": "research"},
        {"type": "shutdown", "requestId": "bye"},
    ]
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(cmd) + "\n" for cmd in cmds)))
    assert await bridge.run_desktop_bridge(MockRuntimeHost(session)) == 0
    acks = {row["requestId"]: row for row in map(json.loads, output.getvalue().splitlines()) if row.get("type") == "ack"}
    assert acks["generic"]["ok"] is False
    assert "Stop the owning research run" in acks["guard-bypass"]["error"]
    assert acks["research"]["ok"] is True
    assert acks["research"]["data"]["runId"] == run["id"]
    assert received == ["Later evidence"]


async def test_stop_and_resume_controls_render_one_canonical_command(coordinator, monkeypatch):
    from test_desktop_bridge import MockAgent, MockRuntimeHost

    con, session, _, received, _ = coordinator
    run = own_run(con, session, status="active")
    session.agent = MockAgent()
    session.subscribe = lambda fn: lambda: None
    session.bindExtensions = lambda *_: asyncio.sleep(0)
    output = io.StringIO()
    monkeypatch.setattr(bridge, "writeRawStdout", output.write)
    monkeypatch.setattr(bridge, "_open_research_readonly", lambda: SimpleNamespace(
        execute=con.execute, close=lambda: None))
    cmds = [
        {"type": "stop_research", "runId": run["id"], "requestId": "stop-1"},
        {"type": "resume_research", "runId": run["id"], "clarification": "掌权30年吧", "requestId": "resume-1"},
        {"type": "resume_research", "runId": run["id"], "requestId": "resume-2"},
        {"type": "resume_research", "requestId": "resume-3"},
        {"type": "shutdown", "requestId": "bye"},
    ]
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(cmd) + "\n" for cmd in cmds)))
    assert await bridge.run_desktop_bridge(MockRuntimeHost(session)) == 0
    acks = {row["requestId"]: row for row in map(json.loads, output.getvalue().splitlines()) if row.get("type") == "ack"}
    assert acks["stop-1"]["ok"] is True
    assert acks["resume-3"]["ok"] is False
    assert "resume_research requires runId" in acks["resume-3"]["error"]
    assert received == [
        f"/research stop {run['id']}",
        f"/research resume {run['id']} 掌权30年吧",
        f"/research resume {run['id']}",
    ]


def test_desktop_research_flag_builds_real_host_parts(tmp_path, monkeypatch):
    from misaka.core.platform import session as session_module

    monkeypatch.setenv("MISAKA_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("MISAKA_RESEARCH_NODE", raising=False)
    captured = {}

    async def open_session(flags, cwd, assembly):
        captured["parts"] = assembly.parts
        return None, None, "fixture opened"

    monkeypatch.setattr(session_module, "open_session", open_session)
    assert bridge.main(SimpleNamespace(cwd=str(tmp_path), research_context=True)) == 1
    assert any(isinstance(part, ResearchPart) for part in captured["parts"])


async def test_research_question_retains_request_id_and_startup_uses_real_events(coordinator, monkeypatch):
    from misaka.core.platform import cards
    from misaka.core.research import ingress as ingress_module
    from misaka.core.research.wiring import research as research_module

    con, session, _, _, tmp_path = coordinator
    monkeypatch.setattr(research_module, "_con", lambda: con)
    monkeypatch.setattr(research_module, "_cfg", lambda: {"profiles_root": str(tmp_path / "profiles"), "db": str(tmp_path / "board.db")})
    # Real ResearchPart/start command, run row, and root binding; only the
    # provider-backed workflow itself is stopped at the deterministic boundary.
    monkeypatch.setattr(cards, "init_project", lambda *a, **k: None)
    monkeypatch.setattr(research_module.session_overrides, "apply", lambda *a: lambda: None)
    messages = []
    session.moments.send_message = lambda message, opts: messages.append(message)
    ctx = SimpleNamespace(sessionManager=SimpleNamespace(sessionId=session.sessionId, sessionFile=session.sessionFile),
                          cwd=str(tmp_path), isIdle=lambda: True, ui=SimpleNamespace(notify=lambda *a: None))

    async def deterministic_workflow(db, cfg, spawner, *, run_id, **kwargs):
        runs.set_state(db, run_id, root_session=session.sessionFile, status="waiting_input")
        return {"reason": "waiting_input", "questions": ["Which evidence?"], "run": {"id": run_id}}

    monkeypatch.setattr(research_module.workflow, "run", deterministic_workflow)
    part = ResearchPart()
    part.session = session
    token = ingress_module.current_request_id.set("first-request")
    try:
        await part.commands[0].handler("--plan-approval automatic -- What is the evidence?", ctx)
        for _ in range(10):
            await asyncio.sleep(.01)
    finally:
        ingress_module.current_request_id.reset(token)
    question = next(message for message in messages if message["customType"] == "research-question")
    assert question["details"]["question"] == "What is the evidence?"
    assert question["details"]["requestId"] == "first-request"
    discipline = next(message for message in messages if message["customType"] == "research-discipline")
    assert discipline["details"]["run_id"] == runs.listing(con)[0]["id"]
    assert runs.limits(runs.listing(con)[0])["plan_approval"] is False


async def test_process_stream_id_fences_reopened_session_event_order(coordinator, monkeypatch):
    from test_desktop_bridge import MockAgent, MockRuntimeHost

    con, session, _, _, _ = coordinator
    own_run(con, session, status="done")
    session.agent = MockAgent()
    session.getPermissionMode = lambda: "default"
    session.getSessionStats = dict
    session.getContextUsage = dict
    session.sessionManager.buildContextEntries = list
    session.bindExtensions = lambda *_: asyncio.sleep(0)
    session.subscribe = lambda fn: lambda: None
    monkeypatch.setattr(bridge, "_open_research_readonly", lambda: SimpleNamespace(execute=con.execute, close=lambda: None))
    streams = []
    for _ in range(2):
        output = io.StringIO()
        monkeypatch.setattr(bridge, "writeRawStdout", output.write)
        monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"type": "get_research_host", "requestId": "host"}) + "\n"))
        assert await bridge.run_desktop_bridge(MockRuntimeHost(session)) == 0
        rows = list(map(json.loads, output.getvalue().splitlines()))
        host = next(row["data"] for row in rows if row.get("requestId") == "host")
        assert host["streamId"]
        streams.append(host["streamId"])
    assert streams[0] != streams[1]


def test_event_envelope_carries_stream_epoch():
    event = {"type": "message_end", "message": {"role": "user", "content": "Evidence"}}
    wire = json.loads(bridge._serialize_event(1, "same-session", event, stream_id="new-process"))
    assert wire["streamId"] == "new-process"
    assert wire["sessionId"] == "same-session"
    assert wire["seq"] == 1


def test_native_object_user_event_correlates_request_and_startup_failure(coordinator):
    _, session, _, _, tmp_path = coordinator
    ingress = ingress_for(session, tmp_path)
    ingress.pending.append(("Evidence", "request-evidence"))
    event = SimpleNamespace(type="message_start", message=SimpleNamespace(role="user", content="Evidence"))
    decorated = ingress.event(event)
    assert decorated["requestId"] == "request-evidence"
    ingress.starting = True
    ingress.event(SimpleNamespace(type="message_end", message=SimpleNamespace(role="custom",
        customType="research-progress", details={"stage": "startup_error"})))
    assert ingress.starting is False
