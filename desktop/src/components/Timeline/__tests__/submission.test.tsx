import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MessageItem } from '../MessageItem'
import { useSessionStore } from '../../../store/useSessionStore'

afterEach(cleanup)
it('shows submission failure on the user row and disables retry while stopping', () => {
  const message = { id: 'failed', role: 'user' as const, content: '保留原文', timestamp: 1, submissionError: '测试错误', streamingBehavior: 'followUp' as const }
  useSessionStore.setState({ messages: [message], isStreaming: true, isAborting: true, isSessionLoading: false, sessionLoadError: null })
  render(<MessageItem message={message} />)
  expect(screen.getByRole('status')).toHaveTextContent('测试错误')
  expect(screen.getByRole('button', { name: '重试' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(useSessionStore.getState().messages).toEqual([message])
})
