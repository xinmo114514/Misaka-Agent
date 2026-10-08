import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MessageItem } from '../MessageItem'
import { Timeline } from '../Timeline'
import { useSessionStore } from '../../../store/useSessionStore'
import { MarkdownContent } from '../MarkdownContent'
import { ThinkingBlock } from '../ThinkingBlock'
import { ToolCallCard } from '../ToolCallCard'
import { useSettingsStore } from '../../../store/useSettingsStore'
import type { ChatMessage } from '../../../types/session'

afterEach(cleanup)
beforeEach(() => {
  useSettingsStore.setState({ hideThinkingBlock: false })
  useSessionStore.setState({ currentSessionPath: null })
})
const base = { id: 'answer', role: 'assistant', content: 'legacy combined', timestamp: 1 } as ChatMessage

describe('ordered conversation blocks', () => {
  it('keeps prose before and after a tool in the actual DOM', () => {
    const { container } = render(<MessageItem message={{ ...base, blocks: [
      { type: 'text', id: 'intro', contentIndex: 0, text: '先查资料' },
      { type: 'toolCall', id: 'lookup', contentIndex: 1, toolCall: { id: 'lookup', name: '搜索资料', status: 'success' } },
      { type: 'text', id: 'answer', contentIndex: 2, text: '然后回答' },
    ] } as ChatMessage} />)
    expect(container.textContent).toMatch(/先查资料[\s\S]*搜索资料[\s\S]*然后回答/)
    expect(screen.queryByText('legacy combined')).not.toBeInTheDocument()
  })

  it('retains an expanded execution group while more tools arrive', () => {
    const first = { type: 'toolCall', id: 'first', contentIndex: 0, toolCall: { id: 'first', name: 'read', status: 'success' } }
    const { rerender } = render(<MessageItem message={{ ...base, blocks: [first] } as ChatMessage} />)
    const toggle = screen.getByRole('button', { name: /执行记录/ })
    // Default rows stay visible; exercise both explicit collapse and reopen.
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    rerender(<MessageItem message={{ ...base, blocks: [first, { type: 'toolCall', id: 'second', contentIndex: 1, toolCall: { id: 'second', name: 'write', status: 'running' } }] } as ChatMessage} />)
    expect(screen.getByRole('button', { name: /执行记录/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /write/ })).toBeVisible()
  })
})

it('renders image content retained by an opened user-message history row', () => {
  const message: ChatMessage = {
    id: 'image-user', entryId: 'image-entry', role: 'user', content: '检查图表', timestamp: 1,
    images: [{ type: 'image', mimeType: 'image/png', data: 'cG5n', name: 'chart.png' }],
  }
  render(<MessageItem message={message} />)
  expect(screen.getByRole('img', { name: '附件图片：chart.png' })).toHaveAttribute('src', 'data:image/png;base64,cG5n')
})

describe('thinking lifecycle', () => {
  it('opens while the segment streams and closes when that segment completes', () => {
    const { rerender } = render(<ThinkingBlock thinking="推理步骤" isStreaming />)
    expect(screen.getByRole('button', { name: /深度思考/ })).toHaveAttribute('aria-expanded', 'true')
    rerender(<ThinkingBlock thinking="推理步骤" isStreaming={false} />)
    expect(screen.getByRole('button', { name: /深度思考/ })).toHaveAttribute('aria-expanded', 'false')
  })
  it('retains a manual collapse during streaming updates', () => {
    const { rerender } = render(<ThinkingBlock thinking="开始" isStreaming />)
    fireEvent.click(screen.getByRole('button', { name: /深度思考/ }))
    rerender(<ThinkingBlock thinking="继续思考" isStreaming />)
    expect(screen.getByRole('button', { name: /深度思考/ })).toHaveAttribute('aria-expanded', 'false')
  })
  it('respects the hide-thinking preference even during generation', () => {
    useSettingsStore.setState({ hideThinkingBlock: true })
    render(<ThinkingBlock thinking="隐藏的思路" isStreaming />)
    expect(screen.getByRole('button', { name: /深度思考/ })).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('tool details', () => {
  it('does not serialize a folded tool result until it is expanded', () => {
    const serialize = vi.fn(() => 'large output')
    render(<ToolCallCard toolCall={{ id: 'lazy-result', name: 'read', status: 'success', result: { toJSON: serialize } }} />)
    expect(serialize).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /read.*完成/ }))
    expect(serialize).toHaveBeenCalledTimes(1)
    expect(screen.getByText('"large output"')).toBeVisible()
  })
  it('shows failure, normalized partial output, parameters, and the actual error', () => {
    render(<ToolCallCard toolCall={{ id: 'failed', name: 'fetch', status: 'error', arguments: { q: '中文' }, partialResult: { content: [{ type: 'text', text: '收到部分资料' }] }, error: '连接超时' }} />)
    const toggle = screen.getByRole('button', { name: /fetch.*失败/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(screen.getByText('连接超时')).toBeVisible()
    expect(screen.getByText('收到部分资料')).toBeVisible()
    expect(screen.getByText(/"q": "中文"/)).toBeVisible()
    expect(screen.queryByText(/"type": "text"/)).not.toBeInTheDocument()
  })
})

it('preserves a manual tool disclosure after a virtualized row remounts', () => {
  useSessionStore.setState({ currentSessionPath: 'disclosure-remount.jsonl' })
  const toolCall = { id: 'persistent-tool', name: 'read', status: 'success' as const, result: '工具内容' }
  const first = render(<ToolCallCard toolCall={toolCall} />)
  fireEvent.click(screen.getByRole('button', { name: /read.*完成/ }))
  first.unmount()
  render(<ToolCallCard toolCall={toolCall} />)
  expect(screen.getByRole('button', { name: /read.*完成/ })).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('工具内容')).toBeVisible()
})

it('keeps thinking disclosure when a live message gets persisted and its DOM identity changes', () => {
  useSessionStore.setState({ currentSessionPath: 'live-to-history.jsonl' })
  const live = { ...base, id: 'live-answer', blocks: [{ type: 'thinking' as const, id: 'live-thought', contentIndex: 0, thinking: '继续阅读思考', isStreaming: true }] }
  const first = render(<MessageItem message={live} />)
  const toggle = screen.getByRole('button', { name: /深度思考过程/ })
  fireEvent.click(toggle); fireEvent.click(toggle)
  first.rerender(<MessageItem message={{ ...live, entryId: 'durable-entry', blocks: [{ ...live.blocks[0], isStreaming: false }] }} />)
  first.unmount()
  render(<MessageItem message={{ ...live, id: 'saved-answer', entryId: 'durable-entry', blocks: [{ ...live.blocks[0], id: 'saved-thought', isStreaming: false }] }} />)
  expect(screen.getByRole('button', { name: /深度思考过程/ })).toHaveAttribute('aria-expanded', 'true')
})

it('migrates offscreen collapsed-group choices when entry persistence arrives', () => {
  const live = { ...base, id: 'offscreen-live', blocks: [{ type: 'thinking' as const, id: 'offscreen-thought', contentIndex: 0, thinking: '离屏阅读思考', isStreaming: true }] }
  useSessionStore.setState({ currentSessionPath: 'offscreen-persistence.jsonl', currentSessionId: 'offscreen', messages: [live], lastEventSeq: 0, sessionLoadError: null, isSessionLoading: false })
  const first = render(<MessageItem message={live} />)
  const thinking = screen.getByRole('button', { name: /深度思考过程/ })
  fireEvent.click(thinking); fireEvent.click(thinking)
  fireEvent.click(screen.getByRole('button', { name: /执行记录/ }))
  first.unmount()
  act(() => useSessionStore.getState().handleBridgeMessage({ seq: 1, sessionId: 'offscreen', event: { type: 'entry_appended', entry: { type: 'message', id: 'saved-offscreen', message: { role: 'assistant', timestamp: 1 } } } }))
  render(<MessageItem message={{ ...live, id: 'saved-answer', entryId: 'saved-offscreen', blocks: [{ ...live.blocks[0], id: 'durable-thought', isStreaming: false }] }} />)
  const group = screen.getByRole('button', { name: /执行记录/ })
  expect(group).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(group)
  expect(screen.getByRole('button', { name: /深度思考过程/ })).toHaveAttribute('aria-expanded', 'true')
})

it('bounds mounted history for a 500-message conversation', () => {
  useSessionStore.setState({ currentSessionPath: 'large-render.jsonl', messages: Array.from({ length: 500 }, (_, i) => ({ ...base, id: `large-${i}`, content: `历史 ${i}` })) })
  const { container } = render(<Timeline />)
  expect(container.querySelectorAll('[data-message-anchor]').length).toBeLessThan(40)
  expect(container.querySelectorAll('[data-message-anchor]').length).toBeGreaterThan(0)
})

describe('real Markdown rendering', () => {
  it('renders Chinese aligned tables with escaped pipes as semantic tables', () => {
    render(<MarkdownContent content={'| 名称 | 数值 |\n| :--- | ---: |\n| 中文\\|内容 | 12 |'} />)
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '中文|内容' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '12' })).toHaveStyle({ textAlign: 'right' })
  })
  it('preserves nested lists, task checkboxes and strikethrough', () => {
    const { container } = render(<MarkdownContent content={'- 第一层\n  - 第二层\n\n- [x] 已完成\n- [ ] 待办\n\n~~旧结论~~'} />)
    expect(container.querySelector('ul ul')).toBeInTheDocument()
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(screen.getAllByRole('checkbox')[0]).toBeChecked()
    expect(container.querySelector('del')).toHaveTextContent('旧结论')
  })
  it('renders an unfinished streamed fence with a copy control, then a completed static answer', () => {
    const { rerender } = render(<MarkdownContent content={'```python\nprint("中文")'} isStreaming />)
    expect(screen.getByRole('button', { name: /复制/ })).toBeInTheDocument()
    expect(screen.getByText('print("中文")')).toBeInTheDocument()
    rerender(<MarkdownContent content={'```python\nprint("中文")\n```\n\n完成'} isStreaming={false} />)
    expect(screen.getByText('完成')).toBeVisible()
  })
  it('opens HTTP links through the desktop bridge and excludes raw HTML', () => {
    const openExternal = vi.fn()
    Object.defineProperty(window, 'app', { configurable: true, value: { openExternal } })
    const { container } = render(<MarkdownContent content={'[资料](https://example.com)\n\n<img src="x" onerror="alert(1)">\n\n[坏链接](javascript:alert%281%29)'} />)
    fireEvent.click(screen.getByRole('link', { name: '资料' }))
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')
    expect(container.querySelector('img')).not.toBeInTheDocument()
    expect(container.querySelector('a[href^="javascript:"]')).not.toBeInTheDocument()
  })
})



it('drops raw HTML tags rather than interpreting them as Markdown elements', () => {
  const { container } = render(<MarkdownContent content={'<b>raw html</b>\n\n**Markdown bold**'} />)
  expect(container.querySelector('b')).not.toBeInTheDocument()
  expect(screen.getByText('Markdown bold').tagName).toBe('STRONG')
})

it('repairs incomplete syntax only for the actual streaming text segment', () => {
  render(<MessageItem message={{ ...base, isStreaming: true, blocks: [
    { type: 'text', id: 'completed', contentIndex: 0, text: '**已完成但未闭合', isStreaming: false },
    { type: 'text', id: 'current', contentIndex: 1, text: '**正在生成', isStreaming: true },
  ] }} />)
  expect(screen.getByText('**已完成但未闭合').tagName).toBe('P')
  expect(screen.getByText('正在生成').closest('strong')).toBeInTheDocument()
})

it('does not follow incoming content when the reader has scrolled up', () => {
  useSessionStore.setState({ messages: [{ ...base, content: '历史记录' }], currentSessionPath: 'scroll-test' })
  render(<Timeline />)
  const viewport = screen.getByLabelText('对话记录')
  let height = 1200
  Object.defineProperties(viewport, { scrollHeight: { get: () => height }, clientHeight: { get: () => 500 } })
  viewport.scrollTop = 200
  fireEvent.scroll(viewport)
  height = 1400
  act(() => useSessionStore.setState({ messages: [{ ...base, content: '历史记录增加内容' }] }))
  expect(viewport.scrollTop).toBe(200)
  expect(screen.getByRole('button', { name: '回到底部' })).toBeVisible()
})

it('keeps the visible paragraph anchored when historical details expand above it', () => {
  let resize: (() => void) | undefined
  const PreviousObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { resize = () => callback([], this as unknown as ResizeObserver) }
    observe() {} unobserve() {} disconnect() {}
  } as unknown as typeof ResizeObserver
  try {
    useSessionStore.setState({ messages: [{ ...base, blocks: [
      { type: 'toolCall', id: 'history', contentIndex: 0, toolCall: { id: 'history', name: 'read', status: 'success', result: 'long output' } },
      { type: 'text', id: 'visible', contentIndex: 1, text: '正在阅读的段落' },
    ] }], currentSessionPath: 'anchor-test' })
    const { container } = render(<Timeline />)
    const viewport = screen.getByLabelText('对话记录')
    Object.defineProperties(viewport, { scrollHeight: { get: () => 1500 }, clientHeight: { get: () => 500 } })
    viewport.getBoundingClientRect = () => ({ top: 0, bottom: 500 } as DOMRect)
    const message = container.querySelector<HTMLElement>('[data-message-anchor]')!
    message.getBoundingClientRect = () => ({ top: -300, bottom: 800 } as DOMRect)
    let paragraphTop = 100
    screen.getByText('正在阅读的段落').getBoundingClientRect = () => ({ top: paragraphTop, bottom: paragraphTop + 40 } as DOMRect)
    viewport.scrollTop = 350
    fireEvent.scroll(viewport)
    fireEvent.click(screen.getByRole('button', { name: /执行记录/ }))
    paragraphTop = 220
    act(() => resize?.())
    expect(viewport.scrollTop).toBe(470)
  } finally { globalThis.ResizeObserver = PreviousObserver }
})


it('keeps a manually expanded thinking body visible when its segment completes', () => {
  const thinking = { type: 'thinking' as const, id: 'thought', contentIndex: 0, thinking: '保留阅读的思考', isStreaming: true }
  const { rerender } = render(<MessageItem message={{ ...base, blocks: [thinking] }} />)
  const toggle = screen.getByRole('button', { name: /深度思考过程/ })
  fireEvent.click(toggle)
  fireEvent.click(toggle)
  rerender(<MessageItem message={{ ...base, blocks: [{ ...thinking, isStreaming: false }] }} />)
  expect(screen.getByRole('button', { name: /深度思考过程/ })).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('保留阅读的思考')).toBeVisible()
})

it('shows historical tool status rows while keeping only their details folded', () => {
  render(<MessageItem message={{ ...base, blocks: [
    { type: 'toolCall', id: 'completed', contentIndex: 0, toolCall: { id: 'completed', name: '读取资料', status: 'success', result: '完整输出' } },
    { type: 'toolCall', id: 'failure', contentIndex: 1, toolCall: { id: 'failure', name: '验证资料', status: 'error', error: '验证失败原因' } },
  ] }} />)
  expect(screen.getByRole('button', { name: /读取资料.*完成/ })).toBeVisible()
  expect(screen.getByRole('button', { name: /验证资料.*失败/ })).toBeVisible()
  expect(screen.getByRole('button', { name: /读取资料.*完成/ })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText('完整输出')).not.toBeInTheDocument()
  expect(screen.queryByText('验证失败原因')).not.toBeInTheDocument()
})

