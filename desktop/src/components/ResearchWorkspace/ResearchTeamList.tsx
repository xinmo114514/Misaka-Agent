import { ChevronRight, PanelRight, ShieldQuestion } from 'lucide-react'
import type { ResearchSessionDescriptor, ResearchSessionsPayload } from '../../types/research'
import { useLiveClock } from '../../lib/useLiveClock'
import { ResearchStatusBadge } from './ResearchStatusBadge'
import { teamGroups, teamTotals, rootControllerId, sessionLabel, type TeamMember } from './researchTeam'
import { elapsedLabel } from './researchPresentation'

/**
 * The run's team, as a directory rather than a column.
 *
 * Browsing is the only thing this list does: it never sends, never executes and never loads a
 * transcript it is merely showing, so opening it is cheap however many sessions the run has.
 */
export function ResearchTeamList({ listing, currentId, onOpenMain, onOpenSide }: {
  listing: ResearchSessionsPayload
  /** The member the main area currently shows. */
  currentId: string | null
  onOpenMain: (descriptor: ResearchSessionDescriptor) => void
  onOpenSide?: (descriptor: ResearchSessionDescriptor) => void
}) {
  const groups = teamGroups(listing)
  const totals = teamTotals(groups)
  const controllerId = rootControllerId(listing)
  // Only a live member's elapsed time ticks; a settled directory does not re-render every second.
  const now = useLiveClock(totals.live > 0)
  return <nav className="research-team-list" aria-label="智能体团队">
    <div className="research-team-heading">
      <strong>Last Order</strong>
      <small>{totals.current} 个成员 · {totals.live} 个运行中</small>
    </div>
    {groups.length === 0 ? <p className="research-team-empty">这项研究还没有派出子代理。</p>
      : <div className="research-team-groups">
        {groups.map(group => <section key={group.node?.id ?? 'orphans'} className="research-team-group">
          <h3 className="research-team-group-title">
            <span className="research-team-group-kind">{group.node ? (group.node.kind === 'root' ? '主控节点' : `深度 ${group.node.depth}`) : '未归属'}</span>
            <span title={group.title}>{group.title}</span>
          </h3>
          <ul>{group.members.map(member => <MemberRow key={member.descriptor.executorId} member={member}
            currentId={currentId} controllerId={controllerId} onOpenMain={onOpenMain} onOpenSide={onOpenSide} now={now} />)}</ul>
        </section>)}
      </div>}
    <p className="research-team-note"><ShieldQuestion size={12} aria-hidden="true" />子代理会话只读。需要补充或调整时，请在对话中向主控代理提出。</p>
  </nav>
}

function MemberRow({ member, currentId, controllerId, onOpenMain, onOpenSide, now }: {
  member: TeamMember; currentId: string | null; controllerId: string | null
  onOpenMain: (descriptor: ResearchSessionDescriptor) => void
  onOpenSide?: (descriptor: ResearchSessionDescriptor) => void
  now: number
}) {
  const { descriptor, history } = member
  const label = sessionLabel(descriptor, controllerId)
  const role = descriptor.executorId === controllerId ? '主控 · 研究调度' : 'Last Order · 节点调度'
  return <li className="research-team-member-item">
    <div className="research-team-member-row">
      <button type="button" className="research-team-member" aria-current={currentId === descriptor.executorId}
        data-testid={`research-team-member-${descriptor.executorId}`} onClick={() => onOpenMain(descriptor)}
        title={`在主区域打开 ${label}`}>
        <span className="research-team-member-copy">
          <strong>{label}</strong>
          <small>{descriptor.role === 'last_order' ? role : descriptor.cardTitle && descriptor.label && descriptor.cardTitle !== descriptor.label ? descriptor.label : `代次 ${descriptor.generation} · 尝试 ${descriptor.attempt}`}</small>
        </span>
        <ResearchStatusBadge status={descriptor.status} />
        <span className="research-team-meta">{elapsedLabel(descriptor, now)}{tokensLabel(descriptor) && <> · {tokensLabel(descriptor)}</>}</span>
        <ChevronRight size={12} aria-hidden="true" className="research-team-chevron" />
      </button>
      {onOpenSide && <button type="button" className="research-team-side-button" aria-label={`在右侧查看 ${label}`}
        title="在右侧只读查看" onClick={() => onOpenSide(descriptor)}>
        <PanelRight size={13} aria-hidden="true" />
      </button>}
    </div>
    {history.length > 0 && <details className="research-team-history">
      <summary>历史代次 {history.length}</summary>
      <ul>{history.map(item => <li key={item.executorId}>
        <button type="button" onClick={() => onOpenMain(item)} title={`在主区域打开 ${sessionLabel(item, controllerId)}`}>
          <span>{sessionLabel(item, controllerId) || '未命名代次'}</span>
          <ResearchStatusBadge status={item.status} />
          <small>代次 {item.generation} · 尝试 {item.attempt}</small>
        </button>
      </li>)}</ul>
    </details>}
  </li>
}

/** Compact token totals for a member, from its own telemetry; absent means "not reported". */
function tokensLabel(descriptor: ResearchSessionDescriptor): string {
  const tokens = descriptor.telemetry?.tokens
  if (!tokens) return ''
  const input = compact(tokens.input), output = compact(tokens.output)
  return `↑${input} ↓${output}`
}

function compact(value: number | undefined): string {
  const number = Number(value || 0)
  return number < 1000 ? String(number) : `${(number / 1000).toFixed(number < 10_000 ? 1 : 0)}k`
}
