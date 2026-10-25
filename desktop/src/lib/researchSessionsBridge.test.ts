import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useResearchSessionsStore } from '../store/useResearchSessionsStore'
import { useResearchRunStore } from '../store/useResearchRunStore'
import { researchSessionsBridge } from './researchSessionsBridge'
import { request } from './bridge'
import { requestResearch, addResearchSink } from './researchBridge'

vi.mock('./bridge', () => ({ request: vi.fn() }))
vi.mock('./researchBridge', () => ({ requestResearch: vi.fn(), addResearchSink: vi.fn(() => () => {}) }))
describe('session bridge', () => {
  beforeEach(async () => {
    vi.mocked(requestResearch).mockResolvedValue({ stopped: true })
    await researchSessionsBridge.unwatch()
    vi.clearAllMocks(); useResearchSessionsStore.setState({ byExecutor: {} }); useResearchRunStore.setState({ runs: {} })
  })
  it('lists through ordinary read bridge and subscribes only visible executors on research owner', async () => {
    vi.mocked(request).mockResolvedValueOnce({ runId: 'r', run: { id: 'r' }, graph: { nodes: [] }, sessions: [], suspension: null, suspensions: [] })
    vi.mocked(requestResearch).mockResolvedValueOnce({ subscriptionId: 'sub1', runId: 'r' }).mockResolvedValueOnce({ stopped: true })
      .mockResolvedValueOnce({ subscriptionId: 'sub2', runId: 'r' })
    await researchSessionsBridge.load('r', 'C:/work')
    expect(useResearchRunStore.getState().runs.r.run.id).toBe('r')
    await researchSessionsBridge.watch('r', ['a'], 'C:/work')
    await researchSessionsBridge.watch('r', ['b'], 'C:/work')
    expect(vi.mocked(requestResearch).mock.calls.map(call => call[0])).toEqual(['watch_research_sessions', 'unwatch_research_sessions', 'watch_research_sessions'])
    expect(vi.mocked(requestResearch).mock.calls[2][1]).toMatchObject({ visibleExecutorIds: ['b'], workspace: 'C:/work' })
  })
  it('preserves the newest server observer when an older replacement resumes after deferred unwatch', async () => {
    let serverObserver: string | null = null
    let finishUnwatchA!: (value: { stopped: boolean }) => void
    const unwatchA = new Promise<{ stopped: boolean }>(resolve => { finishUnwatchA = resolve })
    vi.mocked(requestResearch).mockImplementation(async (type, payload = {}) => {
      if (type === 'watch_research_sessions') {
        // The native host owns one observer: every new watch replaces its predecessor.
        const subscriptionId = `sub-${(payload.visibleExecutorIds as string[]).join('-')}`
        serverObserver = subscriptionId
        return { subscriptionId, runId: 'r' }
      }
      if (type === 'unwatch_research_sessions') {
        if (serverObserver === payload.subscriptionId) serverObserver = null
        if (payload.subscriptionId === 'sub-a') return unwatchA
        return { stopped: true }
      }
      throw new Error(`Unexpected command: ${type}`)
    })
    await researchSessionsBridge.watch('r', ['a'], 'C:/work')
    const replacingWithB = researchSessionsBridge.watch('r', ['b'], 'C:/work')
    await researchSessionsBridge.watch('r', ['c'], 'C:/work')
    expect(serverObserver).toBe('sub-c')
    finishUnwatchA({ stopped: true })
    await replacingWithB
    expect(serverObserver).toBe('sub-c')
    // The bridge must still address that real observer, not a stale local-only handle.
    await researchSessionsBridge.unwatch()
    expect(serverObserver).toBeNull()
  })
  it('keeps a stopped owning run observed so explicit resume can update its banner', async () => {
    const descriptor = { executorId: 'lo', sessionId: 'root', role: 'last_order', nodeId: 'node', taskId: null,
      label: 'Last Order', workspace: 'C:/work', status: 'stopped', generation: 0, attempt: 0, startedAt: 1, endedAt: null, error: null, sessionFile: null }
    vi.mocked(request).mockResolvedValue({ runId: 'stopped-run', run: { id: 'stopped-run', status: 'stopped' },
      graph: { nodes: [] }, sessions: [descriptor], suspension: null, suspensions: [] })
    vi.mocked(requestResearch).mockResolvedValue({ subscriptionId: 'retained', runId: 'stopped-run' })
    const release = researchSessionsBridge.retain('stopped-run', 'C:/work')
    await vi.waitFor(() => expect(useResearchSessionsStore.getState().byExecutor.lo?.descriptor.status).toBe('stopped'))
    await vi.waitFor(() => expect(vi.mocked(requestResearch).mock.calls.some(call => call[0] === 'watch_research_sessions')).toBe(true))
    release()
  })
  it('does not apply an old history response after the descriptor changes generation', async () => {
    const descriptor={executorId:'e',sessionId:'old',sessionFile:'old.jsonl',role:'sister' as const,nodeId:'n',taskId:'t',label:'card',workspace:'C:/work',status:'running',generation:1,attempt:1,startedAt:1,endedAt:null,error:null}
    useResearchSessionsStore.getState().upsertDescriptors('r',[descriptor])
    let finish!: (value: any)=>void
    vi.mocked(request).mockReturnValueOnce(new Promise(resolve=>{finish=resolve}))
    const reading=researchSessionsBridge.history('r','e','C:/work')
    useResearchSessionsStore.getState().upsertDescriptors('r',[{...descriptor,sessionId:'new',generation:2}])
    finish({runId:'r',executorId:'e',messages:[{id:'old-row',role:'assistant',content:'old generation',timestamp:1}],historyVersion:'v1',nextCursor:null,hasMore:false,availability:'available'})
    await reading
    expect(useResearchSessionsStore.getState().byExecutor.e.messages).toEqual([])
  })
  it('rejects packets from a retired host stream after reconnect', () => {
    const descriptor={executorId:'stream-card',sessionId:'card-sid',sessionFile:'file',nodeId:'n',taskId:'t',role:'sister' as const,label:'card',workspace:'C:/work',status:'running',generation:1,attempt:1,startedAt:1,endedAt:null,error:null}
    useResearchSessionsStore.getState().upsertDescriptors('r',[descriptor])
    let accept!: (message:any)=>void
    vi.mocked(addResearchSink).mockImplementationOnce(handler=>{accept=handler;return()=>{}})
    const stop=researchSessionsBridge.listen()
    const snapshot={runId:'r',executorId:'stream-card',sessionId:'card-sid',nodeId:'n',taskId:'t',generation:1,attempt:1,revision:1,historyVersion:'v1',streaming:null,telemetry:null,error:'initial',availability:'available'}
    accept({sessionId:'root',seq:1,streamId:'old-host',event:{type:'research_session_snapshot',snapshot}})
    accept({sessionId:'root',seq:1,streamId:'new-host',event:{type:'research_session_snapshot',snapshot:{...snapshot,error:'new authority'}}})
    accept({sessionId:'root',seq:99,streamId:'old-host',event:{type:'research_session_snapshot',snapshot:{...snapshot,revision:99,error:'retired packet'}}})
    expect(useResearchSessionsStore.getState().byExecutor['stream-card'].error).toBe('new authority')
    stop()
  })
})
