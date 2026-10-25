import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { consumeEscape, ESCAPE_PRIORITY, useEscapeLayer, useHasHigherEscapeLayer } from '../../lib/useEscapeLayer'

/**
 * A stable portal destination keeps the transcript, disclosures and page requests mounted.
 * Only its DOM host moves: the grid slot normally, the body for full-window reading. This also
 * keeps the modal outside glass/filtered ancestors that would otherwise contain position:fixed.
 */
export function MultiPaneFrame({ executorId, label, expanded, onClose, className = '', style, children }: {
  executorId: string
  label: string
  expanded: boolean
  onClose: () => void
  className?: string
  style?: CSSProperties
  children: ReactNode
}) {
  const slot = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const wasExpanded = useRef(false)
  const finishScrollMove = useRef<(() => void) | null>(null)
  const [host] = useState(() => document.createElement('div'))
  const foregroundOpen = useHasHigherEscapeLayer(ESCAPE_PRIORITY.side)
  useEscapeLayer(expanded, event => { consumeEscape(event); onClose() }, ESCAPE_PRIORITY.side)

  useLayoutEffect(() => {
    finishScrollMove.current?.()
    const moving = Boolean(host.parentElement) && wasExpanded.current !== expanded
    const positions = Array.from(host.querySelectorAll<HTMLElement>('.research-pane-body, .research-card-contract, .research-lo-overview, .research-pane-footer, .research-telemetry-content'))
      .map(element => ({ element, top: element.scrollTop, left: element.scrollLeft }))
    const restore = () => positions.forEach(({ element, top, left }) => {
      element.scrollTop = top
      element.scrollLeft = left
    })
    // Chromium can clamp detached scrollers to zero, then dispatch a scroll event after the
    // move. That is layout churn, not a reader action, and must not overwrite saved reading.
    const blockTransientScroll = (event: Event) => {
      if (positions.some(position => position.element === event.target)) event.stopImmediatePropagation()
    }
    if (moving) host.addEventListener('scroll', blockTransientScroll, true)
    // Apply destination geometry before attachment, then restore against that actual layout.
    host.className = `research-multi-pane-host${expanded ? ' research-expanded-pane' : ''}`
    if (expanded) {
      if (!wasExpanded.current) {
        // Auto-sized rows must keep their original footprint while the host reads on body.
        const height = slot.current?.getBoundingClientRect().height
        if (slot.current && height) slot.current.style.height = `${height}px`
        const active = document.activeElement
        opener.current = active instanceof HTMLElement && host.contains(active)
          ? active : host.querySelector<HTMLButtonElement>('.research-pane-expand')
      }
      document.body.append(host)
    } else {
      slot.current?.style.removeProperty('height')
      slot.current?.append(host)
      if (wasExpanded.current && opener.current?.isConnected) opener.current.focus({ preventScroll: true })
    }
    wasExpanded.current = expanded
    if (!moving) return
    restore()
    const schedule = window.requestAnimationFrame?.bind(window)
      ?? ((callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0))
    const cancel = window.cancelAnimationFrame?.bind(window) ?? window.clearTimeout.bind(window)
    let frame = schedule(() => {
      restore()
      frame = schedule(() => { host.removeEventListener('scroll', blockTransientScroll, true) })
    })
    finishScrollMove.current = () => {
      cancel(frame)
      host.removeEventListener('scroll', blockTransientScroll, true)
      finishScrollMove.current = null
    }
  }, [expanded, host])

  useLayoutEffect(() => {
    if (expanded) {
      host.setAttribute('role', 'dialog')
      host.setAttribute('aria-label', `展开 ${label} 会话`)
      host.setAttribute('data-research-expanded-pane', executorId)
      host.setAttribute('tabindex', '-1')
      host.toggleAttribute('data-foreground-open', foregroundOpen)
      if (!foregroundOpen) host.setAttribute('aria-modal', 'true')
      else host.removeAttribute('aria-modal')
    } else {
      for (const attribute of ['role', 'aria-label', 'aria-modal', 'tabindex', 'data-research-expanded-pane', 'data-foreground-open']) host.removeAttribute(attribute)
    }
  }, [executorId, expanded, foregroundOpen, host, label])

  useLayoutEffect(() => {
    if (!expanded || foregroundOpen) return
    // An existing dialog/menu keeps its own focus and inertness. Once it closes this reader
    // resumes modality; Escape is independently ordered by the shared layer registry.
    const changed: HTMLElement[] = []
    for (const sibling of document.body.children) {
      if (!(sibling instanceof HTMLElement) || sibling === host || sibling.hasAttribute('inert')) continue
      sibling.setAttribute('inert', '')
      changed.push(sibling)
    }
    const focusEntry = () => (host.querySelector<HTMLButtonElement>('.research-pane-expand') ?? host).focus({ preventScroll: true })
    const stops = () => Array.from(host.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])'))
      .filter(item => !item.closest('[hidden], [inert]') && !Array.from(host.querySelectorAll('details:not([open])')).some(details => details.contains(item) && !details.querySelector('summary')?.contains(item)))
    const contain = (event: FocusEvent) => { if (!host.contains(event.target as Node)) focusEntry() }
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = stops(), first = items[0], last = items[items.length - 1]
      if (!first) { event.preventDefault(); host.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !host.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !host.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    if (!host.contains(document.activeElement)) focusEntry()
    document.addEventListener('focusin', contain)
    document.addEventListener('keydown', trap, true)
    return () => {
      document.removeEventListener('focusin', contain)
      document.removeEventListener('keydown', trap, true)
      changed.forEach(item => item.removeAttribute('inert'))
    }
  }, [expanded, foregroundOpen, host])

  useLayoutEffect(() => () => { finishScrollMove.current?.(); host.remove() }, [host])
  return <>
    <div ref={slot} style={style} className={`research-multi-pane-slot ${className}`} data-research-pane-frame={executorId} />
    {createPortal(children, host)}
  </>
}
