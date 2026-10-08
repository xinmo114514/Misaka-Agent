import { beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { Composer } from '../Composer'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { useSessionStore } from '../../../store/useSessionStore'
import type { ModelDetail } from '../../../types/settings'

const model = (id: string, extra: Partial<ModelDetail> = {}): ModelDetail => ({ id, name: id, provider: 'fixture', reasoning: true, thinkingLevels: ['off', 'low', 'high'], configured: true, input: [], contextWindow: 1000, maxTokens: 100, ...extra })
beforeEach(() => {
  window.bridge = { send: vi.fn(), on: () => () => {} }
  useSessionStore.setState({ currentSessionId: 'picker', activeSessionId: 'picker', sessionLoadError: null, isStreaming: false, isSessionLoading: false, isAborting: false })
  useSettingsStore.setState({ currentModel: { provider: 'fixture', modelId: 'A', name: 'A', thinking: 'low' }, models: [model('A'), model('B', { thinkingLevels: ['high'] }), model('Unknown', { thinkingLevels: undefined }), model('Empty', { thinkingLevels: [] })], availableThinkingLevels: ['off', 'low', 'high'], supportsThinking: true, thinkingLevel: 'low', modelSwitchPending: false, pickerError: null, defaultModel: 'A', defaultProvider: 'fixture' })
})
const open = () => {
  render(<Composer />)
  const trigger = screen.getByTitle('模型与思考深度')
  fireEvent.click(trigger)
  return trigger
}
it('shows the selected model name on the pill and in the depth layer', () => {
  const trigger = open()
  expect(trigger).toHaveTextContent('A')
  expect(screen.getByRole('button', { name: 'A' })).toBeVisible()
})
it('falls back to 选择模型 when no model is selected', () => {
  useSettingsStore.setState({ currentModel: null })
  render(<Composer />)
  expect(screen.getByTitle('模型与思考深度')).toHaveTextContent('选择模型')
})
it('opens focused on the compact rail, navigates back with Esc, then closes and restores focus', () => {
  const trigger = open()
  expect(screen.getByRole('slider')).toHaveFocus()
  fireEvent.click(screen.getByRole('button', { name: 'A' }))
  expect(screen.getByRole('button', { name: '返回思考深度' })).toHaveFocus()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.getByRole('slider')).toHaveFocus()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
})
it('marks real single stop counts, unknown capability without counts, and empty capability', () => {
  open()
  fireEvent.click(screen.getByRole('button', { name: 'A' }))
  const fixed = screen.getByRole('button', { name: /B.*1 档/ })
  expect(within(fixed).getByText('1 档')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Unknown.*模型默认/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Empty.*无可选档位/ })).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '搜索模型' })).not.toBeInTheDocument()
  fireEvent.click(fixed)
  expect(screen.getByRole('slider')).toHaveAttribute('aria-disabled', 'true')
  expect(screen.getByText('高')).toBeInTheDocument()
})
it('shows search above five configured models and closes on outside interaction', () => {
  useSettingsStore.setState({ models: Array.from({ length: 6 }, (_, n) => model(`M${n}`)) })
  open()
  fireEvent.click(screen.getByRole('button', { name: 'A' }))
  const input = screen.getByRole('textbox', { name: '搜索模型' })
  expect(input).toHaveFocus()
  fireEvent.change(input, { target: { value: 'M5' } })
  expect(screen.getByText('M5')).toBeInTheDocument()
  expect(screen.queryByText('M4')).not.toBeInTheDocument()
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
it('keeps configuration available for an empty model list', () => {
  useSettingsStore.setState({ models: [] })
  const configure = vi.fn()
  render(<Composer onOpenModelSettings={configure} />)
  fireEvent.click(screen.getByTitle('模型与思考深度'))
  fireEvent.click(screen.getByRole('button', { name: 'A' }))
  fireEvent.click(screen.getByRole('button', { name: '前往配置模型' }))
  expect(configure).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
it('consumes picker Escape before the composer stop shortcut', () => {
  const stop = vi.fn()
  useSessionStore.setState({ isStreaming: true, abortGeneration: stop })
  open()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(stop).not.toHaveBeenCalled()
})
it('keeps configuration reachable but disables model choices for an unready displayed session', () => {
  open()
  fireEvent.click(screen.getByRole('button', { name: 'A' }))
  act(() => useSessionStore.setState({ currentSessionId: 'failed-preview', sessionLoadError: 'load failed' }))
  expect(screen.getByRole('button', { name: /B.*1 档/ })).toBeDisabled()
  expect(screen.getByRole('button', { name: '配置凭据' })).toBeEnabled()
})


it('displays 默认 heading and disabled gray slider for unknown thinking depth model', () => {
  open()
  fireEvent.click(screen.getByRole('button', { name: 'A' }))
  const unknownModel = screen.getByRole('button', { name: /Unknown.*模型默认/ })
  fireEvent.click(unknownModel)
  expect(screen.getByText('默认')).toBeInTheDocument()
  const slider = screen.getByRole('slider')
  expect(slider).toHaveAttribute('aria-disabled', 'true')
  expect(slider).toHaveAttribute('aria-readonly', 'true')
})