import type { ResearchRunSummary, ResearchSessionDescriptor } from '../../types/research'

export const researchStatusLabels: Record<string, string> = {
  active: '研究中', running: '运行中', executing: '执行中', ready: '就绪', todo: '等待依赖',
  queued: '排队中', planning: '规划中', awaiting_approval: '待审批', waiting_input: '待补充',
  synthesizing: '汇总中', reviewing: '审阅中', finalizing: '终稿中',
  stopping: '正在停止', stopped: '已停止', failed: '失败', error: '失败', done: '已完成', completed: '已完成', closed: '已结项',
  blocked: '已阻塞', triage: '待处理',
}
export function researchStatusTone(status: string): string {
  return ['failed', 'error'].includes(status) ? 'danger'
    : ['running', 'executing', 'active'].includes(status) ? 'active'
      : ['done', 'completed', 'closed'].includes(status) ? 'success'
        : ['stopping', 'stopped', 'blocked', 'triage', 'waiting_input', 'awaiting_approval'].includes(status) ? 'warning' : 'quiet'
}

/** Pick one coherent board row; mixing a stale listing lease with a fresh summary status lies. */
export function resolveResearchStopBoard(
  fallback: { status?: string | null; driving?: boolean; stopRequested?: boolean },
  listing?: ResearchRunSummary, summary?: ResearchRunSummary,
): { status?: string | null; driving?: boolean; stopRequested?: boolean } {
  const newest = listing && summary
    ? (summary.updatedAt ?? 0) >= (listing.updatedAt ?? 0) ? summary : listing
    : summary ?? listing
  // Final card publication may beat both cached board rows; these outcomes never expose stop.
  if (['done', 'completed', 'closed', 'cancelled', 'canceled', 'partial', 'error', 'failed']
    .includes((fallback.status || '').toLowerCase())) return fallback
  return newest ? { status: newest.status, driving: newest.driving, stopRequested: newest.stop_requested } : fallback
}

/** One stop-facing interpretation of durable board state and the local shared attempt. */
export function researchStopPresentation(status: string | null | undefined,
  phase?: 'pending' | 'unconfirmed' | 'failed', stopRequested?: boolean, driving?: boolean):
  'ready' | 'pending' | 'unconfirmed' | 'failed' | 'hidden' {
  const value = (status || '').toLowerCase()
  if (['done', 'completed', 'closed', 'cancelled', 'canceled', 'partial', 'error', 'failed'].includes(value)) return 'hidden'
  if (value === 'stopped' && driving === false) return 'hidden'
  if (phase === 'unconfirmed' || phase === 'failed') return phase
  if (phase === 'pending') return 'pending'
  if (value === 'stopped') return 'unconfirmed' // stopped without a quiet lease has not proved rest.
  if (value === 'stopping' || (stopRequested && ['active', 'waiting_input'].includes(value))) {
    return driving === false ? 'unconfirmed' : 'pending'
  }
  return ['active', 'waiting_input'].includes(value) ? 'ready' : 'hidden'
}
export function elapsedLabel(session: ResearchSessionDescriptor, now: number): string {
  if (!session.startedAt) return '—'
  const seconds = Math.max(0, Math.floor(((session.endedAt ?? now) - session.startedAt) / 1000))
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
}
/** Presentation only: retain all attempts, but put an explicitly retired execution in history. */
export function splitResearchSessions(sessions: ResearchSessionDescriptor[]) {
  const latest = new Map<string, ResearchSessionDescriptor>()
  for (const item of sessions) {
    if (item.role !== 'sister' || !item.taskId) continue
    const previous = latest.get(item.taskId)
    if (!previous || item.generation > previous.generation || (item.generation === previous.generation && item.attempt > previous.attempt)) latest.set(item.taskId, item)
  }
  const current: ResearchSessionDescriptor[] = [], history: ResearchSessionDescriptor[] = []
  for (const item of sessions) {
    const retired = item.isCurrent === false || (item.isCurrent === undefined && item.role === 'sister' && item.taskId && latest.get(item.taskId) !== item)
    ;(retired ? history : current).push(item)
  }
  return { current, history }
}
