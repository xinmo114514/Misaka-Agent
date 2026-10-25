import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, GitBranch, Network } from 'lucide-react'
import type { ResearchGraphNode, ResearchSessionsPayload } from '../../types/research'
import { useDismiss } from '../../lib/useDismiss'
import { useAnchoredLayer } from '../../lib/useAnchoredLayer'
import { ResearchStatusBadge } from './ResearchStatusBadge'
import { researchStatusLabels } from './researchPresentation'

/**
 * The run's structural controls, folded into one header menu.
 *
 * Graph, node and counters are about the shape of the research rather than the conversation being
 * read, so they belong behind a single entry instead of in a banner above every transcript. Run
 * state that must never be missed -- stop, resume, an interruption -- is not in here.
 *
 * Portal plus measurement, for the same reason as the team directory: the bar that holds this
 * trigger clips its children so a long session title cannot push the actions away.
 */
export function ResearchRunMenu({ listing, node, onSelectNode, onGraph }: {
  listing: ResearchSessionsPayload
  node: ResearchGraphNode | undefined
  onSelectNode: (id: string) => void
  onGraph: () => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const anchor = useAnchoredLayer(open, trigger, 'end')
  useDismiss(open, () => setOpen(false), [root, layer], trigger)
  const cards = node?.cards ?? []
  const count = (statuses: string[]) => cards.filter(card => statuses.includes(card.status)).length
  const popover = open && anchor ? createPortal(
    <div ref={layer} className="research-run-menu-popover misaka-glass-popover" role="dialog" aria-label="研究菜单"
      style={{ left: anchor.left, top: anchor.top, width: anchor.width }}>
      <div className="research-run-menu-counters">
        <ResearchStatusBadge status={listing.run.status} />
        <span className="research-counter"><i className="research-dot research-dot--active" />运行 {count(['running'])}</span>
        <span className="research-counter">就绪 {count(['ready'])}</span>
        <span className="research-counter">完成 {count(['done', 'completed'])}/{cards.length}</span>
        <span className="research-counter research-counter--phase">{researchStatusLabels[node?.status ?? listing.run.phase] || node?.status || listing.run.phase}</span>
      </div>
      <label className="research-node-select"><GitBranch size={13} aria-hidden="true" /><span className="sr-only">当前研究节点</span>
        <select aria-label="当前研究节点" value={node?.id ?? ''} onChange={event => onSelectNode(event.target.value)}>
          {listing.graph.nodes.map(item => <option key={item.id} value={item.id}>{item.kind === 'root' ? '主控节点' : `深度 ${item.depth}`} · {item.question}</option>)}
        </select>
      </label>
      <button type="button" className="research-button research-button--subtle" onClick={() => { onGraph(); setOpen(false) }}
        aria-label="查看研究拓扑图"><Network size={14} aria-hidden="true" /><span>研究图谱</span></button>
    </div>, document.body) : null
  return <div className="research-run-menu" ref={root}>
    <button ref={trigger} type="button" className="research-button research-button--subtle research-run-menu-trigger"
      aria-expanded={open} aria-haspopup="dialog" aria-label="研究菜单" title="研究节点、拓扑图与运行概况"
      onClick={() => setOpen(value => !value)}>
      <GitBranch size={13} aria-hidden="true" /><span>研究</span>
      <ChevronDown size={12} aria-hidden="true" className={open ? 'rotate-180' : ''} />
    </button>
    {popover}
  </div>
}
