import { ArrowUpRight, X } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'
import { consumeEscape, ESCAPE_PRIORITY, useEscapeLayer } from '../../lib/useEscapeLayer'
import type { ResearchSessionDescriptor } from '../../types/research'
import { ResearchStatusBadge } from './ResearchStatusBadge'
import { ResearchTranscript } from './ResearchTranscript'

/**
 * A second transcript, read beside the main area without replacing it.
 *
 * It is a viewer, not a workspace: read-only, one at a time, and the main area keeps whatever the
 * reader was already looking at. On a wide screen it takes a fixed column; when the window is too
 * narrow for two readable columns the stylesheet turns it into a drawer over the transcript.
 */
export function ResearchSidePanel({ runId, workspace, descriptor, label, modal = false, onClose, onOpenMain }: {
  runId: string
  workspace: string
  descriptor: ResearchSessionDescriptor
  /** Named by the caller, which knows which Last Order is the run's own controller. */
  label: string
  modal?: boolean
  onClose: () => void
  onOpenMain: () => void
}) {
  const panel = useRef<HTMLElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null | undefined>(undefined)
  useEscapeLayer(true, event => { consumeEscape(event); onClose() }, ESCAPE_PRIORITY.side)
  useLayoutEffect(() => {
    const element = panel.current
    if (!element) return
    // A resize changes modality, not who opened this reader. Capture once so another header
    // control used while reading alongside cannot become the drawer's return destination.
    if (opener.current === undefined) {
      opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement : null
    }
    const original = opener.current
    const host = element.closest('[data-conversation-viewport]') ?? element.closest('[data-research-focus-view]')?.parentElement
    const restore = () => {
      const target = original?.isConnected && !element.contains(original) ? original
        : host?.querySelector<HTMLButtonElement>('.research-team-pill')
      target?.focus({ preventScroll: true })
    }
    if (!modal) return () => { if (element.contains(document.activeElement)) restore() }

    // Keep the same transcript mounted on resize. Inert siblings on the ancestor path, never
    // an ancestor of this reader: this includes the toolbar, main transcript and shared Composer.
    const changed: HTMLElement[] = []
    let branch: HTMLElement = element
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (!(sibling instanceof HTMLElement) || sibling === branch || sibling.hasAttribute('data-research-side-scrim') || sibling.hasAttribute('inert')) continue
        sibling.setAttribute('inert', '')
        changed.push(sibling)
      }
      branch = branch.parentElement
      if (branch === document.body) break
    }
    const stops = () => Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])'))
      .filter(item => !item.closest('[hidden], [inert]') && !Array.from(element.querySelectorAll('details:not([open])')).some(details => details.contains(item) && !details.querySelector('summary')?.contains(item)))
    const contain = (event: FocusEvent) => {
      if (!element.contains(event.target as Node)) closeButton.current?.focus({ preventScroll: true })
    }
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = stops(), first = items[0], last = items[items.length - 1]
      if (!first) { event.preventDefault(); element.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    closeButton.current?.focus({ preventScroll: true })
    document.addEventListener('focusin', contain)
    document.addEventListener('keydown', trap, true)
    return () => {
      document.removeEventListener('focusin', contain)
      document.removeEventListener('keydown', trap, true)
      changed.forEach(item => item.removeAttribute('inert'))
      restore()
    }
  }, [modal])
  return <>
    {modal && <div data-research-side-scrim className="research-side-scrim" aria-hidden="true" onPointerDown={onClose} />}
    <aside ref={panel} className="research-side-panel" role={modal ? 'dialog' : undefined} aria-modal={modal ? true : undefined} aria-label={`${label} 侧栏`} tabIndex={-1} data-modal={modal || undefined}>
    <header className="research-side-panel-header">
      <span className="research-side-panel-title" title={label}>{label}</span>
      <ResearchStatusBadge status={descriptor.status} />
      <button type="button" className="research-side-panel-open" onClick={onOpenMain}>
        <ArrowUpRight size={12} aria-hidden="true" /><span>在主区域打开</span>
      </button>
      <button ref={closeButton} type="button" className="research-side-panel-close" onClick={onClose} aria-label="关闭侧栏会话" title="关闭">
        <X size={13} aria-hidden="true" />
      </button>
    </header>
    <div className="research-side-panel-body">
      <ResearchTranscript runId={runId} workspace={workspace} descriptor={descriptor} area="side" readOnly hideRunEntry />
    </div>
  </aside></>
}
