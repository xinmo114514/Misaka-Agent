import { newRequestId, request } from './bridge'
import { addResearchSink, requestResearch } from './researchBridge'
import type { ResearchOptionsPayload, ResearchRunDetail, ResearchRunSummary, ResearchHostSnapshot, ResearchConversationBinding } from '../types/research'

interface Input {
  question: string
  workspace: string
  model?: { provider: string; modelId: string } | null
  thinkingLevel?: string
  binding?: ResearchConversationBinding | null
  requestId?: string
  onBound?: (host: ResearchHostSnapshot) => void
  onAccepted?: () => void
}

// AI-driven recruitment can require multiple real model turns before the
// original native workflow acknowledges its first input.
const RESEARCH_STARTUP_TIMEOUT_MS = 180_000

export async function openResearchConversation(runId: string, workspace?: string): Promise<ResearchHostSnapshot> {
  const detail = await request<ResearchRunDetail>('get_research_details', { runId, workspace })
  if (!detail.run?.rootSession) throw new Error('该研究的原会话尚未登记，请刷新后重试。')
  const host = await window.app.startResearchBridge({ cwd: detail.run.workspace, sessionFile: detail.run.rootSession })
  if (!host.enabled || !host.session.file) throw new Error('原研究会话尚未就绪。')
  return { ...host, messages: host.messages ?? [], historyVersion: host.historyVersion ?? null,
    lastEventSeq: host.lastEventSeq ?? 0, run: host.run ?? { id: runId, status: detail.run.status, phase: detail.run.phase } }
}

function confirmResearchStartup(sessionId: string) {
  let unsubscribe = () => {}
  let timer: number
  const cancel = () => { window.clearTimeout(timer); unsubscribe() }
  const promise = new Promise<string>((resolve, reject) => {
    timer = window.setTimeout(() => {
      cancel()
      reject(new Error('研究创建尚未确认，请查看研究状态；课题已保留在草稿中。'))
    }, RESEARCH_STARTUP_TIMEOUT_MS)
    unsubscribe = addResearchSink(message => {
      if (!('event' in message) || message.sessionId !== sessionId) return
      const notice = message.event.message
      if (message.event.type !== 'message_end' || notice?.role !== 'custom') return
      if (notice.customType === 'research-discipline' && notice.details?.run_id) {
        cancel()
        resolve(String(notice.details.run_id))
      } else if (notice.customType === 'research-progress' && notice.details?.stage === 'startup_error') {
        cancel()
        reject(new Error(typeof notice.content === 'string' ? notice.content : '研究初始化失败，课题已保留。'))
      }
    })
  })
  // Creation events can arrive before the command's acceptance ack.
  void promise.catch(() => {})
  return { promise, cancel }
}

/** Research uses its own host; ordinary chat permissions alone do not configure it. */
export async function startComposerResearch({ question, workspace, model, thinkingLevel, binding, requestId = newRequestId('research_input'), onBound, onAccepted }: Input) {
  if (!workspace.trim()) throw new Error('请先选择项目目录')
  if (!question.trim()) throw new Error('请先输入研究课题')
  let sessionFile = binding?.sessionFile
  if (!binding) {
    const active = await request<{ runs?: ResearchRunSummary[] }>('get_active_research_runs')
    const owned = active.runs?.find(run => run.workspace.replace(/\\/g, '/').toLowerCase() === workspace.replace(/\\/g, '/').toLowerCase())
    if (owned) {
      const detail = await request<ResearchRunDetail>('get_research_details', { runId: owned.id, workspace })
      if (!detail.run.rootSession) throw new Error('研究根会话尚未登记，请刷新研究状态后重试。')
      sessionFile = detail.run.rootSession
    } else if (active.runs?.length) {
      throw new Error('另一项目仍有研究运行，请先在研究历史中打开或停止该研究。')
    }
  }
  const host = await window.app.startResearchBridge({ cwd: binding?.workspace || workspace, ...(sessionFile ? { sessionFile } : {}) })
  if (!host.enabled || !host.session.file || !host.session.sessionId) throw new Error('研究协调会话尚未就绪，请重试。')
  if (binding && host.session.sessionId !== binding.sessionId) throw new Error('研究会话标识已变更，请重新打开原研究。')
  const snapshot: ResearchHostSnapshot = { ...host, messages: host.messages ?? [], historyVersion: host.historyVersion ?? null,
    lastEventSeq: host.lastEventSeq ?? 0, run: host.run ?? null }
  onBound?.(snapshot)
  const runId = snapshot.run?.id || binding?.runId || undefined
  const starting = !runId
  let limits: ResearchOptionsPayload['defaults'] | undefined
  // Permission is runtime-local: reconnecting a persisted owner must restore
  // research's selected policy without changing its model or run parameters.
  await requestResearch('set_permission_mode', { mode: 'bypassPermissions' })
  if (starting) {
    const options = await request<ResearchOptionsPayload>('get_research_options')
    limits = { ...options.defaults, plan_approval: false }
    if (model) await requestResearch('set_model', { provider: model.provider, modelId: model.modelId })
    if (thinkingLevel) await requestResearch('set_thinking', { level: thinkingLevel })
  }
  const confirmation = starting ? confirmResearchStartup(host.session.sessionId) : null
  try {
    const input = {
      text: question.trim(), sessionId: host.session.sessionId, requestId,
      ...(runId ? { runId } : {}), ...(limits ? { limits } : {}),
    }
    if (starting) await requestResearch('send_research_message', input, RESEARCH_STARTUP_TIMEOUT_MS)
    else await requestResearch('send_research_message', input)
    onAccepted?.()
    const confirmedRunId = confirmation ? await confirmation.promise : runId!
    const latest = await requestResearch<ResearchHostSnapshot>('get_research_host')
    return { ...snapshot, ...(latest?.session ? latest : {}), runId: confirmedRunId }
  } finally {
    confirmation?.cancel()
  }
}
