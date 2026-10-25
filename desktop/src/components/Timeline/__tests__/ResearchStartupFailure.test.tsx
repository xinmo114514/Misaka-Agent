import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MessageItem } from '../MessageItem'
import { Composer } from '../../Composer/Composer'
import { useSessionStore } from '../../../store/useSessionStore'
import { installResearchBridge } from '../../../lib/researchBridge'
import type { ChatMessage } from '../../../types/session'

const research = vi.hoisted(() => ({ start: vi.fn() }))
vi.mock('../../../lib/startComposerResearch', () => ({ startComposerResearch: research.start, cancelResearchStartup: vi.fn() }))
vi.mock('../../../lib/bridge', async importOriginal => ({ ...await importOriginal<typeof import('../../../lib/bridge')>(),
  request: vi.fn(async () => ({ defaults: { max_depth: 3, parallel: 4, sister_parallel: 4, max_followups: 2,
    max_revisions: 2, max_nodes: 30, plan_approval: true }, constraints: {}, sisters: [] })) }))

let deliver: (message: any) => void
let release: () => void
const submission = { text: '原课题', sessionId: 'failure-root', requestId: 'failure-id', startNew: true,
  limits: { max_depth: 2, parallel: 2, sister_parallel: 1, max_followups: 2, max_revisions: 2, max_nodes: 10, plan_approval: false } }
const failure: ChatMessage = { id: 'failure-row', role: 'user', timestamp: 1, content: '原课题', requestId: 'failure-id',
  deliveryStatus: 'failed', submissionError: '协调模型连接失败，研究尚未启动。', deliveryRetryable: true,
  researchSubmission: submission, errorCode: 'RESEARCH_RECRUITMENT_MODEL_ERROR', errorStage: 'recruitment',
  errorDetails: { role: 'last_order', provider: 'fixture', modelId: 'fixture-model', attempt: 2, category: 'connection',
    message: 'Connection refused api_key=private-api-key', stack: 'ConnectionError: refused\n  at original_stack.py:42',
    diagnostics: [{ cause: 'proxy refused', authorization: 'Bearer abcdefghijklmnop' }],
    route: { mode: 'proxy', endpoint: 'https://model.test/v1', proxy: 'http://proxy-user:proxy-password@127.0.0.1:9999' } } }

beforeEach(() => {
  window.bridge = { send: vi.fn(), on: () => () => {} }
  window.researchBridge = { send: vi.fn(), on: callback => { deliver = callback; return () => {} } }
  release = installResearchBridge()
  research.start.mockReset().mockImplementation(() => new Promise(() => {}))
  useSessionStore.setState({ agentMode: 'research', currentWorkspace: 'C:/work', researchBinding: null, researchCards: {},
    researchPendingCreationRequestId: null, researchBindings: {}, researchConversations: {}, researchSnapshots: {}, researchEditors: {},
    researchConversation: { currentSessionId: '', messages: [], isStreaming: false, isAborting: false, streamingMessageId: null, lastEventSeq: 0 },
    isSessionLoading: false, sessionLoadError: null, isStreaming: false, isAborting: false, draft: '', attachments: [], sessionOperation: null, isCompacting: false })
  useSessionStore.getState().bindResearchConversation({ enabled: true, streamId: 'failure-stream',
    session: { sessionId: 'failure-root', file: 'C:/work/root.jsonl', cwd: 'C:/work' },
    messages: [failure], historyVersion: 'v1', lastEventSeq: 1, run: null, stats: {}, contextUsage: {}, isIdle: true })
  useSessionStore.getState().selectResearchView({ kind: 'conversation', sessionId: 'failure-root', ownerKey: 'conversation:failure-root' })
})
afterEach(() => { cleanup(); release() })

function sentProbe() {
  return vi.mocked(window.researchBridge.send).mock.calls.map(([command]) => command as Record<string, unknown>)
    .find(command => command.type === 'check_research_connection')!
}

it.each([false, true])('cold marker reopening exposes the original research recovery controls (legacy: %s)', async legacy => {
  const persisted = legacy ? { ...failure, researchSubmission: undefined } : failure
  const snapshot = { enabled: true, streamId: 'cold-recovery-stream',
    session: { sessionId: 'failure-root', file: 'C:/work/root.jsonl', cwd: 'C:/work' }, messages: [persisted],
    historyVersion: 'cold-v1', lastEventSeq: 1, run: null, stats: {}, contextUsage: null, isIdle: true }
  window.app = { ...window.app, startResearchBridge: vi.fn().mockResolvedValue(snapshot) }
  useSessionStore.setState({ agentMode: 'agent', researchBinding: null, researchBindings: {}, researchConversations: {}, researchSnapshots: {},
    sessions: [{ id: 'failure-root', path: 'C:/work/root.jsonl', cwd: 'C:/work', created: '2026-10-16', modified: '2026-10-16',
      firstMessage: '原课题', messageCount: 1, desktopResearch: true }], draft: 'ordinary draft' })
  await act(async () => useSessionStore.getState().openSession('C:/work/root.jsonl'))
  const message = useSessionStore.getState().researchConversation.messages[0]
  render(<><MessageItem message={message} /><Composer /></>)
  expect(screen.getByRole('button', { name: '检查连接' })).toBeEnabled()
  expect(window.bridge.send).not.toHaveBeenCalled()
  if (legacy) {
    fireEvent.click(screen.getByRole('button', { name: '恢复到草稿' }))
    expect(screen.getByRole('textbox')).toHaveValue('原课题')
    expect(research.start).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(await screen.findByRole('button', { name: '确认并开始研究' })).toBeEnabled()
    expect(research.start).not.toHaveBeenCalled()
  } else {
    fireEvent.click(screen.getByRole('button', { name: '重试启动' }))
    expect(research.start).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'failure-id', submission,
      binding: expect.objectContaining({ sessionId: 'failure-root', sessionFile: 'C:/work/root.jsonl' }) }))
    expect(useSessionStore.getState().researchConversation.messages.filter(row => row.role === 'user')).toHaveLength(1)
  }
  expect(vi.mocked(window.bridge.send).mock.calls.some(([command]) => ['prompt', 'load_session', 'send_research_message'].includes((command as { type: string }).type))).toBe(false)
})

it('shows a startup summary with actual expandable sanitized diagnostics, not a submission or resume action', () => {
  render(<MessageItem message={failure} />)
  expect(screen.getByText('协调模型连接失败，研究尚未启动。')).toBeInTheDocument()
  expect(screen.queryByText(/提交失败/)).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /继续|恢复研究|Resume/i })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
  expect(screen.getByText(/original_stack.py:42/)).toBeVisible()
  expect(screen.getByText(/last_order/)).toBeVisible()
  expect(screen.getByText(/fixture-model/)).toBeVisible()
  expect(screen.getByText(/proxy refused/)).toBeVisible()
  expect(document.body.textContent).not.toMatch(/private-api-key|abcdefghijklmnop|proxy-password|proxy-user/)
  fireEvent.click(screen.getByRole('button', { name: '重试启动' }))
  expect(research.start).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'failure-id', submission }))
})

it('probes the bound session and stream once and accurately limits a successful TCP result', async () => {
  render(<MessageItem message={failure} />)
  const button = screen.getByRole('button', { name: '检查连接' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(button).toBeDisabled()
  expect(window.researchBridge.send).toHaveBeenCalledTimes(1)
  const command = sentProbe()
  expect(command).toMatchObject({ sessionId: 'failure-root', streamId: 'failure-stream' })
  expect(command).not.toHaveProperty('endpoint')
  await act(async () => deliver({ type: 'ack', ok: true, requestId: command.requestId, data: {
    route: { mode: 'proxy', endpoint: 'https://model.test/v1', proxy: 'http://127.0.0.1:9999' }, reachable: true, check: 'tcp' } }))
  expect(screen.getByText(/TCP连通仅说明端口可达，尚未验证鉴权或模型推理/)).toBeVisible()
  expect(screen.getByText(/代理.*127.0.0.1:9999/)).toBeVisible()
  expect(screen.getByText(/代理服务恢复.*重试启动/)).toBeVisible()
  expect(screen.getByText(/环境变量.*完整重启/)).toBeVisible()
  expect(button).toBeEnabled()
})

it.each(['failure', 'stream', 'session', 'navigation'] as const)('discards late probe results after a newer %s identity', async kind => {
  const { rerender } = render(<MessageItem message={failure} />)
  fireEvent.click(screen.getByRole('button', { name: '检查连接' }))
  const command = sentProbe()
  if (kind === 'failure') rerender(<MessageItem message={{ ...failure, errorDetails: { ...failure.errorDetails!, attempt: 3 } }} />)
  else act(() => useSessionStore.setState(state => kind === 'navigation' ? { researchPageVersion: state.researchPageVersion + 1 }
    : { researchBinding: { ...state.researchBinding!, ...(kind === 'stream' ? { streamId: 'new-stream' } : { sessionId: 'new-root' }) } }))
  await act(async () => deliver({ type: 'ack', ok: true, requestId: command.requestId, data: {
    route: { mode: 'direct', endpoint: 'https://stale-result.test' }, reachable: true, check: 'tcp' } }))
  expect(screen.queryByText(/stale-result.test/)).not.toBeInTheDocument()
  expect(screen.queryByText(/TCP连通仅说明/)).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '检查连接' })).toBeEnabled()
})

it('shows the direct target and failed TCP outcome without claiming model readiness', async () => {
  render(<MessageItem message={failure} />)
  fireEvent.click(screen.getByRole('button', { name: '检查连接' }))
  await act(async () => deliver({ type: 'ack', ok: true, requestId: sentProbe().requestId, data: {
    route: { mode: 'direct', endpoint: 'https://direct-model.test/v1' }, reachable: false, check: 'tcp', error: 'Connection refused' } }))
  expect(screen.getByText(/直连.*direct-model.test/)).toBeVisible()
  expect(screen.getByText(/TCP.*不可达/)).toBeVisible()
  expect(screen.getByText(/Connection refused/)).toBeVisible()
})

it('reports malformed route configuration when the TCP probe has no resolved route', async () => {
  render(<MessageItem message={failure} />)
  fireEvent.click(screen.getByRole('button', { name: '检查连接' }))
  await act(async () => deliver({ type: 'ack', ok: true, requestId: sentProbe().requestId,
    data: { route: null, reachable: false, check: 'tcp', error: 'Invalid proxy URL' } }))
  expect(screen.getByText('Invalid proxy URL')).toBeVisible()
  expect(screen.getByText(/TCP.*不可达/)).toBeVisible()
  expect(screen.getByRole('button', { name: '检查连接' })).toBeEnabled()
})

it('discards a probe after unmount and clears a completed result when failure changes', async () => {
  const { rerender, unmount } = render(<MessageItem message={failure} />)
  fireEvent.click(screen.getByRole('button', { name: '检查连接' }))
  await act(async () => deliver({ type: 'ack', ok: true, requestId: sentProbe().requestId,
    data: { route: { mode: 'direct', endpoint: 'https://old-result.test' }, reachable: true, check: 'tcp' } }))
  expect(screen.getByText(/old-result.test/)).toBeVisible()
  rerender(<MessageItem message={{ ...failure, submissionError: '新的失败' }} />)
  expect(screen.queryByText(/old-result.test/)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '检查连接' }))
  const commands = vi.mocked(window.researchBridge.send).mock.calls.map(([command]) => command as Record<string, unknown>)
  unmount()
  await act(async () => deliver({ type: 'ack', ok: true, requestId: commands.at(-1)!.requestId,
    data: { route: { mode: 'direct', endpoint: 'https://unmounted-result.test' }, reachable: true, check: 'tcp' } }))
  expect(screen.queryByText(/unmounted-result.test/)).not.toBeInTheDocument()
})

it('restores missing-envelope legacy input to the focused editor and opens the wizard only after explicit send', async () => {
  const legacy = { ...failure, researchSubmission: undefined, deliveryRetryable: false, researchNeedsConfiguration: true }
  useSessionStore.setState(state => ({ researchConversation: { ...state.researchConversation, messages: [legacy] } }))
  render(<><MessageItem message={legacy} /><Composer /></>)
  const restore = screen.getByRole('button', { name: '恢复到草稿' })
  expect(restore).toBeEnabled()
  fireEvent.click(restore)
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus())
  expect(screen.getByRole('textbox')).toHaveValue('原课题')
  expect(screen.getByText(/发送.*参数向导/)).toBeVisible()
  expect(research.start).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  fireEvent.click(await screen.findByRole('button', { name: '确认并开始研究' }))
  await waitFor(() => expect(research.start).toHaveBeenCalledOnce())
  const input = research.start.mock.calls[0][0]
  expect(input.requestId).not.toBe('failure-id')
  expect(input.submission).toBeUndefined()
})

it('retains the ordinary chat submission failure and retry button', () => {
  useSessionStore.setState({ agentMode: 'agent' })
  render(<MessageItem message={{ id: 'chat', role: 'user', content: 'chat input', timestamp: 1, submissionError: 'ordinary error' }} />)
  expect(screen.getByText('提交失败：ordinary error')).toBeVisible()
  expect(screen.getByRole('button', { name: '重试' })).toBeVisible()
  expect(screen.queryByRole('button', { name: '检查连接' })).not.toBeInTheDocument()
})
