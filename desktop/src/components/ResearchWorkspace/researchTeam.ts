import type { ResearchGraphNode, ResearchSessionDescriptor, ResearchSessionsPayload } from '../../types/research'
import { splitResearchSessions } from './researchPresentation'

export interface TeamMember {
  descriptor: ResearchSessionDescriptor
  /** Older generations / attempts of the same card; the caller collapses them. */
  history: ResearchSessionDescriptor[]
}

export interface TeamGroup {
  node: ResearchGraphNode | null
  /** The node's own question, or the fallback heading for sessions with no node. */
  title: string
  members: TeamMember[]
}

const statusRank = (item: ResearchSessionDescriptor) => item.status === 'running' || item.status === 'executing' ? 0
  : ['failed', 'error', 'stopped'].includes(item.status) ? 1 : 2
const recent = (a: ResearchSessionDescriptor, b: ResearchSessionDescriptor) =>
  statusRank(a) - statusRank(b) || (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0)
const latestFirst = (a: ResearchSessionDescriptor, b: ResearchSessionDescriptor) =>
  b.generation - a.generation || b.attempt - a.attempt

/**
 * The members of one node: its controller first, then the cards working for it.
 *
 * A card that ran more than once keeps only its newest generation here; the older ones are
 * returned beside it as history so they stay readable without inflating the member count.
 */
export function teamMembers(sessions: ResearchSessionDescriptor[], nodeId?: string | null): TeamMember[] {
  const local = sessions.filter(item => !nodeId || item.nodeId === nodeId)
  const coordinator = local.filter(item => item.role === 'last_order')
  const { current, history } = splitResearchSessions(local.filter(item => item.role !== 'last_order'))
  const byTask = new Map<string, ResearchSessionDescriptor[]>()
  for (const item of history) {
    if (!item.taskId) continue
    byTask.set(item.taskId, [...(byTask.get(item.taskId) ?? []), item])
  }
  return [
    ...coordinator.map(descriptor => ({ descriptor, history: [] })),
    ...current.sort(recent).map(descriptor => ({
      descriptor,
      history: (byTask.get(descriptor.taskId ?? '') ?? []).filter(item => item !== descriptor).sort(latestFirst),
    })),
  ]
}

/**
 * The whole catalog, grouped by the node each session actually belongs to.
 *
 * Graph order is the order, because the nodes are the research plan: a directory that re-sorted
 * them by status would stop matching the graph the run is following.
 */
export function teamGroups(listing: ResearchSessionsPayload): TeamGroup[] {
  const nodes = listing.graph.nodes ?? []
  const groups: TeamGroup[] = nodes.map(node => ({
    node, title: node.question, members: teamMembers(listing.sessions, node.id),
  }))
  const known = new Set(nodes.map(node => node.id))
  const orphans = listing.sessions.filter(item => !known.has(item.nodeId))
  if (orphans.length) groups.push({ node: null, title: '未归属节点的会话', members: teamMembers(orphans) })
  return groups.filter(group => group.members.length > 0)
}

/** Counts for the header pill: current members only, never folded historical generations. */
export function teamTotals(groups: TeamGroup[]): { current: number; live: number } {
  const members = groups.flatMap(group => group.members)
  return {
    current: members.length,
    live: members.filter(member => ['running', 'executing', 'active'].includes(member.descriptor.status)).length,
  }
}

/** The run's own main controller, which is the root node's Last Order session. */
export function rootControllerId(listing: ResearchSessionsPayload): string | null {
  const root = listing.graph.nodes.find(node => node.kind === 'root') ?? listing.graph.nodes[0]
  const controllers = listing.sessions.filter(item => item.role === 'last_order')
  return (controllers.find(item => item.nodeId === root?.id) ?? controllers[0])?.executorId ?? null
}

/**
 * How a member is named in a directory or breadcrumb.
 *
 * Only the run's own controller is "主控"; a branch node's Last Order is a local coordinator with
 * its own name, and calling it 主控 too would make the breadcrumb claim the reader is at the top.
 */
export function sessionLabel(descriptor: ResearchSessionDescriptor, controllerId: string | null): string {
  if (descriptor.role === 'last_order') {
    return descriptor.executorId === controllerId ? '主控' : descriptor.cardTitle || descriptor.label || 'Last Order'
  }
  return descriptor.cardTitle || descriptor.label
}

/**
 * Which session the main area shows.
 *
 * Absent means "the node's controller", so a reader who never browsed gets the controller without
 * any state having to be written. A remembered executor that no longer exists in this listing is
 * ignored rather than left as a blank pane.
 */
export function resolveMainSession(listing: ResearchSessionsPayload, nodeId: string | null, mainExecutorId?: string | null): ResearchSessionDescriptor | null {
  const chosen = mainExecutorId ? listing.sessions.find(item => item.executorId === mainExecutorId) : undefined
  if (chosen) return chosen
  const local = listing.sessions.find(item => item.role === 'last_order' && (!nodeId || item.nodeId === nodeId))
  if (local) return local
  const rootId = rootControllerId(listing)
  return listing.sessions.find(item => item.executorId === rootId) ?? listing.sessions[0] ?? null
}
