import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fixture from '../../../../tests/fixtures/desktop_conversation.json'
import { useSessionStore } from '../useSessionStore'
import type { BridgeMessage } from '../../types/global'

let seq = 0
function emit(event: Record<string, unknown>, sessionId = fixture.sessionId) {
  useSessionStore.getState().handleBridgeMessage({ seq: ++seq, sessionId, event } as BridgeMessage)
}
function replay(until = Number.POSITIVE_INFINITY) {
  for (const envelope of fixture.events) {
    if (envelope.seq > until) break
    seq = envelope.seq
    useSessionStore.getState().handleBridgeMessage(envelope as BridgeMessage)
  }
  vi.advanceTimersByTime(20)
}
function assistants() { return useSessionStore.getState().messages.filter(m => m.role === 'assistant') }

describe('desktop intervention submission', () => {
  it('does not discard a correlated failure just because a same-text echo arrived', () => {
    replay(9)
    useSessionStore.getState().sendMessage('同文任务', 'steer')
    const command = vi.mocked(window.bridge.send).mock.calls.at(-1)![0] as any
    emit({ type: 'message_start', message: { role: 'user', content: '同文任务', timestamp: 1400 } })
    useSessionStore.getState().handleBridgeMessage({ type: 'ack', requestId: command.requestId, ok: false, error: '关联失败' })
    expect(useSessionStore.getState().messages.find(m => m.content === '同文任务')?.submissionError).toBe('关联失败')
    expect(useSessionStore.getState().isStreaming).toBe(true)
  })
  it('defaults to steer even while idle, preserving the mode across the bridge race', () => {
    useSessionStore.getState().sendMessage('任务')
    expect(window.bridge.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'prompt', text: '任务', streamingBehavior: 'steer' }))
  })

  it.each(['steer', 'followUp'] as const)('marks a failed %s on its user row and retries without stopping the run', mode => {
    replay(9)
    const active = useSessionStore.getState().streamingMessageId
    const before = assistants().length
    useSessionStore.getState().sendMessage('调整任务', mode)
    const command = vi.mocked(window.bridge.send).mock.calls.at(-1)![0] as any
    useSessionStore.getState().handleBridgeMessage({ type: 'ack', requestId: command.requestId, ok: false, error: '提交失败' })
    const failed = useSessionStore.getState().messages.find(m => m.content === '调整任务')!
    expect(failed).toMatchObject({ submissionError: '提交失败', streamingBehavior: mode, optimistic: false })
    expect(useSessionStore.getState().isStreaming).toBe(true)
    expect(useSessionStore.getState().streamingMessageId).toBe(active)
    expect(assistants()).toHaveLength(before)
    useSessionStore.getState().retryMessage(failed.id)
    const retried = vi.mocked(window.bridge.send).mock.calls.at(-1)![0] as any
    expect(retried).toMatchObject({ text: '调整任务', streamingBehavior: mode })
    expect(retried.requestId).not.toBe(command.requestId)
    expect(useSessionStore.getState().messages.filter(m => m.content === '调整任务')).toHaveLength(1)
    emit({ type: 'message_start', message: { role: 'user', content: '调整任务', timestamp: 1100 } })
    expect(useSessionStore.getState().messages.filter(m => m.content === '调整任务')).toHaveLength(1)
  })

  it('ignores a late failed acknowledgement after switching sessions', () => {
    useSessionStore.getState().sendMessage('旧任务', 'followUp')
    const command = vi.mocked(window.bridge.send).mock.calls.at(-1)![0] as any
    emit({ type: 'session_started', sessionId: 'new-session' }, 'new-session')
    useSessionStore.getState().handleBridgeMessage({ type: 'ack', requestId: command.requestId, ok: false, error: '旧错误' })
    expect(useSessionStore.getState().messages).toEqual([])
    expect(useSessionStore.getState().isStreaming).toBe(false)
  })

  it('blocks direct sends while stopping and excludes failed identical text from echo matching', () => {
    replay(9)
    useSessionStore.setState({ isAborting: true })
    useSessionStore.getState().sendMessage('不应发送', 'steer')
    expect(vi.mocked(window.bridge.send).mock.calls.filter(([command]) => (command as any).type === 'prompt')).toHaveLength(0)
    useSessionStore.setState({ isAborting: false })
    useSessionStore.getState().sendMessage('重复', 'steer')
    const command = vi.mocked(window.bridge.send).mock.calls.at(-1)![0] as any
    useSessionStore.getState().handleBridgeMessage({ type: 'ack', requestId: command.requestId, ok: false, error: '失败' })
    useSessionStore.getState().sendMessage('重复', 'followUp')
    emit({ type: 'message_start', message: { role: 'user', content: '重复', timestamp: 1200 } })
    const rows = useSessionStore.getState().messages.filter(m => m.content === '重复')
    expect(rows).toHaveLength(2)
    expect(rows[0].submissionError).toBe('失败')
    expect(rows[1].timestamp).toBe(1200)
  })
})

beforeEach(() => {
  vi.useFakeTimers()
  seq = 0
  window.bridge = { send: vi.fn(), on: () => () => {} }
  useSessionStore.setState({ currentSessionId: '', messages: [], isStreaming: false, isAborting: false, lastEventSeq: 0 })
  useSessionStore.getState().handleBridgeMessage({seq:0,sessionId:fixture.sessionId,event:{type:'session_started',sessionId:fixture.sessionId}})
})
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers() })

describe('real bridge conversation replay', () => {
  it('keeps the run busy after a tool-use assistant message ends', () => {
    replay(8)
    expect(useSessionStore.getState().isStreaming).toBe(true)
    expect(useSessionStore.getState().streamingMessageId).toBeNull()
    expect(assistants()[0].toolCalls?.[0].status).toBe('pending')
  })

  it('preserves intermediate replies, ordered blocks and actual tool identity', () => {
    useSessionStore.getState().sendMessage('读取并总结')
    replay(14)
    expect(assistants().map(m => m.content)).toEqual(['先读取文件。读取请求已发出。', '读取完成，继续检索。'])
    expect(assistants()[0].blocks?.map(b => b.type)).toEqual(['thinking', 'text', 'toolCall', 'text'])
    expect(assistants()[0].toolCalls?.[0]).toMatchObject({ id: 'call-a', name: 'read', status: 'success', result: [{ type: 'text', text: '文件内容' }] })
    expect(useSessionStore.getState().messages.filter(m => m.role === 'user')).toHaveLength(1)
  })

  it('keeps agent_end busy until settled and never overwrites earlier assistants', () => {
    replay(21)
    expect(useSessionStore.getState().isStreaming).toBe(true)
    expect(assistants()).toHaveLength(3)
    expect(assistants()[1].toolCalls?.[0]).toMatchObject({ id: 'call-b', status: 'error', result: [{ type: 'text', text: '未找到匹配项' }] })
    emit({ type: 'agent_settled' })
    expect(useSessionStore.getState().isStreaming).toBe(false)
  })

  it('updates parallel tool results independently and idempotently', () => {
    emit({ type: 'agent_start' })
    emit({ type: 'message_start', message: { role: 'assistant', timestamp: 500, content: [] } })
    emit({ type: 'message_end', message: { role: 'assistant', timestamp: 500, content: [
      { type: 'toolCall', id: 'one', name: 'read', arguments: {} },
      { type: 'toolCall', id: 'two', name: 'grep', arguments: {} },
    ], stopReason: 'toolUse' } })
    emit({ type: 'tool_execution_start', toolCallId: 'two', toolName: 'grep', args: {} })
    emit({ type: 'tool_execution_update', toolCallId: 'two', partialResult: { content: [{ type: 'text', text: 'searching' }] } })
    expect(assistants()[0].toolCalls?.[1].status).toBe('running')
    expect(assistants()[0].toolCalls?.[1].partialResult).toEqual({ content: [{ type: 'text', text: 'searching' }] })
    emit({ type: 'tool_execution_end', toolCallId: 'two', isError: true, result: { content: 'error' } })
    emit({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'two', isError: true, content: 'error' } })
    emit({ type: 'tool_execution_end', toolCallId: 'one', isError: false, result: { content: 'ok' } })
    expect(assistants()[0].toolCalls?.map(tc => [tc.id, tc.status, tc.result])).toEqual([['one', 'success', 'ok'], ['two', 'error', 'error']])
    expect(assistants()).toHaveLength(1)
  })

  it('discards buffered deltas and late events from a previous session', () => {
    replay(5)
    emit({ type: 'session_started', sessionId: 'next' }, 'next')
    vi.advanceTimersByTime(20)
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'stale' }] } })
    expect(useSessionStore.getState().messages).toEqual([])
  })

  it('ignores duplicate event envelopes rather than duplicating text', () => {
    replay(6)
    const duplicate = fixture.events[5] as BridgeMessage
    useSessionStore.getState().handleBridgeMessage(duplicate)
    vi.advanceTimersByTime(20)
    expect(assistants()[0].content).toBe('先读取文件。')
  })

  it('keeps stopping busy until settled, retains text and marks unfinished tools stopped', () => {
    replay(9)
    useSessionStore.getState().abortGeneration()
    expect(useSessionStore.getState().isStreaming).toBe(true)
    emit({ type: 'agent_settled' })
    expect(useSessionStore.getState().isStreaming).toBe(false)
    expect(assistants()[0].content).toBe('先读取文件。读取请求已发出。')
    expect(assistants()[0].toolCalls?.[0].status).toBe('cancelled')
  })

  it('flushes a buffered delta before a custom notice without losing order', () => {
    replay(5)
    emit({ type: 'message_end', message: { role: 'custom', content: 'progress', customType: 'research-progress', display: true } })
    expect(assistants()[0].thinking).toBe('先检查文件。')
    expect(useSessionStore.getState().messages.at(-1)?.customType).toBe('research-progress')
  })
})


describe('wire format and reviewed lifecycle boundaries', () => {
  it('renders a stripped toolcall start immediately and reconciles arguments on end', () => {
    emit({ type:'agent_start' })
    emit({ type:'message_start',message:{role:'assistant',content:[],timestamp:900} })
    emit({ type:'message_update',assistantMessageEvent:{type:'toolcall_start',contentIndex:0,id:'wire-call',toolName:'read'} })
    vi.advanceTimersByTime(20)
    expect(assistants()[0].toolCalls?.[0]).toMatchObject({id:'wire-call',name:'read',status:'pending'})
    emit({ type:'message_update',assistantMessageEvent:{type:'toolcall_delta',contentIndex:0,delta:'{"path":"fixture.md"}'} })
    emit({ type:'message_update',assistantMessageEvent:{type:'toolcall_end',contentIndex:0,toolCall:{type:'toolCall',id:'wire-call',name:'read',arguments:{path:'fixture.md'}}} })
    vi.advanceTimersByTime(20)
    expect(assistants()[0].toolCalls).toHaveLength(1)
    expect(assistants()[0].toolCalls?.[0].arguments).toEqual({path:'fixture.md'})
  })

  it('does not settle or discard buffered tokens on an unrelated failed acknowledgement', () => {
    emit({type:'agent_start'})
    emit({type:'message_start',message:{role:'assistant',content:[],timestamp:901}})
    emit({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'保留的文字'}})
    useSessionStore.getState().handleBridgeMessage({type:'ack',requestId:'req_ls_unrelated',ok:false,error:'list error'})
    vi.advanceTimersByTime(20)
    expect(useSessionStore.getState().isStreaming).toBe(true)
    expect(assistants()[0].content).toBe('保留的文字')
  })

  it('routes a late assistant snapshot to its own message while the newer message stays active', () => {
    emit({type:'agent_start'})
    emit({type:'message_start',message:{role:'assistant',content:[],timestamp:910}})
    emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'第一条'}],timestamp:910}})
    emit({type:'message_start',message:{role:'assistant',content:[],timestamp:920}})
    emit({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'第二条'}})
    vi.advanceTimersByTime(20)
    const target=useSessionStore.getState().streamingMessageId
    emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'第一条的校准'}],timestamp:910}})
    expect(assistants().map(m=>m.content)).toEqual(['第一条的校准','第二条'])
    expect(useSessionStore.getState().streamingMessageId).toBe(target)
  })

  it('associates repeated optimistic user echoes FIFO with their saved entries', () => {
    emit({type:'agent_start'})
    useSessionStore.getState().sendMessage('重复任务','steer')
    vi.advanceTimersByTime(1)
    useSessionStore.getState().sendMessage('重复任务','followUp')
    emit({type:'message_start',message:{role:'user',content:'重复任务',timestamp:930}})
    emit({type:'entry_appended',entry:{type:'message',id:'first-entry',message:{role:'user',timestamp:930}}})
    emit({type:'message_start',message:{role:'user',content:'重复任务',timestamp:940}})
    emit({type:'entry_appended',entry:{type:'message',id:'second-entry',message:{role:'user',timestamp:940}}})
    expect(useSessionStore.getState().messages.filter(m=>m.role==='user').map(m=>[m.timestamp,m.entryId])).toEqual([[930,'first-entry'],[940,'second-entry']])
  })

  it('does not clear conversation state on a duplicate session_started envelope', () => {
    replay(8)
    const before=useSessionStore.getState().messages
    useSessionStore.getState().handleBridgeMessage({seq:1,sessionId:fixture.sessionId,event:{type:'session_started',sessionId:fixture.sessionId}})
    expect(useSessionStore.getState().messages).toEqual(before)
    expect(useSessionStore.getState().lastEventSeq).toBe(8)
  })

  it('keeps hydration busy between session_started and its correlated load reply', () => {
    useSessionStore.getState().openSession('new.jsonl')
    const command=(window.bridge.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
    emit({type:'session_started',sessionId:'loaded',file:'new.jsonl'},'loaded')
    expect(useSessionStore.getState().isStreaming).toBe(true)
    useSessionStore.getState().sendMessage('不应提前提交')
    expect(useSessionStore.getState().messages).toEqual([])
    useSessionStore.getState().handleBridgeMessage({type:'ack',requestId:command.requestId,ok:true,data:{session:{sessionId:'loaded',file:'new.jsonl'},messages:[]}})
    expect(useSessionStore.getState().isStreaming).toBe(false)
  })

  it('retains generated prose and tools when an abort snapshot is empty', () => {
    replay(9)
    useSessionStore.getState().abortGeneration()
    emit({type:'message_end',message:{role:'assistant',timestamp:1001,stopReason:'aborted',content:[]}})
    emit({type:'agent_settled'})
    expect(assistants()[0].content).toBe('先读取文件。读取请求已发出。')
    expect(assistants()[0].thinking).toBe('先检查文件。')
    expect(assistants()[0].toolCalls?.[0].status).toBe('cancelled')
  })
})


it('deduplicates the session start even after history loads before any live events', () => {
  useSessionStore.getState().openSession('history.jsonl')
  const command=(window.bridge.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
  const started={seq:50,sessionId:'history',event:{type:'session_started',sessionId:'history',file:'history.jsonl'}}
  useSessionStore.getState().handleBridgeMessage(started as BridgeMessage)
  useSessionStore.getState().handleBridgeMessage({type:'ack',requestId:command.requestId,ok:true,data:{session:{sessionId:'history',file:'history.jsonl'},messages:[{id:'saved',entryId:'saved-entry',role:'assistant',content:'已保存',timestamp:1}]}})
  useSessionStore.getState().handleBridgeMessage(started as BridgeMessage)
  expect(useSessionStore.getState().messages.map(m=>m.content)).toEqual(['已保存'])
  expect(useSessionStore.getState().lastEventSeq).toBe(50)
})

it('cleans a failed load timeout so it cannot stop a later run', () => {
  useSessionStore.getState().openSession('missing.jsonl')
  const command=(window.bridge.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
  useSessionStore.getState().handleBridgeMessage({type:'ack',requestId:command.requestId,ok:false,error:'missing'})
  emit({type:'agent_start'})
  emit({type:'message_start',message:{role:'assistant',content:[],timestamp:960}})
  emit({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'新一轮文字'}})
  vi.advanceTimersByTime(8100)
  expect(useSessionStore.getState().isStreaming).toBe(true)
  expect(assistants()[0].content).toBe('新一轮文字')
})

it('supersedes a pending load when creating a fresh session', () => {
  useSessionStore.getState().openSession('old.jsonl')
  useSessionStore.getState().createSession()
  const command=(window.bridge.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
  emit({type:'session_started',sessionId:'fresh',file:'fresh.jsonl'},'fresh')
  useSessionStore.getState().handleBridgeMessage({type:'ack',requestId:command.requestId,ok:true,data:{}})
  expect(useSessionStore.getState().isSessionLoading).toBe(false)
  expect(useSessionStore.getState().isStreaming).toBe(false)
})


it('ignores a retired session start instead of switching the view backward', () => {
  useSessionStore.getState().handleBridgeMessage({seq:100,sessionId:'current',event:{type:'session_started',sessionId:'current'}})
  useSessionStore.setState({messages:[{id:'current-message',role:'assistant',content:'当前内容',timestamp:1}]})
  useSessionStore.getState().handleBridgeMessage({seq:50,sessionId:fixture.sessionId,event:{type:'session_started',sessionId:fixture.sessionId}})
  expect(useSessionStore.getState().currentSessionId).toBe('current')
  expect(useSessionStore.getState().messages.map(m=>m.content)).toEqual(['当前内容'])
})

it('rejects an older load reply when two loads are requested in the same millisecond', () => {
  useSessionStore.getState().openSession('older.jsonl')
  const oldCommand=(window.bridge.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
  useSessionStore.getState().openSession('latest.jsonl')
  const newCommand=(window.bridge.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
  useSessionStore.getState().handleBridgeMessage({type:'ack',requestId:oldCommand.requestId,ok:true,data:{session:{sessionId:'older'},messages:[{id:'wrong',role:'assistant',content:'旧回复',timestamp:1}]}})
  expect(useSessionStore.getState().isSessionLoading).toBe(true)
  expect(useSessionStore.getState().messages).toEqual([])
  useSessionStore.getState().handleBridgeMessage({type:'ack',requestId:newCommand.requestId,ok:true,data:{session:{sessionId:'latest'},messages:[]}})
  expect(useSessionStore.getState().currentSessionId).toBe('latest')
  expect(useSessionStore.getState().isSessionLoading).toBe(false)
})
