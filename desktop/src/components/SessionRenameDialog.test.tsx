import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SessionRenameDialog } from './SessionRenameDialog'

afterEach(cleanup)

it('submits the captured session name on Enter and closes after confirmation', async () => {
  const onRename = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  render(<SessionRenameDialog open path="one.jsonl" name="原名称" onRename={onRename} onClose={onClose} />)
  const input = screen.getByRole('textbox', { name: '会话名称' })
  fireEvent.change(input, { target: { value: '新名称' } })
  fireEvent.submit(input.closest('form')!)
  await waitFor(() => expect(onRename).toHaveBeenCalledWith('one.jsonl', '新名称'))
  expect(onClose).toHaveBeenCalledOnce()
})

it('Escape cancels without saving and a rejected rename keeps its draft visible', async () => {
  const onRename = vi.fn().mockRejectedValue(new Error('磁盘错误'))
  const onClose = vi.fn()
  const { rerender } = render(<SessionRenameDialog open path="one.jsonl" name="原名称" onRename={onRename} onClose={onClose} />)
  const input = screen.getByRole('textbox', { name: '会话名称' })
  fireEvent.change(input, { target: { value: '未保存' } })
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(onRename).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalledOnce()
  rerender(<SessionRenameDialog open path="one.jsonl" name="原名称" onRename={onRename} onClose={onClose} />)
  fireEvent.change(screen.getByRole('textbox', { name: '会话名称' }), { target: { value: '保留错误输入' } })
  fireEvent.click(screen.getByRole('button', { name: '保存名称' }))
  expect(await screen.findByRole('status')).toHaveTextContent('磁盘错误')
  expect(screen.getByRole('textbox', { name: '会话名称' })).toHaveValue('保留错误输入')
})

it('closes a same-name edit without a bridge write and ignores blank names', async () => {
  const onRename = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  render(<SessionRenameDialog open path="one.jsonl" name="原名称" onRename={onRename} onClose={onClose} />)
  fireEvent.click(screen.getByRole('button', { name: '保存名称' }))
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  expect(onRename).not.toHaveBeenCalled()
})
