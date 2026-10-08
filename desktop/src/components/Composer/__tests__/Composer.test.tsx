import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Composer } from '../Composer'
import { useSessionStore } from '../../../store/useSessionStore'
const research = vi.hoisted(() => ({ start: vi.fn() }))
vi.mock('../../../lib/startComposerResearch', () => ({ startComposerResearch: research.start }))

afterEach(cleanup)
const send = vi.fn()
const stop = vi.fn()
const researchSnapshot = { enabled: true, session: { sessionId: 'research-root', file: 'root.jsonl', cwd: 'C:/project' },
  messages: [], historyVersion: 'v1', lastEventSeq: 0, run: { id: 'new-run', status: 'active', phase: 'plan' }, stats: {}, contextUsage: {} }
beforeEach(() => {
  send.mockClear(); stop.mockClear()
  research.start.mockReset().mockImplementation(async input => { input.onBound?.(researchSnapshot); input.onAccepted?.(); return { ...researchSnapshot, runId: 'new-run' } })
  useSessionStore.setState({ researchBinding: null, researchConnectionError: null,
    researchConversation: { currentSessionId: '', messages: [], isStreaming: false, isAborting: false, streamingMessageId: null, lastEventSeq: 0 },
    messages: [], agentMode: 'agent', permissionMode: 'default', currentWorkspace: 'C:/project', sessionOperation: null, isCompacting: false, draft: '', attachments: [], retainedEditorText: null, isStreaming: false, isSessionLoading: false, sessionLoadError: null, isAborting: false, sendMessage: send, abortGeneration: stop })
})

it('retains a draft and blocks submit after readiness times out', () => {
  useSessionStore.setState({ sessionLoadError: '会话准备超时', isSessionLoading: false })
  const { container } = render(<Composer />)
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: '等待期间写的草稿' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.submit(container.querySelector('form')!)
  expect(send).not.toHaveBeenCalled()
  expect(input).toHaveValue('等待期间写的草稿')
  expect(screen.getByRole('button', { name: '会话尚未就绪' })).toBeDisabled()
})

it('does not send Enter during IME composition, but sends normal Enter', () => {
  render(<Composer />)
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: '中文任务' } })
  fireEvent.compositionStart(input)
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true })
  expect(send).not.toHaveBeenCalled()
  fireEvent.compositionEnd(input)
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
  expect(send).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(send).toHaveBeenCalledWith('中文任务', 'steer')
  expect(input).toHaveValue('')
})

it('sends steering during a run without replacing the independent stop button', () => {
  useSessionStore.setState({ isStreaming: true })
  render(<Composer />)
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: '先看测试' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(send).toHaveBeenCalledWith('先看测试', 'steer')
  expect(stop).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: /中止生成/ })).toBeEnabled()
})

it('queues Alt+Enter during a run but sends normally when idle', () => {
  useSessionStore.setState({ isStreaming: true })
  const view = render(<Composer />)
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: '下一步' } })
  fireEvent.keyDown(input, { key: 'Enter', altKey: true })
  expect(send).toHaveBeenLastCalledWith('下一步', 'followUp')
  view.unmount()
  useSessionStore.setState({ isStreaming: false })
  render(<Composer />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '空闲任务' } })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', altKey: true })
  expect(send).toHaveBeenLastCalledWith('空闲任务', 'steer')
})

it('queues from the menu without changing the next default send', () => {
  useSessionStore.setState({ isStreaming: true })
  render(<Composer />)
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: '稍后做' } })
  fireEvent.click(screen.getByRole('button', { name: '发送选项' }))
  fireEvent.click(screen.getByRole('menuitem', { name: /后续排队/ }))
  expect(send).toHaveBeenLastCalledWith('稍后做', 'followUp')
  expect(input).toHaveValue('')
  fireEvent.change(input, { target: { value: '现在调整' } })
  fireEvent.click(screen.getByRole('button', { name: '干预当前运行 (Enter)' }))
  expect(send).toHaveBeenLastCalledWith('现在调整', 'steer')
  expect(stop).not.toHaveBeenCalled()
})

it('uses the first Escape to close the send menu, the second to stop', () => {
  useSessionStore.setState({ isStreaming: true })
  render(<Composer />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '任务' } })
  fireEvent.click(screen.getByRole('button', { name: '发送选项' }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(stop).not.toHaveBeenCalled()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(stop).toHaveBeenCalledOnce()
})

it('does not send empty text and disables send options while stopping', () => {
  useSessionStore.setState({ isStreaming: true })
  render(<Composer />)
  expect(screen.getByRole('button', { name: '干预当前运行 (Enter)' })).toBeDisabled()
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', altKey: true })
  expect(send).not.toHaveBeenCalled()
})

it('closes the permission menu before stopping with Escape', () => {
  useSessionStore.setState({ isStreaming: true, permissionMode: 'default' })
  render(<Composer />)
  fireEvent.click(screen.getByRole('button', { name: '标准模式' }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByText('选择 Agent 模式')).not.toBeInTheDocument()
  expect(stop).not.toHaveBeenCalled()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(stop).toHaveBeenCalledOnce()
})

it('keeps a stop action available for the whole active run even without input', () => {
  useSessionStore.setState({ isStreaming: true })
  render(<Composer />)
  fireEvent.click(screen.getByRole('button', { name: /中止/ }))
  expect(stop).toHaveBeenCalledOnce()
})



it('disables submission while a session loads without presenting a fake stop action', () => {
  useSessionStore.setState({ isSessionLoading: true, isStreaming: false })
  const { container } = render(<Composer />)
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: '加载后的任务' } })
  expect(screen.getByRole('button', { name: '会话加载中' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: /中止/ })).not.toBeInTheDocument()
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.submit(container.querySelector('form')!)
  expect(send).not.toHaveBeenCalled()
  expect(stop).not.toHaveBeenCalled()
  expect(input).toHaveValue('加载后的任务')
})

it('shows stopping progress and blocks repeated stop requests until the run settles', () => {
  useSessionStore.setState({ isStreaming: true, isAborting: true })
  const { container } = render(<Composer />)
  const action = screen.getByRole('button', { name: '停止中' })
  expect(action).toBeDisabled()
  fireEvent.click(action)
  fireEvent.keyDown(document, { key: 'Escape' })
  fireEvent.submit(container.querySelector('form')!)
  expect(stop).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

it('consumes /tree and /compact in the composer rather than sending them as prompts', () => {
  useSessionStore.setState({ currentSessionId: 'slash-session', draft: '' })
  render(<Composer />)
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: '/tree' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(send).not.toHaveBeenCalled()
  expect(useSessionStore.getState().treeOpen).toBe(true)
  fireEvent.change(input, { target: { value: '/compact preserve exact language' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(send).not.toHaveBeenCalled()
  expect(useSessionStore.getState().compactOpen).toBe(true)
  expect(useSessionStore.getState().compactDraft).toBe('preserve exact language')
})

it('offers returned tree text separately and leaves an existing draft untouched until requested', () => {
  useSessionStore.setState({ draft: 'my current draft', retainedEditorText: 'selected user message' })
  render(<Composer />)
  expect(screen.getByText(/selected user message/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /restore returned text|恢复到草稿/i }))
  expect(useSessionStore.getState().draft).toBe('my current draft\n\nselected user message')
  expect(useSessionStore.getState().retainedEditorText).toBeNull()
})

it('opens the native file picker from the plus control and leaves the draft unchanged on cancel', async () => {
  const pickFiles = vi.fn().mockResolvedValue([])
  window.app = {
    getVersion: async () => 'test', pickDirectory: async () => null, pickFiles,
    openPath: async () => ({ ok: true }), openExternal: async () => false,
    showItemInFolder: async () => ({ ok: true }),
    startResearchBridge: async () => ({ enabled: false, session: { sessionId: '', file: '', cwd: '' }, stats: {}, contextUsage: {} }),
    setResearchActive: () => {},
  }
  useSessionStore.setState({ draft: '保留草稿' })
  render(<Composer />)
  fireEvent.click(screen.getByRole('button', { name: '添加附件' }))
  await waitFor(() => expect(pickFiles).toHaveBeenCalledOnce())
  expect(useSessionStore.getState().draft).toBe('保留草稿')
})

it('selects research from the Agent menu and starts it directly from the existing input', async () => {
  const onResearchStarted = vi.fn()
  render(<Composer onResearchStarted={onResearchStarted} />)
  fireEvent.click(screen.getByRole('button', { name: '标准模式' }))
  fireEvent.click(screen.getByRole('button', { name: /研究模式/ }))
  expect(useSessionStore.getState().permissionMode).toBe('bypassPermissions')
  expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', expect.stringContaining('研究'))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '比较两种方法' } })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  await waitFor(() => expect(onResearchStarted).toHaveBeenCalledOnce())
  expect(research.start).toHaveBeenCalledWith(expect.objectContaining({ question: '比较两种方法', workspace: 'C:/project' }))
  expect(send).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox')).toHaveValue('')
  expect(useSessionStore.getState().researchBinding?.runId).toBe('new-run')
})

it('keeps the draft on research startup failure and permits retry', async () => {
  research.start.mockRejectedValueOnce(new Error('研究启动失败'))
  useSessionStore.setState({ agentMode: 'research' })
  const onResearchStarted = vi.fn()
  render(<Composer onResearchStarted={onResearchStarted} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '保留课题' } })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(await screen.findByRole('alert')).toHaveTextContent('研究启动失败')
  expect(screen.getByRole('textbox')).toHaveValue('保留课题')
  expect(onResearchStarted).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  await waitFor(() => expect(onResearchStarted).toHaveBeenCalledOnce())
})

it('deduplicates research submissions while starting and preserves edits made during startup', async () => {
  let finish!: () => void
  research.start.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ...researchSnapshot, runId: 'new-run' }) }))
  useSessionStore.setState({ agentMode: 'research' })
  render(<Composer />)
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: '第一项研究' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(research.start).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: '研究启动中' })).toBeDisabled()
  fireEvent.change(input, { target: { value: '下一项课题草稿' } })
  finish()
  await waitFor(() => expect(screen.queryByRole('button', { name: '研究启动中' })).not.toBeInTheDocument())
  expect(input).toHaveValue('下一项课题草稿')
})

it('still routes local slash commands before research startup', () => {
  useSessionStore.setState({ agentMode: 'research', currentSessionId: 'slash-session' })
  render(<Composer />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '/tree' } })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(research.start).not.toHaveBeenCalled()
  expect(useSessionStore.getState().treeOpen).toBe(true)
})

it('explains why research cannot start during an ordinary streaming turn without dropping the draft', async () => {
  useSessionStore.setState({ agentMode: 'research', isStreaming: true })
  render(<Composer />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '新的研究课题' } })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(await screen.findByRole('alert')).toHaveTextContent('当前对话')
  expect(screen.getByRole('textbox')).toHaveValue('新的研究课题')
  expect(research.start).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

it('routes followup text to the bound coordinator during research streaming and keeps ordinary history intact', async () => {
  useSessionStore.getState().bindResearchConversation(researchSnapshot)
  const binding = useSessionStore.getState().researchBinding
  useSessionStore.setState({ agentMode: 'research', messages: [{ id: 'ordinary', role: 'user', content: '普通聊天', timestamp: 1 }],
    researchConversation: { ...useSessionStore.getState().researchConversation, isStreaming: true } })
  render(<Composer />)
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: '只考虑公开证据' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(research.start).toHaveBeenCalledOnce())
  expect(research.start).toHaveBeenCalledWith(expect.objectContaining({ question: '只考虑公开证据', binding }))
  expect(send).not.toHaveBeenCalled()
  expect(useSessionStore.getState().messages.map(m => m.content)).toEqual(['普通聊天'])
})
