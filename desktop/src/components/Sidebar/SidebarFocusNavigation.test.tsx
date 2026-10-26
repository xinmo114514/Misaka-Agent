import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Sidebar } from './Sidebar'
import { ResearchFocusView } from '../ResearchWorkspace/ResearchFocusView'
import { useResearchRunStore } from '../../store/useResearchRunStore'
import { useResearchSessionsStore } from '../../store/useResearchSessionsStore'
import { useResearchWorkspaceStore, type WorkspaceState } from '../../store/useResearchWorkspaceStore'
import { useSessionStore } from '../../store/useSessionStore'
import { RESEARCH_VIEW_MODE_STORAGE_KEY } from '../../lib/researchViewMode'
import { researchSessionsBridge } from '../../lib/researchSessionsBridge'
import { openResearchConversation } from '../../lib/startComposerResearch'
import type { ResearchSessionDescriptor, ResearchSessionsPayload } from '../../types/research'

vi.mock('../../lib/researchSessionsBridge', () => ({ researchSessionsBridge: {
  retainVisible: vi.fn(() => () => {}), load: vi.fn().mockResolvedValue(null),
  history: vi.fn().mockResolvedValue(null), watch: vi.fn().mockResolvedValue(null),
  unwatch: vi.fn().mockResolvedValue(null), listen: vi.fn(() => () => {}), content: vi.fn(),
} }))
vi.mock('../../lib/startComposerResearch', () => ({ openResearchConversation: vi.fn() }))

const workspace = 'C:/fixture'
const runId = 'sidebar-run'

function descriptor(executorId: string, nodeId: string, role: 'last_order' | 'sister', label: string): ResearchSessionDescriptor {
  return { executorId, sessionId: `${executorId}-session`, sessionFile: `${executorId}.jsonl`, nodeId,
    taskId: role === 'last_order' ? null : `${executorId}-task`, role, label, workspace, status: 'ready',
    generation: 1, attempt: 1, startedAt: 1, endedAt: null, error: null }
}

const listing: ResearchSessionsPayload = {
  runId,
  run: { id: runId, question: 'Sidebar run', workspace, status: 'active', phase: 'active', nodes: 2, tasks: 2 },
  graph: { run: runId, question: 'Sidebar run', status: 'active', phase: 'active', nodes: [
    { id: 'root', question: 'Root question', depth: 0, status: 'active', kind: 'root', parents: [], children: ['branch'] },
    { id: 'branch', question: 'Branch question', depth: 1, status: 'active', kind: 'alt', parents: ['root'], children: [] },
  ] },
  sessions: [
    descriptor('root-lo', 'root', 'last_order', 'Root controller'),
    descriptor('member-a', 'root', 'sister', 'Member A'),
    descriptor('member-b', 'root', 'sister', 'Member B'),
    descriptor('branch-lo', 'branch', 'last_order', 'Branch controller'),
  ],
  suspension: null,
  suspensions: [],
}

function workspaceState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    selectedNodeId: 'root', focusedExecutorId: 'member-a', pinnedExecutorIds: ['member-a'],
    reading: { 'member-a': { scrollTop: 91, following: false } },
    mainExecutorId: 'root-lo', sideExecutorId: 'member-a',
    ...overrides,
  }
}

function FocusReader() {
  const nodeId = useResearchWorkspaceStore(state => state.byRun[runId]?.selectedNodeId ?? null)
  return <ResearchFocusView runId={runId} workspace={workspace} listing={listing} nodeId={nodeId} />
}

function renderSidebar(withReader = false) {
  return render(<>{<Sidebar />}{withReader && <FocusReader />}</>)
}

beforeEach(() => {
  localStorage.clear()
  vi.mocked(openResearchConversation).mockReset()
  vi.mocked(researchSessionsBridge.history).mockReset().mockResolvedValue(null as never)
  useResearchRunStore.setState({ runs: { [runId]: listing } })
  useResearchSessionsStore.setState({ byExecutor: {} })
  useResearchSessionsStore.getState().upsertDescriptors(runId, listing.sessions)
  useResearchWorkspaceStore.setState({ byRun: { [runId]: workspaceState() } })
  useSessionStore.setState({
    sessions: [], projects: [], currentWorkspace: workspace, recentWorkspaces: [], currentSessionPath: null,
    researchBinding: { sessionId: 'root-session', sessionFile: 'root.jsonl', workspace, runId },
    researchPageView: 'conversation', agentMode: 'research', draft: 'root writer draft',
  })
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('uses focus navigation by default so sidebar members and nodes replace the main reader only', async () => {
  const binding = useSessionStore.getState().researchBinding
  renderSidebar(true)
  expect(screen.getByLabelText('Root controller 会话记录')).toBeInTheDocument()

  fireEvent.click(screen.getByTitle('Member B · ready'))

  await waitFor(() => expect(screen.getByLabelText('Member B 会话记录')).toBeInTheDocument())
  expect(useResearchWorkspaceStore.getState().byRun[runId]).toEqual(workspaceState({ mainExecutorId: 'member-b' }))
  expect(useSessionStore.getState().researchBinding).toBe(binding)
  expect(useSessionStore.getState().draft).toBe('root writer draft')

  fireEvent.click(screen.getByRole('button', { name: 'Branch question' }))

  await waitFor(() => expect(screen.getByLabelText('Branch controller 会话记录')).toBeInTheDocument())
  expect(useResearchWorkspaceStore.getState().byRun[runId]).toEqual(workspaceState({
    selectedNodeId: 'branch', mainExecutorId: null,
  }))
  expect(useSessionStore.getState().researchBinding).toBe(binding)
  expect(useSessionStore.getState().draft).toBe('root writer draft')
  expect(openResearchConversation).not.toHaveBeenCalled()
})

it('retains multi-pane focus and node semantics when the saved global mode is multi', async () => {
  localStorage.setItem(RESEARCH_VIEW_MODE_STORAGE_KEY, 'multi')
  useResearchWorkspaceStore.setState({ byRun: { [runId]: workspaceState({ mainExecutorId: 'manual-main' }) } })
  const binding = useSessionStore.getState().researchBinding
  renderSidebar()

  fireEvent.click(screen.getByTitle('Member B · ready'))

  await waitFor(() => expect(useResearchWorkspaceStore.getState().byRun[runId].focusedExecutorId).toBe('member-b'))
  expect(useResearchWorkspaceStore.getState().byRun[runId]).toEqual(workspaceState({
    focusedExecutorId: 'member-b', pinnedExecutorIds: ['member-b', 'member-a'], mainExecutorId: 'manual-main',
  }))

  fireEvent.click(screen.getByRole('button', { name: 'Branch question' }))

  await waitFor(() => expect(useResearchWorkspaceStore.getState().byRun[runId].selectedNodeId).toBe('branch'))
  expect(useResearchWorkspaceStore.getState().byRun[runId]).toEqual(workspaceState({
    selectedNodeId: 'branch', focusedExecutorId: 'member-b',
    pinnedExecutorIds: ['member-b', 'member-a'], mainExecutorId: 'manual-main',
  }))
  expect(useSessionStore.getState().researchBinding).toBe(binding)
  expect(useSessionStore.getState().draft).toBe('root writer draft')
  expect(openResearchConversation).not.toHaveBeenCalled()
})

it('prefers a run saved in focus mode over the global multi preference', async () => {
  localStorage.setItem(RESEARCH_VIEW_MODE_STORAGE_KEY, 'multi')
  useResearchWorkspaceStore.setState({ byRun: { [runId]: workspaceState({ viewMode: 'focus' }) } })
  const binding = useSessionStore.getState().researchBinding
  renderSidebar(true)

  fireEvent.click(screen.getByTitle('Member B · ready'))

  await waitFor(() => expect(screen.getByLabelText('Member B 会话记录')).toBeInTheDocument())
  expect(useResearchWorkspaceStore.getState().byRun[runId]).toEqual(workspaceState({
    viewMode: 'focus', mainExecutorId: 'member-b',
  }))
  expect(useSessionStore.getState().researchBinding).toBe(binding)
  expect(useSessionStore.getState().draft).toBe('root writer draft')
  expect(openResearchConversation).not.toHaveBeenCalled()
})
