export type ResearchViewMode = 'focus' | 'multi'

export const RESEARCH_VIEW_MODE_STORAGE_KEY = 'misaka_research_view_mode'

/**
 * The research workspace opens in the focus view and remembers the user's last choice.
 *
 * A plain localStorage key, like the other desktop preferences: the value is one string and the
 * window must stay usable when storage is disabled, so it is read with a fallback.
 */
export function readResearchViewMode(): ResearchViewMode {
  try {
    return localStorage.getItem(RESEARCH_VIEW_MODE_STORAGE_KEY) === 'multi' ? 'multi' : 'focus'
  } catch {
    return 'focus'
  }
}

export function saveResearchViewMode(mode: ResearchViewMode): void {
  try {
    localStorage.setItem(RESEARCH_VIEW_MODE_STORAGE_KEY, mode)
  } catch {
    // The current window remains usable when browser storage is disabled.
  }
}
