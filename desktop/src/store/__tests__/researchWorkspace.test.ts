import { beforeEach, describe, expect, it } from 'vitest'
import { useResearchRunStore } from '../useResearchRunStore'
import { useResearchSessionsStore } from '../useResearchSessionsStore'
import { useResearchWorkspaceStore } from '../useResearchWorkspaceStore'
import type { ResearchSessionDescriptor, ResearchSessionTelemetry } from '../../types/research'

const descriptor = (executorId: string, nodeId = 'n1', status = 'running'): ResearchSessionDescriptor => ({
  executorId, sessionId: executorId, sessionFile: null, nodeId, taskId: executorId, role: 'sister',
  label: executorId, workspace: 'C:/work', status, generation: 1, attempt: 1,
  startedAt: 100, endedAt: null, error: null,
})
const liveTelemetry = (): ResearchSessionTelemetry => ({ cwd: 'C:/work', tokens: { input: 100, output: 50, cacheRead: 20, cacheWrite: 2 },
  cost: 1.2, cacheHitRate: 12, contextUsage: { tokens: 900, contextWindow: 1000, percent: 90 },
  model: { provider: 'real', modelId: 'new-model' }, thinkingLevel: 'high', permissionMode: 'bypassPermissions',
  autoCompact: false, compactionCount: 2, subscription: true })

describe('research tile state', () => {
  beforeEach(() => {
    useResearchRunStore.setState({ runs: {} })
    useResearchSessionsStore.setState({ byExecutor: {} })
    useResearchWorkspaceStore.setState({ byRun: {} })
  })
  it('keeps independent transcript, telemetry and preview state by executor, never role', () => {
    const store = useResearchSessionsStore.getState()
    store.upsertDescriptors('r1', [descriptor('a'), descriptor('b')])
    store.applyHistory({ runId: 'r1', executorId: 'a', messages: [{ id: 'ma', role: 'assistant', content: 'A', timestamp: 1 }],
      nextCursor: null, hasMore: false, availability: 'available', historyVersion: 'v1' })
    store.setPreview('b', 'tool-1', 'expanded')
    store.setFold('b', 'tool-1', true)
    expect(useResearchSessionsStore.getState().byExecutor.a.messages[0].content).toBe('A')
    expect(useResearchSessionsStore.getState().byExecutor.b.messages).toEqual([])
    expect(useResearchSessionsStore.getState().byExecutor.a.previews['tool-1']).toBeUndefined()
    expect(useResearchSessionsStore.getState().byExecutor.b.previews['tool-1']).toBe('expanded')
    expect(useResearchSessionsStore.getState().byExecutor.b.folds['tool-1']).toBe(true)
    expect(useResearchSessionsStore.getState().byExecutor.a.folds['tool-1']).toBeUndefined()
  })
  it('rejects stale generation and revision snapshots for one executor', () => {
    const store = useResearchSessionsStore.getState()
    store.upsertDescriptors('r1', [descriptor('a')])
    store.applySnapshot({ runId: 'r1', executorId: 'a', sessionId: 'a', nodeId: 'n1', taskId: 'a', generation: 1,
      attempt: 1, revision: 2, historyVersion: 'v2', streaming: null, telemetry: null, error: 'new', availability: 'available' })
    store.applySnapshot({ runId: 'r1', executorId: 'a', sessionId: 'a', nodeId: 'n1', taskId: 'a', generation: 1,
      attempt: 1, revision: 1, historyVersion: 'v1', streaming: null, telemetry: null, error: 'old', availability: 'available' })
    expect(useResearchSessionsStore.getState().byExecutor.a.error).toBe('new')
  })
  it('keeps loaded history version distinct from a newer observed snapshot and resets revision for a new transport', () => {
    const store = useResearchSessionsStore.getState()
    store.upsertDescriptors('r1', [descriptor('a')])
    store.applyHistory({ runId: 'r1', executorId: 'a', messages: [], nextCursor: null, hasMore: false,
      availability: 'available', historyVersion: 'v1' })
    store.applySnapshot({ runId: 'r1', executorId: 'a', sessionId: 'a', nodeId: 'n1', taskId: 'a', generation: 1,
      attempt: 1, revision: 10, historyVersion: 'v2', streaming: null, telemetry: null, error: null, availability: 'available' })
    expect(useResearchSessionsStore.getState().byExecutor.a.loadedHistoryVersion).toBe('v1')
    expect(useResearchSessionsStore.getState().byExecutor.a.historyVersion).toBe('v2')
    store.resetRevisions('r1')
    expect(useResearchSessionsStore.getState().byExecutor.a.revision).toBe(-1)
  })
  it('appends later pages by identity and replaces history on a fresh first page', () => {
    const store = useResearchSessionsStore.getState()
    store.upsertDescriptors('r1', [descriptor('a')])
    const page = (messages: Array<{id: string; role: 'assistant'; content: string; timestamp: number}>, nextCursor: string | null) =>
      ({ runId: 'r1', executorId: 'a', messages, nextCursor, hasMore: Boolean(nextCursor), availability: 'available' as const, historyVersion: 'v1' })
    store.applyHistory(page([{id:'m1',role:'assistant',content:'one',timestamp:1}], 'cursor'))
    store.applyHistory(page([{id:'m2',role:'assistant',content:'two',timestamp:2}], null), true)
    expect(useResearchSessionsStore.getState().byExecutor.a.messages.map(message => message.id)).toEqual(['m1','m2'])
    store.applyHistory(page([{id:'m3',role:'assistant',content:'fresh',timestamp:3}], null))
    expect(useResearchSessionsStore.getState().byExecutor.a.messages.map(message => message.id)).toEqual(['m3'])
  })
  it('focus pins the selected node without discarding pane reading positions', () => {
    const store = useResearchWorkspaceStore.getState()
    store.selectNode('r1', 'n1')
    store.setReading('r1', 'a', { scrollTop: 270, following: false })
    store.focusExecutor('r1', descriptor('b', 'n2'))
    const run = useResearchWorkspaceStore.getState().byRun.r1
    expect(run.selectedNodeId).toBe('n2')
    expect(run.focusedExecutorId).toBe('b')
    expect(run.pinnedExecutorIds).toContain('b')
    expect(run.reading.a.scrollTop).toBe(270)
  })
  it('selects a focus node and clears only the main reader in one workspace update', () => {
    useResearchWorkspaceStore.setState({ byRun: { r1: {
      selectedNodeId: 'n1', focusedExecutorId: 'a', pinnedExecutorIds: ['a', 'b'],
      reading: { a: { scrollTop: 270, following: false } }, viewMode: 'multi',
      expandedExecutorId: 'b', detailsOpen: true, processOpen: true,
      mainExecutorId: 'a', sideExecutorId: 'b',
    } } })
    const updates: Array<{ selectedNodeId: string | null; mainExecutorId?: string | null }> = []
    const unsubscribe = useResearchWorkspaceStore.subscribe(state => updates.push({
      selectedNodeId: state.byRun.r1.selectedNodeId,
      mainExecutorId: state.byRun.r1.mainExecutorId,
    }))

    try {
      useResearchWorkspaceStore.getState().selectFocusNode('r1', 'n2')
    } finally {
      unsubscribe()
    }

    expect(updates).toEqual([{ selectedNodeId: 'n2', mainExecutorId: null }])
    expect(useResearchWorkspaceStore.getState().byRun.r1).toEqual({
      selectedNodeId: 'n2', focusedExecutorId: 'a', pinnedExecutorIds: ['a', 'b'],
      reading: { a: { scrollTop: 270, following: false } }, viewMode: 'multi',
      expandedExecutorId: 'b', detailsOpen: true, processOpen: true,
      mainExecutorId: null, sideExecutorId: 'b',
    })
  })
  it('keeps six MRU card pins and never spends a card pin on Last Order', () => {
    const store = useResearchWorkspaceStore.getState()
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) store.focusExecutor('r1', descriptor(id))
    store.focusExecutor('r1', { ...descriptor('lo'), role: 'last_order' })
    expect(useResearchWorkspaceStore.getState().byRun.r1.pinnedExecutorIds).toEqual(['g', 'f', 'e', 'd', 'c', 'b'])
    store.focusExecutor('r1', descriptor('c'))
    expect(useResearchWorkspaceStore.getState().byRun.r1.pinnedExecutorIds).toEqual(['c', 'g', 'f', 'e', 'd', 'b'])
  })
  it('rejects history older than the observed native file version', () => {
    const store = useResearchSessionsStore.getState()
    store.upsertDescriptors('r1', [descriptor('a')])
    store.applySnapshot({ runId:'r1',executorId:'a',sessionId:'a',nodeId:'n1',taskId:'a',generation:1,attempt:1,
      revision:2,historyVersion:'200:20',streaming:null,telemetry:null,error:null,availability:'available' })
    store.applyHistory({ runId:'r1',executorId:'a',messages:[{id:'old',role:'assistant',content:'stale',timestamp:1}],
      nextCursor:null,hasMore:false,availability:'available',historyVersion:'100:10' })
    expect(useResearchSessionsStore.getState().byExecutor.a.historyVersion).toBe('200:20')
    expect(useResearchSessionsStore.getState().byExecutor.a.messages).toEqual([])
  })
  it('prepends older native pages ahead of the latest page', () => {
    const store=useResearchSessionsStore.getState();store.upsertDescriptors('r1',[descriptor('a')])
    const base={runId:'r1',executorId:'a',hasMore:false,nextCursor:null,availability:'available' as const,historyVersion:'100:10',direction:'older' as const}
    store.applyHistory({...base,messages:[{id:'latest',role:'assistant',content:'latest',timestamp:2}]})
    store.applyHistory({...base,messages:[{id:'earlier',role:'assistant',content:'earlier',timestamp:1}]},true)
    expect(useResearchSessionsStore.getState().byExecutor.a.messages.map(m=>m.id)).toEqual(['earlier','latest'])
  })
  it('keeps observed runtime settings and live counters when saved history arrives later, while clearing explicit null error', () => {
    const store = useResearchSessionsStore.getState()
    store.upsertDescriptors('r1', [{ ...descriptor('a'), error: 'former quota stop' }])
    const live = { cwd: 'C:/work', tokens: { input: 100, output: 50, cacheRead: 20, cacheWrite: 2 },
      cost: 1.2, cacheHitRate: 12, contextUsage: { tokens: 900, contextWindow: 1000, percent: 90 },
      model: { provider: 'real', modelId: 'm' }, thinkingLevel: 'high', permissionMode: 'bypassPermissions',
      autoCompact: false, compactionCount: 2, subscription: true }
    store.applySnapshot({ runId:'r1',executorId:'a',sessionId:'a',nodeId:'n1',taskId:'a',generation:1,attempt:1,
      revision:1,historyVersion:'v1',streaming:null,telemetry:live,error:'former quota stop',availability:'available' })
    const saved = { ...live, tokens: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
      thinkingLevel: null, permissionMode: null, autoCompact: null, subscription: null }
    store.applyHistory({ runId:'r1',executorId:'a',messages:[],nextCursor:null,hasMore:false,
      availability:'available',historyVersion:'v1',telemetry:saved,error:null })
    const current = useResearchSessionsStore.getState().byExecutor.a
    expect(current.telemetry?.tokens.input).toBe(100)
    expect(current.telemetry?.thinkingLevel).toBe('high')
    expect(current.telemetry?.autoCompact).toBe(false)
    expect(current.telemetry?.subscription).toBe(true)
    expect(current.error).toBeNull()
  })
  it('refreshes saved usage without demoting the observed current model or context, then accepts live null context', () => {
    const store = useResearchSessionsStore.getState()
    store.upsertDescriptors('r1', [descriptor('a')])
    const snapshot = { runId:'r1',executorId:'a',sessionId:'a',nodeId:'n1',taskId:'a',generation:1,attempt:1,
      revision:1,historyVersion:'v1',streaming:null,telemetry:liveTelemetry(),error:null,availability:'available', runtimeSource:'live' as const }
    store.applySnapshot(snapshot)
    const saved = { ...liveTelemetry(), tokens: { input: 150, output: 80, cacheRead: 20, cacheWrite: 2 }, cost: 1.5,
      model: { provider: 'real', modelId: 'old-model' }, contextUsage: { tokens:null,contextWindow:null,percent:null },
      thinkingLevel:null,permissionMode:null,autoCompact:null,subscription:null,compactionCount:3 }
    const page = { runId:'r1',executorId:'a',messages:[],nextCursor:null,hasMore:false,
      availability:'available' as const,historyVersion:'v2',telemetry:saved }
    store.applyHistory(page)
    let current = useResearchSessionsStore.getState().byExecutor.a.telemetry!
    expect(current.tokens.input).toBe(150)
    expect(current.cost).toBe(1.5)
    expect(current.compactionCount).toBe(3)
    expect(current.model?.modelId).toBe('new-model')
    expect(current.contextUsage.tokens).toBe(900)
    store.applySnapshot({ ...snapshot, revision:2, historyVersion:'v2', telemetry: { ...liveTelemetry(), contextUsage: { tokens:null,contextWindow:1000,percent:null } } })
    store.applyHistory(page)
    current = useResearchSessionsStore.getState().byExecutor.a.telemetry!
    expect(current.contextUsage.tokens).toBeNull()
    expect(current.contextUsage.percent).toBeNull()
  })
  it('accepts unknown saved snapshots without carrying runtime facts across a new execution identity', () => {
    const store = useResearchSessionsStore.getState()
    store.upsertDescriptors('r1', [descriptor('a')])
    store.applySnapshot({ runId:'r1',executorId:'a',sessionId:'a',nodeId:'n1',taskId:'a',generation:1,attempt:1,
      revision:1,historyVersion:'v1',streaming:null,telemetry:liveTelemetry(),error:null,availability:'available',runtimeSource:'live' })
    const next = { ...descriptor('a'), sessionId:'new-session', generation:2 }
    store.upsertDescriptors('r1', [next])
    const saved = { ...liveTelemetry(), thinkingLevel:null,permissionMode:null,autoCompact:null,subscription:null }
    store.applySnapshot({ runId:'r1',executorId:'a',sessionId:'new-session',nodeId:'n1',taskId:'a',generation:2,attempt:1,
      revision:1,historyVersion:'v2',streaming:null,telemetry:saved,error:null,availability:'available',runtimeSource:'saved' })
    expect(useResearchSessionsStore.getState().byExecutor.a.telemetry?.subscription).toBeNull()
  })
  it('clears descriptor and snapshot current errors without removing historical transcript evidence', () => {
    const store = useResearchSessionsStore.getState()
    store.upsertDescriptors('r1', [{ ...descriptor('a'), error:'previous quota stop' }])
    store.applyHistory({ runId:'r1',executorId:'a',messages:[{id:'failure',role:'assistant',content:'previous quota stop',timestamp:1}],
      nextCursor:null,hasMore:false,availability:'available',historyVersion:'v1' })
    store.upsertDescriptors('r1', [descriptor('a', 'n1', 'done')])
    expect(useResearchSessionsStore.getState().byExecutor.a.error).toBeNull()
    expect(useResearchSessionsStore.getState().byExecutor.a.messages[0].content).toBe('previous quota stop')
    store.applySnapshot({ runId:'r1',executorId:'a',sessionId:'a',nodeId:'n1',taskId:'a',generation:1,attempt:1,
      revision:1,historyVersion:'v1',streaming:null,telemetry:null,error:null,availability:'available' })
    expect(useResearchSessionsStore.getState().byExecutor.a.error).toBeNull()
  })
})
