import { beforeEach, expect, it } from 'vitest'
import { useSettingsStore } from '../useSettingsStore'
import type { BridgeMessage } from '../../types/global'
import { useSessionStore } from '../useSessionStore'

let sent: any[] = []
const state = () => useSettingsStore.getState()
const ack = (requestId: string, data: any, ok = true) => state().handleBridgeMessage({ type: 'ack', requestId, ok, data, ...(ok ? {} : { error: 'fixture failure' }) } as BridgeMessage)
const last = (type: string) => sent.filter(command => command.type === type).at(-1)!
const truth = { currentModel: { provider: 'p', modelId: 'a', name: 'A', thinking: 'medium' }, level: 'medium', levels: ['off', 'medium', 'high'], supportsThinking: true }
beforeEach(() => {
  useSessionStore.setState({ currentSessionId: 'picker', activeSessionId: 'picker', isSessionLoading: false, sessionLoadError: null })
  sent = []
  window.bridge = { send: command => { sent.push(command) }, on: () => () => {} }
  useSettingsStore.setState({ models: ['a', 'b', 'c'].map(id => ({ id, provider: 'p', name: id.toUpperCase(), reasoning: true, thinkingLevels: ['low', 'high'], input: [], maxTokens: 100, contextWindow: 1000, configured: true })), modelSwitchPending: false, pickerError: null })
  state().resyncModelCapability()
  ack(last('get_models').requestId, { ...truth, models: state().models })
  ack(last('get_thinking_levels').requestId, truth)
})
it('does not target the old backend when the displayed session failed hydration', () => {
  useSessionStore.setState({ currentSessionId: 'preview-next', sessionLoadError: 'load failed', isSessionLoading: false })
  const before = sent.length
  state().setSessionModel('p', 'b')
  state().setThinkingLevel('high')
  expect(sent).toHaveLength(before)
})
it('does not save a mixed previous-model and next-session-depth rollback snapshot', () => {
  useSessionStore.setState({ currentSessionId: 'next', activeSessionId: 'next' })
  state().resyncModelCapability()
  ack(last('get_thinking_levels').requestId, { levels: ['high'], level: 'high', supportsThinking: true })
  const before = sent.filter(c => c.type === 'set_model').length
  state().setSessionModel('p', 'c')
  expect(sent.filter(c => c.type === 'set_model')).toHaveLength(before)
})
it('only accepts the newest model reply and never changes the global default', () => {
  useSettingsStore.setState({ defaultProvider: 'p', defaultModel: 'a' })
  state().setSessionModel('p', 'b'); const older = last('set_model')
  state().setSessionModel('p', 'c'); const newer = last('set_model')
  ack(older.requestId, { ...truth, currentModel: { ...truth.currentModel, modelId: 'b' } })
  expect(state().currentModel?.modelId).toBe('c')
  expect(state().modelSwitchPending).toBe(true)
  ack(newer.requestId, { ...truth, currentModel: { ...truth.currentModel, modelId: 'c' }, level: 'high', levels: ['high'] })
  expect(state().thinkingLevel).toBe('high')
  expect(state().defaultModel).toBe('a')
})
it('restores confirmed state immediately when the newest model fails', () => {
  state().setSessionModel('p', 'b')
  ack(last('set_model').requestId, {}, false)
  expect(state().currentModel?.modelId).toBe('a')
  expect(state().thinkingLevel).toBe('medium')
  expect(state().availableThinkingLevels).toEqual(['off', 'medium', 'high'])
  expect(state().pickerError).toContain('已恢复')
})
it('keeps backend supportsThinking authoritative when the catalog read arrives second', () => {
  state().resyncModelCapability()
  const modelRead = last('get_models')
  ack(last('get_thinking_levels').requestId, { levels: ['off'], level: 'off', supportsThinking: false })
  ack(modelRead.requestId, { ...truth, currentModel: { ...truth.currentModel, thinking: 'off' }, models: state().models })
  expect(state().supportsThinking).toBe(false)
})
it('preserves explicitly empty acknowledged levels', () => {
  state().setSessionModel('p', 'b')
  ack(last('set_model').requestId, { ...truth, levels: [] })
  expect(state().availableThinkingLevels).toEqual([])
})
it('rejects stale session reads and reads superseded by a newer model operation', () => {
  state().resyncModelCapability(); const olderRead = last('get_thinking_levels')
  state().resyncModelCapability(); const newerRead = last('get_thinking_levels')
  expect(newerRead.requestId).not.toBe(olderRead.requestId)
  ack(newerRead.requestId, { ...truth, level: 'high' })
  ack(olderRead.requestId, truth)
  expect(state().thinkingLevel).toBe('high')
  state().resyncModelCapability(); const read = last('get_thinking_levels')
  state().setSessionModel('p', 'c')
  ack(read.requestId, truth)
  expect(state().modelSwitchPending).toBe(true)
  expect(state().currentModel?.modelId).toBe('c')
})
it('blocks depth during model confirmation and rolls back latest failed depth', () => {
  state().setSessionModel('p', 'b')
  state().setThinkingLevel('low')
  expect(sent.filter(c => c.type === 'set_thinking')).toHaveLength(0)
  ack(last('set_model').requestId, truth)
  state().setThinkingLevel('high'); const older = last('set_thinking')
  state().setThinkingLevel('off'); const newer = last('set_thinking')
  ack(older.requestId, { ...truth, level: 'high' })
  expect(state().thinkingLevel).toBe('off')
  ack(newer.requestId, {}, false)
  expect(state().thinkingLevel).toBe('medium')
})
it('ignores an old model acknowledgement after the active session changed', () => {
  state().setSessionModel('p', 'b')
  const oldSwitch = last('set_model')
  useSessionStore.setState({ currentSessionId: 'new-session', activeSessionId: 'new-session' })
  state().resyncModelCapability()
  const current = { ...truth, currentModel: { ...truth.currentModel, modelId: 'c', name: 'C', thinking: 'high' }, level: 'high' }
  ack(last('get_models').requestId, { ...current, models: state().models })
  ack(last('get_thinking_levels').requestId, current)
  ack(oldSwitch.requestId, { ...truth, currentModel: { ...truth.currentModel, modelId: 'b' } })
  expect(state().currentModel?.modelId).toBe('c')
  expect(state().thinkingLevel).toBe('high')
  expect(state().modelSwitchPending).toBe(false)
})
