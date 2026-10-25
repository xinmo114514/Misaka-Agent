import { beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ResearchAgentPane } from './ResearchAgentPane'
import { MultiPaneFrame } from './MultiPaneFrame'
import { researchSessionsBridge } from '../../lib/researchSessionsBridge'
import { useResearchSessionsStore } from '../../store/useResearchSessionsStore'
import { useResearchWorkspaceStore } from '../../store/useResearchWorkspaceStore'

vi.mock('../../lib/researchSessionsBridge', () => ({ researchSessionsBridge: { content: vi.fn(), history: vi.fn() } }))
beforeEach(() => {
  useResearchSessionsStore.setState({ byExecutor: {} })
  useResearchWorkspaceStore.setState({ byRun: {} })
  vi.mocked(researchSessionsBridge.content).mockReset()
  vi.mocked(researchSessionsBridge.history).mockReset()
})

it('loads longer saved content by entry id and the full error by executor id', async () => {
  const descriptor = { executorId: 'e', sessionId: 's', sessionFile: 's.jsonl', nodeId: 'n', taskId: 't', role: 'sister' as const,
    label: 'research-generalist · t', cardTitle: 'Evidence', workspace: 'C:/fixture', status: 'failed', generation: 1, attempt: 1,
    startedAt: 1, endedAt: 2, error: 'failed' }
  useResearchSessionsStore.setState({ byExecutor: {} })
  useResearchSessionsStore.getState().upsertDescriptors('r', [descriptor])
  useResearchSessionsStore.getState().applyHistory({ runId: 'r', executorId: 'e', messages: [{ id: 'm', entryId: 'entry', role: 'assistant', content: 'Preview', contentTruncated: true, timestamp: 1 }],
    nextCursor: null, hasMore: false, availability: 'available', historyVersion: 'v1', error: 'failure preview' })
  vi.mocked(researchSessionsBridge.content).mockResolvedValue({ content: 'Full body', nextOffset: null, hasMore: false })
  render(<ResearchAgentPane runId="r" descriptor={descriptor} />)
  fireEvent.click(screen.getByRole('button', { name: '读取完整消息' }))
  await waitFor(() => expect(screen.getByText('Full body')).toBeInTheDocument())
  expect(researchSessionsBridge.content).toHaveBeenCalledWith('r', 'e', 'entry', 'content', 0, 8192, 'C:/fixture')
  fireEvent.click(screen.getByRole('button', { name: '查看完整错误' }))
  expect(researchSessionsBridge.content).toHaveBeenCalledWith('r', 'e', 'e', 'error', 0, 8192, 'C:/fixture')
  expect(screen.getByText(/research-generalist · t/)).toBeInTheDocument()
})

it('uses returned Unicode content offsets instead of UTF-16 display lengths', async () => {
  const descriptor={executorId:'unicode',sessionId:'u',sessionFile:'u.jsonl',nodeId:'n',taskId:'t',role:'sister' as const,
    label:'Unicode card',workspace:'C:/fixture',status:'done',generation:1,attempt:1,startedAt:1,endedAt:2,error:null}
  useResearchSessionsStore.setState({byExecutor:{}})
  useResearchSessionsStore.getState().upsertDescriptors('r',[descriptor])
  useResearchSessionsStore.getState().applyHistory({runId:'r',executorId:'unicode',messages:[{id:'u-msg',entryId:'u-entry',role:'assistant',content:'🙂',contentTruncated:true,timestamp:1}],nextCursor:null,hasMore:false,availability:'available',historyVersion:'v1'})
  vi.mocked(researchSessionsBridge.content).mockReset().mockResolvedValueOnce({content:'🙂中',nextOffset:2,hasMore:true})
    .mockResolvedValueOnce({content:'文',nextOffset:null,hasMore:false})
  render(<ResearchAgentPane runId="r" descriptor={descriptor}/>)
  fireEvent.click(screen.getByRole('button',{name:'读取完整消息'}))
  await waitFor(()=>expect(screen.getByText('🙂中')).toBeInTheDocument())
  fireEvent.click(screen.getByRole('button',{name:'读取完整消息'}))
  await waitFor(()=>expect(screen.getByText('🙂中文')).toBeInTheDocument())
  expect(researchSessionsBridge.content).toHaveBeenLastCalledWith('r','unicode','u-entry','content',2,8192,'C:/fixture')
})

const toolDescriptor = { executorId: 'tool-e', sessionId: 'tool-s', sessionFile: 'tool.jsonl', nodeId: 'n', taskId: 't',
  role: 'sister' as const, label: 'Tool executor', workspace: 'C:/fixture', status: 'done', generation: 1,
  attempt: 1, startedAt: 1, endedAt: 2, error: null }
function seedTool(result: string, truncated = false) {
  useResearchSessionsStore.setState({ byExecutor: {} })
  useResearchSessionsStore.getState().upsertDescriptors('r', [toolDescriptor])
  useResearchSessionsStore.getState().applyHistory({ runId: 'r', executorId: 'tool-e', messages: [{
    id: 'tool-msg', entryId: 'tool-entry', role: 'assistant', content: '', timestamp: 1,
    toolCalls: [{ id: 'call-1', name: 'Read fixture', status: 'success', result, resultTruncated: truncated }],
  }], nextCursor: null, hasMore: false, availability: 'available', historyVersion: 'v1' })
}

it('restores saved reading after a new frame attaches its initially detached portal host', async () => {
  seedTool('Saved reading fixture.')
  useResearchWorkspaceStore.getState().setReading('r', toolDescriptor.executorId, { scrollTop: 250, following: false })
  const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop')
  const scrollPositions = new WeakMap<HTMLElement, number>()
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get() { return scrollPositions.get(this) ?? 0 },
    set(value: number) {
      const detachedReader = this.classList.contains('research-pane-body') && !this.isConnected
      scrollPositions.set(this, detachedReader ? 0 : Number(value))
    },
  })
  try {
    const view = render(<MultiPaneFrame executorId={toolDescriptor.executorId} label={toolDescriptor.label} expanded={false} onClose={() => {}}>
      <ResearchAgentPane runId="r" descriptor={toolDescriptor} />
    </MultiPaneFrame>)
    const body = view.container.ownerDocument.querySelector<HTMLElement>('.research-pane-body')!
    expect(body.isConnected).toBe(true)
    await act(() => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())))
    expect(body.scrollTop).toBe(250)
  } finally {
    if (originalScrollTop) Object.defineProperty(HTMLElement.prototype, 'scrollTop', originalScrollTop)
    else delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop
  }
})

it('shows only the tool name and status while closed, then reveals the full local output without a server call', () => {
  const result = ['x'.repeat(2000), ...Array.from({ length: 8 }, (_, index) => `line ${index + 2}`)].join('\n')
  seedTool(result)
  vi.mocked(researchSessionsBridge.content).mockReset()
  const { container } = render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  expect(container.querySelector('pre')).not.toBeInTheDocument()
  expect(screen.queryByText('line 9')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '展开完整输出' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /Read fixture · success/ }))
  expect(container.querySelector('pre')).toHaveTextContent('line 9')
  expect(researchSessionsBridge.content).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /Read fixture · success/ }))
  expect(container.querySelector('pre')).not.toBeInTheDocument()
})

it('persists tool page cursor and loaded body through pane remount, and never refetches offset zero at end', async () => {
  seedTool('🙂', true)
  vi.mocked(researchSessionsBridge.content).mockReset().mockResolvedValueOnce({ content: '🙂中', nextOffset: 2, hasMore: true })
    .mockResolvedValueOnce({ content: '文', nextOffset: null, hasMore: false })
  const first = render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  fireEvent.click(screen.getByRole('button', { name: /Read fixture · success/ }))
  expect(researchSessionsBridge.content).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '展开完整输出' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '继续读取' })).toBeInTheDocument())
  first.unmount()
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  fireEvent.click(screen.getByRole('button', { name: '继续读取' }))
  await waitFor(() => expect(screen.getByText('🙂中文')).toBeInTheDocument())
  expect(researchSessionsBridge.content).toHaveBeenLastCalledWith('r', 'tool-e', 'call-1', 'result', 2, 8192, 'C:/fixture')
  expect(screen.queryByRole('button', { name: /继续读取|展开完整输出/ })).not.toBeInTheDocument()
  expect(researchSessionsBridge.content).toHaveBeenCalledTimes(2)
})

it('guards a pending tool page against repeated clicks', async () => {
  seedTool('preview', true)
  let resolve!: (value: { content: string; nextOffset: number | null; hasMore: boolean }) => void
  vi.mocked(researchSessionsBridge.content).mockReset().mockImplementationOnce(() => new Promise(done => { resolve = done }))
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  fireEvent.click(screen.getByRole('button', { name: /Read fixture · success/ }))
  fireEvent.click(screen.getByRole('button', { name: '展开完整输出' }))
  fireEvent.click(screen.getByRole('button', { name: '展开完整输出' }))
  expect(researchSessionsBridge.content).toHaveBeenCalledTimes(1)
  resolve({ content: 'full', nextOffset: null, hasMore: false })
  await waitFor(() => expect(screen.getByText('full')).toBeInTheDocument())
})

it('keeps failed tool status visible while its output is folded and preserves paging errors after folding', async () => {
  seedTool('permission denied', true)
  const session = useResearchSessionsStore.getState().byExecutor['tool-e']
  useResearchSessionsStore.getState().applyHistory({ runId: 'r', executorId: 'tool-e', messages: [{
    ...session.messages[0], toolCalls: [{ id: 'call-1', name: 'Read fixture', status: 'error', error: 'permission denied', resultTruncated: true }],
  }], nextCursor: null, hasMore: false, availability: 'available', historyVersion: 'v2' })
  vi.mocked(researchSessionsBridge.content).mockRejectedValueOnce(new Error('Page unavailable'))
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  const heading = screen.getByRole('button', { name: /Read fixture · error/ })
  expect(heading).toBeVisible()
  expect(screen.queryByText('permission denied')).not.toBeInTheDocument()
  fireEvent.click(heading)
  expect(screen.getByText('permission denied')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '展开完整输出' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Page unavailable'))
  expect(researchSessionsBridge.content).toHaveBeenCalledWith('r', 'tool-e', 'call-1', 'error', 0, 8192, 'C:/fixture')
  fireEvent.click(heading)
  expect(screen.queryByText('permission denied')).not.toBeInTheDocument()
  expect(screen.getByRole('alert')).toBeVisible()
})

it('separates focus and expansion controls without repeating an equal task title and member label', () => {
  const descriptor = { ...toolDescriptor, label: 'Evidence title', cardTitle: 'Evidence title', isCurrent: false, attempt: 2 }
  const focus = vi.fn()
  const toggle = vi.fn()
  const view = render(<ResearchAgentPane runId="r" descriptor={descriptor} focused onFocus={focus} expanded={false} onToggleExpanded={toggle} />)
  expect(screen.getAllByText('Evidence title')).toHaveLength(1)
  expect(screen.getByText(/历史记录/)).toBeVisible()
  const focusButton = screen.getByRole('button', { name: '聚焦 Evidence title' })
  expect(focusButton.textContent?.match(/Evidence title/g)).toHaveLength(1)
  const expandButton = screen.getByRole('button', { name: '展开会话' })
  expect(expandButton.parentElement?.closest('button')).toBeNull()
  expect(focusButton.closest('header')).toBe(expandButton.closest('header'))
  expect(expandButton).toHaveAttribute('aria-pressed', 'false')
  fireEvent.click(expandButton)
  expect(toggle).toHaveBeenCalledOnce()
  expect(focus).not.toHaveBeenCalled()
  fireEvent.click(focusButton)
  expect(focus).toHaveBeenCalledOnce()
  view.rerender(<ResearchAgentPane runId="r" descriptor={descriptor} expanded onToggleExpanded={toggle} />)
  expect(screen.getByRole('button', { name: '退出展开' })).toHaveAttribute('aria-pressed', 'true')
  view.rerender(<ResearchAgentPane runId="r" descriptor={descriptor} />)
  expect(screen.queryByRole('button', { name: /展开会话|退出展开/ })).not.toBeInTheDocument()
})

it('distinguishes root and node controllers while retaining their native identity', () => {
  const descriptor = { ...toolDescriptor, role: 'last_order' as const, label: 'Last Order' }
  const view = render(<ResearchAgentPane runId="r" descriptor={descriptor} isRootController />)
  expect(screen.getByText('主控')).toBeVisible()
  expect(screen.getAllByText('Last Order')).toHaveLength(1)
  view.rerender(<ResearchAgentPane runId="r" descriptor={descriptor} isRootController={false} />)
  expect(screen.getByText('节点主控')).toBeVisible()
  expect(screen.queryByText('主控')).not.toBeInTheDocument()
})

it('omits only a delimited member-label prefix from the subtitle while preserving native title, history and attempts', () => {
  const label = '成员任务 3'
  const cardTitle = '成员任务 3 · 长上下文跨段整合'
  const descriptor = { ...toolDescriptor, label, cardTitle, isCurrent: false, attempt: 2 }
  const view = render(<ResearchAgentPane runId="r" descriptor={descriptor} />)
  const focus = screen.getByRole('button', { name: '聚焦 成员任务 3' })
  expect(focus.textContent?.match(/成员任务 3/g)).toHaveLength(1)
  expect(screen.getByText(cardTitle)).toBeVisible()
  expect(screen.getByText('历史记录')).toBeVisible()
  expect(screen.getByText(/第 2 次执行/)).toBeVisible()
  view.rerender(<ResearchAgentPane runId="r" descriptor={{ ...descriptor, isCurrent: true, attempt: 1 }} />)
  expect(focus.textContent?.match(/成员任务 3/g)).toHaveLength(1)
  expect(screen.queryByText(/第 1 次执行/)).not.toBeInTheDocument()
  view.rerender(<ResearchAgentPane runId="r" descriptor={{ ...descriptor, attempt: 1 }} />)
  expect(screen.getByText('历史记录')).toBeVisible()
  expect(screen.getByText(/第 1 次执行/)).toBeVisible()
})

it.each([
  ['成员任务 3：长上下文跨段整合', false],
  ['成员任务 3 — 长上下文跨段整合', false],
  ['成员任务 3 | 长上下文跨段整合', false],
  ['成员任务 30 · 长上下文跨段整合', true],
  ['成员任务 3-extra-native-id', true],
  ['长上下文跨段整合 · 成员任务 3', true],
  ['长上下文跨段整合', true],
])('preserves genuinely distinct identity for title %s', (cardTitle, keepSubtitleIdentity) => {
  const { container } = render(<ResearchAgentPane runId="r" descriptor={{ ...toolDescriptor, label: '成员任务 3', cardTitle }} />)
  const subtitle = container.querySelector('.research-pane-title small')
  if (keepSubtitleIdentity) expect(subtitle).toHaveTextContent('成员任务 3')
  else expect(subtitle).toBeNull()
  expect(screen.getByText(cardTitle)).toBeVisible()
})

it('folds a short initial contract task but leaves follow-up questions directly readable', () => {
  const descriptor = { ...toolDescriptor, contract: 'Keep every native task instruction.' }
  useResearchSessionsStore.getState().upsertDescriptors('r', [descriptor])
  useResearchSessionsStore.getState().applyHistory({ runId: 'r', executorId: descriptor.executorId, messages: [
    { id: 'initial', role: 'user', content: 'Initial assigned task.', timestamp: 1 },
    { id: 'response', role: 'assistant', content: 'Checking evidence.', timestamp: 2 },
    { id: 'follow-up', role: 'user', content: 'What changed?', timestamp: 3 },
  ], nextCursor: null, hasMore: false, availability: 'available', historyVersion: 'v1' })
  render(<ResearchAgentPane runId="r" descriptor={descriptor} />)
  const initial = screen.getByText('Initial assigned task.')
  expect(initial.closest('details')).not.toBeNull()
  expect(initial.closest('details')).not.toHaveAttribute('open')
  expect(initial).not.toBeVisible()
  expect(screen.getByText('What changed?')).toBeVisible()
  fireEvent.click(screen.getByText('查看完整研究任务说明'))
  expect(initial).toBeVisible()
})

it('projects canonical assistant blocks into readable prose and reasoning without duplicate tools', () => {
  useResearchSessionsStore.getState().upsertDescriptors('r', [toolDescriptor])
  useResearchSessionsStore.getState().applyHistory({ runId: 'r', executorId: toolDescriptor.executorId, messages: [{
    id: 'canonical', role: 'assistant', content: '', timestamp: 1, blocks: [
      { id: 'b0', contentIndex: 0, type: 'text', text: 'Native block report.' },
      { id: 'b1', contentIndex: 1, type: 'thinking', thinking: 'Native reasoning.' },
      { id: 'b2', contentIndex: 2, type: 'toolCall', toolCall: { id: 'block-tool', name: 'Verify source', status: 'success', result: 'Evidence output.' } },
    ],
  }], nextCursor: null, hasMore: false, availability: 'available', historyVersion: 'v1' })
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  expect(screen.getByText('Native block report.')).toBeVisible()
  const reasoning = screen.getByText('Native reasoning.')
  expect(reasoning).not.toBeVisible()
  fireEvent.click(screen.getByText('思考过程'))
  expect(reasoning).toBeVisible()
  expect(screen.getAllByRole('button', { name: 'Verify source · success' })).toHaveLength(1)
})

it('retains streaming markdown behavior when projecting canonical live assistant blocks', () => {
  useResearchSessionsStore.getState().upsertDescriptors('r', [toolDescriptor])
  useResearchSessionsStore.getState().applySnapshot({ runId: 'r', executorId: toolDescriptor.executorId, sessionId: toolDescriptor.sessionId,
    nodeId: toolDescriptor.nodeId, taskId: toolDescriptor.taskId, generation: 1, attempt: 1, revision: 1, historyVersion: 'v1',
    telemetry: null, error: null, availability: 'available', streaming: {
      id: 'live-canonical', role: 'assistant', content: '', timestamp: 1, isStreaming: true,
      blocks: [{ id: 'live-b0', contentIndex: 0, type: 'text', text: '**Streaming native text', isStreaming: true }],
    } })
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  expect(screen.getByText('Streaming native text', { selector: 'strong' })).toBeVisible()
})

function seedMessages(messages: import('../../types/session').ChatMessage[], extra = {}) {
  useResearchSessionsStore.getState().upsertDescriptors('r', [toolDescriptor])
  useResearchSessionsStore.getState().applyHistory({ runId: 'r', executorId: toolDescriptor.executorId, messages,
    nextCursor: null, hasMore: false, availability: 'available', historyVersion: 'v1', ...extra })
}

it('keeps canonical text, tool and thinking blocks in their original interleaved order', () => {
  seedMessages([{ id: 'ordered', role: 'assistant', content: 'stale compatibility projection', timestamp: 1, blocks: [
    { id: 'o0', contentIndex: 0, type: 'text', text: 'Before first tool.' },
    { id: 'o1', contentIndex: 1, type: 'toolCall', toolCall: { id: 'first', name: 'First evidence', status: 'success' } },
    { id: 'o2', contentIndex: 2, type: 'text', text: 'Between evidence calls.' },
    { id: 'o3', contentIndex: 3, type: 'thinking', thinking: 'Reason after evidence.' },
    { id: 'o4', contentIndex: 4, type: 'toolCall', toolCall: { id: 'second', name: 'Second evidence', status: 'running' } },
    { id: 'o5', contentIndex: 5, type: 'text', text: 'After second tool.' },
  ] }])
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  const ordered = [screen.getByText('Before first tool.'), screen.getByRole('button', { name: 'First evidence · success' }),
    screen.getByText('Between evidence calls.'), screen.getByText('思考过程'),
    screen.getByRole('button', { name: 'Second evidence · running' }), screen.getByText('After second tool.')]
  ordered.slice(1).forEach((element, index) => expect(ordered[index].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy())
  expect(screen.queryByText('stale compatibility projection')).not.toBeInTheDocument()
})

it('reveals every tool field together, formats native content and redacts live arguments and details', () => {
  seedMessages([{ id: 'all-fields', entryId: 'all-entry', role: 'assistant', content: '', timestamp: 1,
    toolCalls: [{ id: 'all-call', name: 'Inspect source', status: 'error', arguments: { query: 'Local evidence', token: 'hidden-argument' },
      partialArguments: 'query=streamed password=hidden-partial', partialResult: [{ type: 'text', text: 'Live evidence.' }],
      result: { content: [{ type: 'text', text: 'Final evidence.' }] }, details: { origin: 'Native fixture', api_key: 'hidden-detail' }, error: 'Permission failed, token=hidden-error' }] }])
  const view = render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  expect(view.container.querySelector('pre')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect source · error' }))
  expect(screen.getByText(/Local evidence/)).toBeVisible()
  expect(screen.getByText(/query=streamed/)).toBeVisible()
  expect(screen.getByText('Live evidence.')).toBeVisible()
  expect(screen.getByText('Final evidence.')).toBeVisible()
  expect(screen.getByText(/Native fixture/)).toBeVisible()
  expect(screen.getByText(/Permission failed/)).toBeVisible()
  expect(view.container.textContent).not.toMatch(/hidden-(argument|partial|detail|error)/)
  expect(screen.getByText(/详情.*预览/)).toBeVisible()
})

it('shows assistant execution errors and incomplete report reasons without suppressing native notices', () => {
  seedMessages([
    { id: 'hidden', role: 'custom', customType: 'research-progress', display: false, content: 'Hidden native notice', timestamp: 1 },
    { id: 'native-progress', role: 'custom', customType: 'research-progress', content: 'Visible scheduling notice', timestamp: 2 },
    { id: 'assistant-error', role: 'assistant', content: 'Partial answer', errorMessage: 'Executor disconnected.', timestamp: 3 },
    { id: 'partial-report', role: 'custom', customType: 'research-final', content: 'Partial report body.', timestamp: 4,
      details: { incomplete: true, reason: 'Evidence not verified.', result: { status: 'stopped', last_error: 'Budget exhausted.' } } },
  ])
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  expect(screen.queryByText('Hidden native notice')).not.toBeInTheDocument()
  expect(screen.getByText('Visible scheduling notice')).toBeVisible()
  expect(screen.getByText('Executor disconnected.')).toBeVisible()
  expect(screen.getByText('不完整报告')).toBeVisible()
  expect(screen.getByText(/Evidence not verified/)).toBeVisible()
  expect(screen.getByText(/Budget exhausted/)).toBeVisible()
})

it('retains ordered multi-text previews and reads the aggregate body in a clearly separate region', async () => {
  seedMessages([{ id: 'multi', entryId: 'multi-entry', role: 'assistant', content: 'Opening preview.Closing preview.', contentTruncated: true, timestamp: 1, blocks: [
    { id: 'multi0', contentIndex: 0, type: 'text', text: 'Opening preview.' },
    { id: 'multi1', contentIndex: 1, type: 'toolCall', toolCall: { id: 'middle-call', name: 'Middle evidence', status: 'success' } },
    { id: 'multi2', contentIndex: 2, type: 'text', text: 'Closing preview.' },
  ] }])
  vi.mocked(researchSessionsBridge.content).mockResolvedValue({ content: 'Opening full body.Closing full body.', nextOffset: null, hasMore: false })
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  const area = screen.getByRole('region', { name: '完整消息正文' })
  expect(within(area).queryByText('Opening preview.')).not.toBeInTheDocument()
  fireEvent.click(within(area).getByRole('button', { name: '读取完整消息' }))
  await waitFor(() => expect(within(area).getByText('Opening full body.Closing full body.')).toBeVisible())
  expect(screen.getByText('Opening preview.')).toBeVisible()
  expect(screen.getByText('Closing preview.')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Middle evidence · success' }).compareDocumentPosition(area) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it('catches up past a native 32KiB CJK/emoji preview on the first read without shrink or duplicate text', async () => {
  const full = '开端🙂中文'.repeat(3200) + '尾声'
  const characters = Array.from(full)
  const encoder = new TextEncoder()
  const characterBytes = characters.map(character => encoder.encode(character).length)
  const pageAt = (offset: number, budget: number) => {
    let content = '', next = offset, used = 0
    while (next < characters.length && used + characterBytes[next] <= budget) {
      used += characterBytes[next]
      content += characters[next++]
    }
    return { content, nextOffset: next < characters.length ? next : null, hasMore: next < characters.length }
  }
  const preview = pageAt(0, 32768).content
  seedMessages([{ id: 'native-long', entryId: 'native-long-entry', role: 'assistant', content: preview, contentTruncated: true, timestamp: 1 }])
  vi.mocked(researchSessionsBridge.content).mockImplementation(async (_run, _executor, _entry, _field, offset = 0, limit = 8192) => pageAt(offset, limit))
  const view = render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  const renderedBody = () => view.container.querySelector('.research-message .conversation-markdown')!.textContent!
  fireEvent.click(screen.getByRole('button', { name: '读取完整消息' }))
  expect(renderedBody()).toBe(preview)
  await waitFor(() => expect(renderedBody().length).toBeGreaterThan(preview.length))
  expect(renderedBody()).toBe(full.slice(0, renderedBody().length))
  expect(researchSessionsBridge.content).toHaveBeenCalledTimes(5)
  for (let index = 0; index < 5 && screen.queryByRole('button', { name: '读取完整消息' }); index++) {
    fireEvent.click(screen.getByRole('button', { name: '读取完整消息' }))
    await waitFor(() => {
      const button = screen.queryByRole('button', { name: '读取完整消息' })
      if (button) expect(button).not.toBeDisabled()
    })
  }
  await waitFor(() => expect(renderedBody()).toBe(full))
  expect(screen.getByText('完整消息已读取')).toBeVisible()
  const calls = vi.mocked(researchSessionsBridge.content).mock.calls
  expect(calls[1][4]).toBe(pageAt(0, 8192).nextOffset)
  expect(calls[1][4]).not.toBe(pageAt(0, 8192).content.length)
})

it('preserves a truncated preview on empty reads and exposes an in-place retry', async () => {
  seedMessages([{ id: 'empty-page', entryId: 'empty-entry', role: 'assistant', content: 'Keep this preview.', contentTruncated: true, timestamp: 1 }])
  vi.mocked(researchSessionsBridge.content).mockResolvedValueOnce({ content: '', nextOffset: null, hasMore: false })
    .mockResolvedValueOnce({ content: 'Keep this preview. Completed.', nextOffset: null, hasMore: false })
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  fireEvent.click(screen.getByRole('button', { name: '读取完整消息' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/空内容/))
  expect(screen.getByText('Keep this preview.')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '重试读取完整消息' }))
  await waitFor(() => expect(screen.getByText('Keep this preview. Completed.')).toBeVisible())
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('reports a stalled server cursor without duplicating or replacing the original preview', async () => {
  seedMessages([{ id: 'stalled', entryId: 'stalled-entry', role: 'assistant', content: 'Stable preview.', contentTruncated: true, timestamp: 1 }])
  vi.mocked(researchSessionsBridge.content).mockResolvedValue({ content: 'Stable', nextOffset: 0, hasMore: true })
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  fireEvent.click(screen.getByRole('button', { name: '读取完整消息' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/游标/))
  expect(screen.getByText('Stable preview.')).toBeVisible()
  expect(screen.getByRole('button', { name: '重试读取完整消息' })).toBeEnabled()
})

it('shares an in-flight message page across pane remounts rather than requesting it twice', async () => {
  seedMessages([{ id: 'pending-message', entryId: 'pending-entry', role: 'assistant', content: 'Pending preview.', contentTruncated: true, timestamp: 1 }])
  let resolve!: (value: { content: string; nextOffset: number | null; hasMore: boolean }) => void
  const pending = new Promise<{ content: string; nextOffset: number | null; hasMore: boolean }>(done => { resolve = done })
  vi.mocked(researchSessionsBridge.content).mockImplementation(() => pending)
  const first = render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  fireEvent.click(screen.getByRole('button', { name: '读取完整消息' }))
  first.unmount()
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  fireEvent.click(screen.getByRole('button', { name: '读取完整消息' }))
  await act(async () => { resolve({ content: 'Pending preview. Completed.', nextOffset: null, hasMore: false }); await pending })
  expect(screen.getByText('Pending preview. Completed.')).toBeVisible()
  expect(researchSessionsBridge.content).toHaveBeenCalledTimes(1)
})

it('labels unsupported truncated thinking as a preview instead of offering a wrong-field read', () => {
  const message = { id: 'thought-preview', role: 'assistant' as const, content: 'Answer.', thinking: 'Thought preview.', thinkingTruncated: true, timestamp: 1 }
  seedMessages([message])
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  fireEvent.click(screen.getByText('思考过程'))
  expect(screen.getByText(/思考.*预览/)).toBeVisible()
  expect(screen.getByText('Thought preview.')).toBeVisible()
  expect(researchSessionsBridge.content).not.toHaveBeenCalled()
})

it('keeps result, arguments and error pagination buffers independent for the same tool', async () => {
  const tool = { id: 'independent-call', name: 'Independent fields', status: 'error' as const,
    arguments: { query: 'args preview' }, argumentsTruncated: true, result: 'result preview', resultTruncated: true,
    error: 'error preview', errorTruncated: true }
  seedMessages([{ id: 'independent', entryId: 'independent-entry', role: 'assistant', content: '', timestamp: 1, toolCalls: [tool] }])
  vi.mocked(researchSessionsBridge.content).mockImplementation(async (_run, _executor, _entry, field) => ({ content: `${field} authoritative complete`, nextOffset: null, hasMore: false }))
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  fireEvent.click(screen.getByRole('button', { name: 'Independent fields · error' }))
  fireEvent.click(screen.getByRole('button', { name: '读取完整参数' }))
  await waitFor(() => expect(screen.getByText('arguments authoritative complete')).toBeVisible())
  expect(screen.getByText('result preview')).toBeVisible()
  expect(screen.getByText('error preview')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '展开完整输出' }))
  await waitFor(() => expect(screen.getByText('result authoritative complete')).toBeVisible())
  fireEvent.click(screen.getByRole('button', { name: '读取完整工具错误' }))
  await waitFor(() => expect(screen.getByText('error authoritative complete')).toBeVisible())
  expect(screen.getByText('arguments authoritative complete')).toBeVisible()
  expect(screen.getByText('result authoritative complete')).toBeVisible()
  expect(researchSessionsBridge.content).toHaveBeenCalledTimes(3)
})

it('ignores late pages after executor identity changes even when an entry id is reused', async () => {
  seedMessages([{ id: 'late', entryId: 'reused-entry', role: 'assistant', content: 'Old preview', contentTruncated: true, timestamp: 1 }])
  let resolve!: (value: { content: string; nextOffset: number | null; hasMore: boolean }) => void
  vi.mocked(researchSessionsBridge.content).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    .mockResolvedValueOnce({ content: 'New preview completed', nextOffset: null, hasMore: false })
  const view = render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  fireEvent.click(screen.getByRole('button', { name: '读取完整消息' }))
  const nextDescriptor = { ...toolDescriptor, generation: 2, sessionId: 'replacement-session' }
  act(() => {
    useResearchSessionsStore.getState().upsertDescriptors('r', [nextDescriptor])
    useResearchSessionsStore.getState().applyHistory({ runId: 'r', executorId: nextDescriptor.executorId,
      messages: [{ id: 'late', entryId: 'reused-entry', role: 'assistant', content: 'New preview', contentTruncated: true, timestamp: 2 }],
      nextCursor: null, hasMore: false, availability: 'available', historyVersion: 'v2' })
  })
  view.rerender(<ResearchAgentPane runId="r" descriptor={nextDescriptor} />)
  await act(async () => { resolve({ content: 'Old late content', nextOffset: null, hasMore: false }); await Promise.resolve() })
  expect(screen.queryByText('Old late content')).not.toBeInTheDocument()
  expect(Object.values(useResearchSessionsStore.getState().byExecutor[toolDescriptor.executorId].previews)).not.toContain('Old late content')
  fireEvent.click(screen.getByRole('button', { name: '读取完整消息' }))
  await waitFor(() => expect(screen.getByText('New preview completed')).toBeVisible())
})

it('preserves the visible content anchor while older history is prepended', async () => {
  seedMessages([{ id: 'current', entryId: 'current-entry', role: 'assistant', content: 'Current visible paragraph.', timestamp: 2 }], { hasMore: true, nextCursor: 'v1@1' })
  const view = render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  const body = view.container.querySelector<HTMLElement>('.research-pane-body')!
  let historyAdded = false
  Object.defineProperties(body, { scrollHeight: { get: () => historyAdded ? 1400 : 1000 }, clientHeight: { value: 200 } })
  const current = screen.getByText('Current visible paragraph.')
  vi.spyOn(body, 'getBoundingClientRect').mockImplementation(() => ({ top: 0, bottom: 200, left: 0, right: 500, width: 500, height: 200, x: 0, y: 0, toJSON() {} }))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this.contains(current) ? (historyAdded ? 500 : 100) - body.scrollTop : 0
    return { top, bottom: top + 150, left: 0, right: 500, width: 500, height: 150, x: 0, y: top, toJSON() {} }
  })
  body.scrollTop = 100
  fireEvent.scroll(body)
  vi.mocked(researchSessionsBridge.history).mockImplementation(async () => {
    historyAdded = true
    const page: import('../../types/research').ResearchSessionHistory = { runId: 'r', executorId: toolDescriptor.executorId, messages: [{ id: 'older', role: 'assistant', content: 'Older paragraph.', timestamp: 1 }],
      nextCursor: null, hasMore: false, availability: 'available', historyVersion: 'v1', direction: 'older' as const }
    useResearchSessionsStore.getState().applyHistory(page, true)
    return page
  })
  fireEvent.click(screen.getByRole('button', { name: '读取更多历史' }))
  await waitFor(() => expect(screen.getByText('Older paragraph.')).toBeVisible())
  await waitFor(() => expect(body.scrollTop).toBe(500))
  expect(useResearchWorkspaceStore.getState().byRun.r.reading[toolDescriptor.executorId]).toEqual({ scrollTop: 500, following: false })
})

it('hydrates legacy result cursors and folds without sharing their buffer with tool arguments', async () => {
  seedTool('🙂', true)
  useResearchSessionsStore.getState().setPreview(toolDescriptor.executorId, 'tool-entry:call-1', '🙂中', 2)
  useResearchSessionsStore.getState().setFold(toolDescriptor.executorId, 'tool-entry:call-1', true)
  vi.mocked(researchSessionsBridge.content).mockResolvedValue({ content: '文', nextOffset: null, hasMore: false })
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  expect(screen.getByText('🙂中')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '继续读取' }))
  await waitFor(() => expect(screen.getByText('🙂中文')).toBeVisible())
  expect(researchSessionsBridge.content).toHaveBeenCalledWith('r', 'tool-e', 'call-1', 'result', 2, 8192, 'C:/fixture')
  expect(useResearchSessionsStore.getState().byExecutor['tool-e'].folds['tool-entry:call-1']).toBe(true)
  expect(useResearchSessionsStore.getState().byExecutor['tool-e'].previews['tool-entry:call-1']).toBe('🙂中文')
})

it.each([true, undefined])('hydrates legacy tool-error content and resumes its codepoint cursor (errorTruncated=%s)', async errorTruncated => {
  const tool = { id: 'legacy-error-call', name: 'Legacy error', status: 'error' as const, error: '🙂', resultTruncated: true, errorTruncated }
  seedMessages([{ id: 'legacy-error-message', entryId: 'legacy-error-entry', role: 'assistant', content: '', timestamp: 1, toolCalls: [tool] }])
  useResearchSessionsStore.getState().setPreview(toolDescriptor.executorId, 'legacy-error-entry:legacy-error-call', '🙂中', 2)
  useResearchSessionsStore.getState().setFold(toolDescriptor.executorId, 'legacy-error-entry:legacy-error-call', true)
  vi.mocked(researchSessionsBridge.content).mockResolvedValue({ content: '文', nextOffset: null, hasMore: false })
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  const error = screen.getByRole('region', { name: '工具错误' })
  expect(within(error).getByText('🙂中')).toBeVisible()
  fireEvent.click(within(error).getByRole('button', { name: '继续读取工具错误' }))
  await waitFor(() => expect(within(error).getByText('🙂中文')).toBeVisible())
  expect(researchSessionsBridge.content).toHaveBeenCalledWith('r', 'tool-e', 'legacy-error-call', 'error', 2, 8192, 'C:/fixture')
  expect(useResearchSessionsStore.getState().byExecutor['tool-e'].previews['legacy-error-entry:legacy-error-call']).toBe('🙂中文')
})

it('preserves a completed legacy tool-error cache without offering or requesting offset zero again', () => {
  const tool = { id: 'legacy-complete-call', name: 'Legacy complete error', status: 'error' as const, error: '🙂', errorTruncated: true }
  seedMessages([{ id: 'legacy-complete-message', entryId: 'legacy-complete-entry', role: 'assistant', content: '', timestamp: 1, toolCalls: [tool] }])
  useResearchSessionsStore.getState().setPreview(toolDescriptor.executorId, 'legacy-complete-entry:legacy-complete-call', '🙂中文', null)
  useResearchSessionsStore.getState().setFold(toolDescriptor.executorId, 'legacy-complete-entry:legacy-complete-call', true)
  const view = render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  const error = screen.getByRole('region', { name: '工具错误' })
  expect(within(error).getByText('🙂中文')).toBeVisible()
  expect(within(error).getByText('完整工具错误已读取')).toBeVisible()
  expect(within(error).queryByRole('button')).not.toBeInTheDocument()
  view.unmount()
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  expect(screen.getByText('🙂中文')).toBeVisible()
  expect(researchSessionsBridge.content).not.toHaveBeenCalled()
})

it('migrates the old shared tool cache only into error when result and arguments also have pages', async () => {
  const tool = { id: 'legacy-mixed-call', name: 'Legacy mixed fields', status: 'error' as const, arguments: { query: 'argument preview' },
    argumentsTruncated: true, result: 'result preview', resultTruncated: true, error: '🙂', errorTruncated: true }
  seedMessages([{ id: 'legacy-mixed-message', entryId: 'legacy-mixed-entry', role: 'assistant', content: '', timestamp: 1, toolCalls: [tool] }])
  useResearchSessionsStore.getState().setPreview(toolDescriptor.executorId, 'legacy-mixed-entry:legacy-mixed-call', '🙂中', 2)
  useResearchSessionsStore.getState().setFold(toolDescriptor.executorId, 'legacy-mixed-entry:legacy-mixed-call', true)
  vi.mocked(researchSessionsBridge.content).mockImplementation(async (_run, _executor, _entry, field) => ({
    content: field === 'error' ? '文' : `${field} completed independently`, nextOffset: null, hasMore: false,
  }))
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  const error = screen.getByRole('region', { name: '工具错误' })
  expect(within(error).getByText('🙂中')).toBeVisible()
  expect(screen.getByText('result preview')).toBeVisible()
  expect(screen.getByText(/argument preview/)).toBeVisible()
  fireEvent.click(within(error).getByRole('button', { name: '继续读取工具错误' }))
  await waitFor(() => expect(within(error).getByText('🙂中文')).toBeVisible())
  fireEvent.click(screen.getByRole('button', { name: '展开完整输出' }))
  await waitFor(() => expect(screen.getByText('result completed independently')).toBeVisible())
  fireEvent.click(screen.getByRole('button', { name: '读取完整参数' }))
  await waitFor(() => expect(screen.getByText('arguments completed independently')).toBeVisible())
  expect(within(error).getByText('🙂中文')).toBeVisible()
  expect(researchSessionsBridge.content).toHaveBeenNthCalledWith(1, 'r', 'tool-e', 'legacy-mixed-call', 'error', 2, 8192, 'C:/fixture')
  expect(researchSessionsBridge.content).toHaveBeenNthCalledWith(2, 'r', 'tool-e', 'legacy-mixed-call', 'result', 0, 8192, 'C:/fixture')
  expect(researchSessionsBridge.content).toHaveBeenNthCalledWith(3, 'r', 'tool-e', 'legacy-mixed-call', 'arguments', 0, 8192, 'C:/fixture')
})

it('hydrates an existing body preview and its authoritative cursor without rereading offset zero', async () => {
  seedMessages([{ id: 'legacy-body', entryId: 'legacy-entry', role: 'assistant', content: '🙂', contentTruncated: true, timestamp: 1 }])
  useResearchSessionsStore.getState().setPreview(toolDescriptor.executorId, 'content:legacy-entry', '🙂中', 2)
  vi.mocked(researchSessionsBridge.content).mockResolvedValue({ content: '文', nextOffset: null, hasMore: false })
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  expect(screen.getByText('🙂中')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '读取完整消息' }))
  await waitFor(() => expect(screen.getByText('🙂中文')).toBeVisible())
  expect(researchSessionsBridge.content).toHaveBeenCalledWith('r', 'tool-e', 'legacy-entry', 'content', 2, 8192, 'C:/fixture')
})

it('does not let a completed legacy mirror mask a changed native field preview', async () => {
  seedTool('old preview', true)
  vi.mocked(researchSessionsBridge.content).mockResolvedValueOnce({ content: 'old preview completed', nextOffset: null, hasMore: false })
    .mockResolvedValueOnce({ content: 'new preview completed', nextOffset: null, hasMore: false })
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  fireEvent.click(screen.getByRole('button', { name: 'Read fixture · success' }))
  fireEvent.click(screen.getByRole('button', { name: '展开完整输出' }))
  await waitFor(() => expect(screen.getByText('old preview completed')).toBeVisible())
  act(() => {
    const current = useResearchSessionsStore.getState().byExecutor['tool-e'].messages[0]
    useResearchSessionsStore.getState().applyHistory({ runId: 'r', executorId: 'tool-e', messages: [{ ...current,
      toolCalls: [{ id: 'call-1', name: 'Read fixture', status: 'success', result: 'new preview', resultTruncated: true }] }],
      nextCursor: null, hasMore: false, availability: 'available', historyVersion: 'v2' })
  })
  expect(screen.getByText('new preview')).toBeVisible()
  expect(screen.queryByText('old preview completed')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '展开完整输出' }))
  await waitFor(() => expect(screen.getByText('new preview completed')).toBeVisible())
})

it('ignores a history-operation anchor after switching the pane to a different run', async () => {
  seedMessages([{ id: 'old-run', role: 'assistant', content: 'Old run paragraph.', timestamp: 1 }], { hasMore: true, nextCursor: 'v1@1' })
  let resolve!: (page: import('../../types/research').ResearchSessionHistory) => void
  const page = new Promise<import('../../types/research').ResearchSessionHistory>(done => { resolve = done })
  vi.mocked(researchSessionsBridge.history).mockReturnValue(page)
  const view = render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  const body = view.container.querySelector<HTMLElement>('.research-pane-body')!
  Object.defineProperties(body, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } })
  body.scrollTop = 100
  fireEvent.scroll(body)
  fireEvent.click(screen.getByRole('button', { name: '读取更多历史' }))
  const nextDescriptor = { ...toolDescriptor, sessionId: 'other-run-session' }
  act(() => {
    useResearchSessionsStore.getState().upsertDescriptors('other-run', [nextDescriptor])
    useResearchWorkspaceStore.getState().setReading('other-run', nextDescriptor.executorId, { scrollTop: 70, following: false })
    useResearchSessionsStore.getState().applyHistory({ runId: 'other-run', executorId: nextDescriptor.executorId,
      messages: [{ id: 'new-run', role: 'assistant', content: 'New run paragraph.', timestamp: 1 }], nextCursor: null, hasMore: false, availability: 'available', historyVersion: 'v1' })
  })
  view.rerender(<ResearchAgentPane runId="other-run" descriptor={nextDescriptor} />)
  expect(body.scrollTop).toBe(70)
  await act(async () => { resolve({ runId: 'r', executorId: toolDescriptor.executorId, messages: [], nextCursor: null, hasMore: false, availability: 'available', historyVersion: 'v1' }); await page })
  await new Promise(done => window.requestAnimationFrame(done))
  expect(body.scrollTop).toBe(70)
})

it('does not keep a new run loading or expose an old history failure after a switch', async () => {
  seedMessages([{ id: 'old-history', role: 'assistant', content: 'Old history.', timestamp: 1 }], { hasMore: true, nextCursor: 'v1@1' })
  let reject!: (failure: Error) => void
  const pending = new Promise<import('../../types/research').ResearchSessionHistory>((_resolve, fail) => { reject = fail })
  vi.mocked(researchSessionsBridge.history).mockReturnValue(pending)
  const view = render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  fireEvent.click(screen.getByRole('button', { name: '读取更多历史' }))
  const next = { ...toolDescriptor, sessionId: 'new-history-session' }
  act(() => {
    useResearchSessionsStore.getState().upsertDescriptors('next-run', [next])
    useResearchSessionsStore.getState().applyHistory({ runId: 'next-run', executorId: next.executorId,
      messages: [{ id: 'new-history', role: 'assistant', content: 'New history.', timestamp: 1 }],
      nextCursor: 'v1@1', hasMore: true, availability: 'available', historyVersion: 'v1' })
  })
  view.rerender(<ResearchAgentPane runId="next-run" descriptor={next} />)
  await act(async () => { reject(new Error('Old history failure')); await pending.catch(() => {}) })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '读取更多历史' })).toBeEnabled()
})

it('keeps the visible block anchored when a tool expands above it and follows only in following mode', async () => {
  seedMessages([{ id: 'disclosure-anchor', role: 'assistant', content: '', timestamp: 1, blocks: [
    { id: 'above-tool', contentIndex: 0, type: 'toolCall', toolCall: { id: 'above', name: 'Above viewport', status: 'success', result: 'Expanded tool output.' } },
    { id: 'visible-text', contentIndex: 1, type: 'text', text: 'Keep this block in place.' },
  ] }])
  const view = render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  const body = view.container.querySelector<HTMLElement>('.research-pane-body')!
  const expanded = () => Boolean(view.container.querySelector('.research-tool-fields'))
  Object.defineProperties(body, { scrollHeight: { get: () => expanded() ? 1250 : 1000 }, clientHeight: { value: 200 } })
  const visible = screen.getByText('Keep this block in place.')
  vi.spyOn(body, 'getBoundingClientRect').mockImplementation(() => ({ top: 0, bottom: 200, left: 0, right: 500, width: 500, height: 200, x: 0, y: 0, toJSON() {} }))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this.contains(visible) ? (expanded() ? 450 : 200) - body.scrollTop : -500
    return { top, bottom: top + 100, left: 0, right: 500, width: 500, height: 100, x: 0, y: top, toJSON() {} }
  })
  body.scrollTop = 200
  fireEvent.scroll(body)
  fireEvent.click(screen.getByRole('button', { name: 'Above viewport · success' }))
  await waitFor(() => expect(body.scrollTop).toBe(450))
  body.scrollTop = 1050
  fireEvent.scroll(body)
  expect(useResearchWorkspaceStore.getState().byRun.r.reading[toolDescriptor.executorId].following).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Above viewport · success' }))
  expect(body.scrollTop).toBe(1000)
})

it('repairs markdown only in the actual streaming canonical text block', () => {
  seedMessages([{ id: 'per-block-streaming', role: 'assistant', content: '', isStreaming: true, timestamp: 1, blocks: [
    { id: 'static-block', type: 'text', contentIndex: 0, text: '**Finished but unclosed', isStreaming: false },
    { id: 'streaming-block', type: 'text', contentIndex: 1, text: '**Currently streaming', isStreaming: true },
  ] }])
  render(<ResearchAgentPane runId="r" descriptor={toolDescriptor} />)
  expect(screen.getByText('**Finished but unclosed').tagName).toBe('P')
  expect(screen.getByText('Currently streaming').closest('strong')).toBeInTheDocument()
})
