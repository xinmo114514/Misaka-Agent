import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('./bridge', async original => ({ ...await original<typeof import('./bridge')>(), request: io.request }))
import { retainResearchActivity, useResearchActivityStore } from './researchActivityStore'
import { beginResearchStop, resetResearchStopTimers } from './researchStop'
import { useResearchStopStore } from '../store/useResearchStopStore'
import { useResearchRunStore } from '../store/useResearchRunStore'
import { useSessionStore } from '../store/useSessionStore'
import { observeResearchStop } from './researchStopObservation'

let release: (() => void) | undefined
let unobserve: (() => void) | undefined
beforeEach(() => {
  vi.useFakeTimers()
  resetResearchStopTimers()
  window.app = { ...window.app, setResearchActive: vi.fn() }
  useResearchStopStore.setState({ byRun: {} })
  useResearchRunStore.setState({ runs: {} })
  useResearchActivityStore.setState({ errors: {}, details: {}, activeIds: [] })
  useSessionStore.setState({ researchCards: { r1: { runId: 'r1', question: 'Q', workspace: 'C:/original', status: 'stopped', phase: 'active', tasks: [], updatedAt: 1 } },
    researchRuns: [{ id: 'r1', question: 'Q', workspace: 'C:/original', status: 'stopped', phase: 'active', nodes: 1, tasks: 0, driving: true }] })
  io.request.mockReset().mockImplementation(async type => type === 'get_research_details'
    ? { run: { id: 'r1', question: 'Q', workspace: 'C:/original', status: 'stopped', phase: 'active', nodes: 1, tasks: 0, driving: false },
      graph: { run: 'r1', question: 'Q', status: 'stopped', phase: 'active', nodes: [] } }
    : { runs: [] })
})
afterEach(() => { unobserve?.(); release?.(); unobserve = release = undefined; resetResearchStopTimers(); vi.clearAllTimers(); vi.useRealTimers() })

it('a pending stop retains its exact workspace detail watch after the card first says stopped', async () => {
  beginResearchStop('r1')
  unobserve = observeResearchStop()
  release = retainResearchActivity()
  await vi.advanceTimersByTimeAsync(4000)
  expect(io.request).toHaveBeenCalledWith('get_research_details', { runId: 'r1', workspace: 'C:/original' })
  expect(useResearchStopStore.getState().byRun.r1).toBeUndefined()
})

it('repairs an early unknown-workspace watch when the original run metadata arrives', async () => {
  useSessionStore.setState({ researchCards: {}, researchRuns: [], researchBinding: null, researchBindings: {}, currentWorkspace: 'C:/different' })
  const read = io.request.getMockImplementation()!
  io.request.mockImplementation(async (type, payload) => type === 'get_research_details' && !payload?.workspace
    ? { run: null, graph: null } : read(type, payload))
  beginResearchStop('r1')
  unobserve = observeResearchStop()
  release = retainResearchActivity()
  await vi.advanceTimersByTimeAsync(0)
  useSessionStore.setState({ researchCards: { r1: { runId: 'r1', question: 'Q', workspace: 'C:/original', status: 'stopped', phase: 'active', tasks: [], updatedAt: 1 } } })
  await vi.advanceTimersByTimeAsync(4000)
  expect(io.request).toHaveBeenCalledWith('get_research_details', { runId: 'r1', workspace: 'C:/original' })
  expect(useResearchStopStore.getState().byRun.r1).toBeUndefined()
})

it('reports an in-flight stop to the native close flow even before its card is discovered', async () => {
  useSessionStore.setState({ researchCards: {}, researchRuns: [], researchBinding: null, researchBindings: {} })
  io.request.mockImplementation(async type => type === 'get_research_details' ? new Promise(() => {}) : { runs: [] })
  beginResearchStop('r1')
  release = retainResearchActivity()
  await vi.advanceTimersByTimeAsync(0)
  expect(window.app.setResearchActive).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }))
})
