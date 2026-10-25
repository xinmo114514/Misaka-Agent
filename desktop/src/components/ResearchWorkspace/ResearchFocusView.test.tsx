import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { ResearchFocusView } from './ResearchFocusView'
import { ResearchFocusToolbar } from './ResearchFocusToolbar'
import { ResearchViewSwitch } from './ResearchViewSwitch'
import { useResearchSessionsStore } from '../../store/useResearchSessionsStore'
import { useResearchWorkspaceStore } from '../../store/useResearchWorkspaceStore'
import { useSessionStore } from '../../store/useSessionStore'
import { readResearchViewMode, RESEARCH_VIEW_MODE_STORAGE_KEY, saveResearchViewMode } from '../../lib/researchViewMode'
import type { ResearchSessionDescriptor, ResearchSessionsPayload } from '../../types/research'

vi.mock('../../lib/researchSessionsBridge', () => ({ researchSessionsBridge: {
  load: vi.fn().mockResolvedValue(null), history: vi.fn().mockResolvedValue(null), watch: vi.fn().mockResolvedValue(null),
  unwatch: vi.fn().mockResolvedValue(null), listen: vi.fn(() => () => {}), content: vi.fn(),
} }))
vi.mock('../../lib/researchActivityStore', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/researchActivityStore')>(),
  subscribeResearchRun: vi.fn(() => () => {}),
}))
const card = (id: string, role: 'last_order' | 'sister', status = 'running', extra: Partial<ResearchSessionDescriptor> = {}): ResearchSessionDescriptor => ({
  executorId: id, sessionId: id, sessionFile: null, nodeId: 'node', taskId: id, role,
  label: id, workspace: 'C:/fixture', status, generation: 1, attempt: 1,
  startedAt: 100, endedAt: null, error: null, ...extra,
})
const listing = (sessions: ResearchSessionDescriptor[]): ResearchSessionsPayload => ({
  runId: 'r', run: { id: 'r', question: 'Q', workspace: 'C:/fixture', status: 'active', phase: 'cards', nodes: 1, tasks: sessions.length },
  graph: { run: 'r', question: 'Q', status: 'active', phase: 'cards', nodes: [{ id: 'node', question: 'Q', depth: 0, status: 'active', kind: 'root', parents: [], children: [] }] },
  sessions, suspension: null, suspensions: [],
})
const open = (sessions: ResearchSessionDescriptor[]) => render(<><ResearchFocusToolbar runId="r" workspace="C:/fixture" listing={listing(sessions)} nodeId="node" mode="focus" onModeChange={vi.fn()} onSelectNode={vi.fn()} onGraph={vi.fn()} onRefresh={vi.fn()} /><ResearchFocusView runId="r" workspace="C:/fixture"
  listing={listing(sessions)} nodeId="node" /></>)
const history = (executorId: string, content: string) => useResearchSessionsStore.getState().applyHistory({
  runId: 'r', executorId, messages: [{ id: `${executorId}-1`, role: 'assistant', content, timestamp: 1 }],
  nextCursor: null, hasMore: false, availability: 'available', historyVersion: 'v1',
})

beforeEach(() => {
  localStorage.clear()
  useResearchWorkspaceStore.setState({ byRun: {} })
  useResearchSessionsStore.setState({ byExecutor: {} })
})

describe('research view mode preference', () => {
  it('defaults to the focus view and remembers the multi-pane choice', () => {
    expect(readResearchViewMode()).toBe('focus')
    saveResearchViewMode('multi')
    expect(localStorage.getItem(RESEARCH_VIEW_MODE_STORAGE_KEY)).toBe('multi')
    expect(readResearchViewMode()).toBe('multi')
    saveResearchViewMode('focus')
    expect(readResearchViewMode()).toBe('focus')
  })
})

describe('ResearchViewSwitch', () => {
  it('marks the current view and reports the user choice', () => {
    const change = vi.fn()
    render(<ResearchViewSwitch mode="focus" onChange={change} />)
    expect(screen.getByRole('button', { name: '专注' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '多窗' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByRole('button', { name: '多窗' }))
    expect(change).toHaveBeenCalledWith('multi')
  })
})

describe('ResearchFocusView', () => {
  it('reads the controller as an ordinary conversation, without a run banner or a team column', () => {
    const sessions = [card('lo', 'last_order'), card('a', 'sister')]
    useResearchSessionsStore.getState().upsertDescriptors('r', sessions)
    history('lo', 'Controller reasoning')
    open(sessions)
    expect(screen.getByText('Controller reasoning')).toBeInTheDocument()
    // The structure lives in the header pill and the 研究 menu, never above the transcript.
    expect(screen.queryByRole('region', { name: '研究运行概览' })).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: '智能体团队' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('research-pane-lo')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /研究团队/ })).toHaveAccessibleName(/当前主控/)
  })

  it('reads a sub-agent in the main area with a breadcrumb and a way back to the controller', () => {
    const sessions = [card('lo', 'last_order'), card('a', 'sister')]
    useResearchSessionsStore.getState().upsertDescriptors('r', sessions)
    history('lo', 'Controller reasoning')
    history('a', 'A output')
    open(sessions)
    // Browsing is a reading choice held in the store, never a rebind of the research conversation.
    act(() => useResearchWorkspaceStore.getState().setMainExecutor('r', 'a'))
    expect(screen.getByText('A output')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /研究团队/ })).toHaveTextContent('a')
    // A sub-agent transcript is evidence: it offers no input, only a pointer at the writer.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('子代理会话只读。需要补充或调整时，请在对话中向主控代理提出。')
    fireEvent.click(screen.getByRole('button', { name: '返回主控' }))
    expect(useResearchWorkspaceStore.getState().byRun.r.mainExecutorId).toBe('lo')
    expect(screen.getByText('Controller reasoning')).toBeInTheDocument()
  })

  it('reads a second session beside the first without replacing the main area', () => {
    const sessions = [card('lo', 'last_order'), card('a', 'sister')]
    useResearchSessionsStore.getState().upsertDescriptors('r', sessions)
    history('lo', 'Controller reasoning')
    history('a', 'A output')
    useResearchWorkspaceStore.getState().setSideExecutor('r', 'a')
    open(sessions)
    const panel = screen.getByRole('complementary', { name: 'a 侧栏' })
    expect(within(panel).getByText('A output')).toBeInTheDocument()
    // The main area still reads the controller: the panel is a viewer, not a navigation.
    expect(screen.getByText('Controller reasoning')).toBeInTheDocument()
    expect(useResearchWorkspaceStore.getState().byRun.r.mainExecutorId).toBeUndefined()
    fireEvent.click(within(panel).getByRole('button', { name: '在主区域打开' }))
    expect(useResearchWorkspaceStore.getState().byRun.r.mainExecutorId).toBe('a')
    expect(useResearchWorkspaceStore.getState().byRun.r.sideExecutorId).toBeNull()
  })

  it('closes the side viewer and offers no second one', () => {
    const sessions = [card('lo', 'last_order'), card('a', 'sister')]
    useResearchSessionsStore.getState().upsertDescriptors('r', sessions)
    useResearchWorkspaceStore.getState().setSideExecutor('r', 'a')
    open(sessions)
    fireEvent.click(screen.getByRole('button', { name: '关闭侧栏会话' }))
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(useResearchWorkspaceStore.getState().byRun.r.sideExecutorId).toBeNull()
  })

  it('keeps layout choices direct while process stays folded behind More', () => {
    const sessions = [card('lo', 'last_order'), card('a', 'sister')]
    useResearchSessionsStore.getState().upsertDescriptors('r', sessions)
    open(sessions)
    const views = screen.getByRole('group', { name: '研究视图' })
    expect(within(views).getByRole('button', { name: '专注' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(views).getByRole('button', { name: '多窗' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('region', { name: '研究运行过程' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '更多研究选项' }))
    const menu = screen.getByRole('dialog', { name: '研究更多选项' })
    expect(within(menu).queryByRole('button', { name: '切换多窗' })).not.toBeInTheDocument()
    fireEvent.click(within(menu).getByRole('button', { name: '研究过程' }))
    expect(screen.getByRole('region', { name: '研究运行过程' })).toBeInTheDocument()
  })
})

describe('ResearchRunPanel', () => {
  const seedCard = (status: string, tasks: Array<{ id: string; title: string; status: string; assignee: string }>) => {
    useSessionStore.setState({ researchCards: { r: {
      run_id: 'r', question: '比较两条证据路线', status, phase: 'reconciling', workspace: 'C:/fixture',
      tasks: tasks.map(task => ({ ...task, nodeId: 'node', kind: 'research' })),
    } as never } })
  }

  beforeEach(() => {
    useSessionStore.setState({ researchCards: {}, researchTeam: null, activeResearchTaskId: null })
  })

  it('stays folded until asked, then lists the run tasks and opens one', () => {
    seedCard('active', [{ id: 't1', title: '检索召回与引用可追溯性', status: 'running', assignee: 'sister' }])
    open([card('lo', 'last_order')])
    expect(screen.queryByRole('region', { name: '研究运行过程' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '更多研究选项' }))
    fireEvent.click(screen.getByRole('button', { name: '研究过程' }))
    const panel = screen.getByRole('region', { name: '研究运行过程' })
    expect(panel).toHaveTextContent('正在进行研究')
    expect(panel).toHaveTextContent('协同任务与专家分工')
    fireEvent.click(within(panel).getByRole('button', { name: '查看任务 检索召回与引用可追溯性' }))
    expect(useSessionStore.getState().activeResearchTaskId).toMatchObject({ runId: 'r', taskId: 't1' })
  })

  it('closes without touching what is being read', () => {
    seedCard('active', [])
    useResearchSessionsStore.getState().upsertDescriptors('r', [card('lo', 'last_order')])
    history('lo', 'Controller reasoning')
    open([card('lo', 'last_order')])
    fireEvent.click(screen.getByRole('button', { name: '更多研究选项' }))
    fireEvent.click(screen.getByRole('button', { name: '研究过程' }))
    fireEvent.click(screen.getByRole('button', { name: '收起运行过程' }))
    expect(screen.queryByRole('region', { name: '研究运行过程' })).not.toBeInTheDocument()
    expect(screen.getByText('Controller reasoning')).toBeInTheDocument()
  })

  it('names the state the timeline used to announce, including a stopped run', () => {
    seedCard('waiting_input', [])
    open([card('lo', 'last_order')])
    fireEvent.click(screen.getByRole('button', { name: '更多研究选项' }))
    fireEvent.click(screen.getByRole('button', { name: '研究过程' }))
    expect(screen.getByRole('region', { name: '研究运行过程' })).toHaveTextContent('研究等待澄清')
    act(() => seedCard('stopped', []))
    expect(screen.getByRole('region', { name: '研究运行过程' })).toHaveTextContent('研究已暂停')
  })
})
