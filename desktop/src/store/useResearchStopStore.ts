import { create } from 'zustand'

/**
 * The per-run stop state machine, beside the resume one.
 *
 * A stop is only finished when the observation chain reports the run at rest: an ACK merely
 * means the command landed, and an unmounted button must not forget an in-flight stop.
 * The entry lives in a shared store so the focus bar, the run header, the timeline pill and
 * a layout switch all read the same answer, and a second click cannot send a second request.
 */
export type ResearchStopPhase =
  /** 正在停止: the request is in flight or the engine has not reported rest yet. */
  | 'pending'
  /** 结果待确认: a timeout, or an ACK that never showed up as a stopped run. Refresh only. */
  | 'unconfirmed'
  /** 明确失败: the request was rejected; the entry becomes clickable again for a manual retry. */
  | 'failed'

export interface ResearchStopEntry {
  runId: string
  attemptId: string
  phase: ResearchStopPhase
  /** An inherited board stop has no local command whose completion we are awaiting. */
  source?: 'request' | 'observation'
  startedAt: number
  updatedAt: number
  error?: string
}

interface State {
  byRun: Record<string, ResearchStopEntry>
  begin: (runId: string, attemptId: string, at?: number, source?: ResearchStopEntry['source']) => void
  fail: (runId: string, attemptId: string, error: string, at?: number) => void
  unconfirm: (runId: string, attemptId: string, error: string, at?: number) => void
  /** Drop the entry: the run settled (or a resume took it over). With attemptId, only that one. */
  clear: (runId: string, attemptId?: string) => void
}

export const useResearchStopStore = create<State>(set => ({
  byRun: {},
  begin: (runId, attemptId, at = Date.now(), source = 'request') => set(state => ({
    byRun: { ...state.byRun, [runId]: { runId, attemptId, phase: 'pending', source, startedAt: at, updatedAt: at } },
  })),
  fail: (runId, attemptId, error, at = Date.now()) => set(state => {
    const existing = state.byRun[runId]
    if (!existing || existing.attemptId !== attemptId || existing.phase !== 'pending') return state
    return { byRun: { ...state.byRun, [runId]: { ...existing, phase: 'failed', updatedAt: at, error } } }
  }),
  unconfirm: (runId, attemptId, error, at = Date.now()) => set(state => {
    const existing = state.byRun[runId]
    if (!existing || existing.attemptId !== attemptId || existing.phase !== 'pending') return state
    return { byRun: { ...state.byRun, [runId]: { ...existing, phase: 'unconfirmed', updatedAt: at, error } } }
  }),
  clear: (runId, attemptId) => set(state => {
    const existing = state.byRun[runId]
    if (!existing || (attemptId !== undefined && existing.attemptId !== attemptId)) return state
    const byRun = { ...state.byRun }
    delete byRun[runId]
    return { byRun }
  }),
}))

export function researchStopEntry(runId: string | null | undefined): ResearchStopEntry | undefined {
  return runId ? useResearchStopStore.getState().byRun[runId] : undefined
}

/** A pending attempt owns the run's stop lock: a second click must not send a second request. */
export function researchStopInFlight(runId: string | null | undefined): boolean {
  return researchStopEntry(runId)?.phase === 'pending'
}
