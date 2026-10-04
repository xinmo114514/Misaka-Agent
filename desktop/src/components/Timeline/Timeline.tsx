import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { ArrowDown, MessageSquare } from 'lucide-react'
import { useSessionStore } from '../../store/useSessionStore'
import { MessageItem } from './MessageItem'

export const Timeline: React.FC = () => {
  const messages = useSessionStore((s) => s.messages)
  const isStreaming = useSessionStore((s) => s.isStreaming)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const isAtBottomRef = useRef(true)

  // ZCode battle-tested pattern: split live tail from historical turns
  // Prevents ResizeObserver 1-frame latency scroll jitter during high-speed token streaming
  const { historicalMessages, liveMessage } = useMemo(() => {
    const isLastLive =
      isStreaming &&
      messages.length > 0 &&
      messages[messages.length - 1].role === 'assistant'

    if (isLastLive) {
      return {
        historicalMessages: messages.slice(0, -1),
        liveMessage: messages[messages.length - 1],
      }
    }
    return {
      historicalMessages: messages,
      liveMessage: null,
    }
  }, [messages, isStreaming])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    const distanceToBottom = scrollHeight - scrollTop - clientHeight
    const atBottom = distanceToBottom < 80
    isAtBottomRef.current = atBottom
    setShowScrollBottom(!atBottom)
  }, [])

  const scrollToBottom = (smooth = true) => {
    if (!scrollRef.current) return
    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    })
    isAtBottomRef.current = true
    setShowScrollBottom(false)
  }

  // Smooth stick-to-bottom on new streaming tokens
  useEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom(false)
    }
  }, [messages, liveMessage?.content, liveMessage?.thinking])

  return (
    <div className="relative flex-1 h-full overflow-hidden flex flex-col bg-surface-0">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-6 sm:px-12 md:px-20 lg:px-28 py-6 space-y-4"
      >
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted gap-3 select-none">
            <div className="w-12 h-12 rounded-2xl bg-surface-1 border border-border flex items-center justify-center text-dim shadow-sm">
              <MessageSquare className="w-6 h-6 text-rose-lite" />
            </div>
            <p className="text-sm font-medium text-text-main">开始新的研究对话</p>
            <p className="text-xs text-dim">在下方输入框中提出问题或课题，Misaka 将开始研究。</p>
          </div>
        ) : (
          <>
            {/* Historical turns */}
            <div className="space-y-4">
              {historicalMessages.map((msg) => (
                <MessageItem key={msg.id} message={msg} />
              ))}
            </div>

            {/* Live Tail: normal document flow, 0 scroll jitter */}
            {liveMessage && (
              <div className="live-tail pt-1">
                <MessageItem message={liveMessage} />
              </div>
            )}
          </>
        )}

        {/* Bottom padding so content is not obscured by floating composer */}
        <div className="h-28" />
      </div>

      {/* Floating Stick-to-bottom Button */}
      {showScrollBottom && (
        <button
          onClick={() => scrollToBottom(true)}
          className="absolute right-8 bottom-32 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-2 hover:bg-surface-3 border border-border text-xs text-text-main shadow-md transition-all hover:scale-105 cursor-pointer z-20"
        >
          <ArrowDown className="w-3.5 h-3.5 text-accent" />
          <span>回到底部</span>
        </button>
      )}
    </div>
  )
}
