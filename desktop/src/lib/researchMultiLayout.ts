import type { ResearchSessionDescriptor } from '../types/research'
import { splitResearchSessions } from '../components/ResearchWorkspace/researchPresentation'

export const RESEARCH_MULTI_MEMBER_LIMIT = 6

export interface ResearchMosaicLayout {
  spans: number[]
  rowCount: number
  columns: 6
  soloController: boolean
}

interface ResearchSessionListing {
  sessions: ResearchSessionDescriptor[]
}

export function selectResearchMultiSessions(
  listing: ResearchSessionListing | null | undefined,
  nodeId: string | null | undefined,
  focusedId: string | null | undefined,
  pinnedIds: readonly string[],
): ResearchSessionDescriptor[] {
  if (!listing || !nodeId) return []
  const local = listing.sessions.filter(session => session.nodeId === nodeId)
  const controller = local.find(session => session.role === 'last_order')
  const { current, history } = splitResearchSessions(local.filter(session => session.role !== 'last_order'))
  const priority = (session: ResearchSessionDescriptor) => session.status === 'running' ? 0
    : ['failed', 'error', 'stopped'].includes(session.status) ? 1
      : session.status === 'ready' ? 2 : 3
  const rank = (a: ResearchSessionDescriptor, b: ResearchSessionDescriptor) => priority(a) - priority(b)
    || (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0)
  const others = [...current.sort(rank), ...history.sort(rank)]
  const preferredIds = [...new Set([focusedId, ...pinnedIds])]
  const preferred = preferredIds
    .map(id => others.find(session => session.executorId === id))
    .filter((session): session is ResearchSessionDescriptor => Boolean(session))
  const members = [...preferred, ...others.filter(session => !preferred.includes(session))]
    .slice(0, RESEARCH_MULTI_MEMBER_LIMIT)
  return [...(controller ? [controller] : []), ...members]
}

const CONTROLLER_WIDE = [
  [6],
  [3, 3],
  [2, 2, 2],
  [3, 3, 3, 3],
  [4, 2, 2, 2, 2],
  [2, 2, 2, 2, 2, 2],
  [6, 2, 2, 2, 2, 2, 2],
] as const

const CONTROLLER_MEDIUM = [
  [6],
  [3, 3],
  [6, 3, 3],
  [3, 3, 3, 3],
  [6, 3, 3, 3, 3],
  [3, 3, 3, 3, 3, 3],
  [6, 3, 3, 3, 3, 3, 3],
] as const

const MEMBER_ONLY_WIDE = [
  [],
  [6],
  [3, 3],
  [2, 2, 2],
  [3, 3, 3, 3],
  [2, 2, 2, 3, 3],
  [2, 2, 2, 2, 2, 2],
] as const

const MEMBER_ONLY_MEDIUM = [
  [],
  [6],
  [3, 3],
  [3, 3, 6],
  [3, 3, 3, 3],
  [3, 3, 3, 3, 6],
  [3, 3, 3, 3, 3, 3],
] as const

function countPackedRows(spans: readonly number[]): number {
  let rows = 0
  let occupied = 0
  for (const span of spans) {
    if (occupied === 0 || occupied + span > 6) {
      rows += 1
      occupied = span
    } else {
      occupied += span
    }
    if (occupied === 6) occupied = 0
  }
  return rows
}

export function getResearchMosaicLayout(
  width: number,
  memberCount: number,
  hasController: boolean,
): ResearchMosaicLayout {
  const count = Number.isFinite(memberCount)
    ? Math.min(RESEARCH_MULTI_MEMBER_LIMIT, Math.max(0, Math.trunc(memberCount)))
    : 0
  let spans: readonly number[]
  if (width < 820) {
    spans = Array(count + (hasController ? 1 : 0)).fill(6)
  } else if (width < 1100) {
    spans = (hasController ? CONTROLLER_MEDIUM : MEMBER_ONLY_MEDIUM)[count]
  } else {
    spans = (hasController ? CONTROLLER_WIDE : MEMBER_ONLY_WIDE)[count]
  }
  return {
    spans: [...spans],
    rowCount: countPackedRows(spans),
    columns: 6,
    soloController: hasController && count === 0,
  }
}

export function researchMosaicRowCap(height: number, rows: number, soloController: boolean): number {
  if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(rows) || rows <= 0) return 264
  const measuredCap = soloController ? Math.min(height, 720) : (height - 12 * (Math.ceil(rows) - 1)) / Math.ceil(rows)
  return Math.min(soloController ? 720 : 420, Math.max(264, measuredCap))
}
