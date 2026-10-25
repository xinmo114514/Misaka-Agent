import { useCallback, useEffect, useRef, useState } from 'react'
import { LoaderCircle, Play, RefreshCw, RotateCcw } from 'lucide-react'
import { request } from '../../lib/bridge'
import {
  requestResearchResume,
  researchResumeAvailability,
  RESEARCH_RESUME_CONFIRM_TIMEOUT_MS,
} from '../../lib/researchResume'
import { useResearchResumeStore } from '../../store/useResearchResumeStore'
import type { ResearchHostSnapshot, ResearchRunDetail } from '../../types/research'

/**
 * Resolve the driver state once when the list did not carry it.
 *
 * An old protocol (or an unreadable board) omits `driving`. That is unknown, not "lost": the
 * entry stays disabled until one detail read answers. A failed read stays unknown.
 */
export function useResolvedDriving(runId: string, workspace: string | undefined, driving: boolean | undefined) {
  const [resolved, setResolved] = useState<boolean | undefined>(driving)
  // A ref, not state: flipping a state flag here would rerun this effect and its cleanup would
  // cancel the very read it just started.
  const asked = useRef<string | null>(null)
  useEffect(() => { setResolved(driving) }, [driving])
  useEffect(() => {
    if (driving !== undefined) return
    const key = `${runId}\u0000${workspace ?? ''}`
    if (asked.current === key) return
    asked.current = key
    let live = true
    void request<ResearchRunDetail>('get_research_details', { runId, workspace })
      .then(detail => { if (live && typeof detail?.run?.driving === 'boolean') setResolved(detail.run.driving) })
      .catch(() => { /* unknown stays unknown */ })
    return () => { live = false }
  }, [runId, workspace, driving])
  return resolved
}

const PHASE_LABELS: Record<string, string> = {
  submitting: '提交中',
  confirming: '正在确认恢复',
  confirmed: '恢复成功',
  failed: '重试恢复',
  unconfirmed: '结果待确认',
}

/**
 * The one resume entry, shared by the focus view and the multi-pane view because both render the
 * same run header.
 *
 * Only a user click starts a resume. The lock and the reported phase live in a shared store, so a
 * layout switch, a session switch or a second window cannot start a second request.
 */
export function ResearchResumeButton({ runId, workspace, status, driving, stopRequested, awaitingApproval, onBound, onRefresh,
  hideUnavailable = false }: {
  runId: string
  workspace?: string
  status?: string | null
  driving?: boolean
  stopRequested?: boolean
  awaitingApproval?: boolean
  onBound?: (snapshot: ResearchHostSnapshot) => void
  onRefresh?: () => void
  /** Focus toolbar only: omit an idle or settled, unavailable action while preserving live feedback. */
  hideUnavailable?: boolean
}) {
  const resolved = useResolvedDriving(runId, workspace, driving)
  const entry = useResearchResumeStore(state => state.byRun[runId])
  const availability = researchResumeAvailability({ status, driving: resolved, stopRequested, awaitingApproval })
  const [now, setNow] = useState(() => Date.now())

  // A visible countdown is the only live-looking element, and it belongs to 正在确认恢复.
  useEffect(() => {
    if (entry?.phase !== 'confirming') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [entry?.phase])

  const resume = useCallback(() => {
    void requestResearchResume({ runId, workspace, onBound })
  }, [runId, workspace, onBound])

  const phase = entry?.phase ?? 'idle'
  const activeFeedback = phase === 'submitting' || phase === 'confirming' || phase === 'failed' || phase === 'unconfirmed'
  if (!availability.visible && !(hideUnavailable && activeFeedback)) return null
  if (hideUnavailable && !availability.enabled && !activeFeedback) return null
  const busy = phase === 'submitting' || phase === 'confirming'
  const label = PHASE_LABELS[phase] ?? '恢复研究'
  const disabled = busy || (phase !== 'failed' && phase !== 'unconfirmed' && !availability.enabled)
  const title = phase === 'confirming'
    ? `已提交恢复请求，正在等待观测到研究真正开始运行（最多 ${Math.round(RESEARCH_RESUME_CONFIRM_TIMEOUT_MS / 1000)} 秒）`
    : phase === 'unconfirmed'
      ? entry?.error || '结果待确认，请刷新查看'
      : phase === 'failed'
        ? entry?.error || '恢复失败，可重试'
        : phase === 'confirmed'
          ? '已确认研究开始运行'
          : availability.reason || '恢复这项研究'

  const remaining = entry?.phase === 'confirming'
    ? Math.max(0, Math.round((entry.startedAt + RESEARCH_RESUME_CONFIRM_TIMEOUT_MS - now) / 1000))
    : 0

  return <span className="research-resume-entry">
    <button type="button" className="research-button research-button--subtle research-resume-button"
      onClick={resume} disabled={disabled} title={title} aria-label={label}
      aria-description={availability.enabled ? undefined : availability.reason} aria-busy={busy}
      data-phase={phase}>
      {busy ? <LoaderCircle className="research-spinner" size={14} aria-hidden="true" />
        : phase === 'failed' ? <RotateCcw size={14} aria-hidden="true" />
          : <Play size={13} aria-hidden="true" />}
      <span>{label}</span>
      {phase === 'confirming' && <span className="research-resume-countdown" aria-hidden="true">{remaining}s</span>}
    </button>
    {phase === 'unconfirmed' && onRefresh && <button type="button" className="research-button research-button--subtle"
      onClick={onRefresh} title="刷新研究状态"><RefreshCw size={13} aria-hidden="true" /><span>刷新</span></button>}
  </span>
}
