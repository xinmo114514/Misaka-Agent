import { request } from './bridge'
import {
  beginResearchControl,
  acceptResearchResume,
} from './researchActivityStore'
import {
  executeResearchControl,
  isResearchRequestTimeout,
} from './researchBridge'
import {
  useResearchResumeStore,
  researchResumeEntry,
  researchResumeInFlight,
  type ResearchResumeEntry,
  type ResearchResumePhase,
} from '../store/useResearchResumeStore'
import type { ResearchHostSnapshot, ResearchRunDetail } from '../types/research'

export type { ResearchResumeEntry, ResearchResumePhase }
export { researchResumeEntry, researchResumeInFlight }

/** How long an acknowledged resume may take to show real driving before it reads 结果待确认. */
export const RESEARCH_RESUME_CONFIRM_TIMEOUT_MS = 30_000

/** Run states where the research is over: there is nothing left to resume. */
const RESUMED_TERMINAL = new Set(['done', 'completed', 'closed', 'cancelled', 'canceled', 'partial', 'error'])

export interface ResearchResumeAvailability {
  /** Whether the entry belongs on screen at all. */
  visible: boolean
  /** Whether clicking it may start a resume. */
  enabled: boolean
  /** A short Chinese explanation for the disabled state (title / aria-description). */
  reason?: string
}

const hidden = (): ResearchResumeAvailability => ({ visible: false, enabled: false })

/**
 * The one resume decision. Every entry point renders from this, so the header button and the
 * suspension banner cannot disagree.
 *
 * The rules are the specification's, in this order:
 * a finished run has nothing to resume; a stopping run and a run waiting for the user (a
 * clarification or an approval) are legitimate waits, not anomalies; a valid driver is never
 * taken over; an unknown driver state is unknown — never "lost" — so it stays disabled with a
 * refresh; a lost driver on an active run and a stopped/failed run without a driver are the two
 * states the user may resume.
 */
export function researchResumeAvailability(input: {
  status?: string | null
  driving?: boolean | null
  stopRequested?: boolean
  awaitingApproval?: boolean
}): ResearchResumeAvailability {
  const status = (input.status || '').toLowerCase()
  if (RESUMED_TERMINAL.has(status)) return hidden()
  // `stop_requested` stays set after the run settles: the board only clears it on resume. So a
  // settled run is not still stopping, whatever the flag says (2026-10-18 e2e: a stopped run
  // could never be resumed because the flag read as "正在停止").
  const settled = status === 'stopped' || status === 'failed'
  if (!settled && (input.stopRequested || status === 'stopping')) {
    return { visible: true, enabled: false, reason: '研究正在停止，等停止完成后再恢复' }
  }
  if (status === 'waiting_input') {
    return { visible: true, enabled: false, reason: '研究正在等待你的澄清或审批，先处理当前问题' }
  }
  if (status === 'active' && input.awaitingApproval === true) {
    // A plan approval keeps the run `active` while its driver has legitimately finished its turn,
    // so a free lease means "waiting for the user" here, not "interrupted". The wait is the
    // actionable fact, so it is named ahead of a live lease.
    return { visible: true, enabled: false, reason: '研究正在等待你的澄清或审批，先处理当前问题' }
  }
  if (input.driving === true) {
    return { visible: true, enabled: false, reason: '研究仍在运行，不会接管正在进行的研究' }
  }
  if (input.driving === undefined || input.driving === null) {
    return { visible: true, enabled: false, reason: '研究运行状态未知，刷新后重试' }
  }
  if (status === 'active') {
    // active with no live driver: the run's execution was interrupted and can be resumed.
    return { visible: true, enabled: true }
  }
  // A stopped or failed run is already over: leftover approval material (an unapplied
  // reconciliation, say) describes what it was doing, not a wait the user still owes it.
  if (status === 'stopped' || status === 'failed') return { visible: true, enabled: true }
  return { visible: true, enabled: false, reason: '当前状态无法恢复' }
}

/** Read the authoritative run state before sending anything: the list may be a stale snapshot. */
async function readAuthoritativeRun(runId: string, workspace?: string): Promise<{
  status?: string | null
  driving?: boolean
  stopRequested?: boolean
  awaitingApproval?: boolean
}> {
  const detail = await request<ResearchRunDetail>('get_research_details', { runId, workspace })
  const run = detail?.run
  if (!run) throw new Error('研究记录已不存在，无法恢复')
  // The detail read may predate the field (old protocol): the graph still answers the question.
  const graph = detail.graph ?? {}
  const awaiting = typeof run.awaitingApproval === 'boolean' ? run.awaitingApproval
    : (graph.nodes ?? []).some(node => node.status === 'awaiting_approval')
      || ((graph.reconciles ?? []) as Array<{ applied?: boolean }>).some(item => !item.applied)
  return { status: run.status, driving: run.driving, stopRequested: Boolean(run.stop_requested),
    awaitingApproval: awaiting }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const confirmTimers = new Map<string, number>()
/** Which confirmation each run is waiting on, so a late timer cannot settle a newer attempt. */
const attempts = new Map<string, number>()

function clearConfirmTimer(runId: string): void {
  const timer = confirmTimers.get(runId)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    confirmTimers.delete(runId)
  }
}

function settleUnconfirmed(runId: string, attempt: number): void {
  if (attempts.get(runId) !== attempt) return
  const entry = researchResumeEntry(runId)
  if (entry?.phase !== 'confirming') return
  confirmTimers.delete(runId)
  useResearchResumeStore.getState().unconfirm(runId, '未在 30 秒内确认研究已开始运行，请刷新查看结果')
}

/**
 * The observation chain reports that this run is really being driven.
 *
 * This is the only path that accepts a resume: an acknowledgement means the command was
 * received, not that a driver took the run. Late or repeated observations are harmless — the
 * call only settles a run that is still waiting for confirmation.
 */
export function confirmResearchDriving(runId: string | null | undefined): boolean {
  if (!runId) return false
  const entry = researchResumeEntry(runId)
  // A timeout only stops the UI from waiting: the request may still land, so a late success is
  // real evidence and must be reflected. Any other phase is settled and must not be reopened.
  if (entry?.phase !== 'confirming' && entry?.phase !== 'unconfirmed') return false
  clearConfirmTimer(runId)
  attempts.delete(runId)
  acceptResearchResume(runId)
  useResearchResumeStore.getState().confirmed(runId)
  return true
}

/**
 * The single resume entry: user-triggered, locked per run, confirmed by real driving.
 *
 * Returns the run's entry after the attempt settles (or immediately when the run already has a
 * request in flight). It never resends after a timeout: 结果待确认 leaves the decision to the
 * user, who can refresh or click again deliberately.
 */
export async function requestResearchResume(input: {
  runId: string
  workspace?: string
  onBound?: (snapshot: ResearchHostSnapshot) => void
}): Promise<ResearchResumeEntry> {
  const { runId, workspace } = input
  const existing = researchResumeEntry(runId)
  if (existing && researchResumeInFlight(runId)) return existing

  const store = useResearchResumeStore.getState()
  const attempt = (attempts.get(runId) ?? 0) + 1
  attempts.set(runId, attempt)
  clearConfirmTimer(runId)
  store.begin(runId)

  const fail = (error: string) => {
    if (attempts.get(runId) === attempt) attempts.delete(runId)
    useResearchResumeStore.getState().fail(runId, error)
    return useResearchResumeStore.getState().byRun[runId]
  }

  // Re-read before sending: the list that rendered the button may be a poll behind, and a run
  // that is already driven (or waiting for the user) must not be touched.
  try {
    const authoritative = await readAuthoritativeRun(runId, workspace)
    const availability = researchResumeAvailability(authoritative)
    if (!availability.enabled) {
      return fail(availability.reason || '当前状态无法恢复')
    }
  } catch (error) {
    return fail(messageOf(error))
  }

  beginResearchControl(runId)
  try {
    await executeResearchControl('resume_research', {
      runId, workspace, onBound: input.onBound,
    })
  } catch (error) {
    // A timeout is not a failure: the request may still land. Show 结果待确认 and let the user
    // refresh; never resend on their behalf.
    if (isResearchRequestTimeout(error)) {
      useResearchResumeStore.getState().unconfirm(runId, '恢复请求没有回应，结果待确认，请刷新查看')
      return useResearchResumeStore.getState().byRun[runId]
    }
    // A refusal is a refusal: the message is the server's own, and the user retries deliberately.
    return fail(messageOf(error))
  }

  // Acknowledged, not yet driven: wait for the observation chain to prove it.
  useResearchResumeStore.getState().confirming(runId)
  const timer = window.setTimeout(() => settleUnconfirmed(runId, attempt), RESEARCH_RESUME_CONFIRM_TIMEOUT_MS)
  confirmTimers.set(runId, timer)
  return useResearchResumeStore.getState().byRun[runId]
}

/** Test and session-reset helper: drop timers without changing what the user sees. */
export function resetResearchResumeTimers(): void {
  for (const timer of confirmTimers.values()) window.clearTimeout(timer)
  confirmTimers.clear()
  attempts.clear()
}
