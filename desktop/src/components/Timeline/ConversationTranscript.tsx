import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, Loader2 } from 'lucide-react'
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual'
import { messageHeights, readPosition, savePosition } from '../../lib/sessionViewState'
import type { ChatMessage } from '../../types/session'
import { MessageItem } from './MessageItem'
import { ChatSurfaceProvider, type ChatSurface } from './ChatSurface'

const LANDMARKS = '.conversation-markdown > *, .conversation-group-toggle, .conversation-row-toggle, .conversation-tool-details pre, .conversation-thinking-content, .conversation-user-message, [data-custom-type]'
const ESTIMATED_HEIGHT = 320

interface ConversationTranscriptProps {
  /** Reading identity: reading position, row heights and disclosures are filed under it. */
  viewKey: string | null
  messages: ChatMessage[]
  /** Which chat surface these rows belong to; absent means the ordinary conversation. */
  surface?: ChatSurface
  loading?: boolean
  loadError?: string | null
  onRetry?: () => void
  loadingLabel?: string
  /** Drawn above the first row, inside the reading column. */
  header?: ReactNode
  /** Drawn instead of the rows when there are none. */
  empty?: ReactNode
  label?: string
}

/**
 * The reading surface shared by the ordinary conversation and the research workspace.
 *
 * Both show the same rows -- typography, tool folding, reading position -- so they share this
 * engine instead of one wrapping the other: only the message source, the surface identity and
 * the empty state differ.
 */
export function ConversationTranscript({ viewKey, messages, surface, loading = false, loadError = null,
  onRetry, loadingLabel, header, empty, label = '对话记录' }: ConversationTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const saved = useRef(viewKey ? readPosition(viewKey) : undefined)
  const heights = useRef(viewKey ? messageHeights(viewKey) : new Map<string, number>())
  const following = useRef(saved.current?.following ?? true)
  const [showScrollBottom, setShowScrollBottom] = useState(!following.current)
  const anchor = useRef<{ element: HTMLElement; offset: number } | null>(null)
  const restoring = useRef(saved.current?.anchor)
  const autoScroll = useRef(false)
  const scrollFrame = useRef<number | null>(null)
  const frame = useRef<number | null>(null)
  const anchorFrame = useRef<number | null>(null)
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
    if (following.current) {
      // At the tail there is nothing to hold: new content lands where the reader already is, and
      // scanning every landmark of every mounted row to learn that is the most expensive thing a
      // streamed token can do here.
      anchor.current = null
      if (viewKey) savePosition(viewKey, { scrollTop: viewport.scrollTop, following: true })
      return
    }
    const top = viewport.getBoundingClientRect().top
    // Only mounted visible/overscan rows are inspected, never the entire history.
    const elements = contentRef.current?.querySelectorAll<HTMLElement>(LANDMARKS) || []
    const visible = Array.from(elements).find(element => element.getBoundingClientRect().bottom > top)
    anchor.current = visible ? { element: visible, offset: visible.getBoundingClientRect().top - top } : null
    if (viewKey) {
      const row = visible?.closest<HTMLElement>('[data-message-anchor]')
      savePosition(viewKey, { scrollTop: viewport.scrollTop, following: following.current,
        anchor: row && visible ? { messageId: row.dataset.messageAnchor!, landmark: Array.from(row.querySelectorAll(LANDMARKS)).indexOf(visible), offset: anchor.current!.offset } : undefined })
    }
  }, [viewKey])

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

  /** One geometry pass per animation frame, however many tokens arrived since the last one. */
  const scheduleReconcile = useCallback(() => {
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => { frame.current = null; reconcile() })
  }, [reconcile])

  const scheduleAnchor = useCallback(() => {
    if (anchorFrame.current !== null) return
    anchorFrame.current = requestAnimationFrame(() => { anchorFrame.current = null; rememberAnchor() })
  }, [rememberAnchor])

  const handleScroll = useCallback(() => {
    const viewport = scrollRef.current
    if (!viewport || autoScroll.current) return
    const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 32
    following.current = atBottom
    setShowScrollBottom(!atBottom)
    restoring.current = undefined
    // A reader-driven scroll is where the anchor has to be read: waiting a frame would record the
    // position the expansion already moved it to.
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
    return () => {
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      if (anchorFrame.current !== null) cancelAnimationFrame(anchorFrame.current)
    }
  }, [])
  useLayoutEffect(scheduleReconcile, [messages, scheduleReconcile])
  useLayoutEffect(() => {
    const content = contentRef.current
    const viewport = scrollRef.current
    if (!content || !viewport || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(scheduleReconcile)
    observer.observe(content)
    observer.observe(viewport)
    const host = viewport.closest<HTMLElement>('[data-conversation-viewport]')
    if (host) observer.observe(host)
    return () => observer.disconnect()
  }, [scheduleReconcile])

  const rows = messages.length === 0 ? (empty ?? null) : <>
    {header}
    {virtual ? <div className="conversation-virtual-content" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map(item => <div key={item.key} ref={virtualizer.measureElement} data-index={item.index} data-message-anchor={messages[item.index].id} className="conversation-virtual-row" style={{ transform: `translateY(${item.start}px)` }}>
        <MessageItem message={messages[item.index]} />
      </div>)}
    </div> : messages.map(message => <div key={message.id} data-message-anchor={message.id}><MessageItem message={message} /></div>)}
  </>
  const body = <div className="conversation-timeline">
    {(loading || loadError) && <div className="conversation-load-status" role="status">
      {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      <span>{loadError || loadingLabel || (messages.length ? '历史已显示，正在准备会话…' : '正在读取会话历史…')}</span>
      {loadError && onRetry && <button type="button" onClick={onRetry}>重试</button>}
    </div>}
    <div ref={scrollRef} onScroll={handleScroll} onWheel={() => { autoScroll.current = false }} onTouchStart={() => { autoScroll.current = false }} onClickCapture={scheduleAnchor} className="conversation-scroll" aria-label={label}>
      <div ref={contentRef} className="conversation-content">
        {rows}
        <div className="conversation-composer-spacer" aria-hidden="true" />
      </div>
    </div>
    {showScrollBottom && <button type="button" onClick={scrollToBottom} className="conversation-jump-bottom">
      <ArrowDown className="w-3.5 h-3.5 text-accent" /><span>回到底部</span>
    </button>}
  </div>
  return surface ? <ChatSurfaceProvider surface={surface}>{body}</ChatSurfaceProvider> : body
}
