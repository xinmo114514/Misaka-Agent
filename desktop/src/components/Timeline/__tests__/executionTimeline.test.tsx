import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MessageItem } from '../MessageItem'
import { Timeline } from '../Timeline'
import { useSessionStore } from '../../../store/useSessionStore'
import type { ChatMessage, ToolCall } from '../../../types/session'

afterEach(cleanup)
let caseNumber = 0
beforeEach(() => {
  // Disclosure choices are per-session; a shared path would leak one case's clicks into the next.
  useSessionStore.setState({ currentSessionPath: `execution-case-${++caseNumber}.jsonl`, agentMode: 'agent', researchBinding: null })
})

type Block = NonNullable<ChatMessage['blocks']>[number]
const tool = (id: string, over: Partial<ToolCall> = {}): Extract<Block, { type: 'toolCall' }> => ({
  type: 'toolCall', id, contentIndex: 0, toolCall: { id, name: 'read', status: 'success', ...over },
})
const message = (blocks: Block[], over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'answer', role: 'assistant', content: '', timestamp: 1, blocks, ...over,
})
const group = () => screen.getByRole('button', { name: /^执行记录/ })
const lane = () => document.querySelector<HTMLOListElement>('.conversation-execution-list:not(.is-standalone)')!

describe('execution grouping', () => {
  it('merges a long consecutive run of calls into one lane', () => {
    render(<MessageItem message={message(Array.from({ length: 30 }, (_, i) => tool(`c${i}`, { status: i === 29 ? 'running' : 'success' })))} />)
    expect(screen.getAllByRole('button', { name: /^执行记录/ })).toHaveLength(1)
    expect(group()).toHaveAccessibleName(/30 次工具调用|已完成 29\/30/)
    expect(lane()).not.toBeNull()
  })

  it('starts a new lane when prose separates two batches', () => {
    render(<MessageItem message={message([
      tool('a1'), tool('a2'),
      { type: 'text', id: 'note', contentIndex: 2, text: '中间结论' },
      tool('b1'), tool('b2'),
    ])} />)
    expect(screen.getAllByRole('button', { name: /^执行记录/ })).toHaveLength(2)
    expect(screen.getByText('中间结论')).toBeInTheDocument()
  })

  it('renders a lone call as a compact row without lane chrome', () => {
    const { container } = render(<MessageItem message={message([tool('only')])} />)
    expect(screen.queryByRole('button', { name: /^执行记录/ })).not.toBeInTheDocument()
    expect(container.querySelector('.conversation-execution-list.is-standalone')).not.toBeNull()
    expect(within(container.querySelector('.conversation-execution-list.is-standalone') as HTMLElement).getByRole('button', { name: /读取文件.*完成/ })).toBeVisible()
  })
})

describe('lane lifecycle', () => {
  it('is open and counts progress while running, then folds itself when the turn ends', () => {
    const blocks = [tool('t1', { status: 'success', startedAt: 1_000, endedAt: 2_000 }), tool('t2', { status: 'running', startedAt: 2_000 })]
    const { rerender } = render(<MessageItem message={message(blocks, { isStreaming: true })} />)
    expect(group()).toHaveAccessibleName(/执行中/)
    expect(group()).toHaveAccessibleName(/已完成 1\/2/)
    expect(lane()).not.toHaveAttribute('hidden')
    rerender(<MessageItem message={message(blocks.map((b, i) => i === 1 ? tool('t2', { status: 'success', startedAt: 2_000, endedAt: 4_000 }) : b))} />)
    expect(group()).toHaveAccessibleName(/已完成 · 2 次工具调用/)
    expect(group()).toHaveAttribute('aria-expanded', 'false')
    expect(lane()).toHaveAttribute('hidden')
  })

  it('keeps the live seconds ticking from the first real start and freezes after the last one', () => {
    vi.useFakeTimers({ now: 10_000, toFake: ['Date'] })
    try {
      const running = [tool('t1', { status: 'success', startedAt: 1_000, endedAt: 2_000 }), tool('t2', { status: 'running', startedAt: 2_000 })]
      const settled = [tool('t1', { status: 'success', startedAt: 1_000, endedAt: 2_000 }), tool('t2', { status: 'success', startedAt: 2_000, endedAt: 12_000 })]
      const { rerender } = render(<MessageItem message={message(running, { isStreaming: true })} />)
      expect(screen.getByText('9.0 秒')).toBeInTheDocument()
      rerender(<MessageItem message={message(settled)} />)
      act(() => { vi.advanceTimersByTime(5_000) })
      expect(screen.getByText('11 秒')).toBeInTheDocument()
      expect(screen.queryByText('16 秒')).not.toBeInTheDocument()
    } finally { vi.useRealTimers() }
  })

  it('stays silent about duration when the history carries no clock', () => {
    render(<MessageItem message={message([tool('h1'), tool('h2')])} />)
    expect(group()).toHaveAccessibleName(/2 次工具调用/)
    expect(document.querySelector('.conversation-group-toggle .conversation-row-meta + .conversation-row-meta')).toBeNull()
  })

  it('aggregates a failure that the run recovered from', () => {
    render(<MessageItem message={message([tool('f1', { status: 'error' }), tool('f2', { status: 'success' })])} />)
    expect(group()).toHaveAccessibleName(/部分失败/)
    expect(group()).toHaveAccessibleName(/1 项失败/)
    fireEvent.click(group())
    expect(screen.getByRole('button', { name: /读取文件.*失败/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('marks a stopped run cancelled instead of successful', () => {
    render(<MessageItem message={message([tool('s1', { status: 'cancelled' }), tool('s2', { status: 'cancelled' })])} />)
    expect(group()).toHaveAccessibleName(/已取消/)
  })
})

describe('lane scrolling', () => {
  const measure = (list: HTMLOListElement, scrollHeight: number) => {
    Object.defineProperties(list, { scrollHeight: { configurable: true, get: () => scrollHeight }, clientHeight: { configurable: true, get: () => 170 } })
  }

  it('follows the newest record until the reader scrolls back through the log', () => {
    const blocks = Array.from({ length: 6 }, (_, i) => tool(`r${i}`, { status: i === 5 ? 'running' : 'success' }))
    const { rerender } = render(<MessageItem message={message(blocks, { isStreaming: true })} />)
    const push = (extra: number) => rerender(<MessageItem message={message([
      ...blocks.map(b => b.toolCall.id === 'r5' ? tool('r5') : b),
      ...Array.from({ length: extra }, (_, i) => tool(`x${i}`)),
    ], { isStreaming: true })} />)
    const list = lane()
    measure(list, 620)
    push(1)
    expect(list.scrollTop).toBe(620)

    measure(list, 900)
    push(2)
    expect(list.scrollTop).toBe(900)

    list.scrollTop = 120
    fireEvent.scroll(list)
    measure(list, 1180)
    push(3)
    expect(list.scrollTop).toBe(120)

    list.scrollTop = 1180
    fireEvent.scroll(list)
    measure(list, 1460)
    push(4)
    expect(list.scrollTop).toBe(1460)
  })

  it('keeps the final answer outside the lane so folding cannot hide it', () => {
    render(<MessageItem message={message([tool('q1'), tool('q2'), { type: 'text', id: 'final', contentIndex: 2, text: '这是最终结论' }])} />)
    expect(group()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('这是最终结论')).toBeVisible()
    fireEvent.click(group())
    for (const row of screen.getAllByRole('button', { name: /读取文件/ })) expect(lane()).toContainElement(row)
    expect(screen.getByText('这是最终结论')).toBeVisible()
  })

  it('bounds a hundred-call lane to one scroll container', () => {
    render(<MessageItem message={message(Array.from({ length: 100 }, (_, i) => tool(`big${i}`, { startedAt: 1, endedAt: 2 })))} />)
    expect(document.querySelectorAll('.conversation-execution-list:not(.is-standalone)')).toHaveLength(1)
    expect(group()).toHaveAccessibleName(/100 次工具调用/)
    expect(lane().querySelectorAll('.conversation-execution-row')).toHaveLength(100)
  })
})

describe('research mode', () => {
  const host = (file: string) => ({
    enabled: true, streamId: 'rs-1', historyVersion: 'v1', lastEventSeq: 1,
    session: { sessionId: 'rsess', file, cwd: 'C:/research' },
    run: { id: 'r1', status: 'waiting_input', phase: 'done' }, stats: {}, contextUsage: null,
    messages: [message([tool('rs1', { startedAt: 1_000, endedAt: 2_000 }), tool('rs2', { startedAt: 2_000, endedAt: 4_000 })], { id: 'rs-answer', entryId: 'rs-entry' })],
  }) as never

  it('gives the research transcript the same lane and keeps its reading state separate', () => {
    useSessionStore.setState({ agentMode: 'research' })
    useSessionStore.getState().bindResearchConversation(host('C:/research/research.jsonl'))
    useSessionStore.getState().selectResearchView({kind:'conversation',sessionId:'rsess',ownerKey:'conversation:rsess'})
    const { rerender } = render(<Timeline />)
    expect(group()).toHaveAccessibleName(/已完成 · 2 次工具调用/)
    expect(document.querySelector('.conversation-group-duration')).toHaveTextContent('3.0 秒')
    expect(group()).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(group())
    expect(lane()).toBeVisible()

    // The agent row is a different transcript; its lanes must not inherit this choice.
    useSessionStore.setState({ agentMode: 'agent', messages: [message([tool('ag1'), tool('ag2')], { id: 'ag-answer', entryId: 'ag-entry' })] })
    rerender(<Timeline />)
    expect(screen.getByRole('button', { name: /^执行记录/ })).toHaveAttribute('aria-expanded', 'false')
    useSessionStore.setState({ agentMode: 'research' })
    rerender(<Timeline />)
    expect(group()).toHaveAttribute('aria-expanded', 'true')
  })
})
