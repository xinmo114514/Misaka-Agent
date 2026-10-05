import React, { useState } from 'react'
import { Terminal, CheckCircle2, AlertCircle, Loader2, ChevronDown, ChevronRight } from 'lucide-react'
import type { ToolCall } from '../../types/session'

interface ToolCallCardProps {
  toolCall: ToolCall
}

export const ToolCallCard: React.FC<ToolCallCardProps> = ({ toolCall }) => {
  const [expanded, setExpanded] = useState(false)

  const isRunning = toolCall.status === 'running' || toolCall.status === 'pending'
  const isError = toolCall.status === 'error'

  return (
    <div className="my-2.5 rounded-xl border border-border-subtle bg-card overflow-hidden shadow-e1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-surface-2 transition-colors cursor-pointer select-none"
      >
        <div className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5 text-accent" />
          <span className="font-semibold text-text-main font-mono text-[11.5px]">
            {toolCall.name}
          </span>
          {isRunning ? (
            <span className="flex items-center gap-1 text-[11px] text-warning">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>执行中...</span>
            </span>
          ) : isError ? (
            <span className="flex items-center gap-1 text-[11px] text-danger">
              <AlertCircle className="w-3 h-3" />
              <span>失败</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[11px] text-success">
              <CheckCircle2 className="w-3 h-3" />
              <span>完成</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 text-dim text-[11px]">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </div>
      </button>

      {/* The header row above is card chrome and keeps its fixed sizes; only the expanded body
          is reading content, so it follows the 阅读字号 setting. */}
      {expanded && (
        <div className="p-3 border-t border-border-subtle bg-well font-mono text-micro space-y-2">
          {toolCall.arguments && Object.keys(toolCall.arguments).length > 0 && (
            <div>
              <div className="text-label text-dim mb-1 font-sans">参数 (Arguments):</div>
              <pre className="p-2 rounded bg-surface-2 border border-border-subtle overflow-x-auto text-text-main">
                {JSON.stringify(toolCall.arguments, null, 2)}
              </pre>
            </div>
          )}

          {toolCall.result !== undefined && (
            <div>
              <div className="text-label text-dim mb-1 font-sans">输出 (Output):</div>
              <pre className="p-2 rounded bg-surface-2 border border-border-subtle overflow-x-auto text-muted">
                {typeof toolCall.result === 'string'
                  ? toolCall.result
                  : JSON.stringify(toolCall.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
