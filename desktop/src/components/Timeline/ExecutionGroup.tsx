import React, { useId } from 'react'
import { ChevronRight, Layers, Loader2 } from 'lucide-react'
import type { ChatMessage } from '../../types/session'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallCard } from './ToolCallCard'
import { useDisclosure } from '../../lib/sessionViewState'

type Block = NonNullable<ChatMessage['blocks']>[number]
type ExecutionBlock = Exclude<Block, { type: 'text' }>

export const ExecutionGroup: React.FC<{ blocks: ExecutionBlock[]; stateKey?: string }> = ({ blocks, stateKey }) => {
  // Keep execution status rows visible by default. Only the inner thinking body
  // follows segment lifecycle; a group disclosure is exclusively a user choice.
  const [manualExpanded, setExpanded] = useDisclosure(`group:${stateKey ?? blocks[0].id}`)
  const expanded = manualExpanded ?? true
  const thinkingNow = blocks.some(block => block.type === 'thinking' && block.isStreaming)
  const running = blocks.some(block => block.type === 'toolCall' && ['pending', 'running'].includes(block.toolCall.status))
  const failed = blocks.some(block => block.type === 'toolCall' && block.toolCall.status === 'error')
  const contentId = useId()
  const names = blocks.map(block => block.type === 'toolCall' ? block.toolCall.name : '深度思考')
  return <section className="conversation-execution-group" data-execution-group={blocks[0].id}>
    <button type="button" className="conversation-group-toggle" aria-label={`执行记录，${blocks.length} 步`} aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(!expanded)}>
      {running || thinkingNow ? <Loader2 className="conversation-row-icon animate-spin text-accent" /> : <Layers className="conversation-row-icon text-dim" />}
      <span>执行记录 <span className="conversation-row-meta">{blocks.length} 步</span></span>
      <span className="conversation-group-summary">{names.join(' · ')}</span>
      {failed && <span className="text-danger">失败</span>}
      <ChevronRight className={'conversation-chevron ' + (expanded ? 'is-expanded' : '')} />
    </button>
    <div id={contentId} hidden={!expanded} className="conversation-group-body">
      {expanded && blocks.map(block => block.type === 'thinking'
        ? <ThinkingBlock key={block.id} stateKey={stateKey ? `${stateKey}:${block.contentIndex}` : block.id} thinking={block.thinking} isStreaming={Boolean(block.isStreaming)} />
        : <ToolCallCard key={block.id} toolCall={block.toolCall} />)}
    </div>
  </section>
}

