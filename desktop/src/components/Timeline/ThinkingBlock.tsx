import React, { useId } from 'react'
import { ChevronRight, Sparkles } from 'lucide-react'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useDisclosure } from '../../lib/sessionViewState'

interface ThinkingBlockProps {
  thinking: string
  isStreaming?: boolean
  stateKey?: string
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ thinking, isStreaming = false, stateKey }) => {
  const hideThinkingBlock = useSettingsStore(s => s.hideThinkingBlock)
  // null follows the segment lifecycle; a click is a lasting user decision.
  const [manualExpanded, setManualExpanded] = useDisclosure(`thinking:${stateKey ?? 'standalone'}`)
  const expanded = manualExpanded ?? (isStreaming && !hideThinkingBlock)
  const contentId = useId()
  if (!thinking) return null
  return <section className="conversation-execution-row conversation-thinking">
    <button type="button" className="conversation-row-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setManualExpanded(!expanded)}>
      <Sparkles className="conversation-row-icon text-accent" />
      <span>深度思考过程</span>
      <span className="conversation-row-meta">{isStreaming ? '思考中' : '已完成'}</span>
      <ChevronRight className={'conversation-chevron ' + (expanded ? 'is-expanded' : '')} />
    </button>
    <div id={contentId} hidden={!expanded} className="conversation-thinking-content">{expanded ? thinking : null}</div>
  </section>
}
