# 多窗输入框精修：轻量双层，居中限宽

Approved spec: the user's 2026-10-23 implementation request in this conversation.

## Global Constraints
- Only multi-window Composer presentation changes. Ordinary chat, focus and welcome retain their appearance and behavior.
- Keep existing working-tree changes, same Composer/textarea nodes, root coordinator write routing, attachments, controlled drafts, queues, stop and menu focus/Escape behavior.
- No backend/IPC/protocol/dependencies/settings/global material changes. Do not commit, stage, stash or discard anything.
- Work in the existing feature checkout: its uncommitted earlier approved UI is the baseline. Snapshot source before edits and review task deltas against that snapshot rather than HEAD.
- Preserve evidence and before/after screenshots for delivery; no scratch cleanup that removes the only record of uncommitted implementation.

## Task 1: Fresh baseline and browser RED (controller)
- Capture status, HEAD and hashes/copies of desktop source, tests and configs in this plan's evidence workspace.
- Run fresh targeted Composer/workspace tests and typecheck, record their outputs.
- Capture same-size dark/light multi screenshots at 1440/1280/960/900, sidebar open/closed, and ordinary/focus/welcome boundaries.
- Add and observe failing browser assertions for centered 1120px limit, transparent in-flow dock/no top rule, lightweight double-layer, card-width breakpoints and content-height recomputation.
- Do not allow production implementation until baseline captures and expected browser RED are recorded.

## Task 2: Scoped Composer implementation and unit RED/GREEN (implementer)
Read this task first: it is your requirements and exact values.

Scope: desktop/src/components/Composer/Composer.tsx; desktop/src/App.tsx; desktop/src/index.css; a new scoped desktop/src/styles/research-composer.css; directly related Composer tests/sizing helper if useful. Controller owns browser fixtures/specs/evidence. Do not edit their files. Do not spawn helpers. No commits/staging/cleanup. Preserve all earlier local changes.

- Add optional internal `presentation?: 'default' | 'multi'` prop, default unchanged. App enables it only for the existing research multi scene, never a new/keyed Composer or textarea.
- Multi dock remains in flow, reserving real space. Remove multi dock's solid background and top border; retain neutral page/viewport light and existing material fallback.
- Card max-width 1120px, centered, minimum 12px outer gutters, radius 16px, about 8px 12px padding.
- Textarea upper layer, quiet lower toolbar; no divider, approximately 6px gap. Empty card about 84–88px, not fixed total height. Attachments/inline feedback may grow it.
- Left group is attachments, mode, new research; right group model, send options, send, independent stop. Preserve DOM/focus order where practical.
- Mode/model/new-research ghost controls: no permanent border or fill, feedback on hover/focus/open. Controls about 32px high and text 12px, existing Lucide. Pending stop can grow to retain feedback text.
- Idle actionable send uses accent; stop is always independent, danger and existing pending/stop text. Do not merge/send-disable stop with empty text.
- Existing glass/semantic colors/fallback, only light card shadow and clear focus outline. No extra accent glow or global material token changes.
- Actual card width <600px: model name max100px; <420px: icon model entry with full accessible description and tooltip, keep existing exact accessible button name `模型与思考深度`; <360px: explicit ordered two toolbar rows (context controls then send operations), all functions retained.
- Keep controlled textarea, existing multi 88px cap. Recompute current text height when card width or presentation changes, including restored drafts, without DOM replacement or cursor/selection changes. Outside multi's initial appearance remains unchanged; leaving multi must remove stale 88px inline geometry. Avoid ResizeObserver feedback loops.
- Preserve existing form-height measurement used by viewport; status/attachments/errors remain inline. No business/routing/queue/model changes.
- First write and observe failing unit tests for optional presentation and resizing behavior, then minimal implementation. Wait for controller's baseline/RED release before any production edit. Report exact commands/results, changed files and concerns to task-2-report.md in this plan's SDD workspace.

## Task 3: Browser, state and native acceptance (controller)
- GREEN browser geometry/card-width tests, screenshot matrix and compare ordinary/focus/welcome before/after.
- Cover empty/multiline/restored drafts/long model, attachments/failure retry/submitting/running/stopping, Enter/Shift+Enter/IME, send options/independent stop, Escape/focus and mode-return node/draft/attachment preservation.
- Inspect all eight semantic themes normal/hover/focus/disabled; actual-content contrast target >=4.5. Cover opaque fallback and reduced motion.
- Extend isolated Electron renderer acceptance for centered multi card, editor width changes/node preservation and control behavior.
- Independent task review (spec and quality) with snapshot delta; fix/re-review loop if needed.

## Task 4: Frozen release gates and final review (controller)
- Freeze source; serially run complete frontend tests, browser suite (isolated/no real-model credentials), isolated Electron focus+multi fixtures, typecheck, lint and build.
- Record fresh counts/exit codes and distinguish existing warnings.
- Snapshot scope audit proves no unrelated files changed. Independent final integrated review with source/test/evidence delta.
- Deliver concise Chinese result with absolute dark/light before-after screenshot links, any remaining limitations and confirmation no auto-commit.
