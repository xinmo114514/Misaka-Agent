import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResearchSessionDescriptor } from '../types/research'

vi.mock('./bridge', () => ({ request: vi.fn() }))
vi.mock('./researchBridge', () => ({ requestResearch: vi.fn(), addResearchSink: vi.fn(() => () => {}) }))

const descriptor = (workspace = 'A', label = 'root'): ResearchSessionDescriptor => ({ executorId: 'root',
  sessionId: 'root-session', sessionFile: 'root.jsonl', role: 'last_order', nodeId: 'n', taskId: null,
  label, workspace, status: 'running', generation: 1, attempt: 1, startedAt: 1, endedAt: null, error: null })
const listing = (runId = 'r', workspace = 'A', label = 'root') => ({ runId, run: { id: runId }, graph: { nodes: [] },
  sessions: [descriptor(workspace, label)], suspension: null, suspensions: [] })
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

describe('visible session subscription leases', () => {
  let bridge: typeof import('./researchSessionsBridge').researchSessionsBridge
  let read: typeof import('./bridge').request
  let command: typeof import('./researchBridge').requestResearch
  let sessions: typeof import('../store/useResearchSessionsStore').useResearchSessionsStore
  let sink: (message: any) => void
  let observer: { subscriptionId: string; runId: string; ids: string[]; workspace?: string } | null
  let counter: number
  let releases: (() => void)[]
  const own = (release: () => void) => { releases.push(release); return release }
  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    bridge = (await import('./researchSessionsBridge')).researchSessionsBridge
    read = (await import('./bridge')).request
    const transport = await import('./researchBridge')
    command = transport.requestResearch
    sessions = (await import('../store/useResearchSessionsStore')).useResearchSessionsStore
    vi.mocked(read).mockReset().mockImplementation(async (_type, payload: any) => listing(payload.runId, payload.workspace))
    observer = null; counter = 0; releases = []
    vi.mocked(command).mockReset().mockImplementation(async (type, payload: any = {}) => {
      if (type === 'watch_research_sessions') {
        observer = { subscriptionId: `sub-${++counter}`, runId: payload.runId, ids: payload.visibleExecutorIds, workspace: payload.workspace }
        return { subscriptionId: observer.subscriptionId }
      }
      if (type === 'unwatch_research_sessions') {
        if (observer?.subscriptionId === payload.subscriptionId) observer = null
        return { stopped: true }
      }
      throw new Error(`Unexpected command ${type}`)
    })
    vi.mocked(transport.addResearchSink).mockImplementation(handler => { sink = handler; return () => {} })
    bridge.listen()
  })
  afterEach(async () => {
    releases.reverse().forEach(release => release())
    await bridge.unwatch()
    vi.useRealTimers()
  })

  // Removing lease persistence would reconnect root instead of both visible cards.
  it('restores the mounted main and side cards after App retain reattaches', async () => {
    own(bridge.retainVisible('r', ['main', 'side'], 'A'))
    await flush()
    expect(observer).toBeNull()
    const releaseOwner = own(bridge.retain('r', 'A'))
    await flush()
    expect(observer).toMatchObject({ ids: ['main', 'side'] })
    releaseOwner()
    await flush()
    expect(observer).toBeNull()
    own(bridge.retain('r', 'A'))
    await flush()
    expect(observer).toMatchObject({ ids: ['main', 'side'] })
  })

  it('reapplies visible cards when the retained transport stream changes', async () => {
    own(bridge.retain('r', 'A')); own(bridge.retainVisible('r', ['main', 'side'], 'A'))
    await flush()
    const packet = (streamId: string) => ({ streamId, event: { type: 'research_sessions_changed', payload: listing() } })
    sink(packet('host-1')); await flush()
    const firstSubscription = observer?.subscriptionId
    sink(packet('host-2')); await flush()
    expect(observer).toMatchObject({ ids: ['main', 'side'] })
    expect(observer?.subscriptionId).not.toBe(firstSubscription)
  })

  it('keeps replacement host authority across the zero-owner reconnect gap', async () => {
    const first = own(bridge.retain('r', 'A'))
    own(bridge.retainVisible('r', ['main'], 'A')); await flush()
    const packet = (streamId: string, label: string) => ({ streamId,
      event: { type: 'research_sessions_changed', payload: listing('r', 'A', label) } })
    sink(packet('old-host', 'old-initial'))
    first(); own(bridge.retain('r', 'A')); await flush()
    sink(packet('new-host', 'new-current'))
    sink(packet('old-host', 'old-late'))
    sink(packet('new-host', 'new-final')); await flush()
    expect(sessions.getState().byExecutor.root.descriptor.label).toBe('new-final')
    expect(observer).toMatchObject({ ids: ['main'] })
  })

  it('accepts the same legitimate host after its observer temporarily closes', async () => {
    const first = own(bridge.retain('r', 'A')); await flush()
    const packet = (label: string) => ({ streamId: 'same-host',
      event: { type: 'research_sessions_changed', payload: listing('r', 'A', label) } })
    sink(packet('before-close'))
    first(); own(bridge.retain('r', 'A')); await flush()
    sink(packet('after-reopen')); await flush()
    expect(sessions.getState().byExecutor.root.descriptor.label).toBe('after-reopen')
    expect(observer).toMatchObject({ ids: ['root'] })
  })

  it('preserves host ordering when explicit unwatch closes only the observer', async () => {
    own(bridge.retain('r', 'A')); await flush()
    const packet = (streamId: string, label: string) => ({ streamId,
      event: { type: 'research_sessions_changed', payload: listing('r', 'A', label) } })
    sink(packet('old-host', 'before-close'))
    await bridge.unwatch()
    await bridge.watch('r', ['root'], 'A')
    sink(packet('new-host', 'new-current'))
    sink(packet('old-host', 'old-late'))
    sink(packet('new-host', 'new-final')); await flush()
    expect(sessions.getState().byExecutor.root.descriptor.label).toBe('new-final')
  })

  // Removing the owner fence would publish this disposed owner's listing.
  it('ignores a disposed retain load and never starts its observer', async () => {
    const pending = deferred<any>()
    vi.mocked(read).mockReturnValueOnce(pending.promise)
    const release = own(bridge.retain('r', 'A'))
    release()
    pending.resolve(listing())
    await flush()
    expect(observer).toBeNull()
    expect(sessions.getState().byExecutor.root).toBeUndefined()
  })

  it('cleans a pending watch after disposal without reporting a successful lease', async () => {
    const pending = deferred<any>()
    const status = vi.fn()
    vi.mocked(command).mockImplementationOnce(async (_type, payload: any) => {
      await pending.promise
      observer = { subscriptionId: 'late', runId: payload.runId, ids: payload.visibleExecutorIds }
      return { subscriptionId: 'late' }
    })
    const releaseOwner = own(bridge.retain('r', 'A'))
    own(bridge.retainVisible('r', ['main'], 'A', status))
    await flush(); releaseOwner()
    pending.resolve({})
    await flush()
    expect(observer).toBeNull()
    expect(status).not.toHaveBeenCalled()
  })

  it('keeps the newest lease when an older release runs twice', async () => {
    own(bridge.retain('r', 'A'))
    const older = own(bridge.retainVisible('r', ['old'], 'A'))
    own(bridge.retainVisible('r', ['main', 'side'], 'A'))
    await flush()
    older(); older(); await flush()
    expect(observer).toMatchObject({ ids: ['main', 'side'] })
  })

  it('restores the still-mounted lease and then root after the newest mount leaves', async () => {
    own(bridge.retain('r', 'A'))
    const first = own(bridge.retainVisible('r', ['main'], 'A'))
    const second = own(bridge.retainVisible('r', ['main', 'side'], 'A'))
    await flush(); second(); await flush()
    expect(observer).toMatchObject({ ids: ['main'] })
    first(); await flush()
    expect(observer).toMatchObject({ ids: ['root'] })
  })

  it('coalesces identical mounted sets and reports success to the current lease', async () => {
    const firstStatus = vi.fn(), latestStatus = vi.fn()
    own(bridge.retain('r', 'A'))
    own(bridge.retainVisible('r', ['side', 'main'], 'A', firstStatus))
    own(bridge.retainVisible('r', ['main', 'side', 'main'], 'A', latestStatus))
    await flush()
    expect(counter).toBe(1)
    expect(firstStatus).not.toHaveBeenCalled()
    expect(latestStatus).toHaveBeenLastCalledWith(null)
    await vi.advanceTimersByTimeAsync(1500)
    expect(counter).toBe(1)
  })

  it('reports a failed watch and clears only after an explicit retry succeeds', async () => {
    const failure = new Error('transport unavailable'), status = vi.fn()
    const pendingListing = deferred<any>()
    vi.mocked(read).mockReturnValueOnce(pendingListing.promise)
    vi.mocked(command).mockRejectedValueOnce(failure)
    own(bridge.retain('r', 'A')); own(bridge.retainVisible('r', ['main', 'side'], 'A', status))
    await flush()
    expect(status).toHaveBeenLastCalledWith(failure)
    expect(observer).toBeNull()
    await bridge.watch('r', ['main', 'side'], 'A')
    expect(observer).toMatchObject({ ids: ['main', 'side'] })
    expect(status).toHaveBeenLastCalledWith(null)
    pendingListing.resolve(listing()); await flush()
  })

  it('rejects an older mounted reader retry without replacing the newest visible lease', async () => {
    const oldStatus = vi.fn(), latestStatus = vi.fn()
    own(bridge.retain('r', 'A'))
    own(bridge.retainVisible('r', ['older-mount'], 'A', oldStatus))
    own(bridge.retainVisible('r', ['newest-mount'], 'A', latestStatus)); await flush()
    const currentSubscription = observer?.subscriptionId
    oldStatus.mockClear(); latestStatus.mockClear()
    await expect(bridge.watch('r', ['older-mount'], 'A')).rejects.toThrow()
    expect(observer).toMatchObject({ subscriptionId: currentSubscription, ids: ['newest-mount'] })
    expect(oldStatus).not.toHaveBeenCalled()
    expect(latestStatus).not.toHaveBeenCalled()
  })

  it('rejects a retry superseded by a newer lease while its native acknowledgement is pending', async () => {
    const firstFailure = new Error('first watch failed'), ack = deferred<void>(), initialListing = deferred<any>()
    vi.mocked(read).mockReturnValueOnce(initialListing.promise)
    vi.mocked(command).mockRejectedValueOnce(firstFailure)
    own(bridge.retain('r', 'A')); own(bridge.retainVisible('r', ['older-mount'], 'A')); await flush()
    const normalCommand = vi.mocked(command).getMockImplementation()!
    vi.mocked(command).mockImplementationOnce(async (type, payload) => {
      const result = await normalCommand(type, payload)
      await ack.promise
      return result
    })
    const retried = bridge.watch('r', ['older-mount'], 'A')
    // Attach the rejection assertion before releasing the delayed native reply.
    const rejected = expect(retried).rejects.toThrow()
    await flush()
    own(bridge.retainVisible('r', ['newest-mount'], 'A')); await flush()
    ack.resolve(); initialListing.resolve(listing()); await rejected; await flush()
    expect(observer).toMatchObject({ ids: ['newest-mount'] })
  })

  // Dropping workspace from watch identity would leave A observed after switching to B.
  it('uses workspace in subscription identity and fences old workspace listings', async () => {
    const oldListing = deferred<any>()
    vi.mocked(read).mockReturnValueOnce(oldListing.promise)
    const old = own(bridge.retain('r', 'A'))
    own(bridge.retainVisible('r', ['main'], 'A'))
    await flush(); old()
    own(bridge.retain('r', 'B')); own(bridge.retainVisible('r', ['main'], 'B'))
    await flush()
    oldListing.resolve(listing('r', 'A', 'obsolete'))
    await flush()
    expect(observer).toMatchObject({ workspace: 'B', ids: ['main'] })
    expect(sessions.getState().byExecutor.root.descriptor.workspace).toBe('B')
  })

  it('fences old workspace history even when session identity is otherwise identical', async () => {
    sessions.getState().upsertDescriptors('r', [descriptor()])
    const oldHistory = deferred<any>()
    vi.mocked(read).mockReturnValueOnce(oldHistory.promise)
    const reading = bridge.history('r', 'root', 'A')
    sessions.getState().upsertDescriptors('r', [descriptor('B')])
    oldHistory.resolve({ runId: 'r', executorId: 'root', messages: [{ id: 'old', role: 'assistant', content: 'A history', timestamp: 1 }],
      historyVersion: 'v1', nextCursor: null, hasMore: false, availability: 'available' })
    await expect(reading).rejects.toMatchObject({ name: 'ResearchHistoryInvalidatedError', retryable: false })
    expect(sessions.getState().byExecutor.root.messages).toEqual([])
  })

  it('does not deduplicate concurrent history reads from different workspaces', async () => {
    sessions.getState().upsertDescriptors('r', [descriptor()])
    const old = deferred<any>(), latest = deferred<any>()
    vi.mocked(read).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
    const first = bridge.history('r', 'root', 'A'), second = bridge.history('r', 'root', 'B')
    latest.resolve({ runId: 'r', executorId: 'root', messages: [{ id: 'new', role: 'assistant', content: 'B history', timestamp: 1 }],
      historyVersion: 'v1', nextCursor: null, hasMore: false, availability: 'available' })
    await flush()
    old.resolve({ runId: 'r', executorId: 'root', messages: [], historyVersion: 'v1', nextCursor: null, hasMore: false, availability: 'available' })
    await expect(first).rejects.toMatchObject({ name: 'ResearchHistoryInvalidatedError', retryable: false })
    await second
    expect(sessions.getState().byExecutor.root.messages.map(message => message.content)).toEqual(['B history'])
  })

  // A superseded queued connect must not tear down the fallback that replaced it.
  it('keeps the root observer when a visible lease is released before its watch starts', async () => {
    own(bridge.retain('r', 'A')); await flush()
    const visible = own(bridge.retainVisible('r', ['main'], 'A'))
    visible(); await flush()
    expect(observer).toMatchObject({ ids: ['root'] })
  })

  it('starts a fresh watch when the same visible set is reacquired before obsolete work runs', async () => {
    own(bridge.retain('r', 'A')); await flush()
    const visible = own(bridge.retainVisible('r', ['main'], 'A'))
    visible()
    const status = vi.fn()
    own(bridge.retainVisible('r', ['main'], 'A', status)); await flush()
    expect(observer).toMatchObject({ ids: ['main'] })
    expect(status).toHaveBeenLastCalledWith(null)
  })

  it('repairs the latest observer after an old native watch finishes last', async () => {
    const oldWatch = deferred<void>(), oldStatus = vi.fn(), latestStatus = vi.fn()
    vi.mocked(command).mockImplementationOnce(async (_type, payload: any) => {
      await oldWatch.promise
      observer = { subscriptionId: 'obsolete-native-watch', runId: payload.runId, ids: payload.visibleExecutorIds, workspace: payload.workspace }
      return { subscriptionId: observer.subscriptionId }
    })
    own(bridge.retain('r', 'A')); own(bridge.retainVisible('r', ['old'], 'A', oldStatus))
    await flush()
    own(bridge.retainVisible('r', ['main', 'side'], 'A', latestStatus))
    await flush()
    expect(observer).toMatchObject({ ids: ['main', 'side'] })
    oldWatch.resolve(); await flush()
    expect(observer).toMatchObject({ ids: ['main', 'side'] })
    expect(oldStatus).not.toHaveBeenCalled()
    expect(latestStatus).toHaveBeenLastCalledWith(null)
  })

  it.each(['pending', 'resolved', 'rejected'] as const)(
    'restores the native current observer on retry while obsolete acknowledgement is %s', async outcome => {
      const execution = deferred<void>(), ack = deferred<void>()
      const oldStatus = vi.fn(), latestStatus = vi.fn()
      const normalCommand = vi.mocked(command).getMockImplementation()!
      vi.mocked(command).mockImplementationOnce(async (type, payload) => {
        await execution.promise
        const result = await normalCommand(type, payload)
        await ack.promise
        return result
      })
      own(bridge.retain('r', 'A')); own(bridge.retainVisible('r', ['obsolete'], 'A', oldStatus)); await flush()
      own(bridge.retainVisible('r', ['current'], 'A', latestStatus)); await flush()
      expect(observer).toMatchObject({ ids: ['current'] })
      execution.resolve(); await flush()
      expect(observer).toMatchObject({ ids: ['obsolete'] })
      latestStatus.mockClear()
      await bridge.watch('r', ['current'], 'A')
      expect(observer).toMatchObject({ ids: ['current'] })
      expect(latestStatus).toHaveBeenLastCalledWith(null)
      if (outcome === 'resolved') ack.resolve()
      if (outcome === 'rejected') ack.reject(new Error('obsolete acknowledgement lost'))
      await flush()
      expect(observer).toMatchObject({ ids: ['current'] })
      expect(oldStatus).not.toHaveBeenCalled()
    })

  it('does not trust a pending matching watch reply after an obsolete watch executed later', async () => {
    const oldExecution = deferred<void>(), oldAck = deferred<void>(), currentAck = deferred<void>()
    const normalCommand = vi.mocked(command).getMockImplementation()!
    let delayCurrent = true
    vi.mocked(command).mockImplementation(async (type, payload: any) => {
      if (type === 'watch_research_sessions' && payload.visibleExecutorIds[0] === 'obsolete') {
        await oldExecution.promise
        const result = await normalCommand(type, payload)
        await oldAck.promise
        return result
      }
      const result = await normalCommand(type, payload)
      if (type === 'watch_research_sessions' && delayCurrent) {
        delayCurrent = false
        await currentAck.promise
      }
      return result
    })
    own(bridge.retain('r', 'A')); own(bridge.retainVisible('r', ['obsolete'], 'A')); await flush()
    own(bridge.retainVisible('r', ['current'], 'A')); await flush()
    oldExecution.resolve(); await flush()
    expect(observer).toMatchObject({ ids: ['obsolete'] })
    const retry = bridge.watch('r', ['current'], 'A')
    currentAck.resolve(); await retry; await flush()
    expect(observer).toMatchObject({ ids: ['current'] })
    oldAck.resolve(); await flush()
    expect(observer).toMatchObject({ ids: ['current'] })
  })

  it('does not publish an obsolete watch failure to the newest visible lease', async () => {
    const oldWatch = deferred<void>(), oldStatus = vi.fn(), latestStatus = vi.fn()
    vi.mocked(command).mockImplementationOnce(async () => {
      await oldWatch.promise
      throw new Error('obsolete watch failure')
    })
    own(bridge.retain('r', 'A')); own(bridge.retainVisible('r', ['old'], 'A', oldStatus))
    await flush()
    own(bridge.retainVisible('r', ['main'], 'A', latestStatus)); await flush()
    oldWatch.resolve(); await flush()
    expect(oldStatus).not.toHaveBeenCalled()
    expect(latestStatus.mock.calls).toEqual([[null]])
    expect(observer).toMatchObject({ ids: ['main'] })
  })

  it('preserves the latest A observer through rapid A B A switches and a slow old unwatch', async () => {
    own(bridge.retainVisible('r', ['main', 'side'], 'A'))
    own(bridge.retainVisible('r', ['other'], 'B'))
    const first = own(bridge.retain('r', 'A')); await flush()
    const oldUnwatch = deferred<void>()
    const normalCommand = vi.mocked(command).getMockImplementation()!
    vi.mocked(command).mockImplementationOnce(async (type, payload) => {
      await oldUnwatch.promise
      return normalCommand(type, payload)
    })
    first()
    const second = own(bridge.retain('r', 'B')); await flush()
    second()
    own(bridge.retain('r', 'A')); await flush()
    oldUnwatch.resolve(); await flush()
    expect(observer).toMatchObject({ workspace: 'A', ids: ['main', 'side'] })
  })

  it('keeps observing when an older App retain for the same run is released', async () => {
    const first = own(bridge.retain('r', 'A'))
    own(bridge.retain('r', 'A')); own(bridge.retainVisible('r', ['main'], 'A'))
    await flush(); first(); first(); await flush()
    expect(observer).toMatchObject({ ids: ['main'] })
  })

  it('shares a pending visible subscription between concurrent App retains of the same context', async () => {
    const acknowledged = deferred<void>()
    vi.mocked(command).mockImplementationOnce(async (_type, payload: any) => {
      ++counter
      observer = { subscriptionId: 'shared', runId: payload.runId, ids: payload.visibleExecutorIds, workspace: payload.workspace }
      await acknowledged.promise
      return { subscriptionId: 'shared' }
    })
    const first = own(bridge.retain('r', 'A'))
    own(bridge.retainVisible('r', ['main'], 'A')); await flush()
    own(bridge.retain('r', 'A')); await flush()
    acknowledged.resolve(); await flush()
    first(); await flush()
    expect(observer).toMatchObject({ ids: ['main'] })
    expect(counter).toBe(1)
  })

  it('fences pending history across disposal and reacquisition of the same owner identity', async () => {
    const first = own(bridge.retain('r', 'A')); await flush()
    const oldHistory = deferred<any>()
    vi.mocked(read).mockReturnValueOnce(oldHistory.promise)
    const reading = bridge.history('r', 'root', 'A')
    first(); own(bridge.retain('r', 'A')); await flush()
    oldHistory.resolve({ runId: 'r', executorId: 'root', messages: [{ id: 'old', role: 'assistant', content: 'old owner', timestamp: 1 }],
      historyVersion: 'v1', nextCursor: null, hasMore: false, availability: 'available' })
    await expect(reading).rejects.toMatchObject({ name: 'ResearchHistoryInvalidatedError', retryable: true })
    expect(sessions.getState().byExecutor.root.messages).toEqual([])
  })

  it('shares visibility and history ownership across equivalent Windows workspace aliases', async () => {
    own(bridge.retain('r', ' C:/A/ '))
    own(bridge.retainVisible('r', ['main'], 'c:\\a'))
    await flush()
    expect(observer).toMatchObject({ ids: ['main'] })
    await bridge.watch('r', ['main'], 'C:/a/')
    expect(counter).toBe(1)
    vi.mocked(read).mockResolvedValueOnce({ runId: 'r', executorId: 'root', messages: [{ id: 'valid', role: 'assistant', content: 'current history', timestamp: 1 }],
      historyVersion: 'v1', nextCursor: null, hasMore: false, availability: 'available' })
    await bridge.history('r', 'root', 'c:/a')
    expect(sessions.getState().byExecutor.root.messages.map(message => message.content)).toEqual(['current history'])
  })

  it('applies a listing read through an equivalent workspace alias', async () => {
    own(bridge.retain('r', 'C:/A/')); await flush()
    vi.mocked(read).mockResolvedValueOnce(listing('r', 'c:\\a', 'alias listing'))
    await bridge.load('r', 'c:\\a')
    expect(sessions.getState().byExecutor.root.descriptor.label).toBe('alias listing')
  })

  it.each([
    { runId: 'obsolete-run', workspace: 'A' },
    { runId: 'r', workspace: 'B' },
  ])('rejects a listing packet for inactive ownership $runId/$workspace before changing stream authority', async ({ runId, workspace }) => {
    own(bridge.retain('r', 'A')); await flush()
    const packet = (streamId: string, payload: any) => ({ streamId, event: { type: 'research_sessions_changed', payload } })
    sink(packet('current-host', listing('r', 'A', 'first')))
    const obsolete = listing(runId, workspace, 'obsolete')
    sink(packet('old-host', { ...obsolete, run: { ...obsolete.run, workspace } }))
    sink(packet('current-host', listing('r', 'A', 'current')))
    await flush()
    expect(sessions.getState().byExecutor.root.runId).toBe('r')
    expect(sessions.getState().byExecutor.root.descriptor.label).toBe('current')
  })

  it('uses the graph root controller for fallback even when a branch coordinator is listed first', async () => {
    vi.mocked(read).mockResolvedValueOnce({ ...listing(), graph: { nodes: [{ id: 'branch-node', kind: 'alt' }, { id: 'root-node', kind: 'root' }] },
      sessions: [{ ...descriptor(), executorId: 'branch', nodeId: 'branch-node' }, { ...descriptor(), executorId: 'actual-root', nodeId: 'root-node' }] })
    own(bridge.retain('r', 'A')); await flush()
    expect(observer).toMatchObject({ ids: ['actual-root'] })
  })
})
