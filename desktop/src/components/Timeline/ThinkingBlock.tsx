import React, { useState, useEffect } from 'react'
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react'
import { useSettingsStore } from '../../store/useSettingsStore'

interface ThinkingBlockProps {
  thinking: string
  isStreaming?: boolean
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({
  thinking,
  isStreaming,
}) => {
  const hideThinkingBlock = useSettingsStore((s) => s.hideThinkingBlock)
  const [expanded, setExpanded] = useState(() => !hideThinkingBlock)

  // Auto expand when streaming starts, or follow user preference initially
  useEffect(() => {
    if (isStreaming) {
      setExpanded(true)
    }
  }, [isStreaming])

  if (!thinking) return null

  return (
    <div className="my-2 rounded-xl border border-border-subtle bg-card overflow-hidden shadow-e1">
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
        <div className="px-3.5 py-2.5 border-t border-border-subtle/60 text-[length:var(--font-size-prose-sm)] font-sans leading-relaxed text-thinking-text whitespace-pre-wrap selection:bg-accent/20 bg-well">
          {thinking}
        </div>
      )}
    </div>
  )
}
