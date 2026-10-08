import type { BridgeEventEnvelope } from '../types/global'
import type { ChatMessage } from '../types/session'
import type { ResearchRunCard } from '../types/research'
import { reduceConversationEvent, type ConversationState } from './conversationEvents'
import { contentText, normalizeChatMessage } from './messageBlocks'
import { applyResearchNoticeToCard } from './researchCards'

export function emptyResearchConversation(): ConversationState {
  return { currentSessionId: '', messages: [], isStreaming: false, isAborting: false, streamingMessageId: null, lastEventSeq: 0 }
}

function questionText(message: { customType?: string; details?: Record<string, any> }): string | null {
  return message.customType === 'research-question' && typeof message.details?.question === 'string'
    ? message.details.question : null
}

function researchUserText(message: { customType?: string; details?: Record<string, any>; content?: unknown }): string | null {
  if (message.customType !== 'research-input') return questionText(message)
  const text = message.details?.text ?? message.details?.question
  return typeof text === 'string' ? text : contentText(message.content)
}

/** A backend question notice is itself the persisted user intent, not a fabricated echo. */
export function projectResearchHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(raw => {
    const message = normalizeChatMessage(raw)
    const question = researchUserText(message)
    if (question === null && message.role !== 'user') return message
    return { ...message, role: 'user', content: question ?? message.content, deliveryStatus: 'created', optimistic: false,
      ...(message.requestId || message.details?.requestId ? { requestId: message.requestId || message.details?.requestId } : {}) }
  })
}

/** Snapshot absence is not rejection: preserve accepted but not-yet-persisted sends. */
export function reconcileResearchPendingHistory(history: ChatMessage[], local: ChatMessage[]): ChatMessage[] {
  const pending = local.filter(message => message.role === 'user' && message.optimistic && !message.submissionError)
  const matched = new Set<string>()
  for (const message of history) {
    if (message.role !== 'user') continue
    const requestId = message.requestId || message.details?.requestId
    const match = pending.find(row => !matched.has(row.id) && (requestId ? row.requestId === requestId : row.content === message.content))
    if (match) matched.add(match.id)
  }
  return [...history, ...pending.filter(message => !matched.has(message.id))]
}

export function reduceResearchConversationEvent(state: ConversationState, envelope: BridgeEventEnvelope): ConversationState {
  if (!state.currentSessionId || envelope.sessionId !== state.currentSessionId || envelope.seq <= state.lastEventSeq) return state
  const event = envelope.event
  const question = researchUserText(event.message ?? {})
  const projected = question !== null && (event.type === 'message_start' || event.type === 'message_end')
    ? { ...envelope, event: { ...event, message: { ...event.message, role: 'user', content: question } } }
    : envelope
  const requestId = event.message?.details?.requestId || event.message?.requestId || event.requestId
  const correlatedRow = projected.event.message?.role === 'user' && (event.type === 'message_start' || event.type === 'message_end') && requestId
    ? state.messages.find(message => message.role === 'user' && message.requestId === requestId) : undefined
  // Use the shared reducer's authoritative row conversion but reconcile its identity
  // by request ID: identical queued inputs are independent submissions.
  let next = reduceConversationEvent(correlatedRow ? { ...state, messages: [] } : state, projected)
  if (correlatedRow) {
    const authoritative = next.messages.find(message => message.role === 'user')
    if (authoritative) next = { ...next, messages: state.messages.map(message => message.id === correlatedRow.id
      ? { ...message, ...authoritative, id: message.id, requestId: message.requestId, optimistic: false, deliveryStatus: 'created', submissionError: undefined } : message) }
  }
  // Non-conversation notices share the same ordered host stream too.
  if (next.lastEventSeq !== envelope.seq) next = { ...next, lastEventSeq: envelope.seq }
  if ((event.type === 'message_start' || event.type === 'message_end') && (event.message?.role === 'user' || question !== null)) {
    const questionRow = question === null ? null : [...next.messages].reverse().find(message =>
      message.role === 'user' && !message.optimistic && !message.submissionError && message.content === question &&
      (event.message?.timestamp === undefined || message.timestamp === event.message.timestamp))
    next = { ...next, messages: next.messages.map(message => {
      if (message.role !== 'user' || message.optimistic || message.submissionError) return message
      return { ...message, deliveryStatus: 'created', ...(message.id === questionRow?.id
        ? { customType: event.message.customType, details: event.message.details } : {}) }
    }) }
  }
  if (event.type === 'entry_appended' && researchUserText(event.entry?.message ?? {}) !== null) {
    const raw = event.entry.message
    next = { ...next, messages: next.messages.map(message => message.role === 'user' && message.customType === raw.customType && message.timestamp === raw.timestamp && !message.entryId
      ? { ...message, entryId: event.entry.id } : message) }
  }
  if (event.type === 'message_end' && event.message?.role === 'custom' &&
    (event.message.customType === 'research-final' || event.message.customType === 'research-error' || event.message.customType === 'research-clarification') &&
    !next.streamingMessageId) {
    // The background research driver can finish without a model agent_settled event.
    // A genuinely live assistant remains owned by the shared conversation reducer.
    next = { ...next, isStreaming: false, isAborting: false }
  }
  return next
}

export function researchNoticeRunId(message: { details?: Record<string, any> }): string {
  return String(message.details?.run_id || message.details?.runId || '')
}

/** Rebuild the same run projection from live or persisted genuine notices. */
export function hydrateResearchHistoryCards(existing: Record<string, ResearchRunCard>, messages: ChatMessage[]): Record<string, ResearchRunCard> {
  const cards = { ...existing }
  let question = ''
  let workspace: string | undefined
  for (const message of messages) {
    if (message.customType === 'research-question') {
      question = questionText(message) ?? question
      workspace = message.details?.workspace || workspace
    }
    if (!message.customType?.startsWith('research-') || message.customType === 'research-input') continue
    const runId = researchNoticeRunId(message)
    if (!runId) continue
    const prev = cards[runId]
    cards[runId] = applyResearchNoticeToCard(prev, message)
    if (!cards[runId].question && question) cards[runId] = { ...cards[runId], question }
    if (!cards[runId].workspace && workspace) cards[runId] = { ...cards[runId], workspace }
  }
  return cards
}

export function isResearchRunActive(status?: string): boolean {
  return Boolean(status && !['done', 'closed', 'stopped', 'partial', 'failed', 'error', 'cancelled', 'aborted', 'waiting_input'].includes(status))
}
