"""Ask the process that owns a research run to record the user's command.

A research intervention is not a database write: it is a tool call that only the owning Last
Order conversation may make (``research.commands`` compares the caller's conversation against the
run's, and the phase's validation lives in closures the driver holds). So a GUI cannot lawfully
record one. It can only ask the owner to record it, which is what a terminal user's turn already
does -- this module routes to the same tool, in the same process, with the same context, over a
socket that refuses strangers when that process is elsewhere.

Three lanes, chosen by who owns the run:

``desktop``
    The bridge opened this run, so its own session is the owner. Ask its ``SessionControl`` to
    run the phase tool it published. ``_owns`` is satisfied by construction, not by an assertion.
``remote``
    A terminal or pane owns it and is still alive: send the command to that process over its
    control socket, and let it execute with *its* context.
``none``
    Nobody owns it -- a terminal started it and exited. Nothing lawful can be recorded yet; the
    desktop has to adopt the run first (``/research resume <run_id> --here``), which rebinds the
    root window through the engine's own path.

Stop, resume and retry are deliberately absent: the engine guards none of those with session
ownership (``runs.request_stop``, ``runs.resume``, ``runs.retry_node`` are called straight from
the ``/research`` command), so the bridge writes them itself.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Literal

from misaka.config import home

#: GUI action -> the phase tool that records it. Kept to tools that publish only while the run
#: waits for the user, so an action the driver has not offered cannot be conjured here.
ACTION_TOOLS: dict[str, str] = {
    "approve_plan": "misaka_research_start",
    "withdraw_round": "misaka_research_withdraw",
    "skip_node": "misaka_research_skip",
    "revise_reconcile": "misaka_research_reconcile",
    "approve_reconcile": "misaka_research_start",
    "consent": "misaka_research_consent",
}


@dataclass(frozen=True)
class Owner:
    """Who may record a command for this run, and how to reach them."""

    kind: Literal["desktop", "remote", "none"]
    session_file: str | None
    record: dict[str, Any] | None = None

    @property
    def reachable(self) -> bool:
        return self.kind != "none"


def _absolute(value: Any) -> str | None:
    """Expand a stored session pointer, tolerating an already-absolute one.

    ``home.from_stored`` leaves absolute paths alone, which matters because the same pointer reads
    differently depending on the connection: ``platform.tasks.Row`` expands ``HOME_POINTERS`` on
    named access, while the bridge's read-only handle is a plain ``sqlite3.Row`` that does not.
    """
    if not value:
        return None
    return str(home.from_stored(str(value)))


def owner_session_file(runs: Any, con: Any, run: Any, node_id: str | None = None) -> str | None:
    """The conversation that records the command: the node's own, else the run's root window.

    The same precedence ``workflow._await_approval`` uses (``current["session_file"] or
    run["root_session"]``), because the wait state that published the tool decided it.
    """
    if node_id:
        node = runs.node(con, node_id)
        if node is not None:
            own = _absolute(node["session_file"])
            if own:
                return own
    return _absolute(run["root_session"])


def resolve_owner(runs: Any, con: Any, run: Any, session: Any = None,
                  node_id: str | None = None) -> Owner:
    """Classify ownership against the live session catalog.

    ``state`` is ``"saved"`` once the owning process let go, and a record carries ``control``
    only while that process is alive -- so a dead terminal reads as unreachable rather than as a
    session to command.
    """
    from misaka.core import session_catalog

    path = owner_session_file(runs, con, run, node_id)
    if not path:
        return Owner("none", None)

    manager = getattr(session, "sessionManager", None)
    own = getattr(manager, "sessionFile", None) if manager is not None else None
    if own and os.path.realpath(own) == os.path.realpath(path):
        return Owner("desktop", path)

    record = session_catalog.owner_record(path)
    if record.get("control") and str(record.get("state") or "") != "saved":
        return Owner("remote", path, record)
    return Owner("none", path)


async def published_tools(session: Any, runs: Any, con: Any, run: Any,
                          node_id: str | None = None) -> list[str]:
    """Which interventions the owner offers right now -- what the GUI may draw.

    The driver registers a phase's tools when the run enters the wait and unregisters them when it
    leaves (``workflow.py:1577-1603``), so this is the only honest source of affordances; asking
    the owner keeps the answer current instead of reimplementing the state machine here.
    """
    owner = resolve_owner(runs, con, run, session, node_id)
    if owner.kind == "desktop":
        control = _control(session)
        return [tool.name for tool in (getattr(control, "review_tools", None) or ())] if control else []
    if owner.kind == "remote":
        from misaka.core import session_control

        try:
            answer = await session_control.request(owner.record, "research_tools")
            return list(answer.get("tools") or [])
        except Exception:  # noqa: BLE001 - an owner that will not answer offers nothing
            return []
    return []


def _control(session: Any):
    from misaka.core import session_control

    return session_control.for_session(session) if session is not None else None


async def invoke(session: Any, runs: Any, con: Any, *, run_id: str, action: str,
                 node_id: str | None = None, payload: dict[str, Any] | None = None,
                 call_id: str | None = None) -> dict[str, Any]:
    """Record one research command in the process that owns the run, through its own gated tool.

    Raises rather than writing when nobody owns the run: the desktop must adopt it first, and a
    refusal with the reason beats a row that no driver will honour.
    """
    if action not in ACTION_TOOLS:
        raise ValueError(f"Unknown research action: {action}")
    tool_name = ACTION_TOOLS[action]
    run = runs.get(con, run_id)
    if run is None:
        raise ValueError(f"No research run {run_id} on this board.")

    owner = resolve_owner(runs, con, run, session, node_id)
    if owner.kind == "none":
        # Refuse with the reason: a row the driver will not honour is worse than no row.
        raise ValueError(
            f"Nobody is driving run {run_id}: its owning conversation is not open. "
            "Adopt it first (/research resume <run_id> --here).")

    arguments = {"tool": tool_name, "payload": payload or {}}
    if call_id:
        arguments["call_id"] = call_id

    if owner.kind == "remote":
        from misaka.core import session_control

        return await session_control.request(owner.record, "research_tool", **arguments)

    control = _control(session)
    if control is None:
        raise ValueError("This desktop session has no control endpoint to command itself with.")
    # The same entry point a socket client reaches, called in-process: the fencing in
    # ``_owns`` is satisfied by this session's own identity, so nothing is asserted about
    # anyone else's conversation.
    command = {"session": control.session.sessionId, "instance": control.catalog.instance,
               "operation": "research_tool", **arguments}
    return await control._research_command(command, "research_tool")
