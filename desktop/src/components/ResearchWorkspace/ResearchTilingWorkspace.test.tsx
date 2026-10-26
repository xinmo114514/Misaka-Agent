import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { act } from '@testing-library/react'
import { ResearchTilingWorkspace } from './ResearchTilingWorkspace'
import { useResearchSessionsStore } from '../../store/useResearchSessionsStore'
import { useResearchRunStore } from '../../store/useResearchRunStore'
import { useResearchWorkspaceStore } from '../../store/useResearchWorkspaceStore'
import { researchSessionsBridge } from '../../lib/researchSessionsBridge'
import { RESEARCH_VIEW_MODE_STORAGE_KEY } from '../../lib/researchViewMode'
import { request } from '../../lib/bridge'
import type { ResearchSessionDescriptor } from '../../types/research'

vi.mock('../../lib/researchSessionsBridge', () => ({ researchSessionsBridge: {
  retainVisible: vi.fn((runId: string, ids: string[], workspace?: string, status?: (error: unknown | null) => void) => {
    let live = true
    void researchSessionsBridge.watch(runId, ids, workspace).then(
      () => { if (live) status?.(null) }, error => { if (live) status?.(error) },
    )
    return () => { live = false }
  }),
  load: vi.fn().mockResolvedValue(null), history: vi.fn().mockResolvedValue(null), watch: vi.fn().mockResolvedValue(null),
  unwatch: vi.fn().mockResolvedValue(null), listen: vi.fn(() => () => {}), content: vi.fn(),
} }))
vi.mock('../../lib/bridge', () => ({ request: vi.fn() }))
const card = (id: string, role: 'last_order' | 'sister', status = 'running'): ResearchSessionDescriptor => ({
  executorId: id, sessionId: id, sessionFile: null, nodeId: 'node', taskId: id, role,
  label: id, workspace: 'C:/fixture', status, generation: 1, attempt: 1,
  startedAt: 100, endedAt: null, error: null,
})
/** These cases exercise the multi-pane tile grid; the focus view has its own suite. */
const useMultiPane = () => {
  localStorage.setItem(RESEARCH_VIEW_MODE_STORAGE_KEY, 'multi')
  useResearchWorkspaceStore.setState({ byRun: { r: { selectedNodeId: null, focusedExecutorId: null,
    pinnedExecutorIds: [], reading: {}, viewMode: 'multi' } } })
}
describe('research tiling workspace', () => {
  beforeEach(() => {
    vi.mocked(request).mockResolvedValue({ detail: { plan: null } })
    localStorage.clear()
    useResearchWorkspaceStore.setState({ byRun: {} })
  })
  it('renders LO and four actual sisters, each with its own transcript instead of root messages', () => {
    useMultiPane()
    vi.mocked(researchSessionsBridge.load).mockResolvedValue(null as never)
    vi.mocked(researchSessionsBridge.watch).mockResolvedValue(undefined)
    vi.mocked(researchSessionsBridge.unwatch).mockResolvedValue(undefined)
    vi.mocked(researchSessionsBridge.history).mockResolvedValue(null as never)
    const sessions = [card('lo', 'last_order'), ...['a', 'b', 'c', 'd'].map(id => card(id, 'sister'))]
    useResearchRunStore.setState({ runs: { r: { runId: 'r', run: { id: 'r', question: 'Q', workspace: 'C:/fixture', status: 'active', phase: 'cards', nodes: 1, tasks: 4 },
      graph: { run: 'r', question: 'Q', status: 'active', phase: 'cards', nodes: [{ id: 'node', question: 'Q', depth: 0, status: 'active', kind: 'root', parents: [], children: [] }] },
      sessions, suspension: null, suspensions: [] } } })
    useResearchSessionsStore.getState().upsertDescriptors('r', sessions)
    useResearchSessionsStore.getState().applyHistory({ runId: 'r', executorId: 'b', messages: [{ id: 'only-b', role: 'assistant', content: 'B unique output', timestamp: 1 }],
      nextCursor: null, hasMore: false, availability: 'available', historyVersion: 'v1' })
    render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture" />)
    expect(screen.getAllByRole('region', { name: /会话/ })).toHaveLength(5)
    expect(screen.getByText('B unique output')).toBeInTheDocument()
    expect(screen.getByTestId('research-pane-b')).toHaveTextContent('B unique output')
    expect(screen.getByTestId('research-pane-a')).not.toHaveTextContent('B unique output')
  })
  it('shows the selected node stop confirmation while other nodes keep running', () => {
    useMultiPane()
    vi.mocked(researchSessionsBridge.load).mockResolvedValue(null as never)
    vi.mocked(researchSessionsBridge.watch).mockResolvedValue(undefined)
    vi.mocked(researchSessionsBridge.history).mockResolvedValue(null as never)
    const sessions=[card('node-lo','last_order','failed')]
    useResearchRunStore.setState({runs:{r:{runId:'r',run:{id:'r',question:'Q',workspace:'C:/fixture',status:'active',phase:'active',nodes:2,tasks:1},
      graph:{run:'r',question:'Q',status:'active',phase:'active',nodes:[{id:'node',question:'Q',depth:0,status:'failed',kind:'root',parents:[],children:['other']},{id:'other',question:'Other',depth:1,status:'executing',kind:'alt',parents:['node'],children:[]}]},
      sessions,suspension:null,suspensions:[{id:'halt',runId:'r',nodeId:'node',scope:'node',reason:'all_cards_stopped',hasAcceptedOutput:false,confirmations:[],resumeCommand:'/research resume r',message:'node stop confirmation',createdAt:1,resolvedAt:null}]}}})
    useResearchSessionsStore.getState().upsertDescriptors('r',sessions)
    render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture"/>)
    expect(screen.getByText('node stop confirmation')).toBeInTheDocument()
    // A node-level suspension never offers a run-level resume: the stop banner itself has none.
    // The shared toolbar offers resume only for a known stopped driver. Unknown remains unknown,
    // with an explicit refresh available in More instead of guessing the run is resumable.
    const banner = screen.getByText('node stop confirmation').closest('[role="status"]')
    expect(banner).not.toBeNull()
    expect(within(banner as HTMLElement).queryByRole('button', { name: '恢复研究' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复研究' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '更多研究选项' }))
    fireEvent.click(screen.getByRole('button', { name: '研究详情' }))
    expect(screen.getByRole('button', { name: '刷新研究状态' })).toBeEnabled()
  })
  it('projects native node card statuses and plan dependencies beside LO without replacing her transcript', async () => {
    useMultiPane()
    vi.mocked(researchSessionsBridge.load).mockResolvedValue(null as never)
    vi.mocked(researchSessionsBridge.watch).mockResolvedValue(undefined)
    vi.mocked(researchSessionsBridge.history).mockResolvedValue(null as never)
    vi.mocked(request).mockResolvedValue({ detail: { plan: { tasks: [
      { local_id: 'C1', title: 'Source audit', dependencies: [] },
      { local_id: 'C2', title: 'Compare findings', dependencies: ['C1'] },
    ] } } })
    const sessions = [card('lo', 'last_order')]
    useResearchRunStore.setState({ runs: { r: { runId: 'r', run: { id: 'r', question: 'Q', workspace: 'C:/fixture', status: 'active', phase: 'cards', nodes: 1, tasks: 2 },
      graph: { run: 'r', question: 'Q', status: 'active', phase: 'cards', nodes: [{ id: 'node', question: 'Q', depth: 0, status: 'executing', kind: 'root', parents: [], children: [], cards: [
        { id: 't1', title: 'Source audit', status: 'running' }, { id: 't2', title: 'Compare findings', status: 'ready' },
      ] }] }, sessions, suspension: null, suspensions: [] } } })
    useResearchSessionsStore.getState().upsertDescriptors('r', sessions)
    useResearchSessionsStore.getState().applyHistory({ runId: 'r', executorId: 'lo', messages: [{ id: 'lo-content', role: 'assistant', content: 'LO native reasoning', timestamp: 1 }],
      nextCursor: null, hasMore: false, availability: 'available', historyVersion: 'v1' })
    render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture" />)
    expect(await screen.findByText('C2 · Compare findings')).toBeInTheDocument()
    expect(screen.getByText('已完成 0/2 · 运行中 1 · 待执行 1')).toBeInTheDocument()
    expect(screen.getByText('依赖 C1')).toBeInTheDocument()
    expect(screen.getByTestId('research-pane-lo')).toHaveTextContent('LO native reasoning')
  })
  it('keeps five focused Sisters visible alongside LO while reading state survives', () => {
    useMultiPane()
    vi.mocked(researchSessionsBridge.load).mockResolvedValue(null as never)
    vi.mocked(researchSessionsBridge.watch).mockResolvedValue(undefined)
    vi.mocked(researchSessionsBridge.history).mockResolvedValue(null as never)
    const sisters = ['a','b','c','d','e'].map(id => card(id,'sister'))
    const sessions = [card('lo','last_order'), ...sisters]
    useResearchRunStore.setState({ runs: { r: { runId: 'r', run: { id:'r',question:'Q',workspace:'C:/fixture',status:'active',phase:'cards',nodes:1,tasks:5 },
      graph: { run:'r',question:'Q',status:'active',phase:'cards',nodes:[{id:'node',question:'Q',depth:0,status:'executing',kind:'root',parents:[],children:[]}] },
      sessions,suspension:null,suspensions:[] } } })
    useResearchSessionsStore.getState().upsertDescriptors('r',sessions)
    const store=useResearchWorkspaceStore.getState()
    store.setReading('r','a',{scrollTop:321,following:false})
    render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture" />)
    for (const sister of sisters) act(() => store.focusExecutor('r',sister))
    expect(screen.getByTestId('research-pane-e')).toBeInTheDocument()
    expect(screen.getByTestId('research-pane-lo')).toBeInTheDocument()
    expect(screen.getAllByRole('region',{name:/会话/})).toHaveLength(6)
    expect(useResearchWorkspaceStore.getState().byRun.r.reading.a.scrollTop).toBe(321)
  })
})
