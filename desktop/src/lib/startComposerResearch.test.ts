import { beforeEach, expect, it, vi } from 'vitest'
import { cancelResearchStartup, startComposerResearch } from './startComposerResearch'
const mocks = vi.hoisted(() => ({ request: vi.fn(), research: vi.fn(), host: vi.fn(), sinks: new Set<(message: any) => void>() }))
vi.mock('./bridge', () => ({ request: mocks.request, newRequestId: () => 'input-1' }))
vi.mock('./researchBridge', () => ({ requestResearch: mocks.research,
  addResearchSink: (sink: (message: any) => void) => { mocks.sinks.add(sink); return () => mocks.sinks.delete(sink) },
  isResearchRequestTimeout: (error: unknown) => error instanceof Error && error.name === 'ResearchRequestTimeoutError',
}))
const defaults = { max_depth: 2, parallel: 2, sister_parallel: 3, max_followups: 1, max_revisions: 1, max_nodes: 12, plan_approval: true }
const snapshot = { enabled: true, session: { file: 'root.jsonl', sessionId: 'research-session', cwd: 'C:/project' },
  messages: [], historyVersion: 'v1', lastEventSeq: 0, run: null, stats: {}, contextUsage: {} }
function started(streamId?: string) {
  for (const sink of mocks.sinks) sink({ sessionId: 'research-session', streamId, seq: 2, event: {
    type: 'message_end', message: { role: 'custom', customType: 'research-discipline', details: { run_id: 'new-run' } },
  } })
}
beforeEach(() => {
  mocks.sinks.clear()
  mocks.request.mockReset().mockImplementation(async type => type === 'get_active_research_runs' ? { runs: [] } : { defaults, sisters: [] })
  mocks.host.mockReset().mockResolvedValue(snapshot)
  mocks.research.mockReset().mockImplementation(async type => {
    if (type === 'send_research_message') queueMicrotask(started)
    if (type === 'get_research_host') return { ...snapshot, run: { id: 'new-run', status: 'active', phase: 'plan' } }
    return { accepted: true, mode: 'start' }
  })
  window.app = { ...window.app, startResearchBridge: mocks.host }
})
it('starts through unified ingress even with an empty expert directory', async () => {
  const onBound = vi.fn()
  const result = await startComposerResearch({ question: ' Compare evidence ', workspace: 'C:/project', requestId: 'input-1', onBound,
    model: { provider: 'provider', modelId: 'model' }, thinkingLevel: 'high' })
  expect(onBound).toHaveBeenCalledWith(snapshot)
  expect(mocks.research).toHaveBeenCalledWith('send_research_message', {
    text: 'Compare evidence', sessionId: 'research-session', requestId: 'input-1', limits: defaults,
  }, 650_000)
  expect(mocks.research).toHaveBeenCalledWith('set_permission_mode', { mode: 'bypassPermissions' })
  expect(result.runId).toBe('new-run')
})
it('keeps confirmed nine-field limits immutable and configures explicit role models before submission', async () => {
  const chosen = { ...defaults, max_depth: 5, context_threshold: .8, max_output_tokens: 2048 }
  await startComposerResearch({ question: 'Evidence', workspace: 'C:/project', requestId: 'roles-1',
    limits: chosen, model: { provider: 'sister-provider', modelId: 'sister-model' },
    lastOrderModel: { provider: 'lo-provider', modelId: 'lo-model' } })
  const sent = mocks.research.mock.calls.find(call => call[0] === 'send_research_message')?.[1]
  expect(sent.limits).toEqual(chosen)
  expect(mocks.research).toHaveBeenCalledWith('desktop_set_team_model', expect.objectContaining({ role: 'sister', provider: 'sister-provider', modelId: 'sister-model' }))
  expect(mocks.research).toHaveBeenCalledWith('desktop_set_team_model', expect.objectContaining({ role: 'last_order', provider: 'lo-provider', modelId: 'lo-model' }))
  expect(mocks.research).not.toHaveBeenCalledWith('set_model', expect.anything())
})
it.each(['sister', 'last_order'] as const)('blocks startup submission when %s role switch reports failed', async role => {
  mocks.research.mockImplementation(async type => {
    if (type === 'send_research_message') throw new Error('unexpected submission')
    if (type === 'desktop_set_team_model') return { modelBindings: { [role]: {
      effective: { provider: 'old', modelId: 'old-model' }, target: null, epoch: 2, state: 'failed', error: 'Selected role unavailable',
    } } }
    return { accepted: true }
  })
  await expect(startComposerResearch({ question: 'Evidence', workspace: 'C:/project', requestId: `bad-${role}`,
    ...(role === 'sister' ? { model: { provider: 'new', modelId: 'new-model' } } : {
      lastOrderModel: { provider: 'new', modelId: 'new-model' },
    }) })).rejects.toThrow('Selected role unavailable')
  expect(mocks.research.mock.calls.some(call => call[0] === 'send_research_message')).toBe(false)
})
it('continues same owner without changing live model settings or starting another run', async () => {
  mocks.host.mockResolvedValue({ ...snapshot, run: { id: 'running', status: 'active', phase: 'plan' } })
  const binding = { sessionId: 'research-session', sessionFile: 'root.jsonl', workspace: 'C:/project', runId: 'running' }
  await startComposerResearch({ question: '只看公开文献', workspace: 'C:/project', binding, requestId: 'input-2' })
  expect(mocks.host).toHaveBeenCalledWith({ cwd: 'C:/project', sessionFile: 'root.jsonl' })
  expect(mocks.research).toHaveBeenCalledWith('send_research_message', { text: '只看公开文献', sessionId: 'research-session', runId: 'running', requestId: 'input-2' })
  expect(mocks.research).not.toHaveBeenCalledWith('set_model', expect.anything())
  expect(mocks.request).not.toHaveBeenCalledWith('get_research_options')
})
it('rejects fresh start when another research is active in the workspace', async () => {
  mocks.request.mockImplementation(async type => type === 'get_active_research_runs'
    ? { runs: [{ id: 'active-1', workspace: 'C:/project', question: '已在运行的研究' }] }
    : { defaults, sisters: [] })
  await expect(startComposerResearch({ question: '新的课题', workspace: 'C:/project', startNew: true }))
    .rejects.toThrow('当前项目已有研究正在运行中')
})

it('applies the picker selection when continuing a bound run', async () => {
  mocks.host.mockResolvedValue({ ...snapshot, run: { id: 'running', status: 'active', phase: 'plan' } })
  const binding = { sessionId: 'research-session', sessionFile: 'root.jsonl', workspace: 'C:/project', runId: 'running' }
  await startComposerResearch({ question: '追问', workspace: 'C:/project', binding, requestId: 'follow-1',
    model: { provider: 'other', modelId: 'fresh' }, thinkingLevel: 'high' })
  expect(mocks.research).toHaveBeenCalledWith('desktop_set_team_model', expect.objectContaining({ provider: 'other', modelId: 'fresh', action: 'switch' }))
  expect(mocks.research).not.toHaveBeenCalledWith('set_thinking', expect.anything())
  expect(mocks.research).not.toHaveBeenCalledWith('set_model', expect.anything())
  expect(mocks.research).toHaveBeenCalledWith('send_research_message', { text: '追问', sessionId: 'research-session', runId: 'running', requestId: 'follow-1' })
})
it('opens a fresh run instead of adopting a settled one when the caller declares a new research', async () => {
  mocks.host.mockResolvedValue({ ...snapshot, run: { id: 'finished', status: 'done', phase: 'done' } })
  const result = await startComposerResearch({ question: '新的课题', workspace: 'C:/project', requestId: 'new-1', startNew: true })
  const sent = mocks.research.mock.calls.find(call => call[0] === 'send_research_message')?.[1]
  expect(sent).not.toHaveProperty('runId')
  expect(sent).toMatchObject({ text: '新的课题', startNew: true, limits: defaults })
  expect(result.runId).toBe('new-run')
})

it('binds a fresh startup without the previous settled run so cancellation targets the new startup', async () => {
  mocks.host.mockResolvedValue({ ...snapshot, run: { id: 'r_old', status: 'done', phase: 'done' } })
  mocks.research.mockImplementation(async type => type === 'send_research_message' ? new Promise(() => {}) : { accepted: true })
  const onBound = vi.fn()
  const pending = startComposerResearch({ question: 'New question', workspace: 'C:/project', startNew: true, onBound })
  await vi.waitFor(() => expect(onBound).toHaveBeenCalledOnce())
  const projected = onBound.mock.calls[0][0]
  cancelResearchStartup('research-session')
  await expect(pending).rejects.toThrow('研究启动已取消')
  expect(projected.run).toBeNull()
  expect(mocks.research).toHaveBeenCalledWith('abort', { sessionId: 'research-session' })
  expect(mocks.research.mock.calls.some(call => call[0] === 'stop_research')).toBe(false)
})

it('does not confirm a fresh creation timeout from the previous settled run snapshot', async () => {
  vi.useFakeTimers()
  try {
    const oldHost = { ...snapshot, run: { id: 'r_old', status: 'done', phase: 'done' } }
    mocks.host.mockResolvedValue(oldHost)
    mocks.research.mockImplementation(async type => type === 'get_research_host' ? oldHost : { accepted: true })
    const pending = startComposerResearch({ question: 'New question', workspace: 'C:/project', startNew: true })
    const result = pending.then(() => ({ accepted: false, stage: 'unexpected-success' }), error => error)
    await vi.waitFor(() => expect(mocks.research).toHaveBeenCalledWith('send_research_message', expect.anything(), 650_000))
    await vi.advanceTimersByTimeAsync(650_000)
    expect(await result).toMatchObject({ accepted: true, stage: 'startup', name: 'ResearchStartupConfirmationTimeoutError' })
  } finally { vi.useRealTimers() }
})
it('keeps a retried fresh start away from the previous settled run', async () => {
  mocks.host.mockResolvedValue({ ...snapshot, run: { id: 'finished', status: 'done', phase: 'done' } })
  const submission = { text: '新的课题', sessionId: 'research-session', requestId: 'retry-1', startNew: true,
    limits: { ...defaults, plan_approval: false } }
  const result = await startComposerResearch({ question: '新的课题', workspace: 'C:/project', requestId: 'retry-1', submission })
  const sent = mocks.research.mock.calls.find(call => call[0] === 'send_research_message')?.[1]
  expect(sent).not.toHaveProperty('runId')
  // The startup timeout argument only exists while the run creation is still unconfirmed.
  expect(mocks.research).toHaveBeenCalledWith('send_research_message', expect.objectContaining({ startNew: true }), 650_000)
  expect(result.runId).toBe('new-run')
})

it('reports a completed host reconciliation instead of leaving the send checking forever', async () => {
  const timeout = new Error('研究请求超时')
  timeout.name = 'ResearchRequestTimeoutError'
  mocks.research.mockImplementation(async type => {
    if (type === 'send_research_message') return Promise.reject(timeout)
    if (type === 'get_research_host') return { ...snapshot, submissionReceipts: [] }
    return { accepted: true }
  })
  const onUnconfirmed = vi.fn()
  await expect(startComposerResearch({ question: 'New question', workspace: 'C:/project', startNew: true, onUnconfirmed }))
    .rejects.toBe(timeout)
  expect(onUnconfirmed).toHaveBeenLastCalledWith(timeout, true)
})

it('adopts a settled run when the caller does not declare a new research', async () => {
  mocks.host.mockResolvedValue({ ...snapshot, run: { id: 'finished', status: 'done', phase: 'done' } })
  await startComposerResearch({ question: '继续追问', workspace: 'C:/project', requestId: 'cont-1' })
  expect(mocks.research).toHaveBeenCalledWith('send_research_message', { text: '继续追问', sessionId: 'research-session', runId: 'finished', requestId: 'cont-1' })
})
it('waits for actual creation after acceptance', async () => {
  mocks.research.mockResolvedValue({ accepted: true, mode: 'start' })
  let completed = false
  const pending = startComposerResearch({ question: 'Question', workspace: 'C:/project' }).then(() => { completed = true })
  await vi.waitFor(() => expect(mocks.research).toHaveBeenCalledWith('send_research_message', expect.anything(), 650_000))
  expect(completed).toBe(false)
  started()
  await pending
  expect(mocks.sinks.size).toBe(0)
})
it('propagates real asynchronous startup errors', async () => {
  mocks.research.mockImplementation(async type => {
    if (type === 'send_research_message') queueMicrotask(() => {
      for (const sink of mocks.sinks) sink({ sessionId: 'research-session', event: {
        type: 'message_end', message: { role: 'custom', customType: 'research-progress', content: 'initialization failed', details: { stage: 'startup_error' } },
      } })
    })
    return { accepted: true, mode: 'start' }
  })
  await expect(startComposerResearch({ question: 'Question', workspace: 'C:/project' })).rejects.toThrow('initialization failed')
  expect(mocks.sinks.size).toBe(0)
})
it('retains owner and draft on reconnection errors', async () => {
  mocks.host.mockRejectedValue(new Error('owner offline'))
  await expect(startComposerResearch({ question: 'Question', workspace: 'C:/project' })).rejects.toThrow('owner offline')
  expect(mocks.research).not.toHaveBeenCalled()
})
it('validates a project before creating any runtime', async () => {
  await expect(startComposerResearch({ question: 'Question', workspace: '' })).rejects.toThrow('项目目录')
  expect(mocks.host).not.toHaveBeenCalled()
})

it('marks a timed-out input unconfirmed and reconciles it from host history', async () => {
  const timeout = Object.assign(new Error('send_research_message 没有回应'), {
    name: 'ResearchRequestTimeoutError', requestId: 'stable-id', requestType: 'send_research_message',
  })
  const persisted = { ...snapshot, run: { id: 'running', status: 'active', phase: 'executing' }, messages: [
    { id: 'persisted', role: 'user', content: 'same text', timestamp: 1, details: { requestId: 'stable-id' } },
  ] }
  mocks.host.mockResolvedValue({ ...snapshot, run: persisted.run })
  mocks.research.mockImplementation(async type => {
    if (type === 'send_research_message') throw timeout
    if (type === 'get_research_host') return persisted
    return { accepted: true }
  })
  const onBound = vi.fn()
  const onUnconfirmed = vi.fn()
  const result = await startComposerResearch({ question: 'same text', workspace: 'C:/project', requestId: 'stable-id',
    binding: { sessionId: 'research-session', sessionFile: 'root.jsonl', workspace: 'C:/project', runId: 'running' },
    onBound, onUnconfirmed })
  expect(onUnconfirmed).toHaveBeenCalledOnce()
  expect(onBound).toHaveBeenLastCalledWith(persisted)
  expect(result.messages[0]).toMatchObject({ details: { requestId: 'stable-id' } })
})

it('cancels an unconfirmed start on its own research host and releases the wait', async () => {
  let release!: (value: { accepted: boolean; mode: string }) => void
  const hanging = new Promise<{ accepted: boolean; mode: string }>(resolve => { release = resolve })
  mocks.research.mockImplementation(async type => {
    if (type === 'send_research_message') return hanging
    if (type === 'abort') return { accepted: false }
    return { accepted: true, mode: 'start' }
  })
  const pending = startComposerResearch({ question: 'Question', workspace: 'C:/project' })
  await vi.waitFor(() => expect(mocks.research).toHaveBeenCalledWith('send_research_message', expect.anything(), 650_000))
  expect(cancelResearchStartup('research-session')).toBe(true)
  await expect(pending).rejects.toThrow('研究启动已取消')
  expect(mocks.research).toHaveBeenCalledWith('abort', { sessionId: 'research-session' })
  release({ accepted: true, mode: 'start' })
  expect(cancelResearchStartup('research-session')).toBe(false)
})

it('cancels before a slow host resolves and never submits to the late host', async () => {
  let finishHost!: (host: typeof snapshot) => void
  const hostPending = new Promise<typeof snapshot>(resolve => { finishHost = resolve })
  mocks.host.mockReturnValue(hostPending)
  const onBound = vi.fn()
  const pending = startComposerResearch({ question: 'Question', workspace: 'C:/project',
    requestId: 'connecting-input', onBound })
  await vi.waitFor(() => expect(mocks.host).toHaveBeenCalledOnce())
  expect(cancelResearchStartup('connecting-input')).toBe(true)
  await expect(pending).rejects.toThrow('研究启动已取消')
  finishHost(snapshot)
  await hostPending
  expect(onBound).not.toHaveBeenCalled()
  expect(mocks.research).not.toHaveBeenCalled()
})

it('fences startup cancellation with the captured host stream', async () => {
  mocks.host.mockResolvedValue({ ...snapshot, streamId: 'startup-epoch' })
  mocks.research.mockImplementation(async type => type === 'send_research_message'
    ? new Promise(() => {}) : { accepted: true })
  const pending = startComposerResearch({ question: '研究问题', workspace: 'C:/project' })
  await vi.waitFor(() => expect(mocks.research).toHaveBeenCalledWith('send_research_message', expect.anything(), 650_000))
  expect(cancelResearchStartup('research-session')).toBe(true)
  await expect(pending).rejects.toThrow('研究启动已取消')
  expect(mocks.research).toHaveBeenCalledWith('abort', { sessionId: 'research-session', streamId: 'startup-epoch' })
})

it('keeps the first message pending through a real multi-turn team preparation budget', async () => {
  vi.useFakeTimers()
  try {
    let failure: unknown
    let complete = false
    mocks.research.mockImplementation(async type => {
      if (type === 'send_research_message') {
        await new Promise(resolve => window.setTimeout(resolve, 45_000))
        started()
      }
      if (type === 'get_research_host') return { ...snapshot, run: { id: 'new-run', status: 'active', phase: 'plan' } }
      return { accepted: true, mode: 'start' }
    })
    const pending = startComposerResearch({ question: 'Compare evidence', workspace: 'C:/project' })
      .then(() => { complete = true }, error => { failure = error })
    await vi.advanceTimersByTimeAsync(35_000)
    expect(failure).toBeUndefined()
    expect(complete).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    await pending
    expect(failure).toBeUndefined()
    expect(complete).toBe(true)
    expect(mocks.research.mock.calls.find(call => call[0] === 'send_research_message')?.[2]).toBe(650_000)
  } finally { vi.useRealTimers() }
})


it('keeps acceptance and the valid owner snapshot when post-ack refresh fails', async () => {
  const refreshError = new Error('refresh offline')
  const onAccepted = vi.fn()
  mocks.research.mockImplementation(async type => {
    if (type === 'send_research_message') queueMicrotask(started)
    if (type === 'get_research_host') throw refreshError
    return { accepted: true, mode: 'start' }
  })
  const result = await startComposerResearch({ question: 'Question', workspace: 'C:/project', onAccepted })
  expect(result).toMatchObject({ ...snapshot, runId: 'new-run', syncError: refreshError.message })
  expect(onAccepted).toHaveBeenCalledOnce()
})

it.each([
  { session: { ...snapshot.session, sessionId: 'other-session' } },
  { session: snapshot.session, streamId: 'other-stream' },
])('does not apply a post-ack snapshot from another owner or stream: %j', async replacement => {
  const owner = { ...snapshot, streamId: 'owner-stream', run: { id: 'running', status: 'active', phase: 'plan' } }
  mocks.host.mockResolvedValue(owner)
  mocks.research.mockImplementation(async type => type === 'get_research_host'
    ? { ...owner, ...replacement, messages: [{ id: 'foreign', role: 'user', content: 'other', timestamp: 1 }] }
    : { accepted: true })
  const result = await startComposerResearch({ question: 'Question', workspace: 'C:/project' })
  expect(result.session.sessionId).toBe('research-session')
  expect(result.streamId).toBe('owner-stream')
  expect(result.messages).toEqual([])
  expect(result.runId).toBe('running')
  expect(result.syncError).toEqual(expect.any(String))
})

it('labels execution startup errors separately after the input is accepted', async () => {
  mocks.research.mockImplementation(async type => {
    if (type === 'send_research_message') queueMicrotask(() => {
      for (const sink of mocks.sinks) sink({ sessionId: 'research-session', event: {
        type: 'message_end', message: { role: 'custom', customType: 'research-progress', content: 'startup failed', details: { stage: 'startup_error' } },
      } })
    })
    return { accepted: true, mode: 'start' }
  })
  const onAccepted = vi.fn()
  await expect(startComposerResearch({ question: 'Question', workspace: 'C:/project', onAccepted }))
    .rejects.toMatchObject({ message: 'startup failed', stage: 'startup', accepted: true })
  expect(onAccepted).toHaveBeenCalledOnce()
})

it.each(['prepared', 'unconfirmed', 'rejected', 'missing'])('does not confirm persisted input intent with an authoritative %s receipt', async state => {
  const timeout = Object.assign(new Error('unconfirmed'), { name: 'ResearchRequestTimeoutError' })
  const owner = { ...snapshot, run: { id: 'running', status: 'active', phase: 'plan' } }
  mocks.host.mockResolvedValue(owner)
  mocks.research.mockImplementation(async type => {
    if (type === 'send_research_message') throw timeout
    if (type === 'get_research_host') return { ...owner,
      messages: [{ id: 'intent', role: 'custom', customType: 'research-input', content: 'Question', timestamp: 1, details: { requestId: 'stable-id' } }],
      submissionReceipts: state === 'missing' ? [] : [{ requestId: 'stable-id', state, runId: 'running' }],
    }
    return { accepted: true }
  })
  const onAccepted = vi.fn()
  await expect(startComposerResearch({ question: 'Question', workspace: 'C:/project', requestId: 'stable-id', onAccepted })).rejects.toBe(timeout)
  expect(onAccepted).not.toHaveBeenCalled()
})

it.each(['accepted', 'applied'])('reconciles an authoritative %s receipt without transcript intent', async state => {
  const timeout = Object.assign(new Error('unconfirmed'), { name: 'ResearchRequestTimeoutError' })
  mocks.research.mockImplementation(async type => {
    if (type === 'send_research_message') throw timeout
    if (type === 'get_research_host') return { ...snapshot, submissionReceipts: [{ requestId: 'stable-id', state, runId: 'receipt-run', mode: 'start' }] }
    return { accepted: true }
  })
  const onAccepted = vi.fn()
  const result = await startComposerResearch({ question: 'Question', workspace: 'C:/project', requestId: 'stable-id', onAccepted })
  expect(result.runId).toBe('receipt-run')
  expect(onAccepted).toHaveBeenCalledOnce()
})

it('captures an immutable exact submission at the first actual send', async () => {
  mocks.host.mockResolvedValue({ ...snapshot, streamId: 'stream-1' })
  mocks.research.mockImplementation(async type => {
    if (type === 'send_research_message') queueMicrotask(() => started('stream-1'))
    if (type === 'get_research_host') return { ...snapshot, streamId: 'stream-1', run: { id: 'new-run', status: 'active', phase: 'plan' } }
    return { accepted: true }
  })
  const onSubmission = vi.fn(input => {
    expect(mocks.research.mock.calls.some(call => call[0] === 'send_research_message')).toBe(false)
    expect(Object.isFrozen(input)).toBe(true)
    expect(Object.isFrozen(input.limits)).toBe(true)
  })
  await startComposerResearch({ question: ' Question ', workspace: 'C:/project', onSubmission })
  const captured = onSubmission.mock.calls[0][0]
  expect(captured).toEqual({ text: 'Question', sessionId: 'research-session', streamId: 'stream-1', requestId: 'input-1', limits: defaults })
  expect(onSubmission).toHaveBeenCalledOnce()
  expect(mocks.research).toHaveBeenCalledWith('send_research_message', captured, 650_000)
})

it('retries the original submission identity after a bound run appears and the transport reconnects', async () => {
  const stored = { text: ' original text ', sessionId: 'research-session', requestId: 'stable-id', streamId: 'old-stream', limits: { ...defaults, plan_approval: false } }
  mocks.host.mockResolvedValue({ ...snapshot, streamId: 'live-stream', run: { id: 'running', status: 'active', phase: 'plan' } })
  const onSubmission = vi.fn()
  await startComposerResearch({ question: 'changed question', workspace: 'C:/project', requestId: 'changed-id', submission: stored, onSubmission,
    binding: { sessionId: 'research-session', sessionFile: 'root.jsonl', workspace: 'C:/project', runId: 'running', streamId: 'old-stream' },
    model: { provider: 'new-provider', modelId: 'new-model' }, thinkingLevel: 'high' })
  const sent = mocks.research.mock.calls.find(call => call[0] === 'send_research_message')?.[1]
  expect(sent).toEqual({ text: ' original text ', sessionId: 'research-session', requestId: 'stable-id', streamId: 'live-stream', limits: { ...defaults, plan_approval: false } })
  expect(sent).not.toHaveProperty('runId')
  expect(stored.streamId).toBe('old-stream')
  expect(onSubmission).not.toHaveBeenCalled()
  // The picker's live selection is applied on the retry too; only the persisted
  // submission identity (question, run, limits) is replayed verbatim.
  expect(mocks.research).toHaveBeenCalledWith('desktop_set_team_model', expect.objectContaining({ provider: 'new-provider', modelId: 'new-model', action: 'switch' }))
  expect(mocks.research).not.toHaveBeenCalledWith('set_thinking', expect.anything())
  expect(mocks.request.mock.calls.map(call => call[0])).not.toContain('get_research_options')
})

it('retains an explicit original run id and limits on retry', async () => {
  const stored = { text: 'Original', sessionId: 'research-session', requestId: 'stable-id', runId: 'original-run', limits: { ...defaults, max_depth: 5 } }
  mocks.host.mockResolvedValue({ ...snapshot, run: { id: 'latest-run', status: 'active', phase: 'plan' } })
  await startComposerResearch({ question: '', workspace: 'C:/project', submission: stored })
  expect(mocks.research).toHaveBeenCalledWith('send_research_message', stored)
})

it('rejects retry on a different session before invoking the ingress', async () => {
  const submission = { text: 'Original', sessionId: 'old-session', requestId: 'stable-id' }
  await expect(startComposerResearch({ question: 'Question', workspace: 'C:/project', submission })).rejects.toThrow('研究会话')
  expect(mocks.research).not.toHaveBeenCalled()
})


it('routes an explicit backend unknown-delivery result through unconfirmed reconciliation', async () => {
  const unknownDelivery = Object.assign(new Error('delivery unknown'), { name: 'ResearchRequestError', retryable: false, errorCode: 'RESEARCH_DELIVERY_UNCONFIRMED' })
  const owner = { ...snapshot, run: { id: 'running', status: 'active', phase: 'plan' } }
  mocks.host.mockResolvedValue(owner)
  mocks.research.mockImplementation(async type => {
    if (type === 'send_research_message') throw unknownDelivery
    if (type === 'get_research_host') return { ...owner, submissionReceipts: [] }
    return { accepted: true }
  })
  const onUnconfirmed = vi.fn()
  await expect(startComposerResearch({ question: 'Question', workspace: 'C:/project', onUnconfirmed })).rejects.toBe(unknownDelivery)
  expect(onUnconfirmed).toHaveBeenCalledWith(unknownDelivery)
})

it('does not reconcile timeout receipts from a different transport stream', async () => {
  const timeout = Object.assign(new Error('unconfirmed'), { name: 'ResearchRequestTimeoutError' })
  const owner = { ...snapshot, streamId: 'current-stream', run: { id: 'running', status: 'active', phase: 'plan' } }
  mocks.host.mockResolvedValue(owner)
  mocks.research.mockImplementation(async type => {
    if (type === 'send_research_message') throw timeout
    if (type === 'get_research_host') return { ...owner, streamId: 'stale-stream', submissionReceipts: [{ requestId: 'input-1', state: 'accepted', runId: 'running' }] }
    return { accepted: true }
  })
  const onAccepted = vi.fn()
  const onBound = vi.fn()
  await expect(startComposerResearch({ question: 'Question', workspace: 'C:/project', onAccepted, onBound })).rejects.toBe(timeout)
  expect(onAccepted).not.toHaveBeenCalled()
  expect(onBound).toHaveBeenCalledOnce()
})

it('retries an original follow-up without waiting for a second run when the host run snapshot is delayed', async () => {
  const stored = { text: 'Follow up', sessionId: 'research-session', requestId: 'stable-id', runId: 'original-run' }
  mocks.research.mockImplementation(async type => type === 'get_research_host' ? snapshot : { accepted: true })
  const result = await startComposerResearch({ question: 'Question', workspace: 'C:/project', submission: stored })
  expect(result.runId).toBe('original-run')
  expect(mocks.research).toHaveBeenCalledWith('send_research_message', stored)
  expect(mocks.sinks.size).toBe(0)
})

it('waits for real creation when an accepted receipt has not acquired a run id yet', async () => {
  const timeout = Object.assign(new Error('unconfirmed'), { name: 'ResearchRequestTimeoutError' })
  mocks.research.mockImplementation(async type => {
    if (type === 'send_research_message') throw timeout
    if (type === 'get_research_host') return { ...snapshot, submissionReceipts: [{ requestId: 'input-1', state: 'accepted' }] }
    return { accepted: true }
  })
  const onAccepted = vi.fn()
  let complete = false
  const pending = startComposerResearch({ question: 'Question', workspace: 'C:/project', onAccepted }).then(result => { complete = true; return result })
  await vi.waitFor(() => expect(onAccepted).toHaveBeenCalledOnce())
  expect(complete).toBe(false)
  started()
  expect((await pending).runId).toBe('new-run')
})

it('ignores creation confirmations from an older stream of the same session', async () => {
  mocks.host.mockResolvedValue({ ...snapshot, streamId: 'live-stream' })
  mocks.research.mockImplementation(async type => type === 'get_research_host'
    ? { ...snapshot, streamId: 'live-stream', run: { id: 'new-run', status: 'active', phase: 'plan' } }
    : { accepted: true })
  let complete = false
  const onAccepted = vi.fn()
  const pending = startComposerResearch({ question: 'Question', workspace: 'C:/project', onAccepted }).then(result => { complete = true; return result })
  await vi.waitFor(() => expect(onAccepted).toHaveBeenCalledOnce())
  try {
    started('stale-stream')
    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(complete).toBe(false)
  } finally {
    started('live-stream')
    await pending
  }
})

it('captures run creation while restoring host permissions before the send acknowledgement', async () => {
  mocks.research.mockImplementation(async type => {
    if (type === 'set_permission_mode') started()
    if (type === 'get_research_host') return { ...snapshot, run: { id: 'new-run', status: 'active', phase: 'plan' } }
    return { accepted: true }
  })
  const pending = startComposerResearch({ question: 'Question', workspace: 'C:/project' })
  let complete = false
  void pending.then(() => { complete = true })
  try {
    await vi.waitFor(() => expect(complete).toBe(true), { timeout: 500 })
    expect((await pending).runId).toBe('new-run')
  } finally {
    // Release the old implementation's missed confirmation after proving the race.
    started()
    await pending
  }
  expect(mocks.sinks.size).toBe(0)
})

it('releases the early startup observer when permission restoration fails', async () => {
  const failure = new Error('permission restoration failed')
  let observed = false
  mocks.research.mockImplementation(async type => {
    if (type === 'set_permission_mode') {
      observed = mocks.sinks.size > 0
      throw failure
    }
    return { accepted: true }
  })
  await expect(startComposerResearch({ question: 'Question', workspace: 'C:/project' })).rejects.toBe(failure)
  expect(observed).toBe(true)
  expect(mocks.sinks.size).toBe(0)
  expect(cancelResearchStartup('research-session')).toBe(false)
})

it('cancels startup during permission restoration without sending an input', async () => {
  let restore!: () => void
  const restoring = new Promise<void>(resolve => { restore = resolve })
  mocks.research.mockImplementation(async type => {
    if (type === 'set_permission_mode') await restoring
    return { accepted: true }
  })
  const pending = startComposerResearch({ question: 'Question', workspace: 'C:/project' })
  const rejection = expect(pending).rejects.toThrow('研究启动已取消')
  await vi.waitFor(() => expect(mocks.research).toHaveBeenCalledWith('set_permission_mode', expect.anything()))
  const cancelledEarly = cancelResearchStartup('research-session')
  try {
    expect(cancelledEarly).toBe(true)
    await rejection
    expect(mocks.research.mock.calls.map(call => call[0])).not.toContain('send_research_message')
    expect(mocks.sinks.size).toBe(0)
  } finally {
    restore()
    if (!cancelledEarly) {
      await vi.waitFor(() => expect(mocks.research).toHaveBeenCalledWith('send_research_message', expect.anything(), 650_000))
      cancelResearchStartup('research-session')
    }
    await rejection
  }
})

it('reconciles a missing creation event from its trusted host before declaring startup timeout', async () => {
  vi.useFakeTimers()
  try {
    mocks.research.mockImplementation(async type => type === 'get_research_host'
      ? { ...snapshot, run: { id: 'durable-run', status: 'active', phase: 'plan' } }
      : { accepted: true })
    let result: Awaited<ReturnType<typeof startComposerResearch>> | undefined
    let failure: unknown
    const pending = startComposerResearch({ question: 'Question', workspace: 'C:/project' })
      .then(value => { result = value }, error => { failure = error })
    await vi.advanceTimersByTimeAsync(650_000)
    await pending
    expect(failure).toBeUndefined()
    expect(result?.runId).toBe('durable-run')
    expect(mocks.sinks.size).toBe(0)
  } finally { vi.useRealTimers() }
})

it('does not wait out the whole startup budget when the creation notice is missed', async () => {
  vi.useFakeTimers()
  try {
    // The run is durable on the board, so the host can still answer for it even though the
    // discipline notice never reached this renderer.
    mocks.research.mockImplementation(async type => type === 'get_research_host'
      ? { ...snapshot, run: { id: 'durable-run', status: 'active', phase: 'plan' } }
      : { accepted: true, mode: 'start' })
    let result: Awaited<ReturnType<typeof startComposerResearch>> | undefined
    const pending = startComposerResearch({ question: 'Question', workspace: 'C:/project' }).then(value => { result = value })
    // First reconciliation attempt is well inside the budget.
    await vi.advanceTimersByTimeAsync(3_000)
    await pending
    expect(result?.runId).toBe('durable-run')
    expect(mocks.sinks.size).toBe(0)
  } finally { vi.useRealTimers() }
})

it('reports startup failure as soon as the host says the run could not be created', async () => {
  mocks.research.mockImplementation(async type => {
    if (type === 'send_research_message') queueMicrotask(() => {
      for (const sink of mocks.sinks) sink({ sessionId: 'research-session', event: {
        type: 'message_end', message: { role: 'custom', customType: 'research-progress', content: '团队招募超时', details: { stage: 'startup_error' } },
      } })
    })
    return { accepted: true, mode: 'start' }
  })
  await expect(startComposerResearch({ question: 'Question', workspace: 'C:/project' })).rejects.toThrow('团队招募超时')
  expect(mocks.sinks.size).toBe(0)
})

it('stops polling once the run is confirmed, leaving no live reconciliation timer', async () => {
  vi.useFakeTimers()
  try {
    let result: Awaited<ReturnType<typeof startComposerResearch>> | undefined
    const pending = startComposerResearch({ question: 'Question', workspace: 'C:/project' }).then(value => { result = value })
    await vi.advanceTimersByTimeAsync(3_000)
    await pending
    const hostCalls = mocks.research.mock.calls.filter(call => call[0] === 'get_research_host').length
    await vi.advanceTimersByTimeAsync(600_000)
    expect(mocks.research.mock.calls.filter(call => call[0] === 'get_research_host').length).toBe(hostCalls)
    expect(result?.runId).toBe('new-run')
  } finally { vi.useRealTimers() }
})
it.each(['failed','switching','mismatch'])('blocks submission when team model acknowledgement is %s', async state => {
  mocks.host.mockResolvedValue({...snapshot,run:{id:'running',status:'active',phase:'plan'}})
  mocks.research.mockImplementation(async type => type === 'desktop_set_team_model' ? {modelBinding:{state:state === 'mismatch' ? 'ready' : state,effective:{provider:'old',modelId:'old'},target:{provider:'wanted',modelId:'wanted'},error:'model unavailable'}} : {accepted:true})
  const submission=vi.fn()
  await expect(startComposerResearch({question:'Do not admit while paused',workspace:'C:/project',binding:{sessionId:'research-session',sessionFile:'root.jsonl',workspace:'C:/project',runId:'running'},model:{provider:'wanted',modelId:'wanted'},requestId:'guard-model',onSubmission:submission})).rejects.toMatchObject({retryable:true,errorCode:'RESEARCH_MODEL_NOT_READY'})
  expect(mocks.research.mock.calls.some(([type])=>type==='send_research_message')).toBe(false)
  expect(submission).not.toHaveBeenCalled()
})
it('accepted resume message opens a new metadata control epoch before hydration', async () => {
 const {useSessionStore}=await import('../store/useSessionStore')
 useSessionStore.setState({researchCards:{running:{runId:'running',question:'Q',status:'stopped',phase:'stopped',tasks:[],updatedAt:1}}})
 mocks.host.mockResolvedValue({...snapshot,run:{id:'running',status:'stopped',phase:'stopped'}})
 mocks.research.mockImplementation(async type=>type==='send_research_message'?{accepted:true,mode:'resume',runId:'running'}: type==='get_research_host'?{...snapshot,run:{id:'running',status:'active',phase:'active'}}:{accepted:true})
 await startComposerResearch({question:'Resume',workspace:'C:/project',binding:{sessionId:'research-session',sessionFile:'root.jsonl',workspace:'C:/project',runId:'running'},requestId:'resume-message'})
 expect(useSessionStore.getState().researchCards.running.status).toBe('active')
 expect(useSessionStore.getState().researchCards.running.controlEpoch).toBe(1)
})
