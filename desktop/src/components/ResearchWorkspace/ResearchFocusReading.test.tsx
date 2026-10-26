import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { ResearchFocusView } from './ResearchFocusView'
import { ResearchFocusToolbar } from './ResearchFocusToolbar'
import { ResearchTranscript } from './ResearchTranscript'
import { Composer } from '../Composer/Composer'
import { ResearchHistoryDialog } from '../Timeline/ResearchHistoryDialog'
import { ResearchGraphModal } from '../Timeline/ResearchGraphModal'
import { CloseConfirmDialog } from '../CloseConfirmDialog'
import { SessionRenameDialog } from '../SessionRenameDialog'
import { SessionDeleteDialog } from '../SessionDeleteDialog'
import { CompactDialog } from '../SessionTree/CompactDialog'
import { PermissionDialog } from '../Permission/PermissionDialog'
import { useSessionStore } from '../../store/useSessionStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useResearchSessionsStore } from '../../store/useResearchSessionsStore'
import { useResearchWorkspaceStore } from '../../store/useResearchWorkspaceStore'
import { savePosition, forgetSessionView } from '../../lib/sessionViewState'
import { researchSurfaceKey } from '../Timeline/ChatSurface'
import type { ResearchSessionDescriptor, ResearchSessionsPayload } from '../../types/research'

vi.mock('../../lib/researchSessionsBridge', () => ({ researchSessionsBridge: { content: vi.fn(), history: vi.fn() } }))
vi.mock('../../lib/researchActivityStore', async original => ({ ...await original<typeof import('../../lib/researchActivityStore')>(), subscribeResearchRun: () => () => {}, subscribeResearchHistory: () => () => {} }))
vi.mock('../ResearchGraph/ResearchGraphCanvas', () => ({ ResearchGraphCanvas: () => <div>graph content</div> }))
const stop = vi.fn()
const member = (id: string, role: 'last_order' | 'sister'): ResearchSessionDescriptor => ({ executorId: id, sessionId: id, sessionFile: null, taskId: id, nodeId: 'root', role, label: id, workspace: '/fixture', status: 'running', generation: 1, attempt: 1, startedAt: 1, endedAt: null, error: null })
const listing: ResearchSessionsPayload = { runId: 'r', run: { id: 'r', question: 'topic', workspace: '/fixture', status: 'active', phase: 'cards', driving: true, nodes: 1, tasks: 1 }, graph: { run: 'r', question: 'topic', status: 'active', phase: 'cards', nodes: [{ id: 'root', question: 'topic', depth: 0, kind: 'root', status: 'active', parents: [], children: [], cards: [{ id: 'task', title: 'Evidence task', status: 'running' }] }] }, sessions: [member('lo', 'last_order'), member('a', 'sister'), member('b', 'sister')], suspension: null, suspensions: [] }
let width = 1100
let observers: ResizeObserverCallback[] = []
function resize(next: number) { width = next; act(() => observers.forEach(callback => callback([], {} as ResizeObserver))) }
function open() {
  return render(<div data-conversation-viewport data-research-view-mode="focus"><ResearchFocusToolbar runId="r" workspace="/fixture" listing={listing} nodeId="root" mode="focus" onModeChange={vi.fn()} onSelectNode={vi.fn()} onGraph={vi.fn()} onRefresh={async () => {}} /><ResearchFocusView runId="r" workspace="/fixture" listing={listing} nodeId="root" /><Composer /><ResearchHistoryDialog /><ResearchGraphModal /></div>)
}
function side() { fireEvent.click(screen.getByRole('button', { name: /研究团队/ })); fireEvent.click(screen.getByRole('button', { name: '在右侧查看 a' })) }
function process() { act(() => useResearchWorkspaceStore.getState().setProcessOpen('r', true)) }
beforeEach(() => {
  width = 1100; observers = []; stop.mockReset()
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { observers.push(callback) } observe() {} disconnect() {} unobserve() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return { width: this.hasAttribute('data-conversation-viewport') ? width : 500, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON() {} } })
  useResearchWorkspaceStore.setState({ byRun: {} }); useResearchSessionsStore.setState({ byExecutor: {} })
  useResearchSessionsStore.getState().upsertDescriptors('r', listing.sessions)
  useSessionStore.setState({ agentMode: 'research', researchPageView: 'conversation', draft: 'unsubmitted draft', researchBinding: { runId: 'r', sessionId: 'root-session', sessionFile: '/root', workspace: '/fixture' } as never, researchConversation: { messages: [], isStreaming: true, isAborting: false, isIdle: false, stats: {}, contextUsage: null } as never, researchCards: {}, researchTeam: null, researchRuns: [], requestResearchStop: stop, isSessionLoading: false, sessionLoadError: null, activeResearchGraphRunId: null, researchHistoryOpen: false })
  useSettingsStore.setState({ currentModel: { provider: 'test', modelId: 'model', name: 'Model', thinking: 'off' }, models: [] })
  useSessionStore.setState({ sessionDeletion: null, pendingPermissionRequest: null })
})
afterEach(() => { vi.unstubAllGlobals(); for (const id of ['lo', 'a', 'b']) for (const area of ['main', 'side'] as const) forgetSessionView(researchSurfaceKey('r', id, area)) })
it('puts real task actions before a folded role disclosure and connects process controls to its id', () => {
  open(); fireEvent.click(screen.getByRole('button', { name: '更多研究选项' })); const control = screen.getByRole('button', { name: '研究过程' }); expect(control).not.toHaveAttribute('aria-controls'); fireEvent.click(control)
  const panel = screen.getByRole('region', { name: '研究运行过程' }); const details = panel.querySelector('details[data-research-role-details]')!
  expect(details).not.toBeNull(); expect(details).not.toHaveAttribute('open'); expect(details.querySelector('summary')).toHaveTextContent('团队与角色')
  expect(screen.getByRole('button', { name: '查看任务 Evidence task' }).compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '更多研究选项' })); expect(document.getElementById(screen.getByRole('button', { name: '研究过程' }).getAttribute('aria-controls')!)).toBe(panel)
})
it('reveals role retention deliberately after ending a stopped run', () => {
  useSessionStore.setState({ researchCards: { r: { status: 'stopped', tasks: [] } as never }, researchTeam: { teamId: 'team', members: [{ id: 'role', name: 'Researcher', kind: 'task_agent', status: 'done', responsibility: 'evidence' }] } as never })
  open(); process(); fireEvent.click(screen.getByText('团队与角色'))
  fireEvent.click(screen.getByRole('button', { name: '结束本次研究并选择保留角色' }))
  expect(screen.getByRole('checkbox', { name: '保留 Researcher' })).toBeVisible()
})
it('keeps process controls reachable before a readable session has been created', () => {
  const empty = { ...listing, sessions: [] }
  render(<div data-conversation-viewport>
    <ResearchFocusToolbar runId="r" workspace="/fixture" listing={empty} nodeId="root"
      mode="focus" onModeChange={vi.fn()} onSelectNode={vi.fn()} onGraph={vi.fn()} onRefresh={async () => {}} />
    <ResearchFocusView runId="r" workspace="/fixture" listing={empty} nodeId="root" />
  </div>)
  fireEvent.click(screen.getByRole('button', { name: '更多研究选项' }))
  fireEvent.click(screen.getByRole('button', { name: '研究过程' }))
  expect(screen.getByRole('region', { name: '研究运行过程' })).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('正在等待可查看的会话')
})
it('routes actual Composer Escape through menu, side and process before stopping, and ignores IME', () => {
  open(); process(); side(); const input = screen.getByRole('textbox'); expect(input).toHaveValue('unsubmitted draft')
  for (const name of ['更多研究选项', '研究团队：3 个成员，当前主控', '模型与思考深度', '停止研究']) {
    fireEvent.click(screen.getByRole('button', { name }))
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape', isComposing: true }); expect(dialog).toBeInTheDocument()
    fireEvent.keyDown(dialog, { key: 'Escape' }); expect(dialog).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'a 侧栏' })).toBeInTheDocument(); expect(screen.getByTestId('research-run-panel')).toBeInTheDocument(); expect(stop).not.toHaveBeenCalled()
  }
  fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: 'Escape' }); expect(screen.getByRole('complementary')).toBeInTheDocument(); fireEvent.compositionEnd(input)
  fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByRole('complementary')).not.toBeInTheDocument(); expect(screen.getByTestId('research-run-panel')).toBeInTheDocument(); expect(stop).not.toHaveBeenCalled()
  fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByTestId('research-run-panel')).not.toBeInTheDocument(); expect(stop).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Escape' }); expect(stop).toHaveBeenCalledOnce(); expect(screen.getByRole('textbox')).toBe(input); expect(input).toHaveValue('unsubmitted draft')
})
it.each(['history', 'graph'])('keeps side/process behind the active %s dialog on Escape', kind => {
  open(); process(); side(); act(() => kind === 'history' ? useSessionStore.getState().setResearchHistoryOpen(true) : useSessionStore.getState().setActiveResearchGraphRunId('r'))
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.getByRole('complementary')).toBeInTheDocument(); expect(screen.getByTestId('research-run-panel')).toBeInTheDocument(); expect(stop).not.toHaveBeenCalled()
})
it.each(['graph', 'history', 'model', 'more'])('preserves foreground %s ownership when a wide side reader becomes narrow', kind => {
  open(); side()
  if (kind === 'graph') act(() => useSessionStore.getState().setActiveResearchGraphRunId('r'))
  else if (kind === 'history') act(() => useSessionStore.getState().setResearchHistoryOpen(true))
  else fireEvent.click(screen.getByRole('button', { name: kind === 'model' ? '模型与思考深度' : '更多研究选项' }))
  const foreground = screen.getByRole('dialog')
  resize(700)
  expect(foreground).toBeInTheDocument()
  expect(foreground.closest('[inert]')).toBeNull()
  expect(screen.getByRole('complementary', { name: 'a 侧栏' })).not.toHaveAttribute('aria-modal')
  fireEvent.keyDown(foreground, { key: 'Escape' })
  expect(foreground).not.toBeInTheDocument()
  const drawer = screen.getByRole('dialog', { name: 'a 侧栏' })
  expect(drawer).toHaveAttribute('aria-modal', 'true')
  fireEvent.keyDown(drawer, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(stop).not.toHaveBeenCalled()
})
it.each(['close', 'rename', 'delete', 'compact', 'permission'])('keeps the existing %s dialog operable above a resized side reader', kind => {
  open(); side()
  const dismiss = vi.fn()
  if (kind === 'delete') act(() => useSessionStore.setState({ sessionDeletion: { path: '/fixture/history.jsonl', requestId: null, status: 'confirm' } }))
  if (kind === 'permission') act(() => useSessionStore.setState({ pendingPermissionRequest: { requestId: 'permission', toolName: 'read', toolInput: { path: '/fixture/evidence.md' }, reason: 'Confirm tool access', agentId: 'root' } }))
  const modal = kind === 'close' ? render(<CloseConfirmDialog open onClose={dismiss} />)
    : kind === 'rename' ? render(<SessionRenameDialog open path="/fixture/history.jsonl" name="History" onClose={dismiss} onRename={async () => {}} />)
      : kind === 'delete' ? render(<SessionDeleteDialog />)
        : kind === 'compact' ? render(<CompactDialog open busy={false} status={{ state: 'idle' }} messageCount={10} initialInstructions={null} onConfirm={vi.fn()} onCancelOperation={vi.fn()} onClose={dismiss} />)
          : render(<PermissionDialog />)
  const foreground = kind === 'permission' ? screen.getByText('操作审批请求').closest('.misaka-glass-popover')!
    : screen.getByRole(kind === 'close' || kind === 'delete' ? 'alertdialog' : 'dialog')
  resize(700)
  expect(foreground.closest('[inert]')).toBeNull()
  expect(screen.getByRole('complementary', { name: 'a 侧栏' })).toBeInTheDocument()
  fireEvent.keyDown(foreground, { key: 'Escape' })
  if (kind === 'permission') expect(useSessionStore.getState().pendingPermissionRequest?.requestId).toBe('permission')
  else if (kind === 'delete') expect(useSessionStore.getState().sessionDeletion).toBeNull()
  else expect(dismiss).toHaveBeenCalledOnce()
  expect(stop).not.toHaveBeenCalled()
  modal.unmount()
  expect(screen.getByRole('dialog', { name: 'a 侧栏' })).toHaveAttribute('aria-modal', 'true')
})
it('preserves pending deletion and compaction cancellation semantics while protecting the side reader', () => {
  open(); side()
  act(() => useSessionStore.setState({ sessionDeletion: { path: '/fixture/history.jsonl', requestId: 'deleting', status: 'pending' } }))
  const deletion = render(<SessionDeleteDialog />)
  resize(700)
  fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
  expect(useSessionStore.getState().sessionDeletion?.status).toBe('pending')
  expect(screen.getByRole('complementary', { name: 'a 侧栏' })).toBeInTheDocument()
  deletion.unmount()
  const cancel = vi.fn(), close = vi.fn()
  const compact = render(<CompactDialog open busy status={{ state: 'running' }} messageCount={10} initialInstructions={null} onConfirm={vi.fn()} onCancelOperation={cancel} onClose={close} />)
  fireEvent.keyDown(screen.getByRole('dialog', { name: '手动压缩会话' }), { key: 'Escape' })
  expect(cancel).toHaveBeenCalledOnce()
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByRole('complementary', { name: 'a 侧栏' })).toBeInTheDocument()
  expect(stop).not.toHaveBeenCalled()
  compact.unmount()
})
it.each(['mode', 'send'])('closes the foreground Composer %s menu before the side reader or process', kind => {
  open(); process(); side()
  fireEvent.click(kind === 'mode'
    ? screen.getByTitle('点击切换 Agent 模式')
    : screen.getByRole('button', { name: '发送选项' }))
  const menu = kind === 'mode'
    ? document.querySelector('.conversation-permission-popover')!
    : screen.getByRole('menu', { name: '发送选项' })
  expect(menu).toBeInTheDocument()
  fireEvent.keyDown(menu, { key: 'Escape' })
  expect(menu).not.toBeInTheDocument()
  expect(screen.getByRole('complementary', { name: 'a 侧栏' })).toBeInTheDocument()
  expect(screen.getByTestId('research-run-panel')).toBeInTheDocument()
  expect(stop).not.toHaveBeenCalled()
})
it('returns process-panel keyboard focus to the surviving More trigger when it closes', () => {
  open(); process()
  const close = screen.getByRole('button', { name: '收起运行过程' })
  close.focus()
  fireEvent.keyDown(close, { key: 'Escape' })
  expect(screen.queryByRole('region', { name: '研究运行过程' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '更多研究选项' })).toHaveFocus()
  expect(stop).not.toHaveBeenCalled()
})
it('leaves search IME cancellation to the browser without sending Escape to the streaming Composer', () => {
  useSettingsStore.setState({ models: Array.from({ length: 6 }, (_, index) => ({
    id: `model-${index}`, name: `Model ${index}`, provider: 'test', reasoning: false,
    input: ['text'], contextWindow: 128000, maxTokens: 4096, configured: true,
  })) })
  open(); side()
  fireEvent.click(screen.getByRole('button', { name: '模型与思考深度' }))
  const dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Model' }))
  const search = within(dialog).getByPlaceholderText(/搜索/)
  fireEvent.compositionStart(search)
  const escaped = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  fireEvent(search, escaped)
  expect(escaped.defaultPrevented).toBe(false)
  expect(search).toBeInTheDocument()
  expect(stop).not.toHaveBeenCalled()
  fireEvent.compositionEnd(search)
  fireEvent.keyDown(search, { key: 'Escape' })
  expect(search).not.toBeInTheDocument()
  expect(dialog).toBeInTheDocument()
  fireEvent.keyDown(dialog, { key: 'Escape' })
  expect(dialog).not.toBeInTheDocument()
  expect(screen.getByRole('complementary')).toBeInTheDocument()
})
it('uses the measured workspace breakpoint and traps a narrow modal until close, restoring focus and inertness on resize', () => {
  open(); const input = screen.getByRole('textbox'); const trigger = screen.getByRole('button', { name: /研究团队/ }); side()
  expect(screen.getByRole('complementary')).not.toHaveAttribute('aria-modal'); expect(input.closest('[inert]')).toBeNull()
  resize(999)
  const drawer = screen.getByRole('dialog', { name: 'a 侧栏' }); expect(drawer).toHaveAttribute('aria-modal', 'true'); expect(drawer.contains(document.activeElement)).toBe(true); expect(input.closest('[inert]')).not.toBeNull(); expect(trigger.closest('[inert]')).not.toBeNull()
  const first = within(drawer).getByRole('button', { name: '在主区域打开' }); const last = within(drawer).getByRole('button', { name: '关闭侧栏会话' }); last.focus(); fireEvent.keyDown(last, { key: 'Tab' }); expect(first).toHaveFocus(); fireEvent.keyDown(first, { key: 'Tab', shiftKey: true }); expect(last).toHaveFocus()
  resize(1000); expect(screen.getByRole('complementary')).not.toHaveAttribute('aria-modal'); expect(input.closest('[inert]')).toBeNull(); expect(trigger.closest('[inert]')).toBeNull()
  resize(700); fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(trigger).toHaveFocus(); expect(input.closest('[inert]')).toBeNull(); expect(input).toHaveValue('unsubmitted draft'); expect(stop).not.toHaveBeenCalled()
})
it('dismisses the narrow drawer with its scrim without replacing the main selection or Composer', () => {
  width = 700; act(() => useResearchWorkspaceStore.getState().setMainExecutor('r', 'b')); open(); const input = screen.getByRole('textbox'); side()
  fireEvent.pointerDown(document.querySelector('[data-research-side-scrim]')!)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(useResearchWorkspaceStore.getState().byRun.r.mainExecutorId).toBe('b'); expect(screen.getByRole('textbox')).toBe(input)
})
it('returns to the original team opener when resizing becomes modal after another toolbar control held focus', () => {
  open()
  const team = screen.getByRole('button', { name: /研究团队/ })
  side()
  screen.getByRole('button', { name: '更多研究选项' }).focus()
  resize(700)
  const drawer = screen.getByRole('dialog', { name: 'a 侧栏' })
  fireEvent.keyDown(drawer, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(team).toHaveFocus()
  expect(stop).not.toHaveBeenCalled()
})
it('restores independent main/side/member reading positions on the real shared transcript', () => {
  const keys = [researchSurfaceKey('r', 'a', 'main'), researchSurfaceKey('r', 'b', 'main'), researchSurfaceKey('r', 'a', 'side')]
  keys.forEach((key, i) => savePosition(key, { scrollTop: (i + 1) * 110, following: false }))
  const view = render(<ResearchTranscript runId="r" workspace="/fixture" descriptor={listing.sessions[1]} area="main" />)
  expect(screen.getByLabelText('a 会话记录').scrollTop).toBe(110)
  view.rerender(<ResearchTranscript runId="r" workspace="/fixture" descriptor={listing.sessions[2]} area="main" />); expect(screen.getByLabelText('b 会话记录').scrollTop).toBe(220)
  view.rerender(<ResearchTranscript runId="r" workspace="/fixture" descriptor={listing.sessions[1]} area="side" />); expect(screen.getByLabelText('a 会话记录').scrollTop).toBe(330)
  view.rerender(<ResearchTranscript runId="r" workspace="/fixture" descriptor={listing.sessions[1]} area="main" />); expect(screen.getByLabelText('a 会话记录').scrollTop).toBe(110)
})
