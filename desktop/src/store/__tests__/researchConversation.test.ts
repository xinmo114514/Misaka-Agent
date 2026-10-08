import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../useSessionStore'
import type { BridgeEventEnvelope } from '../../types/global'

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  enabled: true, session: { sessionId: 'research-session', file: '/research.jsonl', cwd: '/workspace' },
  messages: [], historyVersion: 'v1', lastEventSeq: 10, run: null, stats: {}, contextUsage: {}, ...overrides,
})
const event = (seq: number, type: string, extra: Record<string, unknown> = {}, sessionId = 'research-session'): BridgeEventEnvelope => ({ seq, sessionId, event: { type, ...extra } })
const notice = (seq: number, customType: string, details: Record<string, unknown>, content = '') => event(seq, 'message_end', { message: { role: 'custom', customType, details, content, timestamp: seq * 100 } })

beforeEach(() => {
  window.bridge = { send: vi.fn(), on: () => () => {} }
  useSessionStore.setState({ currentSessionId: 'ordinary', messages: [{ id: 'ordinary-user', role: 'user', content: 'ordinary question', timestamp: 1 }],
    isStreaming: false, isAborting: false, isSessionLoading: false, lastEventSeq: 0, researchCards: {}, researchBinding: null,
    researchConnectionError: null, researchConversation: { currentSessionId: '', messages: [], isStreaming: false, isAborting: false, streamingMessageId: null, lastEventSeq: 0 } })
})

describe('isolated continuous research conversation', () => {
  it('binds genuine host history without touching ordinary session or loading state', () => {
    const ordinary = useSessionStore.getState().messages
    useSessionStore.setState({ isSessionLoading: true })
    useSessionStore.getState().bindResearchConversation(snapshot({ messages: [{ id: 'persisted', entryId: 'entry-1', role: 'assistant', content: '真实历史', timestamp: 2 }] }))
    const state = useSessionStore.getState()
    expect(state.researchBinding).toEqual({ sessionId: 'research-session', sessionFile: '/research.jsonl', workspace: '/workspace', runId: null })
    expect(state.researchConversation.messages[0]).toMatchObject({ id: 'persisted', entryId: 'entry-1', content: '真实历史' })
    expect(state.messages).toBe(ordinary)
    expect(state.currentSessionId).toBe('ordinary')
    expect(state.isSessionLoading).toBe(true)
  })

  it('gates research events by session and sequence before updating messages or run cards', () => {
    useSessionStore.getState().bindResearchConversation(snapshot())
    const handle = useSessionStore.getState().handleResearchBridgeMessage
    handle(event(11, 'agent_start', {}, 'ordinary'))
    handle(event(11, 'agent_start'))
    handle(event(12, 'message_start', { message: { role: 'assistant', timestamp: 3 } }))
    const delta = event(13, 'message_update', { assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '真实' } })
    handle(delta); handle(delta)
    handle(event(12, 'message_update', { assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '旧' } }))
    handle(notice(10, 'research-discipline', { run_id: 'stale-run' }))
    const state = useSessionStore.getState()
    expect(state.researchConversation.messages[0].content).toBe('真实')
    expect(state.researchConversation.lastEventSeq).toBe(13)
    expect(state.researchCards).toEqual({})
    expect(state.isStreaming).toBe(false)
    expect(state.messages).toHaveLength(1)
  })

  it('keeps accepted optimistic text pending until the authoritative initial question and attaches it to one run', () => {
    useSessionStore.getState().bindResearchConversation(snapshot())
    const actions = useSessionStore.getState()
    actions.queueResearchMessage('req1', '真实问题')
    actions.acceptResearchMessage('req1')
    expect(useSessionStore.getState().researchConversation.messages[0]).toMatchObject({ content: '真实问题', optimistic: true, deliveryStatus: 'accepted' })
    expect(useSessionStore.getState().researchBinding?.runId).toBeNull()
    actions.handleResearchBridgeMessage(notice(11, 'research-question', { question: '真实问题' }, 'Research question | 真实问题'))
    actions.handleResearchBridgeMessage(notice(12, 'research-discipline', { run_id: 'run1' }))
    actions.handleResearchBridgeMessage(notice(13, 'research-progress', { run_id: 'run1', stage: 'planning' }))
    const state = useSessionStore.getState()
    expect(state.researchConversation.messages.filter(m => m.role === 'user')).toHaveLength(1)
    expect(state.researchConversation.messages[0]).toMatchObject({ content: '真实问题', optimistic: false, deliveryStatus: 'created' })
    expect(state.researchBinding?.runId).toBe('run1')
    expect(Object.keys(state.researchCards)).toEqual(['run1'])
    expect(state.researchCards.run1.question).toBe('真实问题')
    expect(state.researchCards.run1.workspace).toBe('/workspace')
  })

  it('projects a question without a timestamp and links its persisted entry to the optimistic row', () => {
    useSessionStore.getState().bindResearchConversation(snapshot())
    const actions = useSessionStore.getState()
    actions.queueResearchMessage('req1', '问题')
    actions.handleResearchBridgeMessage(event(11, 'message_end', { message: { role: 'custom', customType: 'research-question', details: { question: '问题' }, content: 'Research question | 问题' } }))
    const row = useSessionStore.getState().researchConversation.messages[0]
    actions.handleResearchBridgeMessage(event(12, 'entry_appended', { entry: { type: 'message', id: 'persisted-question', message: { role: 'custom', customType: 'research-question', details: { question: '问题' }, timestamp: row.timestamp } } }))
    actions.handleResearchBridgeMessage(notice(13, 'research-discipline', { run_id: 'run1' }))
    expect(useSessionStore.getState().researchConversation.messages[0]).toMatchObject({ id: 'research-user-req1', customType: 'research-question', entryId: 'persisted-question' })
    expect(useSessionStore.getState().researchCards.run1.question).toBe('问题')
  })

  it('keeps ordinary-channel research-shaped notices outside research cards', () => {
    useSessionStore.getState().bindResearchConversation(snapshot())
    useSessionStore.getState().handleBridgeMessage(event(1, 'message_end', { message: { role: 'custom', customType: 'research-discipline', content: 'ordinary notice', details: { run_id: 'ordinary-run' }, timestamp: 10 } }, 'ordinary'))
    expect(useSessionStore.getState().messages.at(-1)?.content).toBe('ordinary notice')
    expect(useSessionStore.getState().researchCards).toEqual({})
    expect(useSessionStore.getState().researchConversation.messages).toEqual([])
  })

  it('ignores old request acknowledgements after binding a different host transcript', () => {
    useSessionStore.getState().bindResearchConversation(snapshot())
    useSessionStore.getState().queueResearchMessage('old', '旧文本')
    useSessionStore.getState().bindResearchConversation(snapshot({ session: { sessionId: 'new-research', file: '/new.jsonl', cwd: '/next' } }))
    useSessionStore.getState().handleResearchBridgeMessage({ type: 'ack', requestId: 'old', ok: false, error: '旧错误' })
    expect(useSessionStore.getState().researchConversation.messages).toEqual([])
    expect(useSessionStore.getState().researchConnectionError).toBeNull()
  })

  it('reconciles identical pending inputs by the backend requestId rather than text order', () => {
    useSessionStore.getState().bindResearchConversation(snapshot())
    const actions = useSessionStore.getState()
    actions.queueResearchMessage('first', '相同问题')
    actions.queueResearchMessage('second', '相同问题')
    actions.handleResearchBridgeMessage(notice(11, 'research-question', { question: '相同问题', requestId: 'second' }))
    const rows = useSessionStore.getState().researchConversation.messages
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ requestId: 'first', optimistic: true })
    expect(rows[1]).toMatchObject({ requestId: 'second', optimistic: false, deliveryStatus: 'created', timestamp: 1100 })
  })

  it('settles a host run hydrated as active when its real final arrives without an assistant stream', () => {
    useSessionStore.getState().bindResearchConversation(snapshot({ run: { id: 'run1', status: 'active', phase: 'executing' } }))
    const actions = useSessionStore.getState()
    actions.handleResearchBridgeMessage(notice(11, 'research-final', { run_id: 'run1', result: { status: 'partial', phase: 'stopped' } }))
    expect(useSessionStore.getState().researchConversation.isStreaming).toBe(false)
    actions.clearResearchConversation()
    expect(useSessionStore.getState().researchBinding).toBeNull()
  })

  it('keeps a completed run selected while the native host is busy before its assistant starts', () => {
    const actions = useSessionStore.getState()
    const doneRun = { id: 'run1', status: 'done', phase: 'done' }
    actions.bindResearchConversation(snapshot({ streamId: 'stream1', run: doneRun, isStreaming: false, isIdle: false }))
    expect(useSessionStore.getState().researchConversation.streamingMessageId).toBeNull()
    expect(useSessionStore.getState().researchConversation.isStreaming).toBe(true)
    actions.clearResearchConversation()
    expect(useSessionStore.getState().researchBinding?.runId).toBe('run1')
    actions.bindResearchConversation(snapshot({ streamId: 'stream1', lastEventSeq: 11, run: doneRun, isStreaming: false, isIdle: true }))
    expect(useSessionStore.getState().researchConversation.isStreaming).toBe(false)
    actions.clearResearchConversation()
    expect(useSessionStore.getState().researchBinding).toBeNull()
  })

  it('preserves a same-stream native agent_start before an assistant owner when a legacy snapshot lacks busy fields', () => {
    const actions = useSessionStore.getState()
    const doneRun = { id: 'run1', status: 'done', phase: 'done' }
    actions.bindResearchConversation(snapshot({ streamId: 'stream1', run: doneRun }))
    actions.handleResearchBridgeMessage({ ...event(11, 'agent_start'), streamId: 'stream1' })
    actions.bindResearchConversation(snapshot({ streamId: 'stream1', lastEventSeq: 11, run: doneRun }))
    expect(useSessionStore.getState().researchConversation.isStreaming).toBe(true)
    actions.clearResearchConversation()
    expect(useSessionStore.getState().researchBinding?.runId).toBe('run1')
    actions.handleResearchBridgeMessage({ ...event(12, 'agent_settled'), streamId: 'stream1' })
    actions.clearResearchConversation()
    expect(useSessionStore.getState().researchBinding).toBeNull()
  })

  it('keeps a waiting-input run selected even though its native host is idle', () => {
    const actions = useSessionStore.getState()
    actions.bindResearchConversation(snapshot({ run: { id: 'run1', status: 'waiting_input', phase: 'waiting_input' }, isStreaming: false, isIdle: true }))
    expect(useSessionStore.getState().researchConversation.isStreaming).toBe(false)
    actions.clearResearchConversation()
    expect(useSessionStore.getState().researchBinding?.runId).toBe('run1')
  })

  it('accepts restarted host sequences for the same persisted session after authoritative rebind', () => {
    useSessionStore.getState().bindResearchConversation(snapshot({ lastEventSeq: 100, streamId: 'old-process' }))
    useSessionStore.getState().bindResearchConversation(snapshot({ lastEventSeq: 1, streamId: 'new-process' }))
    useSessionStore.getState().handleResearchBridgeMessage(event(2, 'message_end', { message: { role: 'user', content: '新进程', timestamp: 10 } }))
    expect(useSessionStore.getState().researchConversation.messages[0]?.content).toBe('新进程')
    expect(useSessionStore.getState().researchConversation.lastEventSeq).toBe(2)
  })

  it('preserves accepted input missing from a same-session snapshot until its true persisted row arrives', () => {
    useSessionStore.getState().bindResearchConversation(snapshot({ run: { id: 'run1', status: 'waiting_input', phase: 'waiting_input' } }))
    const actions = useSessionStore.getState()
    actions.queueResearchMessage('followup', '补充条件')
    actions.acceptResearchMessage('followup')
    actions.bindResearchConversation(snapshot({ lastEventSeq: 11, run: { id: 'run1', status: 'active', phase: 'executing' } }))
    expect(useSessionStore.getState().researchConversation.messages[0]).toMatchObject({ requestId: 'followup', content: '补充条件', optimistic: true, deliveryStatus: 'accepted' })
    actions.bindResearchConversation(snapshot({ lastEventSeq: 12, messages: [{ id: 'persisted', role: 'user', content: '补充条件', timestamp: 50, details: { requestId: 'followup' } }], run: { id: 'run1', status: 'active', phase: 'executing' } }))
    expect(useSessionStore.getState().researchConversation.messages).toHaveLength(1)
    expect(useSessionStore.getState().researchConversation.messages[0].id).toBe('persisted')
  })

  it('ignores a stale same-stream snapshot and old-epoch events after a real restart', () => {
    const actions = useSessionStore.getState()
    actions.bindResearchConversation(snapshot({ streamId: 'stream1' }))
    actions.handleResearchBridgeMessage({ ...event(11, 'message_end', { message: { role: 'user', content: '新历史', timestamp: 20 } }), streamId: 'stream1' })
    actions.bindResearchConversation(snapshot({ streamId: 'stream1', lastEventSeq: 10 }))
    expect(useSessionStore.getState().researchConversation.messages[0]?.content).toBe('新历史')
    actions.bindResearchConversation(snapshot({ streamId: 'stream2', lastEventSeq: 1 }))
    actions.handleResearchBridgeMessage({ ...notice(100, 'research-discipline', { run_id: 'old-run' }), streamId: 'stream1' })
    expect(useSessionStore.getState().researchBinding?.runId).toBeNull()
    expect(useSessionStore.getState().researchCards['old-run']).toBeUndefined()
  })

  it('preserves a same-stream assistant prefix absent from saved history during a follow-up snapshot', () => {
    const actions = useSessionStore.getState()
    actions.bindResearchConversation(snapshot({ streamId: 'stream1', run: { id: 'run1', status: 'active', phase: 'executing' } }))
    actions.handleResearchBridgeMessage({ ...event(11, 'message_start', { message: { role: 'assistant', timestamp: 30 } }), streamId: 'stream1' })
    actions.handleResearchBridgeMessage({ ...event(12, 'message_update', { assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '已收到的前缀' } }), streamId: 'stream1' })
    const owner = useSessionStore.getState().researchConversation.streamingMessageId
    actions.bindResearchConversation(snapshot({ streamId: 'stream1', lastEventSeq: 12, run: { id: 'run1', status: 'active', phase: 'executing' } }))
    expect(useSessionStore.getState().researchConversation.messages[0]?.content).toBe('已收到的前缀')
    expect(useSessionStore.getState().researchConversation.streamingMessageId).toBe(owner)
    actions.handleResearchBridgeMessage({ ...event(13, 'message_update', { assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '，继续' } }), streamId: 'stream1' })
    expect(useSessionStore.getState().researchConversation.messages[0]?.content).toBe('已收到的前缀，继续')
  })

  it('surfaces a real connection error without accepting its unrelated event sequence', () => {
    const actions = useSessionStore.getState()
    actions.bindResearchConversation(snapshot())
    actions.handleResearchBridgeMessage(event(0, 'research_connection_error', { error: '进程已退出' }))
    expect(useSessionStore.getState().researchConnectionError).toBe('进程已退出')
    expect(useSessionStore.getState().researchConversation.lastEventSeq).toBe(10)
  })

  it('keeps selection during the persisted-question to run-creation gap', () => {
    useSessionStore.getState().bindResearchConversation(snapshot())
    const actions = useSessionStore.getState()
    actions.queueResearchMessage('creating', '创建中的问题')
    actions.acceptResearchMessage('creating')
    actions.handleResearchBridgeMessage(notice(11, 'research-question', { question: '创建中的问题', requestId: 'creating' }))
    actions.handleResearchBridgeMessage(event(12, 'agent_settled'))
    actions.clearResearchConversation()
    expect(useSessionStore.getState().researchBinding?.sessionId).toBe('research-session')
    actions.handleResearchBridgeMessage(notice(13, 'research-progress', { stage: 'startup_error', requestId: 'creating' }, '创建失败'))
    actions.clearResearchConversation()
    expect(useSessionStore.getState().researchBinding).toBeNull()
  })

  it('retains a real snapshot run even when history lacks a discipline notice', () => {
    useSessionStore.getState().bindResearchConversation(snapshot({ messages: [{ id: 'q1', role: 'user', content: '已有研究', timestamp: 1 }], run: { id: 'persisted-run', status: 'active', phase: 'executing' } }))
    const actions = useSessionStore.getState()
    actions.handleResearchBridgeMessage(event(11, 'agent_settled'))
    actions.clearResearchConversation()
    expect(useSessionStore.getState().researchBinding?.runId).toBe('persisted-run')
    expect(useSessionStore.getState().researchCards['persisted-run']).toMatchObject({ status: 'active', phase: 'executing', question: '已有研究', workspace: '/workspace' })
  })

  it('records correlated rejection on the research row without deleting text or stopping ordinary streaming', () => {
    useSessionStore.getState().bindResearchConversation(snapshot())
    useSessionStore.setState({ isStreaming: true })
    useSessionStore.getState().queueResearchMessage('req1', '保留文本')
    useSessionStore.getState().handleResearchBridgeMessage({ type: 'ack', requestId: 'req1', ok: false, error: '网络失败' })
    expect(useSessionStore.getState().researchConversation.messages[0]).toMatchObject({ content: '保留文本', optimistic: false, submissionError: '网络失败', deliveryStatus: 'failed' })
    expect(useSessionStore.getState().isStreaming).toBe(true)
  })

  it('clears selection only after the real research stream settles and retains history cards', () => {
    useSessionStore.getState().bindResearchConversation(snapshot())
    const actions = useSessionStore.getState()
    actions.handleResearchBridgeMessage(notice(11, 'research-discipline', { run_id: 'run1' }))
    actions.handleResearchBridgeMessage(event(12, 'agent_start'))
    actions.clearResearchConversation()
    expect(useSessionStore.getState().researchBinding?.sessionId).toBe('research-session')
    actions.handleResearchBridgeMessage(notice(13, 'research-final', { run_id: 'run1', result: { status: 'done' } }))
    actions.handleResearchBridgeMessage(event(14, 'agent_settled'))
    actions.clearResearchConversation()
    expect(useSessionStore.getState().researchBinding).toBeNull()
    expect(useSessionStore.getState().researchConversation.messages).toEqual([])
    expect(useSessionStore.getState().researchCards.run1.status).toBe('done')
  })

  it('rehydrates run cards from real notices, with stable entry IDs and no stale optimistic errors', () => {
    const messages = [
      { id: 'q', entryId: 'eq', role: 'custom', customType: 'research-question', content: 'Research question | 原问题', details: { question: '原问题' }, timestamp: 1 },
      { id: 'd', entryId: 'ed', role: 'custom', customType: 'research-discipline', content: '', details: { run_id: 'run1' }, timestamp: 2 },
      { id: 'p', entryId: 'ep', role: 'custom', customType: 'research-progress', content: '', details: { run_id: 'run1', tasks: [{ id: 'task1', title: '真实任务', status: 'running' }] }, timestamp: 3 },
    ]
    useSessionStore.getState().bindResearchConversation(snapshot({ messages, run: { id: 'run1', status: 'active', phase: 'executing' } }))
    useSessionStore.getState().queueResearchMessage('late', '临时')
    useSessionStore.getState().failResearchMessage('late', '失败')
    useSessionStore.getState().bindResearchConversation(snapshot({ messages, lastEventSeq: 20, run: { id: 'run1', status: 'active', phase: 'executing' } }))
    const state = useSessionStore.getState()
    expect(state.researchConversation.messages[0]).toMatchObject({ id: 'q', entryId: 'eq', role: 'user', content: '原问题' })
    expect(state.researchConversation.messages.some(m => m.submissionError)).toBe(false)
    expect(state.researchCards.run1).toMatchObject({ question: '原问题', tasks: [{ id: 'task1', title: '真实任务' }] })
  })

  it('projects genuine research-input follow-ups without replacing the original run question', () => {
    const messages = [
      { id: 'q', role: 'custom', customType: 'research-question', content: 'Research question | 原问题', details: { question: '原问题' }, timestamp: 1 },
      { id: 'd', role: 'custom', customType: 'research-discipline', content: '', details: { run_id: 'run1' }, timestamp: 2 },
      { id: 'i', entryId: 'entry-input', role: 'custom', customType: 'research-input', content: 'Research input | 历史补充', details: { text: '历史补充', run_id: 'run1', requestId: 'historical' }, timestamp: 3 },
    ]
    const actions = useSessionStore.getState()
    actions.bindResearchConversation(snapshot({ messages, run: { id: 'run1', status: 'waiting_input', phase: 'waiting_input' } }))
    expect(useSessionStore.getState().researchConversation.messages[2]).toMatchObject({ role: 'user', content: '历史补充', customType: 'research-input', entryId: 'entry-input', requestId: 'historical' })
    actions.queueResearchMessage('followup', '新补充')
    actions.handleResearchBridgeMessage(notice(11, 'research-input', { question: '新补充', run_id: 'run1', requestId: 'followup' }, 'Research input | 新补充'))
    expect(useSessionStore.getState().researchConversation.messages.at(-1)).toMatchObject({ role: 'user', content: '新补充', customType: 'research-input', optimistic: false, requestId: 'followup' })
    expect(useSessionStore.getState().researchCards.run1.question).toBe('原问题')
    expect(Object.keys(useSessionStore.getState().researchCards)).toEqual(['run1'])
    actions.queueResearchMessage('plain-input', '原样输入')
    actions.handleResearchBridgeMessage(event(12, 'message_start', { message: { role: 'custom', customType: 'research-input', content: '原样输入', details: { run_id: 'run1', requestId: 'plain-input' }, timestamp: 1200 } }))
    actions.handleResearchBridgeMessage(event(13, 'message_end', { message: { role: 'custom', customType: 'research-input', content: '原样输入', details: { run_id: 'run1', requestId: 'plain-input' }, timestamp: 1200 } }))
    expect(useSessionStore.getState().researchConversation.messages.filter(message => message.content === '原样输入')).toHaveLength(1)
    expect(useSessionStore.getState().researchConversation.messages.at(-1)).toMatchObject({ role: 'user', content: '原样输入', optimistic: false, deliveryStatus: 'created' })
  })
})
