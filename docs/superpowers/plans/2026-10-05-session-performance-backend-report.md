# Backend session-performance implementation report

Date: 2026-10-06. Workspace: existing `codex/conversation-rendering` checkout. No commit, reset, worktree transfer, or frontend edits.

## Protocol and behavior

- `load_session` and `switch_workspace` accept `preview: true`. For an existing target the bridge reads `SessionManager.openInMemory`, projects the active branch/compaction context via `buildContextEntries`, and emits `session_preview` with `requestId`, `session`, `messages`, `historyVersion` **before** `runtime_host.switchSession`. The in-memory open does not repair or write the target JSONL.
- Final ACKs include `session` and `historyVersion` in opt-in mode. If the target revision remains authoritative, ACK/data contain `historyUnchanged: true` and omit `messages`; if the file changed during activation, both contain the fresh messages. A newly created workspace has no preview and sends messages plus a synthetic `new:<sessionId>` version. Legacy requests still return full message payloads.
- Desktop `session_started` events for load/workspace/new/fork carry the command `requestId`; unsolicited runtime events remain unchanged. Explicit missing session paths and workspace/session cwd mismatch fail before runtime mutation. Runtime cancellation now sends an unsuccessful cancelled ACK rather than a success/start event.
- The stdin pump and serialized command worker are separate. The pump replaces only an *adjacent pending* switch with the latest switch and ACKs the superseded request `{ok:false,cancelled:true}`. In-flight commands cannot be coalesced; prompts/settings/other commands form FIFO boundaries. EOF drains pending commands before shutdown.
- Workspace lookup checks the encoded cwd bucket and then the flat legacy root by reading headers and stopping at the newest cwd match, rather than enumerating/parsing all session histories. Lookup never creates a bucket; runtime creation retains the normal directory lifecycle.
- Session summaries use revision-keyed LRU reuse (real path, nanosecond mtime/ctime, size), copy cached `SessionInfo` on return, and cap retention to 256 entries / approximately 32 MiB. `list_sessions` serializes `fileRevision` as `mtime_ns:size` for frontend invalidation even when the last activity timestamp is unchanged.
- Opt-in ACK `timings` contains numeric `queueMs`, `fileMs`, `historyMs`, `runtimeMs`; runtime switch also supplies `abortMs`, `shutdownMs`, `disposeMs`, `prepareMs`, `bindMs` where available. Timings do not log conversation content. `prepareMs` includes service creation and session activation; no live runtime/services/extensions are cached.

## Red/green evidence

- Opt-in preview/unchanged ACK and adjacent pending switch coalescing initially failed with missing preview and old request succeeding; targeted green: 4 passed.
- Summary reuse initially reread unchanged files twice; targeted green: 3 passed including revision invalidation and cache-budget test.
- Missing explicit load target, mismatched workspace target, no lookup-created bucket, and synthetic new-workspace version each failed before their fixes; targeted reruns green.
- Teardown phase timing test initially lacked `lastSwitchTimings` (after fixing the test's extension-runner fixture); targeted green: 1 passed.
- A changed-on-activation history test confirms final messages and a new version; a real cwd-bucket test confirms no `listAll` traversal.

## Verification

- Focused regression command (all relevant backend/branch/JSONL tests excluding subprocess integration): `69 passed, 1 deselected` (see fresh verification in agent handoff; prior run was `68 passed, 1 deselected` before final workspace-preview test).
- Subprocess `test_cli_pipe_integration` passes in isolation (`1 passed, 31 deselected in 13.15s`). In two combined runs its 20-second `uv run` subprocess timeout fired under suite startup contention while the remaining tests passed; no protocol failure observed in isolated repro. A combined run before the final test had `68 passed, 1 failed` solely from this timeout. The test's fixed timeout is retained; no timeout relaxation or unrelated process termination performed.
- `ruff check` on modified production modules and new focused tests: `All checks passed!` after import/style cleanup. `git diff --check` clean apart from Git's CRLF conversion notices.

## Scope and remaining performance measurement

Production browser benchmark acceptance numbers (cached P95 ≤150ms, cold ≤500ms for 500 messages ≤5MiB, input ≤100ms) require controller-owned frontend/integration measurement and are not claimed here. Actual service-preparation internals are represented by aggregate `prepareMs`; no extension/runtime object is reused across workspaces.
