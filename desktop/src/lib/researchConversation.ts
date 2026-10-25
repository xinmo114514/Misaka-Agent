import type { BridgeEventEnvelope } from '../types/global'
import type { ChatMessage } from '../types/session'
import type { ResearchRunCard, ResearchHostSnapshot } from '../types/research'
import { reduceConversationEvent, type ConversationState } from './conversationEvents'
import { contentText, normalizeChatMessage } from './messageBlocks'
import { applyResearchNoticeToCard } from './researchCards'

export function emptyResearchConversation(): ConversationState {
  return { currentSessionId: '', messages: [], isStreaming: false, isAborting: false, streamingMessageId: null, lastEventSeq: 0 }
}

/** A same-request startup success retires only startup diagnostics, never run execution errors. */
export function clearResearchStartupFailure(message: ChatMessage): ChatMessage {
  const startup = message.errorStage === 'startup' || message.errorStage === 'recruitment' ||
    (!message.errorStage && message.researchSubmission && !message.researchSubmission.runId)
  if (!startup) return message
  return { ...message, executionError: undefined, submissionError: undefined, errorDetails: undefined,
    errorCode: undefined, errorStage: undefined, researchNeedsConfiguration: undefined,
    deliveryRetryable: undefined, deliveryReconciled: undefined }
}

export function clearResearchStartupRequest(state: ConversationState, requestId?: string): ConversationState {
  if (!requestId) return state
  return { ...state, messages: state.messages.map(message => message.role === 'user' && message.requestId === requestId
    ? clearResearchStartupFailure(message) : message) }
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
    if (message.researchSubmission) {
      const input = message.researchSubmission
      message.researchSubmission = Object.freeze({ ...input, ...(input.limits ? { limits: Object.freeze({ ...input.limits }) } : {}) })
    }
    const question = researchUserText(message)
    if (question === null && message.role !== 'user') return message
    const failed = message.deliveryStatus === 'failed' || message.deliveryStatus === 'unconfirmed'
    return { ...message, role: 'user', content: question ?? message.content, deliveryStatus: failed ? message.deliveryStatus : 'created', optimistic: false,
      ...(message.requestId || message.details?.requestId ? { requestId: message.requestId || message.details?.requestId } : {}) }
  })
}

/** Snapshot absence is not rejection: preserve accepted but not-yet-persisted sends. */
export function reconcileResearchPendingHistory(history: ChatMessage[], local: ChatMessage[], receipts: ResearchHostSnapshot['submissionReceipts'] = [], hasRun = false): ChatMessage[] {
  const candidates = local.filter(message => message.role === 'user' && (message.optimistic || message.deliveryStatus === 'failed' || message.researchSubmission))
  const matched = new Set<string>()
  const rows = history.map(message => {
    if (message.role !== 'user') return message
    const requestId = message.requestId || message.details?.requestId
    const match = candidates.find(row => !matched.has(row.id) && (requestId ? row.requestId === requestId : row.content === message.content))
    if (!match) return message
    matched.add(match.id)
    const failed = message.deliveryStatus === 'failed' || message.deliveryStatus === 'unconfirmed'
    return { ...message, researchSubmission: message.researchSubmission ?? match.researchSubmission,
      researchDraft: match.researchDraft ?? message.researchDraft,
      executionError: message.executionError ?? (!hasRun && match.deliveryStatus !== 'failed' ? match.executionError : undefined),
      ...(failed ? { errorDetails: message.errorDetails ?? match.errorDetails, errorCode: message.errorCode ?? match.errorCode,
        errorStage: message.errorStage ?? match.errorStage, researchNeedsConfiguration: message.researchNeedsConfiguration ?? match.researchNeedsConfiguration,
        deliveryRetryable: message.deliveryRetryable ?? match.deliveryRetryable } : {}) }
  })
  return [...rows, ...candidates.filter(message => !matched.has(message.id))].map(message => {
    const receipt = receipts.find(item => item.requestId === message.requestId)
    if (receipt?.state === 'rejected' && receipt.errorStage === 'startup') return {
      ...message, optimistic: false,
      deliveryStatus: message.deliveryStatus === 'created' ? 'created' : 'accepted',
      deliveryRetryable: receipt.retryable ?? true, submissionError: undefined,
      executionError: receipt.error || message.executionError || '研究启动失败，原始问题已记录。',
    }
    if (receipt?.state === 'rejected') return { ...message, optimistic: false, deliveryStatus: 'failed',
      errorDetails: receipt.errorDetails ?? message.errorDetails, errorCode: receipt.errorCode ?? message.errorCode,
      errorStage: receipt.errorStage ?? message.errorStage, researchNeedsConfiguration: receipt.researchNeedsConfiguration ?? message.researchNeedsConfiguration,
      deliveryRetryable: receipt.retryable ?? message.deliveryRetryable ?? true,
      submissionError: receipt.error || message.submissionError || '研究消息已拒绝，请重试' }
    if (receipt?.state === 'prepared' || receipt?.state === 'unconfirmed') return { ...message, optimistic: true, deliveryStatus: 'unconfirmed', deliveryRetryable: false, deliveryReconciled: true, submissionError: undefined }
    if (receipt?.state === 'accepted' || receipt?.state === 'applied') return { ...message, optimistic: receipt.state === 'accepted', deliveryStatus: receipt.state === 'applied' ? 'created' : 'accepted', submissionError: undefined, deliveryReconciled: undefined,
      errorDetails: undefined, errorCode: undefined, errorStage: undefined, researchNeedsConfiguration: undefined, deliveryRetryable: undefined }
    return message.deliveryStatus === 'unconfirmed' ? { ...message, deliveryReconciled: true } : message
  })
}

export function reduceResearchConversationEvent(state: ConversationState, envelope: BridgeEventEnvelope): ConversationState {
  if (!state.currentSessionId || envelope.sessionId !== state.currentSessionId || envelope.seq <= state.lastEventSeq) return state
  const event = envelope.event
  const entryMessage = event.type === 'entry_appended' ? event.entry?.message : null
  const entryRequestId = entryMessage?.requestId || entryMessage?.details?.requestId
  if (entryRequestId && (entryMessage.role === 'user' || researchUserText(entryMessage) !== null)) {
    return { ...state, lastEventSeq: envelope.seq, messages: state.messages.map(message =>
      message.role === 'user' && message.requestId === entryRequestId && !message.entryId ? { ...message, entryId: event.entry.id } : message) }
  }
  const question = researchUserText(event.message ?? {})
  const projected = question !== null && (event.type === 'message_start' || event.type === 'message_end')
    ? { ...envelope, event: { ...event, message: { ...event.message, role: 'user', content: question } } }
    : envelope
  const requestId = event.message?.details?.requestId || event.message?.requestId || event.requestId
  const correlatedRow = projected.event.message?.role === 'user' && (event.type === 'message_start' || event.type === 'message_end') && requestId
    ? state.messages.find(message => message.role === 'user' && message.requestId === requestId) : undefined
  // Use the shared reducer's authoritative row conversion but reconcile its identity
  // by request ID: identical queued inputs are independent submissions.
  const identifiedUserEvent = Boolean(projected.event.message?.role === 'user' && requestId && (event.type === 'message_start' || event.type === 'message_end'))
  let next = reduceConversationEvent(identifiedUserEvent ? { ...state, messages: [] } : state, projected)
  if (identifiedUserEvent) {
    const authoritative = next.messages.find(message => message.role === 'user')
    if (authoritative) next = { ...next, messages: correlatedRow ? state.messages.map(message => message.id === correlatedRow.id
      ? { ...(event.message?.customType === 'research-question' ? clearResearchStartupFailure(message) : message),
        ...authoritative, id: message.id, requestId: message.requestId, optimistic: false, deliveryStatus: 'created', submissionError: undefined } : message)
      : [...state.messages, { ...authoritative, requestId, optimistic: false, deliveryStatus: 'created' }] }
  }
  // Non-conversation notices share the same ordered host stream too.
  if (next.lastEventSeq !== envelope.seq) next = { ...next, lastEventSeq: envelope.seq }
  if ((event.type === 'message_start' || event.type === 'message_end') && (event.message?.role === 'user' || question !== null)) {
    const questionRow = question === null ? null : [...next.messages].reverse().find(message =>
      message.role === 'user' && !message.optimistic && !message.submissionError && message.content === question &&
      (!requestId || message.requestId === requestId) &&
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
    (event.message.customType === 'research-final' || event.message.customType === 'research-error' || event.message.customType === 'research-clarification')) {
    // The background research driver can finish without a model agent_settled event.
    // When research-error / final / clarification arrives, the run is no longer streaming.
    next = {
      ...next,
      isStreaming: false,
      isAborting: false,
      streamingMessageId: null,
      messages: next.messages.map(m => m.isStreaming ? { ...m, isStreaming: false } : m),
    }
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

/**
 * A failure that happened *after* the intent was taken but before (or instead of) the run it
 * describes. The question is already recorded, so it is an execution failure to retry, never a
 * submission that failed to send. Recruitment failures before native ingress do not imply
 * acceptance: those retain failed delivery and their original startup envelope.
 */
export function isResearchStartupFailure(error: { accepted?: boolean; stage?: string; errorStage?: string } | null | undefined): boolean {
  if (!error) return false
  return Boolean(error.accepted) || error.stage === 'startup' || error.errorStage === 'startup'
}
