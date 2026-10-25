import { useEffect, useState } from 'react'
import { ChevronDown, Clock3, History, Workflow } from 'lucide-react'
import type { ResearchSessionsPayload, ResearchSessionDescriptor } from '../../types/research'
import { useResearchWorkspaceStore } from '../../store/useResearchWorkspaceStore'
import { elapsedLabel, researchStatusLabels, researchStatusTone, splitResearchSessions } from './researchPresentation'

export function ResearchSessionTree({ listing, selectedNodeId, onSelectNode, onFocus }: {
  listing: ResearchSessionsPayload; selectedNodeId: string | null; onSelectNode: (nodeId: string) => void
  onFocus: (session: ResearchSessionDescriptor) => void
}) {
  const focused = useResearchWorkspaceStore(s => s.byRun[listing.runId]?.focusedExecutorId)
  const selected = useResearchWorkspaceStore(s => s.byRun[listing.runId]?.selectedNodeId) ?? selectedNodeId
  const [now, setNow] = useState(Date.now())
  const running = listing.sessions.some(item => item.status === 'running')
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 15000)
    return () => window.clearInterval(timer)
  }, [running])
  const renderSession = (session: ResearchSessionDescriptor) => <button type="button" key={session.executorId}
    onClick={() => onFocus(session)} aria-current={focused === session.executorId ? 'true' : undefined}
    className="research-session-row" title={`${session.label} · ${session.status}`}>
    <span className={`research-dot research-dot--${researchStatusTone(session.status)}`} />
    <span className="research-session-copy"><span>{session.cardTitle || session.label}</span>
      {session.cardTitle && session.cardTitle !== session.label && <small title={session.label}>{session.label}</small>}</span>
    <span className="research-session-state"><span>{researchStatusLabels[session.status] || session.status}</span><small><Clock3 size={10} aria-hidden="true" />{elapsedLabel(session, now)}</small></span>
    <span className="sr-only">{session.role === 'last_order' ? 'LO' : session.role === 'sister' ? 'Sister' : 'Agent'}</span>
  </button>
  return <nav aria-label="研究会话目录" className="research-session-tree">
    {listing.graph.nodes.map(node => {
      const { current, history } = splitResearchSessions(listing.sessions.filter(session => session.nodeId === node.id))
      return <div key={node.id} className="research-tree-node">
        <button type="button" className="research-tree-node-title" aria-current={selected === node.id ? 'true' : undefined}
          onClick={() => onSelectNode(node.id)} title={node.question}><Workflow size={12} aria-hidden="true" /><span>{node.question}</span><ChevronDown size={12} aria-hidden="true" /></button>
        {(['last_order', 'agents'] as const).map(group => {
          const members = current.filter(session => group === 'last_order' ? session.role === 'last_order' : session.role !== 'last_order')
          return members.length ? <div key={group} className="research-tree-group">
            <div className="research-tree-group-title">{group === 'last_order' ? 'Last Order' : 'Sisters / Agents'} · {members.length}</div>
            {members.map(renderSession)}
          </div> : null
        })}
        {history.length > 0 && <details className="research-tree-history"><summary><History size={12} aria-hidden="true" />历史代次 <span>{history.length}</span></summary>
          {history.map(renderSession)}</details>}
      </div>
    })}
  </nav>
}
