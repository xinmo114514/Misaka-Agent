import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ResearchSessionDescriptor, ResearchSessionHistory } from '../../types/research'
import { useResearchSessionsStore } from '../../store/useResearchSessionsStore'
import { researchSessionsBridge } from '../../lib/researchSessionsBridge'
import { forgetSessionView } from '../../lib/sessionViewState'
import { researchSurfaceKey } from '../Timeline/ChatSurface'
import { ResearchTranscript } from './ResearchTranscript'

vi.mock('../../lib/researchSessionsBridge', () => ({
  researchSessionsBridge: { history: vi.fn(), content: vi.fn() },
}))

const descriptor = (extra: Partial<ResearchSessionDescriptor> = {}): ResearchSessionDescriptor => ({
  executorId: 'reader', sessionId: 'session-1', sessionFile: 'session-1.jsonl', nodeId: 'node', taskId: 'task',
  role: 'sister', label: 'Reader', workspace: '  C:/authoritative-owner/  ', status: 'running', generation: 1,
  attempt: 1, startedAt: 1, endedAt: null, error: null, ...extra,
})

const page = (extra: Partial<ResearchSessionHistory> = {}): ResearchSessionHistory => ({
  runId: 'run-1', executorId: 'reader',
  messages: [{ id: 'current', role: 'assistant', content: 'Current saved message.', timestamp: 2 }],
  nextCursor: null, hasMore: false, availability: 'available', historyVersion: 'v1', ...extra,
})

function seed(item = descriptor(), history?: ResearchSessionHistory) {
  useResearchSessionsStore.getState().upsertDescriptors(history?.runId ?? 'run-1', [item])
  if (history) useResearchSessionsStore.getState().applyHistory(history)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

beforeEach(() => {
  useResearchSessionsStore.setState({ byExecutor: {} })
  vi.mocked(researchSessionsBridge.history).mockReset()
  vi.mocked(researchSessionsBridge.content).mockReset()
})

afterEach(() => {
  for (const id of ['reader', 'other']) for (const area of ['main', 'side'] as const) {
    forgetSessionView(researchSurfaceKey('run-1', id, area))
  }
})

it('loads the latest focus transcript from its descriptor owner and exposes pending work', async () => {
  const loading = deferred<ResearchSessionHistory>()
  vi.mocked(researchSessionsBridge.history).mockReturnValue(loading.promise)
  seed()

  render(<ResearchTranscript runId="run-1" workspace="C:/wrong-page" descriptor={descriptor()} area="main" />)

  expect(await screen.findByText('正在读取会话历史…')).toBeVisible()
  expect(researchSessionsBridge.history).toHaveBeenCalledWith('run-1', 'reader', 'C:/authoritative-owner')
  expect(researchSessionsBridge.history).toHaveBeenCalledTimes(1)

  await act(async () => {
    const result = page()
    useResearchSessionsStore.getState().applyHistory(result)
    loading.resolve(result)
    await loading.promise
  })
  expect(await screen.findByText('Current saved message.')).toBeVisible()
  expect(screen.queryByText('正在读取会话历史…')).not.toBeInTheDocument()
})

it('keeps an initial failure stable until explicit retry and coalesces repeated retry clicks', async () => {
  vi.mocked(researchSessionsBridge.history).mockRejectedValueOnce(new Error('history transport failed'))
  seed()
  const view = render(<ResearchTranscript runId="run-1" workspace="C:/page" descriptor={descriptor()} area="main" />)

  expect(await screen.findByText('Error: history transport failed')).toBeVisible()
  view.rerender(<ResearchTranscript runId="run-1" workspace="C:/page" descriptor={descriptor()} area="main" />)
  await act(async () => {})
  expect(researchSessionsBridge.history).toHaveBeenCalledTimes(1)

  const retry = deferred<ResearchSessionHistory>()
  vi.mocked(researchSessionsBridge.history).mockReturnValue(retry.promise)
  const button = screen.getByRole('button', { name: '重试' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(researchSessionsBridge.history).toHaveBeenCalledTimes(2)
  expect(screen.getByText('正在读取会话历史…')).toBeVisible()

  await act(async () => {
    const result = page({ messages: [] })
    useResearchSessionsStore.getState().applyHistory(result)
    retry.resolve(result)
    await retry.promise
  })
  expect(screen.getByText('会话暂无内容')).toBeVisible()
})

it('loads a newer saved version while preserving the live streaming row', async () => {
  seed(descriptor(), page())
  vi.mocked(researchSessionsBridge.history).mockImplementation(async () => {
    const result = page({
      historyVersion: 'v2',
      messages: [{ id: 'saved-new', role: 'assistant', content: 'New saved version.', timestamp: 3 }],
    })
    useResearchSessionsStore.getState().applyHistory(result)
    return result
  })
  render(<ResearchTranscript runId="run-1" workspace="C:/page" descriptor={descriptor()} area="main" />)
  expect(screen.getByText('Current saved message.')).toBeVisible()

  act(() => useResearchSessionsStore.getState().applySnapshot({
    runId: 'run-1', executorId: 'reader', sessionId: 'session-1', nodeId: 'node', taskId: 'task', generation: 1,
    attempt: 1, revision: 1, historyVersion: 'v2',
    streaming: { id: 'streaming', role: 'assistant', content: 'Live streaming row.', timestamp: 4 },
    telemetry: null, error: null, availability: 'available',
  }))

  expect(await screen.findByText('New saved version.')).toBeVisible()
  expect(screen.getByText('Live streaming row.')).toBeVisible()
  expect(researchSessionsBridge.history).toHaveBeenCalledTimes(1)
})

it.each([
  ['not_started', descriptor({ sessionId: null, sessionFile: null }), undefined, '等待会话开始'],
  ['missing', descriptor(), page({ messages: [], availability: 'missing' }), '会话记录缺失'],
  ['interrupted', descriptor(), page({ messages: [], availability: 'interrupted' }), '会话记录读取中断'],
] as const)('shows the authoritative %s empty state instead of a focus placeholder', (_availability, item, history, expected) => {
  seed(item, history)
  render(<ResearchTranscript runId="run-1" workspace="C:/page" descriptor={item} area="main"
    empty={<p>Focus placeholder</p>} />)
  expect(screen.getByText(expected)).toBeVisible()
  expect(screen.queryByText('Focus placeholder')).not.toBeInTheDocument()
})

it('uses the focus placeholder for a successfully loaded empty session', () => {
  seed(descriptor(), page({ messages: [] }))
  render(<ResearchTranscript runId="run-1" workspace="C:/page" descriptor={descriptor()} area="main"
    empty={<p>Focus placeholder</p>} />)
  expect(screen.getByText('Focus placeholder')).toBeVisible()
})

it('shows the real session error even when the transcript is empty', () => {
  seed(descriptor(), page({ messages: [], error: 'Worker stopped on a real error.' }))
  render(<ResearchTranscript runId="run-1" workspace="C:/page" descriptor={descriptor()} area="main"
    empty={<p>Focus placeholder</p>} />)
  expect(screen.getByRole('alert')).toHaveTextContent('Worker stopped on a real error.')
})

it('keeps existing rows and reading offset after older-page failure and coalesces retry clicks', async () => {
  seed(descriptor(), page({ nextCursor: 'v1@20', hasMore: true }))
  vi.mocked(researchSessionsBridge.history).mockRejectedValueOnce(new Error('older page failed'))
  render(<ResearchTranscript runId="run-1" workspace="C:/page" descriptor={descriptor()} area="main" />)
  const viewport = screen.getByLabelText('Reader 会话记录')
  Object.defineProperties(viewport, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } })
  viewport.scrollTop = 180
  fireEvent.scroll(viewport)
  fireEvent.click(screen.getByRole('button', { name: '读取更多历史' }))

  expect(await screen.findByText('Error: older page failed')).toBeVisible()
  expect(screen.getByText('Current saved message.')).toBeVisible()
  expect(viewport.scrollTop).toBe(180)
  expect(researchSessionsBridge.history).toHaveBeenCalledWith('run-1', 'reader', 'C:/authoritative-owner', 'v1@20')

  const retry = deferred<ResearchSessionHistory>()
  vi.mocked(researchSessionsBridge.history).mockReturnValue(retry.promise)
  const button = screen.getByRole('button', { name: '重试' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(researchSessionsBridge.history).toHaveBeenCalledTimes(2)

  await act(async () => {
    const result = page({
      direction: 'older', messages: [{ id: 'older', role: 'assistant', content: 'Older saved message.', timestamp: 1 }],
      nextCursor: null, hasMore: false,
    })
    useResearchSessionsStore.getState().applyHistory(result, true)
    retry.resolve(result)
    await retry.promise
  })
  expect(await screen.findByText('Older saved message.')).toBeVisible()
})

it('does not leak an obsolete request failure across descriptor switches or request generations', async () => {
  const first = deferred<ResearchSessionHistory>()
  const second = deferred<ResearchSessionHistory>()
  vi.mocked(researchSessionsBridge.history).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const original = descriptor()
  seed(original)
  const view = render(<ResearchTranscript runId="run-1" workspace="C:/page" descriptor={original} area="main" />)
  await waitFor(() => expect(researchSessionsBridge.history).toHaveBeenCalledTimes(1))

  const replacement = descriptor({ workspace: 'C:/second-owner', sessionId: 'session-2', sessionFile: 'session-2.jsonl', generation: 2, attempt: 2 })
  act(() => useResearchSessionsStore.getState().upsertDescriptors('run-1', [replacement]))
  view.rerender(<ResearchTranscript runId="run-1" workspace="C:/page" descriptor={replacement} area="main" />)
  await waitFor(() => expect(researchSessionsBridge.history).toHaveBeenCalledTimes(2))

  await act(async () => {
    first.reject(new Error('obsolete failure'))
    await first.promise.catch(() => {})
  })
  expect(screen.queryByText(/obsolete failure/)).not.toBeInTheDocument()
  expect(screen.getByText('正在读取会话历史…')).toBeVisible()

  await act(async () => {
    const result = page({ messages: [{ id: 'replacement', role: 'assistant', content: 'Replacement history.', timestamp: 5 }] })
    useResearchSessionsStore.getState().applyHistory(result)
    second.resolve(result)
    await second.promise
  })
  expect(screen.getByText('Replacement history.')).toBeVisible()
})

it('ignores a late content page after the descriptor owner is replaced with a reused entry', async () => {
  const oldContent = deferred<{ content: string; nextOffset: number | null; hasMore: boolean }>()
  vi.mocked(researchSessionsBridge.content).mockReturnValueOnce(oldContent.promise)
    .mockResolvedValueOnce({ content: 'New completed body.', nextOffset: null, hasMore: false })
  const original = descriptor()
  seed(original, page({
    messages: [{ id: 'old', entryId: 'reused-entry', role: 'assistant', content: 'Old preview.', contentTruncated: true, timestamp: 2 }],
  }))
  const view = render(<ResearchTranscript runId="run-1" workspace="C:/page" descriptor={original} area="main" />)
  fireEvent.click(screen.getByRole('button', { name: '读取完整消息' }))

  const replacement = descriptor({
    workspace: 'C:/second-owner', sessionId: 'session-2', sessionFile: 'session-2.jsonl', generation: 2, attempt: 2,
  })
  act(() => {
    useResearchSessionsStore.getState().upsertDescriptors('run-1', [replacement])
    useResearchSessionsStore.getState().applyHistory(page({
      historyVersion: 'v2',
      messages: [{ id: 'new', entryId: 'reused-entry', role: 'assistant', content: 'New preview.', contentTruncated: true, timestamp: 3 }],
    }))
  })
  view.rerender(<ResearchTranscript runId="run-1" workspace="C:/page" descriptor={replacement} area="main" />)

  await act(async () => {
    oldContent.resolve({ content: 'Old completed body.', nextOffset: null, hasMore: false })
    await oldContent.promise
  })
  expect(screen.queryByText('Old completed body.')).not.toBeInTheDocument()
  expect(Object.values(useResearchSessionsStore.getState().byExecutor.reader.previews)).not.toContain('Old completed body.')

  fireEvent.click(screen.getByRole('button', { name: '读取完整消息' }))
  expect(await screen.findByText('New completed body.')).toBeVisible()
})

it('ignores a late content page after the transcript unmounts', async () => {
  const oldContent = deferred<{ content: string; nextOffset: number | null; hasMore: boolean }>()
  vi.mocked(researchSessionsBridge.content).mockReturnValue(oldContent.promise)
  seed(descriptor(), page({
    messages: [{ id: 'old', entryId: 'unmounted-entry', role: 'assistant', content: 'Unmount preview.', contentTruncated: true, timestamp: 2 }],
  }))
  const view = render(<ResearchTranscript runId="run-1" workspace="C:/page" descriptor={descriptor()} area="side" />)
  fireEvent.click(screen.getByRole('button', { name: '读取完整消息' }))
  view.unmount()

  await act(async () => {
    oldContent.resolve({ content: 'Unmounted completed body.', nextOffset: null, hasMore: false })
    await oldContent.promise
  })
  expect(Object.values(useResearchSessionsStore.getState().byExecutor.reader.previews)).not.toContain('Unmounted completed body.')
})
