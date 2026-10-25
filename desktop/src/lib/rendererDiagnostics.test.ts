import { afterEach, describe, expect, it, vi } from 'vitest'
import { installRendererDiagnostics, type DiagnosticRecord } from './rendererDiagnostics'

let clock = 1000
const teardown: Array<() => void> = []

afterEach(() => {
  while (teardown.length) teardown.pop()!()
  clock = 1000
})

function harness(windowMs = 400) {
  const batches: DiagnosticRecord[][] = []
  const diagnostics = installRendererDiagnostics({ report: records => batches.push(records) }, {
    now: () => clock, windowMs,
  })
  teardown.push(diagnostics.stop)
  return { diagnostics, batches, flat: () => batches.flat() }
}

describe('rendererDiagnostics', () => {
  it('aggregates a stream window instead of writing one record per event', () => {
    const { diagnostics, flat } = harness()
    diagnostics.noteArrival(4096, 11)
    clock = 1120
    diagnostics.noteArrival(64, 12)
    diagnostics.noteApplied(12, 5, 3.4, 2)
    diagnostics.flushNow()
    const window = flat().filter(record => record.kind === 'renderer:stream')
    expect(window).toHaveLength(1)
    expect(window[0]).toMatchObject({ received: 2, applied: 1, merged: 5, bytes: 4160, maxApplyMs: 3.4, maxGapMs: 120, lastSeq: 12, queue: 2 })
    expect(diagnostics.stats()).toMatchObject({ received: 2, merged: 5 })
  })

  it('leaves the window empty when nothing arrived, so an idle app records nothing', () => {
    const { diagnostics, batches } = harness()
    diagnostics.flushNow()
    expect(batches).toHaveLength(0)
  })

  it('reports an uncaught error through the shell transport, clipped', () => {
    const { diagnostics, flat } = harness()
    window.dispatchEvent(new ErrorEvent('error', { message: `boom ${'x'.repeat(500)}` }))
    diagnostics.flushNow()
    const record = flat().find(item => item.kind === 'renderer:error')
    expect(String(record?.message).startsWith('boom ')).toBe(true)
    expect(String(record?.message).length).toBe(200)
  })

  it('hands a rejected promise to the same bounded channel', () => {
    const { diagnostics, flat } = harness()
    window.dispatchEvent(new Event('unhandledrejection'))
    diagnostics.flushNow()
    expect(flat().some(record => record.kind === 'renderer:error' && record.unhandled === true)).toBe(true)
  })

  it('stops observing when torn down', () => {
    const { diagnostics, batches } = harness()
    diagnostics.stop()
    const before = batches.length
    window.dispatchEvent(new ErrorEvent('error', { message: 'after stop' }))
    diagnostics.flushNow()
    expect(batches.length).toBe(before)
  })

  it('flushes on the periodic window and caps what is buffered', () => {
    vi.useFakeTimers()
    try {
      const batches: DiagnosticRecord[][] = []
      const diagnostics = installRendererDiagnostics({ report: records => batches.push(records) }, { now: () => 5 })
      teardown.push(diagnostics.stop)
      diagnostics.record('a')
      diagnostics.noteArrival(10, 1)
      vi.advanceTimersByTime(2100)
      expect(batches.flat().map(record => record.kind)).toEqual(['a', 'renderer:stream'])
      for (let index = 0; index < 300; index += 1) diagnostics.record('b', { index })
      vi.advanceTimersByTime(2100)
      const flushed = batches.flat().filter(record => record.kind === 'b')
      expect(flushed.length).toBeLessThanOrEqual(300)
      expect(flushed.at(-1)).toMatchObject({ index: 299 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('survives a transport that throws', () => {
    const diagnostics = installRendererDiagnostics({
      report: () => { throw new Error('channel closed') },
    }, { now: () => 7, onError: vi.fn() })
    teardown.push(diagnostics.stop)
    diagnostics.record('a')
    expect(() => diagnostics.flushNow()).not.toThrow()
  })
})
