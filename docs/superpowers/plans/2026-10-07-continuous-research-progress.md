# Continuous research implementation ledger

Authority: user's approved “研究模式改造：直接发送、自动准备、持续对话” plan in this chat.

## Decisions
- Work in the current checkout: the running desktop and all prerequisite capsule/bridge code exist as uncommitted/untracked changes. Preserve that state; no reset, destructive cleanup or commit of unrelated changes.
- Keep independent root research process and ordinary chat state isolated. Use `send_research_message` with validated root owner and a real snapshot from `get_research_host`.
- Start acknowledgement means accepted, not created; true research-discipline confirms creation. Preserve the draft on startup failure.
- Reuse existing planner/SessionControl input and durable default roster; do not create fake UI-only workflows.

## Contract review
| Tasks | Shared contract | Decision |
|---|---|---|
| Backend/state/UI | host snapshot | enabled, session, messages, historyVersion, lastEventSeq, run, stats, contextUsage |
| Backend/UI | send_research_message | text, sessionId, optional runId, requestId, optional first-start limits |
| State/UI | research binding | sessionId, sessionFile, workspace, nullable runId |
| State/UI | real events | isolated conversation reducer; no synthetic discipline messages |

## Tasks
- [x] Backend root assembly, default roster, validated continuous message ingress and snapshots (research_backend).
- [x] Independent frontend research reducer, binding, card hydration and event isolation (research_state).
- [x] Composer, Electron allowlist, Timeline, history, restart/stop UX and true event fixtures (root).
- [x] Independent read-only cross-layer review: no remaining confirmed P1/P2 findings.
- [x] Final production build and latest runtime/browser rechecks.

## Verification evidence
- Complete frontend suite: 50 files, 382 tests passed before final narrowly scoped lifecycle/report refinements; those refinements have fresh focused coverage.
- Backend focused suite: 263 passed, 1 uv subprocess probe deselected; parent's separate continuous/bridge/start suite: 91 passed, same 1 deselected.
- An attempted full 92-case parent suite failed only the legacy uv child launch with Windows WinError 5. The real Electron test successfully launches that same Python bridge via the actual app transport.
- Browser workflow suite: 8 passed, covering research supplement, clarification, report followup, history, task drawer, graph, and ordinary-chat regression.
- Real Electron isolated-profile smoke: root ResearchPart enabled; true transcript/stream identity snapshots round-trip; normal shutdown passes after closing stdin to release Python's read executor.
- Research native-runtime coverage uses real AgentSession and persisted entries with deterministic provider responses/scripted costly workflow workers. No external model budget consumed; complete live-provider research was not run.
- Final fresh checks: 84 relevant frontend tests passed; TypeScript + Vite/Electron build passed; 8 browser workflows passed; real Electron isolated root-host/IPC/shutdown smoke passed (13.3s). Native busy snapshots and waiting-input clear guards are included in these final checks.
- Integration decision: retain changes uncommitted in the existing user workspace; no merge, push, or unrelated cleanup requested/performed.
