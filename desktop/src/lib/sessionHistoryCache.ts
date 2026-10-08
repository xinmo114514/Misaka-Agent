import type { ChatMessage } from '../types/session'

export interface CachedSessionHistory {
  path: string
  sessionId: string
  title: string
  workspace: string
  messages: ChatMessage[]
  historyVersion: string | null
  modified?: string
  fileRevision?: string
}

// Count UTF-16 storage and object overhead conservatively, including compatibility
// projections. Shared objects are counted once; no huge JSON string is allocated.
function memoryBytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === 'string') return value.length * 2 + 24
  if (!value || typeof value !== 'object') return 8
  if (seen.has(value)) return 0
  seen.add(value)
  let bytes = 32
  for (const [key, child] of Object.entries(value)) bytes += key.length * 2 + 16 + memoryBytes(child, seen)
  return bytes
}

export class SessionHistoryCache {
  private entries = new Map<string, { history: CachedSessionHistory; bytes: number }>()
  private bytes = 0
  constructor(private maxEntries = 8, private maxBytes = 32 * 1024 * 1024) {}

  get(path: string): CachedSessionHistory | undefined {
    const entry = this.entries.get(path)
    if (!entry) return undefined
    this.entries.delete(path)
    this.entries.set(path, entry)
    return entry.history
  }

  put(history: CachedSessionHistory): void {
    this.delete(history.path)
    const bytes = memoryBytes(history)
    if (bytes > this.maxBytes) return
    this.entries.set(history.path, { history, bytes })
    this.bytes += bytes
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.delete(this.entries.keys().next().value!)
  }

  delete(path: string): void {
    const entry = this.entries.get(path)
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(path) }
  }

  invalidateChanged(sessions: { path: string; modified: string; fileRevision?: string }[]): void {
    const revisions = new Map(sessions.map(session => [session.path, session]))
    for (const [path, { history }] of this.entries) {
      const revision = revisions.get(path)
      if (!revision || (history.fileRevision ? revision.fileRevision !== history.fileRevision : history.modified && revision.modified !== history.modified)) this.delete(path)
    }
  }

  clear(): void { this.entries.clear(); this.bytes = 0 }
  get size(): number { return this.entries.size }
  get retainedBytes(): number { return this.bytes }
}

export const sessionHistoryCache = new SessionHistoryCache()
