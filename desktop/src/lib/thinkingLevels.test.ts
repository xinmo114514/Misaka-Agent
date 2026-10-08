import { describe, expect, it } from 'vitest'
import { resolveSupportedLevels, thinkingStopsFor, resetTarget } from './thinkingLevels'
import type { ModelDetail } from '../types/settings'

const model = (extra: Partial<ModelDetail> = {}): ModelDetail => ({ id: 'm', provider: 'p', name: 'Model', reasoning: true, input: [], contextWindow: 1000, maxTokens: 100, configured: true, ...extra })
describe('capability ladder', () => {
  it('preserves explicit empty catalog and backend ladders', () => {
    expect(resolveSupportedLevels(model({ thinkingLevels: [] }))).toEqual([])
    expect(thinkingStopsFor({ currentModel: { provider: 'p', modelId: 'm' }, models: [model({ thinkingLevels: ['high'] })], backendLevels: [] })).toEqual({ levels: [], isFallback: false })
  })
  it('marks absent capability as generic instead of claiming provider stop counts', () => {
    expect(thinkingStopsFor({ currentModel: { provider: 'p', modelId: 'm' }, models: [model()], backendLevels: null }).isFallback).toBe(true)
  })
  it('respects fixed non-off and disabled map entries', () => {
    expect(resolveSupportedLevels(model({ thinkingLevels: ['high'] }))).toEqual(['high'])
    expect(resolveSupportedLevels(model({ thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null } }))).toEqual([])
    expect(resolveSupportedLevels(model({ thinkingLevelMap: { low: null, max: 'maximum' } }))).toEqual(['off', 'minimal', 'medium', 'high', 'max'])
  })
  it('resets to the user default adjusted upward then downward within the model', () => {
    expect(resetTarget('medium', ['low', 'high'])).toBe('high')
    expect(resetTarget('max', ['high'])).toBe('high')
    expect(resetTarget(undefined, ['off', 'medium', 'high'])).toBe('medium')
  })
  it('honors an explicit no-thinking capability over contradictory level metadata', () => {
    expect(resolveSupportedLevels(model({ supportsThinking: false, thinkingLevels: ['high'] }))).toEqual(['off'])
    expect(thinkingStopsFor({ currentModel: { provider: 'p', modelId: 'm' }, models: [model()], backendLevels: ['low', 'high'], backendSupportsThinking: false }).levels).toEqual(['off'])
  })

  it('keeps backend generic ladders explicitly unverified and adjustable', () => {
    const capability = { status: 'unknown' as const, source: 'generic' as const, levels: ['off', 'low', 'high'], adjustable: true }
    expect(thinkingStopsFor({ currentModel: { provider: 'p', modelId: 'm' }, models: [model()],
      backendLevels: capability.levels, backendCapability: capability })).toEqual({ levels: ['off', 'low', 'high'], isFallback: true })
  })

  it('represents provider-default as a default mode rather than a fake off level', () => {
    const capability = { status: 'default' as const, source: 'service' as const, levels: [], adjustable: false }
    expect(thinkingStopsFor({ currentModel: { provider: 'p', modelId: 'm' }, models: [model()],
      backendLevels: ['off'], backendCapability: capability })).toEqual({ levels: [], isFallback: false, isDefault: true })
  })
})
