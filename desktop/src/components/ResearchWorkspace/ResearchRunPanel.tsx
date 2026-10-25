import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Clock, Loader2, PauseCircle, Users, X } from 'lucide-react'
import { useSessionStore } from '../../store/useSessionStore'
import { subscribeResearchRun } from '../../lib/researchActivityStore'
import { researchPhaseLabel } from '../../lib/researchStatus'
import { consumeEscape, ESCAPE_PRIORITY, useEscapeLayer } from '../../lib/useEscapeLayer'
import { DesktopResearchTeam } from '../Timeline/DesktopResearchTeam'
import type { ResearchRunCard, ResearchRunSummary, ResearchSessionsPayload, ResearchTaskSummary } from '../../types/research'

/**
 * The run's working parts, folded away in the focus view.
 *
 * 专注模式 reads as an ordinary conversation, so the old run pill -- banner, task list and team in
 * the middle of the transcript -- has no place above the chat. What it alone could reach still has
 * to be reachable: the tasks a run handed out, the team it assembled, and the retention step at the
 * end of a stopped run. This panel is that home, opened from the header bar and closed again without
 * touching what is being read.
 */
export function ResearchRunPanel({ runId, workspace, listing, onClose }: {
  runId: string
  workspace: string
  /** The directory already carries every node's cards, so tasks show before any card snapshot. */
  listing: ResearchSessionsPayload
  onClose: () => void
}) {
  const card = useSessionStore(state => state.researchCards[runId])
  const setActiveResearchTask = useSessionStore(state => state.setActiveResearchTask)
  const [confirmedEnd, setConfirmedEnd] = useState(false)
  const panel = useRef<HTMLElement>(null)
  const roles = useRef<HTMLDetailsElement>(null)
  const closePanel = () => {
    const element = panel.current
    const restore = element?.contains(document.activeElement)
    const host = element?.closest('[data-conversation-viewport]') ?? element?.closest('[data-research-tiling-workspace]')
    const trigger = host?.querySelector<HTMLButtonElement>('button[aria-label="更多研究选项"]')
    onClose()
    if (restore) trigger?.focus({ preventScroll: true })
  }
  useEscapeLayer(true, event => { consumeEscape(event); closePanel() }, ESCAPE_PRIORITY.process)
  // The panel is the only thing watching the card in this view, and only while it is open.
  useEffect(() => subscribeResearchRun(runId, card?.workspace || workspace), [runId, card?.workspace, workspace])
  useEffect(() => { setConfirmedEnd(false) }, [runId, card?.status])
  const tasks = tasksOf(card, listing)
  const completed = tasks.filter(task => task.status === 'closed' || task.status === 'done').length
  const status = card?.status ?? listing.run.status ?? ''
  const canEndForRetention = status === 'failed' || status === 'stopped'
  const done = status === 'done' || (canEndForRetention && confirmedEnd)
  const StatusIcon = status === 'done' ? CheckCircle2
    : status === 'waiting_input' ? AlertCircle
      : status === 'failed' || status === 'error' ? AlertCircle
        : status === 'stopped' || status === 'partial' || status === 'cancelled' ? PauseCircle
          : Loader2
  return <section ref={panel} id={`research-process-${runId}`} className="research-run-panel" aria-label="研究运行过程" data-testid="research-run-panel">
    <header className="research-run-panel-head">
      <span className="research-run-panel-state" data-status={status || 'syncing'}>
        <StatusIcon size={13} aria-hidden="true" className={StatusIcon === Loader2 ? 'research-run-panel-spin' : undefined} />
        <span>{runStatusLine(status, card?.phase || card?.stage || listing.run.phase)}</span>
      </span>
      {tasks.length > 0 && <span className="research-run-panel-counts">{completed}/{tasks.length} 项任务</span>}
      <button type="button" className="research-run-panel-close" onClick={closePanel} aria-label="收起运行过程" title="收起">
        <X size={13} aria-hidden="true" />
      </button>
    </header>
    <div className="research-run-panel-body">
      <div className="research-run-panel-tasks">
        <div className="research-run-panel-tasks-head">
          <span><Users size={12} aria-hidden="true" />协同任务与专家分工</span>
          <span>{tasks.length} 个任务</span>
        </div>
        {tasks.length === 0
          ? <p className="research-run-panel-empty" role="status">{status === 'active'
            ? '正在根据课题规划研究节点与分工…'
            : status === 'waiting_input' ? '尚未创建任务，等待你的回答' : '暂无任务记录'}</p>
          : <ul className="research-run-panel-task-list">
            {tasks.map(task => <li key={`${task.nodeId ?? ''}:${task.id}`}>
              <button type="button" className="research-run-panel-task" aria-label={`查看任务 ${task.title}`}
                onClick={() => setActiveResearchTask({ runId, taskId: task.id })}>
                <TaskIcon status={task.status} />
                <span className="research-run-panel-task-title" title={task.title}>{task.title}</span>
                <span className="research-run-panel-task-meta">{task.assignee}</span>
              </button>
            </li>)}
          </ul>}
      </div>
      <details ref={roles} data-research-role-details className="research-run-role-details">
        <summary>团队与角色</summary>
      {canEndForRetention && <div className="research-run-panel-retain">
        {!confirmedEnd
          ? <button type="button" className="research-button research-button--subtle" onClick={() => { setConfirmedEnd(true); if (roles.current) roles.current.open = true }}>
            结束本次研究并选择保留角色
          </button>
          : <p className="research-run-panel-hint">保留全部研究与恢复资料；下一步仅保存你勾选并确认的角色。</p>}
      </div>}
      <DesktopResearchTeam runId={runId} done={done} />
      </details>
    </div>
  </section>
}

/**
 * The tasks a run handed out.
 *
 * A card snapshot is the live truth, but it only exists once the run reports itself. The directory
 * already lists every node's cards, so the panel opens with the work it can see instead of an empty
 * list, and the snapshot takes over as soon as it lands.
 */
function tasksOf(card: ResearchRunCard | undefined, listing: ResearchSessionsPayload): ResearchTaskSummary[] {
  if (card?.tasks?.length) return card.tasks
  return listing.graph.nodes.flatMap(node => (node.cards ?? []).map(item => ({
    id: item.local_id || item.id, nodeId: node.id, title: item.title,
    status: item.status, assignee: item.assignee, kind: item.kind,
  } as ResearchTaskSummary)))
}

/** One line naming what the run is doing, in the words the timeline used before. */
function runStatusLine(status: string, phase: ResearchRunSummary['phase'] | string | undefined): string {
  if (status === 'done') return '研究已完成'
  if (status === 'waiting_input') return '研究等待澄清 · 需要你的确认'
  if (status === 'failed' || status === 'error') return '研究中断 · 查看下方任务与团队'
  if (status === 'stopped' || status === 'partial' || status === 'cancelled') return '研究已暂停'
  if (status === 'stopping') return '研究正在停止 · 等待结算'
  if (!status) return '正在同步研究状态…'
  return `正在进行研究 · ${researchPhaseLabel(String(phase || '多节点协同'))}`
}

function TaskIcon({ status }: { status: string }) {
  if (status === 'closed' || status === 'done') return <CheckCircle2 size={12} aria-hidden="true" className="research-run-panel-task-icon is-done" />
  if (status === 'error' || status === 'failed') return <AlertCircle size={12} aria-hidden="true" className="research-run-panel-task-icon is-error" />
  if (status === 'running') return <Loader2 size={12} aria-hidden="true" className="research-run-panel-task-icon is-live research-run-panel-spin" />
  return <Clock size={12} aria-hidden="true" className="research-run-panel-task-icon" />
}
