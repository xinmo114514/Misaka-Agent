import { create } from 'zustand'
import type {
  SettingsSectionId,
  ModelProviderInfo,
  ModelDetail,
  ThinkingCapability,
  ConfigPaths,
  CurrentModelConfig,
  ProviderGroup,
  CustomProviderDraft,
  CustomModelDraft,
  ConnectivityResult,
  ToolInfo,
  DiagnosticsInfo,
  UpdateCheckResult,
  FontSizeOption,
  CloseWindowAction,
} from '../types/settings'
import type { BridgeMessage, ThemeData } from '../types/global'
import { useSessionStore } from './useSessionStore'
import { themeRegistry } from '../theme/registry'
import type { ThemeSummary } from '../theme/types'
import { newRequestId } from '../lib/bridge'
import { requestResearch } from '../lib/researchBridge'
import type { ResearchModelBinding, ResearchModelRef, ResearchTeamSnapshot } from '../types/research'

let latestThemeRequest = 0
let latestMirroredBuiltinRequest = 0
import {
  clampThinkingLevel,
  isThinkingLevelId,
  normalizeLevels,
  resolveSupportedLevels,
  hasThinkingCapability,
  normalizeThinkingCapability,
} from '../lib/thinkingLevels'

const pendingCallbacks = new Map<string, (res: { ok: boolean; data?: any; error?: string }) => void>()

/** A bridge ack is the commit point for settings actions. Silence is an unconfirmed result. */
function sendSettingsCommand(type: string, payload: Record<string, any> = {}, timeoutMs = 20_000): Promise<any> {
  if (!window.bridge?.send) return Promise.reject(new Error('桌面桥接进程尚未就绪'))
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : newRequestId(type)
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (pendingCallbacks.delete(requestId)) reject(new Error(`${type} 等待超时，结果未确认`))
    }, timeoutMs)
    pendingCallbacks.set(requestId, (result) => {
      window.clearTimeout(timer)
      if (result.ok) resolve(result.data)
      else reject(new Error(result.error || `${type} 失败`))
    })
    try {
      window.bridge.send({ ...payload, type, requestId })
    } catch (error) {
      pendingCallbacks.delete(requestId)
      window.clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/**
 * The newest model / thinking switch the renderer has issued. Only its ack is allowed to
 * touch the store: a switch that has already been superseded -- by another model pick, or by
 * the resync a session swap fires -- describes a state the session no longer holds, and
 * applying it is exactly how a picker ends up showing a model the engine never agreed to.
 */
let latestModelSwitchId: string | null = null
let latestResearchModelRequest: string | null = null
let awaitingResearchModelRequest: { requestId: string; sessionId: string; baseEpoch: number } | null = null
let latestThinkingSwitchId: string | null = null
let latestModelsReadId: string | null = null
let latestThinkingReadId: string | null = null
let requestSessionId = ''
type ConfirmedCapability = Pick<SettingsState, 'currentModel' | 'thinkingLevel' | 'availableThinkingLevels' | 'supportsThinking' | 'thinkingCapability'>
let confirmedCapability: ConfirmedCapability | null = null
let confirmedSessionId = ''

function capabilitySnapshot(state: SettingsState): ConfirmedCapability {
  return { currentModel: state.currentModel, thinkingLevel: state.thinkingLevel,
    availableThinkingLevels: state.availableThinkingLevels, supportsThinking: state.supportsThinking, thinkingCapability: state.thinkingCapability }
}

function rememberConfirmed(state: SettingsState) {
  confirmedCapability = capabilitySnapshot(state)
  confirmedSessionId = useSessionStore.getState().currentSessionId
}

function beginSwitch(state: SettingsState) {
  const sessionId = useSessionStore.getState().currentSessionId
  if (!confirmedCapability || confirmedSessionId !== sessionId) rememberConfirmed(state)
  requestSessionId = sessionId
  // Even a matching session read issued before this operation is older than its preview.
  latestModelsReadId = null
  latestThinkingReadId = null
}

function sessionReady() {
  const session = useSessionStore.getState()
  return !session.isSessionLoading && !session.sessionLoadError && session.currentSessionId === session.activeSessionId
}

function contextIsCurrent(allowLoading = false) {
  const session = useSessionStore.getState()
  return requestSessionId === session.currentSessionId &&
    requestSessionId === session.activeSessionId && !session.sessionLoadError && (allowLoading || sessionReady())
}
/** Set once per failed switch and cleared by its retry, a newer switch, or the timer below. */
let pickerErrorTimer: number | undefined

/**
 * A unique suffix for switch request ids. Date.now() alone collides when the user clicks two
 * model rows inside the same millisecond, and colliding ids defeat the epoch check below: a
 * superseded ack looks current and repaints a model the session has already moved past.
 */
let switchSeq = 0
const switchReqId = (kind: 'sm' | 'st') => `req_${kind}_${Date.now()}_${++switchSeq}`

function clearPickerError(set: (partial: Partial<SettingsState>) => void) {
  if (typeof window !== 'undefined') window.clearTimeout(pickerErrorTimer)
  pickerErrorTimer = undefined
  set({ pickerError: null })
}

/**
 * The ack for the switch the user is still waiting on, if there is one. A superseded ack
 * returns null and lands nowhere: the store already reflects the newer request, and the
 * session may belong to a different agent entirely by now.
 */
function ackIsCurrent(kind: 'model' | 'thinking', requestId: string) {
  return contextIsCurrent() && (kind === 'model'
    ? latestModelSwitchId === requestId
    : latestThinkingSwitchId === requestId)
}

function finishSwitch(
  set: (partial: Partial<SettingsState>) => void,
  kind: 'model' | 'thinking',
  requestId: string,
) {
  if (kind === 'model') {
    if (latestModelSwitchId === requestId) latestModelSwitchId = null
    set({ modelSwitchPending: false })
  } else if (latestThinkingSwitchId === requestId) {
    latestThinkingSwitchId = null
  }
}

function reportSwitchError(set: (partial: Partial<SettingsState>) => void, message: string) {
  set({ pickerError: message })
  if (typeof window === 'undefined') return
  window.clearTimeout(pickerErrorTimer)
  // Long enough to read, short enough that a stale failure cannot outlive the popover the
  // user already closed. Any new switch clears it earlier.
  pickerErrorTimer = window.setTimeout(() => {
    pickerErrorTimer = undefined
    set({ pickerError: null })
  }, 4000)
}

// Load saved local preferences
const FONT_SIZE_OPTIONS: readonly FontSizeOption[] = ['compact', 'standard', 'spacious']

function readSavedFontSize(): FontSizeOption {
  if (typeof localStorage === 'undefined') return 'standard'
  let raw: string | null = null
  try {
    raw = localStorage.getItem('misaka_font_size')
  } catch {
    return 'standard'
  }
  if ((FONT_SIZE_OPTIONS as readonly string[]).includes(raw ?? '')) return raw as FontSizeOption
  if (raw !== null) {
    // Heal a corrupt value instead of half-applying it: an unknown data-font-size matches no
    // CSS rule, so the app would render 13px while the settings panel highlighted nothing.
    try {
      localStorage.setItem('misaka_font_size', 'standard')
    } catch {}
  }
  return 'standard'
}

const savedFontSize = readSavedFontSize()
const savedHideThinking = typeof localStorage !== 'undefined' ? localStorage.getItem('misaka_hide_thinking') === 'true' : false
const savedShellConfirm = typeof localStorage !== 'undefined' ? localStorage.getItem('misaka_shell_confirm') === 'true' : false
function readSavedCloseWindowAction(): CloseWindowAction {
  if (typeof localStorage === 'undefined') return 'ask'
  try {
    const raw = localStorage.getItem('misaka_close_window_action')
    if (raw === 'tray' || raw === 'quit' || raw === 'ask') return raw
  } catch {}
  return 'ask'
}

const savedCloseWindowAction = readSavedCloseWindowAction()

// data-font-size has exactly one owner: this module. main.tsx imports the store before it
// renders, so the attribute is in place for the first paint and nothing reflows afterwards.
if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('data-font-size', savedFontSize)
}

function applyFontSize(size: FontSizeOption) {
  try {
    localStorage.setItem('misaka_font_size', size)
  } catch (e) {
    console.error('Failed to persist font size:', e)
  }
  document.documentElement.setAttribute('data-font-size', size)
}

// index.html stamps data-theme from the load URL before the bundle runs, so the panel can start
// out already agreeing with the palette on screen instead of a round trip later.
function readAppliedThemeName(): string {
  if (typeof document !== 'undefined') {
    const applied = document.documentElement.getAttribute('data-theme')
    if (applied) return applied
  }
  return 'dark'
}

interface SettingsState {
  activeSection: SettingsSectionId
  searchQuery: string
  providers: ModelProviderInfo[]
  providerGroups: ProviderGroup[]
  visibleProviderIds: string[]
  customProviders: CustomProviderDraft[]
  customProvidersPath: string
  customProvidersError: string | null
  models: ModelDetail[]
  currentModel: CurrentModelConfig | null
  defaultProvider: string | null
  defaultModel: string | null
  thinkingLevel: string
  availableThinkingLevels: string[] | null
  supportsThinking: boolean
  thinkingCapability: ThinkingCapability | null
  /** A set_model is in flight: the ladder shown is the local preview, so commits must wait.
      A level commit needs no flag of its own -- the rail already paints what was asked for and
      the ack corrects it, so dimming on every drag release would only read as a stall. */
  modelSwitchPending: boolean
  /** Last picker failure, shown inside the popover instead of silently reverting the pill. */
  pickerError: string | null
  researchModelBinding: ResearchModelBinding | null
  researchModelSessionId: string | null
  researchModelTarget: ResearchModelRef | null
  configPaths: ConfigPaths | null
  themes: ThemeSummary[]
  loadThemes: () => Promise<void>
  themeName: string
  /** Set when a theme request was refused; rendered by the appearance section. */
  themeError: string | null
  productSettings: Record<string, any>
  isLoading: boolean
  statusMessage: string | null
  connectivity: Record<string, ConnectivityResult | 'testing'>

  // Real tools & extensions state
  tools: ToolInfo[]
  slashCommands: string[]
  isLoadingTools: boolean

  // Diagnostics & system health
  diagnostics: DiagnosticsInfo | null
  isDiagnosing: boolean
  updateStatus: UpdateCheckResult | null
  isCheckingUpdate: boolean

  // Appearance & preferences
  fontSize: FontSizeOption
  hideThinkingBlock: boolean
  autoCompaction: boolean
  requireShellConfirm: boolean
  lastExportedPath: string | null

  // Actions
  setActiveSection: (sec: SettingsSectionId) => void
  setSearchQuery: (q: string) => void
  fetchInitialData: () => void
  fetchCustomProviders: () => void
  fetchTools: () => void
  runDiagnostics: () => Promise<DiagnosticsInfo | null>
  checkUpdate: () => Promise<UpdateCheckResult | null>
  setWorkspaceCwd: (path: string) => Promise<string>
  setSessionModel: (provider: string, modelId: string, persist?: boolean) => void
  applyResearchModelBinding: (sessionId: string, binding: ResearchModelBinding) => void
  switchResearchTeamModel: (provider: string, modelId: string, action?: 'switch' | 'retry' | 'cancel') => void
  retryResearchModelSwitch: () => void
  cancelResearchModelSwitch: () => void
  /** Clear the popover's error line, e.g. when the picker closes. */
  clearPickerError: () => void
  /** Re-read the live model and its thinking ladder; call when the session changes. */
  resyncModelCapability: () => void
  setDefaultModel: (provider: string, modelId: string) => void
  setThinkingLevel: (level: string) => void
  setDefaultThinkingLevel: (level: string) => void
  setHideThinkingBlock: (hide: boolean) => void
  setAutoCompaction: (enabled: boolean) => void
  closeWindowAction: CloseWindowAction
  setCloseWindowAction: (action: CloseWindowAction) => void
  setFontSize: (size: FontSizeOption) => void
  setRequireShellConfirm: (required: boolean) => void
  resetResearchSettings: () => Promise<void>
  exportCurrentSession: (sessionPath?: string) => Promise<{ ok: boolean; path?: string; error?: string }>
  setProviderCredential: (provider: string, apiKey: string) => void
  deleteProviderCredential: (provider: string) => void
  upsertCustomProvider: (draft: CustomProviderDraft & { apiKey: string }) => Promise<{ ok: boolean; error?: string }>
  fetchRemoteModels: (params: { baseUrl: string; api: string; apiKey?: string; providerId?: string; headers?: Record<string, string> }) => Promise<{ ok: boolean; models?: CustomModelDraft[]; error?: string }>
  deleteCustomProvider: (providerId: string) => void
  reorderCustomProviders: (order: string[]) => void
  testProviderConnectivity: (providerId: string, modelId?: string) => void
  clearConnectivity: (providerId: string) => void
  refreshModels: () => void
  saveProductSetting: (section: string, key: string, value: any) => Promise<void>
  setThemeName: (theme: string) => void
  pickDirectory: () => Promise<string | null>
  handleBridgeMessage: (msg: BridgeMessage) => void
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  activeSection: 'models',
  searchQuery: '',
  providers: [],
  providerGroups: [],
  visibleProviderIds: [],
  customProviders: [],
  customProvidersPath: '',
  customProvidersError: null,
  models: [],
  currentModel: null,
  defaultProvider: null,
  defaultModel: null,
  thinkingLevel: 'off',
  // null means not yet described; [] is an explicit no-stops capability.
  availableThinkingLevels: null,
  supportsThinking: false,
  thinkingCapability: null,
  modelSwitchPending: false,
  pickerError: null,
  researchModelBinding: null,
  researchModelSessionId: null,
  researchModelTarget: null,
  configPaths: null,
  themes: themeRegistry.list(),
  loadThemes: async () => {
    try {
      if (window.theme?.listThemes) set({ themes: await window.theme.listThemes() })
    } catch {
      set({ themeError: '读取主题列表失败' })
    }
  },
  themeName: readAppliedThemeName(),
  themeError: null,
  productSettings: {
    research: { token_cap: 0, plan_approval: true },
    subagents: {
      coordinator_mode: true,
      verification_agent: true,
      auto_memory: true,
      max_concurrent: 4,
    },
    network: { max_concurrent_sisters: 4 },
  },
  isLoading: false,
  statusMessage: null,
  connectivity: {},

  // New fields
  tools: [],
  slashCommands: [],
  isLoadingTools: false,
  diagnostics: null,
  isDiagnosing: false,
  updateStatus: null,
  isCheckingUpdate: false,
  fontSize: savedFontSize,
  hideThinkingBlock: savedHideThinking,
  autoCompaction: true,
  requireShellConfirm: savedShellConfirm,
  closeWindowAction: savedCloseWindowAction,
  lastExportedPath: null,

  setActiveSection: (sec: SettingsSectionId) => set({ activeSection: sec }),
  setSearchQuery: (q: string) => set({ searchQuery: q }),

  fetchInitialData: () => {
    set({ isLoading: true })
    if (window.bridge?.send) {
      window.bridge.send({ type: 'get_providers', requestId: 'req_providers' })
      window.bridge.send({ type: 'get_provider_groups', requestId: 'req_provider_groups' })
      window.bridge.send({ type: 'get_custom_providers', requestId: 'req_custom_providers' })
      window.bridge.send({ type: 'get_config', requestId: 'req_config' })
      get().resyncModelCapability()
      window.bridge.send({ type: 'get_tools', requestId: 'req_tools' })
    }
  },

  fetchTools: () => {
    set({ isLoadingTools: true })
    if (window.bridge?.send) {
      window.bridge.send({
        type: 'get_tools',
        requestId: `req_tools_${Date.now()}`,
      })
    }
  },

  runDiagnostics: () => {
    return new Promise((resolve) => {
      set({ isDiagnosing: true })
      if (!window.bridge?.send) {
        set({ isDiagnosing: false })
        resolve(null)
        return
      }
      const startTime = Date.now()
      const reqId = `req_diag_${startTime}`
      pendingCallbacks.set(reqId, (res) => {
        set({ isDiagnosing: false })
        if (res.ok && res.data) {
          const latency = Math.max(1, Date.now() - startTime)
          const diag: DiagnosticsInfo = { ...res.data, latencyMs: latency }
          set({ diagnostics: diag })
          resolve(diag)
        } else {
          resolve(null)
        }
      })
      window.bridge.send({
        type: 'get_diagnostics',
        requestId: reqId,
      })
    })
  },

  checkUpdate: () => {
    return new Promise((resolve) => {
      set({ isCheckingUpdate: true })
      if (!window.bridge?.send) {
        set({ isCheckingUpdate: false })
        resolve(null)
        return
      }
      const reqId = `req_check_update_${Date.now()}`
      pendingCallbacks.set(reqId, (res) => {
        set({ isCheckingUpdate: false })
        if (res.ok && res.data) {
          set({ updateStatus: res.data })
          resolve(res.data)
        } else {
          resolve(null)
        }
      })
      window.bridge.send({
        type: 'check_update',
        requestId: reqId,
      })
    })
  },

  setWorkspaceCwd: async (path: string) => {
    const data = await sendSettingsCommand('set_cwd', { path })
    const resolvedPath = typeof data?.cwd === 'string' && data.cwd ? data.cwd : null
    if (!resolvedPath) throw new Error('后端未返回已切换的工作目录')
    set((state) => ({
      configPaths: state.configPaths ? { ...state.configPaths, cwd: resolvedPath } : null,
    }))
    useSessionStore.getState().syncWorkspaceCwd(resolvedPath)
    return resolvedPath
  },

  setFontSize: (size: FontSizeOption) => {
    set({ fontSize: size })
    applyFontSize(size)
  },

  setHideThinkingBlock: (hide: boolean) => {
    set({ hideThinkingBlock: hide })
    try {
      localStorage.setItem('misaka_hide_thinking', String(hide))
    } catch {}
    if (window.bridge?.send) {
      window.bridge.send({
        type: 'set_setting',
        requestId: `req_set_hide_thinking_${Date.now()}`,
        section: 'ui',
        key: 'hideThinkingBlock',
        value: hide,
      })
    }
  },

  setAutoCompaction: (enabled: boolean) => {
    set({ autoCompaction: enabled })
    if (window.bridge?.send) {
      window.bridge.send({
        type: 'set_setting',
        requestId: `req_set_compaction_${Date.now()}`,
        section: 'compaction',
        key: 'enabled',
        value: enabled,
      })
    }
  },

  setDefaultThinkingLevel: (level: string) => {
    if (window.bridge?.send) {
      window.bridge.send({
        type: 'set_default_thinking_level',
        requestId: `req_sdtl_${Date.now()}`,
        level,
      })
      set((state) => ({
        configPaths: state.configPaths ? { ...state.configPaths, defaultThinkingLevel: level } : null,
      }))
    }
  },

    setCloseWindowAction: (action: CloseWindowAction) => {
    set({ closeWindowAction: action })
    try {
      localStorage.setItem('misaka_close_window_action', action)
    } catch {}
  },

  setRequireShellConfirm: (required: boolean) => {
    set({ requireShellConfirm: required })
    try {
      localStorage.setItem('misaka_shell_confirm', String(required))
    } catch {}
    if (window.bridge?.send) {
      window.bridge.send({
        type: 'set_setting',
        requestId: `req_set_shell_confirm_${Date.now()}`,
        section: 'security',
        key: 'requireShellConfirm',
        value: required,
      })
    }
  },

  resetResearchSettings: async () => {
    const defaults = [
      ['research', 'plan_approval', true],
      ['research', 'token_cap', 0],
      ['subagents', 'coordinator_mode', true],
      ['subagents', 'verification_agent', true],
      ['subagents', 'auto_memory', true],
      ['network', 'max_concurrent_sisters', 4],
    ] as const
    let saved = 0
    try {
      for (const [section, key, value] of defaults) {
        await get().saveProductSetting(section, key, value)
        saved += 1
      }
    } catch (error) {
      if (saved > 0) {
        try {
          const data = await sendSettingsCommand('get_config', { requestId: newRequestId('config_reload') })
          const product = data?.product ?? data?.config?.product
          if (product && typeof product === 'object') set({ productSettings: product })
        } catch {
          // Keep the per-setting acknowledgements as the best confirmed state available.
        }
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${saved ? `部分恢复（${saved}/6 项）` : '恢复失败'}：${message}`)
    }
  },

  exportCurrentSession: async (sessionPath?: string) => {
    set({ lastExportedPath: null })
    try {
      const data = await sendSettingsCommand('export_session', { path: sessionPath })
      const writtenPath = typeof data?.path === 'string' && data.path ? data.path : null
      if (!writtenPath) throw new Error('导出回执未包含文件路径，结果未确认')
      set({ lastExportedPath: writtenPath })
      return { ok: true, path: writtenPath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  fetchCustomProviders: () => {
    if (window.bridge?.send) {
      window.bridge.send({
        type: 'get_custom_providers',
        requestId: `req_custom_${Date.now()}`,
      })
    }
  },

  fetchRemoteModels: (params) => {
    return new Promise((resolve) => {
      if (!window.bridge?.send) {
        resolve({ ok: false, error: 'Bridge 未连接' })
        return
      }
      const requestId = `req_fetch_models_${Date.now()}`
      pendingCallbacks.set(requestId, (res) => {
        if (res.ok && Array.isArray(res.data?.models)) {
          resolve({ ok: true, models: res.data.models })
        } else {
          resolve({ ok: false, error: res.error || '获取模型列表失败，请检查 Base URL 与 Key' })
        }
      })
      window.bridge.send({
        type: 'fetch_remote_models',
        requestId,
        baseUrl: params.baseUrl,
        api: params.api,
        apiKey: params.apiKey,
        providerId: params.providerId,
        headers: params.headers,
      })
    })
  },

  upsertCustomProvider: (draft) => {
    return new Promise((resolve) => {
      if (!window.bridge?.send) {
        resolve({ ok: false, error: 'Bridge 不可用' })
        return
      }
      const requestId = `req_upsert_${Date.now()}`
      pendingCallbacks.set(requestId, (res) => {
        resolve({ ok: res.ok, error: res.error })
      })
      window.bridge.send({
        type: 'upsert_custom_provider',
        requestId,
        providerId: draft.providerId,
        name: draft.name,
        baseUrl: draft.baseUrl,
        api: draft.api,
        apiKey: draft.apiKey,
        headers: draft.headers,
        models: draft.models,
      })
    })
  },

  deleteCustomProvider: (providerId) => {
    if (window.bridge?.send) {
      window.bridge.send({
        type: 'delete_custom_provider',
        requestId: `req_del_custom_${Date.now()}`,
        providerId,
      })
    }
  },

  reorderCustomProviders: (order) => {
    if (window.bridge?.send) {
      set((state) => ({
        customProviders: [...state.customProviders].sort(
          (a, b) => order.indexOf(a.providerId) - order.indexOf(b.providerId),
        ),
      }))
      window.bridge.send({
        type: 'reorder_custom_providers',
        requestId: `req_order_custom_${Date.now()}`,
        order,
      })
    }
  },

  testProviderConnectivity: (providerId, modelId) => {
    if (window.bridge?.send) {
      set((state) => ({ connectivity: { ...state.connectivity, [providerId]: 'testing' } }))
      window.bridge.send({
        type: 'test_provider_connectivity',
        requestId: `req_test_${providerId}_${Date.now()}`,
        providerId,
        modelId,
      })
    }
  },

  clearConnectivity: (providerId) => {
    set((state) => {
      const next = { ...state.connectivity }
      delete next[providerId]
      return { connectivity: next }
    })
  },

  setSessionModel: (provider: string, modelId: string, persist = false) => {
    const session = useSessionStore.getState()
    if (session.agentMode === 'research' && session.researchBinding) {
      get().switchResearchTeamModel(provider, modelId)
      return
    }
    if (!window.bridge?.send || !sessionReady()) return
    // A new session needs a coherent model + ladder before it can own a rollback snapshot.
    if (!confirmedCapability && (latestModelsReadId || latestThinkingReadId)) return
    beginSwitch(get())
    const reqId = switchReqId('sm')
    // A new model supersedes any level change still in flight: its ack describes the model
    // this switch is replacing, so letting it land would paint the old ladder back on.
    latestModelSwitchId = reqId
    latestThinkingSwitchId = null
    clearPickerError(set)
    const matched = get().models.find((m) => m.provider === provider && m.id === modelId)
    set({ modelSwitchPending: true })
    if (matched) {
      // Re-rank the ladder locally: the ack will take a few ms and the backend may land on a
      // different level entirely (a role or per-model default outranks whatever is live now),
      // but the slider needs the new stop count the moment the row is clicked.
      const levels = resolveSupportedLevels(matched)
      const next = clampThinkingLevel(levels, get().thinkingLevel)
      set({
        availableThinkingLevels: hasThinkingCapability(matched) ? levels : null,
        thinkingCapability: matched.thinkingCapability ?? null,
        supportsThinking: matched.supportsThinking ?? matched.reasoning ?? true,
        thinkingLevel: next,
        currentModel: { provider, modelId, name: matched.name, thinking: next },
      })
    }
    // persist only mirrors the local guess; the set_default_model command is what makes it
    // stick, so picking a session model must not rewrite the default here.
    if (persist && matched) {
      set({ defaultProvider: provider, defaultModel: modelId })
    }
    window.bridge.send({ type: 'set_model', requestId: reqId, provider, modelId, persist })
  },

  applyResearchModelBinding: (sessionId, binding) => {
    const session = useSessionStore.getState()
    if (session.agentMode !== 'research' || session.researchBinding?.sessionId !== sessionId) return
    const previous = get().researchModelSessionId === sessionId ? get().researchModelBinding : null
    if (previous && (binding.epoch < previous.epoch || (binding.epoch === previous.epoch && previous.state === 'ready' && binding.state === 'switching'))) return
    const localPending = awaitingResearchModelRequest?.sessionId === sessionId && binding.epoch <= awaitingResearchModelRequest.baseEpoch
      && get().modelSwitchPending && Boolean(get().researchModelTarget)
    window.clearTimeout(pickerErrorTimer)
    const matched = get().models.find(model => model.provider === binding.effective.provider && model.id === binding.effective.modelId)
    const levels = matched ? resolveSupportedLevels(matched) : null
    const thinking = levels ? clampThinkingLevel(levels, get().thinkingLevel) : 'off'
    set({ researchModelBinding: binding, researchModelSessionId: sessionId, researchModelTarget: localPending ? get().researchModelTarget : binding.target,
      modelSwitchPending: localPending || binding.state === 'switching', pickerError: localPending ? get().pickerError : binding.state === 'failed' ? binding.error || '团队模型切换失败' : null,
      currentModel: { ...binding.effective, name: matched?.name || binding.effective.modelId, thinking }, thinkingLevel: thinking,
      availableThinkingLevels: matched && hasThinkingCapability(matched) ? levels : null,
      thinkingCapability: matched?.thinkingCapability ?? null, supportsThinking: matched?.supportsThinking ?? matched?.reasoning ?? false })
  },

  switchResearchTeamModel: (provider, modelId, action = 'switch') => {
    const session = useSessionStore.getState()
    if (session.agentMode !== 'research' || !session.researchBinding) return
    const sessionId = session.researchBinding.sessionId
    const requestId = newRequestId('desktop_team_model')
    latestResearchModelRequest = requestId
    awaitingResearchModelRequest = { requestId, sessionId, baseEpoch: session.researchModelBinding?.epoch ?? get().researchModelBinding?.epoch ?? -1 }
    clearPickerError(set)
    set({ modelSwitchPending: true, researchModelTarget: action === 'cancel' ? get().researchModelTarget : { provider, modelId } })
    void requestResearch<ResearchTeamSnapshot & { snapshot?: ResearchTeamSnapshot }>('desktop_set_team_model', { sessionId, provider, modelId, action, requestId }, 180_000).then(result => {
      if (latestResearchModelRequest !== requestId || useSessionStore.getState().researchBinding?.sessionId !== sessionId) return
      if (awaitingResearchModelRequest?.requestId === requestId) awaitingResearchModelRequest = null
      const snapshot = result.snapshot ?? result
      useSessionStore.getState().applyResearchTeamSnapshot(sessionId, snapshot)
      if (snapshot.modelBinding) get().applyResearchModelBinding(sessionId, snapshot.modelBinding)
    }).catch(error => {
      if (latestResearchModelRequest !== requestId || useSessionStore.getState().researchBinding?.sessionId !== sessionId) return
      if (awaitingResearchModelRequest?.requestId === requestId) awaitingResearchModelRequest = null
      set({ modelSwitchPending: false, pickerError: error instanceof Error ? error.message : String(error) })
    })
  },

  retryResearchModelSwitch: () => {
    const target = get().researchModelTarget ?? get().researchModelBinding?.target
    if (target) get().switchResearchTeamModel(target.provider, target.modelId, 'retry')
  },

  cancelResearchModelSwitch: () => {
    const model = get().researchModelBinding?.effective ?? get().currentModel
    if (model) get().switchResearchTeamModel(model.provider, model.modelId, 'cancel')
  },

  clearPickerError: () => {
    if (useSessionStore.getState().agentMode === 'research' && useSessionStore.getState().researchBinding) return
    clearPickerError(set)
  },

  // A session swap changes which model is live, and nothing else re-reads that: the
  // initial fetch only ever runs once, so without this the pickers keep showing the
  // previous conversation's model and ladder. Unique read IDs prevent delayed old-session
  // responses from repainting the new context.
  resyncModelCapability: () => {
    if (!window.bridge?.send) return
    const research = useSessionStore.getState()
    const boundResearch = research.agentMode === 'research' && research.researchBinding && research.researchModelBinding
    // The session changed, so whatever switch was in flight belongs to a different agent.
    latestModelSwitchId = null
    latestThinkingSwitchId = null
    if (!sessionReady()) {
      latestModelsReadId = null
      latestThinkingReadId = null
      set({ modelSwitchPending: true })
      if (boundResearch) get().applyResearchModelBinding(research.researchBinding!.sessionId, research.researchModelBinding!)
      return
    }
    requestSessionId = useSessionStore.getState().currentSessionId
    const changedSession = confirmedSessionId !== requestSessionId
    if (changedSession) confirmedCapability = null
    latestModelsReadId = `req_models_${++switchSeq}`
    latestThinkingReadId = `req_thinking_${++switchSeq}`
    set({ modelSwitchPending: true, ...(changedSession && !boundResearch ? { currentModel: null, thinkingLevel: 'off', availableThinkingLevels: null, supportsThinking: false, thinkingCapability: null } : {}) })
    window.bridge.send({ type: 'get_models', requestId: latestModelsReadId })
    window.bridge.send({ type: 'get_thinking_levels', requestId: latestThinkingReadId })
    if (research.agentMode === 'research' && research.researchBinding && research.researchModelBinding) {
      get().applyResearchModelBinding(research.researchBinding.sessionId, research.researchModelBinding)
    }
  },

  setDefaultModel: (provider: string, modelId: string) => {
    if (window.bridge?.send) {
      window.bridge.send({
        type: 'set_default_model',
        requestId: `req_sdm_${Date.now()}`,
        provider,
        modelId,
      })
      set({ defaultProvider: provider, defaultModel: modelId })
    }
  },

  setThinkingLevel: (level: string) => {
    const session = useSessionStore.getState()
    if (session.agentMode === 'research' && session.researchBinding) return
    if (!window.bridge?.send) return
    if (get().modelSwitchPending || !sessionReady()) return
    beginSwitch(get())
    const reqId = switchReqId('st')
    latestThinkingSwitchId = reqId
    clearPickerError(set)
    set((state) => ({
      thinkingLevel: level,
      currentModel: state.currentModel ? { ...state.currentModel, thinking: level } : null,
    }))
    window.bridge.send({ type: 'set_thinking', requestId: reqId, level })
  },

  setProviderCredential: (provider: string, apiKey: string) => {
    if (!apiKey.trim()) return
    if (window.bridge?.send) {
      window.bridge.send({
        type: 'set_provider_credential',
        requestId: `req_spc_${Date.now()}`,
        provider,
        apiKey: apiKey.trim(),
      })
      set((state) => ({
        providers: state.providers.map((p) =>
          p.id === provider ? { ...p, configured: true, source: 'stored' } : p,
        ),
      }))
      setTimeout(() => {
        get().fetchInitialData()
      }, 300)
    }
  },

  deleteProviderCredential: (provider: string) => {
    if (window.bridge?.send) {
      window.bridge.send({
        type: 'delete_provider_credential',
        requestId: `req_dpc_${Date.now()}`,
        provider,
      })
      set((state) => ({
        providers: state.providers.map((p) =>
          p.id === provider ? { ...p, configured: false, source: '' } : p,
        ),
      }))
      setTimeout(() => {
        get().fetchInitialData()
      }, 300)
    }
  },

  refreshModels: () => {
    set({ isLoading: true })
    if (window.bridge?.send) {
      window.bridge.send({
        type: 'refresh_models',
        requestId: `req_refresh_${Date.now()}`,
      })
      setTimeout(() => {
        get().fetchInitialData()
      }, 500)
    }
  },

  saveProductSetting: async (section: string, key: string, value: any) => {
    await sendSettingsCommand('set_setting', { section, key, value })
    set((state) => {
      const prod = { ...state.productSettings }
      prod[section] = { ...prod[section], [key]: value }
      return { productSettings: prod }
    })
  },

  setThemeName: (theme: string) => {
    const request = ++latestThemeRequest
    // The renderer never paints the theme: useTheme's theme:change subscription is the only
    // writer. Here we request, mirror the outcome, and echo the choice to the Python side.
    if (!window.theme?.setTheme) {
      set({ themeError: '桌面主题通道不可用（Electron preload 未加载？）' })
      return
    }

    window.theme
      .setTheme(theme)
      .then((result) => {
        // A successful builtin remains the terminal's last builtin even if a newer
        // desktop-only choice fails. Do not let late older acknowledgements undo it.
        if (result?.ok && (result.name === 'dark' || result.name === 'light') && request > latestMirroredBuiltinRequest) {
          latestMirroredBuiltinRequest = request
          window.bridge?.send?.({ type: 'set_theme', requestId: `req_theme_${Date.now()}`, name: result.name })
        }
        if (request !== latestThemeRequest) return
        if (!result?.ok) {
          set({ themeError: result?.error || '切换主题失败' })
          return
        }
        set({ themeError: null, themeName: result.name })
      })
      .catch((error: unknown) => {
        if (request !== latestThemeRequest) return
        console.error('theme:set failed', error)
        set({ themeError: '切换主题失败（主进程无响应）' })
      })
  },

  pickDirectory: async () => {
    if (!window.app?.pickDirectory) throw new Error('目录选择器不可用')
    const chosen = await window.app.pickDirectory()
    if (!chosen) return null
    return await get().setWorkspaceCwd(chosen)
  },

  handleBridgeMessage: (msg: BridgeMessage) => {
    // Compatibility feedback belongs to the response's model and session, not to a
    // later model switch. It changes capability, never the user's global defaults.
    if ('event' in msg && msg.event && msg.event.type === 'message_end') {
      const event = msg.event as { message?: { provider?: string; model?: string; diagnostics?: Array<{ type?: string; details?: Record<string, unknown> }> } }
      const message = event.message
      const current = get().currentModel
      const activeSession = useSessionStore.getState().currentSessionId
      if (message && current && !get().modelSwitchPending && message.provider === current.provider && message.model === current.modelId
        && (!msg.sessionId || msg.sessionId === activeSession)) {
        const feedback = message.diagnostics?.find(item => item.type === 'thinking_compatibility')?.details
        const capability = normalizeThinkingCapability(feedback?.thinkingCapability)
        if (capability) {
          const resolved = isThinkingLevelId(String(feedback?.resolvedLevel)) ? String(feedback!.resolvedLevel) : get().thinkingLevel
          set({ thinkingCapability: capability, availableThinkingLevels: capability.levels,
            supportsThinking: capability.status !== 'default', thinkingLevel: resolved,
            currentModel: { ...current, thinking: resolved },
            models: get().models.map(model => model.provider === current.provider && model.id === current.modelId
              ? { ...model, thinkingCapability: capability, thinkingLevels: capability.levels } : model) })
          rememberConfirmed(get())
        }
      }
    }
    if ('type' in msg && msg.type === 'ack' && msg.requestId) {
      const cb = pendingCallbacks.get(msg.requestId)
      if (cb) {
        pendingCallbacks.delete(msg.requestId)
        cb({ ok: msg.ok !== false, data: msg.data || msg, error: msg.error })
      }
      const data = msg.data || msg
      if (msg.requestId === 'req_providers' && Array.isArray(data.providers || data)) {
        set({
          providers: data.providers || data,
          isLoading: false,
        })
      } else if (msg.requestId === 'req_provider_groups') {
        if (msg.ok === false) {
          set({ isLoading: false })
          return
        }
        set({
          providerGroups: data.groups || [],
          visibleProviderIds: data.visibleProviderIds || [],
          isLoading: false,
        })
      } else if (
        msg.requestId.startsWith('req_custom_') ||
        msg.requestId.startsWith('req_upsert_') ||
        msg.requestId.startsWith('req_del_custom_') ||
        msg.requestId.startsWith('req_order_custom_')
      ) {
        set({
          customProviders: data.providers || [],
          customProvidersPath: data.path || '',
          customProvidersError: data.error || (msg.ok === false ? msg.error || '操作失败' : null),
        })
        if (
          msg.requestId.startsWith('req_upsert_') ||
          msg.requestId.startsWith('req_del_custom_')
        ) {
          get().fetchInitialData()
        }
      } else if (msg.requestId.startsWith('req_test_')) {
        const providerId = msg.requestId.slice('req_test_'.length).replace(/_\d+$/, '')
        const result: ConnectivityResult = {
          ok: msg.ok !== false && (data.ok !== false),
          error: msg.error || data.error,
          latencyMs: data.latencyMs,
          responseText: data.responseText,
          modelId: data.modelId,
        }
        set((state) => ({ connectivity: { ...state.connectivity, [providerId]: result } }))
      } else if (msg.requestId.startsWith('req_models_') || msg.requestId === 'req_models') {
        if (msg.requestId !== latestModelsReadId || !contextIsCurrent(true)) return
        latestModelsReadId = null
        if (msg.ok === false) {
          set({ modelSwitchPending: Boolean(latestThinkingReadId) })
          reportSwitchError(set, '模型状态读取失败，请重试')
          return
        }
        const rawList = data.models || []
        const modelsList = [...rawList].sort((a, b) =>
          (a.name || a.id).localeCompare(b.name || b.id, 'en', { sensitivity: 'base' })
        )
        const cur = data.currentModel
        const defP = data.defaultProvider
        const defM = data.defaultModel
        const research = useSessionStore.getState()
        if (research.agentMode === 'research' && research.researchBinding && research.researchModelBinding) {
          set({ models: modelsList, defaultProvider: defP, defaultModel: defM, isLoading: false })
          get().applyResearchModelBinding(research.researchBinding.sessionId, research.researchModelBinding)
          return
        }
        set({
          models: modelsList,
          currentModel: cur || get().currentModel,
          defaultProvider: defP,
          defaultModel: defM,
          // `currentModel.thinking` is what the session actually holds, so a resync after
          // a session switch also corrects the level -- the ladder alone would not.
          ...(cur && isThinkingLevelId(String(cur.thinking))
            ? { thinkingLevel: cur.thinking }
            : null),
          ...(cur && latestThinkingReadId
            ? {
                supportsThinking: Boolean(
                  modelsList.find((m) => m.provider === cur.provider && m.id === cur.modelId)
                    ?.reasoning,
                ),
              }
            : null),
          isLoading: false,
          modelSwitchPending: Boolean(latestThinkingReadId),
        })
        if (!latestThinkingReadId) rememberConfirmed(get())
      } else if ((msg.requestId === 'req_config' || msg.requestId.startsWith('req_config_reload_')) && (data.config || data.product)) {
        const cfg = data.config || data
        const comp = cfg.product?.compaction
        const autoComp = comp && typeof comp.enabled === 'boolean' ? comp.enabled : true
        set({
          configPaths: cfg,
          defaultProvider: cfg.defaultProvider || get().defaultProvider,
          defaultModel: cfg.defaultModel || get().defaultModel,
          productSettings: cfg.product || get().productSettings,
          autoCompaction: autoComp,
          isLoading: false,
        })
      } else if (msg.requestId.startsWith('req_sm_') || msg.requestId.startsWith('req_st_')) {
        const kind = msg.requestId.startsWith('req_sm_') ? 'model' : 'thinking'
        if (!ackIsCurrent(kind, msg.requestId)) {
          // Superseded: drop it outright, including its pending flag, which belongs to the
          // switch that is still outstanding.
          return
        }
        finishSwitch(set, kind, msg.requestId)
        if (msg.ok === false) {
          // Roll back immediately, then reconcile with the engine in case an older queued
          // operation changed it before this failure.
          if (confirmedCapability && confirmedSessionId === requestSessionId) set(confirmedCapability)
          reportSwitchError(set, '切换失败，已恢复已确认选择')
          get().resyncModelCapability()
          return
        }
        // The bridge clamps the level against what the model really supports and, on a model
        // switch, may resolve one of its own from the role / per-model default tables. Both
        // beat the optimistic write above, which can only guess.
        const levels = normalizeLevels(data.levels)
        const patch: Partial<SettingsState> = {}
        if (Array.isArray(data.levels)) patch.availableThinkingLevels = levels
        patch.thinkingCapability = normalizeThinkingCapability(data.thinkingCapability)
        if (typeof data.supportsThinking === 'boolean') patch.supportsThinking = data.supportsThinking
        if (typeof data.level === 'string' && isThinkingLevelId(data.level)) {
          patch.thinkingLevel = data.level
        }
        const cur = data.currentModel
        if (cur && typeof cur.provider === 'string' && typeof cur.modelId === 'string') {
          patch.currentModel = cur
        } else if (patch.thinkingLevel && get().currentModel) {
          patch.currentModel = { ...get().currentModel!, thinking: patch.thinkingLevel }
        }
        if (Object.keys(patch).length) set(patch)
        rememberConfirmed(get())
      } else if (msg.requestId.startsWith('req_thinking_') || msg.requestId === 'req_thinking') {
        if (msg.requestId !== latestThinkingReadId || !contextIsCurrent(true)) return
        latestThinkingReadId = null
        const research = useSessionStore.getState()
        if (research.agentMode === 'research' && research.researchBinding && research.researchModelBinding) {
          get().applyResearchModelBinding(research.researchBinding.sessionId, research.researchModelBinding)
          return
        }
        if (msg.ok === false) {
          set({ modelSwitchPending: Boolean(latestModelsReadId) })
          reportSwitchError(set, '思考深度读取失败，请重试')
          return
        }
        // A resync is the freshest truth there is, so it also settles any switch the previous
        // session left hanging.
        latestModelSwitchId = null
        latestThinkingSwitchId = null
        const levels = normalizeLevels(data.levels)
        set({
          availableThinkingLevels: Array.isArray(data.levels) ? levels : null,
          thinkingCapability: normalizeThinkingCapability(data.thinkingCapability),
          supportsThinking: typeof data.supportsThinking === 'boolean' ? data.supportsThinking : get().supportsThinking,
          thinkingLevel: isThinkingLevelId(data.level) ? data.level : get().thinkingLevel,
          modelSwitchPending: Boolean(latestModelsReadId),
          currentModel: get().currentModel && isThinkingLevelId(data.level)
            ? { ...get().currentModel!, thinking: data.level } : get().currentModel,
        })
        if (!latestModelsReadId) rememberConfirmed(get())
      } else if (msg.requestId === 'req_tools' || msg.requestId.startsWith('req_tools_')) {
        set({
          tools: Array.isArray(data.tools) ? data.tools : [],
          slashCommands: Array.isArray(data.slashCommands) ? data.slashCommands : [],
          isLoadingTools: false,
        })
      } else if (msg.requestId.startsWith('req_diag_')) {
        set({
          diagnostics: data || null,
          isDiagnosing: false,
        })
      } else if (msg.requestId.startsWith('req_check_update_')) {
        set({
          updateStatus: data || null,
          isCheckingUpdate: false,
        })
      }
    }
  },
}))

// themeName mirrors whichever theme the main process actually applied, so the settings
// panel can never claim a theme that differs from the colors on screen.
window.addEventListener('misaka-theme-applied', (event) => {
  const name = (event as CustomEvent<ThemeData>).detail?.name
  if (name) useSettingsStore.setState({ themeName: name })
})
