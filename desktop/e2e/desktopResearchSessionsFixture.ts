import type { BridgeMessage } from '../src/types/global'
import type { ResearchSessionDescriptor, ResearchSessionsPayload } from '../src/types/research'

/**
 * Research sessions for the browser harness.
 *
 * The focus view and the tile grid read the same projections the desktop host produces, so a
 * browser acceptance run needs a team whose nodes, generations and statuses look like a real run:
 * a controller for every node, one card working for each branch node, and one card that ran twice
 * so the folded history has something to fold.
 */
let enabled = false
let question = ''
let readError: string | null = null
/** Live rows of the root controller, which the host writes into its own session file. */
let live: (executorId: string) => any[] = () => []

export function enableResearchSessions(value: { question: string }) {
  enabled = true
  question = value.question
}

export function resetResearchSessions() {
  enabled = false
  question = ''
  readError = null
  // `live` stays: it reads an array the harness clears in place, so it survives a reset.
}

export function setResearchSessionsReadError(error: string | null) {
  readError = error
}

/**
 * The root controller's session is the run's own conversation.
 *
 * The host appends what the engine reports -- the question, the discipline notice, the final
 * report -- to the controller's transcript, so a surface that reads that session sees them. A
 * browser fixture has to join the same two sources or the notice rows would only exist in the
 * live stream, which no research transcript reads.
 */
export function setResearchSessionsLive(reader: (executorId: string) => any[]) {
  live = reader
}

/** A timestamp inside the last ten minutes, so elapsed labels read like a live run. */
const at = (minutes: number) => Date.now() - (10 - minutes) * 60_000
const telemetry = (input: number, output: number) => ({
  cwd: 'C:/research', tokens: { input, output, cacheRead: 0, cacheWrite: 0 }, cost: null, cacheHitRate: null,
  contextUsage: { tokens: input + output, contextWindow: 128000, percent: 0.05 },
  model: { provider: 'fixture', modelId: 'fixture-model' }, thinkingLevel: 'high',
  permissionMode: 'bypassPermissions', autoCompact: true, compactionCount: 0, subscription: null,
})
const session = (id: string, nodeId: string, role: ResearchSessionDescriptor['role'], label: string, status: string,
  extra: Partial<ResearchSessionDescriptor> = {}): ResearchSessionDescriptor => ({
  executorId: id, sessionId: `session-${id}`, sessionFile: `C:/research/.misaka/sessions/${id}.jsonl`, nodeId,
  taskId: role === 'last_order' ? null : `task-${nodeId}`, role, label, workspace: 'C:/research', status,
  generation: 0, attempt: 1, startedAt: at(0), endedAt: status === 'running' ? null : at(6), error: null,
  isCurrent: true, telemetry: telemetry(4200, 1800), ...extra,
})

const nodes = () => [
  { id: 'b_root', question, depth: 0, status: 'closed', kind: 'root', parents: [], children: ['b_retrieval', 'b_context', 'b_join'],
    cards: [{ id: 'task-b_retrieval', title: '检索召回与引用可追溯性', kind: 'research', status: 'done', assignee: 'fixture-sister' },
      { id: 'task-b_context', title: '长上下文跨段整合', kind: 'research', status: 'running', assignee: 'fixture-sister' }] },
  { id: 'b_retrieval', question: '检索路线的优势与局限', depth: 1, status: 'closed', kind: 'alt', parents: ['b_root'], children: [], cards: [] },
  { id: 'b_context', question: '长上下文路线的优势与局限', depth: 1, status: 'closed', kind: 'alt', parents: ['b_root'], children: [], cards: [] },
  { id: 'b_join', question: '汇总两条证据路径', depth: 1, status: 'closed', kind: 'join', parents: ['b_retrieval', 'b_context'], children: [], cards: [] },
]

const sessions = () => [
  session('lo-root', 'b_root', 'last_order', '主控', 'running', { cardTitle: question }),
  session('lo-retrieval', 'b_retrieval', 'last_order', '检索节点主控', 'done'),
  session('s-retrieval', 'b_retrieval', 'sister', '检索证据卡', 'done',
    { cardTitle: '检索召回与引用可追溯性', generation: 1, attempt: 2, telemetry: telemetry(9600, 2400) }),
  // The same card before its retry: readable history that must not count as a member.
  session('s-retrieval-r1', 'b_retrieval', 'sister', '检索证据卡', 'failed', { cardTitle: '检索召回与引用可追溯性',
    generation: 1, attempt: 1, isCurrent: false, endedAt: at(3), error: '连接中断，已重试', telemetry: telemetry(1200, 400) }),
  session('lo-context', 'b_context', 'last_order', '上下文节点主控', 'done'),
  session('s-context', 'b_context', 'sister', '长上下文证据卡', 'running', { cardTitle: '长上下文跨段整合', telemetry: telemetry(7400, 900) }),
  session('lo-join', 'b_join', 'last_order', '汇总节点主控', 'ready'),
]

export function researchSessionsPayload(runId: string): ResearchSessionsPayload {
  return {
    runId,
    run: { id: runId, question, workspace: 'C:/research', nodes: nodes().length, tasks: 4, status: 'active',
      phase: 'reconciling', driving: true } as never,
    graph: { run: runId, question, status: 'active', phase: 'reconciling', nodes: nodes(), decisions: [], relations: [], reconciles: [], paths: [] } as never,
    sessions: sessions(), suspension: null, suspensions: [],
  }
}

const transcript = (executorId: string) => {
  const descriptor = sessions().find(item => item.executorId === executorId)
  const card = descriptor?.role === 'sister'
  const opening = card ? '核验检索召回与引用可追溯性。' : '比较检索增强生成与长上下文两条证据路线。'
  return [
    { id: `${executorId}-u`, entryId: `${executorId}-u`, role: 'user', content: opening, timestamp: at(1),
      blocks: [{ type: 'text', id: `${executorId}-u-t`, contentIndex: 0, isStreaming: false, text: opening }] },
    { id: `${executorId}-a`, entryId: `${executorId}-a`, role: 'assistant', timestamp: at(2),
      blocks: [
        { type: 'text', id: `${executorId}-a-t`, contentIndex: 0, isStreaming: false, text: card
          ? '十篇样本里，检索路线把每条结论都定位到了证据片段，但召回受索引覆盖面影响；长上下文路线在跨段整合上更稳，代价是窗口与噪声。\n\n两类限制都不来自方法本身，而来自语料规模和问题边界。'
          : '先把两条路线拆成可核验的比较维度：召回、跨段整合、引用可追溯性。检索路线便于逐条定位，长上下文路线在跨段指代上更完整。\n\n下面把证据核验交给两张独立卡片，避免同一个上下文里互相迁就。' },
        { type: 'toolCall', id: `${executorId}-a-tool`, contentIndex: 1, toolCall: { id: `${executorId}-call`, name: 'read',
          status: 'success', result: [{ type: 'text', text: '研究论文/benchmarks.md\n检索结果可逐项定位到证据片段。\n'.repeat(3) }] } },
        { type: 'text', id: `${executorId}-a-t2`, contentIndex: 2, isStreaming: false,
          text: '结论按任务设定与语料特征区分，不给出脱离条件的胜负判断。' },
      ] },
  ]
}

/**
 * What a saved session file holds right now.
 *
 * The root controller's file is the run's own conversation: the engine's rows are persisted into
 * it, exactly as the host does, so a surface that reads that session sees them. A browser fixture
 * has to join the same two sources; keeping the join in one place keeps the version it publishes
 * equal to the version a reader would load.
 */
export function researchSessionRows(executorId: string): any[] {
  const descriptor = sessions().find(item => item.executorId === executorId)
  return descriptor?.role === 'last_order' ? [...transcript(executorId), ...live(executorId)] : transcript(executorId)
}

export function researchSessionVersion(executorId: string): string {
  return `v1:${researchSessionRows(executorId).length}`
}

export function handleResearchSessionsCommand(command: any, emit: (message: BridgeMessage) => void): boolean {
  if (!enabled) return false
  if (command.type === 'get_research_sessions') {
    if (readError) {
      emit({ type: 'ack', requestId: command.requestId, ok: false, error: readError })
      return true
    }
    emit({ type: 'ack', requestId: command.requestId, ok: true, data: researchSessionsPayload(String(command.runId)) })
    return true
  }
  if (command.type === 'get_research_session_history') {
    const executorId = String(command.executorId)
    const descriptor = sessions().find(item => item.executorId === executorId)
    emit({ type: 'ack', requestId: command.requestId, ok: true, data: { runId: command.runId, executorId,
      messages: researchSessionRows(executorId), nextCursor: null, hasMore: false,
      availability: descriptor?.sessionId ? 'available' : 'not_started', historyVersion: researchSessionVersion(executorId),
      telemetry: descriptor?.telemetry ?? null, error: descriptor?.error ?? null } })
    return true
  }
  return false
}

export function handleResearchSessionsWatch(command: any, emit: (message: BridgeMessage) => void): boolean {
  if (!enabled) return false
  if (command.type === 'watch_research_sessions') {
    emit({ type: 'ack', requestId: command.requestId, ok: true, data: { subscriptionId: `sub-${command.runId}` } })
    return true
  }
  if (command.type === 'unwatch_research_sessions') {
    emit({ type: 'ack', requestId: command.requestId, ok: true, data: { unsubscribed: true } })
    return true
  }
  return false
}
