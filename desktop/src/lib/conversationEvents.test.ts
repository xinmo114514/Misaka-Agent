import { describe, expect, it, vi } from 'vitest'
import { reduceConversationEvent, type ConversationState } from './conversationEvents'
import type { BridgeEventEnvelope } from '../types/global'
import type { ChatMessage, ToolCall } from '../types/session'

const envelope = (seq: number, event: Record<string, any>): BridgeEventEnvelope => ({ seq, sessionId: 's1', event } as BridgeEventEnvelope)
const toolBlock = (toolCall: ToolCall) => ({ type: 'toolCall' as const, id: 'm1:block:0', contentIndex: 0, toolCall })
const start = (over: Partial<ConversationState> = {}): ConversationState => ({
  currentSessionId: 's1', isStreaming: true, isAborting: false, streamingMessageId: 'm1', lastEventSeq: 0,
  messages: [{ id: 'm1', role: 'assistant', content: '', timestamp: 1, isStreaming: true, blocks: [toolBlock({ id: 'c1', name: 'bash', status: 'pending' })] } as ChatMessage],
  ...over,
})
const onlyCall = (state: ConversationState) => (state.messages[0].blocks![0] as { toolCall: ToolCall }).toolCall

describe('tool call clock', () => {
  it('stamps the first real start and never re-bases it on a replayed event', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      let state = reduceConversationEvent(start(), envelope(1, { type: 'tool_execution_start', toolCallId: 'c1', args: { command: 'ls' } }))
      expect(onlyCall(state)).toMatchObject({ status: 'running', startedAt: 1_000 })
      vi.setSystemTime(4_000)
      state = reduceConversationEvent(state, envelope(2, { type: 'tool_execution_start', toolCallId: 'c1', args: { command: 'ls' } }))
      expect(onlyCall(state).startedAt).toBe(1_000)
    } finally { vi.useRealTimers() }
  })

  it('freezes the end and refuses to reopen a settled call', () => {
    vi.useFakeTimers()
    try {
      const base = start({ messages: [{ ...start().messages[0], blocks: [toolBlock({ id: 'c1', name: 'bash', status: 'running', startedAt: 500 })] } as ChatMessage] })
      vi.setSystemTime(2_300)
      let state = reduceConversationEvent(base, envelope(1, { type: 'tool_execution_end', toolCallId: 'c1', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } }))
      expect(onlyCall(state)).toMatchObject({ status: 'success', startedAt: 500, endedAt: 2_300 })
      state = reduceConversationEvent(state, envelope(2, { type: 'tool_execution_update', toolCallId: 'c1', partialResult: 'late' }))
      expect(onlyCall(state)).toMatchObject({ status: 'success', endedAt: 2_300 })
    } finally { vi.useRealTimers() }
  })

  it('ends a call the transcript never saw running without inventing a start', () => {
    const state = reduceConversationEvent(start(), envelope(1, { type: 'tool_execution_end', toolCallId: 'c1', isError: true, result: 'boom' }))
    expect(onlyCall(state).status).toBe('error')
    expect(onlyCall(state).startedAt).toBeUndefined()
    expect(onlyCall(state).endedAt).toBeTypeOf('number')
  })

  it('closes an interrupted call with its own terminal timestamp', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(9_000)
      const base = start({ messages: [{ ...start().messages[0], blocks: [toolBlock({ id: 'c1', name: 'bash', status: 'running', startedAt: 8_000 })] } as ChatMessage] })
      const state = reduceConversationEvent(base, envelope(1, { type: 'agent_settled' }))
      expect(onlyCall(state)).toMatchObject({ status: 'cancelled', endedAt: 9_000 })
    } finally { vi.useRealTimers() }
  })

  it('leaves a restored transcript without any clock alone', () => {
    const restored = start({ isStreaming: false, messages: [{ id: 'h1', role: 'assistant', content: '', timestamp: 1, entryId: 'e1', blocks: [toolBlock({ id: 'c9', name: 'read', status: 'success' })] } as ChatMessage] })
    expect(onlyCall(restored).startedAt).toBeUndefined()
    expect(onlyCall(restored).endedAt).toBeUndefined()
  })
})
