import { describe, expect, it, vi } from 'vitest'
import { createResearchIngest, snapshotKey, type IngestOptions } from './researchEventIngest'
import type { BridgeMessage } from '../types/global'

function snapshot(seq: number, timestamp: number, chars: number, streamId = 's1'): BridgeMessage {
  return { seq, sessionId: 'root', streamId, event: { type: 'message_update',
    message: { role: 'assistant', timestamp, content: [{ type: 'text', text: 'x'.repeat(chars) }] } } } as never
}

function delta(seq: number, piece: string): BridgeMessage {
  return { seq, sessionId: 'root', streamId: 's1', event: { type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: piece } } } as never
}

function terminal(seq: number): BridgeMessage {
  return { seq, sessionId: 'root', streamId: 's1', event: { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read', isError: false, result: 'ok' } } as never
}

/** A drain that runs when the test says so, with a clock the test advances by how long work takes. */
function harness(options: Partial<IngestOptions> = {}) {
  const applied: BridgeMessage[] = []
  let clock = 0
  const pending: Array<() => void> = []
  const ingest = createResearchIngest({
    apply: message => { applied.push(message); clock += 1 },
    budgetMs: 3,
    now: () => clock,
    yieldTo: callback => { pending.push(callback) },
    ...options,
  })
  const runAll = () => { while (pending.length) pending.shift()!() }
  return { applied, ingest, pending, runAll, clock: () => clock }
}

describe('snapshotKey', () => {
  it('names only a whole-message assistant snapshot', () => {
    expect(snapshotKey(snapshot(1, 1000, 10))).toBe('root|s1|1000')
    expect(snapshotKey(delta(2, 'half a sentence'))).toBeNull()
    expect(snapshotKey(terminal(3))).toBeNull()
    expect(snapshotKey({ type: 'ack', requestId: 'r' } as never)).toBeNull()
  })

  it('keeps a user row and a custom notice out of the merge', () => {
    expect(snapshotKey({ seq: 1, sessionId: 'root', streamId: 's1',
      event: { type: 'message_update', message: { role: 'user', timestamp: 5, content: [] } } } as never)).toBeNull()
  })
})

describe('createResearchIngest', () => {
  it('collapses a run of snapshots into the newest one', () => {
    const h = harness()
    h.ingest.push(snapshot(1, 1000, 8))
    h.ingest.push(snapshot(2, 1000, 40))
    h.ingest.push(snapshot(3, 1000, 90))
    h.runAll()
    expect(h.applied).toHaveLength(1)
    expect((h.applied[0] as { seq: number }).seq).toBe(3)
    expect(h.ingest.stats()).toMatchObject({ received: 3, applied: 1, merged: 2, dropped: 0 })
  })

  it('never merges an incremental delta, so no streamed text is lost', () => {
    const h = harness()
    for (const [index, piece] of ['Ho', 'll', 'y ', 'no', 'w'] .entries()) h.ingest.push(delta(index + 1, piece))
    h.runAll()
    expect(h.applied).toHaveLength(5)
    expect(h.ingest.stats().merged).toBe(0)
  })

  it('keeps state-changing events between two snapshots', () => {
    const h = harness()
    h.ingest.push(snapshot(1, 1000, 8))
    h.ingest.push(terminal(2))
    h.ingest.push(snapshot(3, 1000, 30))
    h.runAll()
    expect(h.applied.map(message => (message as { seq: number }).seq)).toEqual([1, 2, 3])
  })

  it('treats another stream as another message', () => {
    const h = harness()
    h.ingest.push(snapshot(1, 1000, 8, 's1'))
    h.ingest.push(snapshot(2, 1000, 8, 's2'))
    h.runAll()
    expect(h.applied).toHaveLength(2)
  })

  it('spends a bounded slice per task and keeps draining until the queue is empty', () => {
    const h = harness()
    for (let index = 0; index < 50; index += 1) h.ingest.push(terminal(index + 1))
    // One task: budget 3ms, each apply costs 1ms -> 4 applied (the check happens after applying).
    h.pending.shift()!()
    expect(h.applied.length).toBeLessThanOrEqual(5)
    expect(h.pending).toHaveLength(1)
    h.runAll()
    expect(h.applied).toHaveLength(50)
    expect(h.ingest.size()).toBe(0)
  })

  it('drops only superseded snapshots when the queue overflows', () => {
    const applied: BridgeMessage[] = []
    let clock = 0
    const ingest = createResearchIngest({
      apply: message => applied.push(message),
      maxQueued: 4,
      budgetMs: 1000,
      now: () => clock,
      yieldTo: () => { /* never drained on its own: flushNow decides the order */ },
    })
    // Snapshots of one message separated by tool results: they cannot merge pairwise, so only the
    // newest one of that message may be shed.
    for (let index = 0; index < 10; index += 1) {
      ingest.push(snapshot(index + 1, 1000, index))
      ingest.push(terminal(100 + index))
    }
    ingest.flushNow()
    const seqs = applied.map(message => (message as { seq: number }).seq)
    expect(seqs.filter(seq => seq >= 100)).toHaveLength(10)
    expect(seqs).toContain(10)
    expect(seqs).not.toContain(1)
    expect(seqs[seqs.length - 1]).toBe(109)
    expect(ingest.stats().dropped).toBe(9)
  })

  it('flushNow applies what is waiting, in order, without scheduling a task', () => {
    const h = harness()
    h.ingest.push(snapshot(1, 1000, 8))
    h.ingest.push(terminal(2))
    h.ingest.push(terminal(3))
    h.ingest.flushNow()
    expect(h.applied.map(message => (message as { seq: number }).seq)).toEqual([1, 2, 3])
    expect(h.ingest.size()).toBe(0)
    expect(h.pending).toHaveLength(1)
    h.pending.length = 0
    h.runAll()
    expect(h.applied).toHaveLength(3)
  })

  it('an apply that throws does not stall the queue', () => {
    const seen: number[] = []
    const onError = vi.fn()
    let clock = 0
    const pending: Array<() => void> = []
    const ingest = createResearchIngest({
      apply: message => {
        const seq = (message as { seq: number }).seq
        seen.push(seq)
        if (seq === 2) throw new Error('reducer rejected')
      },
      budgetMs: 1000,
      now: () => ++clock,
      yieldTo: callback => pending.push(callback),
      onError,
    })
    for (const seq of [1, 2, 3]) ingest.push(terminal(seq))
    pending.shift()!()
    expect(seen).toEqual([1, 2, 3])
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('stop() discards what has not been applied yet', () => {
    const h = harness()
    h.ingest.push(terminal(1))
    h.ingest.stop()
    h.ingest.push(terminal(2))
    h.runAll()
    h.ingest.flushNow()
    expect(h.applied).toHaveLength(0)
  })

  it('reports the drain to the shell diagnostics', () => {
    const onDrain = vi.fn()
    const h = harness({ onDrain })
    h.ingest.push(snapshot(1, 1000, 8))
    h.ingest.push(snapshot(2, 1000, 9))
    h.runAll()
    expect(onDrain).toHaveBeenCalledWith(expect.objectContaining({ applied: 1, merged: 1, queue: 0, lastSeq: 2 }))
  })
})
