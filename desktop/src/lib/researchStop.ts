import {
  researchStopEntry,
  researchStopInFlight,
  useResearchStopStore,
} from '../store/useResearchStopStore'

/**
 * The stop attempt's machinery: one lock per run, one timer per attempt, and the single rule
 * for when a stop counts as finished. An ACK is not evidence of stopping -- only the board's
 * own status is -- so the confirmation reuses the observation chain that resume already trusts.
 */
export const RESEARCH_STOP_CONFIRM_TIMEOUT_MS = 30_000

/** Where a run is over: a stop that lands on one of these is done, whatever it says otherwise. */
const STOPPED = new Set(['stopped'])
const TERMINAL = new Set(['done', 'completed', 'closed', 'failed', 'error', 'cancelled', 'canceled', 'partial'])

let sequence = 0
/** Which attempt each run currently owns, so a late ACK/error/timer cannot resurrect an old one. */
const attempts = new Map<string, string>()
const confirmTimers = new Map<string, number>()

function clearConfirmTimer(runId: string): void {
  const timer = confirmTimers.get(runId)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    confirmTimers.delete(runId)
  }
}

function ownsAttempt(runId: string, attemptId: string): boolean {
  return attempts.get(runId) === attemptId
}

/**
 * Take the run's stop lock, or return null when a stop is already pending.
 * A failed or unconfirmed attempt may be retried: the new begin fences off the old one.
 */
export function beginResearchStop(runId: string, source: 'request' | 'observation' = 'request'): string | null {
  if (researchStopInFlight(runId)) return null
  clearConfirmTimer(runId)
  const attemptId = `stop_${Date.now().toString(36)}_${(++sequence).toString(36)}`
  attempts.set(runId, attemptId)
  useResearchStopStore.getState().begin(runId, attemptId, undefined, source)
  return attemptId
}

/** The request was acknowledged: it landed, but the run is not stopped until the board says so. */
export function noteResearchStopAck(runId: string, attemptId: string): void {
  if (!ownsAttempt(runId, attemptId) || researchStopEntry(runId)?.phase !== 'pending' || confirmTimers.has(runId)) return
  const timer = window.setTimeout(() => {
    unconfirmResearchStop(runId, attemptId, '未在 30 秒内确认研究已停止，请刷新查看结果')
  }, RESEARCH_STOP_CONFIRM_TIMEOUT_MS)
  confirmTimers.set(runId, timer)
}

/** Adopt a persisted stop after reconnect, without ever sending a control command. */
export function observeResearchStopping(runId: string, status: string, driving?: boolean, stopRequested?: boolean): void {
  const value = status.toLowerCase()
  const stopping = value === 'stopping' || (stopRequested && ['active', 'waiting_input'].includes(value))
    || (value === 'stopped' && driving !== false)
  if (!stopping) return
  let entry = researchStopEntry(runId)
  if (!entry) {
    const attemptId = beginResearchStop(runId, 'observation')
    if (!attemptId) return
    noteResearchStopAck(runId, attemptId)
    entry = researchStopEntry(runId)
  }
  // A fresh local command may be starting its settlement driver; only inherited waits can
  // conclude immediately that nobody remains to observe the old stop request.
  if (entry?.source === 'observation' && entry.phase === 'pending' && driving === false && value !== 'stopped') {
    unconfirmResearchStop(runId, entry.attemptId, '停止结果待确认：后台驱动已结束，请刷新或重试停止以完成收尾。')
  }
}

export function researchRunAtRest(status?: string | null, driving?: boolean): boolean {
  const value = (status || '').toLowerCase()
  return (STOPPED.has(value) && driving === false) || TERMINAL.has(value)
}

export function failResearchStop(runId: string, attemptId: string, error: string): void {
  if (!ownsAttempt(runId, attemptId)) return
  clearConfirmTimer(runId)
  useResearchStopStore.getState().fail(runId, attemptId, error)
}

/** 结果待确认: silence is not failure -- the request may still land, so no automatic resend. */
export function unconfirmResearchStop(runId: string, attemptId: string, error: string): void {
  if (!ownsAttempt(runId, attemptId)) return
  clearConfirmTimer(runId)
  useResearchStopStore.getState().unconfirm(runId, attemptId, error)
}

export function clearResearchStop(runId: string, attemptId?: string): void {
  if (attemptId === undefined || attempts.get(runId) === attemptId) {
    attempts.delete(runId)
    clearConfirmTimer(runId)
  }
  useResearchStopStore.getState().clear(runId, attemptId)
}

/**
 * The one settling rule, fed by the existing observation chain.
 *
 * `stopped` needs the board's own lease answer (driving === false): 停止 means the run ended,
 * not merely that a flag was raised. Every other terminal status ends the wait with its label.
 * A `stopped` row whose lease still reads live (or unknown) keeps the user waiting honestly.
 */
export function confirmResearchStopped(runId: string | null | undefined, status?: string | null,
  driving?: boolean): boolean {
  if (!runId) return false
  const entry = researchStopEntry(runId)
  if (!entry) return false
  if (researchRunAtRest(status, driving)) {
    clearResearchStop(runId, entry.attemptId)
    return true
  }
  return false
}

/** Test and session-reset helper: drop timers without touching what the user sees. */
export function resetResearchStopTimers(): void {
  for (const timer of confirmTimers.values()) window.clearTimeout(timer)
  confirmTimers.clear()
  attempts.clear()
}
