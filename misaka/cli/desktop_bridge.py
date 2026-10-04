"""Desktop bridge for JSONL stdio communication with Electron frontend."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import socket
import sys
import urllib.parse
from typing import Any

from misaka.core.output_guard import (
    flushRawStdout,
    isStdoutTakenOver,
    restoreStdout,
    takeOverStdout,
    waitForRawStdoutBackpressure,
    writeRawStdout,
)
from misaka.core.session_manager import SessionInfo, SessionManager
from misaka.modes.jsonl import to_json_event, to_jsonable
from misaka.ui.tui.interactive.theme.theme import (
    get_resolved_theme_colors,
    load_theme_json,
)
from misaka.utils.shell import killTrackedDetachedChildren
from misaka.utils.values import read_field


def _clean_broken_local_proxies() -> None:
    for var in ("ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"):
        val = os.environ.get(var)
        if val and ("127.0.0.1" in val or "localhost" in val):
            try:
                parsed = urllib.parse.urlparse(val)
                port = parsed.port or (7890 if "7890" in val else 8080)
                host = parsed.hostname or "127.0.0.1"
                with socket.create_connection((host, port), timeout=0.1):
                    pass
            except Exception:  # noqa: BLE001
                os.environ.pop(var, None)


def _serialize_session_info(s: SessionInfo) -> dict[str, Any]:
    created_str = (
        s.created.isoformat()
        if hasattr(s.created, "isoformat")
        else str(s.created)
    )
    modified_str = (
        s.modified.isoformat()
        if hasattr(s.modified, "isoformat")
        else str(s.modified)
    )
    return {
        "path": s.path,
        "id": s.id,
        "cwd": s.cwd,
        "created": created_str,
        "modified": modified_str,
        "messageCount": s.messageCount,
        "firstMessage": s.firstMessage,
        "allMessagesText": s.allMessagesText,
        "name": s.name,
        "parentSessionPath": s.parentSessionPath,
    }


def _get_desktop_theme_colors(theme_name: str | None = None) -> dict[str, Any]:
    colors = get_resolved_theme_colors(theme_name)
    try:
        theme_json = load_theme_json(theme_name or "dark")
    except Exception:  # noqa: BLE001
        theme_json = {}
    desktop_section = theme_json.get("desktop") if isinstance(theme_json, dict) else {}
    if not isinstance(desktop_section, dict):
        desktop_section = {}

    default_desktop = {
        "surface2": "#25252d",
        "surface3": "#2c2c36",
        "surfaceHover": "#232329",
        "borderSubtle": colors.get("borderMuted", "#2a2a33"),
        "border": colors.get("border", "#37373f"),
        "borderAccent": colors.get("borderAccent", "#8f2545"),
        "disabled": "#6e5f64",
        "focusRing": colors.get("accent", "#e8698c"),
        "chart": ["#cb3862", "#e0b23e", "#acd39c", "#3c9a80", "#4f70c4", "#c191d4"],
    }
    merged_desktop = {**default_desktop, **desktop_section}
    return {**colors, "desktop": merged_desktop}


def _safe_to_json_event(event: Any) -> Any:
    try:
        return to_json_event(event)
    except Exception as error:  # noqa: BLE001
        print(f"Warning: to_json_event fallback: {error}", file=sys.stderr)
        return to_jsonable(event)


def _serialize_event(seq_num: int, session_id: str, raw_event: Any) -> str:
    payload = {
        "seq": seq_num,
        "sessionId": session_id,
        "event": _safe_to_json_event(raw_event),
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"


def _serialize_ack(
    request_id: str | None,
    ok: bool,
    error: str | None = None,
    data: Any = None,
    **extra: Any,
) -> str:
    payload: dict[str, Any] = {
        "type": "ack",
        "requestId": request_id,
        "ok": ok,
    }
    if error is not None:
        payload["error"] = error
    if data is not None:
        payload["data"] = data
    payload.update(extra)
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
async def run_desktop_bridge(runtime_host: Any, options: Any = None) -> int:
    """Run the desktop bridge loop transferring stdio commands and JSONL events."""
    _clean_broken_local_proxies()
    session = runtime_host.session
    unsubscribe = None
    unsubscribe_backpressure = None
    disposed = False
    signal_cleanup_handlers: list[tuple[int, Any]] = []
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    seq = 0
    active_prompt_task: asyncio.Task[None] | None = None
    took_over = False

    if not isStdoutTakenOver():
        takeOverStdout()
        took_over = True

    def write_ack(
        request_id: str | None,
        ok: bool,
        error: str | None = None,
        data: Any = None,
        **extra: Any,
    ) -> None:
        writeRawStdout(_serialize_ack(request_id, ok, error, data, **extra))

    def handle_event(event: Any) -> None:
        nonlocal seq
        seq += 1
        line = _serialize_event(seq, session.sessionId, event)
        writeRawStdout(line)

    async def dispose_runtime() -> None:
        nonlocal disposed, unsubscribe, unsubscribe_backpressure
        if disposed:
            return
        disposed = True
        if callable(unsubscribe):
            unsubscribe()
            unsubscribe = None
        if callable(unsubscribe_backpressure):
            unsubscribe_backpressure()
            unsubscribe_backpressure = None
        await runtime_host.dispose()

    async def rebind_session(_session: Any = None) -> None:
        nonlocal session, unsubscribe, unsubscribe_backpressure
        session = runtime_host.session

        async def _fork(entry_id: str, fork_options: Any = None) -> dict[str, Any]:
            result = await runtime_host.fork(entry_id, fork_options)
            return {"cancelled": read_field(result, "cancelled")}

        async def _navigate_tree(target_id: str, navigate_options: Any = None) -> dict[str, Any]:
            result = await session.navigateTree(
                target_id,
                {
                    "summarize": read_field(navigate_options, "summarize"),
                    "customInstructions": read_field(navigate_options, "customInstructions"),
                    "replaceInstructions": read_field(navigate_options, "replaceInstructions"),
                    "label": read_field(navigate_options, "label"),
                },
            )
            return {"cancelled": read_field(result, "cancelled")}

        async def _reload() -> None:
            await session.reload()

        await session.bindExtensions(
            {
                "mode": "json",
                "commandContextActions": {
                    "waitForIdle": lambda: session.waitForIdle(),
                    "newSession": lambda new_session_options=None: runtime_host.newSession(new_session_options),
                    "fork": _fork,
                    "navigateTree": _navigate_tree,
                    "switchSession": lambda session_path, switch_options=None: runtime_host.switchSession(
                        session_path,
                        switch_options,
                    ),
                    "reload": _reload,
                },
                "onError": lambda error: print(
                    f"Extension error ({read_field(error, 'extensionPath', '<unknown>')}): "
                    f"{read_field(error, 'error', error)}",
                    file=sys.stderr,
                ),
            }
        )

        if callable(unsubscribe):
            unsubscribe()
        if callable(unsubscribe_backpressure):
            unsubscribe_backpressure()
        unsubscribe = session.subscribe(handle_event)
        unsubscribe_backpressure = session.agent.subscribe(
            lambda _event, _signal=None: waitForRawStdoutBackpressure()
        )

    def register_signal_handlers() -> None:
        signals = [signal.SIGTERM]
        sighup = getattr(signal, "SIGHUP", None)
        if sys.platform != "win32" and sighup is not None:
            signals.append(sighup)

        for current_signal in signals:
            previous_handler = signal.getsignal(current_signal)

            def _handler(_signum: int, _frame: Any, *, current_signal: int = current_signal) -> None:
                killTrackedDetachedChildren()
                exit_code = 129 if sighup is not None and current_signal == sighup else 143
                task = loop.create_task(dispose_runtime())
                task.add_done_callback(lambda _task, exit_code=exit_code: sys.exit(exit_code))

            signal.signal(current_signal, _handler)
            signal_cleanup_handlers.append((current_signal, previous_handler))
    async def dispatch_command(obj: dict[str, Any]) -> None:
        nonlocal active_prompt_task
        req_id = obj.get("requestId")
        cmd_type = obj.get("type") or obj.get("command") or obj.get("action")
        if not cmd_type and "text" in obj and "path" not in obj:
            cmd_type = "prompt"

        if not cmd_type:
            write_ack(req_id, ok=False, error="Missing command type")
            return

        cmd = str(cmd_type).lower()
        if cmd == "prompt":
            text = obj.get("text")
            if not isinstance(text, str):
                write_ack(req_id, ok=False, error="prompt requires 'text' string")
                return
            images = obj.get("images")
            streaming_behavior = obj.get("streamingBehavior")

            if session.isStreaming and not streaming_behavior:
                write_ack(
                    req_id,
                    ok=False,
                    error="Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
                )
                return

            write_ack(req_id, ok=True)

            async def _run_prompt() -> None:
                try:
                    prompt_opts: dict[str, Any] = {"images": images}
                    if streaming_behavior:
                        prompt_opts["streamingBehavior"] = streaming_behavior
                    await session.prompt(text, prompt_opts)
                except Exception as exc:  # noqa: BLE001
                    print(f"Prompt error: {exc}", file=sys.stderr)

            task = loop.create_task(_run_prompt())
            active_prompt_task = task

        elif cmd == "steer":
            text = obj.get("text")
            if not isinstance(text, str):
                write_ack(req_id, ok=False, error="steer requires 'text' string")
                return
            try:
                await session.steer(text, obj.get("images"))
                write_ack(req_id, ok=True)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("follow_up", "followup"):
            text = obj.get("text")
            if not isinstance(text, str):
                write_ack(req_id, ok=False, error="follow_up requires 'text' string")
                return
            try:
                await session.followUp(text, obj.get("images"))
                write_ack(req_id, ok=True)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd == "abort":
            try:
                await session.abort()
                write_ack(req_id, ok=True)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("set_model", "setmodel"):
            provider = obj.get("provider")
            model_id = obj.get("modelId") or obj.get("model")
            if not provider or not model_id:
                write_ack(req_id, ok=False, error="set_model requires 'provider' and 'modelId'")
                return
            model = session.modelRegistry.find(provider, model_id)
            if model is None:
                write_ack(req_id, ok=False, error=f"Model not found: {provider}/{model_id}")
                return
            try:
                await session.setModel(model)
                write_ack(req_id, ok=True)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("set_thinking", "setthinking"):
            level = obj.get("level")
            if not level:
                write_ack(req_id, ok=False, error="set_thinking requires 'level'")
                return
            try:
                session.setThinkingLevel(level)
                write_ack(req_id, ok=True)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("get_stats", "getstats"):
            try:
                stats = session.getSessionStats()
                context_usage = session.getContextUsage()
                stats_payload = {
                    "stats": to_jsonable(stats),
                    "contextUsage": to_jsonable(context_usage),
                }
                write_ack(req_id, ok=True, data=stats_payload, **stats_payload)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("get_tools", "gettools"):
            try:
                tools = session.getAllTools()
                slash_commands = session.getSlashCommands()
                tools_payload = {
                    "tools": to_jsonable(tools),
                    "slashCommands": to_jsonable(slash_commands),
                }
                write_ack(req_id, ok=True, data=tools_payload, **tools_payload)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("list_sessions", "listsessions"):
            try:
                target_cwd = obj.get("cwd") or session.sessionManager.getCwd()
                sessions_list = await SessionManager.list(target_cwd)
                sessions_data = [_serialize_session_info(s) for s in sessions_list]
                write_ack(req_id, ok=True, data=sessions_data, sessions=sessions_data)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("load_session", "loadsession"):
            path = obj.get("path")
            if not path:
                write_ack(req_id, ok=False, error="load_session requires 'path'")
                return
            try:
                await runtime_host.switchSession(path)
                write_ack(req_id, ok=True)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("set_theme", "settheme"):
            name = obj.get("name")
            if not name:
                write_ack(req_id, ok=False, error="set_theme requires 'name'")
                return
            try:
                colors = _get_desktop_theme_colors(name)
                write_ack(req_id, ok=True, data=colors, colors=colors)
            except Exception as error:  # noqa: BLE001
                write_ack(req_id, ok=False, error=str(error))

        elif cmd in ("shutdown", "exit", "quit"):
            write_ack(req_id, ok=True)
            stop_event.set()

        else:
            write_ack(req_id, ok=False, error=f"Unknown command: {cmd_type}")
    async def process_line(line: str) -> None:
        try:
            obj = json.loads(line)
        except Exception as error:  # noqa: BLE001
            write_ack(None, ok=False, error=f"Invalid JSON: {error}")
            return

        if not isinstance(obj, dict):
            write_ack(None, ok=False, error="Command must be a JSON object")
            return

        await dispatch_command(obj)

    async def stdin_reader() -> None:
        while not stop_event.is_set():
            try:
                line = await asyncio.to_thread(sys.stdin.readline)
            except Exception:  # noqa: BLE001
                break
            if line == "":
                # EOF reached on stdin
                if active_prompt_task and not active_prompt_task.done():
                    try:
                        await active_prompt_task
                    except Exception:  # noqa: BLE001, S110
                        pass
                stop_event.set()
                break
            stripped = line.strip()
            if not stripped:
                continue
            await process_line(stripped)

    reader_task: asyncio.Task[None] | None = None
    try:
        register_signal_handlers()
        runtime_host.setRebindSession(rebind_session)
        await rebind_session()

        reader_task = loop.create_task(stdin_reader())
        await stop_event.wait()
        return 0
    except Exception as error:  # noqa: BLE001
        print(f"Bridge error: {error}", file=sys.stderr)
        return 1
    finally:
        if reader_task and not reader_task.done():
            reader_task.cancel()
        for current_signal, previous_handler in signal_cleanup_handlers:
            signal.signal(current_signal, previous_handler)
        await dispose_runtime()
        await flushRawStdout()
        if took_over and isStdoutTakenOver():
            restoreStdout()


def main(args: Any = None) -> int:
    """Entry point for desktop bridge CLI command."""
    from misaka.windows_bootstrap import apply_windows_utf8_bootstrap

    apply_windows_utf8_bootstrap()
    _clean_broken_local_proxies()

    cwd = getattr(args, "cwd", None) or os.getcwd()
    flags: list[str] = ["--mode", "json"]
    if getattr(args, "no_session", False):
        flags.append("--no-session")
    if getattr(args, "session", None):
        flags.extend(["--session", str(args.session)])
    if getattr(args, "model", None):
        flags.extend(["--model", str(args.model)])
    if getattr(args, "theme", None):
        theme_str = str(args.theme)
        if theme_str.endswith(".json") or os.path.exists(theme_str):
            flags.extend(["--theme", theme_str])
        else:
            flags.extend(["--use-theme", theme_str])

    from misaka.core.platform.session import open_session

    async def _run() -> int:
        runtime, _session, error = await open_session(flags, cwd)
        if error:
            print(f"Error opening bridge session: {error}", file=sys.stderr)
            if runtime is not None:
                await runtime.dispose()
            return 1
        return await run_desktop_bridge(runtime, {"cwd": cwd})

    try:
        return asyncio.run(_run())
    except Exception as error:  # noqa: BLE001
        print(f"Bridge runtime fatal error: {error}", file=sys.stderr)
        return 1


__all__ = ["main", "run_desktop_bridge"]
