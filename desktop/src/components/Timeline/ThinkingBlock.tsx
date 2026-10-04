import React, { useState } from 'react'
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react'

interface ThinkingBlockProps {
  thinking: string
  isStreaming?: boolean
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({
  thinking,
  isStreaming,
}) => {
  const [expanded, setExpanded] = useState(true)

  if (!thinking) return null

  return (
    <div className="my-2 rounded-lg border border-border-subtle bg-surface-1/70 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-muted hover:bg-surface-2 transition-colors cursor-pointer select-none"
      >
        <div className="flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-rose-lite" />
          <span className="font-medium text-text-main">深度思考过程</span>
          {isStreaming && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-lite animate-pulse ml-1" />
          )}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-dim">
          <span>{expanded ? '折叠' : '展开'}</span>
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </div>
      </button>

      {/* Thinking content with WCAG AA thinkingText color */}
      {expanded && (
        <div className="px-3.5 py-2.5 border-t border-border-subtle/60 text-xs font-sans leading-relaxed text-thinking-text whitespace-pre-wrap selection:bg-accent/20 bg-surface-0/40">
          {thinking}
        </div>
      )}
    </div>
  )
}
