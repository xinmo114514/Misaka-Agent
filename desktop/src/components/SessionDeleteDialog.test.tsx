import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSessionStore } from '../store/useSessionStore'
import { SessionDeleteDialog } from './SessionDeleteDialog'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

beforeEach(() => {
  useSessionStore.setState({ sessionDeletion: {
    path: 'C:/project/session.jsonl', requestId: null, status: 'confirm',
  }, sessions: [{ id: 'session', path: 'C:/project/session.jsonl', cwd: 'C:/project', name: '研究工作',
    firstMessage: '', created: '2026-10-05', modified: '2026-10-06', messageCount: 4 }] })
})

it('names the conversation and requires an explicit confirmation before deleting it', () => {
  render(<SessionDeleteDialog />)

  expect(screen.getByRole('alertdialog', { name: '删除会话' })).toBeInTheDocument()
  expect(screen.getByText('研究工作')).toBeInTheDocument()
  expect(screen.getByText('永久删除后，此会话记录将无法恢复。')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(useSessionStore.getState().sessionDeletion).toBeNull()
})

it('disables confirmation while the bridge request is pending and exposes bridge errors', () => {
  useSessionStore.setState({ sessionDeletion: { path: 'C:/project/session.jsonl', requestId: 'delete-1', status: 'pending' } })
  const { rerender } = render(<SessionDeleteDialog />)
  expect(screen.getByRole('button', { name: '正在删除…' })).toBeDisabled()

  useSessionStore.setState({ sessionDeletion: { path: 'C:/project/session.jsonl', requestId: 'delete-1', status: 'error', error: '文件仍被占用' } })
  rerender(<SessionDeleteDialog />)
  expect(screen.getByRole('status')).toHaveTextContent('文件仍被占用')
})
