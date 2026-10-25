import { create } from 'zustand'
import type { ChatMessage } from '../types/session'
import type { ResearchSessionDescriptor, ResearchSessionHistory, ResearchSessionSnapshot, ResearchSessionTelemetry } from '../types/research'

export interface SessionState {
  runId: string
  descriptor: ResearchSessionDescriptor
  messages: ChatMessage[]
  streaming: ChatMessage | null
  telemetry: ResearchSessionTelemetry | null
  runtimeSource: 'live' | 'saved'
  previews: Record<string, string>
  folds: Record<string, boolean>
  contentOffsets: Record<string, number | null>
  error: string | null
  availability: string
  revision: number
  historyVersion: string | null
  loadedHistoryVersion: string | null
  nextCursor: string | null
  hasMore: boolean
}
interface State {
  byExecutor: Record<string, SessionState>
  upsertDescriptors: (runId: string, descriptors: ResearchSessionDescriptor[]) => void
  applyHistory: (page: ResearchSessionHistory, append?: boolean) => void
  applySnapshot: (snapshot: ResearchSessionSnapshot) => void
  setPreview: (executorId: string, entryId: string, content: string, nextOffset?: number | null) => void
  setFold: (executorId: string, entryId: string, open: boolean) => void
  resetRevisions: (runId: string) => void
}
export function historyVersionPrecedes(incoming: string | null, current: string | null): boolean {
  if (!incoming || !current || incoming === current) return false
  const before = /^(\d+):\d+$/.exec(incoming) ?? /^v(\d+)$/.exec(incoming)
  const after = /^(\d+):\d+$/.exec(current) ?? /^v(\d+)$/.exec(current)
  return Boolean(before && after && BigInt(before[1]) < BigInt(after[1]))
}
function savedTelemetry(incoming: ResearchSessionTelemetry | null | undefined, old: SessionState, sameVersion = false): ResearchSessionTelemetry | null {
  if (!incoming) return old.telemetry
  if (!old.telemetry || old.runtimeSource !== 'live') return incoming
  const observed = old.telemetry
  // A file's last assistant model is not the current runtime model. Live nulls
  // (e.g. context after compaction) are authoritative too, not missing history.
  return { ...(sameVersion ? observed : incoming), model: observed.model, contextUsage: observed.contextUsage,
    thinkingLevel: observed.thinkingLevel, permissionMode: observed.permissionMode,
    autoCompact: observed.autoCompact, subscription: observed.subscription }
}
export const useResearchSessionsStore = create<State>(set => ({
  byExecutor: {},
  upsertDescriptors: (_runId, descriptors) => set(state => {
    const next = { ...state.byExecutor }
    for (const descriptor of descriptors) {
      const existing = next[descriptor.executorId]
      if (existing && existing.descriptor.generation > descriptor.generation) continue
      const old = existing && existing.runId === _runId && existing.descriptor.generation === descriptor.generation
        && existing.descriptor.attempt === descriptor.attempt && existing.descriptor.sessionId === descriptor.sessionId
        && existing.descriptor.sessionFile === descriptor.sessionFile ? existing : undefined
      next[descriptor.executorId] = old && old.descriptor.generation > descriptor.generation ? old : old
        ? { ...old, descriptor, telemetry: savedTelemetry(descriptor.telemetry, old), error: descriptor.error }
        : { runId: _runId, descriptor, messages: [], streaming: null, telemetry: descriptor.telemetry ?? null, runtimeSource: 'saved', previews: {}, folds: {}, contentOffsets: {},
          error: descriptor.error, availability: descriptor.sessionId ? 'available' : 'not_started',
          revision: -1, historyVersion: null, loadedHistoryVersion: null, nextCursor: null, hasMore: false }
    }
    return { byExecutor: next }
  }),
  applyHistory: (page, append = false) => set(state => {
    const old = state.byExecutor[page.executorId]
    if (!old || old.runId !== page.runId) return state
    if (historyVersionPrecedes(page.historyVersion, old.historyVersion)) return state
    const older = page.direction === 'older'
    const overlap = older && old.messages.some(message => page.messages.some(next => (next.entryId || next.id) === (message.entryId || message.id)))
    const merging = !page.reset && (append || overlap)
    const messages = merging ? append && older ? [...page.messages, ...old.messages] : [...old.messages, ...page.messages] : page.messages
    const unique = Array.from(new Map(messages.map(message => [message.entryId || message.id, message])).values())
    const preserveCursor = older && overlap && !append && !page.reset
    const nextCursor = preserveCursor && old.nextCursor
      ? `${page.historyVersion}@${old.nextCursor.split('@').at(-1)}` : preserveCursor ? null : page.nextCursor
    return { byExecutor: { ...state.byExecutor, [page.executorId]: { ...old,
      messages: page.availability === 'interrupted' && !page.messages.length ? old.messages : unique,
      nextCursor, hasMore: preserveCursor ? old.hasMore : page.hasMore, historyVersion: page.historyVersion, loadedHistoryVersion: page.historyVersion,
      telemetry: savedTelemetry(page.telemetry, old, page.historyVersion === old.historyVersion),
      error: page.error === undefined ? old.error : page.error, availability: page.availability,
    } } }
  }),
  applySnapshot: snapshot => set(state => {
    const old = state.byExecutor[snapshot.executorId]
    if (!old || old.runId !== snapshot.runId || old.descriptor.generation !== snapshot.generation || old.descriptor.sessionId !== snapshot.sessionId || old.descriptor.attempt !== snapshot.attempt || old.revision >= snapshot.revision) return state
    const source = snapshot.runtimeSource ?? 'live'
    return { byExecutor: { ...state.byExecutor, [snapshot.executorId]: { ...old,
      revision: snapshot.revision, streaming: snapshot.streaming,
      telemetry: source === 'live' ? snapshot.telemetry ?? old.telemetry : savedTelemetry(snapshot.telemetry, old),
      runtimeSource: snapshot.telemetry && source === 'live' ? 'live' : old.runtimeSource,
      error: snapshot.error, availability: snapshot.availability, historyVersion: snapshot.historyVersion,
    } } }
  }),
  setPreview: (executorId, entryId, content, nextOffset) => set(state => {
    const old = state.byExecutor[executorId]
    return old ? { byExecutor: { ...state.byExecutor, [executorId]: { ...old, previews: { ...old.previews, [entryId]: content },
      ...(nextOffset !== undefined ? { contentOffsets: { ...old.contentOffsets, [entryId]: nextOffset } } : {}) } } } : state
  }),
  setFold: (executorId, entryId, open) => set(state => {
    const old = state.byExecutor[executorId]
    return old ? { byExecutor: { ...state.byExecutor, [executorId]: { ...old, folds: { ...old.folds, [entryId]: open } } } } : state
  }),
  resetRevisions: runId => set(state => ({ byExecutor: Object.fromEntries(Object.entries(state.byExecutor).map(([id, session]) =>
    [id, session.runId === runId ? { ...session, revision: -1, streaming: null } : session])) })),
}))
