import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../useSessionStore'

describe('session tree and compact store actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.bridge = { send: vi.fn(), on: () => () => {} }
    useSessionStore.setState({
      currentSessionId: 'session-1',
      currentSessionPath: 'session-1.jsonl',
      isSessionLoading: false,
      sessionLoadError: null,
      sessionOperation: null,
      treeOpen: false,
      compactOpen: false,
      compactDraft: null,
      draft: '',
      retainedEditorText: null,
    })
  })

  it('resolves only exact /tree and /compact commands without sending model prompts', () => {
    const run = useSessionStore.getState().runSlashCommand
    expect(run('/tree')).toBe(true)
    expect(run('/compact custom instruction')).toBe(true)
    expect(run('/compactor')).toBe(false)
    expect(window.bridge.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt' }))
    expect(useSessionStore.getState().compactDraft).toBe('custom instruction')
  })

  it('ignores late operation results from an older session', () => {
    useSessionStore.setState({
      sessionOperation: { requestId: 'op-1', operation: 'navigate_tree', sessionId: 'old-session' },
      currentSessionId: 'new-session',
      messages: [],
    })
    useSessionStore.getState().handleBridgeMessage({
      seq: 1, sessionId: 'old-session',
      event: { type: 'session_operation_end', requestId: 'op-1', operation: 'navigate_tree', status: 'done',
        messages: [{ id: 'stale', role: 'user', content: 'stale', timestamp: 1 }] },
    } as any)
    expect(useSessionStore.getState().messages).toEqual([])
    expect(useSessionStore.getState().sessionOperation).toBeNull()
  })

  it('preserves the engine tree filter setting and refreshes the tree after navigation', () => {
    useSessionStore.setState({ treeOpen: true, sessionOperation: { requestId: 'op-2', operation: 'navigate_tree', sessionId: 'session-1' } })
    useSessionStore.getState().handleBridgeMessage({
      seq: 2, sessionId: 'session-1',
      event: { type: 'session_operation_end', requestId: 'op-2', operation: 'navigate_tree', status: 'done',
        leafId: 'new-leaf', historyVersion: 'v2', messages: [{ id: 'm1', role: 'user', content: 'new', timestamp: 1 }] },
    } as any)
    expect(useSessionStore.getState().messages.map(m => m.content)).toEqual(['new'])
    expect(window.bridge.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'get_session_tree' }))
  })

  it('retains returned user text when the composer already has a draft', () => {
    useSessionStore.setState({ draft: 'keep me', sessionOperation: { requestId: 'op-3', operation: 'navigate_tree', sessionId: 'session-1' } })
    useSessionStore.getState().handleBridgeMessage({
      seq: 3, sessionId: 'session-1',
      event: { type: 'session_operation_end', requestId: 'op-3', operation: 'navigate_tree', status: 'done',
        editorText: 'returned user text', messages: [] },
    } as any)
    expect(useSessionStore.getState().draft).toBe('keep me')
    expect(useSessionStore.getState().retainedEditorText).toBe('returned user text')
  })
})
