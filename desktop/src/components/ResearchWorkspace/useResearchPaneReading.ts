import { createContext, useCallback, useLayoutEffect, useRef, type MouseEvent, type RefObject, type UIEvent } from 'react'
import { useResearchWorkspaceStore } from '../../store/useResearchWorkspaceStore'

/** Only explicit content operations participate; moving the pane's portal is Frame's job. */
export const ResearchContentChangeContext = createContext<() => void>(() => {})

interface ReadingAnchor {
  following: boolean
  scrollTop: number
  scrollHeight: number
  anchorId?: string
  anchorTop?: number
}

export function useResearchPaneReading(runId: string, executorId: string, scrollRef: RefObject<HTMLDivElement | null>, content: unknown, streaming: unknown, sessionIdentity: string) {
  const pending = useRef<ReadingAnchor | null>(null)
  const asynchronous = useRef(new Set<{ anchor: ReadingAnchor | null }>())
  const frame = useRef<number | null>(null)
  const attachmentFrame = useRef<number | null>(null)
  const epoch = useRef(0)
  const previousContent = useRef({ content, streaming })

  const capture = useCallback((): ReadingAnchor | null => {
    const element = scrollRef.current
    if (!element) return null
    const reading = useResearchWorkspaceStore.getState().byRun[runId]?.reading[executorId]
    const boundary = element.getBoundingClientRect()
    const anchors = Array.from(element.querySelectorAll<HTMLElement>('[data-research-reading-anchor]'))
    const anchor = anchors.find(candidate => {
      const rect = candidate.getBoundingClientRect()
      return rect.bottom > boundary.top && rect.top < boundary.bottom
    })
    return { following: reading?.following ?? true, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight,
      anchorId: anchor?.dataset.researchReadingAnchor, anchorTop: anchor?.getBoundingClientRect().top }
  }, [executorId, runId, scrollRef])

  const restore = useCallback((anchor: ReadingAnchor | null) => {
    const element = scrollRef.current
    if (!element || !anchor) return
    if (anchor.following) element.scrollTop = element.scrollHeight
    else {
      const target = anchor.anchorId && Array.from(element.querySelectorAll<HTMLElement>('[data-research-reading-anchor]'))
        .find(candidate => candidate.dataset.researchReadingAnchor === anchor.anchorId)
      element.scrollTop = target && anchor.anchorTop !== undefined
        ? element.scrollTop + target.getBoundingClientRect().top - anchor.anchorTop
        : anchor.scrollTop + element.scrollHeight - anchor.scrollHeight
    }
    useResearchWorkspaceStore.getState().setReading(runId, executorId, { scrollTop: element.scrollTop, following: anchor.following })
  }, [executorId, runId, scrollRef])

  const schedule = useCallback(() => {
    if (frame.current !== null) return
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null
      const anchor = pending.current
      pending.current = null
      restore(anchor)
    })
  }, [restore])

  const beforeChange = useCallback(() => {
    // Several field cache writes can belong to the same React commit.
    pending.current ??= capture()
    schedule()
  }, [capture, schedule])

  const preserveAsync = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    const holder = { anchor: capture() }
    const startedEpoch = epoch.current
    asynchronous.current.add(holder)
    try { return await operation() }
    finally {
      asynchronous.current.delete(holder)
      if (epoch.current === startedEpoch) {
        pending.current ??= holder.anchor
        schedule()
      }
    }
  }, [capture, schedule])

  useLayoutEffect(() => {
    epoch.current++
    const element = scrollRef.current
    if (element) {
      const reading = useResearchWorkspaceStore.getState().byRun[runId]?.reading[executorId]
      element.scrollTop = reading?.scrollTop ?? element.scrollHeight
      if (reading && !element.isConnected) {
        const startedEpoch = epoch.current
        attachmentFrame.current = window.requestAnimationFrame(() => {
          attachmentFrame.current = null
          if (epoch.current !== startedEpoch || scrollRef.current !== element || !element.isConnected) return
          element.scrollTop = reading?.scrollTop ?? element.scrollHeight
        })
      }
    }
    pending.current = null
    asynchronous.current.clear()
    return () => {
      epoch.current++
      if (frame.current !== null) window.cancelAnimationFrame(frame.current)
      if (attachmentFrame.current !== null) window.cancelAnimationFrame(attachmentFrame.current)
      frame.current = null
      attachmentFrame.current = null
    }
  }, [executorId, runId, scrollRef, sessionIdentity])

  useLayoutEffect(() => {
    const changed = previousContent.current.content !== content || previousContent.current.streaming !== streaming
    previousContent.current = { content, streaming }
    const anchor = pending.current ?? (changed ? asynchronous.current.values().next().value?.anchor : null)
    pending.current = null
    if (anchor) restore(anchor)
    else if (changed && (useResearchWorkspaceStore.getState().byRun[runId]?.reading[executorId]?.following ?? true)) {
      const element = scrollRef.current
      if (element) element.scrollTop = element.scrollHeight
    }
  })

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    useResearchWorkspaceStore.getState().setReading(runId, executorId, {
      scrollTop: element.scrollTop, following: element.scrollHeight - element.scrollTop - element.clientHeight < 30,
    })
    // A reader can move while an older-history request is outstanding.
    for (const holder of asynchronous.current) holder.anchor = capture()
  }, [capture, executorId, runId])

  const onDisclosureClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('summary')) beforeChange()
  }, [beforeChange])

  return { beforeChange, preserveAsync, onScroll, onDisclosureClick }
}
