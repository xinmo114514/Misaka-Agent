import { useResearchRunStore } from '../store/useResearchRunStore'
import { useSessionStore } from '../store/useSessionStore'
import { confirmResearchStopped, observeResearchStopping, researchRunAtRest } from './researchStop'
import { useResearchStopStore } from '../store/useResearchStopStore'
import type { ResearchRunSummary } from '../types/research'

/**
 * Feed the existing observation chain into the stop confirmation.
 *
 * A stop is finished only when the board reports the run at rest, and the desktop already
 * watches that twice: the session observer pushes listings into `useResearchRunStore`, and
 * the activity poller keeps `researchRuns` current. This subscribes to them instead of
 * adding a stop-specific poller. A `stopped` row whose lease answer is missing (old protocol)
 * gets one authoritative detail read -- the same refresh the pill's own entry offers.
 */
export function observeResearchStop(): () => void {
  const lastDetailAt = new Map<string, number>()
  const lastObserved = new Map<string, ResearchRunSummary>()
  const settledEpochs = new Map<string, number>()
  const settle = (observed: ResearchRunSummary) => {
    const runId = observed.id
    const epoch = useSessionStore.getState().researchCards[runId]?.controlEpoch ?? 0
    if (settledEpochs.get(runId) === epoch && !researchRunAtRest(observed.status, observed.driving)) return
    const previous = lastObserved.get(runId)
    if (previous?.updatedAt !== undefined && observed.updatedAt !== undefined && observed.updatedAt < previous.updatedAt) return
    lastObserved.set(runId, observed)
    if (researchRunAtRest(observed.status, observed.driving)) settledEpochs.set(runId, epoch)
    if (confirmResearchStopped(runId, observed.status, observed.driving)) {
      useSessionStore.setState(state => {
        const researchConversations = { ...state.researchConversations }
        for (const [id, binding] of Object.entries(state.researchBindings)) {
          const conversation = researchConversations[id]
          if (binding.runId === runId && conversation?.isAborting) researchConversations[id] = { ...conversation, isAborting: false }
        }
        return { researchConversations,
          ...(state.researchBinding?.runId === runId && state.researchConversation.isAborting
            ? { researchConversation: { ...state.researchConversation, isAborting: false } } : {}) }
      })
      return
    }
    observeResearchStopping(runId, observed.status, observed.driving, observed.stop_requested)
    if (observed.driving === undefined && useResearchStopStore.getState().byRun[runId]) {
      const now = Date.now()
      if (!lastDetailAt.has(runId) || now - lastDetailAt.get(runId)! >= 5_000) {
        lastDetailAt.set(runId, now)
        void useSessionStore.getState().fetchResearchCardDetails(runId).catch(() => {})
      }
    }
  }
  // Process the lane which actually changed: a stale cached listing must not mask a fresh
  // detail/summary answer, nor recreate a wait on unrelated draft/navigation changes.
  const stopListings = useResearchRunStore.subscribe((state, previous) => {
    for (const [id, listing] of Object.entries(state.runs)) if (listing !== previous.runs[id]) settle(listing.run)
  })
  const stopSummaries = useSessionStore.subscribe((state, previous) => {
    if (state.researchRuns === previous.researchRuns) return
    const old = new Map(previous.researchRuns.map(run => [run.id, run]))
    for (const run of state.researchRuns) if (run !== old.get(run.id)) settle(run)
  })
  const initial = new Map(Object.values(useResearchRunStore.getState().runs).map(listing => [listing.run.id, listing.run]))
  for (const run of useSessionStore.getState().researchRuns) {
    const old = initial.get(run.id)
    if (!old || (run.updatedAt ?? 0) >= (old.updatedAt ?? 0)) initial.set(run.id, run)
  }
  for (const run of initial.values()) settle(run)
  return () => {
    stopListings()
    stopSummaries()
  }
}
