import { create } from 'zustand'
import type { ResearchSessionsPayload } from '../types/research'

interface State {
  runs: Record<string, ResearchSessionsPayload>
  applyListing: (listing: ResearchSessionsPayload) => void
}
export const useResearchRunStore = create<State>(set => ({
  runs: {},
  applyListing: listing => set(state => ({ runs: { ...state.runs, [listing.runId]: listing } })),
}))
