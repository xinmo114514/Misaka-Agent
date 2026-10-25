import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Users } from 'lucide-react'
import type { ResearchSessionDescriptor, ResearchSessionsPayload } from '../../types/research'
import { useDismiss } from '../../lib/useDismiss'
import { useAnchoredLayer } from '../../lib/useAnchoredLayer'
import { rootControllerId, sessionLabel, teamGroups, teamTotals } from './researchTeam'
import { ResearchTeamList } from './ResearchTeamList'

/**
 * The run's team as a header pill, the way an ordinary chat exposes its sub-agents.
 *
 * The pill is the count and nothing else: the transcript stays in the main area, because a
 * conversation squeezed into a dropdown is unreadable and the pill would have to grow with it.
 * Hover previews the directory; a click pins it so it can be used by keyboard and by touch.
 *
 * The directory is portalled: the page header truncates its own children, so a list drawn inside
 * it would be clipped at the first few rows.
 *
 * Closing has to win over hovering. Choosing a member unmounts the popover under a pointer that is
 * still inside the nav, and the browser then reports that same pointer entering the nav again --
 * which would reopen the directory the reader just dismissed. So a close arms a suppressor that
 * only a real pointer move away from the nav clears.
 */
export function ResearchTeamNavigator({ listing, currentId, onOpenMain, onOpenSide, onReturnToMain, presentation }: {
  listing: ResearchSessionsPayload
  currentId: string | null
  onOpenMain: (descriptor: ResearchSessionDescriptor) => void
  onOpenSide?: (descriptor: ResearchSessionDescriptor) => void
  onReturnToMain: () => void
  presentation?: 'focus'
}) {
  const groups = useMemo(() => teamGroups(listing), [listing])
  const totals = teamTotals(groups)
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const suppressed = useRef(false)
  const leaveTimer = useRef(0)
  const root = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const open = pinned || hovered
  const anchor = useAnchoredLayer(open, trigger, 'start')
  const controllerId = rootControllerId(listing)
  const close = () => { if (layer.current?.contains(document.activeElement)) trigger.current?.focus(); suppressed.current = true; setPinned(false); setHovered(false) }
  useDismiss(open, close, [root, layer], trigger)
  const current = listing.sessions.find(item => item.executorId === currentId)
  useEffect(() => {
    if (pinned && anchor) {
      const member = layer.current?.querySelector<HTMLButtonElement>('.research-team-member[aria-current="true"]')
        ?? layer.current?.querySelector<HTMLButtonElement>('.research-team-member')
        ?? layer.current?.querySelector<HTMLButtonElement>('button')
      member?.focus()
    }
  }, [pinned, anchor])
  // While browsing a sub-agent the pill names it, because the main area is no longer the controller.
  const hint = current && currentId !== controllerId ? (current.cardTitle || current.label)
    : totals.live > 0 ? `${totals.live} 个运行中` : '团队'
  const popover = open && anchor ? createPortal(
    <div ref={layer} className="research-team-popover misaka-glass-popover" role="dialog" aria-label="研究团队目录"
      style={{ left: anchor.left, top: anchor.top, width: anchor.width, maxHeight: anchor.maxHeight }}
      onPointerEnter={() => { window.clearTimeout(leaveTimer.current); setHovered(true) }} onPointerLeave={() => leave()}>
      {currentId && currentId !== controllerId &&
        <button type="button" className="research-team-return" onClick={() => { onReturnToMain(); close() }}>返回主控会话</button>}
      <ResearchTeamList listing={listing} currentId={currentId}
        onOpenMain={descriptor => { onOpenMain(descriptor); close() }}
        onOpenSide={onOpenSide ? descriptor => { onOpenSide(descriptor); close() } : undefined} />
    </div>, document.body) : null
  // The popover is portalled, so it is not inside the nav: leaving the pill on the way down must not
  // collapse the directory before the pointer arrives, hence the short grace period.
  const leave = () => {
    window.clearTimeout(leaveTimer.current)
    leaveTimer.current = window.setTimeout(() => { suppressed.current = false; if (!pinned) setHovered(false) }, 180)
  }
  useEffect(() => () => window.clearTimeout(leaveTimer.current), [])
  return <div className="research-team-nav" ref={root}
    onPointerMove={() => { if (!suppressed.current) setHovered(true) }}
    onPointerEnter={() => { window.clearTimeout(leaveTimer.current); if (!suppressed.current) setHovered(true) }}
    onPointerLeave={leave}>
    <button ref={trigger} type="button" className={`research-team-pill ${presentation === 'focus' ? 'research-team-pill--focus' : ''} ${open ? 'is-open' : ''}`}
      aria-expanded={open} aria-haspopup="dialog" aria-label={`研究团队：${totals.current} 个成员${presentation === 'focus' ? `，当前${current ? sessionLabel(current, controllerId) : '主控'}` : ''}`}
      title="查看研究的子代理会话"
      onClick={() => { suppressed.current = false; setPinned(value => !value) }}
      onKeyDown={event => { if (['ArrowDown', 'Enter', ' '].includes(event.key)) { event.preventDefault(); suppressed.current = false; setPinned(true) } }}>
      <Users size={13} aria-hidden="true" />
      {presentation === 'focus' ? <span className="research-team-focus-identity">{current && currentId !== controllerId ? sessionLabel(current, controllerId) : `团队 · ${totals.current}`}</span> : <><span className="research-team-pill-count">{totals.current}</span>
        <span className="research-team-pill-hint">{hint}</span>
        {totals.live > 0 && <span className="research-team-pill-pulse" aria-hidden="true" />}</>}
      <ChevronDown size={12} aria-hidden="true" className={`research-team-pill-chevron ${open ? 'rotate-180' : ''}`} />
    </button>
    {popover}
  </div>
}
