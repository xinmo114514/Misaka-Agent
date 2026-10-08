import { afterEach, beforeEach, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ModelPickerPopover } from '../ModelPickerPopover'
import { useSessionStore } from '../../../store/useSessionStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { installResearchBridge } from '../../../lib/researchBridge'
import type { BridgeMessage } from '../../../types/global'

let sent: any[], ordinary: any[], deliver: (message: BridgeMessage) => void, release: () => void
beforeEach(() => {
  sent = []; ordinary = []
  window.bridge = { send: command => ordinary.push(command), on: () => () => {} }
  window.researchBridge = { send: command => sent.push(command), on: callback => { deliver = callback; return () => {} } }
  release = installResearchBridge()
  useSessionStore.setState({ agentMode: 'research', currentSessionId: 'failed-ordinary', activeSessionId: 'ordinary', sessionLoadError: 'ordinary failed', researchModelBinding: null, researchTeam: null, researchBinding: { sessionId: 'root', sessionFile: '/root', workspace: '/work', runId: 'run' } })
  useSettingsStore.setState({ models: ['A', 'B'].map(id => ({ provider: 'fixture', id, name: id, reasoning: true, thinkingLevels: ['high'], input: [], maxTokens: 100, contextWindow: 1000, configured: true })), researchModelBinding: null, researchModelSessionId: null, researchModelTarget: null })
  useSettingsStore.getState().applyResearchModelBinding('root', { effective: { provider: 'fixture', modelId: 'A' }, target: null, state: 'ready', epoch: 1 })
})
afterEach(() => release())
it('research model selection remains reachable independently of ordinary session readiness and shows pending target', async () => {
  render(<ModelPickerPopover onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'A' }))
  const option = screen.getByRole('button', { name: /B.*1 档/ })
  expect(option).toBeEnabled()
  fireEvent.click(option)
  expect(sent[0]).toMatchObject({ type: 'desktop_set_team_model', sessionId: 'root', modelId: 'B' })
  expect(ordinary).toEqual([])
  expect(screen.getByRole('button', { name: 'A' })).toBeVisible()
  expect(screen.getByText('正在切换至 fixture/B')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '取消模型切换' }))
  expect(sent[1]).toMatchObject({ action: 'cancel' })
  await act(async () => deliver({ type: 'ack', requestId: sent[1].requestId, ok: true, data: { modelBinding: { effective: { provider: 'fixture', modelId: 'A' }, target: null, state: 'ready', epoch: 3 } } }))
  expect(screen.queryByText('正在切换至 fixture/B')).not.toBeInTheDocument()
})
it('keeps failed switch error visible with retry and cancel controls', () => {
  useSettingsStore.getState().applyResearchModelBinding('root', { effective: { provider: 'fixture', modelId: 'A' }, target: { provider: 'fixture', modelId: 'B' }, state: 'failed', epoch: 2, error: 'Worker launch failed' })
  const view = render(<ModelPickerPopover onClose={() => {}} />)
  expect(screen.getByRole('status')).toHaveTextContent('Worker launch failed')
  fireEvent.click(screen.getByRole('button', { name: '重试模型切换' }))
  expect(sent[0]).toMatchObject({ action: 'retry', modelId: 'B' })
  view.unmount()
  act(() => useSettingsStore.getState().applyResearchModelBinding('root', { effective: { provider: 'fixture', modelId: 'A' }, target: { provider: 'fixture', modelId: 'B' }, state: 'failed', epoch: 3, error: 'Worker launch failed again' }))
  render(<ModelPickerPopover onClose={() => {}} />)
  expect(screen.getByRole('status')).toHaveTextContent('Worker launch failed again')
  expect(screen.getByRole('button', { name: '取消模型切换' })).toBeVisible()
})
it('keeps bound research depth read-only while its model choice remains switchable', () => {
  useSettingsStore.setState({ models: useSettingsStore.getState().models.map(model => ({ ...model, thinkingLevels: ['low', 'high'] })) })
  useSettingsStore.getState().applyResearchModelBinding('root', { effective: { provider: 'fixture', modelId: 'A' }, target: null, state: 'ready', epoch: 2 })
  render(<ModelPickerPopover onClose={() => {}} />)
  expect(screen.getByRole('slider')).toHaveAttribute('aria-disabled', 'true')
  expect(screen.getByRole('slider')).toHaveAttribute('aria-readonly', 'true')
  expect(screen.getByRole('slider')).not.toHaveAttribute('aria-busy')
  fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowLeft' })
  useSettingsStore.getState().setThinkingLevel('low')
  expect(ordinary).toEqual([])
  expect(screen.getByRole('button', { name: 'A' })).toBeEnabled()
})
