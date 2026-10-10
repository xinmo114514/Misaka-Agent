import { beforeEach, expect, it, vi } from 'vitest'
import { useSessionStore } from '../useSessionStore'

const control = vi.hoisted(() => vi.fn())
const research = vi.hoisted(() => vi.fn())
const cancelStartup = vi.hoisted(() => vi.fn())
vi.mock('../../lib/researchBridge', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/researchBridge')>(),
  executeResearchControl: control,
  requestResearch: research,
}))
vi.mock('../../lib/startComposerResearch', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/startComposerResearch')>(),
  cancelResearchStartup: cancelStartup,
}))
const host = (streamId?: string) => ({ enabled: true, streamId,
  session: { sessionId: 'control-root', file: 'root.jsonl', cwd: 'C:/fixture' },
  messages: [], stats: {}, contextUsage: {}, historyVersion: 'v1', lastEventSeq: 10,
  run: { id: 'r_control', status: 'active', phase: 'executing' }, isIdle: false, isStreaming: true,
})

beforeEach(() => {
  control.mockReset().mockResolvedValue(undefined)
  research.mockReset().mockResolvedValue(host('old-stream'))
  cancelStartup.mockReset().mockReturnValue(true)
  useSessionStore.setState({ agentMode: 'research', researchBinding: null, researchCards: {}, researchConnectionError: null })
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

it('adopts the reconnected stop host and accepts its terminal event without clearing pending stop on ACK', async () => {
  control.mockImplementation(async (_type, input) => { input.onBound?.(host('new-stream')) })
  useSessionStore.getState().requestResearchStop()
  await vi.waitFor(() => expect(control).toHaveBeenCalledOnce())
  expect(useSessionStore.getState().researchBinding?.streamId).toBe('new-stream')
  expect(useSessionStore.getState().researchConversation.isAborting).toBe(true)
  useSessionStore.getState().handleResearchBridgeMessage({ sessionId: 'control-root', streamId: 'new-stream', seq: 11,
    event: { type: 'message_end', message: { role: 'custom', customType: 'research-final', content: 'Stopped',
      details: { run_id: 'r_control', result: { status: 'stopped' } } } } })
  expect(useSessionStore.getState().researchConversation.isAborting).toBe(false)
})

it('preserves the current stream and a pending stop when a compatible snapshot omits streamId', () => {
  useSessionStore.setState(state => ({ researchConversation: { ...state.researchConversation, isAborting: true } }))
  useSessionStore.getState().bindResearchConversation(host())
  expect(useSessionStore.getState().researchBinding?.streamId).toBe('old-stream')
  expect(useSessionStore.getState().researchConversation.isAborting).toBe(true)
})
