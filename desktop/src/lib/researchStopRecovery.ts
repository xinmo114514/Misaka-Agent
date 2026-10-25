import { request } from './bridge'
import type { ResearchControlTarget } from './researchView'
import type { ResearchRunDetail } from '../types/research'

export type ResearchStopTarget = Extract<ResearchControlTarget, { kind: 'run' }>

/** Compare Windows paths as Windows paths, while preserving case-sensitive POSIX hosts. */
export function sameResearchStopPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const path = value.replace(/\\/g, '/').replace(/\/+$/, '')
    return /^[a-z]:(?:$|\/)/i.test(path) || path.startsWith('//') ? path.toLowerCase() : path
  }
  return normalize(left) === normalize(right)
}

/** A retry never trusts stale page metadata or silently adopts another run's root. */
export async function refreshResearchStopTarget(target: ResearchStopTarget): Promise<ResearchRunDetail> {
  const detail = await request<ResearchRunDetail>('get_research_details', { runId: target.runId, workspace: target.workspace })
  const run = detail?.run
  const expectedRoot = target.sessionFile || target.rootSession
  if (!run || run.id !== target.runId || !run.workspace || !run.rootSession
    || (target.workspace && !sameResearchStopPath(target.workspace, run.workspace))
    || (expectedRoot && !sameResearchStopPath(expectedRoot, run.rootSession))) {
    throw new Error('研究控制目标已变更或根会话缺失，请重新打开原研究后再停止。')
  }
  return detail
}
