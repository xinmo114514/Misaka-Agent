export const SIDEBAR_VISIBILITY_STORAGE_KEY = 'misaka_sidebar_visible'

export function readSidebarVisible(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_VISIBILITY_STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

export function saveSidebarVisible(visible: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_VISIBILITY_STORAGE_KEY, visible ? '1' : '0')
  } catch {
    // The current window remains usable when browser storage is disabled.
  }
}
