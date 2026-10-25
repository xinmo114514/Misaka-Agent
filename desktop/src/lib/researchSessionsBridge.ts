import { request } from './bridge'
import { addResearchSink, requestResearch } from './researchBridge'
import { useResearchRunStore } from '../store/useResearchRunStore'
import { useResearchSessionsStore } from '../store/useResearchSessionsStore'
import type { ResearchSessionHistory, ResearchSessionsPayload } from '../types/research'

let active: { runId: string; subscriptionId: string; executorIds: string } | null = null
let watchSequence = 0
let transportStreamId: string | null = null
const historyPending = new Map<string, Promise<ResearchSessionHistory>>()
const historyEpochs = new Map<string, number>()
const listingEpochs = new Map<string, number>()
const retiredStreams = new Set<string>()
function acceptStream(streamId: string | undefined, runId: string): boolean {
  if (!streamId) return true
  if (retiredStreams.has(streamId)) return false
  if (transportStreamId && transportStreamId !== streamId) {
    retiredStreams.add(transportStreamId)
    if (retiredStreams.size > 64) retiredStreams.delete(retiredStreams.values().next().value!)
    useResearchSessionsStore.getState().resetRevisions(runId)
  }
  transportStreamId = streamId
  return true
}
function sessionIdentity(executorId: string): string {
  const state = useResearchSessionsStore.getState().byExecutor[executorId]
  return state ? JSON.stringify([state.runId,state.descriptor.sessionId,state.descriptor.sessionFile,state.descriptor.generation,state.descriptor.attempt]) : ''
}

export const researchSessionsBridge = {
  retain(runId: string, workspace?: string): () => void {
    let disposed = false
    let pending = false
    const connect = async () => {
      if (disposed || pending) return
      pending = true
      try {
        const listing = await researchSessionsBridge.load(runId, workspace)
        if (disposed) return
        if (active?.runId === runId) return
        // App owns observation, including stopped runs and separate new-entry/graph scenes.
        // Tiling may later replace visibility without owning the subscription lifetime.
        const ids = listing.sessions.filter(item => item.role === 'last_order').slice(0, 1).map(item => item.executorId)
        await researchSessionsBridge.watch(runId, ids, workspace)
      } catch {
        // A saved historical run is readable before its native owner is reopened.
        // The next tick reconnects after explicit Resume creates that owner.
      } finally { pending = false }
    }
    void connect()
    const timer = window.setInterval(() => { void connect() }, 1500)
    return () => {
      disposed = true
      window.clearInterval(timer)
      if (active?.runId === runId) void researchSessionsBridge.unwatch().catch(() => {})
    }
  },
  async load(runId: string, workspace?: string) {
    const epoch = (listingEpochs.get(runId) ?? 0) + 1
    listingEpochs.set(runId, epoch)
    const listing = await request<ResearchSessionsPayload>('get_research_sessions', { runId, workspace })
    if (listing?.runId !== runId) throw new Error('研究目录与请求不一致')
    if (listingEpochs.get(runId) !== epoch) return listing
    useResearchRunStore.getState().applyListing(listing)
    useResearchSessionsStore.getState().upsertDescriptors(runId, listing.sessions)
    return listing
  },
  async history(runId: string, executorId: string, workspace?: string, cursor?: string) {
    const identity = sessionIdentity(executorId)
    const expectedVersion = useResearchSessionsStore.getState().byExecutor[executorId]?.historyVersion
    const key = `${runId}:${executorId}:${identity}:${expectedVersion || ''}:${cursor || ''}`
    if (historyPending.has(key)) return historyPending.get(key)!
    const epochKey = `${runId}:${executorId}`
    const epoch = (historyEpochs.get(epochKey) ?? 0) + 1
    historyEpochs.set(epochKey, epoch)
    const loading = request<ResearchSessionHistory>('get_research_session_history', { runId, executorId, workspace, ...(cursor ? { cursor } : {}) })
    historyPending.set(key, loading)
    let page: ResearchSessionHistory
    try { page = await loading } finally { historyPending.delete(key) }
    if (page.runId !== runId || page.executorId !== executorId) throw new Error('研究会话历史归属不一致')
    if (sessionIdentity(executorId) !== identity || historyEpochs.get(epochKey) !== epoch) return page
    useResearchSessionsStore.getState().applyHistory(page, Boolean(cursor))
    return page
  },
  async content(runId: string, executorId: string, entryId: string, field: 'content' | 'result' | 'arguments' | 'error', offset = 0, limit = 8192, workspace?: string) {
    return request<{content: string; nextOffset: number | null; hasMore: boolean}>('get_research_session_content',
      { runId, executorId, entryId, field, offset, limit, workspace })
  },
  async watch(runId: string, visibleExecutorIds: string[], workspace?: string) {
    const ids = [...new Set(visibleExecutorIds)].sort().join('|')
    if (active?.runId === runId && active.executorIds === ids) return
    const seq = ++watchSequence
    if (active) {
      const old = active
      active = null
      await requestResearch('unwatch_research_sessions', { subscriptionId: old.subscriptionId })
    }
    // A newer watch may already own the host's singleton observer while this
    // replacement awaited its old unwatch. Do not replace that newer observer.
    if (seq !== watchSequence || !ids) return
    useResearchSessionsStore.getState().resetRevisions(runId)
    const result = await requestResearch<{subscriptionId: string}>('watch_research_sessions', { runId, visibleExecutorIds: ids.split('|'), workspace })
    if (seq !== watchSequence) {
      await requestResearch('unwatch_research_sessions', { subscriptionId: result.subscriptionId })
      return
    }
    active = { runId, executorIds: ids, subscriptionId: result.subscriptionId }
  },
  async unwatch() {
    ++watchSequence
    const old = active
    active = null
    transportStreamId = null
    if (old) await requestResearch('unwatch_research_sessions', { subscriptionId: old.subscriptionId })
  },
  listen() {
    return addResearchSink(message => {
      if (!('event' in message)) return
      if (message.event.type === 'research_sessions_changed') {
        const listing = message.event.payload as ResearchSessionsPayload
        if (!listing?.runId || !acceptStream(message.streamId, listing.runId)) return
        listingEpochs.set(listing.runId, (listingEpochs.get(listing.runId) ?? 0) + 1)
        useResearchRunStore.getState().applyListing(listing)
        useResearchSessionsStore.getState().upsertDescriptors(listing.runId, listing.sessions)
      } else if (message.event.type === 'research_session_snapshot') {
        const snapshot = message.event.snapshot
        if (!snapshot?.runId || !snapshot?.executorId || (active && active.runId !== snapshot.runId)) return
        if (!acceptStream(message.streamId, snapshot.runId)) return
        useResearchSessionsStore.getState().applySnapshot(snapshot)
      }
    })
  },
}
