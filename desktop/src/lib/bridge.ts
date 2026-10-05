/**
 * The one place that talks to the Python bridge.
 *
 * Before this, a reply was matched to its request by sniffing the prefix of the `requestId`
 * string (`req_ls_`, `req_sw_`, `req_graph_`...), which meant adding a command required inventing
 * a new prefix and teaching every listener that sniffs it. Requests here carry their own
 * resolver, keyed by an id that is unique rather than merely namespaced.
 *
 * Acks that nobody is waiting on, and all push events, still fan out to registered sinks, so a
 * store that reacts to unsolicited traffic (`session_started`, `message_update`, a permission
 * request) does not have to change to use this.
 */
import type { BridgeAck, BridgeEventEnvelope, BridgeMessage } from '../types/global'

type Pending = {
  resolve: (msg: BridgeMessage) => void
  reject: (error: Error) => void
  timer: number
}

const pending = new Map<string, Pending>()
const sinks = new Set<(msg: BridgeMessage) => void>()
const eventHandlers = new Map<string, Set<(event: any) => void>>()

let sequence = 0

/** A request id unique within this process, still prefixed for human-readable logs. */
export function newRequestId(type: string): string {
  sequence += 1
  return `req_${type}_${Date.now().toString(36)}_${sequence.toString(36)}`
}

export function isBridgeAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.bridge?.send
}

/** Fire and forget: the command is written, its ack is not awaited. */
export function send(command: Record<string, any>): void {
  if (!isBridgeAvailable()) return
  window.bridge.send(command as any)
}

/**
 * Send a command and wait for its ack.
 *
 * Rejects on an `ok: false` ack (with the bridge's own message), and on a timeout -- the bridge
 * answers every command it recognises, so silence means the child died between the write and the
 * reply, which the caller must not mistake for success.
 */
export function request<T = any>(
  type: string,
  payload: Record<string, any> = {},
  timeoutMs = 20000,
): Promise<T> {
  const requestId = typeof payload.requestId === 'string' && payload.requestId
    ? payload.requestId
    : newRequestId(type)
  return new Promise<T>((resolve, reject) => {
    if (!isBridgeAvailable()) {
      reject(new Error('桌面桥接进程尚未就绪'))
      return
    }
    const timer = window.setTimeout(() => {
      if (pending.delete(requestId)) reject(new Error(`${type} 没有回应`))
    }, timeoutMs)
    pending.set(requestId, {
      resolve: (msg) => {
        const ack = msg as Partial<BridgeAck>
        resolve((ack.data ?? ack) as T)
      },
      reject,
      timer,
    })
    send({ ...payload, type, requestId })
  })
}

/** Like {@link request}, but hands back the whole ack envelope for replies that keep fields beside `data`. */
export function requestEnvelope(
  type: string,
  payload: Record<string, any> = {},
  timeoutMs = 20000,
): Promise<BridgeMessage> {
  const requestId = typeof payload.requestId === 'string' && payload.requestId
    ? payload.requestId
    : newRequestId(type)
  return new Promise<BridgeMessage>((resolve, reject) => {
    if (!isBridgeAvailable()) {
      reject(new Error('桌面桥接进程尚未就绪'))
      return
    }
    const timer = window.setTimeout(() => {
      if (pending.delete(requestId)) reject(new Error(`${type} 没有回应`))
    }, timeoutMs)
    pending.set(requestId, { resolve, reject, timer })
    send({ ...payload, type, requestId })
  })
}

/** Drop every waiter: call when the bridge process goes away, so nothing hangs. */
function releaseAll(reason: string): void {
  for (const [, entry] of pending) {
    window.clearTimeout(entry.timer)
    entry.reject(new Error(reason))
  }
  pending.clear()
}

/** See every message, acks included. Returns an unsubscribe. */
export function addSink(handler: (msg: BridgeMessage) => void): () => void {
  sinks.add(handler)
  return () => sinks.delete(handler)
}

/** React to one pushed event type (`message_update`, `permission:request`, ...). */
export function onEvent(type: string, handler: (event: any) => void): () => void {
  let set = eventHandlers.get(type)
  if (!set) {
    set = new Set()
    eventHandlers.set(type, set)
  }
  set.add(handler)
  return () => {
    set?.delete(handler)
    if (set && set.size === 0) eventHandlers.delete(type)
  }
}

/**
 * Feed one decoded bridge message in. Wire this to the single `window.bridge.on` subscription.
 *
 * Acks are resolved here first; the sinks still see them, because a store may track traffic that
 * was never asked for.
 *
 * The two kinds are not tagged the same way: an ack carries `type: 'ack'`, while a pushed event
 * is a bare `{seq, sessionId, event}` with no `type` of its own. Dispatch on the shape, not on a
 * name that is not there.
 */
export function handleIncoming(msg: BridgeMessage): void {
  if (!msg || typeof msg !== 'object') return

  if ('type' in msg && msg.type === 'ack' && typeof msg.requestId === 'string') {
    const entry = pending.get(msg.requestId)
    if (entry) {
      pending.delete(msg.requestId)
      window.clearTimeout(entry.timer)
      if (msg.ok === false) entry.reject(new Error(msg.error || '请求失败'))
      else entry.resolve(msg)
    }
  }

  // Snapshotted: a handler that unsubscribes itself (a one-shot reply listener) would otherwise
  // mutate the set mid-dispatch and skip whoever was next.
  const event = (msg as Partial<BridgeEventEnvelope>).event
  if (event && typeof event.type === 'string') {
    const handlers = eventHandlers.get(event.type)
    if (handlers) for (const handler of Array.from(handlers)) handler(event)
  }

  for (const sink of Array.from(sinks)) sink(msg)
}

let installed = 0
let unsubscribers: (() => void) | null = null

/**
 * Subscribe to the bridge once for the whole app. Returns an unsubscribe.
 *
 * Refcounted: several components may install it, and the last one leaving is the only moment the
 * process is genuinely unwatched -- otherwise a remount would reject requests another view is
 * still awaiting.
 */
export function installBridge(): () => void {
  installed += 1
  if (installed === 1 && isBridgeAvailable()) {
    unsubscribers = window.bridge.on(handleIncoming)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    installed -= 1
    if (installed <= 0) {
      installed = 0
      unsubscribers?.()
      unsubscribers = null
      releaseAll('桌面桥接进程已断开')
    }
  }
}
