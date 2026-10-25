import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { observeResearchStop } from './researchStopObservation'
import { beginResearchStop, noteResearchStopAck, resetResearchStopTimers } from './researchStop'
import { useResearchStopStore } from '../store/useResearchStopStore'
import { useResearchRunStore } from '../store/useResearchRunStore'
import { useSessionStore } from '../store/useSessionStore'
import type { ResearchRunSummary } from '../types/research'

let release: (() => void) | undefined
const refresh = vi.fn().mockResolvedValue(undefined)
const row = (extra: Partial<ResearchRunSummary> = {}): ResearchRunSummary => ({
  id: 'orphan', question: 'Q', workspace: 'C:/original', status: 'stopping', phase: 'active',
  nodes: 1, tasks: 24, stop_requested: true, ...extra,
})

beforeEach(() => {
  vi.useFakeTimers()
  resetResearchStopTimers()
  refresh.mockReset().mockResolvedValue(undefined)
  useResearchStopStore.setState({ byRun: {} })
  useResearchRunStore.setState({ runs: {} })
  useSessionStore.setState({ researchRuns: [], researchCards: {}, fetchResearchCardDetails: refresh })
})
afterEach(() => { release?.(); release = undefined; resetResearchStopTimers(); vi.useRealTimers() })

it('recovers an inherited stopping run immediately when the board reports no driver', () => {
  useSessionStore.setState({ researchRuns: [row({ driving: false })] })
  release = observeResearchStop()
  expect(useResearchStopStore.getState().byRun.orphan?.phase).toBe('unconfirmed')
})

it.each([undefined, true])('bounds inherited stopping with driving=%s without restarting its deadline', async driving => {
  useSessionStore.setState({ researchRuns: [row({ driving })] })
  release = observeResearchStop()
  expect(useResearchStopStore.getState().byRun.orphan?.phase).toBe('pending')
  if (driving === undefined) expect(refresh).toHaveBeenCalledWith('orphan')
  await vi.advanceTimersByTimeAsync(29_000)
  useSessionStore.setState({ researchRuns: [row({ driving })] })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(useResearchStopStore.getState().byRun.orphan?.phase).toBe('unconfirmed')
})

it('fresh no-driver evidence unlocks an inherited wait before its deadline', () => {
  useSessionStore.setState({ researchRuns: [row({ driving: true })] })
  release = observeResearchStop()
  useSessionStore.setState({ researchRuns: [row({ driving: false })] })
  expect(useResearchStopStore.getState().byRun.orphan?.phase).toBe('unconfirmed')
})

it('a board read with no driver does not unlock a locally dispatched pending stop', () => {
  beginResearchStop('orphan')
  useSessionStore.setState({ researchRuns: [row({ driving: false })] })
  release = observeResearchStop()
  expect(useResearchStopStore.getState().byRun.orphan?.phase).toBe('pending')
})

it('a stale listing does not mask a fresh authoritative stopped summary', () => {
  beginResearchStop('orphan')
  useResearchRunStore.setState({ runs: { orphan: { runId: 'orphan', run: row({ driving: true, updatedAt: 1 }) } as never } })
  release = observeResearchStop()
  useSessionStore.setState({ researchRuns: [row({ status: 'stopped', driving: false, updatedAt: 2 })] })
  expect(useResearchStopStore.getState().byRun.orphan).toBeUndefined()
  useSessionStore.setState({ draft: 'unrelated navigation state' })
  expect(useResearchStopStore.getState().byRun.orphan).toBeUndefined()
})

it('never infers a released lease from a stopped row that omitted driving', async () => {
  const attempt = beginResearchStop('orphan')!
  noteResearchStopAck('orphan', attempt)
  useSessionStore.setState({ researchRuns: [row({ status: 'stopped' })] })
  release = observeResearchStop()
  expect(refresh).toHaveBeenCalledWith('orphan')
  expect(useResearchStopStore.getState().byRun.orphan?.phase).toBe('pending')
  await vi.advanceTimersByTimeAsync(30_000)
  expect(useResearchStopStore.getState().byRun.orphan?.phase).toBe('unconfirmed')
  useSessionStore.setState({ researchRuns: [row({ status: 'stopped', driving: false })] })
  expect(useResearchStopStore.getState().byRun.orphan).toBeUndefined()
})

it('a failing detail read stays bounded and does not become an unhandled rejection', async () => {
  refresh.mockRejectedValueOnce(new Error('offline'))
  useSessionStore.setState({ researchRuns: [row()] })
  release = observeResearchStop()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(useResearchStopStore.getState().byRun.orphan?.phase).toBe('unconfirmed')
})

it('late reads cannot recreate a settled stop until an explicit resume opens a new epoch', () => {
  beginResearchStop('orphan')
  release = observeResearchStop()
  useSessionStore.setState({ researchRuns: [row({ status: 'stopped', driving: false, updatedAt: 2 })] })
  useSessionStore.setState({ researchRuns: [row({ driving: true, updatedAt: 2 })] })
  expect(useResearchStopStore.getState().byRun.orphan).toBeUndefined()
  useSessionStore.setState({ researchCards: { orphan: { runId: 'orphan', question: 'Q', status: 'active', phase: 'active', tasks: [], updatedAt: 3, controlEpoch: 1 } },
    researchRuns: [row({ driving: false, updatedAt: 3 })] })
  expect(useResearchStopStore.getState().byRun.orphan?.phase).toBe('unconfirmed')
})
