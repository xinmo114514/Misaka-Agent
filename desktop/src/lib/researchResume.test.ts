import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => vi.fn())
const research = vi.hoisted(() => vi.fn())
const bridgeRequest = vi.hoisted(() => vi.fn())
const begin = vi.hoisted(() => vi.fn())
const accept = vi.hoisted(() => vi.fn())
vi.mock('./bridge', async importOriginal => ({
  ...await importOriginal<typeof import('./bridge')>(),
  request: bridgeRequest,
}))
vi.mock('./researchBridge', async importOriginal => ({
  ...await importOriginal<typeof import('./researchBridge')>(),
  executeResearchControl: control,
  requestResearch: research,
}))
vi.mock('./researchActivityStore', async importOriginal => ({
  ...await importOriginal<typeof import('./researchActivityStore')>(),
  beginResearchControl: begin,
  acceptResearchResume: accept,
}))

import {
  confirmResearchDriving,
  requestResearchResume,
  researchResumeAvailability,
  resetResearchResumeTimers,
  RESEARCH_RESUME_CONFIRM_TIMEOUT_MS,
} from './researchResume'
import { useResearchResumeStore } from '../store/useResearchResumeStore'
import { ResearchRequestError, ResearchRequestTimeoutError } from './researchBridge'

const detail = (run: Record<string, unknown>) => ({
  run: { id: 'r1', question: 'q', workspace: 'C:/w', status: 'active', phase: 'active', nodes: 1, tasks: 1, ...run },
  graph: {},
})

beforeEach(() => {
  control.mockReset().mockResolvedValue(undefined)
  research.mockReset().mockResolvedValue(undefined)
  bridgeRequest.mockReset().mockResolvedValue(detail({ status: 'stopped', driving: false }))
  begin.mockReset()
  accept.mockReset()
  resetResearchResumeTimers()
  useResearchResumeStore.setState({ byRun: {} })
})
afterEach(() => { resetResearchResumeTimers(); vi.useRealTimers() })

describe('researchResumeAvailability', () => {
  it('hides the entry for a finished run: there is nothing to resume', () => {
    for (const status of ['done', 'completed', 'closed', 'cancelled', 'partial', 'error']) {
      expect(researchResumeAvailability({ status, driving: false })).toEqual({ visible: false, enabled: false })
    }
  })

  it('never takes over a run that still has a valid driver', () => {
    expect(researchResumeAvailability({ status: 'active', driving: true }))
      .toEqual({ visible: true, enabled: false, reason: '研究仍在运行，不会接管正在进行的研究' })
    expect(researchResumeAvailability({ status: 'stopped', driving: true }).enabled).toBe(false)
    expect(researchResumeAvailability({ status: 'failed', driving: true }).enabled).toBe(false)
  })

  it('treats a stopping run as a legitimate wait, not an anomaly', () => {
    expect(researchResumeAvailability({ status: 'stopping', driving: false }).enabled).toBe(false)
    expect(researchResumeAvailability({ status: 'active', driving: false, stopRequested: true }))
      .toEqual({ visible: true, enabled: false, reason: '研究正在停止，等停止完成后再恢复' })
  })

  it('treats a clarification or approval wait as legitimate even without a driver', () => {
    expect(researchResumeAvailability({ status: 'waiting_input', driving: false }))
      .toEqual({ visible: true, enabled: false, reason: '研究正在等待你的澄清或审批，先处理当前问题' })
  })

  it('never resumes a run whose plan waits for approval, even though its driver is free', () => {
    // The plan wait keeps the run `active` and legitimately releases the lease: without this
    // signal it would look exactly like an interruption (2026-10-18 e2e: 恢复研究 on a live run).
    expect(researchResumeAvailability({ status: 'active', driving: false, awaitingApproval: true }))
      .toEqual({ visible: true, enabled: false, reason: '研究正在等待你的澄清或审批，先处理当前问题' })
    // The wait outranks a live lease too, so the reason names the real obstacle.
    expect(researchResumeAvailability({ status: 'active', driving: true, awaitingApproval: true }).reason)
      .toBe('研究正在等待你的澄清或审批，先处理当前问题')
    // An answer clears the wait: the same run becomes resumable again.
    expect(researchResumeAvailability({ status: 'active', driving: false, awaitingApproval: false }))
      .toEqual({ visible: true, enabled: true })
  })

  it('still resumes a stopped run whatever approval material it left behind', () => {
    // A stopped run is over: leftover material (an unapplied reconciliation, say) describes what
    // it was doing, not a wait the user owes it (2026-10-18 e2e: stop → reopen → resume blocked).
    expect(researchResumeAvailability({ status: 'stopped', driving: false, awaitingApproval: true }))
      .toEqual({ visible: true, enabled: true })
    expect(researchResumeAvailability({ status: 'failed', driving: false, awaitingApproval: true }).enabled)
      .toBe(true)
  })

  it('does not read a settled run as still stopping because the flag outlived it', () => {
    // The board only clears stop_requested on resume, so a stopped run still carries it. Treating
    // that as "正在停止" made every stopped run unresumable.
    expect(researchResumeAvailability({ status: 'stopped', driving: false, stopRequested: true }))
      .toEqual({ visible: true, enabled: true })
    expect(researchResumeAvailability({ status: 'failed', driving: false, stopRequested: true }).enabled)
      .toBe(true)
    // A run that really is still stopping keeps the wait.
    expect(researchResumeAvailability({ status: 'stopping', driving: false, stopRequested: true }))
      .toEqual({ visible: true, enabled: false, reason: '研究正在停止，等停止完成后再恢复' })
    expect(researchResumeAvailability({ status: 'active', driving: false, stopRequested: true }).enabled)
      .toBe(false)
  })

  it('keeps an unknown driver state unknown instead of reading it as lost', () => {
    for (const driving of [undefined, null]) {
      const value = researchResumeAvailability({ status: 'active', driving })
      expect(value.visible).toBe(true)
      expect(value.enabled).toBe(false)
      expect(value.reason).toContain('刷新')
    }
  })

  it('enables the two states the user may resume: a lost driver and a stopped or failed run', () => {
    expect(researchResumeAvailability({ status: 'active', driving: false })).toEqual({ visible: true, enabled: true })
    expect(researchResumeAvailability({ status: 'stopped', driving: false })).toEqual({ visible: true, enabled: true })
    expect(researchResumeAvailability({ status: 'failed', driving: false })).toEqual({ visible: true, enabled: true })
    expect(researchResumeAvailability({ status: 'stopped' }))
      .toEqual({ visible: true, enabled: false, reason: '研究运行状态未知，刷新后重试' })
  })

  it('does not enable a state it does not know how to resume', () => {
    expect(researchResumeAvailability({ status: 'queued', driving: false }).enabled).toBe(false)
  })
})

describe('requestResearchResume', () => {
  it('re-reads the authoritative state and refuses to send when a driver appeared meanwhile', async () => {
    bridgeRequest.mockResolvedValue(detail({ status: 'active', driving: true }))
    const entry = await requestResearchResume({ runId: 'r1', workspace: 'C:/w' })
    expect(control).not.toHaveBeenCalled()
    expect(entry.phase).toBe('failed')
    expect(entry.error).toBe('研究仍在运行，不会接管正在进行的研究')
  })

  it('refuses to send when the run started waiting for the user', async () => {
    bridgeRequest.mockResolvedValue(detail({ status: 'waiting_input', driving: false }))
    const entry = await requestResearchResume({ runId: 'r1' })
    expect(control).not.toHaveBeenCalled()
    expect(entry.phase).toBe('failed')
  })

  it('fails visibly when the authoritative read itself fails', async () => {
    bridgeRequest.mockRejectedValue(new Error('看板读取失败'))
    const entry = await requestResearchResume({ runId: 'r1' })
    expect(control).not.toHaveBeenCalled()
    expect(entry).toMatchObject({ phase: 'failed', error: '看板读取失败' })
  })

  it('acknowledges without accepting: ACK is not driving evidence', async () => {
    const entry = await requestResearchResume({ runId: 'r1', workspace: 'C:/w' })
    expect(control).toHaveBeenCalledWith('resume_research', expect.objectContaining({ runId: 'r1' }))
    expect(begin).toHaveBeenCalledWith('r1')
    expect(accept).not.toHaveBeenCalled()
    expect(entry.phase).toBe('confirming')
  })

  it('accepts the resume only when the observation chain reports real driving', async () => {
    await requestResearchResume({ runId: 'r1' })
    expect(confirmResearchDriving('r1')).toBe(true)
    expect(accept).toHaveBeenCalledWith('r1')
    expect(useResearchResumeStore.getState().byRun.r1.phase).toBe('confirmed')
    // A late second observation is harmless.
    expect(confirmResearchDriving('r1')).toBe(false)
    expect(accept).toHaveBeenCalledOnce()
  })

  it('reads 结果待确认 after 30s without driving, and never resends by itself', async () => {
    vi.useFakeTimers()
    const pending = requestResearchResume({ runId: 'r1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(useResearchResumeStore.getState().byRun.r1.phase).toBe('confirming')
    await vi.advanceTimersByTimeAsync(RESEARCH_RESUME_CONFIRM_TIMEOUT_MS)
    expect(useResearchResumeStore.getState().byRun.r1.phase).toBe('unconfirmed')
    expect(control).toHaveBeenCalledOnce()
    await pending
    expect(control).toHaveBeenCalledOnce()
  })

  it('still accepts a late success that arrives after the timeout', async () => {
    vi.useFakeTimers()
    const pending = requestResearchResume({ runId: 'r1' })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(RESEARCH_RESUME_CONFIRM_TIMEOUT_MS)
    expect(useResearchResumeStore.getState().byRun.r1.phase).toBe('unconfirmed')
    expect(confirmResearchDriving('r1')).toBe(true)
    expect(useResearchResumeStore.getState().byRun.r1.phase).toBe('confirmed')
    await pending
  })

  it('reads 结果待确认 when the request itself times out', async () => {
    control.mockRejectedValue(new ResearchRequestTimeoutError('resume_research', 'req-1'))
    const entry = await requestResearchResume({ runId: 'r1' })
    expect(entry.phase).toBe('unconfirmed')
    expect(accept).not.toHaveBeenCalled()
    expect(control).toHaveBeenCalledOnce()
  })

  it('reports an explicit rejection as a failure the user may retry', async () => {
    control.mockRejectedValueOnce(new ResearchRequestError('研究根会话尚未登记，请刷新研究状态。', { requestId: 'req-1' }))
    const first = await requestResearchResume({ runId: 'r1' })
    expect(first.phase).toBe('failed')
    expect(first.error).toContain('尚未登记')
    expect(accept).not.toHaveBeenCalled()

    control.mockResolvedValueOnce(undefined)
    const second = await requestResearchResume({ runId: 'r1' })
    expect(second.phase).toBe('confirming')
    expect(control).toHaveBeenCalledTimes(2)
  })

  it('locks per run: a second click while in flight sends nothing', async () => {
    let release!: () => void
    control.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const first = requestResearchResume({ runId: 'r1' })
    // The authoritative read happens before the control request; wait for the lock to be held.
    await vi.waitFor(() => expect(control).toHaveBeenCalledOnce())
    const second = await requestResearchResume({ runId: 'r1' })
    expect(second.phase).toBe('submitting')
    release()
    await first
    expect(control).toHaveBeenCalledOnce()
  })

  it('keeps separate runs independent', async () => {
    await requestResearchResume({ runId: 'r1' })
    await requestResearchResume({ runId: 'r2' })
    expect(control).toHaveBeenCalledTimes(2)
    expect(useResearchResumeStore.getState().byRun.r1.phase).toBe('confirming')
    expect(useResearchResumeStore.getState().byRun.r2.phase).toBe('confirming')
    confirmResearchDriving('r1')
    expect(useResearchResumeStore.getState().byRun.r1.phase).toBe('confirmed')
    expect(useResearchResumeStore.getState().byRun.r2.phase).toBe('confirming')
  })

  it('keeps the phase across a remount, because it lives in the shared store', async () => {
    await requestResearchResume({ runId: 'r1' })
    // Nothing component-local holds this: a fresh read of the store still reports the wait.
    expect(useResearchResumeStore.getState().byRun.r1).toMatchObject({ runId: 'r1', phase: 'confirming' })
  })

  it('a late response from an older attempt cannot overwrite a newer one', async () => {
    control.mockRejectedValueOnce(new ResearchRequestError('失败', { requestId: 'req-1' }))
    await requestResearchResume({ runId: 'r1' })
    expect(useResearchResumeStore.getState().byRun.r1.phase).toBe('failed')

    control.mockResolvedValueOnce(undefined)
    await requestResearchResume({ runId: 'r1' })
    expect(useResearchResumeStore.getState().byRun.r1.phase).toBe('confirming')
    expect(confirmResearchDriving('r1')).toBe(true)
    expect(useResearchResumeStore.getState().byRun.r1.phase).toBe('confirmed')
  })
})
