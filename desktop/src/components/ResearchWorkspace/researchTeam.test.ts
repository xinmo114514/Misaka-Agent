import { describe, expect, it } from 'vitest'
import type { ResearchGraphNode, ResearchSessionDescriptor, ResearchSessionsPayload } from '../../types/research'
import { resolveMainSession, resolveResearchNodeId, rootControllerId } from './researchTeam'

const node = (id: string, kind: ResearchGraphNode['kind'], question = `${id} question`): ResearchGraphNode => ({
  id, question, kind, depth: kind === 'root' ? 0 : 1, status: 'active', parents: [], children: [],
})

const session = (executorId: string, nodeId: string, role: ResearchSessionDescriptor['role']): ResearchSessionDescriptor => ({
  executorId, sessionId: executorId, sessionFile: null, nodeId, taskId: executorId, role,
  label: executorId, workspace: 'C:/fixture', status: 'running', generation: 1, attempt: 1,
  startedAt: 1, endedAt: null, error: null,
})

const listing = (nodes: ResearchGraphNode[], sessions: ResearchSessionDescriptor[] = []): ResearchSessionsPayload => ({
  runId: 'r',
  run: { id: 'r', question: 'Q', workspace: 'C:/fixture', status: 'active', phase: 'cards', nodes: nodes.length, tasks: sessions.length },
  graph: { run: 'r', question: 'Q', status: 'active', phase: 'cards', nodes },
  sessions, suspension: null, suspensions: [],
})

describe('resolveResearchNodeId', () => {
  it('retains a selection that still belongs to the graph', () => {
    const payload = listing([node('first', 'alt'), node('root', 'root'), node('branch', 'alt')])
    expect(resolveResearchNodeId(payload, 'branch')).toBe('branch')
  })

  it('falls back from a deleted selection to the real root rather than graph order', () => {
    const payload = listing([node('first', 'alt'), node('root', 'root')])
    expect(resolveResearchNodeId(payload, 'deleted')).toBe('root')
  })

  it('uses the first node only when the graph has no root', () => {
    expect(resolveResearchNodeId(listing([node('first', 'alt'), node('second', 'join')]), null)).toBe('first')
  })

  it('returns null while no graph listing or node exists', () => {
    expect(resolveResearchNodeId(undefined, 'former')).toBeNull()
    expect(resolveResearchNodeId(listing([]), 'former')).toBeNull()
  })
})

describe('resolveMainSession', () => {
  it('keeps an explicit reader even when it belongs to another node', () => {
    const root = session('root-controller', 'root', 'last_order')
    const branchMember = session('branch-member', 'branch', 'sister')
    const payload = listing([node('root', 'root'), node('branch', 'alt')], [root, branchMember])
    expect(resolveMainSession(payload, 'root', 'branch-member')).toBe(branchMember)
  })

  it('waits on a selected node with no coordinator instead of borrowing an unrelated session', () => {
    const root = session('root-controller', 'root', 'last_order')
    const branchMember = session('branch-member', 'branch', 'sister')
    const payload = listing([node('root', 'root'), node('branch', 'alt')], [root, branchMember])
    expect(resolveMainSession(payload, 'branch')).toBeNull()
  })

  it('falls back from a deleted node selection to the real root controller', () => {
    const root = session('root-controller', 'root', 'last_order')
    const payload = listing([node('branch', 'alt'), node('root', 'root')], [root])
    expect(resolveMainSession(payload, 'deleted')).toBe(root)
  })
})

describe('rootControllerId', () => {
  it('treats the first node as the writable root for a legacy graph with no root kind', () => {
    const legacyController = session('legacy-controller', 'first', 'last_order')
    const payload = listing([node('first', 'alt'), node('second', 'join')], [legacyController])
    expect(rootControllerId(payload)).toBe('legacy-controller')
  })

  it('does not promote another node coordinator when the root controller is absent', () => {
    const branchCoordinator = session('branch-coordinator', 'branch', 'last_order')
    const payload = listing([node('root', 'root'), node('branch', 'alt')], [branchCoordinator])
    expect(rootControllerId(payload)).toBeNull()
  })
})
