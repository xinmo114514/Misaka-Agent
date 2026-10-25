import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

/** Where the home keeps the shell's own diagnostics: `misaka/config/home.py` LAYOUT["desktop_diagnostics"]. */
export const DIAGNOSTICS_REL_PATH = 'logs/desktop-diagnostics'
const FILE_PREFIX = 'desktop-'
const ROTATE_BYTES = 2 * 1024 * 1024
const TOTAL_BYTES = 10 * 1024 * 1024
const RETAIN_DAYS = 14
const FLUSH_RECORDS = 64
const MAX_FIELD_CHARS = 200

export type DiagnosticFields = Record<string, unknown>

export interface DiagnosticsFileHandle {
  dir: string
  /** False when the directory could not be derived (no home, no homedir) -- records stay in memory. */
  writable: boolean
}

export interface Diagnostics {
  file: DiagnosticsFileHandle
  record(kind: string, fields?: DiagnosticFields): void
  recordBatch(records: DiagnosticFields[]): void
  flush(): void
  dispose(): void
  buffered(): number
}

/** The home the shell shares with the bridge: one knob, then `~/.misaka` (see `misaka/config/home.py`). */
export function resolveDiagnosticsDir(env: NodeJS.ProcessEnv, homedir: string): DiagnosticsFileHandle {
  const override = typeof env.MISAKA_HOME === 'string' ? env.MISAKA_HOME.trim() : ''
  const root = override || (homedir ? path.join(homedir, '.misaka') : '')
  if (!root) return { dir: '', writable: false }
  return { dir: path.join(root, DIAGNOSTICS_REL_PATH), writable: true }
}

const SECRETISH = /(token|secret|password|passwd|api[-_]?key|access[-_]?key|authorization|cookie|credential|sk-)/i

/** Records carry identity and timing only; a free-text field is clipped and credential-shaped runs are dropped. */
function safeValue(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null
  if (typeof value === 'boolean' || value === null) return value
  if (typeof value === 'string') {
    const clipped = value.slice(0, MAX_FIELD_CHARS)
    return SECRETISH.test(clipped) ? '[redacted]' : clipped
  }
  return null
}

function safeFields(fields: DiagnosticFields | undefined): DiagnosticFields {
  const out: DiagnosticFields = {}
  if (!fields) return out
  for (const [key, value] of Object.entries(fields)) {
    if (key === 't' || key === 'kind') continue
    if (value === undefined || typeof value === 'function') continue
    out[key] = safeValue(value)
  }
  return out
}

function stamp(now: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
}

interface ExistingFile { name: string, bytes: number, mtimeMs: number }

function listExisting(dir: string): ExistingFile[] {
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return [] }
  const found: ExistingFile[] = []
  for (const name of names) {
    if (!name.startsWith(FILE_PREFIX) || !name.endsWith('.jsonl')) continue
    try {
      const stat = fs.statSync(path.join(dir, name))
      if (stat.isFile()) found.push({ name, bytes: stat.size, mtimeMs: stat.mtimeMs })
    } catch { /* a racing rotation is not worth a stack */ }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

export interface CreateOptions {
  env?: NodeJS.ProcessEnv
  homedir?: string
  now?: () => number
  /** Test seam: replaces the whole file layer. */
  sink?: (lines: string[]) => void
  schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  cancel?: (handle: ReturnType<typeof setTimeout>) => void
}

/**
 * A bounded, append-only record of what the shell saw. It never holds prompt bodies, tool output or
 * keys -- only identities, byte counts, timings and queue depths -- because it has to keep working
 * when the thing it is describing (the renderer, or the Python bridge) is not.
 */
export function createDiagnostics(options: CreateOptions = {}): Diagnostics {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now
  const file = resolveDiagnosticsDir(env, options.homedir ?? '')
  const sink = options.sink
  const schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms))
  const cancel = options.cancel ?? (handle => clearTimeout(handle))
  const buffer: string[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let currentName = ''
  let currentBytes = 0
  let prunedAt = 0

  const startNextFile = () => {
    currentName = `${FILE_PREFIX}${stamp(new Date(now()))}-${process.pid}.jsonl`
    currentBytes = 0
  }

  const prune = () => {
    if (!file.writable || sink) return
    if (now() - prunedAt < 60_000) return
    prunedAt = now()
    const existing = listExisting(file.dir)
    const horizon = now() - RETAIN_DAYS * 24 * 60 * 60 * 1000
    let total = existing.reduce((sum, item) => sum + item.bytes, 0)
    for (const item of existing) {
      const expired = item.mtimeMs < horizon
      // Oldest first: the tail of the buffer is what a live freeze needs, so it is the last to go.
      if (!expired && total <= TOTAL_BYTES) break
      total -= item.bytes
      try { fs.unlinkSync(path.join(file.dir, item.name)) } catch { /* another process may have taken it */ }
    }
  }

  const flush = () => {
    if (timer !== null) { cancel(timer); timer = null }
    if (buffer.length === 0) return
    const lines = buffer.splice(0, buffer.length)
    try {
      if (sink) { sink(lines); return }
    } catch { /* a full or locked disk costs records, never the app */ }
    if (!file.writable) return
    try {
      fs.mkdirSync(file.dir, { recursive: true })
      if (!currentName || currentBytes >= ROTATE_BYTES) { prune(); startNextFile() }
      const chunk = lines.join('\n') + '\n'
      fs.appendFileSync(path.join(file.dir, currentName), chunk, 'utf-8')
      currentBytes += Buffer.byteLength(chunk)
    } catch { /* a diagnostics failure must never break the app it observes */ }
  }

  const push = (line: string) => {
    // Bounded by records, not bytes: a record is small and clipped, and the cap is the point.
    if (buffer.length >= 512) buffer.splice(0, buffer.length - 512)
    buffer.push(line)
    if (buffer.length >= FLUSH_RECORDS) flush()
    else if (timer === null) timer = schedule(flush, 2000)
  }

  const record = (kind: string, fields?: DiagnosticFields) => {
    push(JSON.stringify({ t: now(), kind, ...safeFields(fields) }))
  }

  return {
    file,
    record,
    recordBatch: records => {
      for (const fields of records) {
        const { kind, ...rest } = fields
        if (typeof kind !== 'string' || !kind) continue
        record(kind, rest)
      }
    },
    flush,
    dispose: () => { flush(); if (timer !== null) { cancel(timer); timer = null } },
    buffered: () => buffer.length,
  }
}

/** Identity fields every layer agrees on; a record without them cannot be tied to a stream. */
export function eventIdentity(message: unknown): DiagnosticFields {
  if (!message || typeof message !== 'object') return {}
  const value = message as Record<string, unknown>
  const event = value.event as Record<string, unknown> | undefined
  const out: DiagnosticFields = {}
  for (const key of ['sessionId', 'streamId', 'seq', 'requestId'] as const) {
    if (typeof value[key] === 'string' || typeof value[key] === 'number') out[key] = value[key]
  }
  if (typeof value.type === 'string') out.type = value.type
  if (typeof event?.type === 'string') out.eventType = event.type
  if (typeof event?.toolCallId === 'string') out.toolCallId = event.toolCallId
  return out
}

/**
 * Which artifact is actually running. File times lie across a rebuild and a copy, so the record
 * carries a content hash: two runs are comparable only when the hashes match.
 */
export function collectBuildIdentity(inputs: {
  appVersion?: string
  electron?: string
  chrome?: string
  node?: string
  platform?: string
  files?: Record<string, string>
  devServerUrl?: string
  read?: (file: string) => Buffer
}): DiagnosticFields {
  const out: DiagnosticFields = {
    appVersion: inputs.appVersion ?? null,
    electron: inputs.electron ?? null,
    chrome: inputs.chrome ?? null,
    node: inputs.node ?? null,
    platform: inputs.platform ?? null,
    loadedFrom: inputs.devServerUrl ? 'dev-server' : 'bundled-file',
  }
  const read = inputs.read ?? ((file: string) => fs.readFileSync(file))
  for (const [name, file] of Object.entries(inputs.files ?? {})) {
    let digest: string | null = null
    try { digest = sha1Short(read(file)) } catch { /* an artifact that is missing is itself the finding */ }
    out[name] = digest
  }
  return out
}

function sha1Short(content: Buffer | string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 12)
}
