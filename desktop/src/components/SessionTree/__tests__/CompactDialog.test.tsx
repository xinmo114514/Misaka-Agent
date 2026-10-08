import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { CompactDialog, type CompactDialogProps } from '../CompactDialog'

afterEach(cleanup)

function props(overrides: Partial<CompactDialogProps> = {}): CompactDialogProps {
  return {
    open: true,
    busy: false,
    status: { state: 'idle' },
    messageCount: 10,
    initialInstructions: null,
    onConfirm: vi.fn(),
    onCancelOperation: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
}

describe('CompactDialog', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<CompactDialog {...props({ open: false })} />)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('passes the typed instructions through, trimmed', () => {
    const onConfirm = vi.fn()
    const { getByLabelText, getByText } = render(<CompactDialog {...props({ onConfirm })} />)
    fireEvent.change(getByLabelText('自定义压缩指令'), { target: { value: '  保留未完成的实验  ' } })
    fireEvent.click(getByText('立即压缩'))
    expect(onConfirm).toHaveBeenCalledWith('保留未完成的实验')
  })

  it('sends null when the instructions are blank', () => {
    const onConfirm = vi.fn()
    const { getByText } = render(<CompactDialog {...props({ onConfirm })} />)
    fireEvent.click(getByText('立即压缩'))
    expect(onConfirm).toHaveBeenCalledWith(null)
  })

  it('prefills the instructions a /compact command carried', () => {
    const { getByLabelText } = render(<CompactDialog {...props({ initialInstructions: '只留结论' })} />)
    expect((getByLabelText('自定义压缩指令') as HTMLTextAreaElement).value).toBe('只留结论')
  })

  it('disables the run button when there is nothing to compact', () => {
    const onConfirm = vi.fn()
    const { getByText } = render(<CompactDialog {...props({ messageCount: 1, onConfirm })} />)
    expect(getByText('暂无可压缩的消息')).toBeInTheDocument()
    expect(getByText('立即压缩')).toBeDisabled()
    fireEvent.click(getByText('立即压缩'))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('confirms on Ctrl+Enter without submitting on a bare Enter', () => {
    const onConfirm = vi.fn()
    const { getByLabelText } = render(<CompactDialog {...props({ onConfirm })} />)
    const input = getByLabelText('自定义压缩指令')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('swaps the primary action to cancel while a compaction runs', () => {
    const onConfirm = vi.fn()
    const onCancelOperation = vi.fn()
    const { getByText, queryByText } = render(<CompactDialog {...props({
      busy: true, status: { state: 'running' }, onConfirm, onCancelOperation,
    })} />)
    expect(queryByText('立即压缩')).toBeNull()
    fireEvent.click(getByText('取消压缩'))
    expect(onCancelOperation).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('cancels on Escape while busy but closes when idle', () => {
    const onCancelOperation = vi.fn()
    const onClose = vi.fn()
    render(<CompactDialog {...props({ busy: true, onCancelOperation, onClose })} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancelOperation).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()

    cleanup()
    render(<CompactDialog {...props({ onCancelOperation, onClose })} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('reports the engine outcome', () => {
    const { getByText, rerender } = render(<CompactDialog {...props({ status: { state: 'done', message: '压缩完成' } })} />)
    expect(getByText('压缩完成')).toBeInTheDocument()
    rerender(<CompactDialog {...props({ status: { state: 'error', message: '压缩失败' } })} />)
    expect(getByText('压缩失败')).toBeInTheDocument()
    rerender(<CompactDialog {...props({ status: { state: 'aborted', message: '压缩已取消' } })} />)
    expect(getByText('压缩已取消')).toBeInTheDocument()
  })
})
