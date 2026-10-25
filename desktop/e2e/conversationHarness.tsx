import { createRoot } from 'react-dom/client'
import App from '../src/App'
import '../src/index.css'
import fixture from '../../tests/fixtures/desktop_conversation.json'
import { useSessionStore } from '../src/store/useSessionStore'
import { useResearchStopStore } from '../src/store/useResearchStopStore'
import { useResearchResumeStore } from '../src/store/useResearchResumeStore'
import { resetResearchStopTimers } from '../src/lib/researchStop'
import { useSettingsStore } from '../src/store/useSettingsStore'
import { assistantBlocks, normalizeChatMessage } from '../src/lib/messageBlocks'
import { applyThemeToDom } from '../src/theme/useTheme'
import type { BridgeMessage, ThemeData } from '../src/types/global'
import { toThemeData } from '../src/theme/registry'
import { fixtureThemes, themeGraph } from './themeFixture'
import { modelPickerFixture, pickerReply } from './modelPickerFixture'
import { sessionHistoryCache } from '../src/lib/sessionHistoryCache'
import { forgetSessionView } from '../src/lib/sessionViewState'
import { desktopResearchTeamFixture, handleDesktopResearchTeamCommand } from './desktopResearchTeamFixture'
import { enableResearchSessions, handleResearchSessionsCommand, handleResearchSessionsWatch, researchSessionVersion, resetResearchSessions, setResearchSessionsLive, setResearchSessionsReadError } from './desktopResearchSessionsFixture'

const listeners = new Set<(message: BridgeMessage) => void>()
const sent: any[] = []
const histories = new Map<string, { messages: any[]; workspace: string; version: string }>()
let readyDelay = 0
let nextPromptFailure: string | null = null
// Opt-in Composer acceptance controls. Defaults leave all other fixture flows unchanged.
let composerAttachmentFailure = false
let composerHoldSubmission = false
let composerSubmissionFailure: string | null = null
const composerPendingSubmissions: Array<() => void> = []
let graphEnabled = false
const researchListeners = new Set<(message: BridgeMessage) => void>()
let researchPhase: 'idle' | 'plan' | 'critique' | 'branches' | 'done' | 'waiting_input' | 'stopping' | 'stopped' | 'failed' = 'idle'
let researchStopHold = false
let researchStopPendingNotice = false
let inheritedStopDriving: boolean | null = null
let researchStopLeaseHold = false
let researchOpenRunId: string | null = null
let researchQuestion = ''
let researchPlanRound = 1
let researchPlanId = 'plan-r1'
let researchStartArgs: Record<string, any> | null = null
let activeTheme = fixtureThemes.get('light')!
const themeListeners = new Set<(theme: ThemeData) => void>()
const researchOptions = {
  defaults: { max_depth: 3, parallel: 4, sister_parallel: 4, max_followups: 2, max_revisions: 2, max_nodes: 30, plan_approval: true },
  constraints: {
    max_depth: { min: 0, max: 12 }, max_nodes: { min: 1, max: 500 },
    parallel: { min: 1 }, sister_parallel: { min: 1 },
    max_followups: { min: 0, max: 6 }, max_revisions: { min: 0, max: 6 },
  },
  sisters: [{ id: 'literature-reviewer', name: '文献综述专家', description: '比较证据质量与基准' }],
}
const desktopAck = (command: any, data: any) => broadcast({ type: 'ack', requestId: command.requestId ?? null, ok: true, data })
const researchAck = (command: any, data: any) => broadcastResearch({ type: 'ack', requestId: command.requestId ?? null, ok: true, data })
const researchPlan = () => ({
  plan_markdown: researchPlanRound === 1
    ? '## 初始计划\n\n比较检索增强生成与长上下文方法，并检查引用可追溯性。'
    : '## 修订计划\n\n补充长上下文的失效条件与基准来源，并比较引用可追溯性。',
  tasks: [{ local_id: 'task-literature', title: '跨文献基准比较任务',
    body: '核验文献问答中的检索召回、长上下文整合与证据引用。', rationale: '覆盖可核验性和任务边界。',
    assignee: 'literature-reviewer', deliverable: '带引用的比较结论', dependencies: [] }],
})
const researchTask = () => ({
  id: 'task-literature', title: '文献基准比较结果',
  body: '专家交付全文：比较检索召回、长上下文跨段整合和引用可核验性。\n\n结论按任务设定与语料特征区分。',
  status: 'closed', kind: 'research', round: 1, attempt: 1, assignee: 'literature-reviewer',
  artifacts: [{ id: 'artifact-task-full', kind: 'research', title: '专家交付全文', path: 'artifacts/literature-comparison.md', state: 'available',
    content: '专家交付全文：比较检索召回、长上下文跨段整合和引用可核验性。' }],
  findings: [{ id: 'finding-rag', text: '10 篇样本中，长上下文在跨段整合上更稳，但检索更便于追溯证据。',
    claim_type: 'inference', citations: [{ artifact_id: 'artifact-task-full', source_file: '研究论文/benchmarks.md',
      quote: '检索结果可逐项定位到证据片段', evidence_sha: 'sha256-fixture' }] }],
})
const researchGraph = () => {
  const rootStatus = researchPhase === 'plan' ? 'awaiting_approval'
    : researchPhase === 'critique' ? 'critique' : researchPhase === 'branches' ? 'closed' : 'closed'
  const root = { id: 'b_root', question: researchQuestion, depth: 0, status: rootStatus,
    kind: 'root', parents: [], children: researchPhase === 'branches' || researchPhase === 'done'
      ? ['b_retrieval', 'b_context', 'b_join'] : [],
    cards: researchPhase === 'critique' || researchPhase === 'branches' || researchPhase === 'done'
      ? [{ id: 'task-literature', title: '文献基准比较结果', kind: 'research', status: 'closed', assignee: 'literature-reviewer' }] : [],
    red_team: researchPhase === 'critique' ? { assignee: 'red-team-reviewer', reason: '检查证据覆盖范围' } : null }
  const graph: any = {
    run: 'r_desktop_fixture', question: researchQuestion,
    status: ['done', 'waiting_input', 'stopped', 'failed'].includes(researchPhase) ? researchPhase : 'active',
    phase: researchPhase === 'plan' ? 'awaiting_approval' : researchPhase === 'critique' ? 'critique'
      : researchPhase === 'branches' ? 'reconciling' : 'done',
    limits: researchStartArgs?.limits ?? researchOptions.defaults,
    nodes: [root], decisions: [], relations: [], reconciles: [], paths: [], final_artifacts: [],
  }
  if (researchPhase === 'branches' || researchPhase === 'done') {
    graph.nodes.push(
      { id: 'b_retrieval', question: '检索路线的优势与局限', depth: 1, status: 'closed', kind: 'alt', parents: ['b_root'], children: [], cards: [] },
      { id: 'b_context', question: '长上下文路线的优势与局限', depth: 1, status: 'closed', kind: 'alt', parents: ['b_root'], children: [], cards: [] },
      { id: 'b_join', question: '汇总两条证据路径', depth: 1,
        status: researchPhase === 'done' ? 'closed' : 'awaiting_approval', kind: 'join',
        parents: ['b_retrieval', 'b_context'], children: [], cards: [] },
    )
    graph.decisions = [{ id: 'decision-1', node: 'b_root', question: '哪些证据路径最能解释差异？', stakes: '避免脱离任务设定泛化结论。',
      options: [
        { id: 'retrieval', label: '检索路线', premise: '保留逐条证据定位', outcome: '便于核验但召回受索引影响' },
        { id: 'long-context', label: '长上下文路线', premise: '整体输入相关章节', outcome: '跨段整合稳但受窗口与噪声影响' },
      ] }]
    graph.relations = [{ kind: 'convergence', nodes: ['b_retrieval', 'b_context', 'b_join'], note: '两条路径汇入任务边界结论。' }]
    graph.reconciles = [{ round: 1, applied: researchPhase === 'done', summary: '并列保留检索可追溯性与长上下文跨段整合优势，明确适用条件。' }]
  }
  if (researchPhase === 'done') graph.final_artifacts = [{ id: 'a_report', kind: 'final', title: 'RAG 与长上下文文献问答研究报告',
    path: 'rag-literature-review.md', state: 'available' }]
  return graph
}
const researchRun = () => ({
  id: 'r_desktop_fixture', question: researchQuestion, workspace: 'C:/research',
  status: ['done', 'waiting_input', 'stopping', 'stopped', 'failed'].includes(researchPhase) ? researchPhase : 'active',
  phase: researchPhase === 'plan' ? 'awaiting_approval' : researchPhase === 'critique' ? 'critique'
    : researchPhase === 'branches' ? 'reconciling' : researchPhase === 'stopping' ? 'stopping' : 'done',
  nodes: researchPhase === 'branches' || researchPhase === 'done' ? 4 : 1,
  tasks: researchPhase === 'critique' || researchPhase === 'branches' || researchPhase === 'done' ? 1 : 0,
  final_artifact: researchPhase === 'done' ? 'a_report' : null,
  rootSession: 'C:/research/.misaka/sessions/research-root.jsonl',
  driving: researchPhase === 'stopped' && researchStopLeaseHold ? true
    : researchPhase === 'stopping' && inheritedStopDriving !== null ? inheritedStopDriving : !['done', 'stopped', 'failed'].includes(researchPhase)
})
const researchRunDetail = () => ({
  run: researchRun(), graph: researchGraph(), pending_questions: [],
  root_context: { stats: { totalMessages: 34 }, contextUsage: { tokens: 6400, contextWindow: 128000, percent: 0.05 } },
})
const researchNodeDetail = (nodeId: string) => {
  const node = researchGraph().nodes.find((item: any) => item.id === nodeId) || researchGraph().nodes[0]
  const task = researchTask()
  return {
    node: { id: node.id, question: node.question, depth: node.depth, status: node.status, kind: node.kind },
    plan_round: researchPlanRound, plan: node.id === 'b_root' && researchPhase !== 'branches' && researchPhase !== 'done' ? researchPlan() : null,
    plan_tool_call_id: researchPlanId,
    available_tools: researchPhase === 'plan' ? ['misaka_research_assign', 'misaka_research_start']
      : researchPhase === 'branches' && node.id === 'b_root' ? ['misaka_research_start']
        : researchPhase === 'critique' ? ['misaka_research_skip'] : [],
    cards: researchPhase === 'critique' || researchPhase === 'branches' || researchPhase === 'done' ? [task] : [],
    artifacts: researchPhase === 'critique' || researchPhase === 'branches' || researchPhase === 'done' ? [
      { id: 'a_synthesis', kind: 'synthesis', title: '完整节点结论', path: 'artifacts/synthesis.md', state: 'available',
        content: '完整节点结论：两种方法各有边界，依据语料、窗口和追溯要求选择。' },
      { id: 'a_critique', kind: 'critique', title: '红队审查', path: 'artifacts/red-team.md', state: 'available',
        content: '完整红队审查正文：补充来源偏倚与上下文窗口边界。' },
    ] : [],
    findings: researchPhase === 'critique' || researchPhase === 'branches' || researchPhase === 'done' ? task.findings : [],
    issues: researchPhase === 'critique' || researchPhase === 'branches' || researchPhase === 'done' ? [
      { id: 'issue-scope', question: '结论是否区分任务规模与检索质量？', rationale: '两项变量都可能改变方法表现。',
        disposition: '已补充对照', reason: '在修订结论中分别标注语料规模与证据追溯条件。' },
    ] : [],
    errata: [],
    red_team: researchPhase === 'critique' || researchPhase === 'branches' || researchPhase === 'done'
      ? { assignee: 'red-team-reviewer', reason: '审查来源偏倚与窗口边界' } : null,
  }
}
const researchReport = { id: 'a_report', kind: 'final', title: 'RAG 与长上下文文献问答研究报告',
  path: 'rag-literature-review.md', state: 'available',
  content: '# RAG 与长上下文文献问答研究报告\n\n结论：两种路线互补，不存在脱离语料与任务设定的普遍最优方案。\n\n## 参考文献\n\n[1] Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks.\n[2] Lost in the Middle: How Language Models Use Long Contexts.' }
function broadcast(message: BridgeMessage) { for (const callback of listeners) callback(message) }
function broadcastResearch(message: BridgeMessage) { for (const callback of researchListeners) callback(message) }
let researchSeq = 0
const researchTranscript: any[] = []
function emitResearchMessage(message: any) {
  const raw = { timestamp: Date.now(), ...message }
  const id = `research-message-${researchSeq + 1}`
  researchTranscript.push(normalizeChatMessage({ id, ...raw, ...(raw.role === 'assistant' ? { blocks: assistantBlocks(id, raw.content) } : {}) }))
  broadcastResearch({ seq: ++researchSeq, streamId: 'fixture-research-stream', sessionId: 'research-root', event: { type: 'message_end', message: raw } })
  // The host writes these rows into the controller's own session, so a reader of that session
  // sees them: publish the growth the way the host does, or a transcript reading history would
  // stay at whatever it loaded before the notice arrived.
  // The host writes these rows into the controller's own session, so a reader of that session
  // sees them: publish the growth the way the host does, or a transcript reading history would
  // stay at whatever it loaded before the notice arrived. The version must be the same one the
  // history read reports, or the reader would compare two counters that never meet.
  broadcastResearch({ seq: ++researchSeq, streamId: 'fixture-research-stream', event: { type: 'research_session_snapshot',
    snapshot: { runId: 'r_desktop_fixture', executorId: 'lo-root', sessionId: 'session-lo-root', nodeId: 'b_root',
      taskId: null, generation: 0, attempt: 1, revision: researchSeq, historyVersion: researchSessionVersion('lo-root'),
      streaming: null, telemetry: null, error: null, availability: 'available', runtimeSource: 'saved' } } })
}
// Only the root controller's file carries the run's own conversation; node controllers keep theirs.
setResearchSessionsLive(executorId => executorId === 'lo-root' ? researchTranscript : [])
function researchHostSnapshot(cwd = 'C:/research') {
  return { enabled: true, streamId: 'fixture-research-stream',
    session: { sessionId: 'research-root', file: 'C:/research/.misaka/sessions/research-root.jsonl', cwd },
    messages: [...researchTranscript], historyVersion: `research-${researchSeq}`, lastEventSeq: researchSeq,
    run: researchPhase === 'idle' && !researchOpenRunId ? null : { id: researchOpenRunId || 'r_desktop_fixture', status: researchRun().status, phase: researchRun().phase },
    stats: { totalMessages: researchTranscript.length }, contextUsage: { tokens: 6400, contextWindow: 128000, percent: 0.05 }, ...desktopResearchTeamFixture.snapshot() }
}

function handleResearchDesktopCommand(command: any): boolean {
  const supported = new Set(['get_research_options', 'get_active_research_runs', 'list_research_runs', 'get_research_graph',
    'get_research_details', 'get_research_node', 'get_research_task', 'get_research_artifact', 'control_research'])
  if (!supported.has(command.type) || (researchPhase === 'idle' && ['list_research_runs', 'get_research_graph'].includes(command.type))) return false
  queueMicrotask(() => {
    const graph = researchGraph()
    const run = researchRun()
    let data: any = {}
    switch (command.type) {
      case 'get_research_options': data = researchOptions; break
      case 'get_active_research_runs': data = { runs: !['idle', 'done', 'stopped', 'failed'].includes(researchPhase) ? [run] : [] }; break
      case 'list_research_runs': data = { runs: researchPhase === 'idle' ? [] : [run] }; break
      case 'get_research_graph': data = { graph: researchPhase === 'idle' ? null : graph, run: researchPhase === 'idle' ? null : { id: run.id } }; break
      case 'get_research_details': data = researchPhase === 'idle' ? { run: null, graph: null, pending_questions: [] } : researchRunDetail(); break
      case 'get_research_node': data = { detail: researchNodeDetail(String(command.nodeId || 'b_root')) }; break
      case 'get_research_task': data = { detail: researchTask() }; break
      case 'get_research_artifact': data = { detail: command.artifactId === 'a_report' ? researchReport
        : researchTask().artifacts.find(item => item.id === command.artifactId) ?? null }; break
      case 'control_research':
        if (command.action === 'return_plan' && researchPhase === 'plan') {
          researchPlanRound += 1
          researchPlanId = `plan-r${researchPlanRound}`
        } else if (command.action === 'approve_plan' && researchPhase === 'plan') {
          researchPhase = 'critique'
        } else if (command.action === 'approve_reconcile' && researchPhase === 'branches') {
          researchPhase = 'done'
        }
        data = { accepted: true, action: command.action }
        break
    }
    desktopAck(command, data)
  })
  return true
}
window.bridge = {
  send: (command: any) => {
    sent.push(command)
    if (command.type === 'prepare_attachments') {
      const failed = composerAttachmentFailure
      composerAttachmentFailure = false
      queueMicrotask(() => broadcast({ type: 'ack', requestId: command.requestId, ok: true,
        data: { attachments: command.paths.map((file: string) => ({ path: file, name: file.split(/[\\/]/).pop(), size: 128,
          kind: 'text', text: '用于多窗输入附件回归的证据文本。', images: [], error: failed ? '附件读取失败，请重试' : null })) } }))
      return
    }
    // Session listing and per-executor history travel on the desktop bridge; only the live
    // subscription is a research-bridge command.
    if (handleResearchSessionsCommand(command, broadcast)) return
    if (handleResearchDesktopCommand(command)) return
    if (graphEnabled && (command.type === 'get_research_graph' || command.type === 'list_research_runs')) {
      queueMicrotask(() => broadcast({ type: 'ack', requestId: command.requestId, ok: true,
        data: command.type === 'get_research_graph' ? { graph: themeGraph, run: { id: 'theme-run' } } : { runs: [] },
      }))
      return
    }
    if (command.type === 'prompt' && nextPromptFailure) {
      const error = nextPromptFailure
      nextPromptFailure = null
      queueMicrotask(() => broadcast({ type: 'ack', requestId: command.requestId, ok: false, error }))
      return
    }
    if (pickerReply(command, message => { for (const callback of listeners) callback(message) })) return
    if (command.type === 'get_session_tree') {
      queueMicrotask(() => broadcast({ type: 'ack', requestId: command.requestId, ok: true, data: tree.payloadFor() }))
      return
    }
    if (command.type === 'set_tree_filter_mode') {
      tree.filterMode = command.mode
      queueMicrotask(() => broadcast({ type: 'ack', requestId: command.requestId, ok: true, data: { mode: command.mode } }))
      return
    }
    if (command.type === 'set_entry_label') {
      tree.labelWrites.push({ targetId: command.targetId, label: command.label })
      queueMicrotask(() => broadcast({ type: 'ack', requestId: command.requestId, ok: true, data: {
        targetId: command.targetId, label: command.label,
        labelTimestamp: command.label ? '2026-10-06T00:00:00.000Z' : null,
      } }))
      return
    }
    if (command.type === 'navigate_tree') {
      queueMicrotask(() => broadcast({ type: 'ack', requestId: command.requestId, ok: true,
        data: { accepted: true, operation: 'navigate_tree' } }))
      emitEvent({ type: 'session_operation_start', requestId: command.requestId, operation: 'navigate_tree' })
      tree.finishNavigation = () => emitEvent({
        type: 'session_operation_end', requestId: command.requestId, operation: 'navigate_tree',
        ...(tree.navigationResult ?? { status: 'done', messages: [] }),
      })
      if (tree.deferNavigation) return
      queueMicrotask(() => { tree.finishNavigation?.(); tree.finishNavigation = null })
      return
    }
    if (command.type === 'compact_session') {
      queueMicrotask(() => broadcast({ type: 'ack', requestId: command.requestId, ok: true,
        data: { accepted: true, operation: 'compact_session' } }))
      emitEvent({ type: 'session_operation_start', requestId: command.requestId, operation: 'compact_session' })
      queueMicrotask(() => emitEvent(tree.compactFailure
        ? { type: 'session_operation_end', requestId: command.requestId, operation: 'compact_session', status: 'error', error: tree.compactFailure }
        : { type: 'session_operation_end', requestId: command.requestId, operation: 'compact_session', status: 'done' }))
      return
    }
    if (command.type === 'cancel_session_operation') {
      tree.cancelCalls.push(command.operationRequestId ?? null)
      queueMicrotask(() => broadcast({ type: 'ack', requestId: command.requestId, ok: true, data: { cancelled: true } }))
      emitEvent({ type: 'session_operation_end', requestId: command.operationRequestId,
        operation: 'navigate_tree', status: 'aborted' })
      tree.finishNavigation = null
      return
    }
    if (command.type === 'load_session' || command.type === 'switch_workspace') {
      const path = command.type === 'load_session' ? command.path : command.sessionPath || [...histories].find(([, h]) => h.workspace === command.path)?.[0]
      const history = histories.get(path)
      queueMicrotask(() => {
        if (!history) { broadcast({ type: 'ack', requestId: command.requestId, ok: false, error: '测试会话不存在' }); return }
        const session = { sessionId: path, file: path, cwd: history.workspace, name: path }
        broadcast({ seq: ++seq, sessionId: path, event: { type: 'session_preview', requestId: command.requestId, session, messages: history.messages, historyVersion: history.version } })
        window.setTimeout(() => {
          broadcast({ seq: ++seq, sessionId: path, event: { type: 'session_started', requestId: command.requestId, ...session } })
          broadcast({ type: 'ack', requestId: command.requestId, ok: true, data: { session, historyVersion: history.version, historyUnchanged: true, timings: { runtimeMs: readyDelay } } })
        }, readyDelay)
      })
      return
    }
    queueMicrotask(() => {
      const data = command.type === 'list_sessions' ? { sessions: [...histories].map(([path, history]) => ({ id: path, path, cwd: history.workspace, name: path,
        modified: '2026-10-05T00:00:00Z', created: '2026-10-05T00:00:00Z', fileRevision: history.version, messageCount: history.messages.length, firstMessage: path })) } : {}
      for (const callback of listeners) callback({ type: 'ack', requestId: command.requestId ?? null, ok: true, data })
    })
  },
  on: callback => { listeners.add(callback); return () => { listeners.delete(callback) } },
}
window.researchBridge = {
  send: (raw: unknown) => {
    const command = raw as any
    researchCommands.push(command)
    const schedule = (deliver: () => void) => {
      if (composerHoldSubmission && command.type === 'send_research_message') composerPendingSubmissions.push(deliver)
      else queueMicrotask(deliver)
    }
    schedule(() => {
      if (command.type === 'send_research_message' && composerSubmissionFailure) {
        const error = composerSubmissionFailure
        composerSubmissionFailure = null
        broadcastResearch({ type: 'ack', requestId: command.requestId, ok: false, error })
        return
      }
      if (handleResearchSessionsWatch(command, broadcastResearch)) return
      if (handleResearchSessionsCommand(command, broadcastResearch, () => {})) return
      if (handleDesktopResearchTeamCommand(command, broadcastResearch, snapshot => broadcastResearch({ seq: ++researchSeq, streamId: 'fixture-research-stream', sessionId: 'research-root', event: { type: 'desktop-model-switch', details: snapshot } }))) return
      if (command.type === 'get_research_host') {
        researchAck(command, researchHostSnapshot())
        return
      }
      if (command.type === 'start_research' || command.type === 'send_research_message') {
        if (researchPhase === 'idle') {
          researchPhase = command.limits?.plan_approval === false ? 'critique' : 'plan'
          researchQuestion = String(command.text || command.question || '')
          researchStartArgs = { ...command, question: researchQuestion, workspace: 'C:/research' }
          researchPlanRound = 1
          researchPlanId = 'plan-r1'
          // A started run has a directory: the host answers `get_research_sessions` from here on.
          enableResearchSessions({ question: researchQuestion })
          researchAck(command, { accepted: true, mode: 'start', runId: null })
          queueMicrotask(() => {
            emitResearchMessage({ role: 'custom', customType: 'research-question', content: `Research question | ${researchQuestion}`,
              details: { question: researchQuestion, workspace: 'C:/research', requestId: command.requestId } })
            emitResearchMessage({ role: 'custom', customType: 'research-discipline', content: 'Research mode is on',
              details: { run_id: 'r_desktop_fixture' } })
          })
        } else {
          const mode = researchPhase === 'waiting_input' || researchPhase === 'stopped' || researchPhase === 'failed' ? 'resume' : researchPhase === 'done' ? 'followUp' : 'steer'
          if (mode === 'resume') researchPhase = 'critique'
          emitResearchMessage({ role: 'user', content: String(command.text || ''), requestId: command.requestId })
          researchAck(command, { accepted: true, mode, runId: 'r_desktop_fixture' })
          if (mode === 'followUp') emitResearchMessage({ role: 'assistant', content: [{ type: 'text', text: '根据刚才的研究报告，检索方案更便于逐条核验证据。' }] })
        }
        return
      }
      if (command.type === 'stop_research' || command.type === 'resume_research') {
        researchPhase = command.type === 'stop_research' ? (researchStopHold ? 'stopping' : 'stopped') : 'critique'
        researchAck(command, { accepted: true })
        if (command.type === 'stop_research' && researchStopHold) researchStopPendingNotice = true
        if (command.type === 'stop_research' && !researchStopHold) {
          // The engine's stop publishes its final notice after the board settles: the
          // fixture must do the same, or the shared 正在停止 wait has nothing to settle on.
          emitResearchMessage({ role: 'custom', customType: 'research-final', content: '研究已停止。',
            details: { run_id: 'r_desktop_fixture', result: { status: 'stopped' } } })
        }
        return
      }
      if (command.type === 'get_stats') {
        researchAck(command, { stats: { totalMessages: 34 }, contextUsage: { tokens: 6400, contextWindow: 128000, percent: 0.05 } })
        return
      }
      if (command.type === 'compact_session') {
        researchAck(command, { accepted: true, operation: 'compact_session' })
        queueMicrotask(() => broadcastResearch({ seq: ++seq, sessionId: 'research-root', event: {
          type: 'session_operation_end', operation: 'compact_session', requestId: command.requestId,
          status: 'done', compaction: { summary: 'Mock research compaction completed.' },
        } }))
        return
      }
      if (command.type === 'cancel_session_operation') {
        researchAck(command, { cancelled: true })
        return
      }
      researchAck(command, {})
    })
  },
  on: (callback: (message: BridgeMessage) => void) => {
    researchListeners.add(callback)
    return () => { researchListeners.delete(callback) }
  },
}
const treeMessages = (leafId: string) => [
  { id: 't-u1', entryId: 'u1', role: 'user', content: '第一问', timestamp: 1 },
  { id: 't-a1', entryId: 'a1', role: 'assistant', content: '第一答', timestamp: 2 },
  { id: 't-u2', entryId: leafId, role: 'user', content: '折返后的问题', timestamp: 3 },
]

const tree = {
  filterMode: 'default' as string,
  labelWrites: [] as { targetId: string; label: string | null }[],
  cancelCalls: [] as (string | null)[],
  navigationResult: null as Record<string, any> | null,
  compactFailure: null as string | null,
  deferNavigation: false,
  finishNavigation: null as (() => void) | null,
  payloadFor() {
    return {
      sessionId: 'fixture-tree', sessionFile: 'fixture.jsonl', historyVersion: 'tree-v1', leafId: 'u1',
      settings: { treeFilterMode: tree.filterMode, branchSummarySkipPrompt: false },
      tree: [
        { entry: { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: '第一问' }] } },
          label: null, labelTimestamp: null, children: [
            { entry: { type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: '第一答' }], stopReason: 'stop' } },
              label: null, labelTimestamp: null, children: [
                { entry: { type: 'message', id: 'tool', message: { role: 'toolResult', content: [{ type: 'text', text: '工具输出' }] } },
                  label: null, labelTimestamp: null, children: [] },
                { entry: { type: 'message', id: 'u2', message: { role: 'user', content: [{ type: 'text', text: '第二问' }] } },
                  label: '关键问题', labelTimestamp: '2026-10-06T00:00:00.000Z', children: [] },
              ] },
          ] },
      ],
    }
  },
  reset() {
    tree.filterMode = 'default'
    tree.labelWrites = []
    tree.cancelCalls = []
    tree.navigationResult = null
    tree.compactFailure = null
    tree.deferNavigation = false
    tree.finishNavigation = null
  },
}

const emitEvent = (event: Record<string, any>) => {
  broadcast({ seq: ++seq, sessionId: useSessionStore.getState().currentSessionId, event })
}
window.app = { getVersion: async () => 'acceptance', pickDirectory: async () => null, pickFiles: async () => [], openPath: async () => false, openExternal: async () => true, showItemInFolder: () => {},
  startResearchBridge: async ({ cwd }) => researchHostSnapshot(cwd),
  setResearchActive: () => {},
}
window.theme = {
  listThemes: async () => fixtureThemes.list(),
  getTheme: async () => toThemeData(activeTheme),
  setTheme: async name => {
    const theme = fixtureThemes.get(name)
    if (!theme) return { ok: false, name: activeTheme.id, error: '未知测试主题' }
    activeTheme = theme
    const data = toThemeData(theme)
    for (const callback of themeListeners) callback(data)
    return { ok: true, name: theme.id }
  },
  onChange: callback => { themeListeners.add(callback); return () => { themeListeners.delete(callback) } },
}
applyThemeToDom(toThemeData(activeTheme))
let seq = 0
const researchCommands: Record<string, any>[] = []
const emit = (event: Record<string, any>) => useSessionStore.getState().handleBridgeMessage({ seq: ++seq, sessionId: fixture.sessionId, event })
const reset = () => {
  resetResearchStopTimers()
  useResearchStopStore.setState({ byRun: {} })
  useResearchResumeStore.setState({ byRun: {} })
  desktopResearchTeamFixture.reset()
  resetResearchSessions()
  researchSeq = 0
  researchTranscript.length = 0
  useSessionStore.setState({ researchBinding: null, researchTeam: null, researchModelBinding: null, researchTeamEventSeq: 0, researchConnectionError: null, researchCards: {}, researchConversation: { currentSessionId: '', messages: [], isStreaming: false, isAborting: false, streamingMessageId: null, lastEventSeq: 0 } })
  researchCommands.length = 0
  researchPhase = 'idle'
  researchStopHold = false
  researchStopPendingNotice = false
  inheritedStopDriving = null
  researchStopLeaseHold = false
  researchOpenRunId = null
  researchQuestion = ''
  researchPlanRound = 1
  researchPlanId = 'plan-r1'
  researchStartArgs = null
  graphEnabled = false
  seq = -1
  forgetSessionView('fixture.jsonl')
  useSessionStore.setState({ currentSessionId:'', lastEventSeq:0, isSessionLoading:false,
    researchRuns: [], researchGraph: null, researchRunId: null, agentMode: 'agent', permissionMode: 'default' })
  emit({ type: 'session_started', sessionId: fixture.sessionId, cwd: 'C:/research', name: '文献证据与工具验证', file: 'fixture.jsonl' })
  seq = 0
  sent.length = 0
  nextPromptFailure = null
  composerAttachmentFailure = false
  composerHoldSubmission = false
  composerSubmissionFailure = null
  composerPendingSubmissions.length = 0
  tree.reset()
  useSessionStore.setState({ treeOpen: false, treePayload: null, treeFilterMode: null })
}
const api = {
  reset,
  composer: {
    restoreDraft: (text: string) => useSessionStore.getState().setDraft(text),
    attachmentFailure: () => { composerAttachmentFailure = true },
    holdSubmission: () => { composerHoldSubmission = true },
    failSubmission: (error: string) => { composerSubmissionFailure = error },
    releaseSubmission: () => {
      composerHoldSubmission = false
      for (const deliver of composerPendingSubmissions.splice(0)) queueMicrotask(deliver)
    },
    stream: (active: boolean) => {
      researchPhase = active ? 'critique' : 'waiting_input'
      // Opening a saved run only selects its readers. A live native event first
      // needs the writer's authoritative session/stream snapshot, just like startup.
      useSessionStore.getState().bindResearchConversation(researchHostSnapshot())
      broadcastResearch({ seq: ++researchSeq, streamId: 'fixture-research-stream', sessionId: 'research-root',
        event: { type: active ? 'agent_start' : 'agent_end', ...(active ? {} : { messages: [] }) } })
    },
    longModel: () => {
      useSessionStore.setState({ researchModelBindings: null })
      useSettingsStore.setState({ currentModel: { provider: 'misaka-fixture', modelId: 'long',
        name: 'Misaka Academic Research Reasoning — 超长模型名称与跨供应商上下文验证', thinking: 'high' } })
    },
  },
  setLoading: (loading: boolean) => useSessionStore.setState({ isSessionLoading: loading }),
  sent,
  failNextPrompt: (error: string) => { nextPromptFailure = error },
  navigation: {
    register: (path: string, count = 500, workspace = 'C:/research', toolBytes = 0) => {
      const messages = Array.from({ length: count }, (_, index) => ({ id: `${path}:${index}`, entryId: `${path}:entry:${index}`, role: 'assistant', timestamp: 1000 + index,
        blocks: [
          { type: 'text', id: `${path}:${index}:text`, contentIndex: 0, text: `研究记录 ${index + 1}\n\n` + '中文研究证据。\n\n'.repeat(4), isStreaming: false },
          { type: 'toolCall', id: `${path}:${index}:tool`, contentIndex: 1, toolCall: { id: `${path}:${index}:call`, name: 'read', status: 'success', result: 'x'.repeat(toolBytes || 40) } },
        ] }))
      const version = String((Number(histories.get(path)?.version) || 0) + 1)
      histories.set(path, { messages, workspace, version })
      useSessionStore.getState().fetchSessions()
      return new TextEncoder().encode(JSON.stringify(messages)).length
    },
    clearCache: () => sessionHistoryCache.clear(),
    setReadyDelay: (ms: number) => { readyDelay = ms },
    open: (path: string) => useSessionStore.getState().openSession(path),
    workspace: (path: string) => useSessionStore.getState().switchWorkspace(path),
    emit: (event: Record<string, any>) => useSessionStore.getState().handleBridgeMessage({ seq: ++seq, sessionId: useSessionStore.getState().currentSessionId, event }),
    state: () => { const s = useSessionStore.getState(); return { path: s.currentSessionPath, active: s.activeSessionPath, loading: s.isSessionLoading, error: s.sessionLoadError, version: s.sessionHistoryVersion, messages: s.messages.length } },
  },
  tree: {
    reset: () => tree.reset(),
    state: () => ({
      filterMode: useSessionStore.getState().treeFilterMode,
      draft: useSessionStore.getState().draft,
      retained: useSessionStore.getState().retainedEditorText,
      operation: useSessionStore.getState().sessionOperation?.operation ?? null,
      messages: useSessionStore.getState().messages.map(message => message.content),
    }),
    open: () => useSessionStore.getState().openTreePanel(),
    deferNavigation: (defer: boolean) => { tree.deferNavigation = defer },
    finishNavigation: () => { const finish = tree.finishNavigation; tree.finishNavigation = null; finish?.() },
    navigationResult: (result: Record<string, any>) => { tree.navigationResult = result },
    compactFailure: (error: string | null) => { tree.compactFailure = error },
    labelWrites: () => tree.labelWrites,
    cancelCalls: () => tree.cancelCalls,
    navigateResult: (leafId: string, overrides: Record<string, any> = {}) =>
      ({ status: 'done', leafId, historyVersion: 'tree-v2', messages: treeMessages(leafId), ...overrides }),
  },
  replay: (until = 22) => {
    reset()
    for (const envelope of fixture.events) {
      if (envelope.seq > until) break
      seq = envelope.seq
      useSessionStore.getState().handleBridgeMessage(envelope as BridgeMessage)
    }
  },
  emit,
  theme: (name: string) => window.theme.setTheme(name),
  permission: () => useSessionStore.setState({ pendingPermissionRequest: {
    requestId: 'theme-permission', toolName: 'write', toolInput: { path: 'theme.txt', content: '主题写入预览' },
    reason: '主题审批测试', mode: 'default',
  } }),
  graph: () => {
    graphEnabled = true
    useSessionStore.setState({ researchGraph: themeGraph, researchRunId: 'theme-run' })
  },
  research: {
    readError: (error: string | null) => setResearchSessionsReadError(error),
    unconfirmedResume: () => useResearchResumeStore.getState().unconfirm(researchOpenRunId || 'r_desktop_fixture', '恢复结果待确认，请刷新检查'),
    /** Reopened persisted board stop: no local command or stop-store entry survives. */
    inheritStop: (driving = false) => {
      researchPhase = 'stopping'
      inheritedStopDriving = driving
      researchQuestion = '停止收尾验收课题'
      researchOpenRunId = 'r_desktop_fixture'
      useSessionStore.setState({ agentMode: 'agent', researchBinding: null,
        researchCards: { r_desktop_fixture: { runId: 'r_desktop_fixture', question: researchQuestion,
          workspace: 'C:/research', status: 'stopping', phase: 'active', tasks: [], updatedAt: Date.now() } },
        researchRuns: [researchRun()] })
    },
    /** Open a saved run of the session fixture: the focus view reads it, nothing is executed. */
    openRun: (runId = 'r_desktop_fixture', question = '比较 RAG 与长上下文的证据路线') => {
      enableResearchSessions({ question })
      // A saved, readable run is owned by its root session: the host keeps answering
      // get_research_host with it, so no later snapshot read drops the binding's run id
      // mid-action -- the way a terminal snapshot bound to an absent run used to.
      researchOpenRunId = runId
      researchPhase = 'waiting_input'
      useSessionStore.setState({ agentMode: 'research', researchPageView: 'conversation',
        researchBinding: { sessionId: 'research-root', sessionFile: 'C:/research/.misaka/sessions/research-root.jsonl',
          workspace: 'C:/research', runId, streamId: 'fixture-research-stream' } })
    },
    advanceToBranches: () => { if (researchPhase === 'critique') researchPhase = 'branches' },
    /** Hold a stop's final notice: the UI must keep 正在停止 until the engine settles. */
    stopHold: () => { researchStopHold = true },
    /** A final report may precede the driver lease's finally block. */
    holdStopLease: () => { researchStopLeaseHold = true },
    releaseStopLease: () => { researchStopLeaseHold = false },
    releaseStop: () => {
      researchStopHold = false
      if (researchPhase === 'stopping') researchPhase = 'stopped'
      if (researchStopPendingNotice || researchPhase === 'stopped') {
        researchStopPendingNotice = false
        emitResearchMessage({ role: 'custom', customType: 'research-final', content: '研究已停止。',
          details: { run_id: 'r_desktop_fixture', result: { status: 'stopped' } } })
      }
    },
    clarify: () => {
      researchPhase = 'waiting_input'
      emitResearchMessage({ role: 'custom', customType: 'research-clarification', content: 'Research run needs clarification:\n- 是否只使用公开文献？', details: { run_id: 'r_desktop_fixture' } })
    },
    fail: () => {
      researchPhase = 'failed'
      emitResearchMessage({ role: 'custom', customType: 'research-error', content: '研究运行遇到连接错误', details: { run_id: 'r_desktop_fixture' } })
    },
    conversation: () => useSessionStore.getState().researchConversation,
    state: () => ({ phase: researchPhase, question: researchQuestion, start: researchStartArgs, commands: researchCommands,
      binding: useSessionStore.getState().researchBinding }),
    deliverFinalReport: () => {
      researchPhase = 'done'
      emitResearchMessage({
          role: 'custom',
          customType: 'research-final',
          content: researchReport.content,
          details: {
            run_id: 'r_desktop_fixture',
            final_artifact: researchReport.id,
            result: { status: 'done', final: { path: researchReport.path } },
          },
      })
    },
  },
  loadHistory: (messages: any[]) => {
    reset()
    useSessionStore.setState({ messages: messages.map(normalizeChatMessage), isStreaming: false, streamingMessageId: null })
  },
  snapshot: () => {
    const state = useSessionStore.getState()
    return JSON.parse(JSON.stringify({ busy: state.isStreaming, messages: state.messages.map(({role, content, thinking, toolCalls, blocks}) => ({role,content,thinking,toolCalls,blocks})) }))
  },
  seedHistory: (count: number) => {
    reset()
    const messages = Array.from({ length: count }, (_, index) => normalizeChatMessage({
      id: `history-${index}`, role: 'assistant', timestamp: 1000 + index,
      blocks: [
        { type: 'text', id: `history-${index}-text`, contentIndex: 0, text: `研究记录 ${index + 1}\n\n` + '这是一段用于验证阅读锚点的文献证据。\n\n'.repeat(4), isStreaming: false },
        { type: 'toolCall', id: `history-${index}-tool`, contentIndex: 1, toolCall: { id: `history-call-${index}`, name: 'read', status: 'success', result: [{type:'text',text:'文献正文\n'.repeat(8)}] } },
      ],
    }))
    useSessionStore.setState({ messages, isStreaming: false, streamingMessageId: null })
  },
}
;(window as any).conversationFixture = api
;(window as any).modelPickerFixture = modelPickerFixture
;(window as any).desktopResearchTeamFixture = desktopResearchTeamFixture
useSettingsStore.setState({ currentModel: { provider: 'fixture', modelId: 'fixture-model', name: '研究模型', thinking: 'high' }, hideThinkingBlock: false })
createRoot(document.getElementById('root')!).render(<App />)
