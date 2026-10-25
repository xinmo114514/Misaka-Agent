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
    researchBindings: {}, researchConversations: {}, researchSnapshots: {}, researchEditors: {},
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

const recruitmentFailure = { errorCode: 'RESEARCH_RECRUITMENT_MODEL_ERROR', errorStage: 'recruitment',
  errorDetails: { role: 'last_order' as const, provider: 'openai', modelId: 'fixture-model', attempt: 2,
    category: 'connection', message: 'Connection refused', stack: 'ConnectionError: refused\n  at fixture',
    diagnostics: [{ reason: 'proxy refused' }], route: { mode: 'proxy' as const, endpoint: 'https://model.test/v1', proxy: 'http://127.0.0.1:9999' } } }

it('keeps authoritative failed intake and its frozen envelope after reopening with no receipt', () => {
  const actions = useSessionStore.getState()
  actions.queueResearchMessage(original.requestId, original.text)
  actions.bindResearchConversation({ ...host, lastEventSeq: 2, messages: [
    { id: 'failed-intake', role: 'user', timestamp: 1, content: original.text, requestId: original.requestId,
      deliveryStatus: 'failed', submissionError: '研究启动失败', researchSubmission: { ...original, startNew: true }, ...recruitmentFailure },
  ] })
  const row = useSessionStore.getState().researchConversation.messages[0]
  expect(row).toMatchObject({ deliveryStatus: 'failed', submissionError: '研究启动失败', researchSubmission: { ...original, startNew: true }, ...recruitmentFailure })
  expect(Object.isFrozen(row.researchSubmission)).toBe(true)
  expect(useSessionStore.getState().researchPendingCreationRequestId).toBeNull()
})

it('propagates structured ACK failure to the row and clears diagnostics before same-id retry', () => {
  const actions = useSessionStore.getState()
  actions.queueResearchMessage(original.requestId, original.text)
  actions.rememberResearchSubmission(original.requestId, { ...original, startNew: true })
  actions.handleResearchBridgeMessage({ type: 'ack', requestId: original.requestId, ok: false, error: '研究启动失败', retryable: true, ...recruitmentFailure })
  const row = useSessionStore.getState().researchConversation.messages[0]
  expect(row).toMatchObject({ deliveryStatus: 'failed', ...recruitmentFailure })
  actions.retryResearchMessage(row.id)
  expect(research.start).toHaveBeenCalledWith(expect.objectContaining({ requestId: original.requestId, submission: { ...original, startNew: true } }))
  expect(useSessionStore.getState().researchConversation.messages).toHaveLength(1)
  expect(useSessionStore.getState().researchConversation.messages[0]).toMatchObject({ deliveryStatus: 'pending', errorDetails: undefined, errorCode: undefined, errorStage: undefined })
})

it('does not let a stale local failure override an authoritative successful history row', () => {
  const actions = useSessionStore.getState()
  actions.queueResearchMessage(original.requestId, original.text)
  actions.rememberResearchSubmission(original.requestId, original)
  actions.failResearchMessage(original.requestId, 'old failure', false, recruitmentFailure)
  actions.bindResearchConversation({ ...host, lastEventSeq: 2, run: { id: 'recovered', status: 'active', phase: 'active' }, messages: [
    { id: 'native-user', role: 'user', content: original.text, timestamp: 1, requestId: original.requestId },
  ] })
  const row = useSessionStore.getState().researchConversation.messages[0]
  expect(row).toMatchObject({ deliveryStatus: 'created', researchSubmission: original })
  expect(row.submissionError).toBeUndefined()
  expect(row.errorDetails).toBeUndefined()
  expect(row.deliveryRetryable).toBeUndefined()
})

it('keeps the current retry pending when its reconnect snapshot contains the previous failed attempt', () => {
  const actions = useSessionStore.getState()
  actions.bindResearchConversation({ ...host, lastEventSeq: 2, messages: [
    { id: 'failed-attempt', role: 'user', timestamp: 1, content: original.text, requestId: original.requestId,
      deliveryStatus: 'failed', submissionError: '前次失败', researchSubmission: original, ...recruitmentFailure },
  ] })
  research.start.mockImplementation(input => { input.onBound({ ...host, lastEventSeq: 2, messages: [
    { id: 'failed-attempt', role: 'user', timestamp: 1, content: original.text, requestId: original.requestId,
      deliveryStatus: 'failed', submissionError: '前次失败', researchSubmission: original, ...recruitmentFailure },
  ] }); return new Promise(() => {}) })
  actions.retryResearchMessage('failed-attempt')
  const state = useSessionStore.getState()
  expect(state.researchPendingCreationRequestId).toBe(original.requestId)
  expect(state.researchConversation.messages[0]).toMatchObject({ deliveryStatus: 'pending', errorDetails: undefined, submissionError: undefined })
})

it('carries a new structured retry failure back to the same row without another optimistic row', async () => {
  const actions = useSessionStore.getState()
  actions.queueResearchMessage(original.requestId, original.text)
  actions.rememberResearchSubmission(original.requestId, original)
  actions.failResearchMessage(original.requestId, '旧错误')
  research.start.mockRejectedValue(Object.assign(new Error('新错误'), { ...recruitmentFailure, retryable: true }))
  actions.retryResearchMessage(`research-user-${original.requestId}`)
  await vi.waitFor(() => expect(useSessionStore.getState().researchConversation.messages[0]).toMatchObject({ deliveryStatus: 'failed', submissionError: '新错误', ...recruitmentFailure }))
  expect(useSessionStore.getState().researchConversation.messages).toHaveLength(1)
})

it('clears a stale local startup execution error when authoritative history confirms its run', () => {
  acceptedStartupFailure()
  useSessionStore.getState().bindResearchConversation({ ...host, lastEventSeq: 2,
    run: { id: 'confirmed-run', status: 'active', phase: 'active' }, messages: [
      { id: 'confirmed-input', role: 'user', content: original.text, requestId: original.requestId, timestamp: 1 },
    ] })
  expect(useSessionStore.getState().researchConversation.messages[0].executionError).toBeUndefined()
})

it.each(['research-question', 'research-discipline', 'stale discipline'])('clears same-request startup timeout metadata on live %s success', kind => {
  const actions = useSessionStore.getState()
  actions.queueResearchMessage(original.requestId, original.text)
  actions.rememberResearchSubmission(original.requestId, original)
  actions.acceptResearchMessage(original.requestId)
  actions.failResearchExecution(original.requestId, 'Startup confirmation timed out', {
    ...recruitmentFailure, errorStage: 'startup', researchNeedsConfiguration: true,
  })
  actions.handleResearchBridgeMessage({ seq: kind === 'stale discipline' ? 1 : 2, sessionId: host.session.sessionId, streamId: host.streamId,
    event: { type: 'message_end', message: { role: 'custom', timestamp: 2,
      customType: kind === 'research-question' ? kind : 'research-discipline', content: original.text,
      details: { requestId: original.requestId, question: original.text, run_id: 'confirmed-run' } } } })
  const row = useSessionStore.getState().researchConversation.messages.find(message => message.requestId === original.requestId)!
  expect(row.executionError).toBeUndefined()
  expect(row.submissionError).toBeUndefined()
  expect(row.errorDetails).toBeUndefined()
  expect(row.errorCode).toBeUndefined()
  expect(row.errorStage).toBeUndefined()
  expect(row.researchNeedsConfiguration).toBeUndefined()
  expect(row.deliveryRetryable).toBeUndefined()
})

it.each(['other request', 'bound-run error'])('preserves %s metadata when a live question succeeds', kind => {
  acceptedStartupFailure()
  if (kind === 'bound-run error') {
    useSessionStore.setState(state => ({ researchBinding: { ...state.researchBinding!, runId: 'existing-run' } }))
    useSessionStore.getState().failResearchExecution(original.requestId, '研究启动失败：模型暂不可用')
  }
  useSessionStore.getState().handleResearchBridgeMessage({ seq: 2, sessionId: host.session.sessionId, streamId: host.streamId,
    event: { type: 'message_end', message: { role: 'custom', customType: 'research-question', content: original.text, timestamp: 2,
      details: { question: original.text, requestId: kind === 'other request' ? 'different-request' : original.requestId } } } })
  expect(useSessionStore.getState().researchConversation.messages.find(row => row.requestId === original.requestId)?.executionError).toBe('研究启动失败：模型暂不可用')
})

it('clears same-request startup errors when an older snapshot alone confirms the new run', () => {
  acceptedStartupFailure()
  useSessionStore.getState().bindResearchConversation({ ...host, lastEventSeq: 0,
    run: { id: 'late-snapshot-run', status: 'active', phase: 'active' }, messages: [
      { id: 'confirmed-question', role: 'custom', customType: 'research-question', content: original.text, timestamp: 1,
        details: { question: original.text, requestId: original.requestId } },
    ] })
  expect(useSessionStore.getState().researchBinding?.runId).toBe('late-snapshot-run')
  expect(useSessionStore.getState().researchConversation.lastEventSeq).toBe(1)
  expect(useSessionStore.getState().researchConversation.messages[0].executionError).toBeUndefined()
})
