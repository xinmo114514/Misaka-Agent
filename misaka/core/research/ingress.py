"""Narrow desktop ingress to a research conversation's original SessionControl.

This lane validates ownership before touching the session. It never adopts a run,
writes phase approvals, or relaxes the desktop's ordinary session-mutation guards.
"""
from __future__ import annotations

import asyncio
import os
from contextvars import ContextVar

from misaka.config import home
from misaka.core import session_control
from misaka.core.research.wiring.research import ResearchPart
from misaka.utils.values import read_field

current_request_id: ContextVar[str | None] = ContextVar("research_request_id", default=None)


def _path(value):
    return os.path.normcase(os.path.realpath(str(home.from_stored(str(value))))) if value else None


def owns_run(session, run):
    manager = session.sessionManager
    if _path(run["workspace"]) != _path(manager.getCwd()):
        return False
    if run["root_session"]:
        return _path(run["root_session"]) == _path(getattr(manager, "sessionFile", None))
    # Startup persists the run before the driver binds its root window. The
    # initiating session remains its owner in this short, observable interval.
    return run["origin_session"] == session.sessionId


def session_run(session, con):
    if con is None:
        return None
    return next((row for row in con.execute("SELECT * FROM research_runs ORDER BY created_at DESC, rowid DESC")
                 if owns_run(session, row)), None)


class ResearchMessageIngress:
    def __init__(self, session, *, config=None):
        self.session = session
        self.config = config
        self.lock = asyncio.Lock()
        self.starting = False
        self.pending = []
        self.accepted = {}

    def event(self, event):
        """Correlate real messages only; never synthesize acceptance or run events."""
        from misaka.modes.jsonl import to_jsonable

        message = read_field(event, "message")
        kind = read_field(message, "customType")
        details = read_field(message, "details") or {}
        if kind == "research-discipline" or (kind == "research-progress" and read_field(details, "stage") == "startup_error"):
            self.starting = False
        if read_field(event, "type") != "message_start" or read_field(message, "role") != "user":
            return event
        content = read_field(message, "content")
        text = content if isinstance(content, str) else "".join(str(read_field(block, "text") or "")
            for block in (content or []) if read_field(block, "type") == "text")
        match = next((item for item in self.pending if item[0] == text), None)
        if match is None:
            return event
        self.pending.remove(match)
        return {**to_jsonable(event), "requestId": match[1]}

    async def send(self, obj, con):
        from misaka.cli.desktop_bridge import research_start_prompt
        from misaka.config.product import current_config
        from misaka.core.network.roster import ensure_research_sisters

        session = self.session
        if obj.get("sessionId") != session.sessionId:
            raise ValueError("Research session changed; refresh the coordinator before sending.")
        if not any(isinstance(part, ResearchPart) for part in session.moments.parts):
            raise ValueError("This session is not a research coordinator.")
        text = obj.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("Enter a message for this research session.")
        request_id = obj.get("requestId")
        if not isinstance(request_id, str) or not request_id.strip():
            raise ValueError("send_research_message requires requestId")
        text = text.strip()
        # Research controls go through dedicated commands. Text ingress is prose,
        # so it must not turn a slash command into a session/tree mutation.
        if text.startswith("/"):
            raise ValueError("Use research controls for commands; enter prose in this conversation.")
        async with self.lock:
            if request_id in self.accepted:
                accepted_text, ack = self.accepted[request_id]
                if accepted_text != text or obj.get("runId") not in {None, ack["runId"]}:
                    raise ValueError("This requestId already belongs to another research input.")
                return dict(ack)
            run_id = obj.get("runId")
            if run_id is not None and (not isinstance(run_id, str) or not run_id.strip()):
                raise ValueError("runId must be a nonempty string")
            run = (con.execute("SELECT * FROM research_runs WHERE id=?", (run_id,)).fetchone()
                   if con is not None and run_id else session_run(session, con))
            if run_id and (run is None or not owns_run(session, run)):
                raise ValueError("The research run does not belong to this workspace and root session.")
            if run is not None and obj.get("limits") is not None:
                raise ValueError("Research limits are accepted only on the first message.")
            mode = "steer"
            delivered = text
            if run is None and not self.starting:
                limits = obj.get("limits")
                if limits is not None and not isinstance(limits, dict):
                    raise ValueError("Research limits must be an object.")
                delivered = research_start_prompt(text, {**(limits or {}), "plan_approval": False})
                cfg = self.config if self.config is not None else current_config()
                await asyncio.to_thread(ensure_research_sisters, cfg.get("profiles_root"))
                mode = "start"
            elif run is not None:
                from misaka.core.research import runs

                part = next(part for part in session.moments.parts if isinstance(part, ResearchPart))
                driving = part.is_driving(run["id"])
                live = driving or runs.driver_is_live(run)
                if (run["status"] in {"stopped", "failed"}
                        or (run["status"] == "waiting_input" and not part.is_resuming(run["id"]))
                        or (run["status"] == "active" and not live)):
                    mode = "resume"
                    delivered = f"/research resume {run['id']} {text}"
                elif run["status"] == "done":
                    mode = "followUp"
                elif run["status"] == "stopping":
                    raise ValueError("Research is stopping; send the message after it settles.")
            control = session_control.for_session(session)
            if control is None:
                raise ValueError("The research coordinator has no original control endpoint.")
            command = {"session": session.sessionId, "instance": control.catalog.instance,
                       "operation": "input", "text": delivered, "requestId": request_id}
            if not control.accepting or not control._owns(command):
                raise ValueError("The original research session changed owners before accepting input.")
            control._check_input_owner()
            token = current_request_id.set(request_id)
            correlation = (text, request_id)
            if mode in {"steer", "followUp"}:
                self.pending.append(correlation)
            if mode == "start":
                self.starting = True
            try:
                if mode == "resume":
                    # Slash commands do not create native user entries. Record
                    # the original answer through the engine's durable custom
                    # delivery path before starting its workflow, not a UI notice.
                    await session.sendCustomMessage({"customType": "research-input", "display": True,
                        "content": text, "details": {"run_id": run["id"], "requestId": request_id,
                                                       "kind": "clarification"}},
                        {"triggerTurn": False, "_deliveryId": f"research-input:{session.sessionId}:{request_id}"})
                # Same entry point as socket input: catalog instance fencing,
                # ownership checks, preflight acknowledgement and WindowLO routing.
                await control._execute(command)
            except BaseException:
                if correlation in self.pending:
                    self.pending.remove(correlation)
                if mode == "start":
                    self.starting = False
                raise
            finally:
                current_request_id.reset(token)
            ack = {"accepted": True, "sessionId": session.sessionId,
                    "runId": run["id"] if run is not None else None,
                    "requestId": request_id, "mode": mode}
            self.accepted[request_id] = (text, ack)
            return dict(ack)
