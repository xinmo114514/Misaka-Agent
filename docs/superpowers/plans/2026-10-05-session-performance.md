# 会话与工作区切换流畅度优化

Goal: Show target history before runtime activation; keep typing/scrolling responsive and preserve conversation semantics.

## Tasks
- [x] Frontend: bounded 8-entry / 32MiB history cache, preview/active separation, correlated hydration, errors/retry, duplicate refresh coalescing and guarded runtime settings.
- [x] Backend: opt-in session previews, unchanged-history final acknowledgement, latest pending switch coalescing, cached summaries and cwd-targeted lookup, stage timings.
- [x] Rendering: measured virtual timeline, message memoization, lazy tool/thinking bodies, bounded reading/disclosure state and stable anchors.
- [x] Verification: regression suites, production browser benchmark (cached P95 <=150ms, cold <=500ms for 500 messages <=5MiB, input <=100ms), independent review.

## Interfaces
`load_session` and `switch_workspace` accept `preview: true`. Before activation emit `{seq,sessionId,event:{type:'session_preview',requestId,session,messages,historyVersion}}`. Preview is read-only and follows existing active-branch/compaction projection. `session_started` emitted for desktop commands includes requestId. Final ACK has session/historyVersion, and either messages or `historyUnchanged:true` when the emitted preview remains authoritative. Legacy commands preserve the existing full response. Optional timings are numeric stage durations, not content logs.

Displayed identity uses currentSessionId/currentSessionPath; activeSessionId/activeSessionPath track the backend owner. `isSessionLoading` or `sessionLoadError` gates mutating actions. Late previews/starts/ACKs never replace latest target. Timeout does not mark runtime ready. Existing unsolicited startup events remain supported.

## Constraints / rulings
- Work in the existing `codex/conversation-rendering` feature checkout: uncommitted conversation/settings changes are required inputs; no reset, unrelated edits, commits, pushes or worktree transfer.
- One backend implementer alongside controller-owned frontend; no overlapping file ownership. Review work independently afterwards.
- Never cache live runtimes/extensions across workspaces; preserve abort/shutdown/startup/trust lifecycle. Cache only immutable read results keyed by filesystem revision.
- Preserve complete history, ordered blocks, tool outcomes, entry IDs and disclosure preferences. No DOM assumptions requiring all history mounted.
- Performance numbers are acceptance targets, not claims until fresh production measurement.
