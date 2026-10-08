import { beforeEach, describe, expect, it } from 'vitest'
import type { BridgeMessage } from '../../types/global'
import { useSessionStore } from '../useSessionStore'

let sent: any[] = []
let seq = 0
const state = () => useSessionStore.getState()
const last = (type: string) => sent.filter(command => command.type === type).at(-1)!

function emit(event: Record<string, any>, sessionId = 'sess-tree') {
  state().handleBridgeMessage({ seq: ++seq, sessionId, event } as BridgeMessage)
}

function ack(requestId: string, data: any = {}, ok = true) {
  state().handleBridgeMessage({ type: 'ack', requestId, ok, data,
    ...(ok ? {} : { error: data?.error ?? '失败' }) } as BridgeMessage)
}

function payload(leafId = 'a1') {
  return {
    sessionId: 'sess-tree', sessionFile: 'C:/s/sess.jsonl', historyVersion: 'v1', leafId,
    tree: [
      { entry: { type: 'message', id: 'a1', message: { role: 'user', content: [{ type: 'text', text: '第一问' }] } },
        label: null, labelTimestamp: null, children: [
          { entry: { type: 'message', id: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: '第一答' }] } },
            label: null, labelTimestamp: null, children: [] },
        ] },
    ],
    settings: { treeFilterMode: 'no-tools', branchSummarySkipPrompt: false },
  }
}

beforeEach(() => {
  sent = []
  seq = 0
  window.bridge = { send: command => { sent.push(command) }, on: () => () => {} }
  useSessionStore.setState({
    currentSessionId: 'sess-tree', activeSessionId: 'sess-tree', currentSessionPath: 'C:/s/sess.jsonl',
    currentWorkspace: 'C:/s', messages: [], draft: '', retainedEditorText: null, isStreaming: false,
    isSessionLoading: false, isAborting: false, sessionLoadError: null, sessionOperation: null,
    treeOpen: false, treePayload: null, treeLoading: false, treeError: null, treeFilterMode: null,
    treeFilterModeTouched: false, compactOpen: false, compactStatus: { state: 'idle' },
    compactDraft: null, isCompacting: false, labelTimestampsVisible: false, skipSummaryPrompt: false,
  })
})

describe('slash commands', () => {
  it('resolves /tree into an open panel and a tree read, without a prompt', () => {
    state().setDraft('/tree')
    expect(state().runSlashCommand(state().draft)).toBe(true)
    expect(state().treeOpen).toBe(true)
    expect(state().draft).toBe('')
    expect(last('get_session_tree')).toBeTruthy()
    expect(sent.some(command => command.type === 'prompt')).toBe(false)
  })

  it('resolves /compact with instructions into the dialog', () => {
    expect(state().runSlashCommand('/compact 保留实验数据')).toBe(true)
    expect(state().compactOpen).toBe(true)
    expect(state().compactDraft).toBe('保留实验数据')
    expect(sent.some(command => command.type === 'prompt')).toBe(false)
  })

  it('leaves other slash text to the ordinary send path', () => {
    expect(state().runSlashCommand('/unknown thing')).toBe(false)
    expect(state().compactOpen).toBe(false)
    expect(state().treeOpen).toBe(false)
  })
})

describe('session tree state', () => {
  it('adopts the engine tree settings the first time the tree arrives', () => {
    state().fetchSessionTree()
    ack(last('get_session_tree').requestId, payload())
    expect(state().treePayload?.leafId).toBe('a1')
    expect(state().treeFilterMode).toBe('no-tools')
    expect(state().treeLoading).toBe(false)
  })

  it('keeps a filter mode the user already chose', () => {
    state().setTreeFilterMode('user-only')
    expect(last('set_tree_filter_mode').mode).toBe('user-only')
    state().fetchSessionTree()
    ack(last('get_session_tree').requestId, payload())
    expect(state().treeFilterMode).toBe('user-only')
  })

  it('surfaces a failed tree read and lets a retry clear it', () => {
    state().fetchSessionTree()
    ack(last('get_session_tree').requestId, { error: '读取失败' }, false)
    expect(state().treeError).toBe('读取失败')
    state().fetchSessionTree()
    ack(last('get_session_tree').requestId, payload())
    expect(state().treeError).toBeNull()
  })

  it('does not send a label write while an operation is running', () => {
    useSessionStore.setState({ sessionOperation: { requestId: 'op-1', operation: 'navigate_tree', sessionId: 'sess-tree' } })
    state().setEntryLabel('a1', '标签')
    expect(sent.some(command => command.type === 'set_entry_label')).toBe(false)
  })
})

describe('long session operations', () => {
  it('accepts a navigation, then swaps in the projected branch it reports', () => {
    state().navigateTree({ targetId: 'a1', summarize: true })
    const command = last('navigate_tree')
    expect(state().sessionOperation?.operation).toBe('navigate_tree')

    emit({ type: 'session_operation_end', requestId: command.requestId, sessionId: 'sess-tree',
      operation: 'navigate_tree', status: 'done', leafId: 'a1', historyVersion: 'v2',
      editorText: '第一问',
      messages: [{ id: 'm-a1', entryId: 'a1', role: 'user', content: '第一问', timestamp: 1 }] })

    expect(state().sessionOperation).toBeNull()
    expect(state().messages.map(message => message.entryId)).toEqual(['a1'])
    expect(state().sessionHistoryVersion).toBe('v2')
    // The composer was empty, so the returned text goes straight back into the draft.
    expect(state().draft).toBe('第一问')
    expect(state().retainedEditorText).toBeNull()
  })

  it('holds returned text aside instead of overwriting an existing draft', () => {
    state().setDraft('正在写的草稿')
    state().navigateTree({ targetId: 'a1', summarize: false })
    const command = last('navigate_tree')
    emit({ type: 'session_operation_end', requestId: command.requestId, sessionId: 'sess-tree',
      operation: 'navigate_tree', status: 'done', editorText: '第一问', messages: [] })
    expect(state().draft).toBe('正在写的草稿')
    expect(state().retainedEditorText).toBe('第一问')
    expect(state().takeRetainedEditorText()).toBe('第一问')
    expect(state().retainedEditorText).toBeNull()
  })

  it('keeps the previous view when a navigation fails', () => {
    useSessionStore.setState({ messages: [{ id: 'keep', role: 'user', content: '保留', timestamp: 1 }] })
    state().navigateTree({ targetId: 'a1', summarize: false })
    const command = last('navigate_tree')
    emit({ type: 'session_operation_end', requestId: command.requestId, sessionId: 'sess-tree',
      operation: 'navigate_tree', status: 'error', error: '分支摘要失败' })
    expect(state().messages.map(message => message.id)).toEqual(['keep'])
    expect(state().treeError).toBe('分支摘要失败')
    expect(state().sessionOperation).toBeNull()
  })

  it('records the compaction outcome for the dialog', () => {
    state().runCompact('保留实验')
    expect(last('compact_session').customInstructions).toBe('保留实验')
    expect(state().compactStatus.state).toBe('running')
    const command = last('compact_session')
    emit({ type: 'session_operation_end', requestId: command.requestId, sessionId: 'sess-tree',
      operation: 'compact_session', status: 'done' })
    expect(state().compactStatus.state).toBe('done')
    expect(state().sessionOperation).toBeNull()
  })

  it('tracks auto-compaction from the engine events too', () => {
    emit({ type: 'compaction_start', reason: 'overflow' })
    expect(state().isCompacting).toBe(true)
    emit({ type: 'compaction_end', reason: 'overflow', result: { tokensBefore: 10 }, aborted: false })
    expect(state().isCompacting).toBe(false)
    expect(state().compactStatus.state).toBe('done')
  })

  it('refuses to start a second operation while one runs', () => {
    state().navigateTree({ targetId: 'a1', summarize: false })
    state().runCompact(null)
    expect(sent.filter(command => command.type === 'compact_session')).toHaveLength(0)
  })

  it('ignores a terminal event for a session that is no longer current', () => {
    state().navigateTree({ targetId: 'a1', summarize: false })
    const command = last('navigate_tree')
    emit({ type: 'session_operation_end', requestId: command.requestId, sessionId: 'other',
      operation: 'navigate_tree', status: 'done', messages: [] }, 'other')
    expect(state().sessionOperation).toBeNull()
    expect(state().messages).toEqual([])
  })

  it('cancels through the engine, naming the operation', () => {
    state().navigateTree({ targetId: 'a1', summarize: false })
    const command = last('navigate_tree')
    state().cancelSessionOperation()
    expect(last('cancel_session_operation').operationRequestId).toBe(command.requestId)
  })

  it('blocks a prompt while an operation owns the session', () => {
    state().navigateTree({ targetId: 'a1', summarize: false })
    state().sendMessage('你好')
    expect(sent.some(command => command.type === 'prompt')).toBe(false)
  })
})
