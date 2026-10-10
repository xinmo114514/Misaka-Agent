import React, { useEffect, useRef, useState } from 'react'
import { Copy, Check, GitFork, User, Sparkles } from 'lucide-react'
import type { ChatMessage } from '../../types/session'
import { useSessionStore } from '../../store/useSessionStore'
import { clipboardErrorMessage, copyTextToClipboard } from '../../lib/clipboard'
import { ExecutionGroup } from './ExecutionGroup'
import { ToolCallCard } from './ToolCallCard'
import { CustomNotice } from './CustomNotice'
import { MarkdownContent } from './MarkdownContent'
import { getMessageBlocks } from '../../lib/messageBlocks'

interface MessageItemProps {
  message: ChatMessage
}

export const MessageItem = React.memo(function MessageItem({ message }: MessageItemProps) {
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const copyingRef = useRef(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const forkSession = useSessionStore((s) => s.forkSession)
  const retryMessage = useSessionStore(s => s.retryMessage)
  const retryResearchMessage = useSessionStore(s => s.retryResearchMessage)
  const canRetryStartupExecution = useSessionStore(s => s.agentMode === 'research' && Boolean(s.researchBinding) && !s.researchBinding?.runId)
  const retryDisabled = useSessionStore(s => s.isSessionLoading || Boolean(s.sessionLoadError) ||
    message.deliveryRetryable === false ||
    (s.agentMode === 'research' ? !s.researchBinding || s.researchConversation.isAborting ||
      Boolean(!s.researchBinding.runId && s.researchPendingCreationRequestId) ||
      s.researchConversation.messages.some(row => row.requestId === message.requestId && row.deliveryStatus === 'pending') : s.isAborting))
  const isUser = message.role === 'user'
  const researchView = useSessionStore(s => s.agentMode === 'research' && Boolean(s.researchBinding))
  // Only persisted messages carry a real session entry; a live/unsaved turn cannot be a fork point.
  const canFork = !researchView && Boolean(message.entryId) && !message.isStreaming
  const blocks = getMessageBlocks(message)

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
  }, [])

  const segments: ({ kind: 'text'; block: Extract<NonNullable<ChatMessage['blocks']>[number], { type: 'text' }> } | { kind: 'execution'; blocks: Exclude<NonNullable<ChatMessage['blocks']>[number], { type: 'text' }>[] })[] = []
  for (const block of blocks) {
    if (block.type === 'text') segments.push({ kind: 'text', block })
    else {
      const previous = segments[segments.length - 1]
      if (previous?.kind === 'execution') previous.blocks.push(block)
      else segments.push({ kind: 'execution', blocks: [block] })
    }
  }

  const handleCopy = async () => {
    if (copyingRef.current) return
    copyingRef.current = true
    setCopying(true)
    setCopied(false)
    setCopyError(null)
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    try {
      await copyTextToClipboard(blocks.filter(block => block.type === 'text').map(block => block.text).join('\n\n'))
      setCopied(true)
      copyTimerRef.current = setTimeout(() => {
        setCopied(false)
        copyTimerRef.current = null
      }, 2000)
    } catch (error) {
      setCopyError(`复制失败：${clipboardErrorMessage(error)}`)
    } finally {
      copyingRef.current = false
      setCopying(false)
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
      <div className="conversation-user-message group relative">
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
        {message.deliveryStatus === 'pending' && <p role="status" className="mt-1 text-[11px] text-dim">发送中…</p>}
        {message.deliveryStatus === 'unconfirmed' && <p role="status" className="mt-1 text-[11px] text-warning">{message.deliveryReconciled
          ? '发送结果尚未确认，已核对研究记录' : '发送结果尚未确认，正在核对研究记录…'}</p>}
        {message.deliveryStatus === 'accepted' && <p role="status" className="mt-1 text-[11px] text-dim">已接收，等待协调 Agent 处理</p>}
        {message.deliveryStatus === 'created' && <p role="status" className="mt-1 text-[11px] text-dim">已记录</p>}
        {message.executionError && <p role="status" className="mt-1 text-xs text-warning">执行异常：{message.executionError}</p>}
        {message.images?.length ? <div className="mt-2 flex flex-wrap gap-2" aria-label="已发送图片">
          {message.images.map((image, index) => <img
            key={`${message.id}-image-${index}`}
            src={`data:${image.mimeType};base64,${image.data}`}
            alt={image.name ? `附件图片：${image.name}` : '附件图片'}
            loading="lazy"
            className="max-h-64 max-w-full rounded-lg border border-border-subtle object-contain"
          />)}
        </div> : null}
        {message.submissionError && message.deliveryStatus !== 'unconfirmed' && <div className="mt-2 flex items-center gap-2 text-xs text-danger">
          <span role="status">提交失败：{message.submissionError}</span>
          <button type="button" disabled={retryDisabled} onClick={() => researchView ? retryResearchMessage(message.id) : retryMessage(message.id)}
            className="shrink-0 rounded-md border border-border-subtle px-2 py-1 hover:bg-surface-2 disabled:opacity-40">重试</button>
        </div>}
        {message.executionError && message.researchSubmission && canRetryStartupExecution && !message.submissionError &&
          message.deliveryStatus !== 'pending' && message.deliveryRetryable !== false &&
          <button type="button" disabled={retryDisabled} onClick={() => retryResearchMessage(message.id)}
            className="mt-2 rounded-md border border-border-subtle px-2 py-1 text-xs hover:bg-surface-2 disabled:opacity-40">重试</button>}
        {message.deliveryStatus === 'unconfirmed' && message.deliveryReconciled && message.deliveryRetryable !== false && <button type="button" disabled={retryDisabled}
          onClick={() => retryResearchMessage(message.id)} className="mt-2 shrink-0 rounded-md border border-border-subtle px-2 py-1 text-xs hover:bg-surface-2 disabled:opacity-40">重试</button>}
      </div>
    )
  }

  return (
    <div className="conversation-assistant-message group relative" data-message-id={message.id}>
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

      <div className="conversation-message-body">
        {segments.map((segment, index) => {
          if (segment.kind === 'text') {
            return <MarkdownContent key={segment.block.id} content={segment.block.text} isStreaming={Boolean(segment.block.isStreaming)} />
          }
          const [only] = segment.blocks
          if (segment.blocks.length === 1 && only?.type === 'toolCall') {
            return <ToolCallCard key={only.id} toolCall={only.toolCall} />
          }
          return <ExecutionGroup key={only.id} stateKey={`${message.entryId ?? message.id}:${only.contentIndex}`}
            blocks={segment.blocks} active={Boolean(message.isStreaming) && index === segments.length - 1} />
        })}
      </div>
      {message.errorMessage && <p className="conversation-message-error" role="status">{message.errorMessage}</p>}
      {/* Message action bar matching screenshot: Copy, Fork, Timestamp */}
      <div className="conversation-message-actions flex items-center gap-3 text-xs text-dim select-none">
        <button
          onClick={handleCopy}
          disabled={copying}
          className="flex items-center gap-1 hover:text-text-main transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
          title={copying ? '正在复制回答' : '复制回答内容'}
          aria-label="复制回答内容"
        >
          {copying ? <span role="status">复制中…</span> : copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
        {copied && <span role="status" className="text-success">已复制</span>}
        {copyError && <span role="alert" className="text-danger">{copyError}</span>}

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
})
