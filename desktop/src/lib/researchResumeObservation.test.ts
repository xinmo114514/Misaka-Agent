import { beforeEach, expect, it, vi } from 'vitest'

const confirm = vi.hoisted(() => vi.fn())
vi.mock('./researchResume', async importOriginal => ({
  ...await importOriginal<typeof import('./researchResume')>(),
  confirmResearchDriving: confirm,
}))

import { observeResearchDriving } from './researchResumeObservation'
import { useResearchRunStore } from '../store/useResearchRunStore'
import { useSessionStore } from '../store/useSessionStore'
import type { ResearchSessionsPayload } from '../types/research'

const listing = (runId: string, driving: boolean | undefined): ResearchSessionsPayload => ({
  runId, run: { id: runId, question: 'q', workspace: 'C:/w', status: 'active', phase: 'active',
    nodes: 1, tasks: 1, ...(driving === undefined ? {} : { driving }) },
  graph: { run: runId, question: 'q', status: 'active', phase: 'active', nodes: [] },
  sessions: [], suspension: null, suspensions: [],
})

beforeEach(() => {
  confirm.mockReset()
  useResearchRunStore.setState({ runs: {} })
  useSessionStore.setState({ researchRuns: [] })
})

it('confirms a resume from a session listing that reports a live driver', () => {
  const stop = observeResearchDriving()
  useResearchRunStore.getState().applyListing(listing('r1', true))
  expect(confirm).toHaveBeenCalledWith('r1')
  stop()
})

it('confirms a resume from the activity poll summaries too', () => {
  const stop = observeResearchDriving()
  useSessionStore.setState({ researchRuns: [{ id: 'r2', question: 'q', workspace: 'C:/w',
    status: 'active', phase: 'active', nodes: 1, tasks: 1, driving: true }] })
  expect(confirm).toHaveBeenCalledWith('r2')
  stop()
})

it('does not confirm on an absent or unknown driving field: unknown is not driving', () => {
  const stop = observeResearchDriving()
  useResearchRunStore.getState().applyListing(listing('r3', undefined))
  useResearchRunStore.getState().applyListing(listing('r4', false))
  expect(confirm).not.toHaveBeenCalled()
  stop()
})

it('stops observing once released', () => {
  const stop = observeResearchDriving()
  stop()
  useResearchRunStore.getState().applyListing(listing('r5', true))
  expect(confirm).not.toHaveBeenCalled()
})
