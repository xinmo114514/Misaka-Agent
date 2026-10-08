import { useSettingsStore } from '../src/store/useSettingsStore'
import { useSessionStore } from '../src/store/useSessionStore'
import { clampThinkingLevel, resolveSupportedLevels } from '../src/lib/thinkingLevels'
import type { BridgeMessage } from '../src/types/global'
import type { ModelDetail } from '../src/types/settings'

const model = (id: string, name: string, extra: Partial<ModelDetail> = {}): ModelDetail => ({ id, name, provider: 'misaka-fixture', configured: true, reasoning: true, input: [], contextWindow: 128000, maxTokens: 16000, ...extra })
const models = [
  model('full', 'Misaka · 研究推理', { thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }),
  model('two', '两档推理模型', { thinkingLevels: ['low', 'high'] }),
  model('fixed', '固定深度模型', { thinkingLevels: ['high'] }),
  model('plain', '即时响应模型', { reasoning: false, thinkingLevels: ['off'] }),
  model('unknown', '能力待描述模型'),
  model('empty', '空能力模型', { thinkingLevels: [] }),
  model('mapped', '自定义预算模型', { thinkingLevelMap: { off: null, minimal: null, low: 'small', medium: null, high: 'large', xhigh: null, max: null } }),
  model('long', 'Misaka Academic Research Reasoning — 超长模型名称与跨供应商上下文验证', { thinkingLevels: ['off', 'low', 'medium', 'high'] }),
]
let enabled = false
let hold = false
let failNext = false
let backend = { currentModel: { provider: 'misaka-fixture', modelId: 'full', name: models[0].name, thinking: 'max' }, level: 'max', levels: models[0].thinkingLevels!, supportsThinking: true }
const pending = new Map<string, BridgeMessage>()
let deliver: (message: BridgeMessage) => void

export function pickerReply(command: any, emit: (message: BridgeMessage) => void): boolean {
  deliver = emit
  if (!enabled || !['get_models', 'get_thinking_levels', 'set_model', 'set_thinking'].includes(command.type)) return false
  let ok = true
  if (failNext && command.type.startsWith('set_')) { failNext = false; ok = false }
  else if (command.type === 'set_model') {
    const selected = models.find(m => m.id === command.modelId)!
    const levels = resolveSupportedLevels(selected)
    const level = clampThinkingLevel(levels, backend.level)
    backend = { currentModel: { provider: selected.provider, modelId: selected.id, name: selected.name, thinking: level }, level, levels, supportsThinking: selected.reasoning }
  } else if (command.type === 'set_thinking') {
    const level = clampThinkingLevel(backend.levels as any, command.level)
    backend = { ...backend, level, currentModel: { ...backend.currentModel, thinking: level } }
  }
  const data = command.type === 'get_models' ? { ...backend, models, defaultProvider: models[0].provider, defaultModel: 'full' } : { ...backend }
  const reply = { type: 'ack', requestId: command.requestId, ok, data, ...(ok ? {} : { error: 'fixture failure' }) } as BridgeMessage
  if (hold) pending.set(command.requestId, reply)
  else queueMicrotask(() => emit(reply))
  return true
}

export const modelPickerFixture = {
  seed: () => {
    enabled = true; hold = false; failNext = false; pending.clear()
    backend = { currentModel: { provider: models[0].provider, modelId: 'full', name: models[0].name, thinking: 'max' }, level: 'max', levels: models[0].thinkingLevels!, supportsThinking: true }
    useSessionStore.setState({ currentSessionId: 'picker-fixture', activeSessionId: 'picker-fixture', sessionLoadError: null, isSessionLoading: false, isStreaming: false, isAborting: false })
    useSettingsStore.setState({ models, currentModel: backend.currentModel, thinkingLevel: backend.level, availableThinkingLevels: backend.levels, supportsThinking: true, modelSwitchPending: false, defaultProvider: models[0].provider, defaultModel: 'full', configPaths: { cwd: 'C:/research', agentDir: '', authPath: '', sessionsDir: '', theme: 'light', defaultThinkingLevel: 'medium' }, pickerError: null })
    useSettingsStore.getState().resyncModelCapability()
  },
  hold: (value: boolean) => { hold = value },
  failNext: () => { failNext = true },
  pending: () => [...pending.keys()],
  release: (id: string) => { const reply = pending.get(id); if (reply) { pending.delete(id); deliver(reply) } },
  state: () => { const s = useSettingsStore.getState(); return { model: s.currentModel, level: s.thinkingLevel, levels: s.availableThinkingLevels, pending: s.modelSwitchPending, defaultModel: s.defaultModel } },
  empty: () => useSettingsStore.setState({ models: [] }),
  session: () => {
    backend = { currentModel: { provider: models[0].provider, modelId: 'full', name: models[0].name, thinking: 'max' }, level: 'max', levels: models[0].thinkingLevels!, supportsThinking: true }
    useSessionStore.setState({ currentSessionId: 'picker-fixture-next', activeSessionId: 'picker-fixture-next' })
    useSettingsStore.getState().resyncModelCapability()
  },
}
