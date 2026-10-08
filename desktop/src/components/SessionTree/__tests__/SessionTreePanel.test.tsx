import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { SessionTreePayload } from '../../../types/session'
import { SessionTreePanel, type SessionTreePanelProps } from '../SessionTreePanel'

afterEach(cleanup)

interface Node { id: string; role?: string; text?: string; label?: string | null; children?: Node[] }

function serial(node: Node): any {
  return {
    entry: {
      type: 'message',
      id: node.id,
      message: { role: node.role ?? 'user', content: [{ type: 'text', text: node.text ?? node.id }] },
    },
    label: node.label ?? null,
    labelTimestamp: node.label ? '2026-10-05T10:00:00.000Z' : null,
    children: (node.children ?? []).map(serial),
  }
}

function payload(roots: Node[], leafId: string | null = null): SessionTreePayload {
  return { sessionId: 's', sessionFile: null, historyVersion: null, leafId, tree: roots.map(serial) }
}

const FORK: SessionTreePayload = payload([
  { id: 'u1', role: 'user', text: '第一问' },
  { id: 'a1', role: 'assistant', text: '第一答' },
  { id: 'tool', role: 'toolResult', text: '工具输出' },
  { id: 'u2', role: 'user', text: '第二问', label: '关键' },
], 'u1')

function props(overrides: Partial<SessionTreePanelProps> = {}): SessionTreePanelProps {
  return {
    payload: FORK,
    loading: false,
    error: null,
    busy: false,
    operationKind: null,
    filterMode: 'default',
    showLabelTimestamps: false,
    skipSummaryPrompt: false,
    onFilterModeChange: vi.fn(),
    onToggleLabelTimestamps: vi.fn(),
    onToggleSkipSummaryPrompt: vi.fn(),
    onNavigate: vi.fn(),
    onCancelOperation: vi.fn(),
    onRenameLabel: vi.fn(),
    onCopy: vi.fn(),
    onRefresh: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
}

const rows = (container: HTMLElement) => Array.from(container.querySelectorAll('[role="treeitem"]'))
const rowIds = (container: HTMLElement) => rows(container).map(row => row.getAttribute('data-row-id'))

describe('SessionTreePanel', () => {
  it('renders one row per visible entry and filters with the chips', () => {
    const { container, rerender } = render(<SessionTreePanel {...props()} />)
    expect(rowIds(container)).toEqual(['u1', 'a1', 'tool', 'u2'])

    rerender(<SessionTreePanel {...props({ filterMode: 'user-only' })} />)
    expect(rowIds(container)).toEqual(['u1', 'u2'])

    rerender(<SessionTreePanel {...props({ filterMode: 'no-tools' })} />)
    expect(rowIds(container)).toEqual(['u1', 'a1', 'u2'])

    rerender(<SessionTreePanel {...props({ filterMode: 'labeled-only' })} />)
    expect(rowIds(container)).toEqual(['u2'])

    rerender(<SessionTreePanel {...props({ filterMode: 'all' })} />)
    expect(rowIds(container)).toEqual(['u1', 'a1', 'tool', 'u2'])
  })

  it('moves the selection with the keyboard and activates the row', () => {
    const onNavigate = vi.fn()
    const { container } = render(<SessionTreePanel {...props({ onNavigate, skipSummaryPrompt: true })} />)
    const tree = container.querySelector('[role="tree"]') as HTMLElement
    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    fireEvent.keyDown(tree, { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledWith({ targetId: 'a1', summarize: true })
  })

  it('offers all three summary choices and maps them to navigate arguments', () => {
    const onNavigate = vi.fn()
    const { container, getByText, getByLabelText } = render(<SessionTreePanel {...props({ onNavigate })} />)
    fireEvent.click(rows(container)[1])
    fireEvent.click(getByText('不摘要'))
    expect(onNavigate).toHaveBeenLastCalledWith({ targetId: 'a1', summarize: false })

    fireEvent.click(rows(container)[1])
    fireEvent.click(getByText('摘要'))
    expect(onNavigate).toHaveBeenLastCalledWith({ targetId: 'a1', summarize: true })

    fireEvent.click(rows(container)[1])
    fireEvent.click(getByText('自定义摘要提示'))
    fireEvent.change(getByLabelText('自定义摘要提示'), { target: { value: '  只留结论  ' } })
    fireEvent.click(getByText('确定'))
    expect(onNavigate).toHaveBeenLastCalledWith({ targetId: 'a1', summarize: true, customInstructions: '只留结论' })
  })

  it('blocks navigation while an operation runs but still offers cancel', () => {
    const onNavigate = vi.fn()
    const onCancelOperation = vi.fn()
    const { container, getByText } = render(<SessionTreePanel {...props({
      busy: true, operationKind: 'navigate_tree', onNavigate, onCancelOperation,
    })} />)
    fireEvent.click(rows(container)[1])
    expect(onNavigate).not.toHaveBeenCalled()
    fireEvent.click(getByText('取消'))
    expect(onCancelOperation).toHaveBeenCalled()
  })

  it('searches across the visible rows', () => {
    const { container } = render(<SessionTreePanel {...props()} />)
    fireEvent.change(container.querySelector('input[aria-label="搜索会话树"]') as HTMLElement, { target: { value: '第二问' } })
    expect(rowIds(container)).toEqual(['u2'])
  })

  it('edits and clears a label through the inline editor', () => {
    const onRenameLabel = vi.fn()
    const { container } = render(<SessionTreePanel {...props({ onRenameLabel })} />)
    fireEvent.keyDown(container.querySelector('[role="tree"]') as HTMLElement, { key: 'l' })
    const input = container.querySelector('input[aria-label="节点标签"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  新标签  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRenameLabel).toHaveBeenCalledWith('u1', '新标签')

    fireEvent.keyDown(container.querySelector('[role="tree"]') as HTMLElement, { key: 'l' })
    const again = container.querySelector('input[aria-label="节点标签"]') as HTMLInputElement
    fireEvent.change(again, { target: { value: '   ' } })
    fireEvent.keyDown(again, { key: 'Enter' })
    expect(onRenameLabel).toHaveBeenLastCalledWith('u1', null)
  })

  it('copies the selected row with c', () => {
    const onCopy = vi.fn()
    const { container } = render(<SessionTreePanel {...props({ onCopy })} />)
    fireEvent.keyDown(container.querySelector('[role="tree"]') as HTMLElement, { key: 'c' })
    expect(onCopy).toHaveBeenCalledWith('第一问')
  })

  it('cycles the filter mode with the bracket keys', () => {
    const onFilterModeChange = vi.fn()
    const { container } = render(<SessionTreePanel {...props({ onFilterModeChange })} />)
    const tree = container.querySelector('[role="tree"]') as HTMLElement
    fireEvent.keyDown(tree, { key: ']' })
    expect(onFilterModeChange).toHaveBeenLastCalledWith('no-tools')
    fireEvent.keyDown(tree, { key: '[' })
    expect(onFilterModeChange).toHaveBeenLastCalledWith('all')
  })

  it('closes on Escape once the search is already clear', () => {
    const onClose = vi.fn()
    const { container } = render(<SessionTreePanel {...props({ onClose })} />)
    fireEvent.keyDown(container.querySelector('[role="tree"]') as HTMLElement, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('bounds mounted rows for a very large tree', () => {
    const roots: Node[] = Array.from({ length: 1200 }, (_, index) => ({
      id: `n-${index}`, role: 'user', text: `消息 ${index}`,
    }))
    const { container } = render(<SessionTreePanel {...props({ payload: payload(roots, 'n-0') })} />)
    expect(container.querySelectorAll('[role="treeitem"]').length).toBeLessThan(60)
  }, 15000)

  it('renders the label timestamp only when the preference is on', () => {
    const { container, rerender } = render(<SessionTreePanel {...props({ filterMode: 'labeled-only' })} />)
    expect(container.textContent).not.toMatch(/\d{2}-\d{2} \d{2}:\d{2}/)
    rerender(<SessionTreePanel {...props({ filterMode: 'labeled-only', showLabelTimestamps: true })} />)
    expect(container.textContent).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/)
  })

  it('shows the retry affordance when the tree failed to load', () => {
    const onRefresh = vi.fn()
    const { getByText } = render(<SessionTreePanel {...props({ error: '读取会话树失败', payload: null, onRefresh })} />)
    expect(getByText('读取会话树失败')).toBeInTheDocument()
    fireEvent.click(getByText('重试'))
    expect(onRefresh).toHaveBeenCalled()
  })

  it('does not render list rows when a filter matches nothing', () => {
    const { container, getByText } = render(<SessionTreePanel {...props({ filterMode: 'labeled-only', payload: payload([{ id: 'u1' }]) })} />)
    expect(container.querySelectorAll('[role="treeitem"]').length).toBe(0)
    expect(getByText('没有符合当前筛选的节点')).toBeInTheDocument()
  })
})
