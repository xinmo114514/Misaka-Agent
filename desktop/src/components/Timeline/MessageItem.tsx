import React, { useState } from 'react'
import { Copy, Check, GitFork, User, Sparkles } from 'lucide-react'
import type { ChatMessage } from '../../types/session'
import { useSessionStore } from '../../store/useSessionStore'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallCard } from './ToolCallCard'
import { CustomNotice } from './CustomNotice'
import { MarkdownContent } from './MarkdownContent'

interface MessageItemProps {
  message: ChatMessage
}

export const MessageItem: React.FC<MessageItemProps> = ({ message }) => {
  const [copied, setCopied] = useState(false)
  const forkSession = useSessionStore((s) => s.forkSession)
  const isUser = message.role === 'user'
  // Only persisted messages carry a real session entry; a live/unsaved turn cannot be a fork point.
  const canFork = Boolean(message.entryId) && !message.isStreaming

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback
    }
  }

  const timeStr = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  // An engine notice is not something Last Order said; it gets its own feed row.
  if (message.role === 'custom') return <CustomNotice message={message} />

  if (isUser) {
    return (
      <div className="group relative py-3 px-4 rounded-xl bg-card border border-border-subtle shadow-e1 hover:shadow-e2 transition-all my-2.5 max-w-[85%] ml-auto">
        <div className="flex items-center gap-2 mb-1.5 text-xs text-muted">
          <div className="w-5 h-5 rounded-full bg-surface-3 flex items-center justify-center text-text-main">
            <User className="w-3 h-3 text-muted" />
          </div>
          <span className="font-medium text-text-main">你</span>
          <span className="text-[11px] text-dim ml-auto">{timeStr}</span>
        </div>

        <div className="text-[length:var(--font-size-body)] leading-relaxed text-text-main whitespace-pre-wrap selection:bg-accent/20">
          {message.content}
        </div>
      </div>
    )
  }

  return (
    <div className="group relative py-3.5 px-1 text-text-main my-2">
      {/* Assistant Header */}
      <div className="flex items-center gap-2 mb-2 text-xs text-muted select-none">
        <div className="w-5 h-5 rounded-full bg-accent/20 border border-accent/40 flex items-center justify-center">
          <Sparkles className="w-3 h-3 text-accent" />
        </div>
        <span className="font-semibold text-text-main">Misaka Agent</span>
        {message.isStreaming && (
          <span className="flex items-center gap-1 text-[11px] text-rose-lite font-mono">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-lite animate-pulse" />
            生成中...
          </span>
        )}
      </div>

      {/* Thinking section */}
      {message.thinking && (
        <ThinkingBlock thinking={message.thinking} isStreaming={message.isStreaming} />
      )}

      {/* Tool calls */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="my-2 space-y-1">
          {message.toolCalls.map((tc) => (
            <ToolCallCard key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}

      {/* Markdown Body */}
      {message.content && <MarkdownContent content={message.content} />}

      {/* Message action bar matching screenshot: Copy, Fork, Timestamp */}
      <div className="flex items-center gap-3 mt-3 pt-1.5 text-xs text-dim select-none opacity-80 group-hover:opacity-100 transition-opacity">
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-text-main transition-colors cursor-pointer"
          title="复制回答内容"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
        </button>

        <button
          onClick={() => {
            if (!canFork) return
            forkSession(message.entryId!, isUser ? 'before' : 'at')
          }}
          disabled={!canFork}
          className={`flex items-center gap-1 transition-colors ${
            canFork
              ? 'hover:text-text-main cursor-pointer'
              : 'opacity-40 cursor-not-allowed'
          }`}
          title={canFork ? '从此消息分叉会话 (Fork)' : '仅已保存的消息可分叉'}
        >
          <GitFork className="w-3.5 h-3.5" />
        </button>

        <span className="text-[11px] text-dim">{timeStr}</span>

        {message.tokens && (
          <span className="text-[10.5px] text-dim/70 ml-auto font-mono">
            Tokens: {message.tokens.total || (message.tokens.input || 0) + (message.tokens.output || 0)}
          </span>
        )}
      </div>
    </div>
  )
}
