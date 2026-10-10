import '@testing-library/jest-dom/vitest'
import { beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach } from 'vitest'
import { MessageItem } from '../MessageItem'
import { useSessionStore } from '../../../store/useSessionStore'

const research = vi.hoisted(() => ({ start: vi.fn() }))
afterEach(cleanup)
vi.mock('../../../lib/startComposerResearch', () => ({ startComposerResearch: research.start }))

beforeEach(() => research.start.mockReset().mockResolvedValue({ enabled: true, streamId: 'stream-1',
  session: { sessionId: 'root', file: '/root.jsonl', cwd: '/work' }, messages: [], historyVersion: 'v1', lastEventSeq: 1,
  run: { id: 'run-1', status: 'active', phase: 'executing' }, stats: {}, contextUsage: {} }))
it('shows submission failure on the user row and disables retry while stopping', () => {
  const message = { id: 'failed', role: 'user' as const, content: '保留原文', timestamp: 1, submissionError: '测试错误', streamingBehavior: 'followUp' as const }
  useSessionStore.setState({ messages: [message], isStreaming: true, isAborting: true, isSessionLoading: false, sessionLoadError: null })
  render(<MessageItem message={message} />)
  expect(screen.getByRole('status')).toHaveTextContent('测试错误')
  expect(screen.getByRole('button', { name: '重试' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(useSessionStore.getState().messages).toEqual([message])
})

it('retries a reconciled research delivery with the same request ID and exact text', () => {
  const message = { id: 'research-user-stable-id', role: 'user' as const, content: '  exact user text  ', timestamp: 1,
    requestId: 'stable-id', optimistic: true, deliveryStatus: 'unconfirmed' as const,
    deliveryReconciled: true, submissionError: '发送结果尚未确认' }
  useSessionStore.setState({ agentMode: 'research', researchConnectionError: '旧错误',
    researchBinding: { sessionId: 'root', sessionFile: '/root.jsonl', workspace: '/work', runId: 'run-1', streamId: 'stream-1' },
    researchConversation: { currentSessionId: 'root', messages: [message], isStreaming: true, isAborting: false,
      streamingMessageId: 'owner', lastEventSeq: 1 }, isSessionLoading: false, sessionLoadError: null })
  render(<MessageItem message={message} />)
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  const retried = useSessionStore.getState().researchConversation.messages[0]
  expect(retried).toMatchObject({ requestId: 'stable-id', content: '  exact user text  ', deliveryStatus: 'pending', submissionError: undefined })
  expect(useSessionStore.getState().researchConnectionError).toBeNull()
  expect(research.start).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'stable-id', question: '  exact user text  ' }))
})

it('retains the original input envelope when retrying after a run becomes bound', async () => {
  const submission = { text: '原问题', requestId: 'original', sessionId: 'root', limits: { parallel: 3, plan_approval: false,
    max_depth: 3, sister_parallel: 2, max_followups: 3, max_revisions: 3, max_nodes: 12 } }
  const message = { id: 'failed-original', role: 'user' as const, content: '原问题', timestamp: 1, requestId: 'original',
    deliveryStatus: 'failed' as const, submissionError: 'retry', researchSubmission: submission,
    researchDraft: { text: '原问题', attachmentPaths: [], sessionId: 'root', streamId: 'stream-1', mode: 'research' as const } }
  useSessionStore.setState({ agentMode: 'research', draft: '原问题', attachments: [], researchPendingCreationRequestId: null,
    researchBinding: { sessionId: 'root', sessionFile: '/root.jsonl', workspace: '/work', runId: 'new-run', streamId: 'stream-1' },
    researchConversation: { currentSessionId: 'root', messages: [message], isStreaming: false, isAborting: false, streamingMessageId: null, lastEventSeq: 1 },
    isSessionLoading: false, sessionLoadError: null })
  render(<MessageItem message={message} />)
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(research.start).toHaveBeenCalledWith(expect.objectContaining({ submission }))
  await waitFor(() => expect(useSessionStore.getState().draft).toBe(''))
})

it('disables failed input retry while another startup request is pending', () => {
  const message = { id: 'failed', role: 'user' as const, requestId: 'failed', content: '问题', timestamp: 1,
    deliveryStatus: 'failed' as const, submissionError: '失败' }
  useSessionStore.setState({ agentMode: 'research', researchPendingCreationRequestId: 'starting',
    researchBinding: { sessionId: 'root', sessionFile: '/root.jsonl', workspace: '/work', runId: null },
    researchConversation: { currentSessionId: 'root', messages: [message], isStreaming: false, isAborting: false, streamingMessageId: null, lastEventSeq: 1 },
    isSessionLoading: false, sessionLoadError: null })
  render(<MessageItem message={message} />)
  expect(screen.getByRole('button', { name: '重试' })).toBeDisabled()
})

it('shows recorded history separately from execution error without a delivery retry', () => {
  const message = { id: 'created', role: 'user' as const, requestId: 'created', content: '问题', timestamp: 1,
    deliveryStatus: 'created' as const, executionError: '初始化失败' }
  render(<MessageItem message={message} />)
  expect(screen.getByText('已记录')).toBeInTheDocument()
  expect(screen.getByText(/初始化失败/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
})

it('does not expose retry for an authoritative unconfirmed receipt', () => {
  useSessionStore.setState({ agentMode: 'research', researchPendingCreationRequestId: null, researchBinding: null })
  useSessionStore.getState().bindResearchConversation({ enabled: true, streamId: 'stream-1',
    session: { sessionId: 'root', file: '/root.jsonl', cwd: '/work' }, messages: [
      { id: 'unconfirmed', requestId: 'unconfirmed', role: 'user', content: '课题', timestamp: 1 },
    ], submissionReceipts: [{ requestId: 'unconfirmed', state: 'unconfirmed' }], historyVersion: 'v1', lastEventSeq: 1,
    run: { id: 'run-1', status: 'done', phase: 'done' }, stats: {}, contextUsage: {} })
  render(<MessageItem message={useSessionStore.getState().researchConversation.messages[0]} />)
  expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
})

it('disables permanently rejected input retry in both renderer and store', () => {
  const message = { id: 'permanent', role: 'user' as const, requestId: 'permanent', content: '课题', timestamp: 1,
    deliveryStatus: 'failed' as const, deliveryRetryable: false, submissionError: '原会话冲突' }
  useSessionStore.setState({ agentMode: 'research', researchPendingCreationRequestId: null,
    researchBinding: { sessionId: 'root', sessionFile: '/root.jsonl', workspace: '/work', runId: 'run-1' },
    researchConversation: { currentSessionId: 'root', messages: [message], isStreaming: false, isAborting: false, streamingMessageId: null, lastEventSeq: 1 },
    isSessionLoading: false, sessionLoadError: null })
  render(<MessageItem message={message} />)
  expect(screen.getByRole('button', { name: '重试' })).toBeDisabled()
  useSessionStore.getState().retryResearchMessage('permanent')
  expect(research.start).not.toHaveBeenCalled()
})

it('retries reloaded rejected history using original limits and absent original run id', () => {
  const original = { text: '最初课题', requestId: 'reload', sessionId: 'root', limits: {
    max_depth: 2, parallel: 3, sister_parallel: 1, max_followups: 2, max_revisions: 2, max_nodes: 10, plan_approval: false,
  } }
  useSessionStore.setState({ agentMode: 'research', researchBinding: null, researchPendingCreationRequestId: null })
  useSessionStore.getState().bindResearchConversation({ enabled: true, streamId: 'stream-1',
    session: { sessionId: 'root', file: '/root.jsonl', cwd: '/work' }, messages: [
      { id: 'reload', role: 'custom', customType: 'research-question', content: '最初课题', details: { requestId: 'reload', question: '最初课题' }, timestamp: 1, researchSubmission: original },
    ], submissionReceipts: [{ requestId: 'reload', state: 'rejected' }], historyVersion: 'v1', lastEventSeq: 1,
    run: { id: 'later-run', status: 'done', phase: 'done' }, stats: {}, contextUsage: {} })
  const message = useSessionStore.getState().researchConversation.messages[0]
  expect(Object.isFrozen(message.researchSubmission)).toBe(true)
  render(<MessageItem message={message} />)
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(research.start).toHaveBeenCalledWith(expect.objectContaining({ submission: original }))
  expect(research.start.mock.calls[0][0].submission).not.toHaveProperty('runId')
})
