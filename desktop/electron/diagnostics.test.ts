import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { createDiagnostics, eventIdentity, resolveDiagnosticsDir, DIAGNOSTICS_REL_PATH } from './diagnostics'

describe('diagnostics directory', () => {
  it('follows the home row declared in misaka/config/home.py', () => {
    expect(DIAGNOSTICS_REL_PATH).toBe('logs/desktop-diagnostics')
    expect(resolveDiagnosticsDir({ MISAKA_HOME: 'C:/tmp/home' }, 'C:/Users/x')).toEqual({
      dir: path.join('C:/tmp/home', 'logs', 'desktop-diagnostics'), writable: true,
    })
  })

  it('falls back to the user home and reports when nothing is resolvable', () => {
    expect(resolveDiagnosticsDir({}, 'C:/Users/x').dir).toBe(path.join('C:/Users/x', '.misaka', DIAGNOSTICS_REL_PATH))
    expect(resolveDiagnosticsDir({}, '')).toEqual({ dir: '', writable: false })
  })
})

describe('createDiagnostics', () => {
  const make = (overrides: Parameters<typeof createDiagnostics>[0] = {}) => {
    const lines: string[] = []
    let clock = 1_700_000_000_000
    let pending: (() => void) | null = null
    const diagnostics = createDiagnostics({
      sink: batch => lines.push(...batch),
      now: () => clock,
      schedule: callback => { pending = callback; return 1 as unknown as ReturnType<typeof setTimeout> },
      cancel: () => { pending = null },
      ...overrides,
    })
    return { diagnostics, lines, tick: () => { const run = pending; pending = null; run?.() }, advance: (ms: number) => { clock += ms } }
  }

  it('keeps only clipped identity and timing fields', () => {
    const { diagnostics, lines } = make()
    diagnostics.record('renderer:event', {
      sessionId: 's1', streamId: 'f1', seq: 12, bytes: 20_480, kind: 'ignored',
      error: `provider token=sk-abcdef123456 rejected ${'x'.repeat(400)}`, unused: undefined,
    })
    diagnostics.flush()
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0])
    expect(record).toMatchObject({ t: 1_700_000_000_000, kind: 'renderer:event', sessionId: 's1', seq: 12, bytes: 20_480 })
    expect(record.error).toBe('[redacted]')
    expect(record.unused).toBeUndefined()
    expect(record.kind).toBe('renderer:event')
  })

  it('clips a long non-secret field instead of dropping it', () => {
    const { diagnostics, lines } = make()
    diagnostics.record('main:gone', { reason: 'crashed', detail: 'y'.repeat(500) })
    diagnostics.flush()
    expect(JSON.parse(lines[0]).detail).toHaveLength(200)
  })

  it('flushes on a bounded record count and on the timer', () => {
    const { diagnostics, lines, tick } = make()
    diagnostics.record('a')
    expect(lines).toHaveLength(0)
    tick()
    expect(lines).toHaveLength(1)

    for (let index = 0; index < 64; index += 1) diagnostics.record('b', { seq: index })
    expect(lines).toHaveLength(65)
  })

  it('drops the oldest records when nothing consumes the buffer', () => {
    const { diagnostics, lines } = make({ sink: batch => lines.push(...batch) })
    for (let index = 0; index < 2000; index += 1) diagnostics.record('c', { seq: index })
    diagnostics.flush()
    expect(lines.length).toBeLessThanOrEqual(2000)
    expect(JSON.parse(lines[lines.length - 1]).seq).toBe(1999)
  })

  it('accepts a batch from the renderer and ignores records without a kind', () => {
    const { diagnostics, lines } = make()
    diagnostics.recordBatch([{ kind: 'renderer:longtask', ms: 1200 }, { ms: 5 } as Record<string, unknown>])
    diagnostics.flush()
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({ kind: 'renderer:longtask', ms: 1200 })
  })

  it('dispose() drains what is buffered', () => {
    const { diagnostics, lines } = make()
    diagnostics.record('d')
    diagnostics.dispose()
    expect(lines).toHaveLength(1)
  })

  it('a sink that throws does not lose the next record', () => {
    const lines: string[] = []
    let boom = true
    const diagnostics = createDiagnostics({
      schedule: callback => { callback(); return 1 as unknown as ReturnType<typeof setTimeout> },
      sink: batch => { if (boom) { boom = false; throw new Error('disk full') } lines.push(...batch) },
    })
    diagnostics.record('e')
    diagnostics.record('f')
    diagnostics.flush()
    expect(lines.some(line => line.includes('"kind":"f"'))).toBe(true)
  })
})

describe('eventIdentity', () => {
  it('reads the bridge envelope identities without touching the payload', () => {
    expect(eventIdentity({
      seq: 7, sessionId: 's', streamId: 'x', type: 'ack', requestId: 'r1',
      event: { type: 'message_update', toolCallId: 'call_1', message: { content: 'a whole answer' } },
    })).toEqual({ sessionId: 's', streamId: 'x', seq: 7, requestId: 'r1', type: 'ack', eventType: 'message_update', toolCallId: 'call_1' })
  })

  it('tolerates a non-object message', () => {
    expect(eventIdentity(null)).toEqual({})
    expect(eventIdentity('nope')).toEqual({})
  })
})
