# Conversation rendering implementation

Approved scope: fix ordered Markdown, multi-message tool turns, history parity, thinking disclosure and conversation/composer styling. Preserve sidebar, headers, theme tokens, model picker and thinking slider changes.

## Tasks
- [x] Add shared replay fixture and frontend regression test infrastructure.
- [x] Preserve ordered history content and tool results in the Python bridge; add HTTP/HTTPS external-link IPC.
- [x] Normalize ordered blocks and implement message/run/tool lifecycles with session-scoped event replay tests.
- [x] Replace Markdown parser with Streamdown 2.5.0 + CJK 1.0.3 and implement accessible ordered timeline/composer UI.
- [x] Verify tests, typecheck, lint, build, and light/dark/narrow browser acceptance; review complete diff.

## Locked interfaces
`ChatMessage.blocks` is the canonical ordered array. Text blocks: `{type:'text', id, contentIndex, text, isStreaming?}`. Thinking blocks: `{type:'thinking', id, contentIndex, thinking, isStreaming?}`. Tool blocks: `{type:'toolCall', id, contentIndex, toolCall:ToolCall}`. Legacy content/thinking/toolCalls are projected from blocks. ToolCall status is pending/running/success/error/cancelled and includes optional result, partialResult, details and error. Tool results preserve raw content blocks.

Only `agent_settled` ends the run. `message_end` finalizes the current message; subsequent message_start appends a new assistant message. Tool result messages update existing calls without appearing twice. Rendering follows contentIndex order; grouping stops at text. Manual disclosure choices are stable. Thinking is open during generation and closes at thinking completion, except saved folding preference/manual overrides. Composer height is measured and live scroll follows only when already at the bottom.

## Rulings and progress
- Work in place on a feature branch: the approved plan explicitly preserves in-flight work in this checkout; no worktree or rollback is introduced.
- Do not commit unrelated user changes; deliver reviewed working-tree changes.
- Existing sandbox process initialization fails; required commands request reviewed escalation rather than bypassing permissions.
- Shared interface scan: bridge emits the same block shapes consumed by state normalizer and renderer; root owns types/state/dependencies, bridge agent owns Python/IPC, UI agent owns components/scoped styles. No shared-file write overlap.

## Verification record
- 50 frontend regression tests, 21 Python bridge tests and 5 real-browser acceptance tests pass.
- Typecheck and lint pass; production renderer/main/preload builds pass. Vite reports a >500kB chunk warning; no warning threshold is suppressed.
- Browser screenshots: desktop/test-results/conversation-{light,dark,narrow}.png; browser acceptance uses PLAYWRIGHT_CHANNEL=msedge on this host, Chromium by default elsewhere.
- Reviewed and fixed wire-only tool starts, late snapshots, FIFO user echoes, correlated ACKs, hydration races/timeouts, duplicate/retired starts and interrupted snapshot preservation.
- Existing settings/model/slider changes remain uncommitted and preserved. No merge, push or reset performed.

- Final whole-feature review approved; provider-error history cancellation was fixed test-first and independently re-reviewed. Draft typing remains allowed during loading; only submission/stop actions are disabled.
