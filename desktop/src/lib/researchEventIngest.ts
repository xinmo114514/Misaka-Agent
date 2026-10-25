import type { BridgeMessage } from '../types/global'
import { rendererDiagnostics } from './rendererDiagnostics'

/**
 * Research events arrive one per engine event, and the engine emits one per streamed token -- each
 * of those carrying the whole message accumulated so far. Applied as they land, that is one React
 * commit per token and a reader whose clicks queue behind thousands of them.
 *
 * The queue keeps arrival order and every event that changes a state, spends a bounded slice of each
 * task on them, and merges only the intermediate whole-message snapshots a later snapshot already
 * contains. Incremental text deltas are never merged, because they are not self-contained.
 */

export const DEFAULT_BUDGET_MS = 8
export const DEFAULT_MAX_QUEUED = 4000

export interface IngestOptions {
  apply: (message: BridgeMessage) => void
  budgetMs?: number
  maxQueued?: number
  now?: () => number
  yieldTo?: (callback: () => void) => void
  onError?: (error: unknown) => void
  onDrain?: (info: { applied: number; merged: number; dropped: number; queue: number; tookMs: number; lastSeq: number }) => void
}

export interface ResearchIngest {
  push: (message: BridgeMessage) => void
  flushNow: () => void
  size: () => number
  stop: () => void
  stats: () => { received: number; applied: number; merged: number; dropped: number }
}

interface Queued {
  message: BridgeMessage
  mergeKey: string | null
}

/** The identity of the message a snapshot belongs to; two snapshots of one message may collapse. */
export function snapshotKey(message: BridgeMessage): string | null {
  if (!('event' in message) || !message.event) return null
  const event = message.event as { type?: unknown; message?: { role?: unknown; timestamp?: unknown; content?: unknown } }
  if (event.type !== 'message_update') return null
  const row = event.message
  if (!row || row.role !== 'assistant' || !Array.isArray(row.content)) return null
  if (typeof row.timestamp !== 'number') return null
  const sessionId = (message as { sessionId?: unknown }).sessionId
  const streamId = (message as { streamId?: unknown }).streamId
  if (typeof sessionId !== 'string' || typeof streamId !== 'string') return null
  return `${sessionId}|${streamId}|${row.timestamp}`
}

export function createResearchIngest(options: IngestOptions): ResearchIngest {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS
  const maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))
  const yieldTo = options.yieldTo ?? (callback => { setTimeout(callback, 0) })
  const queue: Queued[] = []
  let draining = false
  let stopped = false
  let received = 0
  let applied = 0
  let merged = 0
  let dropped = 0

  const push = (message: BridgeMessage) => {
    if (stopped) return
    received += 1
    const mergeKey = snapshotKey(message)
    const tail = queue[queue.length - 1]
    // Only the newest snapshot of one message is worth applying: the one behind it says nothing the
    // newer one does not, and a whole-message snapshot replaces the blocks it carried.
    if (mergeKey && tail && tail.mergeKey === mergeKey) {
      queue[queue.length - 1] = { message, mergeKey }
      merged += 1
      return
    }
    queue.push({ message, mergeKey })
    if (queue.length > maxQueued) trim()
    if (!draining) schedule()
  }

  /** Shed load by dropping superseded snapshots; a state-changing event is never dropped. */
  const trim = () => {
    const survivors: Queued[] = []
    const seenBackward = new Set<string>()
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const item = queue[index]
      if (item.mergeKey) {
        if (seenBackward.has(item.mergeKey)) { dropped += 1; continue }
        seenBackward.add(item.mergeKey)
      }
      survivors.push(item)
    }
    survivors.reverse()
    queue.length = 0
    queue.push(...survivors)
  }

  const drain = () => {
    draining = false
    if (stopped) return
    const started = now()
    const firstSeq = seqOf(queue[0]?.message)
    let sliceApplied = 0
    let sliceMerged = 0
    while (queue.length > 0) {
      const item = queue.shift()
      if (!item) continue
      if (item.mergeKey) sliceMerged += 1
      try { options.apply(item.message) } catch (error) { options.onError?.(error) }
      applied += 1
      sliceApplied += 1
      if (now() - started >= budgetMs && queue.length > 0) break
    }
    const tookMs = now() - started
    if (sliceApplied > 0) {
      const lastSeq = seqOf(queue.length > 0 ? queue[0].message : undefined) ?? firstSeq
      rendererDiagnostics().noteApplied(lastSeq, sliceMerged, tookMs, queue.length)
      options.onDrain?.({ applied: sliceApplied, merged: sliceMerged, dropped, queue: queue.length, tookMs, lastSeq: lastSeq ?? 0 })
    }
    if (queue.length > 0) schedule()
  }

  const schedule = () => {
    draining = true
    yieldTo(drain)
  }

  return {
    push,
    flushNow: () => {
      // Everything the reader has been promised, applied now, in arrival order.
      while (queue.length > 0) {
        const item = queue.shift()!
        try { options.apply(item.message) } catch (error) { options.onError?.(error) }
        applied += 1
      }
    },
    size: () => queue.length,
    stop: () => { stopped = true; queue.length = 0 },
    stats: () => ({ received, applied, merged, dropped }),
  }
}

function seqOf(message: BridgeMessage | undefined): number | undefined {
  const seq = (message as { seq?: unknown } | undefined)?.seq
  return typeof seq === 'number' ? seq : undefined
}
