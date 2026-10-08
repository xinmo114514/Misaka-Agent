import React, { useEffect, useMemo, useState } from "react"
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  Edit3,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  PlugZap,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Star,
  Trash2,
} from "lucide-react"
import { useSettingsStore } from "../../../store/useSettingsStore"
import type {
  ConnectivityResult,
  CustomModelDraft,
  CustomProviderDraft,
  ProviderConnection,
  ProviderGroup,
} from "../../../types/settings"
import { CUSTOM_API_FORMATS } from "../../../types/settings"
import { BrandLogo } from "../BrandLogo"

/** A brand rail entry: either a shipped brand group or one custom provider. */
type RailEntry =
  | { key: string; kind: "brand"; group: ProviderGroup }
  | { key: string; kind: "custom"; draft: CustomProviderDraft }

const STATUS_DOT: Record<"ready" | "partial" | "idle", string> = {
  ready: "bg-success",
  partial: "bg-warning",
  idle: "bg-dim/50",
}

const KIND_LABEL: Record<ProviderConnection["kind"], string> = {
  "api-key": "API Key 直连",
  oauth: "订阅登录",
  compat: "兼容入口",
}

const emptyDraft = (): CustomProviderDraft & { apiKey: string } => ({
  providerId: "",
  name: "",
  baseUrl: "",
  api: "openai-completions",
  apiKey: "",
  hasApiKey: false,
  headers: {},
  models: [{ id: "", name: "", contextWindow: 128000, maxTokens: 16384 }],
})

export const ModelProviderSection: React.FC = () => {
  const providerGroups = useSettingsStore((s) => s.providerGroups)
  const customProviders = useSettingsStore((s) => s.customProviders)
  const customProvidersPath = useSettingsStore((s) => s.customProvidersPath)
  const customProvidersError = useSettingsStore((s) => s.customProvidersError)
  const models = useSettingsStore((s) => s.models)
  const currentModel = useSettingsStore((s) => s.currentModel)
  const defaultProvider = useSettingsStore((s) => s.defaultProvider)
  const defaultModel = useSettingsStore((s) => s.defaultModel)
  const isLoading = useSettingsStore((s) => s.isLoading)
  const connectivity = useSettingsStore((s) => s.connectivity)
  const refreshModels = useSettingsStore((s) => s.refreshModels)
  const setSessionModel = useSettingsStore((s) => s.setSessionModel)
  const setDefaultModel = useSettingsStore((s) => s.setDefaultModel)
  const setProviderCredential = useSettingsStore((s) => s.setProviderCredential)
  const deleteProviderCredential = useSettingsStore((s) => s.deleteProviderCredential)
  const upsertCustomProvider = useSettingsStore((s) => s.upsertCustomProvider)
  const fetchRemoteModels = useSettingsStore((s) => s.fetchRemoteModels)
  const deleteCustomProvider = useSettingsStore((s) => s.deleteCustomProvider)
  const reorderCustomProviders = useSettingsStore((s) => s.reorderCustomProviders)
  const testProviderConnectivity = useSettingsStore((s) => s.testProviderConnectivity)
  const clearConnectivity = useSettingsStore((s) => s.clearConnectivity)

  const [selectedKey, setSelectedKey] = useState<string>("brand:openai")
  const [connectionIndex, setConnectionIndex] = useState(0)
  const [railQuery, setRailQuery] = useState("")
  const [keyInput, setKeyInput] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [modelSearch, setModelSearch] = useState("")
  const [editingCustom, setEditingCustom] = useState<(CustomProviderDraft & { apiKey: string }) | null>(null)
  const [isEditingCustom, setIsEditingCustom] = useState(false)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [customFetchLoading, setCustomFetchLoading] = useState(false)
  const [customFetchNotice, setCustomFetchNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const railEntries = useMemo<RailEntry[]>(() => {
    const brands: RailEntry[] = providerGroups.map((group) => ({
      key: `brand:${group.brandId}`,
      kind: "brand",
      group,
    }))
    const customs: RailEntry[] = customProviders.map((draft) => ({
      key: `custom:${draft.providerId}`,
      kind: "custom",
      draft,
    }))
    const all = [...brands, ...customs]
    if (!railQuery.trim()) return all
    const q = railQuery.toLowerCase()
    return all.filter((entry) =>
      entry.kind === "brand"
        ? entry.group.displayName.toLowerCase().includes(q) ||
          entry.group.brandId.toLowerCase().includes(q) ||
          entry.group.connections.some((c) => c.providerId.toLowerCase().includes(q))
        : entry.draft.providerId.toLowerCase().includes(q) || entry.draft.name.toLowerCase().includes(q),
    )
  }, [providerGroups, customProviders, railQuery])

  const selectedEntry = useMemo<RailEntry | null>(
    () => railEntries.find((entry) => entry.key === selectedKey) ?? railEntries[0] ?? null,
    [railEntries, selectedKey],
  )

  const isNewDraft = selectedKey === "custom:__new__"

  useEffect(() => {
    if (railEntries.length === 0) return
    if (isNewDraft) return
    if (pendingKey && !railEntries.some((entry) => entry.key === pendingKey)) return
    if (pendingKey) {
      setPendingKey(null)
      setSelectedKey(pendingKey)
      return
    }
    if (!railEntries.some((entry) => entry.key === selectedKey)) {
      setSelectedKey(railEntries[0].key)
    }
  }, [railEntries, selectedKey, isNewDraft, pendingKey])

  useEffect(() => {
    if (selectedKey === "custom:__new__") return
    setConnectionIndex(0)
    setKeyInput("")
    setShowKey(false)
    setEditingCustom(null)
    setIsEditingCustom(false)
    setCustomFetchNotice(null)
  }, [selectedKey])

  const selectedConnection: ProviderConnection | null = useMemo(() => {
    if (!selectedEntry || selectedEntry.kind !== "brand") return null
    return selectedEntry.group.connections[Math.min(connectionIndex, selectedEntry.group.connections.length - 1)] ?? null
  }, [selectedEntry, connectionIndex])

  // "模型只要我填了api就显示哪个供应商之下的模型"
  // "另外我补个排列方式按照英文大小顺序排"
  const visibleModelSet = useMemo(() => {
    if (!selectedEntry) return []
    const providerIds =
      selectedEntry.kind === "brand"
        ? new Set(selectedEntry.group.connections.map((c) => c.providerId))
        : new Set([selectedEntry.draft.providerId])
    const q = modelSearch.toLowerCase()
    return models
      .filter(
        (m) =>
          providerIds.has(m.provider) &&
          (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)),
      )
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, "en", { sensitivity: "base" }))
  }, [selectedEntry, models, modelSearch])

  const startCustomDraft = () => {
    setEditingCustom(emptyDraft())
    setIsEditingCustom(true)
    setSelectedKey("custom:__new__")
  }

  const moveCustom = (providerId: string, direction: -1 | 1) => {
    const ids = customProviders.map((provider) => provider.providerId)
    const index = ids.indexOf(providerId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= ids.length) return
    const next = [...ids]
    ;[next[index], next[target]] = [next[target], next[index]]
    reorderCustomProviders(next)
  }

  const draft: (CustomProviderDraft & { apiKey: string }) | null =
    editingCustom ?? (selectedEntry?.kind === "custom" ? { ...selectedEntry.draft, apiKey: "" } : null)

  const updateDraft = (patch: Partial<CustomProviderDraft & { apiKey: string }>) => {
    setEditingCustom((current) => ({ ...(current ?? draft ?? emptyDraft()), ...patch }))
  }

  const handleSyncRemoteModels = async (provider: CustomProviderDraft) => {
    setCustomFetchLoading(true)
    setCustomFetchNotice(null)
    try {
      const res = await fetchRemoteModels({
        baseUrl: provider.baseUrl,
        api: provider.api,
        providerId: provider.providerId,
      })
      if (res.ok && res.models && res.models.length > 0) {
        const updateRes = await upsertCustomProvider({
          ...provider,
          apiKey: "",
          models: res.models,
        })
        if (updateRes.ok) {
          setCustomFetchNotice({
            ok: true,
            text: `已拉取并同步 ${res.models.length} 个最新模型（按英文字母排序）`,
          })
          refreshModels()
        } else {
          setCustomFetchNotice({
            ok: false,
            text: `拉取成功但更新失败: ${updateRes.error || "未知错误"}`,
          })
        }
      } else {
        setCustomFetchNotice({
          ok: false,
          text: res.error || "未发现可用模型，请检查服务状态与 Base URL",
        })
      }
    } catch (e: any) {
      setCustomFetchNotice({
        ok: false,
        text: `拉取异常: ${e.message || e}`,
      })
    } finally {
      setCustomFetchLoading(false)
    }
  }

  const formatTokens = (count: number) => {
    if (!count) return "—"
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`
    if (count >= 1000) return `${Math.round(count / 1000)}K`
    return String(count)
  }

  const renderConnectivity = (providerId: string) => {
    const state = connectivity[providerId]
    if (state === "testing") {
      return (
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          <Loader2 className="w-3 h-3 animate-spin text-accent" />
          <span>探测中…</span>
        </span>
      )
    }
    if (!state) return null
    const result = state as ConnectivityResult
    return (
      <span
        className={`text-[11px] ${result.ok ? "text-success" : "text-danger"}`}
        title={result.error || result.responseText || ""}
      >
        {result.ok ? `连通正常 · ${result.latencyMs ?? 0}ms` : `失败：${result.error || "未知错误"}`}
      </span>
    )
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-[15px] font-semibold text-text-main">模型与供应商</h2>
          <p className="text-[12px] text-muted leading-relaxed max-w-xl">
            本机直连，凭据加密保存在本地 credentials 目录。页面聚焦核心主流品牌与自定义提供商，按需填入 API Key 即可启用对应模型。
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={refreshModels}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-text-main border border-border-subtle text-[12px] font-medium transition-colors cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin text-accent" : "text-dim"}`} />
            <span>刷新目录</span>
          </button>
          <button
            type="button"
            onClick={startCustomDraft}
            className="misaka-luminous flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent hover:opacity-90 text-on-accent text-[12px] font-medium transition-all cursor-pointer shadow-xs"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>添加自定义提供商</span>
          </button>
        </div>
      </div>

      {customProvidersError && (
        <div className="rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-[12px] text-danger">
          {customProvidersError}
        </div>
      )}

      <div className="misaka-glass-panel relative grid grid-cols-1 md:grid-cols-[224px_minmax(0,1fr)] border border-border-subtle rounded-xl overflow-hidden bg-card shadow-e1">
        {/* Rail */}
        <aside className="border-b md:border-b-0 md:border-r border-border-subtle/70 flex flex-col min-h-0">
          <div className="p-3 border-b border-border-subtle/70">
            <div className="relative flex items-center">
              <Search className="w-3.5 h-3.5 absolute left-2.5 text-dim pointer-events-none" />
              <input
                type="text"
                value={railQuery}
                onChange={(e) => setRailQuery(e.target.value)}
                placeholder="筛选品牌或提供商..."
                className="w-full bg-surface-2 text-text-main placeholder-dim pl-8 pr-2 py-1.5 rounded-lg border border-border-subtle outline-none focus:border-accent/80 focus:ring-1 focus:ring-focus-ring/30 text-[12px]"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-4">
            <div className="space-y-1">
              <div className="px-2 py-1 text-[10.5px] font-medium text-muted tracking-wider">预置品牌</div>
              {railEntries
                .filter((entry) => entry.kind === "brand")
                .map((entry) => {
                  if (entry.kind !== "brand") return null
                  const group = entry.group
                  const configured = group.connections.filter((c) => c.configured).length
                  const dot = group.configured
                    ? configured === group.connections.length
                      ? "ready"
                      : "partial"
                    : "idle"
                  const isActive = selectedKey === entry.key
                  const subtitle =
                    configured === 0
                      ? group.subtitle
                      : `${configured}/${group.connections.length} 已连接`
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      onClick={() => {
                        setSelectedKey(entry.key)
                        setIsEditingCustom(false)
                      }}
                      aria-current={isActive}
                      className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40 ${
                        isActive
                          ? "bg-surface-2 text-text-main border border-border-subtle shadow-xs"
                          : "border border-transparent text-muted hover:text-text-main hover:bg-surface-2/60"
                      }`}
                    >
                      <BrandLogo brandId={group.brandId} size={26} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[12.5px] font-medium">{group.displayName}</span>
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[dot as keyof typeof STATUS_DOT]}`} />
                        </span>
                        <span className="block truncate text-[10.5px] text-muted">{subtitle}</span>
                      </span>
                    </button>
                  )
                })}
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between px-2 py-1">
                <span className="text-[10.5px] font-medium text-muted tracking-wider">自定义提供商</span>
                <button
                  type="button"
                  onClick={startCustomDraft}
                  className="text-dim hover:text-accent transition-colors cursor-pointer"
                  title="新建自定义提供商"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
              {railEntries.filter((entry) => entry.kind === "custom").length === 0 && (
                <div className="px-2 py-1.5 text-[11px] text-muted leading-relaxed">
                  暂未添加。支持 OpenAI 协议与 Anthropic 协议接口。
                </div>
              )}
              {railEntries
                .filter((entry) => entry.kind === "custom")
                .map((entry) => {
                  if (entry.kind !== "custom") return null
                  const isActive = selectedKey === entry.key
                  const position = customProviders.findIndex(
                    (provider) => provider.providerId === entry.draft.providerId,
                  )
                  return (
                    <div
                      key={entry.key}
                      className={`group flex items-center gap-1 rounded-lg border pr-1 transition-colors ${
                        isActive
                          ? "bg-surface-2 border-border-subtle shadow-xs"
                          : "border-transparent hover:bg-surface-2/60"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedKey(entry.key)
                          setIsEditingCustom(false)
                        }}
                        aria-current={isActive}
                        className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40 rounded-lg"
                      >
                        <BrandLogo brandId="custom" size={26} />
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate text-[12.5px] font-medium ${isActive ? "text-text-main" : "text-muted group-hover:text-text-main"}`}>
                            {entry.draft.name || entry.draft.providerId}
                          </span>
                          <span className="block truncate text-[10.5px] text-muted font-mono">
                            {entry.draft.api}
                          </span>
                        </span>
                      </button>
                      <span className="flex flex-col opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        <button
                          type="button"
                          disabled={position <= 0}
                          onClick={() => moveCustom(entry.draft.providerId, -1)}
                          className="text-dim hover:text-text-main transition-colors cursor-pointer disabled:opacity-25 disabled:cursor-default"
                          title="上移"
                          aria-label={`上移 ${entry.draft.name || entry.draft.providerId}`}
                        >
                          <ChevronUp className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          disabled={position < 0 || position >= customProviders.length - 1}
                          onClick={() => moveCustom(entry.draft.providerId, 1)}
                          className="text-dim hover:text-text-main transition-colors cursor-pointer disabled:opacity-25 disabled:cursor-default"
                          title="下移"
                          aria-label={`下移 ${entry.draft.name || entry.draft.providerId}`}
                        >
                          <ChevronDown className="w-3 h-3" />
                        </button>
                      </span>
                    </div>
                  )
                })}
              {selectedKey === "custom:__new__" && (
                <div className="px-2 py-1.5 rounded-lg bg-accent/10 border border-accent/30 text-[12px] text-text-main font-medium">
                  + 新建提供商
                </div>
              )}
            </div>
          </div>
          <div className="px-3 py-2 border-t border-border-subtle/70 text-[10px] text-muted font-mono truncate" title={customProvidersPath}>
            {customProvidersPath || "~/.misaka/models.json"}
          </div>
        </aside>

        {/* Detail Panel */}
        <div className="min-w-0 p-4 sm:p-5 space-y-5">
          {!selectedEntry && (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <ShieldCheck className="w-6 h-6 text-dim" />
              <p className="text-[12.5px] text-muted">尚未选择任何提供商。请从左侧选择品牌，或添加自定义提供商。</p>
            </div>
          )}

          {/* Shipped Brand Detail View */}
          {!isNewDraft && selectedEntry?.kind === "brand" && selectedConnection && (
            <>
              <div className="flex items-start gap-3">
                <BrandLogo brandId={selectedEntry.group.brandId} size={40} />
                <div className="min-w-0 flex-1">
                  <h3 className="text-[14px] font-semibold text-text-main">{selectedEntry.group.displayName}</h3>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    {selectedEntry.group.connections.map((connection, index) => (
                      <button
                        key={`${connection.providerId}:${connection.kind}`}
                        type="button"
                        onClick={() => setConnectionIndex(index)}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11.5px] font-medium transition-colors cursor-pointer ${
                          index === connectionIndex
                            ? "bg-surface-2 border-border text-text-main"
                            : "border-border-subtle text-muted hover:text-text-main"
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${connection.configured ? "bg-success" : "bg-dim/50"}`} />
                        {connection.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11.5px] text-muted mt-1.5">
                    {KIND_LABEL[selectedConnection.kind]}
                    {selectedConnection.detail ? ` · ${selectedConnection.detail}` : ""}
                  </p>
                </div>
                <div className="shrink-0 flex flex-col items-end gap-1.5">
                  {selectedConnection.configured ? (
                    <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-success-surface text-success border border-success-border font-medium">
                      <CheckCircle2 className="w-3 h-3" />
                      <span>已就绪</span>
                    </span>
                  ) : (
                    <span className="text-[11px] px-2 py-0.5 rounded bg-surface-2 text-muted border border-border-subtle">
                      未配置
                    </span>
                  )}
                  {renderConnectivity(selectedConnection.providerId)}
                </div>
              </div>

              {/* Credential form */}
              <div className="misaka-glass-panel relative rounded-xl border border-border-subtle bg-card shadow-e1 p-4 space-y-3">
                {selectedConnection.kind === "oauth" ? (
                  <div className="space-y-2">
                    <div className="text-[12.5px] text-text-main font-medium">订阅登录认证</div>
                    <p className="text-[12px] text-muted leading-relaxed">
                      该连接支持通过终端交互完成授权。请在终端执行 <code className="font-mono text-text-main bg-surface-2 px-1.5 py-0.5 rounded border border-border-subtle">misaka setup model</code>，
                      选择对应提供商并完成登录，完成后回到此处点击「刷新目录」即可加载可用模型。
                    </p>
                    {selectedConnection.configured && selectedConnection.authLabel && (
                      <p className="text-[11.5px] text-muted font-mono">来源：{selectedConnection.authLabel}</p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[12.5px] text-text-main font-medium">API Key 凭据</span>
                      {selectedConnection.configured && (
                        <button
                          type="button"
                          onClick={() => deleteProviderCredential(selectedConnection.providerId)}
                          className="flex items-center gap-1 text-[11px] text-dim hover:text-danger transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                          <span>删除凭据</span>
                        </button>
                      )}
                    </div>
                    <div className="relative flex items-center">
                      <input
                        type={showKey ? "text" : "password"}
                        value={keyInput}
                        onChange={(e) => setKeyInput(e.target.value)}
                        placeholder={selectedConnection.configured ? "已配置，粘贴新 Key 可更新" : "粘贴 API Key 并保存以启用此供应商模型"}
                        className="w-full bg-surface-2 text-text-main placeholder-dim pl-2.5 pr-8 py-1.5 rounded-lg border border-border outline-none focus:border-accent focus:ring-1 focus:ring-focus-ring/30 text-[12px] font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey(!showKey)}
                        className="absolute right-2.5 text-dim hover:text-text-main cursor-pointer"
                        title={showKey ? "隐藏" : "显示"}
                      >
                        {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => testProviderConnectivity(selectedConnection.providerId)}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-2 hover:bg-surface-3 border border-border-subtle text-[11.5px] text-text-main transition-colors cursor-pointer"
                      >
                        <PlugZap className="w-3.5 h-3.5 text-dim" />
                        <span>连通性测试</span>
                      </button>
                      <button
                        type="button"
                        disabled={!keyInput.trim()}
                        onClick={() => {
                          setProviderCredential(selectedConnection.providerId, keyInput.trim())
                          setKeyInput("")
                          clearConnectivity(selectedConnection.providerId)
                        }}
                        className="misaka-luminous flex items-center gap-1.5 px-3 py-1 rounded-lg bg-accent hover:opacity-90 text-on-accent text-[11.5px] font-medium transition-all cursor-pointer shadow-xs disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Save className="w-3.5 h-3.5" />
                        <span>保存到本地</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Models Section: "模型只要我填了api就显示哪个供应商之下的模型" */}
              {!selectedConnection.configured ? (
                <div className="rounded-xl border border-dashed border-border-subtle bg-surface-1/40 p-8 flex flex-col items-center justify-center text-center space-y-2.5">
                  <div className="w-10 h-10 rounded-full bg-surface-2 flex items-center justify-center text-dim">
                    <KeyRound className="w-5 h-5 text-dim" />
                  </div>
                  <div className="space-y-1">
                    <div className="text-[13px] font-medium text-text-main">未配置 API 凭据</div>
                    <p className="text-[12px] text-muted max-w-sm leading-relaxed">
                      请在上方输入 API Key 或登录授权。保存凭据后，将自动展示并启用该供应商旗下的可用模型。
                    </p>
                  </div>
                </div>
              ) : (
                <ModelTable
                  models={visibleModelSet}
                  search={modelSearch}
                  onSearch={setModelSearch}
                  currentModel={currentModel}
                  defaultProvider={defaultProvider}
                  defaultModel={defaultModel}
                  formatTokens={formatTokens}
                  onUse={(provider, id) => setSessionModel(provider, id)}
                  onDefault={(provider, id) => setDefaultModel(provider, id)}
                  onTest={(provider, id) => testProviderConnectivity(provider, id)}
                  renderConnectivity={renderConnectivity}
                />
              )}
            </>
          )}

          {/* Existing Custom Provider: Normal View Mode */}
          {selectedEntry?.kind === "custom" && !isEditingCustom && draft && (
            <div className="space-y-5">
              {/* Custom Provider Header */}
              <div className="flex items-start gap-3">
                <BrandLogo brandId="custom" size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-[14px] font-semibold text-text-main">
                      {selectedEntry.draft.name || selectedEntry.draft.providerId}
                    </h3>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-accent/15 text-rose-lite border border-accent/30 font-mono">
                      自定义
                    </span>
                  </div>
                  <p className="text-[11.5px] text-muted mt-1 leading-relaxed font-mono">
                    {selectedEntry.draft.baseUrl} · {selectedEntry.draft.api}
                  </p>
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  {renderConnectivity(selectedEntry.draft.providerId)}
                  <button
                    type="button"
                    onClick={() => testProviderConnectivity(selectedEntry.draft.providerId)}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-2 hover:bg-surface-3 border border-border-subtle text-[11.5px] text-text-main transition-colors cursor-pointer"
                  >
                    <PlugZap className="w-3.5 h-3.5 text-dim" />
                    <span>连通测试</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsEditingCustom(true)}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-2 hover:bg-surface-3 border border-border-subtle text-[11.5px] text-text-main transition-colors cursor-pointer"
                  >
                    <Edit3 className="w-3.5 h-3.5 text-dim" />
                    <span>编辑配置</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      deleteCustomProvider(selectedEntry.draft.providerId)
                      setSelectedKey("brand:zhipu")
                    }}
                    className="p-1.5 rounded-lg text-dim hover:text-danger hover:bg-surface-2 transition-colors cursor-pointer"
                    title="删除此提供商"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Custom Provider Info & Remote Model Sync Card */}
              <div className="misaka-glass-panel relative rounded-xl border border-border-subtle bg-card shadow-e1 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-1">
                  <div className="text-[12.5px] font-medium text-text-main flex items-center gap-2">
                    <span>远程端点与模型管理</span>
                    <span className="text-[11px] text-muted">
                      ({selectedEntry.draft.models.length} 个模型已落盘)
                    </span>
                  </div>
                  <p className="text-[11.5px] text-muted">
                    支持一键从 Base URL 探测拉取远程服务端发布的模型列表，自动更新至本地 models.json。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleSyncRemoteModels(selectedEntry.draft)}
                  disabled={customFetchLoading}
                  className="misaka-luminous flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent hover:opacity-90 text-on-accent text-[11.5px] font-medium transition-all cursor-pointer shadow-xs disabled:opacity-50 shrink-0"
                >
                  {customFetchLoading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Download className="w-3.5 h-3.5" />
                  )}
                  <span>{customFetchLoading ? "拉取中…" : "获取模型列表"}</span>
                </button>
              </div>

              {customFetchNotice && (
                <div
                  className={`text-[11.5px] px-3 py-2 rounded-lg border ${
                    customFetchNotice.ok
                      ? "bg-success-surface text-success border-success-border"
                      : "bg-danger-surface text-danger border-danger-border"
                  }`}
                >
                  {customFetchNotice.text}
                </div>
              )}

              {/* Models Table for Custom Provider */}
              <ModelTable
                models={visibleModelSet}
                search={modelSearch}
                onSearch={setModelSearch}
                currentModel={currentModel}
                defaultProvider={defaultProvider}
                defaultModel={defaultModel}
                formatTokens={formatTokens}
                onUse={(provider, id) => setSessionModel(provider, id)}
                onDefault={(provider, id) => setDefaultModel(provider, id)}
                onTest={(provider, id) => testProviderConnectivity(provider, id)}
                renderConnectivity={renderConnectivity}
              />
            </div>
          )}

          {/* Custom Provider Edit Mode (Existing or New) */}
          {(isNewDraft || (selectedEntry?.kind === "custom" && isEditingCustom)) && draft && (
            <CustomProviderForm
              draft={draft}
              existing={!isNewDraft}
              apiFormats={CUSTOM_API_FORMATS}
              onChange={updateDraft}
              onFetchModels={fetchRemoteModels}
              onSave={async (cleanedDraft) => {
                const targetKey = `custom:${cleanedDraft.providerId.trim()}`
                const res = await upsertCustomProvider(cleanedDraft)
                if (res.ok) {
                  setEditingCustom(null)
                  setIsEditingCustom(false)
                  setPendingKey(targetKey)
                  setSelectedKey(targetKey)
                  refreshModels()
                }
                return res
              }}
              onDelete={
                !isNewDraft
                  ? () => {
                      deleteCustomProvider(draft.providerId)
                      setSelectedKey("brand:zhipu")
                    }
                  : null
              }
              onCancel={() => {
                setEditingCustom(null)
                setIsEditingCustom(false)
                if (isNewDraft) {
                  setSelectedKey("brand:zhipu")
                }
              }}
              onTest={!isNewDraft && draft.providerId ? () => testProviderConnectivity(draft.providerId) : null}
              connectivity={draft.providerId ? connectivity[draft.providerId] : undefined}
            />
          )}
        </div>
      </div>
    </div>
  )
}

interface ModelTableProps {
  models: ReturnType<typeof useSettingsStore.getState>["models"]
  search: string
  onSearch: (value: string) => void
  currentModel: ReturnType<typeof useSettingsStore.getState>["currentModel"]
  defaultProvider: string | null
  defaultModel: string | null
  formatTokens: (count: number) => string
  onUse: (provider: string, id: string) => void
  onDefault: (provider: string, id: string) => void
  onTest: (provider: string, id: string) => void
  renderConnectivity: (providerId: string) => React.ReactNode
}

const ModelTable: React.FC<ModelTableProps> = ({
  models,
  search,
  onSearch,
  currentModel,
  defaultProvider,
  defaultModel,
  formatTokens,
  onUse,
  onDefault,
  onTest,
  renderConnectivity,
}) => (
  <div className="space-y-3">
    <div className="flex items-center justify-between gap-3">
      <div className="relative flex-1 max-w-sm">
        <Search className="w-3.5 h-3.5 absolute left-3 text-dim pointer-events-none" />
        <input
          type="text"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="搜索可用模型..."
          className="w-full bg-well text-text-main placeholder-dim pl-8 pr-3 py-1.5 rounded-lg border border-border outline-none focus:border-accent text-[12px]"
        />
      </div>
      <span className="text-[11px] text-muted">{models.length} 个模型（按英文字母排序）</span>
    </div>

    <div className="rounded-xl border border-border-subtle bg-card overflow-hidden shadow-xs">
      <div className="grid grid-cols-12 px-3.5 py-2 bg-surface-2/70 text-[11px] font-medium text-muted border-b border-border">
        <div className="col-span-4">模型名称与 ID</div>
        <div className="col-span-2">上下文 / 输出</div>
        <div className="col-span-1 text-center">推理</div>
        <div className="col-span-1 text-center">来源</div>
        <div className="col-span-4 text-right">操作</div>
      </div>
      <div className="divide-y divide-border-subtle/50 max-h-[460px] overflow-y-auto">
        {models.length === 0 ? (
          <div className="p-8 text-center text-muted text-[12px]">该供应商暂无匹配的模型</div>
        ) : (
          models.map((m) => {
            const isCurrent = currentModel?.provider === m.provider && currentModel?.modelId === m.id
            const isDefault = defaultProvider === m.provider && defaultModel === m.id
            return (
              <div
                key={`${m.provider}:${m.id}`}
                className={`grid grid-cols-12 px-3.5 py-2.5 items-center text-[12px] transition-colors hover:bg-surface-2/40 ${
                  isCurrent ? "bg-accent/5" : ""
                }`}
              >
                <div className="col-span-4 pr-2 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-text-main truncate">{m.name}</span>
                    {isCurrent && (
                      <span className="text-[10px] px-1.5 rounded-full bg-accent/20 text-rose-lite border border-accent/40 font-mono">
                        活跃
                      </span>
                    )}
                    {isDefault && (
                      <span className="text-[10px] px-1.5 rounded-full bg-warning-surface text-warning border border-warning-border">
                        默认
                      </span>
                    )}
                  </div>
                  <div className="text-[10.5px] text-muted font-mono truncate">
                    {m.provider}/{m.id}
                  </div>
                </div>
                <div className="col-span-2 text-muted text-[11.5px]">
                  {formatTokens(m.contextWindow)}
                  {m.maxTokens > 0 && <span className="opacity-60"> / {formatTokens(m.maxTokens)}</span>}
                </div>
                <div className="col-span-1 text-center">
                  {m.reasoning ? (
                    <span className="text-[10.5px] px-1.5 rounded bg-info-surface text-info border border-info-border">
                      支持
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </div>
                <div className="col-span-1 text-center">
                  <span
                    className={`text-[10.5px] px-1.5 rounded border ${
                      m.source === "custom"
                        ? "bg-accent/15 text-rose-lite border-accent/30"
                        : "bg-surface-2 text-dim border-border-subtle"
                    }`}
                  >
                    {m.source === "custom" ? "自定义" : "内置"}
                  </span>
                </div>
                <div className="col-span-4 flex items-center justify-end gap-1.5">
                  <div className="mr-1 hidden lg:block">{renderConnectivity(m.provider)}</div>
                  <button
                    type="button"
                    onClick={() => onTest(m.provider, m.id)}
                    className="p-1 rounded text-dim hover:text-accent hover:bg-surface-2 transition-colors cursor-pointer"
                    title="连通性测试"
                  >
                    <PlugZap className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onUse(m.provider, m.id)}
                    disabled={isCurrent}
                    className={`px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                      isCurrent
                        ? "bg-surface-2 text-dim cursor-default opacity-60"
                        : "bg-surface-2 hover:bg-surface-3 text-text-main border border-border-subtle"
                    }`}
                  >
                    {isCurrent ? "当前活跃" : "切换会话"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDefault(m.provider, m.id)}
                    disabled={isDefault}
                    className={`p-1 rounded transition-colors cursor-pointer ${
                      isDefault ? "text-warning bg-warning-surface" : "text-dim hover:text-warning hover:bg-surface-2"
                    }`}
                    title="设为默认模型"
                  >
                    <Star className={`w-3.5 h-3.5 ${isDefault ? "fill-current" : ""}`} />
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  </div>
)

interface CustomProviderFormProps {
  draft: CustomProviderDraft & { apiKey: string }
  existing: boolean
  apiFormats: typeof CUSTOM_API_FORMATS
  onChange: (patch: Partial<CustomProviderDraft & { apiKey: string }>) => void
  onSave: (cleanedDraft: CustomProviderDraft & { apiKey: string }) => Promise<{ ok: boolean; error?: string }>
  onFetchModels: (params: { baseUrl: string; api: string; apiKey?: string; providerId?: string; headers?: Record<string, string> }) => Promise<{ ok: boolean; models?: CustomModelDraft[]; error?: string }>
  onDelete: (() => void) | null
  onCancel: () => void
  onTest: (() => void) | null
  connectivity: ConnectivityResult | "testing" | undefined
}

const CustomProviderForm: React.FC<CustomProviderFormProps> = ({
  draft,
  existing,
  apiFormats,
  onChange,
  onSave,
  onFetchModels,
  onDelete,
  onCancel,
  onTest,
  connectivity,
}) => {
  const [isFetchingModels, setIsFetchingModels] = useState(false)
  const [fetchNotice, setFetchNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const handleFetchModels = async () => {
    if (!draft.baseUrl.trim()) {
      setFetchNotice({ ok: false, text: "请先填写 Base URL" })
      return
    }
    setIsFetchingModels(true)
    setFetchNotice(null)
    try {
      const res = await onFetchModels({
        baseUrl: draft.baseUrl.trim(),
        api: draft.api,
        apiKey: draft.apiKey.trim(),
        providerId: draft.providerId.trim(),
      })
      if (res.ok && res.models && res.models.length > 0) {
        onChange({ models: res.models })
        setFetchNotice({ ok: true, text: `成功获取并载入 ${res.models.length} 个模型（已按英文字母排序）` })
      } else {
        setFetchNotice({ ok: false, text: res.error || "未发现可用模型，请检查服务状态与 Base URL" })
      }
    } catch (e: any) {
      setFetchNotice({ ok: false, text: `获取异常: ${e.message || e}` })
    } finally {
      setIsFetchingModels(false)
    }
  }

  const handleSaveClick = async () => {
    setFormError(null)
    const providerId = draft.providerId.trim()
    if (!providerId) {
      setFormError("提供商 ID 不能为空")
      return
    }
    let baseUrl = draft.baseUrl.trim()
    if (!baseUrl) {
      setFormError("Base URL 不能为空")
      return
    }
    if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
      baseUrl = `http://${baseUrl}`
    }

    // Filter out empty model rows
    const validModels = draft.models.filter((m) => m.id.trim())
    if (validModels.length === 0) {
      validModels.push({
        id: providerId,
        name: draft.name.trim() || providerId,
        contextWindow: 128000,
        maxTokens: 16384,
      })
    }

    // Sort valid models in English alphabetical order
    validModels.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, "en", { sensitivity: "base" }))

    const cleanedDraft: CustomProviderDraft & { apiKey: string } = {
      ...draft,
      providerId,
      name: draft.name.trim() || providerId,
      baseUrl,
      apiKey: draft.apiKey.trim(),
      models: validModels,
    }

    setIsSaving(true)
    try {
      const res = await onSave(cleanedDraft)
      if (!res.ok) {
        setFormError(res.error || "保存失败，请检查配置")
      }
    } catch (e: any) {
      setFormError(`保存异常: ${e.message || e}`)
    } finally {
      setIsSaving(false)
    }
  }

  const updateModel = (index: number, patch: Partial<CustomProviderDraft["models"][number]>) => {
    const next = draft.models.map((model, i) => (i === index ? { ...model, ...patch } : model))
    onChange({ models: next })
  }
  const addModel = () =>
    onChange({ models: [...draft.models, { id: "", name: "", contextWindow: 128000, maxTokens: 16384 }] })
  const removeModel = (index: number) => {
    if (draft.models.length <= 1) return
    onChange({ models: draft.models.filter((_, i) => i !== index) })
  }

  return (
    <div className="space-y-4">
      {formError && (
        <div className="rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-[12px] text-danger">
          {formError}
        </div>
      )}
      <div className="flex items-start gap-3">
        <BrandLogo brandId="custom" size={40} />
        <div className="flex-1 min-w-0">
          <h3 className="text-[14px] font-semibold text-text-main">
            {existing ? `编辑自定义提供商 · ${draft.name || draft.providerId}` : "新建自定义提供商"}
          </h3>
          <p className="text-[11.5px] text-muted mt-1 leading-relaxed">
            支持 OpenAI 格式与 Anthropic 格式。配置将保存在 ~/.misaka/models.json，保存后即可在模型列表中选用。
          </p>
        </div>
        {connectivity && connectivity !== "testing" && (
          <span className={`text-[11px] ${connectivity.ok ? "text-success" : "text-danger"}`}>
            {connectivity.ok ? `连通正常 · ${connectivity.latencyMs ?? 0}ms` : connectivity.error}
          </span>
        )}
        {connectivity === "testing" && (
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <Loader2 className="w-3 h-3 animate-spin text-accent" />探测中…
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="提供商 ID (英文字母/数字/中划线)">
          <input
            type="text"
            value={draft.providerId}
            disabled={existing}
            onChange={(e) => onChange({ providerId: e.target.value })}
            placeholder="例如 ollama, lmstudio"
            className="w-full bg-surface-2 text-text-main placeholder-dim px-2.5 py-1.5 rounded-lg border border-border outline-none focus:border-accent text-[12px] font-mono disabled:opacity-60"
          />
        </Field>
        <Field label="显示名称">
          <input
            type="text"
            value={draft.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="例如 本地 Ollama 服务"
            className="w-full bg-surface-2 text-text-main placeholder-dim px-2.5 py-1.5 rounded-lg border border-border outline-none focus:border-accent text-[12px]"
          />
        </Field>
        <Field label="Base URL (接口基础地址)">
          <input
            type="text"
            value={draft.baseUrl}
            onChange={(e) => onChange({ baseUrl: e.target.value })}
            placeholder="http://localhost:11434/v1"
            className="w-full bg-surface-2 text-text-main placeholder-dim px-2.5 py-1.5 rounded-lg border border-border outline-none focus:border-accent text-[12px] font-mono"
          />
        </Field>
        <Field label="API 格式协议">
          <select
            value={draft.api}
            onChange={(e) => onChange({ api: e.target.value })}
            className="w-full bg-surface-2 text-text-main px-2.5 py-1.5 rounded-lg border border-border outline-none focus:border-accent text-[12px] cursor-pointer"
          >
            {apiFormats.map((format) => (
              <option key={format.value} value={format.value}>
                {format.label} ({format.path})
              </option>
            ))}
          </select>
        </Field>
        <Field label="API Key (本地免密服务如 Ollama 可留空)" full>
          <input
            type="password"
            value={draft.apiKey}
            onChange={(e) => onChange({ apiKey: e.target.value })}
            placeholder={draft.hasApiKey && existing ? "已保存凭据，留空则保持不变" : "输入 API Key（免密服务可直接留空）"}
            className="w-full bg-surface-2 text-text-main placeholder-dim px-2.5 py-1.5 rounded-lg border border-border outline-none focus:border-accent text-[12px] font-mono"
          />
        </Field>
      </div>

      <div className="space-y-2 pt-1 border-t border-border-subtle/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] font-medium text-text-main">模型列表</span>
            <span className="text-[11px] text-muted">（支持一键获取或手动配置）</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleFetchModels}
              disabled={isFetchingModels || !draft.baseUrl.trim()}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-2 hover:bg-surface-3 border border-border-subtle text-[11.5px] text-text-main transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              title="向 Base URL 发送探测请求拉取模型列表 (/models, /v1/models, /api/tags)"
            >
              {isFetchingModels ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
              ) : (
                <Download className="w-3.5 h-3.5 text-accent" />
              )}
              <span>{isFetchingModels ? "正在获取…" : "获取模型列表"}</span>
            </button>
            <button
              type="button"
              onClick={addModel}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-surface-2 hover:bg-surface-3 border border-border-subtle text-[11.5px] text-text-main transition-colors cursor-pointer"
            >
              <Plus className="w-3 h-3 text-dim" />
              <span>添加模型</span>
            </button>
          </div>
        </div>
        {fetchNotice && (
          <div
            className={`text-[11.5px] px-2.5 py-1.5 rounded-lg border ${
              fetchNotice.ok
                ? "bg-success-surface text-success border-success-border"
                : "bg-danger-surface text-danger border-danger-border"
            }`}
          >
            {fetchNotice.text}
          </div>
        )}
        <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
          {draft.models.map((model, index) => (
            <div key={index} className="grid grid-cols-12 gap-2 items-center">
              <input
                type="text"
                value={model.id}
                onChange={(e) => updateModel(index, { id: e.target.value })}
                placeholder="模型 ID，例如 qwen3:32b"
                className="col-span-4 bg-surface-2 text-text-main placeholder-dim px-2 py-1.5 rounded-lg border border-border outline-none focus:border-accent text-[11.5px] font-mono"
              />
              <input
                type="text"
                value={model.name ?? ""}
                onChange={(e) => updateModel(index, { name: e.target.value })}
                placeholder="显示名称（可选）"
                className="col-span-3 bg-surface-2 text-text-main placeholder-dim px-2 py-1.5 rounded-lg border border-border outline-none focus:border-accent text-[11.5px]"
              />
              <input
                type="number"
                value={model.contextWindow ?? 128000}
                onChange={(e) => updateModel(index, { contextWindow: Number(e.target.value) })}
                placeholder="上下文"
                className="col-span-2 bg-surface-2 text-text-main px-2 py-1.5 rounded-lg border border-border outline-none focus:border-accent text-[11.5px] font-mono"
              />
              <input
                type="number"
                value={model.maxTokens ?? 16384}
                onChange={(e) => updateModel(index, { maxTokens: Number(e.target.value) })}
                placeholder="输出限制"
                className="col-span-2 bg-surface-2 text-text-main px-2 py-1.5 rounded-lg border border-border outline-none focus:border-accent text-[11.5px] font-mono"
              />
              <button
                type="button"
                onClick={() => removeModel(index)}
                disabled={draft.models.length <= 1}
                className="col-span-1 flex justify-center text-dim hover:text-danger transition-colors cursor-pointer disabled:opacity-30"
                title="删除模型"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-border-subtle/60">
        <div>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="flex items-center gap-1.5 text-[11.5px] text-dim hover:text-danger transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>删除提供商</span>
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onTest && (
            <button
              type="button"
              onClick={onTest}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-2 hover:bg-surface-3 border border-border-subtle text-[11.5px] text-text-main transition-colors cursor-pointer"
            >
              <PlugZap className="w-3.5 h-3.5 text-dim" />
              <span>测试连接</span>
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="px-2.5 py-1 rounded-lg text-[11.5px] text-dim hover:text-text-main transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSaveClick}
            disabled={isSaving || !draft.providerId.trim() || !draft.baseUrl.trim()}
            className="misaka-luminous flex items-center gap-1.5 px-3 py-1 rounded-lg bg-accent hover:opacity-90 text-on-accent text-[11.5px] font-medium transition-all cursor-pointer shadow-xs disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            <span>{isSaving ? "保存中…" : "保存提供商"}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

const Field: React.FC<{ label: string; children: React.ReactNode; full?: boolean }> = ({
  label,
  children,
  full,
}) => (
  <label className={`space-y-1 ${full ? "sm:col-span-2" : ""}`}>
    <span className="block text-[11px] text-muted">{label}</span>
    {children}
  </label>
)

export default ModelProviderSection
