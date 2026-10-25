/**
 * Renderer-side half of the shell diagnostics. It answers one question the main process cannot: was
 * the main thread actually able to run? Records are aggregated per window and carry identities and
 * timings only -- never a prompt body, a tool output or a key.
 */

export interface DiagnosticsTransport {
  report(records: DiagnosticRecord[]): void
}

export interface DiagnosticRecord {
  kind: string
  [key: string]: unknown
}

export interface StreamStats {
  received: number
  applied: number
  merged: number
  bytes: number
  maxApplyMs: number
  maxGapMs: number
  lastSeq: number
  /** How many envelopes were still waiting to be applied when the window closed. */
  queue: number
}

export interface InstallOptions {
  now?: () => number
  /** How often the aggregate window is handed to the main process. */
  windowMs?: number
  maxBufferedRecords?: number
  onError?: (error: unknown) => void
}

export interface RendererDiagnostics {
  stop(): void
  stats(): StreamStats
  record(kind: string, fields?: Record<string, unknown>): void
  noteArrival(bytes: number, seq: number | undefined): void
  noteApplied(seq: number | undefined, merged: number, applyMs: number, queueLength: number): void
  flushNow(): void
}

const emptyStats = (): StreamStats => ({
  received: 0, applied: 0, merged: 0, bytes: 0, maxApplyMs: 0, maxGapMs: 0, lastSeq: 0, queue: 0,
})

/**
 * Installs the observers and the periodic hand-off. Returns immediately when the surface is not a
 * renderer (unit tests, the graph page) so nothing else has to know about the environment.
 */
export function installRendererDiagnostics(
  transport: DiagnosticsTransport | undefined | null,
  options: InstallOptions = {},
): RendererDiagnostics {
  const now = options.now ?? (() => Date.now())
  const windowMs = options.windowMs ?? 2000
  const maxBuffered = options.maxBufferedRecords ?? 128
  const records: DiagnosticRecord[] = []
  const stats = emptyStats()
  const current = emptyStats()
  let lastArrivalAt = 0
  let stopped = false

  const push = (record: DiagnosticRecord) => {
    if (records.length >= maxBuffered) records.splice(0, records.length - maxBuffered)
    records.push(record)
    if (records.length >= maxBuffered) handOff()
  }

  const handOff = () => {
    if (records.length === 0) return
    const batch = records.splice(0, records.length)
    try { transport?.report(batch) } catch (error) { options.onError?.(error) }
  }

  const flushNow = () => {
    emitWindow()
    handOff()
  }

  const emitWindow = () => {
    if (current.received === 0 && current.applied === 0) return
    stats.received = current.received
    stats.applied = current.applied
    stats.merged = current.merged
    stats.bytes = current.bytes
    stats.maxApplyMs = current.maxApplyMs
    stats.maxGapMs = current.maxGapMs
    stats.lastSeq = current.lastSeq
    push({ kind: 'renderer:stream', t: now(), ...current })
    Object.assign(current, emptyStats())
  }

  const timer = setInterval(() => { emitWindow(); handOff() }, windowMs)

  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 50) push({ kind: 'renderer:longtask', t: now(), ms: Math.round(entry.duration) })
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch { /* longtask observation is a chrome capability, not a requirement */ }

  // Input delay is the number the reader feels: from the browser posting the event to the handler
  // starting. A blocked main thread shows up here before anything on screen moves.
  let eventObserver: PerformanceObserver | null = null
  try {
    eventObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const delay = (entry as PerformanceEntry & { processingStart?: number }).processingStart
        if (typeof delay !== 'number') continue
        if (delay - entry.startTime > 50) {
          push({ kind: 'renderer:input-delay', t: now(), ms: Math.round(delay - entry.startTime), name: entry.name })
        }
      }
    })
    eventObserver.observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit)
  } catch { /* the event timeline needs newer chrome than some builds ship */ }

  const onError = (event: ErrorEvent | PromiseRejectionEvent) => {
    const message = event instanceof ErrorEvent ? event.message : String((event as PromiseRejectionEvent).reason ?? '')
    push({ kind: 'renderer:error', t: now(), unhandled: event.type === 'unhandledrejection', message: message.slice(0, 200) })
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onError)
  }

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      try { observer?.disconnect() } catch { /* already disconnected */ }
      try { eventObserver?.disconnect() } catch { /* never supported on this page */ }
      if (typeof window !== 'undefined') {
        window.removeEventListener('error', onError)
        window.removeEventListener('unhandledrejection', onError)
      }
      flushNow()
    },
    stats: () => ({ ...stats }),
    record: (kind, fields) => push({ kind, t: now(), ...fields }),
    noteArrival: (bytes, seq) => {
      current.received += 1
      current.bytes += bytes
      if (typeof seq === 'number') current.lastSeq = seq
      if (lastArrivalAt > 0) current.maxGapMs = Math.max(current.maxGapMs, now() - lastArrivalAt)
      lastArrivalAt = now()
    },
    noteApplied: (seq, merged, applyMs, queueLength) => {
      current.applied += 1
      current.merged += merged
      current.maxApplyMs = Math.max(current.maxApplyMs, Math.round(applyMs * 100) / 100)
      if (typeof seq === 'number') current.lastSeq = seq
      current.queue = queueLength
    },
    flushNow,
  }
}

/** What the sandboxed renderer may use: a one-way push to the main process. */
export function reportThroughShell(records: DiagnosticRecord[]): void {
  window.diagnostics?.report(records)
}

const inert: RendererDiagnostics = {
  stop: () => {},
  stats: () => emptyStats(),
  record: () => {},
  noteArrival: () => {},
  noteApplied: () => {},
  flushNow: () => {},
}

let installed: RendererDiagnostics | null = null

/** The page's diagnostics, or a no-op when nothing installed them (tests, a plain browser tab). */
export function rendererDiagnostics(): RendererDiagnostics {
  return installed ?? inert
}

/** Install for this page and remember it as the surface every other module reports through. */
export function registerRendererDiagnostics(transport: DiagnosticsTransport | null, options?: InstallOptions): RendererDiagnostics {
  installed?.stop()
  const created = installRendererDiagnostics(transport, options)
  installed = created
  return created
}

export function clearRendererDiagnostics(): void {
  installed = null
}
