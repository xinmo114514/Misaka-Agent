import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  beginResearchStop,
  clearResearchStop,
  confirmResearchStopped,
  failResearchStop,
  noteResearchStopAck,
  RESEARCH_STOP_CONFIRM_TIMEOUT_MS,
  resetResearchStopTimers,
  unconfirmResearchStop,
} from './researchStop'
import { researchStopEntry, useResearchStopStore } from '../store/useResearchStopStore'

beforeEach(() => {
  vi.useFakeTimers()
  resetResearchStopTimers()
  useResearchStopStore.setState({ byRun: {} })
})
afterEach(() => {
  resetResearchStopTimers()
  vi.useRealTimers()
})

describe('beginResearchStop', () => {
  it('locks the run while a stop is pending and releases it for a deliberate retry', () => {
    const first = beginResearchStop('r1')
    expect(first).toBeTruthy()
    expect(beginResearchStop('r1')).toBeNull()
    failResearchStop('r1', first!, '研究桥接通道尚未就绪')
    const retry = beginResearchStop('r1')
    expect(retry).toBeTruthy()
    expect(retry).not.toBe(first)
  })
})

describe('the confirmation timer', () => {
  it('turns an unheard ACK into 结果待确认 after 30s -- refresh only, never a resend', () => {
    const attempt = beginResearchStop('r_ack')!
    noteResearchStopAck('r_ack', attempt)
    expect(researchStopEntry('r_ack')?.phase).toBe('pending')
    vi.advanceTimersByTime(RESEARCH_STOP_CONFIRM_TIMEOUT_MS)
    expect(researchStopEntry('r_ack')).toMatchObject({ phase: 'unconfirmed' })
    // The unconfirmed wait does not own the lock: the user may retry deliberately.
    expect(beginResearchStop('r_ack')).toBeTruthy()
  })

  it('never resurrects an attempt that a newer one replaced', () => {
    const stale = beginResearchStop('r_fence')!
    failResearchStop('r_fence', stale, 'first failure')
    const fresh = beginResearchStop('r_fence')!
    noteResearchStopAck('r_fence', stale)
    vi.advanceTimersByTime(RESEARCH_STOP_CONFIRM_TIMEOUT_MS)
    expect(researchStopEntry('r_fence')).toMatchObject({ phase: 'pending', attemptId: fresh })
  })
})

describe('confirmResearchStopped', () => {
  it('needs the lease answer with the flag: stopped + no driver is rest', () => {
    beginResearchStop('r_rest')!
    expect(confirmResearchStopped('r_rest', 'stopped', undefined)).toBe(false)
    expect(confirmResearchStopped('r_rest', 'stopped', true)).toBe(false)
    expect(researchStopEntry('r_rest')?.phase).toBe('pending')
    expect(confirmResearchStopped('r_rest', 'stopped', false)).toBe(true)
    expect(researchStopEntry('r_rest')).toBeUndefined()
  })

  it('settles every other terminal with its label, and a late success after a timeout', () => {
    const attempt = beginResearchStop('r_done')!
    noteResearchStopAck('r_done', attempt)
    vi.advanceTimersByTime(RESEARCH_STOP_CONFIRM_TIMEOUT_MS)
    expect(researchStopEntry('r_done')?.phase).toBe('unconfirmed')
    // The request landed after all: the observation is evidence, reflected without a click.
    expect(confirmResearchStopped('r_done', 'failed', false)).toBe(true)
    expect(researchStopEntry('r_done')).toBeUndefined()
    void attempt
  })

  it('a failed command is superseded by authoritative evidence that the run stopped', () => {
    const attempt = beginResearchStop('r_failed')!
    failResearchStop('r_failed', attempt, '研究控制宿主尚未就绪')
    expect(confirmResearchStopped('r_failed', 'stopped', false)).toBe(true)
    expect(researchStopEntry('r_failed')).toBeUndefined()
  })

  it('ignores a terminal read for a run nobody is waiting on', () => {
    expect(confirmResearchStopped('r_none', 'stopped', false)).toBe(false)
  })
})

describe('clearResearchStop', () => {
  it('fences a stale attempt and forgets the run entirely on an explicit resume', () => {
    const attempt = beginResearchStop('r_resume')!
    clearResearchStop('r_resume', 'stop_old')
    expect(researchStopEntry('r_resume')).toMatchObject({ phase: 'pending', attemptId: attempt })
    clearResearchStop('r_resume')
    expect(researchStopEntry('r_resume')).toBeUndefined()
    expect(beginResearchStop('r_resume')).toBeTruthy()
  })
})

it('unconfirm on the dispatch timeout keeps its message and releases the lock', () => {
  const attempt = beginResearchStop('r_timeout')!
  unconfirmResearchStop('r_timeout', attempt, 'stop_research 没有回应')
  expect(researchStopEntry('r_timeout')).toMatchObject({ phase: 'unconfirmed', error: 'stop_research 没有回应' })
  expect(beginResearchStop('r_timeout')).toBeTruthy()
})
