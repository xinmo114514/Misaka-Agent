import { beforeEach, expect, it, vi } from 'vitest'
import { useSessionStore } from '../useSessionStore'
import { useResearchStopStore } from '../useResearchStopStore'
import { resetResearchStopTimers } from '../../lib/researchStop'
import { observeResearchStop } from '../../lib/researchStopObservation'

const control = vi.hoisted(() => vi.fn())
const research = vi.hoisted(() => vi.fn())
const cancelStartup = vi.hoisted(() => vi.fn())
const read = vi.hoisted(() => vi.fn())
vi.mock('../../lib/bridge', async original => ({ ...await original<typeof import('../../lib/bridge')>(), request: read }))
vi.mock('../../lib/researchBridge', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/researchBridge')>(),
  executeResearchControl: control,
  requestResearch: research,
}))
vi.mock('../../lib/startComposerResearch', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/startComposerResearch')>(),
  cancelResearchStartup: cancelStartup,
}))
const host = (streamId?: string, run?: { id: string; status: string; phase: string } | null) => ({ enabled: true, streamId,
  session: { sessionId: 'control-root', file: 'root.jsonl', cwd: 'C:/fixture' },
  messages: [], stats: {}, contextUsage: {}, historyVersion: 'v1', lastEventSeq: 10,
  run: run === null ? null : (run ?? { id: 'r_control', status: 'active', phase: 'executing' }),
  isIdle: false, isStreaming: true,
})

beforeEach(() => {
  control.mockReset().mockResolvedValue(undefined)
  research.mockReset().mockResolvedValue(host('old-stream'))
  cancelStartup.mockReset().mockReturnValue(true)
  read.mockReset().mockResolvedValue({ run: { id: 'r_control', question: 'Q', workspace: 'C:/fixture', rootSession: 'root.jsonl',
    status: 'active', phase: 'executing', nodes: 1, tasks: 0, driving: false }, graph: { nodes: [] } })
  resetResearchStopTimers()
  useResearchStopStore.setState({ byRun: {} })
  useSessionStore.setState({ agentMode: 'research', researchBinding: null, researchCards: {},
    researchBindings: {}, researchConversations: {}, researchSnapshots: {}, researchRuns: [], researchConnectionError: null })
  useSessionStore.getState().bindResearchConversation(host('old-stream'))
})

it('stops the real run instead of cancelling the start when the creation notice was missed', async () => {
  // The binding never learned its run id, which is exactly the state that used to turn the
  // user's stop into a startup cancel while a research was already running on the board.
  useSessionStore.setState(state => ({ researchBinding: { ...state.researchBinding!, runId: null } }))
  useSessionStore.getState().requestResearchStop()
  await vi.waitFor(() => expect(control).toHaveBeenCalledOnce())
  expect(control.mock.calls[0][0]).toBe('stop_research')
  expect(control.mock.calls[0][1].runId).toBe('r_control')
  expect(cancelStartup).not.toHaveBeenCalled()
  expect(useSessionStore.getState().researchBinding?.runId).toBe('r_control')
})

it('only cancels the startup when the host confirms no run exists yet', async () => {
  research.mockResolvedValue({ ...host('old-stream'), run: null })
  useSessionStore.setState(state => ({ researchBinding: { ...state.researchBinding!, runId: null } }))
  useSessionStore.getState().requestResearchStop()
  await vi.waitFor(() => expect(cancelStartup).toHaveBeenCalledWith('control-root'))
  expect(control).not.toHaveBeenCalled()
})

it('adopts the reconnected stop host and keeps the wait pending through the ACK', async () => {
  control.mockImplementation(async (_type, input) => { input.onBound?.(host('new-stream')) })
  useSessionStore.getState().requestResearchStop()
  await vi.waitFor(() => expect(control).toHaveBeenCalledOnce())
  expect(useSessionStore.getState().researchBinding?.streamId).toBe('new-stream')
  expect(useSessionStore.getState().researchConversation.isAborting).toBe(true)
  // The ACK means the command landed -- not that the run stopped: the wait stays pending.
  await vi.waitFor(() => expect(control.mock.calls[0][1]).toBeDefined())
  const entry = useResearchStopStore.getState().byRun.r_control
  expect(entry?.phase).toBe('pending')
  useSessionStore.getState().handleResearchBridgeMessage({ sessionId: 'control-root', streamId: 'new-stream', seq: 11,
    event: { type: 'message_end', message: { role: 'custom', customType: 'research-final', content: 'Stopped',
      details: { run_id: 'r_control', result: { status: 'stopped' } } } } })
  expect(useSessionStore.getState().researchConversation.isAborting).toBe(false)
  expect(useResearchStopStore.getState().byRun.r_control?.phase).toBe('pending')
  const release = observeResearchStop()
  try {
    useSessionStore.setState({ researchRuns: [{ id: 'r_control', question: 'Q', workspace: 'C:/fixture',
      status: 'stopped', phase: 'stopped', nodes: 1, tasks: 0, driving: false }] })
    expect(useResearchStopStore.getState().byRun.r_control).toBeUndefined()
  } finally { release() }
})

it('dedupes a repeat stop on the same run: one dispatch while the wait is pending', async () => {
  useSessionStore.getState().requestResearchStop()
  await vi.waitFor(() => expect(control).toHaveBeenCalledOnce())
  useSessionStore.getState().requestResearchStop()
  useSessionStore.getState().requestResearchStop({ kind: 'run', runId: 'r_control', workspace: 'C:/fixture' })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(control).toHaveBeenCalledOnce()
})

it('marks the wait failed on a rejection, and a later attempt may dispatch again', async () => {
  control.mockRejectedValueOnce(new Error('研究桥接通道尚未就绪'))
  useSessionStore.getState().requestResearchStop()
  await vi.waitFor(() => expect(useResearchStopStore.getState().byRun.r_control?.phase).toBe('failed'))
  expect(useResearchStopStore.getState().byRun.r_control?.error).toBe('研究桥接通道尚未就绪')
  expect(useSessionStore.getState().researchConversation.isAborting).toBe(false)
  // A deliberate retry takes the released lock and sends again.
  control.mockClear()
  control.mockResolvedValue(undefined)
  useSessionStore.getState().requestResearchStop()
  await vi.waitFor(() => expect(control).toHaveBeenCalledOnce())
})

it('settles a background run from its owning session\'s final notice', async () => {
  useSessionStore.setState({ researchBindings: { 'other-root': { sessionId: 'other-root', sessionFile: 'other.jsonl',
    workspace: 'C:/other', runId: 'r_back', streamId: 'back-stream' } } })
  useSessionStore.getState().requestResearchStop({ kind: 'run', runId: 'r_back', workspace: 'C:/other', rootSession: 'other.jsonl' })
  await vi.waitFor(() => expect(control).toHaveBeenCalledOnce())
  expect(useResearchStopStore.getState().byRun.r_back?.phase).toBe('pending')
  useSessionStore.getState().handleResearchBridgeMessage({ sessionId: 'other-root', streamId: 'back-stream', seq: 4,
    event: { type: 'message_end', message: { role: 'custom', customType: 'research-final', content: 'Stopped',
      details: { run_id: 'r_back', result: { status: 'stopped' } } } } })
  expect(useResearchStopStore.getState().byRun.r_back?.phase).toBe('pending')
  const release = observeResearchStop()
  try {
    useSessionStore.setState({ researchRuns: [{ id: 'r_back', question: 'Q', workspace: 'C:/other',
      status: 'stopped', phase: 'stopped', nodes: 1, tasks: 0, driving: false }] })
    expect(useResearchStopStore.getState().byRun.r_back).toBeUndefined()
  } finally { release() }
})

it('preserves the current stream and a pending stop when a compatible snapshot omits streamId', () => {
  useSessionStore.setState(state => ({ researchConversation: { ...state.researchConversation, isAborting: true } }))
  useSessionStore.getState().bindResearchConversation(host())
  expect(useSessionStore.getState().researchBinding?.streamId).toBe('old-stream')
  expect(useSessionStore.getState().researchConversation.isAborting).toBe(true)
})
