import React, { useLayoutEffect, useRef, useState, useCallback } from 'react'
import { ArrowDown, Loader2 } from 'lucide-react'
import { MisakaLogo } from '../MisakaLogo'
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual'
import { useSessionStore } from '../../store/useSessionStore'
import { messageHeights, readPosition, savePosition, useSessionViewKey } from '../../lib/sessionViewState'
import { MessageItem } from './MessageItem'

const LANDMARKS = '.conversation-markdown > *, .conversation-group-toggle, .conversation-row-toggle, .conversation-tool-details pre, .conversation-thinking-content, .conversation-user-message, [data-custom-type]'
const ESTIMATED_HEIGHT = 320

export const Timeline: React.FC = () => {
  const path = useSessionViewKey()
  return <TimelineContent key={path ?? 'new-session'} path={path} />
}

function TimelineContent({ path }: { path: string | null }) {
  const messages = useSessionStore(s => s.agentMode === 'research' && s.researchBinding ? s.researchConversation.messages : s.messages)
  const startingResearch = useSessionStore(s => s.agentMode === 'research' && Boolean(s.researchPendingCreationRequestId) && !s.researchBinding?.runId)
  const loading = useSessionStore(s => s.isSessionLoading)
  const loadError = useSessionStore(s => s.sessionLoadError)
  const retry = useSessionStore(s => s.retrySessionLoad)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const saved = useRef(path ? readPosition(path) : undefined)
  const heights = useRef(path ? messageHeights(path) : new Map<string, number>())
  const following = useRef(saved.current?.following ?? true)
  const [showScrollBottom, setShowScrollBottom] = useState(!following.current)
  const anchor = useRef<{ element: HTMLElement; offset: number } | null>(null)
  const restoring = useRef(saved.current?.anchor)
  const autoScroll = useRef(false)
  const scrollFrame = useRef<number | null>(null)
  const virtual = messages.length > 40
  const getKey = useCallback((index: number) => messages[index].id, [messages])
  const estimateSize = useCallback((index: number) => heights.current.get(messages[index].id) ?? ESTIMATED_HEIGHT, [messages])
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: getKey,
    estimateSize,
    enabled: virtual,
    overscan: 6,
    initialRect: { width: 840, height: 720 },
    initialOffset: () => saved.current?.scrollTop ?? Math.max(0, messages.length * ESTIMATED_HEIGHT - 560),
    observeElementRect: (instance, callback) => observeElementRect(instance, rect => callback({ width: rect.width || 840, height: rect.height || 720 })),
    measureElement: (element, entry) => {
      const size = entry?.borderBoxSize?.[0]?.blockSize || element.getBoundingClientRect().height || ESTIMATED_HEIGHT
      const id = element.getAttribute('data-message-anchor')
      if (id) {
        heights.current.set(id, size)
        while (heights.current.size > 1000) heights.current.delete(heights.current.keys().next().value!)
      }
      return size
    },
  })
  // Size corrections above the viewport preserve the reading offset. Changes
  // inside a row are handled with its paragraph landmark below.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => !following.current && item.end < (instance.scrollOffset ?? 0)

  const rememberAnchor = useCallback(() => {
    const viewport = scrollRef.current
    if (!viewport) return
    const top = viewport.getBoundingClientRect().top
    // Only mounted visible/overscan rows are inspected, never the entire history.
    const elements = contentRef.current?.querySelectorAll<HTMLElement>(LANDMARKS) || []
    const visible = Array.from(elements).find(element => element.getBoundingClientRect().bottom > top)
    anchor.current = visible ? { element: visible, offset: visible.getBoundingClientRect().top - top } : null
    if (path) {
      const row = visible?.closest<HTMLElement>('[data-message-anchor]')
      savePosition(path, { scrollTop: viewport.scrollTop, following: following.current,
        anchor: row && visible ? { messageId: row.dataset.messageAnchor!, landmark: Array.from(row.querySelectorAll(LANDMARKS)).indexOf(visible), offset: anchor.current!.offset } : undefined })
    }
  }, [path])

  const toBottom = useCallback(() => {
    const viewport = scrollRef.current
    if (!viewport) return
    autoScroll.current = virtual
    viewport.scrollTop = viewport.scrollHeight
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = requestAnimationFrame(() => { autoScroll.current = false; scrollFrame.current = null })
  }, [virtual])

  const reconcile = useCallback(() => {
    const viewport = scrollRef.current
    if (!viewport) return
    if (following.current) toBottom()
    else {
      if (restoring.current) {
        const row = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[data-message-anchor]') ?? [])
          .find(element => element.dataset.messageAnchor === restoring.current!.messageId)
        const landmark = row?.querySelectorAll<HTMLElement>(LANDMARKS)[restoring.current.landmark]
        if (landmark) {
          viewport.scrollTop += landmark.getBoundingClientRect().top - viewport.getBoundingClientRect().top - restoring.current.offset
          restoring.current = undefined
        }
      } else if (anchor.current?.element.isConnected) {
        const current = anchor.current.element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
        const delta = current - anchor.current.offset
        if (Math.abs(delta) > 0.5) viewport.scrollTop += delta
      }
    }
    rememberAnchor()
  }, [rememberAnchor, toBottom])

  const handleScroll = useCallback(() => {
    const viewport = scrollRef.current
    if (!viewport || autoScroll.current) return
    const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 32
    following.current = atBottom
    setShowScrollBottom(!atBottom)
    restoring.current = undefined
    rememberAnchor()
  }, [rememberAnchor])

  const scrollToBottom = useCallback(() => {
    following.current = true
    restoring.current = undefined
    setShowScrollBottom(false)
    toBottom()
    rememberAnchor()
  }, [toBottom, rememberAnchor])

  useLayoutEffect(() => {
    if (!following.current && saved.current && scrollRef.current) scrollRef.current.scrollTop = saved.current.scrollTop
    return () => { if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current) }
  }, [])
  useLayoutEffect(reconcile, [messages, reconcile])
  useLayoutEffect(() => {
    const content = contentRef.current
    const viewport = scrollRef.current
    if (!content || !viewport || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(reconcile)
    observer.observe(content)
    observer.observe(viewport)
    const host = viewport.closest<HTMLElement>('[data-conversation-viewport]')
    if (host) observer.observe(host)
    return () => observer.disconnect()
  }, [reconcile])

  return <div className="conversation-timeline">
    {(loading || loadError) && <div className="conversation-load-status" role="status">
      {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      <span>{loadError || (messages.length ? '历史已显示，正在准备会话…' : '正在读取会话历史…')}</span>
      {loadError && <button type="button" onClick={retry}>重试</button>}
    </div>}
    <div ref={scrollRef} onScroll={handleScroll} onWheel={() => { autoScroll.current = false }} onTouchStart={() => { autoScroll.current = false }} onClickCapture={rememberAnchor} className="conversation-scroll" aria-label="对话记录">
      <div ref={contentRef} className="conversation-content">
        {messages.length === 0 ? <div className="conversation-empty text-muted">
          <div className="conversation-empty-icon">{loading || startingResearch ? <Loader2 className="w-6 h-6 text-rose-lite animate-spin" /> : <MisakaLogo size={26} />}</div>
          <p className="text-sm font-medium text-text-main">{loading ? '正在加载对话' : loadError ? '会话尚未就绪' : startingResearch ? '研究正在启动' : '开始新的研究对话'}</p>
          <p className="text-xs text-dim">{loading || loadError ? '你可以先在下方写草稿，准备完成后再发送。'
            : startingResearch ? '正在准备研究团队与规划；这一刻可能持续较长时间，状态会随研究事件更新。'
              : '在下方输入框中提出问题或课题，Misaka 将开始研究。'}</p>
        </div> : virtual ? <div className="conversation-virtual-content" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map(item => <div key={item.key} ref={virtualizer.measureElement} data-index={item.index} data-message-anchor={messages[item.index].id} className="conversation-virtual-row" style={{ transform: `translateY(${item.start}px)` }}>
            <MessageItem message={messages[item.index]} />
          </div>)}
        </div> : messages.map(message => <div key={message.id} data-message-anchor={message.id}><MessageItem message={message} /></div>)}
        <div className="conversation-composer-spacer" aria-hidden="true" />
      </div>
    </div>
    {showScrollBottom && <button type="button" onClick={scrollToBottom} className="conversation-jump-bottom">
      <ArrowDown className="w-3.5 h-3.5 text-accent" /><span>回到底部</span>
    </button>}
  </div>
}
