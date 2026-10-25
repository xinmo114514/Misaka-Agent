import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowRight, ListChecks, LoaderCircle, RefreshCw, Play } from 'lucide-react'
import type { ResearchSessionDescriptor, ResearchSuspension } from '../../types/research'
import { researchResumeAvailability, RESEARCH_RESUME_CONFIRM_TIMEOUT_MS } from '../../lib/researchResume'
import { useResearchResumeStore } from '../../store/useResearchResumeStore'

/**
 * The stop record for a run or node that halted.
 *
 * It explains what stopped and points at the single 恢复研究 entry in the run header; it never
 * renders a second resume control, so the focus view, the multi-pane view and this banner can
 * never disagree about the run's ownership.
 */
export function ResearchStoppedBanner({ suspension, runStatus, sessions, onFocus, driving, awaitingApproval }: {
  suspension: ResearchSuspension; runStatus: string; workspace: string; sessions: ResearchSessionDescriptor[]
  onFocus: (session: ResearchSessionDescriptor) => void
  /** The board's driver state. Absent means unknown, which keeps resume disabled. */
  driving?: boolean
  awaitingApproval?: boolean
}) {
  const entry = useResearchResumeStore(state => state.byRun[suspension.runId])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (entry?.phase !== 'confirming') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [entry?.phase])
  // A run-level suspension is the run's own state; a node suspension never offers a run resume.
  const availability = researchResumeAvailability({ status: runStatus, driving, awaitingApproval })
  const resumable = suspension.scope === 'run' && availability.visible
  const phase = entry?.phase ?? 'idle'
  const failed = sessions.filter(item => (suspension.scope === 'run' || item.nodeId === suspension.nodeId)
    && suspension.confirmations.some(confirmation => confirmation.taskId === item.taskId && confirmation.generation === item.generation)
    && (item.error || ['failed', 'error', 'stopped'].includes(item.status)))
    .sort((a, b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0) || b.generation - a.generation)[0]
  const remaining = phase === 'confirming'
    ? Math.max(0, Math.round(((entry?.startedAt ?? now) + RESEARCH_RESUME_CONFIRM_TIMEOUT_MS - now) / 1000))
    : 0
  // The header owns the control; this banner only narrates what that control is doing.
  const state = phase === 'confirming' ? `正在确认恢复，最多 ${Math.round(RESEARCH_RESUME_CONFIRM_TIMEOUT_MS / 1000)} 秒（剩余 ${remaining} 秒）`
    : phase === 'submitting' ? '正在提交恢复请求'
      : phase === 'unconfirmed' ? '恢复结果待确认，请刷新查看'
        : phase === 'failed' ? `恢复失败：${entry?.error || '可重试'}`
          : phase === 'confirmed' ? '已确认研究开始运行'
            : null
  return <aside className="research-stop-banner" role="status">
    <AlertTriangle className="research-stop-icon" size={18} aria-hidden="true" />
    <div className="research-stop-copy"><strong>{suspension.scope === 'run' ? '研究已暂停' : '当前节点已暂停'}</strong>
      <p>{suspension.confirmations.length} 张卡片已停止 · {suspension.hasAcceptedOutput ? '已验收成果完整保留' : '尚无验收产出'}。检查错误后可继续研究。</p>
      {resumable && <p className="research-stop-resume-hint">
        {availability.enabled ? '点右上角「恢复研究」从停止处继续，不会新建课题。' : availability.reason}
      </p>}
      {state && <p className="research-stop-resume-state" aria-live="polite">
        {phase === 'confirming' && <LoaderCircle className="research-spinner" size={12} aria-hidden="true" />}
        {phase !== 'confirming' && phase !== 'failed' && <Play size={12} aria-hidden="true" />}
        {state}
      </p>}
      <details className="research-stop-record"><summary><ListChecks size={12} aria-hidden="true" />查看停止记录</summary><pre>{suspension.message}</pre></details>
      <code className="research-resume-command">{suspension.resumeCommand}</code>
    </div>
    <div className="research-stop-actions">
    {failed && <button type="button" className="research-button research-button--subtle" onClick={() => onFocus(failed)}>查看失败详情<ArrowRight size={12} aria-hidden="true" /></button>}
    {phase === 'unconfirmed' && <button type="button" className="research-button research-button--subtle"
      title="刷新研究状态" onClick={() => useResearchResumeStore.getState().clear(suspension.runId)}>
      <RefreshCw size={13} aria-hidden="true" /><span>刷新</span></button>}
    </div>
    {entry?.phase === 'failed' && entry.error && <p role="alert" className="research-stop-error">{entry.error}</p>}
  </aside>
}
