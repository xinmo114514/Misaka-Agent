import { beforeEach, describe, expect, it } from 'vitest'
import { useResearchWorkspaceStore } from '../useResearchWorkspaceStore'
import { readResearchViewMode, RESEARCH_VIEW_MODE_STORAGE_KEY, saveResearchViewMode } from '../../lib/researchViewMode'

describe('research view state', () => {
  beforeEach(() => {
    useResearchWorkspaceStore.setState({ byRun: {} })
    localStorage.clear()
  })
  it('keeps the view mode, the expanded pane and the details fold per run', () => {
    const store = useResearchWorkspaceStore.getState()
    store.setViewMode('r1', 'multi')
    store.setExpandedExecutor('r1', 'a')
    store.setDetailsOpen('r1', true)
    const run = useResearchWorkspaceStore.getState().byRun.r1
    expect(run.viewMode).toBe('multi')
    expect(run.expandedExecutorId).toBe('a')
    expect(run.detailsOpen).toBe(true)
    // Another run starts clean instead of inheriting a layout.
    expect(useResearchWorkspaceStore.getState().byRun.r2).toBeUndefined()
    store.setExpandedExecutor('r2', null)
    expect(useResearchWorkspaceStore.getState().byRun.r2.expandedExecutorId).toBeNull()
    expect(useResearchWorkspaceStore.getState().byRun.r1.expandedExecutorId).toBe('a')
  })
  it('defaults the stored preference to the focus view and survives a disabled storage', () => {
    expect(readResearchViewMode()).toBe('focus')
    saveResearchViewMode('multi')
    expect(localStorage.getItem(RESEARCH_VIEW_MODE_STORAGE_KEY)).toBe('multi')
    const getItem = Storage.prototype.getItem
    const setItem = Storage.prototype.setItem
    Storage.prototype.getItem = () => { throw new Error('storage disabled') }
    Storage.prototype.setItem = () => { throw new Error('storage disabled') }
    try {
      expect(readResearchViewMode()).toBe('focus')
      expect(() => saveResearchViewMode('multi')).not.toThrow()
    } finally {
      Storage.prototype.getItem = getItem
      Storage.prototype.setItem = setItem
    }
  })
})
