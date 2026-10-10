import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { addResearchSink, executeResearchControl, installResearchBridge, requestResearch } from './researchBridge'

let deliver: (message: any) => void = () => {}
let release: () => void = () => {}

function observe<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => {})
  return promise
}

beforeEach(() => {
  vi.useFakeTimers()
  deliver = () => {}
  window.researchBridge = { send: vi.fn(), on: callback => { deliver = callback; return () => {} } }
  release = installResearchBridge()
})

afterEach(() => {
  release()
  vi.useRealTimers()
})

it('publishes the reconnected control host before sending a session- and stream-fenced stop', async () => {
  const host = { enabled: true, session: { sessionId: 'control-root', file: 'root.jsonl', cwd: 'C:/fixture' },
    streamId: 'new-control-stream', messages: [], historyVersion: 'v1', lastEventSeq: 0,
    stats: {}, contextUsage: {}, run: { id: 'r_control', status: 'active', phase: 'active' } }
  window.app = { ...window.app, startResearchBridge: vi.fn().mockResolvedValue(host) }
  const onBound = vi.fn()
  const pending = executeResearchControl('stop_research', { runId: 'r_control', workspace: 'C:/fixture',
    sessionFile: 'root.jsonl', onBound })
  await vi.waitFor(() => expect(window.researchBridge.send).toHaveBeenCalledOnce())
  const command = vi.mocked(window.researchBridge.send).mock.calls[0][0] as Record<string, unknown>
  deliver({ type: 'ack', requestId: command.requestId, ok: true })
  await pending
  expect(onBound).toHaveBeenCalledWith(host)
  expect(command).toMatchObject({ sessionId: 'control-root', streamId: 'new-control-stream', runId: 'r_control' })
})

it('classifies an ACK timeout as unconfirmed while a late ACK can still reach sinks', async () => {
  const sink = vi.fn()
  const removeSink = addResearchSink(sink)
  try {
    const pending = requestResearch('send_research_message', { requestId: 'stable-id', text: 'same' }, 20)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'ResearchRequestTimeoutError', requestId: 'stable-id' })
    await vi.advanceTimersByTimeAsync(20)
    await rejected
    expect(window.researchBridge.send).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'stable-id' }))
    expect(() => deliver({ type: 'ack', requestId: 'stable-id', ok: true })).not.toThrow()
    expect(sink).toHaveBeenCalledWith({ type: 'ack', requestId: 'stable-id', ok: true })
  } finally {
    removeSink()
  }
})

it('shares the same pending Promise and sends once for an identical command', async () => {
  const first = observe(requestResearch('send_research_message', {
    requestId: 'shared-id', text: 'same', options: { depth: 2, language: 'zh' },
  }))
  const second = observe(requestResearch('send_research_message', {
    options: { language: 'zh', depth: 2 }, text: 'same', requestId: 'shared-id',
  }, 1))

  expect(second).toBe(first)
  expect(window.researchBridge.send).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  deliver({ type: 'ack', requestId: 'shared-id', ok: true, data: { accepted: true } })
  await expect(first).resolves.toEqual({ accepted: true })
  await expect(second).resolves.toEqual({ accepted: true })
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  ['changed body', 'send_research_message', { text: 'changed' }],
  ['changed command type', 'stop_research', { text: 'original' }],
  ['changed stream', 'send_research_message', { text: 'original', streamId: 'other-stream' }],
])('rejects reused requestId with %s without replacing its original waiter', async (_case, type, changed) => {
  const first = observe(requestResearch('send_research_message', {
    requestId: 'conflict-id', text: 'original', streamId: 'stream-a',
  }))
  const conflicting = observe(requestResearch(type, {
    requestId: 'conflict-id', streamId: 'stream-a', ...changed,
  }))
  const rejected = expect(conflicting).rejects.toMatchObject({
    name: 'ResearchRequestError', errorCode: 'REQUEST_ID_CONFLICT', requestId: 'conflict-id', retryable: false,
  })
  deliver({ type: 'ack', requestId: 'conflict-id', streamId: 'stream-a', ok: true, data: { accepted: true } })
  await rejected
  await expect(first).resolves.toEqual({ accepted: true })
  expect(window.researchBridge.send).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  ['session', { sessionId: 'other-session', streamId: 'stream-a' }],
  ['stream', { sessionId: 'session-a', streamId: 'other-stream' }],
])('ignores an ACK with a mismatched %s while preserving the pending request', async (_case, identity) => {
  const promise = observe(requestResearch('send_research_message', {
    requestId: 'correlated-id', sessionId: 'session-a', streamId: 'stream-a',
  }))
  const settled = vi.fn()
  void promise.then(settled, settled)
  const sink = vi.fn()
  const removeSink = addResearchSink(sink)
  try {
    deliver({ type: 'ack', requestId: 'correlated-id', ok: true, data: 'wrong', ...identity })
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    expect(sink).not.toHaveBeenCalled()
    deliver({
      type: 'ack', requestId: 'correlated-id', sessionId: 'session-a', streamId: 'stream-a', ok: true, data: 'correct',
    })
    await expect(promise).resolves.toBe('correct')
    expect(sink).toHaveBeenCalledTimes(1)
  } finally {
    removeSink()
  }
})

it('ignores a mismatched error ACK rather than rejecting the matching request', async () => {
  const promise = observe(requestResearch('send_research_message', {
    requestId: 'error-correlation', sessionId: 'session-a', streamId: 'stream-a',
  }))
  deliver({ type: 'ack', requestId: 'error-correlation', sessionId: 'session-b', ok: false, error: 'stale' })
  deliver({ type: 'ack', requestId: 'error-correlation', sessionId: 'session-a', streamId: 'stream-a', ok: true })
  await expect(promise).resolves.toMatchObject({ ok: true })
})

it('preserves structured ACK failures in a ResearchRequestError', async () => {
  const promise = observe(requestResearch('send_research_message', {
    requestId: 'structured-error', sessionId: 'session-a', streamId: 'stream-a',
  }))
  const rejected = expect(promise).rejects.toMatchObject({
    name: 'ResearchRequestError', message: 'queue unavailable', errorCode: 'QUEUE_UNAVAILABLE',
    errorStage: 'queue', retryable: true, requestId: 'structured-error', sessionId: 'session-a', streamId: 'stream-a',
  })
  deliver({
    type: 'ack', requestId: 'structured-error', ok: false, error: 'queue unavailable',
    errorCode: 'QUEUE_UNAVAILABLE', errorStage: 'queue', retryable: true, sessionId: 'session-a', streamId: 'stream-a',
  })
  await rejected
  expect(vi.getTimerCount()).toBe(0)
})

it('accepts legacy ACKs with no session or stream fields', async () => {
  const promise = requestResearch('send_research_message', {
    requestId: 'legacy-success', sessionId: 'session-a', streamId: 'stream-a',
  })
  deliver({ type: 'ack', requestId: 'legacy-success', ok: true, data: { accepted: true } })
  await expect(promise).resolves.toEqual({ accepted: true })
})

it('retains legacy error messages and pending identity in ResearchRequestError', async () => {
  const promise = observe(requestResearch('send_research_message', {
    requestId: 'legacy-error', sessionId: 'session-a', streamId: 'stream-a',
  }))
  const rejected = expect(promise).rejects.toMatchObject({
    name: 'ResearchRequestError', message: 'legacy failure', requestId: 'legacy-error',
    sessionId: 'session-a', streamId: 'stream-a',
  })
  deliver({ type: 'ack', requestId: 'legacy-error', ok: false, error: 'legacy failure' })
  await rejected
})

it('accepts ACK identities when the caller did not supply correlation fields', async () => {
  const promise = requestResearch('stop_research', { requestId: 'no-identity' })
  deliver({ type: 'ack', requestId: 'no-identity', sessionId: 'session-a', streamId: 'stream-a', ok: true, data: 'stopped' })
  await expect(promise).resolves.toBe('stopped')
})

it('cleans the timer and waiter after a synchronous send failure so the ID can be retried', async () => {
  const sendError = new Error('send failed')
  vi.mocked(window.researchBridge.send).mockImplementationOnce(() => { throw sendError })
  await expect(requestResearch('send_research_message', { requestId: 'send-failure' })).rejects.toBe(sendError)
  expect(vi.getTimerCount()).toBe(0)

  const retry = requestResearch('send_research_message', { requestId: 'send-failure' })
  deliver({ type: 'ack', requestId: 'send-failure', ok: true, data: 'accepted' })
  await expect(retry).resolves.toBe('accepted')
  expect(window.researchBridge.send).toHaveBeenCalledTimes(2)
})

it('rejects requests and clears timers when the last bridge installation is released', async () => {
  const secondRelease = installResearchBridge()
  const first = observe(requestResearch('send_research_message', { requestId: 'disconnect-one' }))
  const second = observe(requestResearch('stop_research', { requestId: 'disconnect-two' }))
  const firstRejected = expect(first).rejects.toThrow('研究桥接通道已断开')
  const secondRejected = expect(second).rejects.toThrow('研究桥接通道已断开')
  release()
  expect(vi.getTimerCount()).toBe(2)
  secondRelease()
  secondRelease()
  await firstRejected
  await secondRejected
  expect(vi.getTimerCount()).toBe(0)

  release = installResearchBridge()
  const fresh = requestResearch('send_research_message', { requestId: 'disconnect-one' })
  deliver({ type: 'ack', requestId: 'disconnect-one', ok: true, data: 'fresh' })
  await expect(fresh).resolves.toBe('fresh')
})

it('allows a timed-out request ID to be submitted again without retaining the old waiter', async () => {
  const first = observe(requestResearch('send_research_message', { requestId: 'timed-out-id', text: 'same' }, 10))
  const rejected = expect(first).rejects.toMatchObject({ name: 'ResearchRequestTimeoutError' })
  await vi.advanceTimersByTimeAsync(10)
  await rejected
  const retry = requestResearch('send_research_message', { requestId: 'timed-out-id', text: 'same' })
  deliver({ type: 'ack', requestId: 'timed-out-id', ok: true, data: 'accepted' })
  await expect(retry).resolves.toBe('accepted')
  expect(window.researchBridge.send).toHaveBeenCalledTimes(2)
})
