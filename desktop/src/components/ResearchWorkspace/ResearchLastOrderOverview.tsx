import { useEffect, useState } from 'react'
import { request } from '../../lib/bridge'
import type { ResearchGraphNode, ResearchNodeDetail } from '../../types/research'
import { ListChecks } from 'lucide-react'

/** A read-only board projection; the coordinator's native transcript remains below. */
export function ResearchLastOrderOverview({ runId, workspace, node }: { runId: string; workspace: string; node: ResearchGraphNode }) {
  const [detail, setDetail] = useState<ResearchNodeDetail | null>(null)
  const cards = node.cards ?? []
  const needsLegacyDetail = cards.some(card => card.local_id === undefined || card.dependencies === undefined)
  useEffect(() => {
    let current = true
    setDetail(null)
    if (!needsLegacyDetail) return () => { current = false }
    void request<{ detail: ResearchNodeDetail }>('get_research_node', { runId, nodeId: node.id, workspace })
      .then(value => { if (current) setDetail(value.detail) }).catch(() => {})
    return () => { current = false }
  }, [runId, workspace, node.id, node.plan_round, needsLegacyDetail])
  const planTasks: Array<{ local_id?: string; title?: string; dependencies?: string[] }> = detail?.plan?.tasks ?? []
  return <section aria-label="节点卡片概览" className="research-lo-overview">
    <details className="research-plan-disclosure">
      <summary className="research-plan-label"><ListChecks size={12} aria-hidden="true" /><strong>研究设计</strong><span>已完成 {cards.filter(card => card.status === 'done').length}/{cards.length} · 运行中 {cards.filter(card => card.status === 'running').length} · 待执行 {cards.filter(card => card.status === 'ready').length}</span></summary>
      <div className="research-plan-cards">{cards.map(card => {
        const candidates = planTasks.filter(task => task.title === card.title)
        const plan = candidates.length === 1 ? candidates[0] : null
        const dependencies = card.dependencies ?? plan?.dependencies ?? []
        return <div key={card.id} className="mt-1 flex flex-wrap gap-x-2 border-l-2 border-border-subtle pl-2">
          <span className="text-text-main">{card.local_id ?? plan?.local_id ?? card.id} · {card.title}</span>
          <span>{card.status}</span>
          {dependencies.length ? <span className="text-dim">依赖 {dependencies.map(id => cards.find(item => item.id === id)?.local_id || id).join('、')}</span> : null}
        </div>
      })}</div>
    </details>
  </section>
}
