import { beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResearchTilingWorkspace } from './ResearchTilingWorkspace'
import { useResearchSessionsStore } from '../../store/useResearchSessionsStore'
import { useResearchRunStore } from '../../store/useResearchRunStore'
import { useResearchWorkspaceStore } from '../../store/useResearchWorkspaceStore'
import { useSessionStore } from '../../store/useSessionStore'
import { useResearchActivityStore } from '../../lib/researchActivityStore'
import { researchSessionsBridge } from '../../lib/researchSessionsBridge'
import { request } from '../../lib/bridge'
import type { ResearchSessionDescriptor, ResearchSessionsPayload } from '../../types/research'

vi.mock('../../lib/researchSessionsBridge', () => ({ researchSessionsBridge: {
  load: vi.fn(), history: vi.fn(), watch: vi.fn(), content: vi.fn(),
  retainVisible: vi.fn((runId, ids, workspace, status) => {
    let live = true
    void researchSessionsBridge.watch(runId, ids, workspace).then(
      () => { if (live) status?.(null) }, error => { if (live) status?.(error) },
    )
    return () => { live = false }
  }),
} }))
vi.mock('../../lib/bridge', () => ({ request: vi.fn().mockResolvedValue({ graph: { nodes: [], plans: [], reconciles: [] } }) }))
vi.mock('../../lib/researchBridge', () => ({ executeResearchControl: vi.fn() }))

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function publish(runId = 'A', workspace = 'C:/A') {
  const descriptor = (id: string, nodeId: string, role: 'last_order' | 'sister'): ResearchSessionDescriptor => ({
    executorId: `${runId}-${id}`, sessionId: `${runId}-${id}`, sessionFile: null, nodeId,
    taskId: role === 'sister' ? id : null, role, label: id, workspace, status: 'running',
    generation: 1, attempt: 1, startedAt: 1, endedAt: null, error: null,
  })
  const sessions = [descriptor('root', 'root', 'last_order'), descriptor('member', 'root', 'sister'), descriptor('branch', 'branch', 'last_order')]
  const listing: ResearchSessionsPayload = { runId,
    run: { id: runId, question: `${runId} question`, workspace, status: 'active', phase: 'cards', driving: true, nodes: 2, tasks: 1 },
    graph: { run: runId, question: 'Q', status: 'active', phase: 'cards', nodes: [
      { id: 'root', question: 'Root question', depth: 0, status: 'executing', kind: 'root', parents: [], children: ['branch'] },
      { id: 'branch', question: 'Branch question', depth: 1, status: 'executing', kind: 'alt', parents: ['root'], children: [] },
    ] }, sessions, suspension: null, suspensions: [],
  }
  useResearchRunStore.setState(state => ({ runs: { ...state.runs, [runId]: listing } }))
  useResearchSessionsStore.getState().upsertDescriptors(runId, sessions)
  for (const item of sessions) useResearchSessionsStore.getState().applyHistory({ runId, executorId: item.executorId,
    messages: [{ id: item.executorId, role: 'assistant', content: `${item.executorId} transcript`, timestamp: 1 }],
    nextCursor: null, hasMore: false, availability: 'available', historyVersion: 'v1',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(request).mockReset().mockResolvedValue({ graph: { nodes: [], plans: [], reconciles: [] } })
  localStorage.clear()
  useResearchWorkspaceStore.setState({ byRun: {} })
  useResearchSessionsStore.setState({ byExecutor: {} })
  useResearchRunStore.setState({ runs: {} })
  useResearchActivityStore.setState({ details: {}, errors: {} })
  vi.mocked(researchSessionsBridge.load).mockReset().mockResolvedValue(null as never)
  vi.mocked(researchSessionsBridge.history).mockReset().mockResolvedValue(null as never)
  vi.mocked(researchSessionsBridge.watch).mockReset().mockResolvedValue(undefined)
})

it('selecting a focus node replaces the manually read member without rebinding the writer or side reader', async () => {
  publish()
  useResearchWorkspaceStore.getState().setMainExecutor('A', 'A-member')
  useResearchWorkspaceStore.getState().setSideExecutor('A', 'A-member')
  const binding = useSessionStore.getState().researchBinding
  const view = render(<ResearchTilingWorkspace runId="A" workspace="C:/A" />)
  fireEvent.click(screen.getByRole('button', { name: '更多研究选项' }))
  fireEvent.click(screen.getByRole('button', { name: '当前节点' }))
  fireEvent.click(screen.getByRole('button', { name: 'Branch question' }))
  expect(view.container.querySelector('.research-focus-main')).toHaveTextContent('A-branch transcript')
  expect(screen.getByRole('complementary')).toHaveTextContent('A-member transcript')
  expect(useSessionStore.getState().researchBinding).toBe(binding)
})

it('does not publish a late watch failure from research A into research B', async () => {
  publish(); publish('B', 'C:/B')
  const old = deferred()
  vi.mocked(researchSessionsBridge.watch).mockReturnValueOnce(old.promise)
  const view = render(<ResearchTilingWorkspace runId="A" workspace="C:/A" />)
  view.rerender(<ResearchTilingWorkspace runId="B" workspace="C:/B" />)
  await act(async () => { old.reject(new Error('A observer offline')) })
  expect(screen.queryByText(/A observer offline/)).not.toBeInTheDocument()
})

it('does not clear research B watch failure when the obsolete A watch succeeds', async () => {
  publish(); publish('B', 'C:/B')
  const old = deferred()
  vi.mocked(researchSessionsBridge.watch).mockReturnValueOnce(old.promise).mockRejectedValueOnce(new Error('B observer offline'))
  const view = render(<ResearchTilingWorkspace runId="A" workspace="C:/A" />)
  view.rerender(<ResearchTilingWorkspace runId="B" workspace="C:/B" />)
  expect(await screen.findByRole('alert')).toHaveTextContent('B observer offline')
  await act(async () => { old.resolve() })
  expect(screen.getByRole('alert')).toHaveTextContent('B observer offline')
})

it('clears a recovered watch error when the reader explicitly retries', async () => {
  publish()
  vi.mocked(researchSessionsBridge.watch).mockRejectedValueOnce(new Error('observer temporarily offline'))
  render(<ResearchTilingWorkspace runId="A" workspace="C:/A" />)
  expect(await screen.findByRole('alert')).toHaveTextContent('observer temporarily offline')
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
})

it('does not retain a loading error when the workspace owner changes for the same run', async () => {
  publish()
  vi.mocked(researchSessionsBridge.load).mockRejectedValueOnce(new Error('old workspace offline'))
  const view = render(<ResearchTilingWorkspace runId="A" workspace="C:/A" />)
  expect(await screen.findByRole('alert')).toHaveTextContent('old workspace offline')
  view.rerender(<ResearchTilingWorkspace runId="A" workspace="C:/B" />)
  await act(async () => {})
  expect(screen.queryByText(/old workspace offline/)).not.toBeInTheDocument()
})

it('does not publish an obsolete visible member watch failure', async () => {
  publish()
  const old = deferred()
  vi.mocked(researchSessionsBridge.watch).mockReturnValueOnce(old.promise)
  render(<ResearchTilingWorkspace runId="A" workspace="C:/A" />)
  act(() => useResearchWorkspaceStore.getState().setMainExecutor('A', 'A-member'))
  await act(async () => { old.reject(new Error('old root observer failed')) })
  expect(screen.queryByText(/old root observer failed/)).not.toBeInTheDocument()
})

it('keeps both independent load and watch errors visible until each operation recovers', async () => {
  publish()
  vi.mocked(researchSessionsBridge.load).mockRejectedValueOnce(new Error('directory offline'))
  vi.mocked(researchSessionsBridge.watch).mockRejectedValueOnce(new Error('observer offline'))
  render(<ResearchTilingWorkspace runId="A" workspace="C:/A" />)
  expect(await screen.findByText(/directory offline/)).toBeInTheDocument()
  expect(await screen.findByText(/observer offline/)).toBeInTheDocument()
})

it('refreshes multi history for a new generation even when executor and session ids are unchanged', async () => {
  publish()
  useResearchSessionsStore.setState(state => ({ byExecutor: { ...state.byExecutor,
    'A-root': { ...state.byExecutor['A-root'], messages: [], historyVersion: null, loadedHistoryVersion: null },
  } }))
  const old = deferred<never>()
  vi.mocked(researchSessionsBridge.history).mockReturnValueOnce(old.promise)
  render(<ResearchTilingWorkspace runId="A" workspace="C:/A" mode="multi" />)
  expect(researchSessionsBridge.history).toHaveBeenCalledTimes(1)
  act(() => {
    const listing = useResearchRunStore.getState().runs.A
    const sessions = listing.sessions.map(item => item.executorId === 'A-root'
      ? { ...item, generation: 2, sessionFile: 'replacement.jsonl' } : item)
    useResearchSessionsStore.getState().upsertDescriptors('A', sessions)
    useResearchRunStore.setState({ runs: { A: { ...listing, sessions } } })
  })
  await waitFor(() => expect(researchSessionsBridge.history).toHaveBeenCalledTimes(2))
  await act(async () => { old.reject(new Error('obsolete generation unavailable')) })
  expect(screen.queryByText(/obsolete generation unavailable/)).not.toBeInTheDocument()
})

it('waits for an explicit retry when another visible history read succeeds after a peer fails', async () => {
  publish()
  useResearchSessionsStore.setState(state => ({ byExecutor: { ...state.byExecutor,
    'A-root': { ...state.byExecutor['A-root'], messages: [], historyVersion: null, loadedHistoryVersion: null },
    'A-member': { ...state.byExecutor['A-member'], messages: [], historyVersion: null, loadedHistoryVersion: null },
  } }))
  const failed = deferred<never>()
  const peer = deferred<never>()
  vi.mocked(researchSessionsBridge.history).mockImplementation((_run, id) => id === 'A-root' ? failed.promise : peer.promise)
  render(<ResearchTilingWorkspace runId="A" workspace="C:/A" mode="multi" />)
  await act(async () => { failed.reject(new Error('root history offline')) })
  expect(screen.getByRole('alert')).toHaveTextContent('root history offline')
  await act(async () => {
    useResearchSessionsStore.getState().applyHistory({ runId: 'A', executorId: 'A-member',
      messages: [{ id: 'peer-loaded', role: 'assistant', content: 'Peer history loaded', timestamp: 1 }],
      historyVersion: 'v1', nextCursor: null, hasMore: false, availability: 'available',
    })
    peer.resolve(null as never)
  })
  expect(vi.mocked(researchSessionsBridge.history).mock.calls.filter(call => call[1] === 'A-root')).toHaveLength(1)
  expect(screen.getByRole('alert')).toHaveTextContent('root history offline')
  vi.mocked(researchSessionsBridge.history).mockImplementation(async (_run, id) => {
    const page = { runId: 'A', executorId: id,
      messages: [{ id: 'root-retried', role: 'assistant' as const, content: 'Root retry recovered', timestamp: 1 }],
      historyVersion: 'v1', nextCursor: null, hasMore: false, availability: 'available' as const }
    useResearchSessionsStore.getState().applyHistory(page)
    return page
  })
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByText('Root retry recovered')).toBeInTheDocument()
  expect(vi.mocked(researchSessionsBridge.history).mock.calls.filter(call => call[1] === 'A-root')).toHaveLength(2)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
