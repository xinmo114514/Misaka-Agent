const PHASE_LABELS: Record<string, string> = {
  created: '规划中', planning: '规划中', awaiting_approval: '待审批',
  waiting_input: '待用户输入', executing: '执行中', active: '执行中',
  critique: '红队审查', critiquing: '红队审查', red_team_review: '红队审查',
  divergence: '歧路审查', diverging: '歧路审查', divergence_review: '歧路审查',
  reconciling: '分支审查', deciding: '分支审查', adjudication: '报告生成',
  adjudication_survey: '报告生成', adjudication_draft: '报告生成',
  adjudication_review: '报告审查', done: '已完成', stopped: '已停止',
  stopping: '正在停止', failed: '失败', error: '失败',
  partial: '已暂停', cancelled: '已停止', closed: '已完成',
}

export function researchPhaseLabel(raw?: string | null): string {
  if (!raw) return '状态待同步'
  return PHASE_LABELS[raw.toLowerCase()] ?? raw.replaceAll('_', ' ')
}

const NODE_LABELS: Record<string, string> = {
  closed: '已完成', done: '已完成', awaiting_approval: '待审批',
  waiting_input: '待用户输入', planning: '规划中', queued: '排队中',
  parked: '已搁置', failed: '失败', stopping: '正在停止',
  executing: '执行中', synthesizing: '整理结论', critiquing: '红队审查',
  critique: '红队审查', diverging: '歧路审查', divergence: '歧路审查',
  deciding: '分析分歧', filling_gaps: '补充研究', disposing: '处理审查意见',
  reconciling: '分支汇总',
}

export function researchNodeLabel(raw?: string | null): string {
  if (!raw) return '状态待同步'
  return NODE_LABELS[raw.toLowerCase()] ?? researchPhaseLabel(raw)
}

export function researchOverview(nodes: Array<{ status?: string }>): Array<{ status: string; label: string; count: number }> {
  const counts = new Map<string, number>()
  for (const node of nodes) {
    const status = node.status || 'unknown'
    counts.set(status, (counts.get(status) ?? 0) + 1)
  }
  return [...counts.entries()].map(([status, count]) => ({ status, label: researchNodeLabel(status), count }))
}

const RUN_TERMINAL = new Set(['done', 'stopped', 'failed', 'error', 'cancelled', 'partial', 'closed'])

/** The run's display label: a business terminal state wins over a stale phase (Task 6).
 *
 * The 2026-10-11 incident showed a failed run as 执行中 because the UI read phase || status;
 * the phase column legitimately still said active while the status column said failed.
 */
export function researchRunLabel(run: { status?: string | null; phase?: string | null } | null | undefined): string {
  if (!run) return '状态待同步'
  const statusValue = (run.status || '').toLowerCase()
  if (statusValue && (RUN_TERMINAL.has(statusValue) || statusValue === 'stopping' || statusValue === 'waiting_input')) return researchPhaseLabel(statusValue)
  return researchPhaseLabel(run.phase || run.status)
}
