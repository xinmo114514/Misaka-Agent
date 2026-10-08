import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CodeBlock } from '../CodeBlock'
import { MessageItem } from '../MessageItem'
import type { ChatMessage } from '../../../types/session'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
})

function setClipboard(writeText?: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  })
}

describe('clipboard feedback', () => {
  it('shows success only after code has been written to the clipboard', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    setClipboard(writeText)

    render(<CodeBlock language="ts" code="const value = 42" />)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已复制'))
    expect(writeText).toHaveBeenCalledWith('const value = 42')
  })

  it('shows an actionable code-copy error and keeps retry available when clipboard write fails', async () => {
    const writeText = vi.fn(async () => { throw new Error('permission denied') })
    setClipboard(writeText)

    render(<CodeBlock language="text" code="retry me" />)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('permission denied')
    expect(screen.getByRole('button', { name: '复制' })).toBeEnabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows a pending state and prevents duplicate code-copy requests', async () => {
    let finishWrite!: () => void
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finishWrite = resolve }))
    setClipboard(writeText)

    render(<CodeBlock language="text" code="slow" />)
    const button = screen.getByRole('button', { name: '复制' })
    fireEvent.click(button)

    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('复制中')
    fireEvent.click(button)
    expect(writeText).toHaveBeenCalledTimes(1)

    await act(async () => { finishWrite() })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已复制'))
  })

  it('shows answer-copy failures instead of silently ignoring them', async () => {
    setClipboard(async () => { throw new Error('clipboard unavailable') })
    const message = {
      id: 'copy-answer', role: 'assistant', content: 'answer body', timestamp: 1,
      blocks: [{ type: 'text', id: 'answer-text', contentIndex: 0, text: 'answer body' }],
    } as ChatMessage

    render(<MessageItem message={message} />)
    fireEvent.click(screen.getByRole('button', { name: '复制回答内容' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('clipboard unavailable')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows answer-copy success only after the complete text blocks are written', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    setClipboard(writeText)
    const message = {
      id: 'copy-answer-success', role: 'assistant', content: 'answer body', timestamp: 1,
      blocks: [
        { type: 'text', id: 'answer-one', contentIndex: 0, text: 'first part' },
        { type: 'text', id: 'answer-two', contentIndex: 1, text: 'second part' },
      ],
    } as ChatMessage

    render(<MessageItem message={message} />)
    fireEvent.click(screen.getByRole('button', { name: '复制回答内容' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已复制'))
    expect(writeText).toHaveBeenCalledWith('first part\n\nsecond part')
  })

  it('reports a missing clipboard interface and lets the user retry', async () => {
    setClipboard()

    render(<CodeBlock language="text" code="still visible" />)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/剪贴板/)
    expect(screen.getByText('still visible')).toBeInTheDocument()
  })
})
