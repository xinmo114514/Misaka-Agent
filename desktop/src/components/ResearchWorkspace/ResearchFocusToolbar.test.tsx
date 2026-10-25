import { beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ResearchFocusToolbar } from './ResearchFocusToolbar'
import { useResearchWorkspaceStore } from '../../store/useResearchWorkspaceStore'
import { useResearchActivityStore } from '../../lib/researchActivityStore'
import { useResearchResumeStore } from '../../store/useResearchResumeStore'
import type { ResearchSessionDescriptor, ResearchSessionsPayload } from '../../types/research'
import type { ResearchViewMode } from '../../lib/researchViewMode'

const listing: ResearchSessionsPayload = { runId: 'research-B', run: { id: 'research-B', question: 'The real research question', workspace: 'C:/B', status: 'active', phase: 'cards', driving: true, nodes: 2, tasks: 0 },
  graph: { run: 'research-B', question: 'The real research question', status: 'active', phase: 'cards', nodes: [
    { id: 'root', question: 'Root question', kind: 'root', depth: 0, status: 'active', parents: [], children: ['branch'] },
    { id: 'branch', question: 'Branch question', kind: 'alt', depth: 1, status: 'active', parents: ['root'], children: [] },
  ] }, sessions: [], suspension: null, suspensions: [] }
const open = (integrated = true, mode: ResearchViewMode = 'focus') => {
  const handlers = { onModeChange: vi.fn(), onSelectNode: vi.fn(), onGraph: vi.fn(), onRefresh: vi.fn().mockResolvedValue(undefined) }
  const chrome = { currentWorkspace: 'C:/B', recentWorkspaces: ['C:/A', 'C:/B'], onSwitchWorkspace: vi.fn(), onOpenWorkspaceDialog: vi.fn(), onOpenSettings: vi.fn() }
  const view = render(<ResearchFocusToolbar runId="research-B" workspace="C:/B" listing={listing} node={listing.graph.nodes[0]} nodeId="root" mode={mode} {...handlers} chromeActions={integrated ? chrome : undefined} />)
  const more = () => { fireEvent.click(screen.getByRole('button', { name: '更多研究选项' })); return screen.getByRole('dialog', { name: '研究更多选项' }) }
  return { ...handlers, chrome, more, view }
}
beforeEach(() => { useResearchWorkspaceStore.setState({ byRun: {} }); useResearchActivityStore.setState({ details: {}, errors: {} }); useResearchResumeStore.setState({ byRun: {} }) })

it('keeps a direct unconfirmed-resume refresh and shows its failure without losing retry', async () => {
  useResearchResumeStore.getState().unconfirm('research-B')
  const item = open()
  item.onRefresh.mockRejectedValueOnce(new Error('direct verification offline'))
  expect(screen.getByRole('button', { name: '结果待确认' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('direct verification offline')
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(item.onRefresh).toHaveBeenCalledTimes(2)
})

it('resets More across runs and fences a delayed A error while B performs its own refresh', async () => {
  let rejectA!: (cause: Error) => void
  let resolveB!: () => void
  const refreshA = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectA = reject }))
  const refreshB = vi.fn(() => new Promise<void>(resolve => { resolveB = resolve }))
  const props = { workspace: 'C:/B', nodeId: 'root', mode: 'focus' as const, onModeChange: vi.fn(), onSelectNode: vi.fn(), onGraph: vi.fn() }
  const view = render(<ResearchFocusToolbar {...props} runId="A" listing={{ ...listing, runId: 'A', run: { ...listing.run, id: 'A' } }} onRefresh={refreshA} />)
  fireEvent.click(screen.getByRole('button', { name: '更多研究选项' }))
  fireEvent.click(screen.getByRole('button', { name: '研究详情' }))
  fireEvent.click(screen.getByRole('button', { name: '刷新研究状态' }))
  view.rerender(<ResearchFocusToolbar {...props} runId="research-B" listing={listing} onRefresh={refreshB} />)
  expect(screen.queryByRole('dialog', { name: '研究更多选项' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '更多研究选项' }))
  expect(screen.getByRole('button', { name: '研究过程' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '研究详情' }))
  fireEvent.click(screen.getByRole('button', { name: '刷新研究状态' }))
  await act(async () => rejectA(new Error('A refresh failure')))
  expect(screen.queryByText(/A refresh failure/)).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '正在刷新…' })).toBeDisabled()
  await act(async () => resolveB())
  expect(screen.getByRole('button', { name: '刷新研究状态' })).toBeEnabled()
})

it('offers the full question through a keyboard-visible disclosure in Details', () => {
  const item = open()
  const menu = item.more()
  fireEvent.click(within(menu).getByRole('button', { name: '研究详情' }))
  const summary = within(menu).getByText('研究问题')
  expect(summary.tagName).toBe('SUMMARY')
  expect(summary.closest('details')).not.toHaveAttribute('open')
  fireEvent.click(summary)
  expect(summary.closest('details')).toHaveAttribute('open')
  expect(within(menu).getByText(listing.run.question)).toBeVisible()
})

it('keeps view switching direct and orders the remaining More actions without ordinary actions', () => {
  const item = open()
  fireEvent.click(within(screen.getByRole('group', { name: '研究视图' })).getByRole('button', { name: '多窗' }))
  expect(item.onModeChange).toHaveBeenCalledWith('multi')
  let menu = item.more()
  expect(within(menu).getAllByRole('button').map(button => button.textContent)).toEqual(['研究过程', '当前节点', '研究图谱', '切换工作区', '模型与设置', '研究详情'])
  fireEvent.keyDown(menu, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  menu = item.more()
  fireEvent.click(within(menu).getByRole('button', { name: '当前节点' }))
  fireEvent.click(within(menu).getByRole('button', { name: 'Branch question' }))
  expect(item.onSelectNode).toHaveBeenCalledWith('branch')
  menu = item.more()
  fireEvent.click(within(menu).getByRole('button', { name: '研究图谱' }))
  expect(item.onGraph).toHaveBeenCalledOnce()
  menu = item.more()
  fireEvent.click(within(menu).getByRole('button', { name: '切换工作区' }))
  fireEvent.click(within(menu).getByRole('button', { name: 'A' }))
  expect(item.chrome.onSwitchWorkspace).toHaveBeenCalledWith('C:/A')
  menu = item.more()
  fireEvent.click(within(menu).getByRole('button', { name: '切换工作区' }))
  fireEvent.click(within(menu).getByRole('button', { name: '打开目录…' }))
  expect(item.chrome.onOpenWorkspaceDialog).toHaveBeenCalledOnce()
  menu = item.more()
  fireEvent.click(within(menu).getByRole('button', { name: '模型与设置' }))
  expect(item.chrome.onOpenSettings).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: '更多研究选项' })).toHaveFocus()
})

it('supports an internal Back path and omits optional chrome actions in standalone workspaces', () => {
  const item = open(false)
  const menu = item.more()
  expect(within(menu).queryByRole('button', { name: '切换工作区' })).not.toBeInTheDocument()
  fireEvent.click(within(menu).getByRole('button', { name: '当前节点' }))
  expect(within(menu).getByRole('button', { name: '返回研究选项' })).toHaveFocus()
  fireEvent.click(within(menu).getByRole('button', { name: '返回研究选项' }))
  expect(within(menu).getByRole('button', { name: '研究过程' })).toHaveFocus()
})

it('shows a refresh failure and retains a deliberate retry in the details subview', async () => {
  const item = open()
  item.onRefresh.mockRejectedValueOnce(new Error('detail offline'))
  const menu = item.more()
  fireEvent.click(within(menu).getByRole('button', { name: '研究详情' }))
  fireEvent.click(within(menu).getByRole('button', { name: '刷新研究状态' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('detail offline')
  fireEvent.click(within(menu).getByRole('button', { name: '刷新研究状态' }))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(item.onRefresh).toHaveBeenCalledTimes(2)
  act(() => useResearchWorkspaceStore.getState().setProcessOpen('other', true))
  expect(useResearchWorkspaceStore.getState().byRun['research-B']?.processOpen).toBeUndefined()
})

it.each(['focus', 'multi'] as const)('exposes the shared %s toolbar and selected view before a listing arrives', mode => {
  const onModeChange = vi.fn()
  render(<ResearchFocusToolbar runId="loading" workspace="C:/B" nodeId={null} mode={mode} onModeChange={onModeChange}
    onSelectNode={vi.fn()} onGraph={vi.fn()} onRefresh={async () => {}} />)
  const header = screen.getByRole('banner')
  expect(header).toHaveAttribute('data-research-workspace-toolbar')
  if (mode === 'focus') expect(header).toHaveAttribute('data-research-focus-toolbar')
  else expect(header).not.toHaveAttribute('data-research-focus-toolbar')
  expect(screen.getByRole('button', { name: '研究团队：读取中' })).toBeDisabled()
  const group = screen.getByRole('group', { name: '研究视图' })
  expect(within(group).getByRole('button', { name: '专注' })).toHaveAttribute('aria-pressed', String(mode === 'focus'))
  expect(within(group).getByRole('button', { name: '多窗' })).toHaveAttribute('aria-pressed', String(mode === 'multi'))
  fireEvent.click(within(group).getByRole('button', { name: mode === 'focus' ? '多窗' : '专注' }))
  expect(onModeChange).toHaveBeenCalledWith(mode === 'focus' ? 'multi' : 'focus')
  fireEvent.click(screen.getByRole('button', { name: '更多研究选项' }))
  fireEvent.click(screen.getByRole('button', { name: '研究过程' }))
  expect(useResearchWorkspaceStore.getState().byRun.loading.processOpen).toBe(true)
})

it.each(['focus', 'multi'] as const)('keeps team, run control, view group and More in order in %s', mode => {
  open(true, mode)
  const header = screen.getByRole('banner')
  const team = within(header).getByRole('button', { name: /研究团队/ })
  const stop = within(header).getByRole('button', { name: '停止研究' })
  const group = within(header).getByRole('group', { name: '研究视图' })
  const more = within(header).getByRole('button', { name: '更多研究选项' })
  expect(team.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(stop.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(group.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

const member = (executorId: string, role: 'last_order' | 'sister', nodeId: string, extra: Partial<ResearchSessionDescriptor> = {}): ResearchSessionDescriptor => ({
  executorId, sessionId: executorId, sessionFile: null, nodeId, taskId: executorId, role, label: executorId,
  workspace: 'C:/B', status: 'done', generation: 1, attempt: 1, startedAt: 1, endedAt: 2, error: null, ...extra,
})
const teamListing: ResearchSessionsPayload = { ...listing, sessions: [
  member('branch-lo', 'last_order', 'branch'), member('root-lo', 'last_order', 'root'),
  member('current', 'sister', 'branch', { taskId: 'task', generation: 2 }),
  member('history', 'sister', 'branch', { taskId: 'task', isCurrent: false }),
] }
function openMultiTeam(value = teamListing, nodeId = 'branch') {
  return render(<ResearchFocusToolbar runId="research-B" workspace="C:/B" listing={value} nodeId={nodeId} mode="multi"
    onModeChange={vi.fn()} onSelectNode={vi.fn()} onGraph={vi.fn()} onRefresh={async () => {}} />)
}
function directory() {
  fireEvent.click(screen.getByRole('button', { name: /研究团队/ }))
  return screen.getByRole('dialog', { name: '研究团队目录' })
}

it('navigates multi members and their history with node and MRU semantics, keeping focus readers intact', () => {
  const store = useResearchWorkspaceStore.getState()
  store.setMainExecutor('research-B', 'root-lo'); store.setSideExecutor('research-B', 'history')
  openMultiTeam()
  let menu = directory()
  expect(within(menu).queryAllByRole('button', { name: /在右侧查看/ })).toHaveLength(0)
  fireEvent.click(within(menu).getByTestId('research-team-member-current'))
  expect(useResearchWorkspaceStore.getState().byRun['research-B']).toMatchObject({
    selectedNodeId: 'branch', focusedExecutorId: 'current', pinnedExecutorIds: ['current'], mainExecutorId: 'root-lo', sideExecutorId: 'history',
  })
  expect(screen.getByRole('button', { name: /研究团队/ })).toHaveAccessibleName(/当前current/)
  menu = directory()
  fireEvent.click(within(menu).getByText('历史代次 1'))
  fireEvent.click(within(menu).getByRole('button', { name: /history/ }))
  expect(useResearchWorkspaceStore.getState().byRun['research-B']).toMatchObject({
    selectedNodeId: 'branch', focusedExecutorId: 'history', pinnedExecutorIds: ['history', 'current'], mainExecutorId: 'root-lo', sideExecutorId: 'history',
  })
})

it('returns multi to the actual root descriptor even when a branch coordinator is listed first', () => {
  useResearchWorkspaceStore.getState().focusExecutor('research-B', teamListing.sessions[2])
  useResearchWorkspaceStore.getState().setMainExecutor('research-B', 'history')
  useResearchWorkspaceStore.getState().setSideExecutor('research-B', 'current')
  openMultiTeam()
  fireEvent.click(within(directory()).getByRole('button', { name: '返回主控会话' }))
  expect(useResearchWorkspaceStore.getState().byRun['research-B']).toMatchObject({
    selectedNodeId: 'root', focusedExecutorId: 'root-lo', pinnedExecutorIds: ['current'], mainExecutorId: 'history', sideExecutorId: 'current',
  })
})

it('uses the selected multi node identity instead of an unrelated remembered focus reader or focus target', () => {
  useResearchWorkspaceStore.getState().setMainExecutor('research-B', 'root-lo')
  useResearchWorkspaceStore.getState().focusExecutor('research-B', teamListing.sessions[1])
  openMultiTeam()
  expect(screen.getByRole('button', { name: /研究团队/ })).toHaveAccessibleName(/当前branch-lo/)
  expect(within(directory()).getByTestId('research-team-member-branch-lo')).toHaveAttribute('aria-current', 'true')
})

it('uses a real local member as multi identity when that node has no coordinator', () => {
  openMultiTeam({ ...teamListing, sessions: teamListing.sessions.filter(item => item.executorId !== 'branch-lo') })
  expect(screen.getByRole('button', { name: /研究团队/ })).toHaveAccessibleName(/当前current/)
})
