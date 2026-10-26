import { request } from './bridge'
import { addResearchSink, requestResearch } from './researchBridge'
import { useResearchRunStore } from '../store/useResearchRunStore'
import { useResearchSessionsStore } from '../store/useResearchSessionsStore'
import type { ResearchSessionHistory, ResearchSessionsPayload } from '../types/research'

type Context = { runId: string; workspace?: string }
type Owner = Context & { connect: () => Promise<void> }
type VisibleLease = Context & { ids: string[]; onStatus?: (error: unknown | null) => void }
type WatchIntent = Context & { ids: string[]; sequence: number; ownerEpoch: number }
let active: (Context & { subscriptionId: string; executorIds: string }) | null = null
let watchSequence = 0
let ownerEpoch = 0
const owners = new Map<symbol, Owner>()
const visibleLeases = new Map<symbol, VisibleLease>()
const roots = new Map<string, string[]>()
let desiredWatch: WatchIntent | null = null
let pendingWatch: { key: string; intent: WatchIntent; promise: Promise<void> } | null = null
const nativeWatches = new Set<number>()
let observerNeedsRepair = false
let transportStreamId: string | null = null
const historyPending = new Map<string, Promise<ResearchSessionHistory>>()
/** A discarded page is not a successful read. Only a matching live owner may retry it. */
export class ResearchHistoryInvalidatedError extends Error {
  constructor(readonly retryable: boolean) {
    super('研究会话历史读取已失效，请重试')
    this.name = 'ResearchHistoryInvalidatedError'
  }
}
const historyEpochs = new Map<string, number>()
const listingEpochs = new Map<string, number>()
const retiredStreams = new Set<string>()
const canonicalWorkspace = (workspace?: string) => workspace?.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() || null
const contextKey = ({ runId, workspace }: Context) => JSON.stringify([runId, canonicalWorkspace(workspace)])
const normalizedIds = (ids: string[]) => [...new Set(ids)].sort()
const currentOwner = () => [...owners.values()].at(-1)
const currentLease = (context: Context) => [...visibleLeases.values()].filter(lease => contextKey(lease) === contextKey(context)).at(-1)
const intentIsCurrent = (intent: WatchIntent) => desiredWatch === intent && intent.sequence === watchSequence && intent.ownerEpoch === ownerEpoch
function ownerAccepts(runId: string, workspace?: string): boolean {
  const owner = currentOwner()
  return !owner || (owner.runId === runId && (!owner.workspace || !workspace
    || canonicalWorkspace(owner.workspace) === canonicalWorkspace(workspace)))
}
function rootExecutorIds(listing: ResearchSessionsPayload): string[] {
  const root = listing.graph.nodes.find(node => node.kind === 'root')
  const controller = listing.sessions.find(item => item.role === 'last_order' && item.nodeId === root?.id)
    ?? listing.sessions.find(item => item.role === 'last_order')
  return controller ? [controller.executorId] : []
}
function reportStatus(intent: WatchIntent, error: unknown | null) {
  if (!intentIsCurrent(intent)) return
  const lease = currentLease(intent)
  if (lease && JSON.stringify(lease.ids) === JSON.stringify(intent.ids)) lease.onStatus?.(error)
}
function reconcileVisibility() {
  const owner = currentOwner()
  if (!owner) return
  const ids = currentLease(owner)?.ids ?? roots.get(contextKey(owner))
  if (ids) void watchSessions(owner.runId, ids, owner.workspace).catch(() => {})
}
function changeOwner(previous: Owner | undefined) {
  const next = currentOwner()
  if (previous === next) return
  if (previous && next && contextKey(previous) === contextKey(next)) {
    // Concurrent mounts share a context lifetime. Only losing its last owner
    // (or switching context) invalidates a pending native subscription.
    reconcileVisibility()
    void next.connect()
    return
  }
  ++ownerEpoch
  // Invalidates in-flight work even when a disposed owner is immediately replaced
  // with the same run/workspace. Releases never address another owner's token.
  ++watchSequence
  desiredWatch = null
  pendingWatch = null
  if (!next || (active && contextKey(active) !== contextKey(next))) {
    const old = active
    active = null
    if (old) void requestResearch('unwatch_research_sessions', { subscriptionId: old.subscriptionId }).catch(() => {})
  }
  // Observer ownership can close and reopen on the same host. Keep the last
  // accepted stream until an actual replacement packet retires it.
  if (!next) return
  reconcileVisibility()
  void next.connect()
}
function acceptStream(streamId: string | undefined, runId: string): boolean {
  if (!streamId) return true
  if (retiredStreams.has(streamId)) return false
  if (transportStreamId && transportStreamId !== streamId) {
    retiredStreams.add(transportStreamId)
    if (retiredStreams.size > 64) retiredStreams.delete(retiredStreams.values().next().value!)
    useResearchSessionsStore.getState().resetRevisions(runId)
    // A replacement host has no observer, even if the visible ids are unchanged.
    const old = active
    active = null
    ++watchSequence
    desiredWatch = null
    pendingWatch = null
    if (old) void requestResearch('unwatch_research_sessions', { subscriptionId: old.subscriptionId }).catch(() => {})
    reconcileVisibility()
  }
  transportStreamId = streamId
  return true
}
function sessionIdentity(executorId: string): string {
  const state = useResearchSessionsStore.getState().byExecutor[executorId]
  return state ? JSON.stringify([state.runId,canonicalWorkspace(state.descriptor.workspace),state.descriptor.sessionId,state.descriptor.sessionFile,state.descriptor.generation,state.descriptor.attempt]) : ''
}

async function loadListing(runId: string, workspace?: string, isCurrent = () => true) {
  const epoch = (listingEpochs.get(runId) ?? 0) + 1
  listingEpochs.set(runId, epoch)
  const ownership = ownerEpoch
  const listing = await request<ResearchSessionsPayload>('get_research_sessions', { runId, workspace })
  if (listing?.runId !== runId) throw new Error('研究目录与请求不一致')
  const owner = currentOwner()
  if (!isCurrent() || ownerEpoch !== ownership || listingEpochs.get(runId) !== epoch
    || (owner && contextKey(owner) !== contextKey({ runId, workspace }))) return listing
  roots.set(contextKey({ runId, workspace }), rootExecutorIds(listing))
  useResearchRunStore.getState().applyListing(listing)
  useResearchSessionsStore.getState().upsertDescriptors(runId, listing.sessions)
  return listing
}

async function watchSessions(runId: string, visibleExecutorIds: string[], workspace?: string, force = false): Promise<void> {
  const context = { runId, workspace }
  const owner = currentOwner()
  if (owner && contextKey(owner) !== contextKey(context)) return
  const ids = normalizedIds(visibleExecutorIds)
  const key = JSON.stringify([contextKey(context), ids])
  const pending = pendingWatch
  // Coalesce only when this is the sole native watch: an obsolete command can
  // also replace a matching watch whose acknowledgement is still in flight.
  if (!force && pending?.key === key && intentIsCurrent(pending.intent)
    && [...nativeWatches].every(sequence => sequence === pending.intent.sequence)) return pending.promise
  const intent: WatchIntent = { ...context, ids, sequence: ++watchSequence, ownerEpoch }
  desiredWatch = intent
  // A pending obsolete command may already have replaced the native singleton
  // without delivering its acknowledgement. A local handle is not evidence of
  // observation until a fresh matching watch has acknowledged in that case.
  if (!force && !nativeWatches.size && active && contextKey(active) === contextKey(context) && active.executorIds === JSON.stringify(ids)) {
    reportStatus(intent, null)
    return
  }
  let settled = false
  const connect = async () => {
    try {
      if (!intentIsCurrent(intent)) return
      const old = active
      active = null
      if (old) await requestResearch('unwatch_research_sessions', { subscriptionId: old.subscriptionId })
      if (!intentIsCurrent(intent) || !ids.length) return
      useResearchSessionsStore.getState().resetRevisions(runId)
      nativeWatches.add(intent.sequence)
      const result = await requestResearch<{ subscriptionId: string }>('watch_research_sessions', { runId, visibleExecutorIds: ids, workspace })
      if (!intentIsCurrent(intent)) {
        observerNeedsRepair = true
        await requestResearch('unwatch_research_sessions', { subscriptionId: result.subscriptionId })
        return
      }
      active = { runId, workspace, executorIds: JSON.stringify(ids), subscriptionId: result.subscriptionId }
      reportStatus(intent, null)
    } catch (error) {
      reportStatus(intent, error)
      throw error
    } finally {
      settled = true
      nativeWatches.delete(intent.sequence)
      if (pendingWatch?.intent === intent) pendingWatch = null
      // An older native watch can finish after the latest one and replace the
      // host's singleton. Repair once all outstanding watches settle, not once
      // per stale response (which would create an endless replacement chain).
      if (!nativeWatches.size && observerNeedsRepair) {
        observerNeedsRepair = false
        const latest = desiredWatch
        if (latest && intentIsCurrent(latest) && active) {
          void watchSessions(latest.runId, latest.ids, latest.workspace, true).catch(() => {})
        }
      }
    }
  }
  const promise = connect()
  if (!settled) pendingWatch = { key, intent, promise }
  return promise
}

export const researchSessionsBridge = {
  retain(runId: string, workspace?: string): () => void {
    let disposed = false
    let pending = false
    const token = Symbol('session-owner')
    const owner: Owner = { runId, workspace, connect: async () => {
      if (disposed || pending || currentOwner() !== owner) return
      pending = true
      const ownership = ownerEpoch
      const applicable = () => !disposed && currentOwner() === owner && ownership === ownerEpoch
      try {
        await loadListing(runId, workspace, applicable)
        if (applicable()) reconcileVisibility()
      } catch {
        // Saved history is readable before Resume reopens its native owner.
      } finally { pending = false }
    } }
    const previous = currentOwner()
    owners.set(token, owner)
    changeOwner(previous)
    const timer = window.setInterval(() => { void owner.connect() }, 1500)
    return () => {
      if (disposed) return
      disposed = true
      window.clearInterval(timer)
      const previous = currentOwner()
      owners.delete(token)
      changeOwner(previous)
    }
  },
  retainVisible(runId: string, visibleExecutorIds: string[], workspace?: string, onStatus?: (error: unknown | null) => void): () => void {
    const token = Symbol('visible-sessions')
    visibleLeases.set(token, { runId, workspace, ids: normalizedIds(visibleExecutorIds), onStatus })
    reconcileVisibility()
    return () => {
      if (!visibleLeases.delete(token)) return
      reconcileVisibility()
    }
  },
  load(runId: string, workspace?: string) {
    return loadListing(runId, workspace)
  },
  async history(runId: string, executorId: string, workspace?: string, cursor?: string) {
    const identity = sessionIdentity(executorId)
    const ownership = ownerEpoch
    const expectedVersion = useResearchSessionsStore.getState().byExecutor[executorId]?.historyVersion
    const key = JSON.stringify([runId, executorId, canonicalWorkspace(workspace), ownership, identity, expectedVersion, cursor])
    if (historyPending.has(key)) return historyPending.get(key)!
    const epochKey = `${runId}:${executorId}`
    const epoch = (historyEpochs.get(epochKey) ?? 0) + 1
    historyEpochs.set(epochKey, epoch)
    // Share the guarded operation, not just its transport: every reader must
    // observe the same invalidation rather than treating a discarded page as loaded.
    const loading = (async () => {
      try {
        const page = await request<ResearchSessionHistory>('get_research_session_history', { runId, executorId, workspace, ...(cursor ? { cursor } : {}) })
        if (page.runId !== runId || page.executorId !== executorId) throw new Error('研究会话历史归属不一致')
        const owner = currentOwner()
        const identityMatches = sessionIdentity(executorId) === identity
        const ownerMatches = Boolean(owner && contextKey(owner) === contextKey({ runId, workspace }))
        if (ownerEpoch !== ownership || (owner && !ownerMatches)
          || !identityMatches || historyEpochs.get(epochKey) !== epoch) {
          throw new ResearchHistoryInvalidatedError(Boolean(identity && identityMatches && ownerMatches))
        }
        useResearchSessionsStore.getState().applyHistory(page, Boolean(cursor))
        return page
      } finally { historyPending.delete(key) }
    })()
    historyPending.set(key, loading)
    return loading
  },
  async content(runId: string, executorId: string, entryId: string, field: 'content' | 'result' | 'arguments' | 'error', offset = 0, limit = 8192, workspace?: string) {
    return request<{content: string; nextOffset: number | null; hasMore: boolean}>('get_research_session_content',
      { runId, executorId, entryId, field, offset, limit, workspace })
  },
  async watch(runId: string, visibleExecutorIds: string[], workspace?: string) {
    const context = { runId, workspace }
    const ids = JSON.stringify(normalizedIds(visibleExecutorIds))
    const assertCurrentLease = () => {
      const lease = currentLease(currentOwner() ?? context)
      if (lease && (contextKey(lease) !== contextKey(context) || JSON.stringify(lease.ids) !== ids)) {
        throw new Error('研究会话可见订阅已被更新的页面接管')
      }
    }
    assertCurrentLease()
    await watchSessions(runId, visibleExecutorIds, workspace)
    // A still-mounted reader can lose visibility authority while its retry is
    // awaiting native IPC. Do not report that superseded attempt as successful.
    assertCurrentLease()
  },
  async unwatch() {
    ++watchSequence
    desiredWatch = null
    pendingWatch = null
    const old = active
    active = null
    if (old) await requestResearch('unwatch_research_sessions', { subscriptionId: old.subscriptionId })
  },
  listen() {
    return addResearchSink(message => {
      if (!('event' in message)) return
      if (message.event.type === 'research_sessions_changed') {
        const listing = message.event.payload as ResearchSessionsPayload
        if (!listing?.runId || !ownerAccepts(listing.runId, listing.run?.workspace) || !acceptStream(message.streamId, listing.runId)) return
        listingEpochs.set(listing.runId, (listingEpochs.get(listing.runId) ?? 0) + 1)
        useResearchRunStore.getState().applyListing(listing)
        useResearchSessionsStore.getState().upsertDescriptors(listing.runId, listing.sessions)
      } else if (message.event.type === 'research_session_snapshot') {
        const snapshot = message.event.snapshot
        if (!snapshot?.runId || !snapshot?.executorId || !ownerAccepts(snapshot.runId) || (active && active.runId !== snapshot.runId)) return
        if (!acceptStream(message.streamId, snapshot.runId)) return
        useResearchSessionsStore.getState().applySnapshot(snapshot)
      }
    })
  },
}
