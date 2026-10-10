"""Narrow desktop ingress to a research conversation's original SessionControl.

This lane validates ownership before touching the session. It never adopts a run,
writes phase approvals, or relaxes the desktop's ordinary session-mutation guards.
"""
from __future__ import annotations

import asyncio
import os
import re
from contextvars import ContextVar

from misaka.config import home
from misaka.core import session_control
from misaka.core.research import submissions
from misaka.core.research.wiring.research import ResearchPart, parse_command
from misaka.utils.values import read_field

current_request_id: ContextVar[str | None] = ContextVar("research_request_id", default=None)

# The engine's own grammar (parse_command) decides what a keyword means; this lane only
# recognizes those words so desktop input can fold their case before handing text over.
RESEARCH_COMMAND_KEYWORDS = frozenset({"resume", "stop", "status", "help", "limits", "tell", "start"})
_RESEARCH_PREFIX = re.compile(r"^\s*/research(?:\s+|$)", re.IGNORECASE)
_STOP_PREFIX = re.compile(r"^\s*/stop(?=\s|$)", re.IGNORECASE)


def research_command_body(text):
    """Return the text after a ``/research`` prefix, or None for anything else."""
    if not isinstance(text, str):
        return None
    prefix = _RESEARCH_PREFIX.match(text)
    return None if prefix is None else text[prefix.end():]


def split_research_command(text):
    """Return ``(keyword, arguments)`` when the body opens with a known keyword."""
    body = research_command_body(text)
    if not body or not body.strip():
        return None
    keyword = body.split(None, 1)[0]
    if keyword.lower() not in RESEARCH_COMMAND_KEYWORDS:
        return None
    return keyword.lower(), body[len(keyword):]


def normalize_research_command(text):
    """Fold only the keyword's case; the argument body stays byte-for-byte."""
    split = split_research_command(text)
    return None if split is None else f"/research {split[0]}{split[1]}"


def render_research_command(action, run_id=None, text=None):
    """Build a research control command in the single form the engine parser accepts."""
    parts = ["/research", action]
    parts.extend(str(value) for value in (run_id, text) if value)
    return " ".join(parts)


def parse_research_control(text):
    """Parse desktop ``/research resume|stop`` without rewriting its free-text tail.

    ``parse_command`` owns the research grammar.  Only the command words are
    normalized here because desktop input treats slash-command keywords as
    case-insensitive; the answer itself is passed to the parser byte-for-byte
    apart from the grammar's documented edge trimming.
    """
    split = split_research_command(text)
    if split is None and isinstance(text, str):
        alias = _STOP_PREFIX.match(text)
        if alias is not None:
            split = ('stop', text[alias.end():])
    if split is None or split[0] not in {"resume", "stop"}:
        return None
    parsed = parse_command(f"{split[0]}{split[1]}")
    return parsed if parsed.get('action') == split[0] else None


def validate_research_input(obj, session_id):
    if obj.get('sessionId') != session_id:
        raise submissions.ResearchInputError('Research session changed; refresh before sending.',
                                             'RESEARCH_SESSION_CHANGED', retryable=False)
    text = obj.get('text')
    if not isinstance(text, str):
        raise submissions.ResearchInputError('研究消息需要文字内容；原始草稿已保留。', 'RESEARCH_TEXT_TYPE')
    if not text.strip():
        raise submissions.ResearchInputError('请先输入研究问题或补充内容。', 'RESEARCH_TEXT_EMPTY')
    text = text.strip()
    control = parse_research_control(text)
    if text.startswith('/') and control is None:
        raise submissions.ResearchInputError('请通过研究控制入口执行命令；正文仍保留在草稿中。',
                                             'RESEARCH_CONTROL_REQUIRED')
    request_id = obj.get('requestId')
    if not isinstance(request_id, str) or not request_id.strip():
        raise submissions.ResearchInputError('send_research_message requires requestId', 'RESEARCH_REQUEST_ID')
    return text, control


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


def adoptable_run(session, con, obj, run_lookup=None):
    """The run this input continues, or ``None`` when the caller opens a fresh one.

    A descriptor command may name a run explicitly; otherwise the newest run that
    owns this root is adopted. ``startNew`` refuses to fold a fresh question into a
    settled run, while an active run still owns the conversation and is returned so
    the existing single-run-per-session guard applies.
    """
    from misaka.core.research import runs

    run = (run_lookup or session_run)(session, con)
    if run is None:
        return None
    if obj.get('startNew') and run['status'] not in runs.ACTIVE:
        return None
    return run


class ResearchMessageIngress:
    def __init__(self, session, *, config=None):
        self.session = session
        self.config = config
        self.lock = asyncio.Lock()
        self.starting = False
        self.pending = []
        self.accepted = {}

    def _durable_receipt(self, request_id, text, requested_run_id, run=None, *, control_action=None, limits=None, start_new=False):
        """Recover an accepted start/clarification from the root transcript.

        The engine already persists these entries with the desktop request id.
        Reusing them prevents a renderer retry after a bridge restart from
        launching the same workflow input again, without another board table.
        """
        receipt = submissions.lookup(self.session, request_id)
        if receipt is not None:
            submissions.assert_identity(receipt, text, requested_run_id, control_action=control_action, limits=limits,
                                        start_new=start_new)
            if receipt['state'] == 'rejected':
                return None
            delivery = submissions.native_delivery(self.session, receipt.get('deliveryId'))
            if receipt['state'] in {'prepared', 'unconfirmed'} and delivery:
                receipt = submissions.record(self.session, request_id, 'applied', entryId=delivery.get('id'))
            if receipt['state'] not in {'accepted', 'applied'}:
                raise submissions.ResearchInputError('发送结果尚未确认，请先核对研究记录。',
                    'RESEARCH_DELIVERY_UNCONFIRMED', stage='reconciliation', retryable=False)
            if receipt.get('mode') in {'steer', 'followUp'} and not delivery:
                control = session_control.for_session(self.session)
                if control is None or receipt.get('instance') != control.catalog.instance:
                    raise submissions.ResearchInputError('队列接收记录已保留，执行结果尚未确认。',
                        'RESEARCH_DELIVERY_UNCONFIRMED', stage='reconciliation', retryable=False)
            # The ack was written before the run existed; replay it with the identity the
            # receipt has since learned, or a retry reports a start with no run to bind.
            ack = {**(receipt.get('ack') or {})}
            ack.setdefault('accepted', True)
            ack.setdefault('sessionId', self.session.sessionId)
            ack.setdefault('mode', receipt.get('mode'))
            ack['requestId'] = request_id
            ack['runId'] = receipt.get('runId') or ack.get('runId')
            return ack
        manager = getattr(self.session, "sessionManager", None)
        entries = manager.getEntries() if manager is not None and hasattr(manager, "getEntries") else []
        for entry in reversed(entries):
            if not isinstance(entry, dict) or entry.get("type") != "custom_message":
                continue
            details = entry.get("details")
            if not isinstance(details, dict) or details.get("requestId") != request_id:
                continue
            kind = entry.get("customType")
            if kind == "research-input":
                recorded_text = str(entry.get("content") or "").strip()
                run_id = details.get("run_id")
                if recorded_text != text or requested_run_id not in {None, run_id}:
                    raise submissions.request_conflict()
                raise submissions.ResearchInputError('补充内容已记录，研究执行结果尚未确认。',
                    'RESEARCH_DELIVERY_UNCONFIRMED', stage='reconciliation', retryable=False)
            if kind == "research-question":
                recorded_text = str(details.get("question") or "").strip()
                if recorded_text != text or (requested_run_id is not None and (run is None or requested_run_id != run['id'])):
                    raise submissions.request_conflict()
                if run is None:
                    raise submissions.ResearchInputError('研究问题已记录，创建结果尚未确认。',
                        'RESEARCH_DELIVERY_UNCONFIRMED', stage='reconciliation', retryable=False)
                return {"accepted": True, "sessionId": self.session.sessionId,
                        "runId": None, "requestId": request_id, "mode": "start"}
        return None

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
        text, control_spec = validate_research_input(obj, session.sessionId)
        if not any(isinstance(part, ResearchPart) for part in session.moments.parts):
            raise ValueError("This session is not a research coordinator.")
        request_id = obj.get("requestId")
        command_run_id = control_spec.get("run_id") if control_spec is not None else None
        object_run_id = obj.get("runId")
        if object_run_id is not None and (not isinstance(object_run_id, str) or not object_run_id.strip()):
            raise ValueError("runId must be a nonempty string")
        if command_run_id and object_run_id and command_run_id != object_run_id:
            raise ValueError("The research run does not belong to this workspace and root session.")
        requested_run_id = command_run_id or object_run_id
        if control_spec is not None:
            text = str(control_spec.get("clarification") or "").strip()
        # Research controls go through dedicated commands. Text ingress is prose,
        # so it must not turn a slash command into a session/tree mutation.
        async with self.lock:
            if request_id in self.accepted and submissions.lookup(session, request_id) is None:
                accepted_text, accepted_run_id, ack = self.accepted[request_id]
                if accepted_text != text or requested_run_id != accepted_run_id:
                    raise submissions.request_conflict()
                return dict(ack)
            run = (con.execute("SELECT * FROM research_runs WHERE id=?", (requested_run_id,)).fetchone()
                   if con is not None and requested_run_id else adoptable_run(session, con, obj))
            if requested_run_id and (run is None or not owns_run(session, run)):
                raise ValueError("The research run does not belong to this workspace and root session.")
            if control_spec is not None and run is None:
                raise ValueError("The research run does not belong to this workspace and root session.")
            durable = self._durable_receipt(request_id, text, requested_run_id, run,
                control_action=control_spec.get('action') if control_spec else None, limits=obj.get('limits'),
                start_new=bool(obj.get('startNew')))
            if durable is not None:
                self.accepted[request_id] = (text, requested_run_id, durable)
                return dict(durable)
            # Replay an already admitted start before considering the current
            # run: its own creation must not turn an identical retry into a new start.
            if obj.get('startNew') and requested_run_id is None:
                from misaka.core.research import runs

                existing = session_run(session, con)
                if existing is not None and existing['status'] in runs.ACTIVE:
                    raise ValueError("A research run is already active in this session; stop it before starting another.")
            if run is not None and obj.get("limits") is not None:
                raise ValueError("Research limits are accepted only on the first message.")
            mode = "steer"
            delivered = text
            if control_spec is not None and control_spec["action"] == "stop":
                mode = "stop"
                delivered = render_research_command("stop", run["id"])
            elif control_spec is not None:
                mode = "resume"
                delivered = render_research_command("resume", run["id"], text)
            elif run is None and not self.starting:
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
                    delivered = render_research_command("resume", run["id"], text)
                elif run["status"] == "done":
                    mode = "followUp"
                elif run["status"] == "stopping":
                    raise ValueError("Research is stopping; send the message after it settles.")
            control = session_control.for_session(session)
            if control is None:
                raise ValueError("The research coordinator has no original control endpoint.")
            command = {"session": session.sessionId, "instance": control.catalog.instance,
                       "operation": "input", "text": delivered, "requestId": request_id,
                       "streamingBehavior": 'followUp' if mode == 'followUp' else 'steer'}
            delivery_id = f'research:{session.sessionId}:{request_id}'
            if mode in {'steer', 'followUp'}:
                command['deliveryId'] = delivery_id
            if not control.accepting or not control._owns(command):
                raise ValueError("The original research session changed owners before accepting input.")
            control._check_input_owner()
            correlation = (text, request_id)
            ack = {"accepted": True, "sessionId": session.sessionId,
                    "runId": run["id"] if run is not None else None,
                    "requestId": request_id, "mode": mode}
            submissions.record(session, request_id, 'prepared', textHash=submissions.text_fingerprint(text),
                initialRunId=requested_run_id, runId=ack['runId'], mode=mode, ack=ack,
                controlAction=control_spec.get('action') if control_spec else None, limits=obj.get('limits'),
                deliveryId=delivery_id, instance=control.catalog.instance, input=submissions.original_input(obj),
                errorCode=None, errorStage=None, retryable=False)
            # Journal admission can fail synchronously. Change transient routing only
            # after its write succeeds, so disk errors leave no phantom start/token.
            token = current_request_id.set(request_id)
            if mode in {"steer", "followUp"}:
                self.pending.append(correlation)
            if mode == "start":
                self.starting = True
            try:
                if mode == "resume" and text and not submissions.recorded_input(session, request_id, 'research-input'):
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
            except BaseException as error:
                if correlation in self.pending:
                    self.pending.remove(correlation)
                if mode == "start":
                    self.starting = False
                submissions.record(session, request_id, 'unconfirmed' if isinstance(error, asyncio.CancelledError) else 'rejected',
                    errorCode='RESEARCH_PREFLIGHT_FAILED', errorStage='preflight',
                    retryable=not isinstance(error, asyncio.CancelledError))
                raise
            finally:
                current_request_id.reset(token)
            # Slash controls have already returned from their native handler. They
            # have no queued user message that could later mark the receipt applied.
            # This denotes control delivery, not successful research/model execution.
            submissions.record(session, request_id, 'applied' if mode in {'resume', 'stop'} else 'accepted')
            self.accepted[request_id] = (text, requested_run_id, ack)
            return dict(ack)
