import { GitBranch, Layers3, Network } from 'lucide-react'
import type { ResearchGraphNode, ResearchHostSnapshot, ResearchSessionsPayload } from '../../types/research'
import { ResearchStatusBadge } from './ResearchStatusBadge'
import { researchStatusLabels } from './researchPresentation'
import { ResearchResumeButton } from './ResearchResumeButton'
import { ResearchStopButton } from './ResearchStopButton'
import { ResearchInterruptedBanner } from './ResearchInterruptedBanner'
import { useSessionStore } from '../../store/useSessionStore'

export function ResearchRunHeader({ listing, node, onSelectNode, onGraph, onRefresh }: {
  listing: ResearchSessionsPayload; node: ResearchGraphNode | undefined; onSelectNode: (id: string) => void
  onGraph: () => void; onRefresh?: () => void
}) {
  const cards = node?.cards ?? []
  const running = cards.filter(card => card.status === 'running').length
  const ready = cards.filter(card => card.status === 'ready').length
  const done = cards.filter(card => ['done', 'completed'].includes(card.status)).length
  const bind = (snapshot: ResearchHostSnapshot) => useSessionStore.getState().bindResearchConversation(snapshot)
  return <>
    <section className="research-run-header" aria-label="研究运行概览" role="region">
      <div className="research-run-identity">
        <div className="research-eyebrow"><span className="research-brand-mark"><Layers3 size={13} aria-hidden="true" /></span>RESEARCH WORKSPACE <span className="research-run-id">{listing.runId}</span></div>
        <h1 title={listing.run.question}>{listing.run.question}</h1>
        <div className="research-run-counters"><ResearchStatusBadge status={listing.run.status} /><span className="research-counter"><i className="research-dot research-dot--active" />运行 {running}</span><span className="research-counter">就绪 {ready}</span><span className="research-counter">完成 {done}/{cards.length}</span><span className="research-counter research-counter--phase">{researchStatusLabels[node?.status ?? listing.run.phase] || node?.status || listing.run.phase}</span></div>
      </div>
      <div className="research-run-actions">
        <label className="research-node-select"><GitBranch size={13} aria-hidden="true" /><span className="sr-only">当前研究节点</span>
          <select aria-label="当前研究节点" value={node?.id ?? ''} onChange={event => onSelectNode(event.target.value)}>
            {listing.graph.nodes.map(item => <option key={item.id} value={item.id}>{item.kind === 'root' ? '主控节点' : `深度 ${item.depth}`} · {item.question}</option>)}
          </select>
        </label>
        <button type="button" className="research-button research-button--subtle" onClick={onGraph} aria-label="查看研究拓扑图"><Network size={14} aria-hidden="true" /><span>研究图谱</span></button>
        <ResearchStopButton runId={listing.runId} workspace={listing.run.workspace}
          status={listing.run.status} driving={listing.run.driving} stopRequested={listing.run.stop_requested} />
        <ResearchResumeButton runId={listing.runId} workspace={listing.run.workspace}
          status={listing.run.status} driving={listing.run.driving}
          stopRequested={listing.run.stop_requested} awaitingApproval={listing.run.awaitingApproval}
          onBound={bind} onRefresh={onRefresh} />
      </div>
    </section>
    <ResearchInterruptedBanner status={listing.run.status} driving={listing.run.driving}
      stopRequested={listing.run.stop_requested} awaitingApproval={listing.run.awaitingApproval} />
  </>
}
