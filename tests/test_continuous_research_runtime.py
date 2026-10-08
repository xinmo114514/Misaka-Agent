"""Real AgentSession, catalog fencing, persisted transcript, and scripted provider replies."""
import asyncio
import os

from misaka.ai.models import get_models
from misaka.ai.types import AssistantMessage, DoneEvent
from misaka.ai.utils.event_stream import AssistantMessageEventStream
from misaka.cli.desktop_bridge import ResearchMessageIngress, research_host_payload
from misaka.core import session_control, wiring
from misaka.core.auth_storage import AuthStorage
from misaka.core.platform import cards
from misaka.core.research import runs
from misaka.core.research.wiring import research
from misaka.core.resource_loader import DefaultResourceLoader
from misaka.core.sdk import create_agent_session
from misaka.core.session_manager import SessionManager
from misaka.core.settings_manager import SettingsManager
from tests.test_prompt_assembly_integration import prompt_home  # noqa: F401 - fixture


async def until(check):
    async with asyncio.timeout(5):
        while not check():
            await asyncio.sleep(.01)


async def test_real_root_receives_first_question_resume_and_done_followup(prompt_home, monkeypatch):  # noqa: F811
    # The role assembly and every native input/transcript path are real. Only the
    # research workflow's costly workers and provider stream are deterministic.
    workspace = prompt_home / "workspace"
    workspace.mkdir()
    # Keep the fixture profiles, but start this host with a genuinely empty
    # Sister catalog: its new profiles must come from the production bootstrap.
    (prompt_home / "profiles" / "sisters").rename(prompt_home / "unused-fixture-experts")
    profile = prompt_home / "profiles" / "last_order"
    _, assembly, _ = wiring.role_session_setup(str(profile), str(workspace),
                                             research_context=True, research_host=True)
    loader = DefaultResourceLoader({"cwd": str(workspace), "agentDir": str(prompt_home / "agent"),
                                    "noExtensions": True, "noPromptTemplates": True, "noThemes": True})
    await loader.reload()
    model = next(m for m in get_models("openai") if "image" in m.input)
    auth = AuthStorage.inMemory()
    auth.setRuntimeApiKey(model.provider, "deterministic-fixture")
    manager = SessionManager.create(str(workspace), str(prompt_home / "sessions"))
    result = await create_agent_session({"cwd": str(workspace), "agentDir": str(prompt_home / "agent"),
        "model": model, "authStorage": auth, "resourceLoader": loader,
        "settingsManager": SettingsManager.inMemory({"compaction": {"enabled": False}, "retry": {"enabled": False}}),
        "sessionManager": manager, "parts": assembly.parts, "customTools": assembly.custom_tools})
    session = result["session"]
    replies = []

    def stream(model, context, options=None):
        replies.append(context)
        reply = AssistantMessage(content=[{"type": "text", "text": "A deterministic followup grounded in the report."}],
            api=model.api, provider=model.provider, model=model.id, stopReason="stop", timestamp=1,
            usage={"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 2,
                   "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}})
        output = AssistantMessageEventStream()
        output.push(DoneEvent(reason="stop", message=reply))
        output.end(reply)
        return output

    session.agent.streamFn = stream
    con = research._con()
    workflow_calls = []
    resume_entered, resume_release = asyncio.Event(), asyncio.Event()

    async def deterministic_workflow(db, cfg, spawner, *, run_id, **options):
        workflow_calls.append((run_id, options.get("clarification")))
        if options.get("clarification") == "The nineteenth century":
            resume_entered.set()
            await resume_release.wait()
        runs.set_state(db, run_id, root_session=session.sessionFile, status="waiting_input", phase="waiting_input")
        return {"reason": "waiting_input", "questions": ["Which period?"], "run": {"id": run_id}}

    monkeypatch.setattr(cards, "init_project", lambda *a, **kw: None)
    monkeypatch.setattr(research.workflow, "run", deterministic_workflow)
    ingress = ResearchMessageIngress(session)
    events = []
    unsubscribe = session.subscribe(lambda event: events.append(ingress.event(event)))
    await session.bindExtensions({"mode": "json"})
    control = session_control.for_session(session)
    try:
        first = await ingress.send({"text": "Compare the evidence", "sessionId": session.sessionId,
                                    "requestId": "first"}, con)
        assert first["mode"] == "start" and first["runId"] is None
        await until(lambda: workflow_calls and runs.listing(con)[0]["status"] == "waiting_input")
        run = runs.listing(con)[0]
        run_id = run["id"]
        assert runs.limits(run)["plan_approval"] is False
        from misaka.core.network import roster

        assert roster.roster_names(str(prompt_home / "profiles" / "sisters")) == [
            "research-generalist", "research-reviewer"]
        assert os.path.realpath(run["root_session"]) == os.path.realpath(session.sessionFile)
        resumed = await ingress.send({"text": "The nineteenth century", "sessionId": session.sessionId,
                                     "runId": run_id, "requestId": "clarification"}, con)
        assert resumed["runId"] == run_id and resumed["mode"] == "resume"
        await until(lambda: len(workflow_calls) == 2)
        assert workflow_calls[1] == (run_id, "The nineteenth century")
        await asyncio.wait_for(resume_entered.wait(), 5)
        second = await ingress.send({"text": "Include the contradictory archives", "sessionId": session.sessionId,
                                     "runId": run_id, "requestId": "second-answer"}, con)
        assert second["mode"] == "steer" and second["runId"] == run_id
        await asyncio.gather(*control.inputs)
        await session.waitForIdle()
        resume_release.set()
        part = next(part for part in session.moments.parts if isinstance(part, research.ResearchPart))
        await until(lambda: not part.is_driving(run_id))
        # Settled drivers leave the same window ready for plain followups.
        runs.set_state(con, run_id, status="done", phase="done")
        follow = await ingress.send({"text": "Explain the uncertainties", "sessionId": session.sessionId,
                                    "runId": run_id, "requestId": "follow"}, con)
        assert follow["mode"] == "followUp" and follow["runId"] == run_id
        await asyncio.gather(*control.inputs)
        await session.waitForIdle()
        assert len(replies) == 2 and len(runs.listing(con)) == 1
        assert "research-generalist" in str(replies[0].messages[0].content)
        assert "research-reviewer" in str(replies[0].messages[0].content)
        snapshot = research_host_payload(session, con, last_event_seq=len(events), stream_id="fixture")
        question = next(m for m in snapshot["messages"] if m.get("customType") == "research-question")
        assert question["details"]["question"] == "Compare the evidence"
        assert question["details"]["requestId"] == "first"
        answer = next(m for m in snapshot["messages"] if m["content"] == "The nineteenth century")
        assert answer["role"] == "user" and answer["requestId"] == "clarification"
        assert any(m["role"] == "user" and m["content"] == "Include the contradictory archives"
                   for m in snapshot["messages"])
        assert any(m["role"] == "user" and m["content"] == "Explain the uncertainties" for m in snapshot["messages"])
        assert any(m["role"] == "assistant" and "deterministic followup" in m["content"] for m in snapshot["messages"])
        reopened = SessionManager.open(session.sessionFile)
        assert reopened.getSessionId() == session.sessionId
        assert reopened.buildContextEntries() == manager.buildContextEntries()
    finally:
        unsubscribe()
        await session.moments.session_shutdown({"type": "session_shutdown", "reason": "test"})
        session.dispose()
