import type { ChatMessage, MessageBlock, ToolCall } from '../types/session'
import type { BridgeEventEnvelope } from '../types/global'
import { assistantBlocks, contentText, getMessageBlocks, projectMessage } from './messageBlocks'

export interface ConversationState {
  currentSessionId: string
  messages: ChatMessage[]
  isStreaming: boolean
  isAborting: boolean
  streamingMessageId: string | null
  lastEventSeq: number
}

const conversationEvents = new Set([
  'agent_start', 'agent_end', 'agent_settled', 'message_start', 'message_update', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'entry_appended',
])

function updateTool(messages: ChatMessage[], id: string, update: (call: ToolCall) => ToolCall): ChatMessage[] {
  return messages.map(message => {
    if (message.role !== 'assistant') return message
    let changed = false
    const blocks = getMessageBlocks(message).map(block => {
      if (block.type !== 'toolCall' || block.toolCall.id !== id) return block
      changed = true
      return { ...block, toolCall: update(block.toolCall) }
    })
    return changed ? projectMessage(message, blocks) : message
  })
}

function resultFields(raw: any) {
  const value = raw?.result
  return {
    result: value && typeof value === 'object' && 'content' in value ? value.content : value,
    details: value && typeof value === 'object' ? value.details : undefined,
  }
}

function ensureAssistant(state: ConversationState, raw: any, seq: number): { messages: ChatMessage[]; id: string } {
  const current = state.messages.find(m => m.id === state.streamingMessageId)
  if (current?.role === 'assistant') return { messages: state.messages, id: current.id }
  const id = `assistant-${state.currentSessionId}-${seq}`
  return { messages: [...state.messages, { id, role: 'assistant', content: '', blocks: [], timestamp: raw?.timestamp ?? Date.now(), isStreaming: true }], id }
}

export function reduceConversationEvent(state: ConversationState, envelope: BridgeEventEnvelope): ConversationState {
  const ev = envelope.event
  if (!conversationEvents.has(ev.type)) return state
  if (state.currentSessionId && envelope.sessionId && envelope.sessionId !== state.currentSessionId) return state
  if (envelope.seq <= state.lastEventSeq) return state
  let next = { ...state, lastEventSeq: envelope.seq }
  const raw = ev.message ?? {}

  if (ev.type === 'agent_start') return { ...next, isStreaming: true }
  // agent_end is an inner-loop boundary; retries and queued continuations may still follow.
  if (ev.type === 'agent_end') return next
  if (ev.type === 'agent_settled') {
    const messages = next.messages.map(message => {
      if (message.role !== 'assistant') return message
      const blocks = getMessageBlocks(message).map(block => {
        if (block.type === 'toolCall') {
          const tc = block.toolCall
          return tc.status === 'pending' || tc.status === 'running'
            ? { ...block, toolCall: { ...tc, status: 'cancelled' as const } } : block
        }
        return { ...block, isStreaming: false }
      })
      return projectMessage({ ...message, isStreaming: false }, blocks)
    })
    return { ...next, messages, isStreaming: false, isAborting: false, streamingMessageId: null }
  }

  if (ev.type === 'entry_appended') {
    const entry = ev.entry
    if (entry?.type !== 'message' || !entry.message) return next
    const source = entry.message
    const match = [...next.messages].reverse().find(m => m.role === source.role && m.timestamp === source.timestamp && !m.entryId)
    if (match) next.messages = next.messages.map(m => m.id === match.id ? { ...m, entryId: entry.id } : m)
    return next
  }

  if (ev.type === 'tool_execution_start' || ev.type === 'tool_execution_update' || ev.type === 'tool_execution_end') {
    next.messages = updateTool(next.messages, ev.toolCallId, tc => {
      if (ev.type === 'tool_execution_end') {
        const fields = resultFields(ev)
        return { ...tc, ...fields, partialResult: undefined, status: ev.isError ? 'error' : 'success', error: ev.isError ? contentText(fields.result) : undefined }
      }
      // Delayed starts/partial outputs must never reopen a completed call.
      if (tc.status === 'success' || tc.status === 'error' || tc.status === 'cancelled') return tc
      return { ...tc, arguments: ev.args ?? tc.arguments, status: 'running', ...(ev.type === 'tool_execution_update' ? { partialResult: ev.partialResult } : {}) }
    })
    return next
  }

  if (ev.type === 'message_end' && raw.role === 'toolResult') {
    next.messages = updateTool(next.messages, raw.toolCallId, tc => ({
      ...tc, status: raw.isError ? 'error' : 'success', result: raw.content,
      details: raw.details ?? tc.details, partialResult: undefined, error: raw.isError ? contentText(raw.content) : undefined,
    }))
    return next
  }

  if ((ev.type === 'message_start' || ev.type === 'message_end') && raw.role === 'user') {
    const text = contentText(raw.content)
    const images = Array.isArray(raw.content)
      ? raw.content.filter((block: any) => block?.type === 'image').map((block: any) => ({ type: 'image' as const, mimeType: String(block.mimeType || 'image/png'), data: String(block.data || '') }))
      : []
    const match = next.messages.find(m => m.role === 'user' && m.content === text && m.timestamp === raw.timestamp && !m.optimistic && !m.submissionError)
      ?? next.messages.find(m => m.role === 'user' && m.content === text && m.optimistic)
    if (match) next.messages = next.messages.map(m => m.id === match.id ? { ...m, ...(images.length && !m.images?.length ? { images } : {}), optimistic: false, timestamp: raw.timestamp ?? m.timestamp } : m)
    else next.messages = [...next.messages, { id: `user-${next.currentSessionId}-${envelope.seq}`, role: 'user', content: text, ...(images.length ? { images } : {}), timestamp: raw.timestamp ?? Date.now() }]
    return next
  }

  if (ev.type === 'message_end' && raw.role === 'custom') {
    const custom: ChatMessage = {
      id: `custom-${next.currentSessionId}-${envelope.seq}`, role: 'custom', content: contentText(raw.content),
      customType: raw.customType ?? '', details: raw.details ?? {}, display: raw.display !== false, timestamp: raw.timestamp ?? Date.now(),
    }
    return { ...next, messages: [...next.messages, custom] }
  }

  if (ev.type === 'message_start' && raw.role === 'assistant') {
    const current = next.messages.find(m => m.id === next.streamingMessageId)
    // Bind the optimistic empty placeholder once; never recycle a finalized reply.
    const canBind = current?.isStreaming && getMessageBlocks(current).length === 0
    const owner = canBind ? { messages: next.messages, id: current!.id } : ensureAssistant({ ...next, streamingMessageId: null }, raw, envelope.seq)
    return {
      ...next, messages: owner.messages.map(m => m.id === owner.id ? { ...m, timestamp: raw.timestamp ?? m.timestamp, isStreaming: true } : m),
      streamingMessageId: owner.id, isStreaming: true,
    }
  }

  if (ev.type === 'message_update') {
    if (!next.isStreaming || next.isAborting) return next
    const ae = ev.assistantMessageEvent
    if (!ae || typeof ae.contentIndex !== 'number') return next
    const snapshot = ev.message ?? ae.partial ?? {}
    const current = next.messages.find(m => m.id === next.streamingMessageId)
    // A late snapshot/delta for a closed message cannot steal the active stream owner.
    if (snapshot.timestamp !== undefined && current && snapshot.timestamp !== current.timestamp) return next
    const owner = ensureAssistant(next, snapshot, envelope.seq)
    next = { ...next, messages: owner.messages, streamingMessageId: owner.id }
    next.messages = next.messages.map(message => {
      if (message.id !== owner.id) return message
      const index = ae.contentIndex
      let blocks = getMessageBlocks(message)
      const hasSnapshot = Array.isArray(snapshot.content) && snapshot.content[index] !== undefined
      if (hasSnapshot) blocks = assistantBlocks(message.id, snapshot.content, blocks, index)
      else {
        blocks = blocks.map(b => b.type === 'toolCall' ? b : { ...b, isStreaming: false })
        const existing = blocks.find(b => b.contentIndex === index)
        let block: MessageBlock | undefined
        const common = { id: `${message.id}:block:${index}`, contentIndex: index, isStreaming: true }
        if (ae.type.startsWith('text_')) {
          block = { ...common, type: 'text', text: ae.type === 'text_end' ? ae.content ?? '' : (existing?.type === 'text' ? existing.text : '') + (ae.delta ?? '') }
        } else if (ae.type.startsWith('thinking_')) {
          block = { ...common, type: 'thinking', thinking: ae.type === 'thinking_end' ? ae.content ?? '' : (existing?.type === 'thinking' ? existing.thinking : '') + (ae.delta ?? '') }
        } else if (ae.type === 'toolcall_start') {
          const known = existing?.type === 'toolCall' ? existing.toolCall : undefined
          block = { ...common, type: 'toolCall', toolCall: {
            ...known, id: ae.id || known?.id || `${message.id}:pending:${index}`,
            name: ae.toolName || known?.name || 'tool', arguments: known?.arguments ?? {}, status: known?.status ?? 'pending',
          } }
        } else if (ae.type === 'toolcall_delta' && existing?.type === 'toolCall') {
          const partialArguments = (existing.toolCall.partialArguments ?? '') + (ae.delta ?? '')
          let args = existing.toolCall.arguments
          try { args = JSON.parse(partialArguments) } catch { /* An unfinished argument JSON remains text until complete. */ }
          block = { ...existing, toolCall: { ...existing.toolCall, partialArguments, arguments: args } }
        } else if (ae.type === 'toolcall_end' && ae.toolCall) {
          block = assistantBlocks(message.id, [{ ...ae.toolCall, type: 'toolCall' }], blocks)[0]
          if (block) block = { ...block, id: common.id, contentIndex: index }
        }
        if (block) blocks = [...blocks.filter(b => b.contentIndex !== index), block].sort((a, b) => a.contentIndex - b.contentIndex)
      }
      if (ae.type.endsWith('_end')) blocks = blocks.map(b => b.contentIndex === index && b.type !== 'toolCall' ? { ...b, isStreaming: false } : b)
      return projectMessage({ ...message, isStreaming: true }, blocks)
    })
    return next
  }

  if (ev.type === 'message_end' && raw.role === 'assistant') {
    const activeId = next.streamingMessageId
    const active = next.messages.find(m => m.id === activeId)
    let ownerId = activeId
    if (raw.timestamp !== undefined && (!active || active.timestamp !== raw.timestamp)) {
      ownerId = [...next.messages].reverse().find(m => m.role === 'assistant' && m.timestamp === raw.timestamp)?.id ?? null
    }
    const owner = ensureAssistant({ ...next, streamingMessageId: ownerId }, raw, envelope.seq)
    next.messages = owner.messages.map(message => {
      if (message.id !== owner.id) return message
      let blocks = assistantBlocks(message.id, raw.content, getMessageBlocks(message))
      if (raw.stopReason === 'aborted' || raw.stopReason === 'error') {
        // An interrupted provider can return an empty/truncated final snapshot. Keep the
        // already-visible prefix and calls instead of replacing the whole answer with nothing.
        const prior = getMessageBlocks(message)
        const complete = new Map(prior.map(b => [b.contentIndex, b]))
        for (const block of blocks) {
          const old = complete.get(block.contentIndex)
          const truncatedText = block.type === 'text' && old?.type === 'text' && old.text.startsWith(block.text)
          const truncatedThinking = block.type === 'thinking' && old?.type === 'thinking' && old.thinking.startsWith(block.thinking)
          if (!truncatedText && !truncatedThinking) complete.set(block.contentIndex, block)
        }
        blocks = [...complete.values()].sort((a,b) => a.contentIndex-b.contentIndex).map(b => b.type === 'toolCall' ? b : { ...b, isStreaming:false })
        blocks = blocks.map(b => b.type === 'toolCall' && (b.toolCall.status === 'pending' || b.toolCall.status === 'running')
          ? { ...b, toolCall: { ...b.toolCall, status: 'cancelled' as const } } : b)
      }
      return projectMessage({
        ...message, isStreaming: false, timestamp: raw.timestamp ?? message.timestamp,
        stopReason: raw.stopReason, errorMessage: raw.errorMessage,
        tokens: raw.usage ? { input: raw.usage.input, output: raw.usage.output, total: raw.usage.totalTokens } : undefined,
      }, blocks)
    })
    return { ...next, streamingMessageId: activeId === owner.id ? null : activeId }
  }
  return next
}
