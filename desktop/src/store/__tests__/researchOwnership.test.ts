import { beforeEach, expect, it } from 'vitest'
import { useSessionStore } from '../useSessionStore'

const host = (runId: string | null) => ({ enabled: true, streamId: 'ownership-stream',
  session: { sessionId: 'ownership-root', file: 'root.jsonl', cwd: 'C:/fixture' },
  messages: [], stats: {}, contextUsage: {}, historyVersion: 'v1', lastEventSeq: 100,
  run: runId ? { id: runId, status: 'active', phase: 'executing' } : null,
})
beforeEach(() => {
  useSessionStore.setState({ researchBinding: null, researchCards: {}, researchPendingCreationRequestId: null })
})

it('keeps current ownership when an older discipline notice names another run on the same stream', () => {
  useSessionStore.getState().bindResearchConversation(host('r_current'))
  useSessionStore.getState().handleResearchBridgeMessage({ seq: 50, sessionId: 'ownership-root', streamId: 'ownership-stream',
    event: { type: 'message_end', message: { role: 'custom', customType: 'research-discipline',
      details: { run_id: 'r_old' } } } })
  expect(useSessionStore.getState().researchBinding?.runId).toBe('r_current')
})

it('does not adopt a stale discipline notice belonging to a different pending creation request', () => {
  useSessionStore.getState().bindResearchConversation(host(null))
  useSessionStore.getState().queueResearchMessage('new-start', 'New question')
  useSessionStore.getState().handleResearchBridgeMessage({ seq: 100, sessionId: 'ownership-root', streamId: 'ownership-stream',
    event: { type: 'message_end', message: { role: 'custom', customType: 'research-discipline',
      details: { run_id: 'r_old', requestId: 'old-start' } } } })
  expect(useSessionStore.getState().researchBinding?.runId).toBeNull()
  expect(useSessionStore.getState().researchPendingCreationRequestId).toBe('new-start')
})

const otherWorkspace = (sessionId: string, streamId: string) => ({ ...host(null), streamId,
  session: { sessionId, file: `${sessionId}.jsonl`, cwd: `C:/${sessionId}` } })

it('lets the user reopen a run whose binding was retired by an automatic switch', () => {
  const workspaceA = otherWorkspace('root-a', 'stream-a')
  useSessionStore.getState().bindResearchConversation(workspaceA)
  useSessionStore.getState().bindResearchConversation(otherWorkspace('root-b', 'stream-b'), true)
  // A late event-driven rebind to the retired host stays fenced, so the live host keeps its own transcript.
  useSessionStore.getState().bindResearchConversation(workspaceA)
  expect(useSessionStore.getState().researchBinding?.sessionId).toBe('root-b')
  // Opening that run from history is the user's own decision and must land on workspace A.
  useSessionStore.getState().bindResearchConversation(workspaceA, true)
  expect(useSessionStore.getState().researchBinding?.sessionId).toBe('root-a')
})

it('settles a reconciled unconfirmed send so its retry stays reachable', () => {
  useSessionStore.getState().bindResearchConversation(host(null))
  useSessionStore.getState().queueResearchMessage('stuck-start', 'New question')
  expect(useSessionStore.getState().researchPendingCreationRequestId).toBe('stuck-start')
  useSessionStore.getState().unconfirmResearchMessage('stuck-start', '研究请求超时', true, true)
  const row = useSessionStore.getState().researchConversation.messages.find(message => message.requestId === 'stuck-start')
  expect(row).toMatchObject({ deliveryStatus: 'unconfirmed', deliveryReconciled: true })
  // The retry finder refuses a row while a creation is still pending under this binding.
  expect(useSessionStore.getState().researchPendingCreationRequestId).toBeNull()
})
