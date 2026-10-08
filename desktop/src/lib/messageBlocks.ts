import type { ChatMessage, MessageBlock, ToolCall } from '../types/session'

/** Only old bridge transcripts without blocks require the historical layout fallback. */
export function getMessageBlocks(message: ChatMessage): MessageBlock[] {
  if (message.blocks) return message.blocks
  const blocks: MessageBlock[] = []
  const base = () => ({ id: `${message.id}:block:${blocks.length}`, contentIndex: blocks.length })
  if (message.thinking) blocks.push({ ...base(), type: 'thinking', thinking: message.thinking, isStreaming: Boolean(message.isStreaming && !message.content && !message.toolCalls?.length) })
  for (const toolCall of message.toolCalls ?? []) blocks.push({ ...base(), type: 'toolCall', toolCall })
  if (message.content) blocks.push({ ...base(), type: 'text', text: message.content, isStreaming: message.isStreaming })
  return blocks
}

export function projectMessage(message: ChatMessage, blocks: MessageBlock[]): ChatMessage {
  return {
    ...message, blocks,
    content: blocks.filter(b => b.type === 'text').map(b => b.text).join(''),
    thinking: blocks.filter(b => b.type === 'thinking').map(b => b.thinking).join(''),
    toolCalls: blocks.filter(b => b.type === 'toolCall').map(b => b.toolCall),
  }
}

export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(b => b?.type === 'text').map(b => b.text ?? '').join('')
}

/** Snapshots replace prose authoritatively while keeping execution facts matched by call ID. */
export function assistantBlocks(id: string, content: unknown, previous: MessageBlock[] = [], activeIndex?: number): MessageBlock[] {
  const source = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  const result: MessageBlock[] = []
  source.forEach((raw, contentIndex) => {
    const blockId = `${id}:block:${contentIndex}`
    if (raw?.type === 'text') {
      result.push({ type: 'text', id: blockId, contentIndex, text: String(raw.text ?? ''), isStreaming: activeIndex === contentIndex })
    } else if (raw?.type === 'thinking') {
      result.push({ type: 'thinking', id: blockId, contentIndex, thinking: String(raw.thinking ?? ''), isStreaming: activeIndex === contentIndex })
    } else if (raw?.type === 'toolCall') {
      const prior = previous.find(b => b.type === 'toolCall' && b.toolCall.id === raw.id)
      const known = prior?.type === 'toolCall' ? prior.toolCall : undefined
      const toolCall: ToolCall = {
        ...known, id: String(raw.id || `${id}:pending:${contentIndex}`), name: String(raw.name || 'tool'),
        arguments: raw.arguments ?? known?.arguments ?? {}, status: known?.status ?? 'pending', partialArguments: undefined,
      }
      result.push({ type: 'toolCall', id: blockId, contentIndex, toolCall })
    }
  })
  return result
}

export function normalizeChatMessage(raw: any): ChatMessage {
  const message: ChatMessage = { ...raw, id: String(raw.id), content: raw.content || '', timestamp: raw.timestamp ?? Date.now(), isStreaming: false }
  if (message.role !== 'assistant') return message
  return projectMessage(message, Array.isArray(raw.blocks) ? raw.blocks : getMessageBlocks(message))
}
