import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleIncoming } from '../../lib/bridge'
import { useSessionStore } from '../useSessionStore'

const session = (path: string, name: string) => ({ path, id: path, cwd: 'C:/project', name, created: '2026-10-01', modified: '2026-10-01', messageCount: 1, firstMessage: name })

beforeEach(() => {
  vi.useRealTimers()
  window.bridge = { send: vi.fn(), on: () => () => {} }
  useSessionStore.setState({ currentSessionId: 'one', activeSessionId: 'one', currentSessionPath: 'one.jsonl', currentTitle: 'One', sessions: [session('one.jsonl', 'One'), session('two.jsonl', 'Two')] as any })
})
afterEach(() => vi.restoreAllMocks())

describe('session rename', () => {
  it('waits for the bridge acknowledgement before updating the captured session', async () => {
    const rename = useSessionStore.getState().renameSession('one.jsonl', 'Renamed')
    expect(rename).toBeInstanceOf(Promise)
    const command = vi.mocked(window.bridge.send).mock.calls[0][0] as any
    expect(command).toMatchObject({ type: 'rename_session', path: 'one.jsonl', name: 'Renamed' })
    useSessionStore.setState({ currentSessionId: 'two', activeSessionId: 'two', currentSessionPath: 'two.jsonl', currentTitle: 'Two' })
    handleIncoming({ type: 'ack', requestId: command.requestId, ok: true, data: {} })
    await rename
    expect(useSessionStore.getState().currentTitle).toBe('Two')
    expect(useSessionStore.getState().sessions.map(row => row.name)).toEqual(['Renamed', 'Two'])
    expect(window.bridge.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'list_sessions' }))
  })

  it('keeps existing titles and reports the bridge error when persistence fails', async () => {
    const rename = useSessionStore.getState().renameSession('one.jsonl', 'Renamed')
    const command = vi.mocked(window.bridge.send).mock.calls[0][0] as any
    handleIncoming({ type: 'ack', requestId: command.requestId, ok: false, error: '磁盘错误' })
    await expect(rename).rejects.toThrow('磁盘错误')
    expect(useSessionStore.getState().currentTitle).toBe('One')
    expect(useSessionStore.getState().sessions[0].name).toBe('One')
  })
})
