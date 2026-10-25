import { useState, type ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ChatSurfaceProvider, ChatText, type ChatPaging } from '../ChatSurface'
import { MessageItem } from '../MessageItem'
import type { ChatMessage } from '../../../types/session'

function Pager({ load, children }: { load: ChatPaging['load']; children: ReactNode }) {
  const [pages, setPages] = useState<Record<string, { content: string; nextOffset: number | null }>>({})
  return <ChatSurfaceProvider surface={{ key: 'paging-fixture', readOnly: true, paging: {
    preview: key => pages[key]?.content,
    nextOffset: key => pages[key]?.nextOffset,
    load,
    save: (key, content, nextOffset) => setPages(current => ({ ...current, [key]: { content, nextOffset } })),
  } }}>{children}</ChatSurfaceProvider>
}
const message: ChatMessage = { id: 'paged-answer', entryId: 'paged-entry', role: 'assistant', timestamp: 1,
  content: 'FIRST PREVIEWSECOND PREVIEW', contentTruncated: true }

it('keeps canonical text/tool order and reads merged prose in one separate full-body reader', async () => {
  const load = vi.fn(async () => ({ content: 'FIRST COMPLETESECOND COMPLETE', nextOffset: null }))
  const { container } = render(<Pager load={load}><MessageItem message={{ ...message, blocks: [
    { id: 'first', type: 'text', contentIndex: 0, text: 'FIRST PREVIEW' },
    { id: 'tool', type: 'toolCall', contentIndex: 1, toolCall: { id: 'lookup', name: 'lookup', status: 'success' } },
    { id: 'second', type: 'text', contentIndex: 2, text: 'SECOND PREVIEW' },
  ] }} /></Pager>)
  expect(screen.getAllByRole('button', { name: '读取完整消息' })).toHaveLength(1)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '读取完整消息' })) })
  expect(container.textContent).toMatch(/FIRST PREVIEW[\s\S]*lookup[\s\S]*SECOND PREVIEW/)
  expect(screen.getAllByText('FIRST COMPLETESECOND COMPLETE')).toHaveLength(1)
  expect(screen.queryByRole('button', { name: '读取完整消息' })).not.toBeInTheDocument()
})

it('keeps the existing 32KiB preview visible while smaller pages catch up', async () => {
  const preview = 'a'.repeat(32768)
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const load = vi.fn(async ({ offset }: { offset: number }) => {
    if (offset > 0) await pending
    const full = preview + 'TAIL'
    const content = full.slice(offset, offset + 8192)
    return { content, nextOffset: offset + content.length < full.length ? offset + content.length : null }
  })
  render(<Pager load={load}><ChatText message={{ ...message, role: 'user', content: preview }} text={preview} plain /></Pager>)
  try {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '读取完整消息' })) })
    expect(screen.getByText(preview)).toBeVisible()
  } finally { release() }
  await waitFor(() => expect(screen.getByText(preview + 'TAIL')).toBeVisible())
  expect(load.mock.calls.map(([input]) => input.offset)).toEqual([0, 8192, 16384, 24576, 32768])
})

it('advances with server codepoint cursors for CJK and emoji, not JavaScript string lengths', async () => {
  const full = '文😀中文😀末尾'
  const points = Array.from(full)
  const load = vi.fn(async ({ offset }: { offset: number }) => ({
    content: points.slice(offset, offset + 2).join(''), nextOffset: offset + 2 < points.length ? offset + 2 : null,
  }))
  render(<Pager load={load}><ChatText message={message} text="文😀中文" plain /></Pager>)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '读取完整消息' })) })
  expect(screen.getByText('文😀中文😀末')).toBeVisible()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '读取完整消息' })) })
  expect(screen.getByText(full)).toBeVisible()
  expect(load.mock.calls.map(([input]) => input.offset)).toEqual([0, 2, 4, 6])
})

it('keeps a longer preview after a partial read fails and retries from the saved server cursor', async () => {
  let failed = false
  const load = vi.fn(async ({ offset }: { offset: number }) => {
    if (offset === 0) return { content: 'FIRST ', nextOffset: 6 }
    if (!failed) { failed = true; throw new Error('page unavailable') }
    return { content: 'PREVIEW COMPLETE', nextOffset: null }
  })
  render(<Pager load={load}><ChatText message={message} text="FIRST PREVIEW" plain /></Pager>)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '读取完整消息' })) })
  expect(screen.getByText('FIRST PREVIEW')).toBeVisible()
  expect(screen.getByRole('alert')).toHaveTextContent('page unavailable')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '读取完整消息' })) })
  expect(screen.getByText('FIRST PREVIEW COMPLETE')).toBeVisible()
  expect(load.mock.calls.map(([input]) => input.offset)).toEqual([0, 6, 6])
})

it('does not replace the preview with a shorter changed prefix before the complete value arrives', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const load = vi.fn(async ({ offset }: { offset: number }) => {
    if (!offset) return { content: 'changed', nextOffset: 7 }
    await pending
    return { content: ' body', nextOffset: null }
  })
  render(<Pager load={load}><ChatText message={message} text="original longer preview" plain /></Pager>)
  try {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '读取完整消息' })) })
    expect(screen.getByText('original longer preview')).toBeVisible()
  } finally { release() }
  await waitFor(() => expect(screen.getByText('changed body')).toBeVisible())
})
