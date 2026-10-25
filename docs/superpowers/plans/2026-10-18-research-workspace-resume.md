# 研究工作区升级与一键恢复研究

Branch: `codex/research-tiling-workspace` (dirty, keep every pre-existing change; no staging, no commits).
Scope ruling: implement the spec and run acceptance locally. Never touch the user's real research data
(`PROJECT.md`, the Paris Commune run). All integration checks use isolated profile dirs and the local
fixture model provider.

## Goal

One research workspace that keeps the pink-purple soft theme and covers three jobs:

1. **对话内审批** — plan / reconcile / clarification approvals render as structured cards inside the
   conversation (同意 / 稍后 / 还需修改), with version guards and revision history, instead of a
   detached panel.
2. **专注 / 多窗双视图** — a focus view (智能体团队 list: main controller + sub-agents, status, recent
   activity, history generations) and the existing multi-pane tile view, switchable both ways, sharing
   selection / reading / collapse state, with the user's choice remembered.
3. **手动恢复研究** — one 恢复研究 entry next to 研究图谱, shared by both views, only ever user-triggered,
   never taking over a valid driver, and reporting success only on real driving.

## Non-negotiable interaction rules

- Default view is 专注; the last choice is remembered; switching back to 多窗 is always available.
- Sub-agent sessions are view-only. Supplement/steering requests are addressed to the main controller
  (research dispatcher); the composer labels the recipient.
- 「稍后」 only collapses the approval card into a pending-approval summary; it does not pause any
  already-approved card.
- Resume is manual only. Nothing else (startup, history load, session switch, refresh) may start a
  model turn.
- An ACK is not evidence of driving. Success requires the observation chain to report
  `driving === true` for that Run.
- A timeout is 结果待确认 with a refresh action only — never an automatic resend.
- Unknown or unreadable driver state is *unknown*, never "lost".
- Stopping / waiting for clarification or approval / a valid driver / unknown driver state disable the
  button; `active` with `driving === false`, `stopped`, `failed` with no valid driver enable it.

## Shared interfaces (agreed before parallel work)

### Backend

`misaka/core/research/desktop_view.py`

- `sessions_payload(con, run_id)["run"]` gains `driving: bool` taken straight from
  `runs.driver_is_live(row)` — the same value `_serialize_research_run` already publishes, so the list
  query and the run detail agree. No new endpoint, no new polling.
- The value must also survive the observer path: `ResearchSessionObserver` reuses
  `sessions_payload`, so a driver change reaches `research_sessions_changed` even when the task counts
  did not move.
- Old protocol / unreadable board: field absent → the frontend queries `get_research_details`; still
  absent or the read fails → `driving` stays `undefined` (unknown), which disables resume.

### Frontend types

`desktop/src/types/research.ts`

```ts
export interface ResearchRunSummary {
  /* …existing… */
  /** Driver lease liveness straight from the board (`runs.driver_is_live`). */
  driving?: boolean
}
```

`ResearchRunDetail.run` keeps its existing optional `driving`.

### Resume module — `desktop/src/lib/researchResume.ts` (new)

```ts
export type ResearchResumePhase =
  | 'idle'        // nothing in flight for this run
  | 'submitting'  // 提交中: control request in flight
  | 'confirming'  // 正在确认恢复: ACK received, waiting for real driving
  | 'confirmed'   // 恢复成功: observation chain reported driving === true
  | 'failed'      // 明确失败: control rejected or driving never arrived before an explicit failure
  | 'unconfirmed' // 结果待确认: 30s / request timeout, refresh only, no auto resend

export interface ResearchResumeEntry {
  runId: string
  phase: ResearchResumePhase
  startedAt: number
  updatedAt: number
  error?: string
}

/** PURE decision: whether the 恢复研究 entry shows and whether it is enabled. */
export function researchResumeAvailability(input: {
  status?: string | null
  driving?: boolean | null   // undefined = unknown / unreadable
  stopRequested?: boolean
}): { visible: boolean; enabled: boolean; reason?: string }
```

Rules encoded in `researchResumeAvailability`:

| state | visible | enabled |
|---|---|---|
| `done` / `completed` / `closed` / `cancelled` / `partial` / `error`? | no | — |
| `stopping` / `stopRequested` | yes | no |
| `waiting_input` (clarification or approval) | yes | no |
| `driving === true` | yes | no (never take over) |
| `driving === undefined` | yes | no (unknown; offer refresh) |
| `active` + `driving === false` | yes | **yes** |
| `stopped` / `failed` + `driving !== true` | yes | **yes** |
| anything else | yes | no |

```ts
/** The single resume entry. Locks per Run immediately, re-reads authoritative state,
 *  reuses executeResearchControl('resume_research'), confirms driving, never resends. */
export async function requestResearchResume(input: {
  runId: string
  workspace?: string
  onBound?: (snapshot: ResearchHostSnapshot) => void
}): Promise<ResearchResumeEntry>
```

`requestResearchResume` behaviour:

1. If the store already has an in-flight phase for this Run, return it (single click = single request).
2. `begin(runId)` → phase `submitting` (persisted in the shared store, survives layout/session switch).
3. Re-read authoritative state (`get_research_details`) and re-run `researchResumeAvailability`; a run
   that now has a valid driver or is waiting for approval ends in `failed` with a reason, without
   sending anything.
4. `executeResearchControl('resume_research', { runId, workspace, onBound })` — unchanged native path
   (`/research resume <runId>`, original root session, returned host bound).
5. On ACK → `confirming` (「正在确认恢复」). **Do not** call `acceptResearchResume` yet.
6. Watch the existing observation chain (run store / activity store / sessions bridge snapshots) for
   `driving === true` → `acceptResearchResume(runId)` + phase `confirmed`.
7. 30 s without driving, or `ResearchRequestTimeoutError` → `unconfirmed` (结果待确认, refresh only).
8. Explicit rejection/`ResearchRequestError` → `failed` with the message; the button becomes usable
   again for a manual retry.

The per-Run lock lives in the shared store so two windows / two views cannot resume twice.

### Shared store — `desktop/src/store/useResearchResumeStore.ts` (new)

```ts
interface ResearchResumeStore {
  byRun: Record<string, ResearchResumeEntry>
  begin(runId: string): void
  confirming(runId: string): void
  confirmed(runId: string): void
  fail(runId: string, error: string): void
  unconfirm(runId: string): void
  clear(runId: string): void
}
```

Selection/reading/collapse state stays in `useResearchWorkspaceStore`; the view-mode preference is a
plain `localStorage` key (`misaka_research_view_mode`, `'focus' | 'multi'`, default `'focus'`),
following `sidebarPreference.ts`.

## Task breakdown and write scopes

| Task | Owner | Write scope |
|---|---|---|
| 1. Backend `driving` in `sessions_payload` + observer parity + pytest | backend | `misaka/core/research/desktop_view.py`, `misaka/desktop_research/session_observer.py`, `tests/test_research_desktop_view.py`, `tests/test_desktop_research_session_observer*.py` |
| 2. Types + `researchResume.ts` + resume store + gating `acceptResearchResume` + Vitest | resume-core | `desktop/src/lib/researchResume.ts`, `desktop/src/lib/researchBridge.ts`, `desktop/src/lib/researchActivityStore.ts`, `desktop/src/store/useResearchResumeStore.ts`, `desktop/src/types/research.ts`, their `*.test.ts` |
| 3. 恢复研究 button in the header (both views) + banner rework + interruption banner | views-ui | `desktop/src/components/ResearchWorkspace/ResearchRunHeader.tsx`, `ResearchResumeButton.tsx`, `ResearchStoppedBanner.tsx`, `ResearchInterruptedBanner.tsx` + tests |
| 4. 专注/多窗 views, 智能体团队 list, shared state, view switch, sidebar activity entry | views-ui | `desktop/src/components/ResearchWorkspace/ResearchFocusView.tsx`, `ResearchTeamList.tsx`, `ResearchViewSwitch.tsx`, `ResearchTilingWorkspace.tsx`, `desktop/src/components/Sidebar/*`, `desktop/src/styles/research-workspace.css` + tests |
| 5. In-conversation approval cards (同意/稍后/还需修改, version guard, history) | approval-ui | `desktop/src/components/ResearchWorkspace/ResearchApprovalCard.tsx`, `ResearchApprovalPanel.tsx`, `desktop/src/components/Timeline/*`, `desktop/src/lib/researchCards.ts`, `desktop/src/lib/researchConversation.ts` + tests |
| 6. Store plumbing + mounting + integration | lead | `desktop/src/store/useSessionStore.ts`, `desktop/src/store/useResearchWorkspaceStore.ts`, `desktop/src/App.tsx`, `desktop/src/components/ResearchWorkspace/ResearchTilingWorkspace.tsx` (integration only) |
| 7. Acceptance: Vitest / Pytest / typecheck / build / Electron | lead | evidence under `.superpowers/sdd/research-workspace-resume/` |

Overlapping files are owned by exactly one task; the lead performs the final integration edit and
review. No task may reset, revert, or reformat files outside its scope.

## Acceptance

- `desktop`: `pnpm exec vitest run --config vitest.config.mts` — all green (baseline 99 files / 819 tests).
- `desktop`: `pnpm run typecheck` and `pnpm run build` clean.
- root: `pytest tests/test_research_desktop_view.py tests/test_desktop_research_session_observer*.py`
  plus the research suite touched by the backend change.
- New tests cover every row of the Section V matrix: approval (同意/稍后/修改/新版本/过期版本/重复操作/
  失败重试), views (成员切换/布局切换/历史加载/流式输出/阅读状态保存/消息路由), resume (运行中/
  驱动丢失/已停止/失败/停止中/已完成/等待审批或澄清/未知/读取失败), protocol (缺少 driving、迟到旧响应、
  重复点击、布局切换、两个窗口同时恢复、另一窗口持有有效驱动), confirmation (ACK 不接管、真实接管、
  超时后迟到成功、明确失败、不自动重发), passive behaviour.
- Visual/regression: 1920×1080, 1366×768, narrow window, 125% / 150% zoom, dark theme.
- Isolated Electron integration test: interrupt the main controller, reopen the app, resume the same Run.

## Rulings recorded

- Reuse the existing dirty checkout; no worktree, no commit.
- Reuse `executeResearchControl('resume_research')`; do not add a second resume transport.
- Reuse the existing list polling and session observer for confirmation; no new scheduler and no resume
  polling loop.
- `driving` is sourced only from `runs.driver_is_live`; the frontend never derives it.
