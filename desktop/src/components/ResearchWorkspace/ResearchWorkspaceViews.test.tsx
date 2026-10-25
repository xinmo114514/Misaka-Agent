import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ResearchTilingWorkspace } from './ResearchTilingWorkspace'
import { useResearchSessionsStore } from '../../store/useResearchSessionsStore'
import { useResearchRunStore } from '../../store/useResearchRunStore'
import { useResearchWorkspaceStore } from '../../store/useResearchWorkspaceStore'
import { useSessionStore } from '../../store/useSessionStore'
import { useResearchActivityStore } from '../../lib/researchActivityStore'
import { researchSessionsBridge } from '../../lib/researchSessionsBridge'
import { RESEARCH_VIEW_MODE_STORAGE_KEY } from '../../lib/researchViewMode'
import { request } from '../../lib/bridge'
import type { ResearchSessionDescriptor, ResearchSessionsPayload } from '../../types/research'

vi.mock('../../lib/researchSessionsBridge', () => ({ researchSessionsBridge: {
  load: vi.fn().mockResolvedValue(null), history: vi.fn().mockResolvedValue(null), watch: vi.fn().mockResolvedValue(null),
  unwatch: vi.fn().mockResolvedValue(null), listen: vi.fn(() => () => {}), content: vi.fn(),
} }))
vi.mock('../../lib/bridge', () => ({ request: vi.fn() }))
vi.mock('../../lib/researchBridge', () => ({ executeResearchControl: vi.fn() }))
const card = (id: string, role: 'last_order' | 'sister', status = 'running'): ResearchSessionDescriptor => ({
  executorId: id, sessionId: id, sessionFile: null, nodeId: 'node', taskId: id, role,
  label: id, workspace: 'C:/fixture', status, generation: 1, attempt: 1, startedAt: 100, endedAt: null, error: null,
})
const publish = (overrides: Partial<ResearchSessionsPayload> = {}) => {
  const sessions = [card('lo', 'last_order'), card('a', 'sister')]
  useResearchSessionsStore.getState().upsertDescriptors('r', sessions)
  useResearchRunStore.setState({ runs: { r: { runId: 'r',
    run: { id: 'r', question: 'Q', workspace: 'C:/fixture', status: 'active', phase: 'active', nodes: 1, tasks: 1 },
    graph: { run: 'r', question: 'Q', status: 'active', phase: 'active',
      nodes: [{ id: 'node', question: 'Q', depth: 0, status: 'awaiting_approval', kind: 'root', parents: [], children: [] }] },
    sessions, suspension: null, suspensions: [], ...overrides } } })
  return sessions
}

beforeEach(() => {
  localStorage.clear()
  vi.mocked(request).mockReset().mockResolvedValue({ graph: { nodes: [], plans: [], reconciles: [] } })
  useResearchWorkspaceStore.setState({ byRun: {} })
  useResearchSessionsStore.setState({ byExecutor: {} })
  useResearchRunStore.setState({ runs: {} })
  useResearchActivityStore.setState({ details: {}, errors: {} })
  vi.mocked(researchSessionsBridge.load).mockResolvedValue(null as never)
  vi.mocked(researchSessionsBridge.watch).mockResolvedValue(undefined)
  vi.mocked(researchSessionsBridge.history).mockResolvedValue(null as never)
})

describe('research workspace views', () => {
  it('keeps exactly one toolbar while listing loads, fails and has no readable members', async () => {
    vi.mocked(researchSessionsBridge.load).mockRejectedValueOnce(new Error('listing offline'))
    const view = render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture" />)
    expect(view.container.querySelectorAll('[data-research-focus-toolbar]')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '更多研究选项' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '重试读取' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试读取' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试读取' })).not.toBeInTheDocument())
    act(() => { publish({ sessions: [] }) })
    expect(view.container.querySelectorAll('[data-research-focus-toolbar]')).toHaveLength(1)
    expect(screen.getByText('当前节点还没有可查看的会话。')).toBeInTheDocument()
  })

  it('keeps run status, a complete accessible question and one team entry while reading a completed member', () => {
    publish()
    const value = useResearchRunStore.getState().runs.r
    const question = 'A long research question '.repeat(30)
    value.run = { ...value.run, question, driving: true }
    value.sessions[1].status = 'completed'
    useResearchWorkspaceStore.getState().setMainExecutor('r', 'a')
    const view = render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture" />)
    const toolbar = view.container.querySelector('[data-research-focus-toolbar]') as HTMLElement
    expect(within(toolbar).getByRole('heading', { name: question.trim() })).toHaveAttribute('title', question)
    expect(toolbar.querySelector('.research-status')).toHaveAttribute('title', 'active')
    expect(within(toolbar).getAllByRole('button', { name: /研究团队/ })).toHaveLength(1)
    expect(within(toolbar).getAllByRole('button', { name: '停止研究' })).toHaveLength(1)
    expect(within(toolbar).queryByRole('button', { name: '恢复研究' })).not.toBeInTheDocument()
  })

  it('opens More by keyboard, consumes Escape and retains process state per run', () => {
    publish()
    const view = render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture" />)
    const trigger = screen.getByRole('button', { name: '更多研究选项' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const menu = screen.getByRole('dialog', { name: '研究更多选项' })
    expect(menu.parentElement).toBe(document.body)
    expect(menu.contains(document.activeElement)).toBe(true)
    const stop = vi.fn()
    document.addEventListener('keydown', stop)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    document.removeEventListener('keydown', stop)
    expect(stop).not.toHaveBeenCalled()
    expect(trigger).toHaveFocus()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: '研究过程' }))
    expect(screen.queryByRole('dialog', { name: '研究更多选项' })).not.toBeInTheDocument()
    expect(useResearchWorkspaceStore.getState().byRun.r.processOpen).toBe(true)
    view.unmount()
    render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture" />)
    expect(screen.getByRole('region', { name: '研究运行过程' })).toBeInTheDocument()
    expect(useResearchWorkspaceStore.getState().byRun.other?.processOpen).toBeUndefined()
  })

  it('returns explicitly to the root controller without changing the selected node or writer', () => {
    publish()
    const value = useResearchRunStore.getState().runs.r
    value.graph.nodes.push({ ...value.graph.nodes[0], id: 'branch', kind: 'alt', depth: 1 })
    value.sessions.push({ ...value.sessions[0], executorId: 'branch-lo', nodeId: 'branch' })
    useResearchWorkspaceStore.getState().selectNode('r', 'branch')
    useResearchWorkspaceStore.getState().setSideExecutor('r', 'a')
    const binding = useSessionStore.getState().researchBinding
    render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture" />)
    fireEvent.click(screen.getByRole('button', { name: '返回主控' }))
    expect(useResearchWorkspaceStore.getState().byRun.r).toMatchObject({ selectedNodeId: 'branch', mainExecutorId: 'lo', sideExecutorId: null })
    expect(useSessionStore.getState().researchBinding).toBe(binding)
  })

  it('refreshes an initially unreadable unknown driver through More and exposes the real resume action', async () => {
    publish()
    vi.mocked(request).mockRejectedValue(new Error('first detail offline'))
    const refresh = vi.spyOn(useSessionStore.getState(), 'fetchResearchCardDetails').mockImplementation(async () => {
      useResearchActivityStore.setState({ details: { r: { run: { id: 'r', driving: false }, graph: { nodes: [] } } as never } })
    })
    render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture" />)
    await waitFor(() => expect(request).toHaveBeenCalledWith('get_research_details', expect.objectContaining({ runId: 'r' })))
    expect(screen.queryByRole('button', { name: '恢复研究' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '更多研究选项' }))
    fireEvent.click(screen.getByRole('button', { name: '研究详情' }))
    fireEvent.click(screen.getByRole('button', { name: '刷新研究状态' }))
    expect(await screen.findByRole('button', { name: '恢复研究' })).toBeEnabled()
    expect(useResearchRunStore.getState().runs.r.run.driving).toBeUndefined()
    refresh.mockRestore()
  })

  it('keeps activity refresh failures visible in More even when the activity refresh settles normally', async () => {
    publish()
    const refresh = vi.spyOn(useSessionStore.getState(), 'fetchResearchCardDetails').mockImplementation(async () => {
      useResearchActivityStore.setState({ errors: { 'run:r': 'detail still offline' } })
    })
    render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture" />)
    fireEvent.click(screen.getByRole('button', { name: '更多研究选项' }))
    fireEvent.click(screen.getByRole('button', { name: '研究详情' }))
    fireEvent.click(screen.getByRole('button', { name: '刷新研究状态' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('detail still offline')
    expect(screen.getByRole('button', { name: '刷新研究状态' })).toBeEnabled()
    refresh.mockRestore()
  })

  it('reports a rejected listing refresh in More and keeps both menu and workspace retry paths', async () => {
    publish()
    const refresh = vi.spyOn(useSessionStore.getState(), 'fetchResearchCardDetails').mockResolvedValue(undefined)
    render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture" />)
    vi.mocked(researchSessionsBridge.load).mockRejectedValueOnce(new Error('directory refresh offline'))
    fireEvent.click(screen.getByRole('button', { name: '更多研究选项' }))
    fireEvent.click(screen.getByRole('button', { name: '研究详情' }))
    fireEvent.click(screen.getByRole('button', { name: '刷新研究状态' }))
    const menu = screen.getByRole('dialog', { name: '研究更多选项' })
    expect(await within(menu).findByRole('alert')).toHaveTextContent('directory refresh offline')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    fireEvent.click(within(menu).getByRole('button', { name: '刷新研究状态' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    refresh.mockRestore()
  })
  it('opens in the focus view and switches to the multi-pane grid, remembering the choice', async () => {
    publish()
    const view = render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture" />)
    expect(view.container.querySelector('[data-research-view-mode]')).toHaveAttribute('data-research-view-mode', 'focus')
    // Focus is a conversation: no run banner, no tile grid.
    expect(screen.getByRole('button', { name: /研究团队/ })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '研究运行概览' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '多窗' }))
    await waitFor(() => expect(view.container.querySelector('[data-research-view-mode]'))
      .toHaveAttribute('data-research-view-mode', 'multi'))
    expect(localStorage.getItem(RESEARCH_VIEW_MODE_STORAGE_KEY)).toBe('multi')
    expect(useResearchWorkspaceStore.getState().byRun.r.viewMode).toBe('multi')
    expect(screen.queryByRole('region', { name: '研究运行概览' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '更多研究选项' })).toBeInTheDocument()
    expect(view.container.querySelectorAll('[data-research-workspace-toolbar]')).toHaveLength(1)
    // Both ways back, without losing the run's own state.
    fireEvent.click(screen.getByRole('button', { name: '专注' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /研究团队/ })).toBeInTheDocument())
    expect(localStorage.getItem(RESEARCH_VIEW_MODE_STORAGE_KEY)).toBe('focus')
  })

  it('reopens in the remembered view', () => {
    localStorage.setItem(RESEARCH_VIEW_MODE_STORAGE_KEY, 'multi')
    publish()
    const view = render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture" />)
    expect(view.container.querySelector('[data-research-view-mode]')).toHaveAttribute('data-research-view-mode', 'multi')
  })

  it('renders pending approvals as conversation cards in the workspace too', async () => {
    publish()
    // The activity owner polls the run detail; the cards read that shared copy.
    useResearchActivityStore.setState({ details: { r: {
      run: { id: 'r', status: 'active' },
      graph: { nodes: [{ id: 'node', status: 'awaiting_approval' }], reconciles: [],
        plans: [{ node_id: 'node', round: 1, tool_call_id: 'plan-1', plan: { plan_markdown: 'Two branches' } }] },
    } as never } })
    render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture" />)
    expect(await screen.findByRole('button', { name: '同意' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '稍后' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '还需修改' })).toBeInTheDocument()
    expect(screen.getByText('Two branches')).toBeInTheDocument()
  })

  it('shows the interrupted banner and resume entry for an active run without a driver', () => {
    const sessions = publish()
    useResearchRunStore.setState({ runs: { r: { ...useResearchRunStore.getState().runs.r,
      run: { ...useResearchRunStore.getState().runs.r.run, driving: false } } } })
    render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture" />)
    expect(screen.getByRole('status', { name: '研究执行已中断' })).toBeInTheDocument()
    expect(screen.getByText('研究执行已中断，可恢复')).toBeInTheDocument()
    // Exactly one resume entry in the focus bar; the notice only points at it.
    expect(screen.getAllByRole('button', { name: '恢复研究' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: '恢复研究' })).toBeEnabled()
    expect(sessions).toHaveLength(2)
  })

  it('never offers resume while the run still has a live driver', () => {
    publish()
    useResearchRunStore.setState({ runs: { r: { ...useResearchRunStore.getState().runs.r,
      run: { ...useResearchRunStore.getState().runs.r.run, driving: true } } } })
    render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture" />)
    expect(screen.queryByRole('status', { name: '研究执行已中断' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复研究' })).not.toBeInTheDocument()
  })

  it('subscribes only the two focus transcripts, and the side viewer when it is open', async () => {
    publish()
    const view = render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture" />)
    expect(vi.mocked(researchSessionsBridge.watch)).toHaveBeenLastCalledWith('r', ['lo'], 'C:/fixture')
    act(() => useResearchWorkspaceStore.getState().setSideExecutor('r', 'a'))
    await waitFor(() => expect(vi.mocked(researchSessionsBridge.watch)).toHaveBeenLastCalledWith('r', ['lo', 'a'], 'C:/fixture'))
    expect(view.container.querySelector('[data-research-view-mode]')).toHaveAttribute('data-research-view-mode', 'focus')
  })

  it('shows a side viewer without dropping the main transcript subscription', () => {
    publish()
    useResearchWorkspaceStore.getState().setSideExecutor('r', 'a')
    render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture" />)
    expect(screen.getByRole('complementary', { name: 'a 侧栏' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /研究团队/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /研究团队/ })).toHaveAccessibleName(/当前主控/)
  })
})
