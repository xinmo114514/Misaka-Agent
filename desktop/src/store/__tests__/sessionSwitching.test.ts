import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../useSessionStore'
import type { BridgeMessage } from '../../types/global'
import { useSettingsStore } from '../useSettingsStore'

let seq = 1000
const message = (content: string) => ({ id: content, role: 'assistant', content, timestamp: 1 })
function command() { return vi.mocked(window.bridge.send).mock.calls.at(-1)![0] as any }
function event(event: any, sessionId = event.sessionId || 'backend') {
  useSessionStore.getState().handleBridgeMessage({ seq: ++seq, sessionId, event })
}
function ready(requestId: string, path: string, content = path) {
  useSessionStore.getState().handleBridgeMessage({ type: 'ack', requestId, ok: true,
    data: { session: { sessionId: path, file: path, cwd: 'C:/project' }, messages: [message(content)], historyVersion: `v-${path}` } } as BridgeMessage)
}
beforeEach(() => {
  vi.useFakeTimers()
  window.bridge = { send: vi.fn(), on: () => () => {} }
  useSessionStore.setState({ currentSessionId: '', currentSessionPath: null, messages: [], isSessionLoading: false, isStreaming: false, lastEventSeq: 0, sessions: [] })
})
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers() })

describe('target history is independent from runtime activation', () => {
  it('shows a correlated preview before readiness and survives the start notification', () => {
    useSessionStore.getState().openSession('preview.jsonl')
    const cmd = command()
    expect(cmd.preview).toBe(true)
    event({ type: 'session_preview', requestId: cmd.requestId, session: { sessionId: 'preview', file: 'preview.jsonl', cwd: 'C:/project' }, messages: [message('可先阅读')], historyVersion: 'v1' })
    expect(useSessionStore.getState().messages[0]?.content).toBe('可先阅读')
    expect(useSessionStore.getState().isSessionLoading).toBe(true)
    event({ type: 'session_started', requestId: cmd.requestId, sessionId: 'preview', file: 'preview.jsonl' }, 'preview')
    expect(useSessionStore.getState().messages[0]?.content).toBe('可先阅读')
    useSessionStore.getState().sendMessage('准备完成前不发送')
    expect(command().type).toBe('load_session')
    useSessionStore.getState().handleBridgeMessage({ type: 'ack', requestId: cmd.requestId, ok: true, data: { session: { sessionId: 'preview', file: 'preview.jsonl' }, historyVersion: 'v1', historyUnchanged: true } })
    expect(useSessionStore.getState().messages[0]?.content).toBe('可先阅读')
    expect(useSessionStore.getState().isSessionLoading).toBe(false)
    expect((useSessionStore.getState() as any).activeSessionId).toBe('preview')
  })

  it('returns to cached history synchronously while backend preparation remains pending', () => {
    useSessionStore.getState().openSession('cached-a.jsonl'); ready(command().requestId, 'cached-a.jsonl', 'A 的内容')
    useSessionStore.getState().openSession('cached-b.jsonl'); ready(command().requestId, 'cached-b.jsonl', 'B 的内容')
    useSessionStore.getState().openSession('cached-a.jsonl')
    expect(useSessionStore.getState().currentSessionPath).toBe('cached-a.jsonl')
    expect(useSessionStore.getState().messages.map(m => m.content)).toEqual(['A 的内容'])
    expect(useSessionStore.getState().isSessionLoading).toBe(true)
    expect((useSessionStore.getState() as any).activeSessionId).toBe('cached-b.jsonl')
  })

  it('rejects stale previews and starts as well as stale ready replies', () => {
    useSessionStore.getState().openSession('stale.jsonl'); const old = command()
    useSessionStore.getState().openSession('latest.jsonl'); const latest = command()
    event({ type: 'session_preview', requestId: latest.requestId, session: { sessionId: 'latest', file: 'latest.jsonl' }, messages: [message('最新')], historyVersion: 'new' })
    event({ type: 'session_preview', requestId: old.requestId, session: { sessionId: 'old', file: 'stale.jsonl' }, messages: [message('旧内容')], historyVersion: 'old' })
    event({ type: 'session_started', requestId: old.requestId, sessionId: 'old', file: 'stale.jsonl' }, 'old')
    ready(old.requestId, 'stale.jsonl')
    expect(useSessionStore.getState().currentSessionPath).toBe('latest.jsonl')
    expect(useSessionStore.getState().messages[0]?.content).toBe('最新')
    expect(useSessionStore.getState().isSessionLoading).toBe(true)
  })

  it('times out without enabling send or losing the preview and permits an explicit retry', () => {
    useSessionStore.getState().openSession('slow.jsonl'); const cmd = command()
    event({ type: 'session_preview', requestId: cmd.requestId, session: { sessionId: 'slow', file: 'slow.jsonl' }, messages: [message('保留历史')], historyVersion: 'v1' })
    vi.advanceTimersByTime(30001)
    const state = useSessionStore.getState() as any
    expect(state.sessionLoadError).toBeTruthy()
    expect(state.messages[0]?.content).toBe('保留历史')
    const calls = vi.mocked(window.bridge.send).mock.calls.length
    state.sendMessage('继续等待')
    state.setPermissionMode('plan')
    expect(vi.mocked(window.bridge.send).mock.calls.length).toBe(calls)
    state.retrySessionLoad()
    expect(command().requestId).not.toBe(cmd.requestId)
    expect((useSessionStore.getState() as any).sessionLoadError).toBeNull()
    expect(useSessionStore.getState().messages[0]?.content).toBe('保留历史')
  })

  it('coalesces duplicate session-list refreshes until the current request completes', () => {
    useSessionStore.getState().fetchSessions(); const cmd = command()
    useSessionStore.getState().fetchSessions(); useSessionStore.getState().fetchSessions()
    expect(vi.mocked(window.bridge.send).mock.calls.filter(([cmd]: any) => cmd.type === 'list_sessions')).toHaveLength(1)
    useSessionStore.getState().handleBridgeMessage({ type: 'ack', requestId: cmd.requestId, ok: true, data: { sessions: [] } })
    vi.advanceTimersByTime(200)
    expect(vi.mocked(window.bridge.send).mock.calls.filter(([cmd]: any) => cmd.type === 'list_sessions')).toHaveLength(2)
  })

  it('blocks model and thinking changes after a session-load error', () => {
    useSessionStore.setState({ isSessionLoading: false, sessionLoadError: '准备失败' })
    useSettingsStore.setState({ modelSwitchPending: false })
    useSettingsStore.getState().setSessionModel('fixture', 'another')
    useSettingsStore.getState().setThinkingLevel('high')
    expect(vi.mocked(window.bridge.send)).not.toHaveBeenCalled()
  })

  it('switches back to agent mode when opening another session from research mode', () => {
    useSessionStore.setState({
      agentMode: 'research',
      researchBinding: { sessionId: 'research-1', sessionFile: 'research.jsonl', workspace: 'C:/project', runId: null },
    })
    useSessionStore.getState().openSession('normal.jsonl')
    expect(useSessionStore.getState().agentMode).toBe('agent')
    expect(command().type).toBe('load_session')
    expect(command().path).toBe('normal.jsonl')
  })

  it('allows switching to currentSessionPath from research mode and resets agent mode', () => {
    useSessionStore.setState({
      currentSessionPath: 'current.jsonl',
      agentMode: 'research',
      researchBinding: { sessionId: 'research-1', sessionFile: 'research.jsonl', workspace: 'C:/project', runId: null },
    })
    useSessionStore.getState().openSession('current.jsonl')
    expect(useSessionStore.getState().agentMode).toBe('agent')
    expect(command().type).toBe('load_session')
    expect(command().path).toBe('current.jsonl')
  })

  it('clears research-local connection errors when leaving for an ordinary session', () => {
    useSessionStore.setState({
      agentMode: 'research',
      researchConnectionError: '旧研究连接错误',
      researchBinding: { sessionId: 'research-1', sessionFile: 'research.jsonl', workspace: 'C:/project', runId: 'run-1' },
    })
    useSessionStore.getState().openSession('normal.jsonl')
    expect(useSessionStore.getState().researchConnectionError).toBeNull()
  })
})
