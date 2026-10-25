import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ read: vi.fn(), control: vi.fn() }))
vi.mock('../../lib/bridge', async original => ({ ...await original<typeof import('../../lib/bridge')>(), request: io.read }))
vi.mock('../../lib/researchBridge', async original => ({ ...await original<typeof import('../../lib/researchBridge')>(), executeResearchControl: io.control }))

import { useSessionStore } from '../useSessionStore'
import { useResearchStopStore } from '../useResearchStopStore'
import { beginResearchStop, clearResearchStop, resetResearchStopTimers, unconfirmResearchStop } from '../../lib/researchStop'

const target = { kind: 'run' as const, runId: 'orphan', workspace: 'C:/original', rootSession: 'C:/sessions/root.jsonl' }
const detail = (extra: Record<string, unknown> = {}) => ({
  run: { id: 'orphan', question: 'Q', workspace: 'C:/original', rootSession: target.rootSession,
    status: 'stopping', phase: 'active', driving: false, nodes: 1, tasks: 1, ...extra },
  graph: { run: 'orphan', question: 'Q', status: 'stopping', phase: 'active', nodes: [] },
})

beforeEach(() => {
  resetResearchStopTimers()
  useResearchStopStore.setState({ byRun: {} })
  io.read.mockReset().mockResolvedValue(detail())
  io.control.mockReset().mockResolvedValue(undefined)
  useSessionStore.setState({ researchBinding: null, researchBindings: {}, researchCards: {
    orphan: { runId: 'orphan', question: 'Q', workspace: 'C:/original', status: 'stopping', phase: 'active', tasks: [], updatedAt: 1 },
  }, researchRuns: [], researchConnectionError: null })
})
afterEach(resetResearchStopTimers)

it('takes the per-run lock before refreshing, then settles the captured original target', async () => {
  let finish!: (value: ReturnType<typeof detail>) => void
  io.read.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  useSessionStore.getState().requestResearchStop(target)
  useSessionStore.getState().requestResearchStop(target)
  expect(io.read).toHaveBeenCalledOnce()
  expect(io.control).not.toHaveBeenCalled()
  expect(useResearchStopStore.getState().byRun.orphan?.phase).toBe('pending')
  useSessionStore.setState({ currentWorkspace: 'C:/different', researchBinding: null })
  finish(detail())
  await vi.waitFor(() => expect(io.control).toHaveBeenCalledOnce())
  expect(io.control).toHaveBeenCalledWith('stop_research', expect.objectContaining({ runId: 'orphan', workspace: 'C:/original', sessionFile: target.rootSession }))
  expect(useResearchStopStore.getState().byRun.orphan?.phase).toBe('pending')
})

it.each([
  { id: 'different' }, { workspace: 'C:/other' }, { rootSession: 'C:/sessions/other.jsonl' },
  { rootSession: null },
])('rejects a refreshed target that changed ownership: %j', async changed => {
  io.read.mockResolvedValue(detail(changed))
  useSessionStore.getState().requestResearchStop(target)
  await vi.waitFor(() => expect(useResearchStopStore.getState().byRun.orphan?.phase).toBe('failed'))
  expect(io.control).not.toHaveBeenCalled()
})

it('updates an already stopped result without resending stop or reopening research', async () => {
  io.read.mockResolvedValue(detail({ status: 'stopped', driving: false }))
  useSessionStore.getState().requestResearchStop(target)
  await vi.waitFor(() => expect(useSessionStore.getState().researchCards.orphan.status).toBe('stopped'))
  expect(io.control).not.toHaveBeenCalled()
  expect(useResearchStopStore.getState().byRun.orphan).toBeUndefined()
})

it.each([true, undefined])('a stopped run with driving=%s stays unconfirmed, never invents rest', async driving => {
  io.read.mockResolvedValue(detail({ status: 'stopped', driving }))
  useSessionStore.getState().requestResearchStop(target)
  await vi.waitFor(() => expect(useResearchStopStore.getState().byRun.orphan?.phase).toBe('unconfirmed'))
  expect(io.control).not.toHaveBeenCalled()
})

it('refresh failure stays visible and allows a new deliberate retry', async () => {
  io.read.mockRejectedValueOnce(new Error('read failed'))
  useSessionStore.getState().requestResearchStop(target)
  await vi.waitFor(() => expect(useResearchStopStore.getState().byRun.orphan?.phase).toBe('failed'))
  expect(useResearchStopStore.getState().byRun.orphan?.error).toContain('read failed')
  expect(io.control).not.toHaveBeenCalled()
  useSessionStore.getState().requestResearchStop(target)
  await vi.waitFor(() => expect(io.control).toHaveBeenCalledOnce())
})

it('an unconfirmed request in the current conversation can retry despite its old abort flag', async () => {
  useSessionStore.setState({ researchBinding: { sessionId: 'root', sessionFile: target.rootSession,
    workspace: target.workspace, runId: 'orphan' }, researchConversation: { currentSessionId: 'root',
    messages: [], isStreaming: false, isAborting: true, streamingMessageId: null, lastEventSeq: 0 } })
  const attempt = beginResearchStop('orphan')!
  unconfirmResearchStop('orphan', attempt, 'no reply')
  useSessionStore.getState().requestResearchStop()
  await vi.waitFor(() => expect(io.control).toHaveBeenCalledOnce())
  expect(io.read).toHaveBeenCalledOnce()
})

it('a stopped final notice without lease evidence keeps the stop pending', async () => {
  const owner = { sessionId: 'root', sessionFile: target.rootSession, workspace: target.workspace, runId: 'orphan', streamId: 'stream' }
  useSessionStore.setState({ researchBinding: owner, researchConversation: { currentSessionId: 'root',
    messages: [], isStreaming: false, isAborting: true, streamingMessageId: null, lastEventSeq: 0 } })
  beginResearchStop('orphan')
  useSessionStore.getState().handleResearchBridgeMessage({ sessionId: 'root', streamId: 'stream', seq: 1,
    event: { type: 'message_end', message: { role: 'custom', customType: 'research-final', content: 'Partial report', details: { run_id: 'orphan', result: { status: 'stopped' } } } } })
  expect(useResearchStopStore.getState().byRun.orphan?.phase).toBe('pending')
})

it('accepts the original Windows host despite harmless path casing and separators', async () => {
  io.control.mockImplementation(async (_type, input) => input.onBound({ enabled: true,
    session: { sessionId: 'root', file: 'c:\\SESSIONS\\ROOT.jsonl', cwd: 'c:\\ORIGINAL' },
    run: { id: 'orphan', status: 'stopping', phase: 'active' } }))
  useSessionStore.getState().requestResearchStop(target)
  await vi.waitFor(() => expect(io.control).toHaveBeenCalledOnce())
  expect(useResearchStopStore.getState().byRun.orphan?.phase).toBe('pending')
})

it('accepts the same Windows drive root with either slash style and casing', async () => {
  io.read.mockResolvedValue(detail({ workspace: 'C:/' }))
  useSessionStore.getState().requestResearchStop({ ...target, workspace: 'c:\\' })
  await vi.waitFor(() => expect(io.control).toHaveBeenCalledOnce())
})

it('normal stop dispatches also carry a fence tied to their own pending attempt', async () => {
  useSessionStore.setState(state => ({ researchCards: { orphan: { ...state.researchCards.orphan, status: 'active' } } }))
  useSessionStore.getState().requestResearchStop(target)
  await vi.waitFor(() => expect(io.control).toHaveBeenCalledOnce())
  const input = io.control.mock.calls[0][1]
  expect(input.isCurrent?.()).toBe(true)
  clearResearchStop('orphan')
  expect(input.isCurrent?.()).toBe(false)
})

it.each(['bound', 'background'])('late %s stop errors cannot overwrite a newer attempt', async surface => {
  let rejectOld!: (reason: Error) => void
  io.control.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject }))
  useSessionStore.setState(state => ({ researchCards: { orphan: { ...state.researchCards.orphan, status: 'active' } },
    ...(surface === 'bound' ? { researchBinding: { sessionId: 'root', runId: 'orphan', workspace: target.workspace, sessionFile: target.rootSession } } : {}),
    researchConversation: { currentSessionId: 'root', messages: [], isStreaming: false, isAborting: false, streamingMessageId: null, lastEventSeq: 0 } }))
  const stop = () => useSessionStore.getState().requestResearchStop(surface === 'bound' ? undefined : target)
  stop()
  clearResearchStop('orphan')
  useSessionStore.setState(state => ({ researchConversation: { ...state.researchConversation, isAborting: false } }))
  stop()
  await vi.waitFor(() => expect(io.control).toHaveBeenCalledTimes(2))
  rejectOld(new Error('stale stop error'))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(useResearchStopStore.getState().byRun.orphan?.phase).toBe('pending')
  expect(useSessionStore.getState().researchConnectionError).not.toBe('stale stop error')
  expect(useSessionStore.getState().researchCards.orphan.error).not.toBe('stale stop error')
  if (surface === 'bound') expect(useSessionStore.getState().researchConversation.isAborting).toBe(true)
})
