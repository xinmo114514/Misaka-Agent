import { beginResearchControl } from './researchActivityStore'
import type { BridgeMessage } from '../types/global'
import { request } from './bridge'
import { rendererDiagnostics } from './rendererDiagnostics'
import type { ResearchHostSnapshot, ResearchRunDetail, ResearchFailureMetadata, ResearchFailureDetails } from '../types/research'

type Pending = {
  resolve: (message: BridgeMessage) => void
  reject: (error: Error) => void
  timer: number
  promise: Promise<any>
  commandSignature: string
  sessionId?: string
  streamId?: string
}
const pending = new Map<string, Pending>()
const sinks = new Set<(message: BridgeMessage) => void>()
let sequence = 0
let installed = 0
let unsubscribe: (() => void) | null = null

type ResearchErrorDetails = ResearchFailureMetadata & {
  requestId: string
  errorCode?: string
  errorStage?: string
  retryable?: boolean
  sessionId?: string
  streamId?: string
}

export class ResearchRequestError extends Error {
  readonly errorCode?: string
  readonly errorStage?: string
  readonly retryable?: boolean
  readonly requestId: string
  readonly sessionId?: string
  readonly streamId?: string
  readonly errorDetails?: ResearchFailureDetails
  readonly researchNeedsConfiguration?: boolean

  constructor(message: string, details: ResearchErrorDetails) {
    super(message)
    this.name = 'ResearchRequestError'
    this.errorCode = details.errorCode
    this.errorStage = details.errorStage
    this.retryable = details.retryable
    this.requestId = details.requestId
    this.sessionId = details.sessionId
    this.streamId = details.streamId
    this.errorDetails = details.errorDetails
    this.researchNeedsConfiguration = details.researchNeedsConfiguration
  }
}

export class ResearchRequestTimeoutError extends Error {
  readonly requestId: string
  readonly requestType: string

  constructor(requestType: string, requestId: string) {
    super(`${requestType} 没有回应`)
    this.name = 'ResearchRequestTimeoutError'
    this.requestId = requestId
    this.requestType = requestType
  }
}

export function isResearchRequestTimeout(error: unknown): error is ResearchRequestTimeoutError {
  return error instanceof ResearchRequestTimeoutError || (error instanceof Error && error.name === 'ResearchRequestTimeoutError')
}

function send(command: Record<string, unknown>): void {
  window.researchBridge?.send(command)
}

function commandSignature(command: Record<string, unknown>): string {
  return JSON.stringify(command, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
  })
}

export function requestResearch<T = any>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 20000): Promise<T> {
  const requestId = typeof payload.requestId === 'string'
    ? payload.requestId
    : `req_research_${Date.now().toString(36)}_${(++sequence).toString(36)}`
  const command = { ...payload, type, requestId }
  let signature: string
  try {
    signature = commandSignature(command)
  } catch (error) {
    return Promise.reject(error)
  }
  const existing = pending.get(requestId)
  if (existing) {
    if (existing.commandSignature === signature) return existing.promise as Promise<T>
    return Promise.reject(new ResearchRequestError('研究请求标识已用于另一条命令', {
      requestId, errorCode: 'REQUEST_ID_CONFLICT', retryable: false,
      sessionId: existing.sessionId, streamId: existing.streamId,
    }))
  }
  if (typeof window === 'undefined' || !window.researchBridge?.send) {
    return Promise.reject(new Error('研究桥接通道尚未就绪'))
  }
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  const waiter: Pending = {
    timer: window.setTimeout(() => {
      if (pending.get(requestId) !== waiter) return
      pending.delete(requestId)
      reject(new ResearchRequestTimeoutError(type, requestId))
    }, timeoutMs),
    promise,
    commandSignature: signature,
    sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
    streamId: typeof payload.streamId === 'string' ? payload.streamId : undefined,
    reject,
    resolve: message => {
      if ('type' in message && message.type === 'ack' && message.ok === false) {
        reject(new ResearchRequestError(message.error || '请求失败', {
          requestId,
          errorCode: typeof message.errorCode === 'string' ? message.errorCode : undefined,
          errorStage: typeof message.errorStage === 'string' ? message.errorStage : undefined,
          retryable: typeof message.retryable === 'boolean' ? message.retryable : undefined,
          errorDetails: message.errorDetails,
          researchNeedsConfiguration: typeof message.researchNeedsConfiguration === 'boolean' ? message.researchNeedsConfiguration : undefined,
          sessionId: typeof message.sessionId === 'string' ? message.sessionId : waiter.sessionId,
          streamId: typeof message.streamId === 'string' ? message.streamId : waiter.streamId,
        }))
        return
      }
      resolve(((message as any).data ?? message) as T)
    },
  }
  pending.set(requestId, waiter)
  try {
    send(command)
  } catch (error) {
    if (pending.get(requestId) === waiter) pending.delete(requestId)
    window.clearTimeout(waiter.timer)
    reject(error instanceof Error ? error : new Error(String(error)))
  }
  return promise
}

export function addResearchSink(handler: (message: BridgeMessage) => void): () => void {
  sinks.add(handler)
  return () => sinks.delete(handler)
}

export async function executeResearchControl(
  type: 'stop_research' | 'resume_research',
  input: { runId: string; workspace?: string; sessionFile?: string | null; clarification?: string;
    onBound?: (snapshot: ResearchHostSnapshot) => void; isCurrent?: () => boolean },
): Promise<void> {
  let sessionFile = input.sessionFile
  let workspace = input.workspace
  if (!sessionFile) {
    const detail = await request<ResearchRunDetail>('get_research_details', { runId: input.runId, workspace })
    sessionFile = detail.run?.rootSession
    workspace = detail.run?.workspace || workspace
  }
  if (!sessionFile || !workspace) throw new Error('研究根会话尚未登记，请刷新研究状态。')
  if (input.isCurrent && !input.isCurrent()) return
  const host = await window.app.startResearchBridge({ cwd: workspace, sessionFile })
  if (input.isCurrent && !input.isCurrent()) return
  if (!host.enabled || !host.session?.sessionId || !host.session.file) throw new Error('研究控制宿主尚未就绪，请重新打开原研究。')
  input.onBound?.({ ...host, messages: host.messages ?? [], historyVersion: host.historyVersion ?? null,
    lastEventSeq: host.lastEventSeq ?? 0, run: host.run ?? null })
  if (input.isCurrent && !input.isCurrent()) return
  beginResearchControl(input.runId)
  await requestResearch(type, { runId: input.runId, clarification: input.clarification,
    sessionId: host.session.sessionId, ...(host.streamId ? { streamId: host.streamId } : {}) })
  // An acknowledgement only means the command was received. A resume is accepted once the
  // observation chain reports a live driver (`researchResume.confirmResearchDriving`), so a
  // rejected or unheard resume cannot flip the card to active.
}

export function installResearchBridge(): () => void {
  installed += 1
  if (installed === 1 && typeof window !== 'undefined' && window.researchBridge?.on) {
    unsubscribe = window.researchBridge.on(message => {
      // Arrival is timed here, before any work: the queue's own record says when it was applied.
      const stamped = message as { mainBytes?: unknown; seq?: unknown }
      rendererDiagnostics().noteArrival(typeof stamped.mainBytes === 'number' ? stamped.mainBytes : 0,
        typeof stamped.seq === 'number' ? stamped.seq : undefined)
      if ('type' in message && message.type === 'ack' && typeof message.requestId === 'string') {
        const waiter = pending.get(message.requestId)
        if (waiter) {
          if (
            (waiter.sessionId !== undefined && typeof message.sessionId === 'string' && message.sessionId !== waiter.sessionId)
            || (waiter.streamId !== undefined && typeof message.streamId === 'string' && message.streamId !== waiter.streamId)
          ) return
          pending.delete(message.requestId)
          window.clearTimeout(waiter.timer)
          waiter.resolve(message)
        }
      }
      for (const sink of Array.from(sinks)) sink(message)
    })
  }
  let released = false
  return () => {
    if (released) return
    released = true
    installed = Math.max(0, installed - 1)
    if (installed === 0) {
      unsubscribe?.()
      unsubscribe = null
      for (const [id, waiter] of pending) {
        window.clearTimeout(waiter.timer)
        waiter.reject(new Error('研究桥接通道已断开'))
        pending.delete(id)
      }
    }
  }
}
