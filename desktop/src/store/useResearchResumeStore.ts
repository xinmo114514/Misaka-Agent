import { create } from 'zustand'

/**
 * The per-run resume state machine.
 *
 * It lives in a shared store, not in a component: the resume entry is rendered by the run header
 * and by the suspension banner, both views mount them, and a layout switch or a session switch
 * unmounts and remounts them. The lock and the reported phase must survive all of that, or a
 * second click would start a second resume.
 */
export type ResearchResumePhase =
  /** Nothing in flight for this run. */
  | 'idle'
  /** 提交中: the control request is in flight. */
  | 'submitting'
  /** 正在确认恢复: the request was acknowledged, real driving is not observed yet. */
  | 'confirming'
  /** 恢复成功: the observation chain reported `driving === true`. */
  | 'confirmed'
  /** 明确失败: the control request was rejected. A manual retry is allowed. */
  | 'failed'
  /** 结果待确认: a timeout. Refresh only — never an automatic resend. */
  | 'unconfirmed'

export interface ResearchResumeEntry {
  runId: string
  phase: ResearchResumePhase
  startedAt: number
  updatedAt: number
  error?: string
}

/** Phases that own the run's resume lock: a second click must not send a second request. */
export const RESEARCH_RESUME_IN_FLIGHT: ReadonlySet<ResearchResumePhase> = new Set<ResearchResumePhase>(['submitting', 'confirming'])

interface State {
  byRun: Record<string, ResearchResumeEntry>
  begin: (runId: string, at?: number) => void
  confirming: (runId: string, at?: number) => void
  confirmed: (runId: string, at?: number) => void
  fail: (runId: string, error: string, at?: number) => void
  unconfirm: (runId: string, error?: string, at?: number) => void
  clear: (runId: string) => void
}

const stamp = (runId: string, phase: ResearchResumePhase, startedAt: number, at: number, error?: string): ResearchResumeEntry => ({
  runId, phase, startedAt, updatedAt: at, ...(error ? { error } : {}),
})

export const useResearchResumeStore = create<State>(set => ({
  byRun: {},
  begin: (runId, at = Date.now()) => set(state => ({
    byRun: { ...state.byRun, [runId]: stamp(runId, 'submitting', at, at) },
  })),
  confirming: (runId, at = Date.now()) => set(state => {
    const existing = state.byRun[runId]
    return { byRun: { ...state.byRun, [runId]: stamp(runId, 'confirming', existing?.startedAt ?? at, at) } }
  }),
  confirmed: (runId, at = Date.now()) => set(state => {
    const existing = state.byRun[runId]
    return { byRun: { ...state.byRun, [runId]: stamp(runId, 'confirmed', existing?.startedAt ?? at, at) } }
  }),
  fail: (runId, error, at = Date.now()) => set(state => {
    const existing = state.byRun[runId]
    return { byRun: { ...state.byRun, [runId]: stamp(runId, 'failed', existing?.startedAt ?? at, at, error) } }
  }),
  unconfirm: (runId, error, at = Date.now()) => set(state => {
    const existing = state.byRun[runId]
    return { byRun: { ...state.byRun, [runId]: stamp(runId, 'unconfirmed', existing?.startedAt ?? at, at, error) } }
  }),
  clear: runId => set(state => {
    if (!(runId in state.byRun)) return state
    const byRun = { ...state.byRun }
    delete byRun[runId]
    return { byRun }
  }),
}))

/** The current entry for a run, or undefined. A selector keeps components from re-rendering on other runs. */
export function researchResumeEntry(runId: string | null | undefined): ResearchResumeEntry | undefined {
  return runId ? useResearchResumeStore.getState().byRun[runId] : undefined
}

/** Whether this run already owns a resume request that has not settled. */
export function researchResumeInFlight(runId: string | null | undefined): boolean {
  const entry = researchResumeEntry(runId)
  return Boolean(entry && RESEARCH_RESUME_IN_FLIGHT.has(entry.phase))
}
