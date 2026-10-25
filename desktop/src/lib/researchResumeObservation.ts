import { confirmResearchDriving } from './researchResume'
import { useResearchRunStore } from '../store/useResearchRunStore'
import { useSessionStore } from '../store/useSessionStore'

/**
 * Feed the existing observation chain into the resume confirmation.
 *
 * A resume is only accepted once a run is really driven, and the desktop already observes that
 * twice: the session observer pushes listings into `useResearchRunStore`, and the activity poller
 * keeps `researchRuns` current. Both carry `driving` from the board, so this subscribes to them
 * instead of adding a resume-specific poller.
 */
export function observeResearchDriving(): () => void {
  const fromListings = () => {
    for (const [runId, listing] of Object.entries(useResearchRunStore.getState().runs)) {
      if (listing?.run?.driving === true) confirmResearchDriving(runId)
    }
  }
  const fromSummaries = () => {
    for (const run of useSessionStore.getState().researchRuns) {
      if (run.driving === true) confirmResearchDriving(run.id)
    }
  }
  fromListings()
  fromSummaries()
  const stopListings = useResearchRunStore.subscribe(fromListings)
  const stopSummaries = useSessionStore.subscribe(fromSummaries)
  return () => {
    stopListings()
    stopSummaries()
  }
}
