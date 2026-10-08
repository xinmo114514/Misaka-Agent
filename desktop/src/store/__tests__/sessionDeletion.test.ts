import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addSink, handleIncoming, installBridge } from '../../lib/bridge'
import { useSessionStore } from '../useSessionStore'

const rows = [{ id: 'active', path: 'C:/project/active.jsonl', cwd: 'C:/project', name: '活动会话',
  firstMessage: '', created: '2026-10-05', modified: '2026-10-06', messageCount: 2 }]

beforeEach(() => {
  vi.useFakeTimers()
  window.bridge = { send: vi.fn(), on: () => () => {} }
  useSessionStore.setState({ sessions: rows, projects: [], currentSessionId: 'active', activeSessionId: 'active',
    currentSessionPath: rows[0].path, activeSessionPath: rows[0].path, currentTitle: rows[0].name,
    currentWorkspace: 'C:/project', messages: [], isStreaming: false, isAborting: false,
    isSessionLoading: false, isCompacting: false, sessionOperation: null, sessionDeletion: null,
    lastDeletedSessionPath: null, lastEventSeq: 0 })
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function connectStore() {
  const stop = addSink(useSessionStore.getState().handleBridgeMessage)
  const dispose = installBridge()
  return () => { stop(); dispose() }
}

describe('session deletion acknowledgements', () => {
  it('keeps the row until the backend confirms deletion, then refreshes immediately', async () => {
    const disconnect = connectStore()
    useSessionStore.getState().requestSessionDeletion(rows[0].path)
    const deletion = useSessionStore.getState().confirmSessionDeletion()
    const command = vi.mocked(window.bridge.send).mock.calls[0][0] as any

    expect(command).toMatchObject({ type: 'delete_session', path: rows[0].path })
    expect(useSessionStore.getState().sessions).toEqual(rows)
    handleIncoming({ type: 'ack', requestId: command.requestId, ok: true,
      data: { path: rows[0].path } })
    await deletion

    expect(useSessionStore.getState().sessions).toEqual([])
    expect(useSessionStore.getState().sessionDeletion).toBeNull()
    expect(vi.mocked(window.bridge.send).mock.calls.at(-1)?.[0]).toMatchObject({ type: 'list_sessions' })
    disconnect()
  })

  it('does not let an already-running session-list response restore a deleted row', async () => {
    const disconnect = connectStore()
    useSessionStore.getState().fetchSessions()
    const staleListRequest = vi.mocked(window.bridge.send).mock.calls[0][0] as any
    useSessionStore.getState().requestSessionDeletion(rows[0].path)
    const deletion = useSessionStore.getState().confirmSessionDeletion()
    const deleteRequest = vi.mocked(window.bridge.send).mock.calls[1][0] as any
    handleIncoming({ type: 'ack', requestId: deleteRequest.requestId, ok: true, data: { path: rows[0].path } })
    await deletion

    handleIncoming({ type: 'ack', requestId: staleListRequest.requestId, ok: true, data: { sessions: rows } })
    expect(useSessionStore.getState().sessions).toEqual([])
    vi.advanceTimersByTime(101)
    const refresh = vi.mocked(window.bridge.send).mock.calls.at(-1)![0] as any
    expect(refresh.type).toBe('list_sessions')
    handleIncoming({ type: 'ack', requestId: refresh.requestId, ok: true, data: { sessions: [] } })
    expect(useSessionStore.getState().sessions).toEqual([])
    disconnect()
  })

  it('shows a bridge error and retains the session when deletion is rejected', async () => {
    const disconnect = connectStore()
    useSessionStore.getState().requestSessionDeletion(rows[0].path)
    const deletion = useSessionStore.getState().confirmSessionDeletion()
    const command = vi.mocked(window.bridge.send).mock.calls[0][0] as any
    handleIncoming({ type: 'ack', requestId: command.requestId, ok: false, error: '文件仍被占用' })
    await deletion

    expect(useSessionStore.getState().sessions).toEqual(rows)
    expect(useSessionStore.getState().sessionDeletion).toMatchObject({ status: 'error', error: '文件仍被占用' })
    disconnect()
  })

  it('tracks the replacement session if active deletion replaces it before unlink fails', async () => {
    const disconnect = connectStore()
    useSessionStore.getState().requestSessionDeletion(rows[0].path)
    const deletion = useSessionStore.getState().confirmSessionDeletion()
    const command = vi.mocked(window.bridge.send).mock.calls[0][0] as any
    handleIncoming({ seq: 1, sessionId: 'fresh-id', event: { type: 'session_started', requestId: command.requestId,
      sessionId: 'fresh-id', file: 'C:/project/fresh.jsonl', cwd: 'C:/project', name: null } })
    handleIncoming({ type: 'ack', requestId: command.requestId, ok: false, error: '文件删除失败' })
    await deletion

    expect(useSessionStore.getState().currentSessionPath).toBe('C:/project/fresh.jsonl')
    expect(useSessionStore.getState().messages).toEqual([])
    expect(useSessionStore.getState().sessions).toEqual(rows)
    expect(useSessionStore.getState().sessionDeletion).toMatchObject({ status: 'error', error: '文件删除失败' })
    disconnect()
  })

  it('prevents repeat confirmation while one request is pending and times out visibly', async () => {
    const disconnect = connectStore()
    useSessionStore.getState().requestSessionDeletion(rows[0].path)
    const deletion = useSessionStore.getState().confirmSessionDeletion()
    const repeat = useSessionStore.getState().confirmSessionDeletion()
    expect(vi.mocked(window.bridge.send).mock.calls.filter(([command]: any) => command.type === 'delete_session')).toHaveLength(1)
    vi.advanceTimersByTime(20001)
    await deletion
    await repeat
    expect(useSessionStore.getState().sessionDeletion).toMatchObject({ status: 'error' })
    disconnect()
  })

  it('accepts a late successful acknowledgement after timeout and follows its replacement event', async () => {
    const disconnect = connectStore()
    useSessionStore.getState().requestSessionDeletion(rows[0].path)
    const deletion = useSessionStore.getState().confirmSessionDeletion()
    const command = vi.mocked(window.bridge.send).mock.calls[0][0] as any
    vi.advanceTimersByTime(20001)
    await deletion
    expect(useSessionStore.getState().sessionDeletion).toMatchObject({ status: 'error' })

    handleIncoming({ seq: 1, sessionId: 'fresh-id', event: { type: 'session_started', requestId: command.requestId,
      sessionId: 'fresh-id', file: 'C:/project/fresh.jsonl', cwd: 'C:/project', name: null } })
    handleIncoming({ type: 'ack', requestId: command.requestId, ok: true,
      data: { path: rows[0].path, session: { file: 'C:/project/fresh.jsonl' } } })

    expect(useSessionStore.getState().currentSessionPath).toBe('C:/project/fresh.jsonl')
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(useSessionStore.getState().sessionDeletion).toBeNull()
    expect(useSessionStore.getState().lastDeletedSessionPath).toBe(rows[0].path)
    disconnect()
  })

  it('does not submit active deletion while the current task is busy', async () => {
    const disconnect = connectStore()
    useSessionStore.setState({ isStreaming: true })
    useSessionStore.getState().requestSessionDeletion(rows[0].path)
    await useSessionStore.getState().confirmSessionDeletion()
    expect(vi.mocked(window.bridge.send)).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessionDeletion).toMatchObject({ status: 'error' })
    disconnect()
  })
})
