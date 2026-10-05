import { create } from 'zustand'
import type {
  SettingsSectionId,
  ModelProviderInfo,
  ModelDetail,
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
} from '../types/settings'
import type { BridgeMessage, ThemeData } from '../types/global'

const pendingCallbacks = new Map<string, (res: { ok: boolean; data?: any; error?: string }) => void>()

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
    if (applied === 'dark' || applied === 'light') return applied
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
  availableThinkingLevels: string[]
  supportsThinking: boolean
  configPaths: ConfigPaths | null
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
  setWorkspaceCwd: (path: string) => Promise<boolean>
  setSessionModel: (provider: string, modelId: string, persist?: boolean) => void
  setDefaultModel: (provider: string, modelId: string) => void
  setThinkingLevel: (level: string) => void
  setDefaultThinkingLevel: (level: string) => void
  setHideThinkingBlock: (hide: boolean) => void
  setAutoCompaction: (enabled: boolean) => void
  setFontSize: (size: FontSizeOption) => void
  setRequireShellConfirm: (required: boolean) => void
  resetResearchSettings: () => void
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
  saveProductSetting: (section: string, key: string, value: any) => void
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
  availableThinkingLevels: ['off', 'low', 'medium', 'high'],
  supportsThinking: false,
  configPaths: null,
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
  lastExportedPath: null,

  setActiveSection: (sec: SettingsSectionId) => set({ activeSection: sec }),
  setSearchQuery: (q: string) => set({ searchQuery: q }),

  fetchInitialData: () => {
    set({ isLoading: true })
    if (window.bridge?.send) {
      window.bridge.send({ type: 'get_providers', requestId: 'req_providers' })
      window.bridge.send({ type: 'get_provider_groups', requestId: 'req_provider_groups' })
      window.bridge.send({ type: 'get_custom_providers', requestId: 'req_custom_providers' })
      window.bridge.send({ type: 'get_models', requestId: 'req_models' })
      window.bridge.send({ type: 'get_config', requestId: 'req_config' })
      window.bridge.send({ type: 'get_thinking_levels', requestId: 'req_thinking' })
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

  setWorkspaceCwd: (path: string) => {
    return new Promise((resolve) => {
      if (!window.bridge?.send) {
        resolve(false)
        return
      }
      const reqId = `req_scwd_${Date.now()}`
      pendingCallbacks.set(reqId, (res) => {
        if (res.ok) {
          set((state) => ({
            configPaths: state.configPaths ? { ...state.configPaths, cwd: path } : null,
          }))
          resolve(true)
        } else {
          resolve(false)
        }
      })
      window.bridge.send({
        type: 'set_cwd',
        requestId: reqId,
        path,
      })
    })
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

  resetResearchSettings: () => {
    const defaults = {
      research: { token_cap: 0, plan_approval: true },
      subagents: {
        coordinator_mode: true,
        verification_agent: true,
        auto_memory: true,
        max_concurrent: 4,
      },
      network: { max_concurrent_sisters: 4 },
    }
    set({ productSettings: defaults })
    if (window.bridge?.send) {
      window.bridge.send({ type: 'set_setting', section: 'research', key: 'plan_approval', value: true })
      window.bridge.send({ type: 'set_setting', section: 'research', key: 'token_cap', value: 0 })
      window.bridge.send({ type: 'set_setting', section: 'subagents', key: 'coordinator_mode', value: true })
      window.bridge.send({ type: 'set_setting', section: 'subagents', key: 'verification_agent', value: true })
      window.bridge.send({ type: 'set_setting', section: 'subagents', key: 'auto_memory', value: true })
      window.bridge.send({ type: 'set_setting', section: 'network', key: 'max_concurrent_sisters', value: 4 })
    }
  },

  exportCurrentSession: (sessionPath?: string) => {
    return new Promise((resolve) => {
      if (!window.bridge?.send) {
        resolve({ ok: false, error: 'Bridge 未连接' })
        return
      }
      const reqId = `req_export_${Date.now()}`
      pendingCallbacks.set(reqId, (res) => {
        if (res.ok) {
          const writtenPath = res.data?.path
          set({ lastExportedPath: writtenPath || null })
          resolve({ ok: true, path: writtenPath })
        } else {
          resolve({ ok: false, error: res.error || '导出失败' })
        }
      })
      window.bridge.send({
        type: 'export_session',
        requestId: reqId,
        path: sessionPath,
      })
    })
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
    if (window.bridge?.send) {
      window.bridge.send({
        type: 'set_model',
        requestId: `req_sm_${Date.now()}`,
        provider,
        modelId,
        persist,
      })
      const matched = get().models.find((m) => m.provider === provider && m.id === modelId)
      if (matched) {
        set({
          currentModel: {
            provider,
            modelId,
            name: matched.name,
            thinking: get().thinkingLevel,
          },
        })
      }
      if (persist) {
        set({ defaultProvider: provider, defaultModel: modelId })
      }
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
    if (window.bridge?.send) {
      window.bridge.send({
        type: 'set_thinking',
        requestId: `req_st_${Date.now()}`,
        level,
      })
      set((state) => ({
        thinkingLevel: level,
        currentModel: state.currentModel ? { ...state.currentModel, thinking: level } : null,
      }))
    }
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

  saveProductSetting: (section: string, key: string, value: any) => {
    if (window.bridge?.send) {
      window.bridge.send({
        type: 'set_setting',
        requestId: `req_set_${Date.now()}`,
        section,
        key,
        value,
      })
      set((state) => {
        const prod = { ...state.productSettings }
        prod[section] = { ...prod[section], [key]: value }
        return { productSettings: prod }
      })
    }
  },

  setThemeName: (theme: string) => {
    // The renderer never paints the theme: useTheme's theme:change subscription is the only
    // writer. Here we request, mirror the outcome, and echo the choice to the Python side.
    if (!window.theme?.setTheme) {
      set({ themeError: '桌面主题通道不可用（Electron preload 未加载？）' })
      return
    }

    window.theme
      .setTheme(theme)
      .then((result) => {
        if (!result?.ok) {
          set({ themeError: result?.error || '切换主题失败' })
          return
        }
        set({ themeError: null })
        // Only once main accepted, so a rejected name can never reach settings.json and the TUI.
        window.bridge?.send?.({
          type: 'set_theme',
          requestId: `req_theme_${Date.now()}`,
          name: result.name,
        })
      })
      .catch((error: unknown) => {
        console.error('theme:set failed', error)
        set({ themeError: '切换主题失败（主进程无响应）' })
      })
  },

  pickDirectory: async () => {
    if (window.app?.pickDirectory) {
      const chosen = await window.app.pickDirectory()
      if (chosen) {
        await get().setWorkspaceCwd(chosen)
        return chosen
      }
    }
    return null
  },

  handleBridgeMessage: (msg: BridgeMessage) => {
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
      } else if (msg.requestId === 'req_models') {
        const rawList = data.models || []
        const modelsList = [...rawList].sort((a, b) =>
          (a.name || a.id).localeCompare(b.name || b.id, 'en', { sensitivity: 'base' })
        )
        const cur = data.currentModel
        const defP = data.defaultProvider
        const defM = data.defaultModel
        set({
          models: modelsList,
          currentModel: cur || get().currentModel,
          defaultProvider: defP,
          defaultModel: defM,
          isLoading: false,
        })
      } else if (msg.requestId === 'req_config' && data.config) {
        const cfg = data.config
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
      } else if (msg.requestId === 'req_thinking') {
        set({
          availableThinkingLevels: data.levels || get().availableThinkingLevels,
          supportsThinking: Boolean(data.supportsThinking),
          thinkingLevel: data.current || get().thinkingLevel,
        })
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
