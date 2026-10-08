import { beforeEach, expect, it, vi } from 'vitest'
import { startComposerResearch } from './startComposerResearch'
const mocks = vi.hoisted(() => ({ request: vi.fn(), research: vi.fn(), host: vi.fn(), sinks: new Set<(message: any) => void>() }))
vi.mock('./bridge', () => ({ request: mocks.request, newRequestId: () => 'input-1' }))
vi.mock('./researchBridge', () => ({ requestResearch: mocks.research,
  addResearchSink: (sink: (message: any) => void) => { mocks.sinks.add(sink); return () => mocks.sinks.delete(sink) },
}))
const defaults = { max_depth: 2, parallel: 2, sister_parallel: 3, max_followups: 1, max_revisions: 1, max_nodes: 12, plan_approval: true }
const snapshot = { enabled: true, session: { file: 'root.jsonl', sessionId: 'research-session', cwd: 'C:/project' },
  messages: [], historyVersion: 'v1', lastEventSeq: 0, run: null, stats: {}, contextUsage: {} }
function started() {
  for (const sink of mocks.sinks) sink({ sessionId: 'research-session', seq: 2, event: {
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
    text: 'Compare evidence', sessionId: 'research-session', requestId: 'input-1', limits: { ...defaults, plan_approval: false },
  }, 180_000)
  expect(mocks.research).toHaveBeenCalledWith('set_permission_mode', { mode: 'bypassPermissions' })
  expect(result.runId).toBe('new-run')
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
it('waits for actual creation after acceptance', async () => {
  mocks.research.mockResolvedValue({ accepted: true, mode: 'start' })
  let completed = false
  const pending = startComposerResearch({ question: 'Question', workspace: 'C:/project' }).then(() => { completed = true })
  await vi.waitFor(() => expect(mocks.research).toHaveBeenCalledWith('send_research_message', expect.anything(), 180_000))
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
    expect(mocks.research.mock.calls.find(call => call[0] === 'send_research_message')?.[2]).toBe(180_000)
  } finally { vi.useRealTimers() }
})

