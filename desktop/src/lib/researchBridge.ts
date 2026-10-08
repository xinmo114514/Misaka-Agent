import type { BridgeMessage } from '../types/global'
import { request } from './bridge'
import type { ResearchRunDetail } from '../types/research'

type Pending = { resolve: (message: BridgeMessage) => void; reject: (error: Error) => void; timer: number }
const pending = new Map<string, Pending>()
const sinks = new Set<(message: BridgeMessage) => void>()
let sequence = 0
let installed = 0
let unsubscribe: (() => void) | null = null

function send(command: Record<string, unknown>): void {
  window.researchBridge?.send(command)
}

export function requestResearch<T = any>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 20000): Promise<T> {
  const requestId = typeof payload.requestId === 'string'
    ? payload.requestId
    : `req_research_${Date.now().toString(36)}_${(++sequence).toString(36)}`
  return new Promise<T>((resolve, reject) => {
    if (typeof window === 'undefined' || !window.researchBridge?.send) {
      reject(new Error('研究桥接通道尚未就绪'))
      return
    }
    const timer = window.setTimeout(() => {
      if (pending.delete(requestId)) reject(new Error(`${type} 没有回应`))
    }, timeoutMs)
    pending.set(requestId, {
      timer,
      reject,
      resolve: message => {
        if ('type' in message && message.type === 'ack' && message.ok === false) {
          reject(new Error(message.error || '请求失败'))
          return
        }
        resolve(((message as any).data ?? message) as T)
      },
    })
    send({ ...payload, type, requestId })
  })
}

export function addResearchSink(handler: (message: BridgeMessage) => void): () => void {
  sinks.add(handler)
  return () => sinks.delete(handler)
}

export async function executeResearchControl(
  type: 'stop_research' | 'resume_research',
  input: { runId: string; workspace?: string; sessionFile?: string | null; clarification?: string },
): Promise<void> {
  let sessionFile = input.sessionFile
  let workspace = input.workspace
  if (!sessionFile) {
    const detail = await request<ResearchRunDetail>('get_research_details', { runId: input.runId, workspace })
    sessionFile = detail.run?.rootSession
    workspace = detail.run?.workspace || workspace
  }
  if (!sessionFile || !workspace) throw new Error('研究根会话尚未登记，请刷新研究状态。')
  await window.app.startResearchBridge({ cwd: workspace, sessionFile })
  await requestResearch(type, { runId: input.runId, clarification: input.clarification })
}

export function installResearchBridge(): () => void {
  installed += 1
  if (installed === 1 && typeof window !== 'undefined' && window.researchBridge?.on) {
    unsubscribe = window.researchBridge.on(message => {
      if ('type' in message && message.type === 'ack' && typeof message.requestId === 'string') {
        const waiter = pending.get(message.requestId)
        if (waiter) {
          pending.delete(message.requestId)
          window.clearTimeout(waiter.timer)
          if (message.ok === false) waiter.reject(new Error(message.error || '请求失败'))
          else waiter.resolve(message)
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
