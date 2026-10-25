import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore } from '../useSessionStore'
import type { BridgeMessage } from '../../types/global'

const SESSION = 'ingest-root'
const STREAM = 'ingest-stream'

function envelope(seq: number, event: Record<string, unknown>): BridgeMessage {
  return { seq, sessionId: SESSION, streamId: STREAM, event } as never
}

function snapshotEvent(timestamp: number, texts: string[], args: Record<string, Record<string, string>>): Record<string, unknown> {
  const entries = Object.entries(args)
  const content = [
    { type: 'text', text: texts.join('') },
    ...entries.map(([id, value]) => ({ type: 'toolCall', id, name: 'desktop_recruit_agent', arguments: value })),
  ]
  const last = entries[entries.length - 1]
  // The engine always pairs a snapshot with the assistant event it came from.
  return { type: 'message_update',
    assistantMessageEvent: last ? { type: 'toolcall_delta', contentIndex: entries.length, id: last[0], delta: '' }
      : { type: 'text_delta', contentIndex: 0, delta: texts.join('') },
    message: { role: 'assistant', timestamp, content } }
}

function snapshot(seq: number, timestamp: number, texts: string[], args: Record<string, Record<string, string>>): BridgeMessage {
  return envelope(seq, snapshotEvent(timestamp, texts, args))
}

beforeEach(() => {
  useSessionStore.setState({
    agentMode: 'research',
    researchBinding: { sessionId: SESSION, sessionFile: 'C:/research/root.jsonl', workspace: 'C:/research', runId: 'r_1', streamId: STREAM },
    researchConversation: { currentSessionId: SESSION, messages: [], isStreaming: false, isAborting: false, streamingMessageId: null, lastEventSeq: 0 },
    researchCards: {}, researchTeam: null, researchPendingCreationRequestId: null,
  })
})

describe('research event ingest through the store', () => {
  it('does not apply an event on the arrival task', () => {
    const store = useSessionStore.getState()
    store.ingestResearchBridgeMessage(envelope(1, { type: 'agent_start' }))
    expect(useSessionStore.getState().researchConversation.isStreaming).toBe(false)
    expect(useSessionStore.getState().researchConversation.lastEventSeq).toBe(0)
  })

  it('applies the same events in arrival order when the slice runs', async () => {
    useSessionStore.getState().ingestResearchBridgeMessage(envelope(1, { type: 'agent_start' }))
    useSessionStore.getState().ingestResearchBridgeMessage(envelope(2, { type: 'message_start',
      message: { role: 'assistant', content: [], timestamp: 500 } }))
    useSessionStore.getState().flushResearchIngest()
    const state = useSessionStore.getState().researchConversation
    expect(state.isStreaming).toBe(true)
    expect(state.messages).toHaveLength(1)
    expect(state.lastEventSeq).toBe(2)
  })

  it('keeps the newest of many snapshots of one message without losing earlier text', () => {
    const ingest = useSessionStore.getState().ingestResearchBridgeMessage
    ingest(envelope(1, { type: 'agent_start' }))
    ingest(envelope(2, { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 500 } }))
    // Six recruitment calls, streamed as whole-message snapshots that grow as they go.
    for (let seq = 3; seq < 33; seq += 1) {
      const args: Record<string, Record<string, string>> = {}
      for (let call = 0; call < Math.min(6, seq - 2); call += 1) args[`call-${call}`] = { name: `role-${call}`, instructions: 'x'.repeat(seq) }
      ingest(snapshot(seq, 500, ['招募六个角色。'], args))
    }
    ingest(envelope(33, { type: 'message_end', message: { role: 'assistant', timestamp: 500, stopReason: 'tool_use',
      content: [{ type: 'text', text: '招募六个角色。' },
        ...Array.from({ length: 6 }, (_unused, call) => ({ type: 'toolCall', id: `call-${call}`, name: 'desktop_recruit_agent', arguments: { name: `role-${call}` } }))] } }))
    useSessionStore.getState().flushResearchIngest()

    const state = useSessionStore.getState().researchConversation
    const row = state.messages.find(message => message.role === 'assistant')
    expect(row?.content).toBe('招募六个角色。')
    expect(row?.toolCalls).toHaveLength(6)
    expect((row?.toolCalls ?? []).map(call => call.id)).toEqual(['call-0', 'call-1', 'call-2', 'call-3', 'call-4', 'call-5'])
    expect(state.lastEventSeq).toBe(33)
  })

  it('finishes a call that failed validation without touching its siblings', () => {
    const ingest = useSessionStore.getState().ingestResearchBridgeMessage
    let seq = 0
    const send = (event: Record<string, unknown>) => ingest(envelope(++seq, event))
    send({ type: 'agent_start' })
    send({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 600 } })
    const ids = ['ok-1', 'bad-1', 'ok-2']
    // Each snapshot carries the whole message, so a later one still names the earlier calls.
    ids.forEach((_id, index) => send(snapshotEvent(600, ['规划中'],
      Object.fromEntries(ids.slice(0, index + 1).map(name => [name, { name }])))))
    for (const id of ids) send({ type: 'tool_execution_start', toolCallId: id, toolName: 'desktop_recruit_agent', args: { name: id } })
    send({ type: 'tool_execution_end', toolCallId: 'ok-1', toolName: 'desktop_recruit_agent', isError: false, result: { content: [{ type: 'text', text: 'registered' }] } })
    send({ type: 'tool_execution_end', toolCallId: 'bad-1', toolName: 'desktop_recruit_agent', isError: true,
      result: { content: [{ type: 'text', text: '1 validation error: responsible is not permitted' }] } })
    useSessionStore.getState().flushResearchIngest()
    send({ type: 'tool_execution_end', toolCallId: 'ok-2', toolName: 'desktop_recruit_agent', isError: false, result: { content: [{ type: 'text', text: 'registered' }] } })
    useSessionStore.getState().flushResearchIngest()

    const calls = useSessionStore.getState().researchConversation.messages.find(message => message.role === 'assistant')?.toolCalls ?? []
    expect(calls.map(call => call.status)).toEqual(['success', 'error', 'success'])
    expect(calls.find(call => call.id === 'bad-1')?.error).toContain('validation error')
  })

  it('answers an ack immediately instead of behind the queue', () => {
    useSessionStore.getState().queueResearchMessage('research-input-1', '一个课题')
    useSessionStore.getState().ingestResearchBridgeMessage(envelope(1, { type: 'agent_start' }))
    useSessionStore.getState().ingestResearchBridgeMessage({ type: 'ack', requestId: 'research-input-1', ok: true, sessionId: SESSION } as never)
    // No flush: the send's own result cannot wait behind a thousand streamed tokens.
    const row = useSessionStore.getState().researchConversation.messages.find(message => message.requestId === 'research-input-1')
    expect(row?.deliveryStatus).toBe('accepted')
  })

  it('lets an older stream never overwrite the current binding', async () => {
    const ingest = useSessionStore.getState().ingestResearchBridgeMessage
    ingest(envelope(1, { type: 'agent_start' }))
    useSessionStore.getState().flushResearchIngest()
    // The reader moved on: a late frame from the previous stream must be ignored, not queued in.
    useSessionStore.setState({ researchBinding: { sessionId: SESSION, sessionFile: 'C:/research/root.jsonl', workspace: 'C:/research', runId: 'r_1', streamId: 'other-stream' } })
    ingest(envelope(2, { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 900 } }))
    useSessionStore.getState().flushResearchIngest()
    expect(useSessionStore.getState().researchConversation.messages).toHaveLength(0)
  })
})
