import { create } from 'zustand'
import type { ResearchSessionDescriptor } from '../types/research'
import type { ResearchViewMode } from '../lib/researchViewMode'
import { RESEARCH_MULTI_MEMBER_LIMIT } from '../lib/researchMultiLayout'
export interface ReadingState { scrollTop: number; following: boolean }
export interface WorkspaceState {
  selectedNodeId: string | null; focusedExecutorId: string | null; pinnedExecutorIds: string[]
  reading: Record<string, ReadingState>
  /** Focus or multi-pane. Kept per run so a switch between runs cannot leak a layout. */
  viewMode?: ResearchViewMode
  /** A pane lifted out of the tile grid in the multi-pane view ("展开会话"). */
  expandedExecutorId?: string | null
  /** Folded "activity / log / usage / model" details, per run. */
  detailsOpen?: boolean
  /** Focus process panel, folded by default and independent for each run. */
  processOpen?: boolean
  /**
   * The transcript the main area shows. Absent means the node's controller.
   *
   * Browsing a sub-agent is a reading choice only: it never rebinds the research conversation,
   * never switches an ordinary chat session, and never touches the node/pin state that the
   * multi-pane grid uses.
   */
  mainExecutorId?: string | null
  /** The transcript in the 420px side viewer. One at a time; null closes it. */
  sideExecutorId?: string | null
}
interface State {
  byRun: Record<string, WorkspaceState>
  selectNode: (runId: string, nodeId: string) => void
  focusExecutor: (runId: string, descriptor: ResearchSessionDescriptor) => void
  setReading: (runId: string, executorId: string, reading: ReadingState) => void
  setViewMode: (runId: string, mode: ResearchViewMode) => void
  setExpandedExecutor: (runId: string, executorId: string | null) => void
  setDetailsOpen: (runId: string, open: boolean) => void
  setProcessOpen: (runId: string, open: boolean) => void
  setMainExecutor: (runId: string, executorId: string | null) => void
  setSideExecutor: (runId: string, executorId: string | null) => void
}
const empty = (): WorkspaceState => ({ selectedNodeId: null, focusedExecutorId: null, pinnedExecutorIds: [], reading: {} })
export const useResearchWorkspaceStore = create<State>(set => ({
  byRun: {},
  selectNode: (runId, nodeId) => set(state => ({ byRun: { ...state.byRun, [runId]: { ...(state.byRun[runId] ?? empty()), selectedNodeId: nodeId } } })),
  focusExecutor: (runId, descriptor) => set(state => {
    const old = state.byRun[runId] ?? empty()
    return { byRun: { ...state.byRun, [runId]: { ...old, selectedNodeId: descriptor.nodeId,
      focusedExecutorId: descriptor.executorId, pinnedExecutorIds: descriptor.role === 'last_order'
        ? old.pinnedExecutorIds.filter(id => id !== descriptor.executorId)
        : [descriptor.executorId, ...old.pinnedExecutorIds.filter(id => id !== descriptor.executorId)].slice(0, RESEARCH_MULTI_MEMBER_LIMIT) } } }
  }),
  setReading: (runId, executorId, reading) => set(state => {
    const old = state.byRun[runId] ?? empty()
    return { byRun: { ...state.byRun, [runId]: { ...old, reading: { ...old.reading, [executorId]: reading } } } }
  }),
  setViewMode: (runId, mode) => set(state => {
    const old = state.byRun[runId] ?? empty()
    return { byRun: { ...state.byRun, [runId]: { ...old, viewMode: mode } } }
  }),
  setExpandedExecutor: (runId, executorId) => set(state => {
    const old = state.byRun[runId] ?? empty()
    return { byRun: { ...state.byRun, [runId]: { ...old, expandedExecutorId: executorId } } }
  }),
  setDetailsOpen: (runId, open) => set(state => {
    const old = state.byRun[runId] ?? empty()
    return { byRun: { ...state.byRun, [runId]: { ...old, detailsOpen: open } } }
  }),
  setProcessOpen: (runId, open) => set(state => {
    const old = state.byRun[runId] ?? empty()
    return { byRun: { ...state.byRun, [runId]: { ...old, processOpen: open } } }
  }),
  setMainExecutor: (runId, executorId) => set(state => {
    const old = state.byRun[runId] ?? empty()
    return { byRun: { ...state.byRun, [runId]: { ...old, mainExecutorId: executorId } } }
  }),
  setSideExecutor: (runId, executorId) => set(state => {
    const old = state.byRun[runId] ?? empty()
    // Reopening replaces the viewer's content: there is only ever one side transcript.
    return { byRun: { ...state.byRun, [runId]: { ...old, sideExecutorId: executorId } } }
  }),
}))
