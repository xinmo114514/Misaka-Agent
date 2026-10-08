/**
 * Thinking-level ladder, mirrored from the Python side.
 *
 * The authority is `misaka/ai/models.py`: `_EXTENDED_THINKING_LEVELS` (line 22),
 * `get_supported_thinking_levels` (line 87) and `clamp_thinking_level` (line 109).
 * This file is the only TS mirror of those three, and both level pickers read their
 * stops through it -- the old `['off','low','medium','high']` literal baked into the
 * store disagreed with the seven-level backend on every model that offers xhigh.
 */
import type { ModelDetail, ThinkingCapability } from '../types/settings'

/** Ordered weakest -> strongest. The index is what the slider drags along. */
export const THINKING_LEVEL_ORDER = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type ThinkingLevelId = (typeof THINKING_LEVEL_ORDER)[number]

/**
 * What a reasoning model offers when nothing says otherwise: exactly what
 * `get_supported_thinking_levels` returns for `reasoning: true` with an empty map.
 * xhigh/max stay opt-in upstream, so guessing them here would offer levels the
 * provider may reject.
 */
export const FALLBACK_THINKING_LEVELS: ThinkingLevelId[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
]

export interface ThinkingLevelLabel {
  /** Large type above the slider. */
  zh: string
  /** Trigger pill and tick-rail ends, where three characters is too many. */
  short: string
  /** Latin name in the sub-line, mirroring Codex's "Ultra". */
  en: string
  desc: string
}

export const THINKING_LABELS: Record<ThinkingLevelId, ThinkingLevelLabel> = {
  off: { zh: '关闭', short: '关', en: 'Off', desc: '不做推理预算分配' },
  minimal: { zh: '极轻', short: '极轻', en: 'Minimal', desc: '仅少量前置推理，优先响应速度' },
  low: { zh: '轻', short: '轻', en: 'Low', desc: '轻量推理，适合问答与检索' },
  medium: { zh: '均衡', short: '均衡', en: 'Medium', desc: '速度与深度折中，日常研读推荐' },
  high: { zh: '深度', short: '深度', en: 'High', desc: '充分展开论证，社科理论推演建议档' },
  xhigh: { zh: '超高', short: '超高', en: 'Extra high', desc: '接近上限的推理预算' },
  max: { zh: '极高', short: '极高', en: 'Ultra', desc: '最大推理预算，长链路证明与反证' },
}

/** Never throws on an id the upstream catalog invented after this file was written. */
export function labelFor(id: string): ThinkingLevelLabel {
  const known = (THINKING_LABELS as Record<string, ThinkingLevelLabel | undefined>)[id]
  return known ?? { zh: id, short: id, en: id, desc: '' }
}

export function isThinkingLevelId(id: string): id is ThinkingLevelId {
  return (THINKING_LEVEL_ORDER as readonly string[]).includes(id)
}

/** Drop unknown ids and re-sort: the slider treats index order as strength order. */
export function normalizeLevels(levels: readonly string[] | null | undefined): ThinkingLevelId[] {
  if (!Array.isArray(levels)) return []
  const known = levels.filter(isThinkingLevelId)
  return THINKING_LEVEL_ORDER.filter((id) => known.includes(id))
}

/**
 * Mirror of `get_supported_thinking_levels` (models.py:87-106).
 *
 * The three cases only look similar: a key mapped to `null` is an explicit
 * disable, a *missing* key means supported, and `xhigh`/`max` are opt-in. That is
 * why this reads `hasOwnProperty` and `=== null` instead of a truthiness test --
 * `!map.off` would hand a "no thinking at all" model an off slot it never asked for.
 */
export function resolveSupportedLevels(
  model: Pick<ModelDetail, 'reasoning' | 'supportsThinking' | 'thinkingLevelMap' | 'thinkingLevels' | 'thinkingCapability'> | null | undefined,
): ThinkingLevelId[] {
  if (!model) return []
  if (model.thinkingCapability?.status === 'default') return []
  if (model.thinkingCapability) return normalizeLevels(model.thinkingCapability.levels)
  if ((model.supportsThinking ?? model.reasoning) === false) return ['off']
  if (Array.isArray(model.thinkingLevels)) return normalizeLevels(model.thinkingLevels)

  const map = model.thinkingLevelMap ?? {}
  const supported: ThinkingLevelId[] = []
  for (const level of THINKING_LEVEL_ORDER) {
    const named = Object.prototype.hasOwnProperty.call(map, level)
    if (named && map[level] === null) continue
    if (level === 'xhigh' || level === 'max') {
      if (named) supported.push(level)
      continue
    }
    supported.push(level)
  }
  return supported
}

/** A count is a provider claim: generic compatibility stops do not establish it. */
export function hasThinkingCapability(model: ModelDetail | null | undefined): boolean {
  if (model?.thinkingCapability) return model.thinkingCapability.status !== 'unknown'
  return Boolean(model && (
    Array.isArray(model.thinkingLevels) || (model.supportsThinking ?? model.reasoning) === false ||
    Object.keys(model.thinkingLevelMap ?? {}).length > 0
  ))
}

/** Mirror of `clamp_thinking_level` (models.py:109-124): step up first, then down. */
export function clampThinkingLevel(
  levels: readonly ThinkingLevelId[],
  requested: string | null | undefined,
): ThinkingLevelId {
  if (!levels.length) return 'off'
  if (requested && (levels as readonly string[]).includes(requested)) {
    return requested as ThinkingLevelId
  }
  const wanted = requested ? THINKING_LEVEL_ORDER.indexOf(requested as ThinkingLevelId) : -1
  if (wanted === -1) return levels[0]

  for (const candidate of THINKING_LEVEL_ORDER.slice(wanted)) {
    if (levels.includes(candidate)) return candidate
  }
  for (const candidate of THINKING_LEVEL_ORDER.slice(0, wanted).reverse()) {
    if (levels.includes(candidate)) return candidate
  }
  return levels[0]
}

export interface ThinkingStops {
  levels: ThinkingLevelId[]
  /** True when neither the backend nor the model catalog could describe the ladder. */
  isFallback: boolean
  isDefault?: boolean
}

export function normalizeThinkingCapability(value: unknown): ThinkingCapability | null {
  if (!value || typeof value !== 'object') return null
  const data = value as Partial<ThinkingCapability>
  if (!['known', 'unknown', 'default'].includes(String(data.status))) return null
  return {
    status: data.status!, source: ['model', 'generic', 'service'].includes(String(data.source)) ? data.source! : 'generic',
    levels: data.status === 'default' ? [] : normalizeLevels(data.levels),
    adjustable: data.status !== 'default' && data.adjustable === true,
  }
}

/**
 * The ladder to render, most authoritative source first: what the bridge answered
 * for the live session, then what the model's own capability map implies, then the
 * generic five. Keeping the order matters -- the first is clamped server-side and
 * cannot lie, the second is what makes the slider re-rank the instant a model is
 * picked, before that round trip lands.
 */
export function thinkingStopsFor(params: {
  currentModel: { provider: string; modelId: string } | null | undefined
  models: readonly ModelDetail[]
  /** null/undefined = absent; [] = an explicitly empty capability. */
  backendLevels?: readonly string[] | null
  backendSupportsThinking?: boolean
  backendCapability?: ThinkingCapability | null
}): ThinkingStops {
  const { currentModel, models, backendLevels } = params
  const matchedModel = currentModel ? models.find(m => m.provider === currentModel.provider && m.id === currentModel.modelId) : undefined
  const capability = params.backendCapability ?? matchedModel?.thinkingCapability
  if (capability?.status === 'default') return { levels: [], isFallback: false, isDefault: true }
  if (capability) return { levels: normalizeLevels(capability.levels), isFallback: capability.status === 'unknown' }
  if (Array.isArray(backendLevels)) return {
    levels: params.backendSupportsThinking === false ? ['off'] : normalizeLevels(backendLevels),
    isFallback: false,
  }

  const matched = currentModel
    ? models.find((m) => m.provider === currentModel.provider && m.id === currentModel.modelId)
    : undefined
  const fromModel = resolveSupportedLevels(matched)
  if (hasThinkingCapability(matched)) return { levels: fromModel, isFallback: false }

  return { levels: FALLBACK_THINKING_LEVELS, isFallback: true }
}

/**
 * Where the reset control lands: the persisted default for new sessions, clamped into
 * this model's ladder. Falling back to `off` would make the button a kill switch
 * rather than a return to the user's own setting.
 *
 * The `medium` stand-in is not a guess -- `getDefaultThinkingLevel()` returns None when
 * nothing was ever saved, and the engine resolves that to `DEFAULT_THINKING_LEVEL`
 * (`misaka/core/defaults.py:7`) on a model switch. An explicit `off` is honoured as-is.
 */
export function resetTarget(
  defaultLevel: string | null | undefined,
  levels: readonly ThinkingLevelId[],
): ThinkingLevelId {
  return clampThinkingLevel(levels, defaultLevel || 'medium')
}
