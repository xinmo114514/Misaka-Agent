import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MessageItem } from '../MessageItem'
import { useSessionStore } from '../../../store/useSessionStore'

const research = vi.hoisted(() => ({ start: vi.fn() }))
vi.mock('../../../lib/startComposerResearch', () => ({ startComposerResearch: research.start, cancelResearchStartup: vi.fn() }))
afterEach(cleanup)

const original = { text: '原始研究课题', requestId: 'startup-recovery', sessionId: 'startup-root', limits: {
  max_depth: 2, parallel: 3, sister_parallel: 1, max_followups: 2, max_revisions: 2, max_nodes: 10, plan_approval: false,
} }
const host = { enabled: true, streamId: 'startup-stream', session: { sessionId: 'startup-root', file: '/root.jsonl', cwd: '/work' },
  messages: [], historyVersion: 'v1', lastEventSeq: 1, run: null, stats: {}, contextUsage: {}, isStreaming: false, isIdle: true }

beforeEach(() => {
  window.bridge = { send: vi.fn(), on: () => () => {} }
  research.start.mockReset().mockImplementation(() => new Promise(() => {}))
  useSessionStore.setState({ agentMode: 'research', researchBinding: null, researchPendingCreationRequestId: null,
    researchConversation: { currentSessionId: '', messages: [], isStreaming: false, isAborting: false, streamingMessageId: null, lastEventSeq: 0 },
    isSessionLoading: false, sessionLoadError: null })
  useSessionStore.getState().bindResearchConversation(host)
})

function acceptedStartupFailure() {
  const actions = useSessionStore.getState()
  actions.queueResearchMessage(original.requestId, original.text)
  actions.rememberResearchSubmission(original.requestId, original)
  actions.acceptResearchMessage(original.requestId)
  actions.failResearchExecution(original.requestId, '研究启动失败：模型暂不可用')
  return useSessionStore.getState().researchConversation.messages[0]
}

it('projects rejected startup receipts as execution failure rather than submission failure', () => {
  useSessionStore.getState().bindResearchConversation({ ...host, lastEventSeq: 2, messages: [
    { id: 'recorded-startup', role: 'user', content: original.text, requestId: original.requestId, timestamp: 1, researchSubmission: original },
  ], submissionReceipts: [{ requestId: original.requestId, state: 'rejected', errorStage: 'startup', retryable: true, error: '研究启动失败：模型暂不可用' }] })
  const message = useSessionStore.getState().researchConversation.messages[0]
  expect(message).toMatchObject({ executionError: '研究启动失败：模型暂不可用', submissionError: undefined })
  render(<MessageItem message={message} />)
  expect(screen.getByText('已记录')).toBeInTheDocument()
  expect(screen.getByText(/执行异常/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '重试' })).toBeEnabled()
})

it('retries an accepted startup execution failure with the same original envelope and request id', () => {
  const message = acceptedStartupFailure()
  useSessionStore.getState().retryResearchMessage(message.id)
  expect(research.start).toHaveBeenCalledWith(expect.objectContaining({ requestId: original.requestId, submission: original }))
  expect(useSessionStore.getState().researchConversation.messages[0]).toMatchObject({ deliveryStatus: 'pending', executionError: undefined })
})

it('offers same-id retry for a no-run execution error on the recorded user row', () => {
  const message = { ...acceptedStartupFailure(), deliveryStatus: 'created' as const }
  useSessionStore.setState(state => ({ researchConversation: { ...state.researchConversation, messages: [message] } }))
  render(<MessageItem message={message} />)
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(research.start).toHaveBeenCalledWith(expect.objectContaining({ requestId: original.requestId, submission: original }))
})

it('keeps bound-run execution failures separate without replaying the original start', () => {
  const message = { ...acceptedStartupFailure(), deliveryStatus: 'created' as const }
  useSessionStore.setState(state => ({ researchBinding: { ...state.researchBinding!, runId: 'existing-run' },
    researchConversation: { ...state.researchConversation, messages: [message] } }))
  render(<MessageItem message={message} />)
  expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
  useSessionStore.getState().retryResearchMessage(message.id)
  expect(research.start).not.toHaveBeenCalled()
})

it('releases the pending startup owner after a rejected startup receipt', () => {
  const actions = useSessionStore.getState()
  actions.queueResearchMessage(original.requestId, original.text)
  actions.rememberResearchSubmission(original.requestId, original)
  actions.bindResearchConversation({ ...host, lastEventSeq: 2, messages: [
    { id: 'recorded-startup', role: 'user', content: original.text, requestId: original.requestId, timestamp: 1, researchSubmission: original },
  ], submissionReceipts: [{ requestId: original.requestId, state: 'rejected', errorStage: 'startup', retryable: true }] })
  expect(useSessionStore.getState().researchPendingCreationRequestId).toBeNull()
})

it('clears the unchanged original draft after reconnecting the same logical owner', async () => {
  const actions = useSessionStore.getState()
  actions.setDraft(original.text)
  actions.queueResearchMessage(original.requestId, original.text)
  actions.rememberResearchSubmission(original.requestId, original, {
    text: original.text, attachmentPaths: [], sessionId: host.session.sessionId,
    streamId: host.streamId, mode: 'research', revision: useSessionStore.getState().draftRevision,
  })
  actions.failResearchMessage(original.requestId, '连接已断开')
  const reconnected = { ...host, streamId: 'new-startup-stream', run: { id: 'created-run', status: 'waiting_input', phase: 'waiting_input' } }
  research.start.mockImplementation(async input => {
    input.onBound(reconnected)
    input.onAccepted()
    return reconnected
  })
  actions.retryResearchMessage('research-user-startup-recovery')
  await vi.waitFor(() => expect(useSessionStore.getState().draft).toBe(''))
})
