import { newRequestId, request } from './bridge'
import { addResearchSink, isResearchRequestTimeout, requestResearch } from './researchBridge'
import { isResearchRunActive } from './researchConversation'
import type { ResearchOptionsPayload, ResearchRunDetail, ResearchRunSummary, ResearchHostSnapshot, ResearchConversationBinding } from '../types/research'

export interface ResearchSubmissionInput {
  text: string
  sessionId: string
  requestId: string
  runId?: string
  limits?: ResearchOptionsPayload['defaults']
  streamId?: string
  startNew?: boolean
}

interface Input {
  question: string
  workspace: string
  model?: { provider: string; modelId: string } | null
  thinkingLevel?: string
  binding?: ResearchConversationBinding | null
  requestId?: string
  /** The caller opens a fresh research conversation; a settled run is not adopted. */
  startNew?: boolean
  submission?: ResearchSubmissionInput
  onSubmission?: (input: ResearchSubmissionInput) => void
  onBound?: (host: ResearchHostSnapshot) => void
  onAccepted?: () => void
  onUnconfirmed?: (error: Error, reconciled?: boolean) => void
}

// AI-driven recruitment can require multiple real model turns before the
// original native workflow acknowledges its first input.
const RESEARCH_STARTUP_TIMEOUT_MS = 180_000

/** Startups without a run id can only be cancelled on their own research host. */
const pendingStartups = new Map<string, () => void>()

export function cancelResearchStartup(sessionId: string): boolean {
  const cancel = pendingStartups.get(sessionId)
  if (!cancel) return false
  cancel()
  return true
}

export async function openResearchConversation(runId: string, workspace?: string): Promise<ResearchHostSnapshot> {
  const detail = await request<ResearchRunDetail>('get_research_details', { runId, workspace })
  if (!detail.run?.rootSession) throw new Error('该研究的原会话尚未登记，请刷新后重试。')
  const host = await window.app.startResearchBridge({ cwd: detail.run.workspace, sessionFile: detail.run.rootSession })
  if (!host.enabled || !host.session.file) throw new Error('原研究会话尚未就绪。')
  return { ...host, messages: host.messages ?? [], historyVersion: host.historyVersion ?? null,
    lastEventSeq: host.lastEventSeq ?? 0, run: host.run ?? { id: runId, status: detail.run.status, phase: detail.run.phase } }
}

/** Cancel an in-flight start on its own research host, before any run id exists. */
function createResearchStartupGate(sessionId: string, streamId?: string) {
  let reason: Error | null = null
  let reject!: (error: Error) => void
  const cancelled = new Promise<never>((_resolve, fail) => { reject = fail })
  // The awaited race can already be settled, leaving this rejection unconsumed.
  void cancelled.catch(() => {})
  const cancel = () => {
    if (reason) return
    reason = new Error('研究启动已取消')
    void requestResearch('abort', { sessionId, ...(streamId ? { streamId } : {}) }).catch(() => {})
    reject(reason)
  }
  pendingStartups.set(sessionId, cancel)
  return {
    race: <T>(promise: Promise<T>): Promise<T> => reason ? Promise.reject(reason) : Promise.race([promise, cancelled]),
    release: () => { if (pendingStartups.get(sessionId) === cancel) pendingStartups.delete(sessionId) },
  }
}

/**
 * Confirms a freshly created run on its own research host.
 *
 * The `research-discipline` notice is the fast path, but it is not the only authority:
 * the run is durable on the board, so `get_research_host` can always answer for it. Waiting
 * on the one event alone leaves the renderer on the welcome page for the whole budget when
 * that notice is missed, so the wait also reconciles against the host on a widening schedule.
 * The total budget is unchanged: a deep research initialization is allowed to take a long
 * time, and the poll only asks whether the run already exists.
 */
function confirmResearchStartup(sessionId: string, streamId?: string, previousRunId?: string, requestId?: string) {
  let unsubscribe = () => {}
  let timer: number
  let pollTimer: number | null = null
  let settled = false
  const cancel = () => {
    settled = true
    window.clearTimeout(timer)
    if (pollTimer !== null) window.clearTimeout(pollTimer)
    unsubscribe()
  }
  const promise = new Promise<string>((resolve, reject) => {
    const finish = (runId: string) => {
      if (settled || runId === previousRunId) return
      cancel()
      resolve(runId)
    }
    const fail = (error: Error) => {
      if (settled) return
      cancel()
      reject(error)
    }
    timer = window.setTimeout(() => {
      fail(Object.assign(new Error('研究创建尚未确认，请查看研究状态；课题已保留在草稿中。'), {
        name: 'ResearchStartupConfirmationTimeoutError',
      }))
    }, RESEARCH_STARTUP_TIMEOUT_MS)
    unsubscribe = addResearchSink(message => {
      if (!('event' in message) || message.sessionId !== sessionId) return
      if (streamId && message.streamId !== streamId) return
      const notice = message.event.message
      if (message.event.type !== 'message_end' || notice?.role !== 'custom') return
      if (requestId && notice.details?.requestId && notice.details.requestId !== requestId) return
      if (notice.customType === 'research-discipline' && notice.details?.run_id) {
        finish(String(notice.details.run_id))
      } else if (notice.customType === 'research-progress' && notice.details?.stage === 'startup_error') {
        fail(new Error(typeof notice.content === 'string' ? notice.content : '研究初始化失败，课题已保留。'))
      }
    })
    // Widening backoff inside the same budget: the host is asked whether the run exists,
    // which is durable board state rather than a transport event that can be missed.
    const attempts = [3_000, 6_000, 12_000, 24_000, 48_000, 96_000]
    let index = 0
    const schedule = () => {
      const delay = attempts[index]
      if (settled || delay === undefined) return
      index += 1
      pollTimer = window.setTimeout(() => {
        pollTimer = null
        if (settled) return
        requestResearch<ResearchHostSnapshot>('get_research_host', {}, 15_000)
          .then(latest => {
            if (settled) return
            if (latest?.session?.sessionId !== sessionId || (streamId && latest.streamId !== streamId)) {
              schedule()
              return
            }
            if (latest.run?.id && latest.run.id !== previousRunId) finish(String(latest.run.id))
            else schedule()
          })
          .catch(() => { if (!settled) schedule() })
      }, delay)
    }
    schedule()
  })
  // Creation events can arrive before the command's acceptance ack.
  void promise.catch(() => {})
  return { promise, cancel }
}

type ResearchStartResult = ResearchHostSnapshot & { runId: string; syncError?: string }

/** The renderer can cancel a launch before it has acquired a native session ID. */
export function startComposerResearch(input: Input): Promise<ResearchStartResult> {
  const requestId = input.requestId ?? newRequestId('research_input')
  let reason: Error | null = null
  let reject!: (error: Error) => void
  const cancelled = new Promise<never>((_resolve, fail) => { reject = fail })
  const cancel = () => {
    if (reason) return
    reason = new Error('研究启动已取消')
    reject(reason)
  }
  const release = () => { if (pendingStartups.get(requestId) === cancel) pendingStartups.delete(requestId) }
  pendingStartups.set(requestId, cancel)
  const launched = launchComposerResearch({ ...input, requestId }, {
    check: () => { if (reason) throw reason },
    bound: release,
  })
  // Late host creation may finish, but its continuation checks cancellation before
  // binding or submitting. It remains an idle host, never an orphan research run.
  return Promise.race([launched, cancelled]).finally(release)
}

/** Research uses its own host; ordinary chat permissions alone do not configure it. */
async function launchComposerResearch({ question, workspace, model, thinkingLevel, binding, requestId = newRequestId('research_input'), startNew, submission, onSubmission, onBound, onAccepted, onUnconfirmed }: Input,
  launch: { check: () => void; bound: () => void }): Promise<ResearchStartResult> {
  if (!workspace.trim()) throw new Error('请先选择项目目录')
  if (!(submission?.text ?? question).trim()) throw new Error('请先输入研究课题')
  // Capture retry identity before any asynchronous reconnect can change UI state.
  const stored = submission ? { ...submission, ...(submission.limits ? { limits: { ...submission.limits } } : {}) } : undefined
  // A retry hands back the original envelope, and with it its fresh-start intent: without
  // this the previous settled run would be adopted as the retried question's own run.
  const freshStart = startNew ?? Boolean(stored?.startNew)
  let sessionFile = binding?.sessionFile
  if (!binding) {
    const active = await request<{ runs?: ResearchRunSummary[] }>('get_active_research_runs')
    launch.check()
    const owned = active.runs?.find(run => run.workspace.replace(/\\/g, '/').toLowerCase() === workspace.replace(/\\/g, '/').toLowerCase())
    if (owned) {
      const detail = await request<ResearchRunDetail>('get_research_details', { runId: owned.id, workspace })
      launch.check()
      if (!detail.run.rootSession) throw new Error('研究根会话尚未登记，请刷新研究状态后重试。')
      sessionFile = detail.run.rootSession
    } else if (active.runs?.length) {
      throw new Error('另一项目仍有研究运行，请先在研究历史中打开或停止该研究。')
    }
  }
  launch.check()
  const host = await window.app.startResearchBridge({ cwd: binding?.workspace || workspace, ...(sessionFile ? { sessionFile } : {}) })
  launch.check()
  if (!host.enabled || !host.session.file || !host.session.sessionId) throw new Error('研究协调会话尚未就绪，请重试。')
  if (binding && host.session.sessionId !== binding.sessionId) throw new Error('研究会话标识已变更，请重新打开原研究。')
  if (stored && host.session.sessionId !== stored.sessionId) throw new Error('研究会话标识已变更，请重新打开原研究。')
  const snapshot: ResearchHostSnapshot = { ...host, messages: host.messages ?? [], historyVersion: host.historyVersion ?? null,
    lastEventSeq: host.lastEventSeq ?? 0, run: host.run ?? null }
  // A settled run in the host snapshot is adopted only when the caller is not
  // deliberately opening a new research conversation; otherwise its run id would
  // silently fold a fresh question into the previous (finished) run.
  const adoptSnapshotRun = !(freshStart && snapshot.run && !isResearchRunActive(snapshot.run.status))
  const runId = (adoptSnapshotRun ? snapshot.run?.id : undefined) || binding?.runId || stored?.runId || undefined
  const starting = !runId
  const previousRunId = starting && !adoptSnapshotRun ? snapshot.run?.id : undefined
  const projectStartupSnapshot = (source: ResearchHostSnapshot): ResearchHostSnapshot =>
    previousRunId && source.run?.id === previousRunId ? { ...source, run: null } : source
  const boundSnapshot = projectStartupSnapshot(snapshot)
  // A durable submission can create its run during any reconnect setup await.
  // Subscribe before restoring permissions, options, or model settings.
  const confirmation = starting ? confirmResearchStartup(host.session.sessionId, host.streamId, previousRunId, requestId) : null
  const gate = starting ? createResearchStartupGate(host.session.sessionId, host.streamId) : null
  try {
    launch.bound()
    onBound?.(boundSnapshot)
    const wait = <T>(promise: Promise<T>) => gate ? gate.race(promise) : promise
    let limits: ResearchOptionsPayload['defaults'] | undefined
    // Permission is runtime-local: reconnecting a persisted owner must restore
    // research's selected policy without changing its model or run parameters.
    await wait(requestResearch('set_permission_mode', { mode: 'bypassPermissions' }))
    if (starting && !stored) {
      const options = await wait(request<ResearchOptionsPayload>('get_research_options'))
      limits = { ...options.defaults, plan_approval: false }
    }
    // The picker selection is authoritative for this send, including when
    // continuing an existing run: the research channel's team barrier drains
    // in-flight requests and commits the pair before the message is admitted.
    if (model) await wait(requestResearch('set_model', { provider: model.provider, modelId: model.modelId }))
    if (thinkingLevel) await wait(requestResearch('set_thinking', { level: thinkingLevel }))
    const identity: ResearchSubmissionInput = stored ?? {
      text: question.trim(), sessionId: host.session.sessionId, requestId,
      ...(freshStart ? { startNew: true } : {}),
      ...(runId ? { runId } : {}), ...(limits ? { limits } : {}),
    }
    // The stream identifies the current transport, not the persisted submission.
    const { streamId: _previousStream, ...original } = identity
    const input = { ...original, ...(host.streamId ? { streamId: host.streamId } : {}) }
    let acceptedSnapshot = boundSnapshot
    let receiptRunId: string | undefined
    try {
      if (!stored) onSubmission?.(Object.freeze({ ...input,
        ...(input.limits ? { limits: Object.freeze({ ...input.limits }) } : {}),
      }))
      const sent = gate ? gate.race(requestResearch('send_research_message', input, RESEARCH_STARTUP_TIMEOUT_MS))
        : requestResearch('send_research_message', input)
      await sent
    } catch (error) {
      const unknownDelivery = error instanceof Error &&
        (error as Error & { errorCode?: string }).errorCode === 'RESEARCH_DELIVERY_UNCONFIRMED'
      if (!isResearchRequestTimeout(error) && !unknownDelivery) throw error
      onUnconfirmed?.(error)
      // A timeout says nothing about delivery. Ask the owning host before the UI
      // exposes retry. Persisted intent is not an authoritative acceptance receipt.
      let reconciledAcceptance = false
      try {
        const latest = projectStartupSnapshot(await requestResearch<ResearchHostSnapshot>('get_research_host'))
        if (latest?.session?.sessionId === host.session.sessionId && (!host.streamId || latest.streamId === host.streamId)) {
          const reconciled: ResearchHostSnapshot = { ...boundSnapshot, ...latest,
            messages: latest.messages ?? [], historyVersion: latest.historyVersion ?? null,
            lastEventSeq: latest.lastEventSeq ?? boundSnapshot.lastEventSeq, run: latest.run ?? boundSnapshot.run }
          onBound?.(reconciled)
          const receipts = latest.submissionReceipts
          const receipt = receipts?.find(item => item.requestId === input.requestId)
          const persisted = receipts === undefined && reconciled.messages.some(message =>
            message.role === 'user' && (message.requestId || message.details?.requestId) === input.requestId)
          reconciledAcceptance = receipt ? receipt.state === 'accepted' || receipt.state === 'applied'
            : persisted && (!starting || !!reconciled.run?.id)
          if (reconciledAcceptance) {
            acceptedSnapshot = reconciled
            receiptRunId = receipt?.runId || reconciled.run?.id || runId
          }
        }
      } catch {
        // The original timeout remains unconfirmed; a refresh failure is not rejection either.
      }
      if (!reconciledAcceptance) {
        // The owning host has been asked and did not confirm: the row is as settled as this
        // attempt can make it, so the UI must offer the same-id retry instead of polling forever.
        onUnconfirmed?.(error, true)
        throw error
      }
    }
    onAccepted?.()
    let confirmedRunId = receiptRunId || runId
    if (!confirmedRunId && gate && confirmation) {
      const confirmOrReconcile = async () => {
        try { return await confirmation.promise }
        catch (error) {
          if (error instanceof Error && error.name === 'ResearchStartupConfirmationTimeoutError') {
            // A durable run can exist even if its creation event was missed.
            try {
              const latest = projectStartupSnapshot(await gate.race(requestResearch<ResearchHostSnapshot>('get_research_host')))
              if (latest?.session?.sessionId === host.session.sessionId && (!host.streamId || latest.streamId === host.streamId) && latest.run?.id) {
                acceptedSnapshot = { ...boundSnapshot, ...latest }
                return latest.run.id
              }
            } catch {
              // A failed/untrusted refresh does not erase the accepted input.
            }
          }
          throw error
        }
      }
      try { confirmedRunId = await gate.race(confirmOrReconcile()) }
      catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { stage: 'startup', accepted: true })
      }
    }
    try {
      const latest = projectStartupSnapshot(await requestResearch<ResearchHostSnapshot>('get_research_host'))
      if (latest?.session?.sessionId !== host.session.sessionId || (host.streamId && latest.streamId !== host.streamId)) {
        throw new Error('研究状态同步的会话或通道标识已变更，请刷新原研究。')
      }
      return { ...acceptedSnapshot, ...latest, runId: confirmedRunId! }
    } catch (error) {
      return { ...acceptedSnapshot, runId: confirmedRunId!, syncError: error instanceof Error ? error.message : String(error) }
    }
  } finally {
    confirmation?.cancel()
    gate?.release()
  }
}
