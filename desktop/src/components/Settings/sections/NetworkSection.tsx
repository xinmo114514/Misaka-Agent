import React, { useEffect, useState } from 'react'
import { AlertCircle, Check, LoaderCircle, Network, PlugZap, Save } from 'lucide-react'
import { useSettingsStore } from '../../../store/useSettingsStore'
import type { ProxyRoute } from '../../../types/settings'
import { validateProxyDraft, type ProxyDraftErrors, type ProxySettingsDraft } from '../../../lib/proxySettings'

function routeLabel(route: ProxyRoute | null) {
  if (!route) return '尚未获得有效路由'
  if (route.mode === 'direct') return `直连 · ${route.endpoint}`
  return `${route.proxy || '代理'} · ${route.endpoint}`
}

export const NetworkSection: React.FC = () => {
  const snapshot = useSettingsStore((state) => state.proxySettingsSnapshot)
  const status = useSettingsStore((state) => state.proxySettingsStatus)
  const storeError = useSettingsStore((state) => state.proxySettingsError)
  const savePending = useSettingsStore((state) => state.proxySavePending)
  const checkPending = useSettingsStore((state) => state.proxyCheckPending)
  const checkResult = useSettingsStore((state) => state.proxyConnectionCheck)
  const loadProxySettings = useSettingsStore((state) => state.loadProxySettings)
  const clearProxyFeedback = useSettingsStore((state) => state.clearProxyFeedback)
  const saveProxySettings = useSettingsStore((state) => state.saveProxySettings)
  const checkProxyConnection = useSettingsStore((state) => state.checkProxyConnection)
  const [draft, setDraft] = useState<ProxySettingsDraft | null>(null)
  const [errors, setErrors] = useState<ProxyDraftErrors>({})
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    void loadProxySettings().catch(() => undefined)
  }, [loadProxySettings])

  useEffect(() => {
    if (!snapshot) return
    setDraft({
      ...snapshot.settings,
      port: snapshot.settings.port === null ? '' : String(snapshot.settings.port),
    })
  }, [snapshot])

  const updateDraft = <K extends keyof ProxySettingsDraft>(key: K, value: ProxySettingsDraft[K]) => {
    setDraft((current) => current ? { ...current, [key]: value } : current)
    if (key === 'port' || key === 'host') {
      setErrors((current) => ({ ...current, [key]: undefined }))
    }
    setNotice(null)
    clearProxyFeedback()
  }

  const validatedDraft = () => {
    if (!draft) return null
    const result = validateProxyDraft(draft)
    setErrors(result.errors)
    if (!result.settings) setNotice({ kind: 'error', text: result.errors.port || result.errors.host || '请检查代理设置。' })
    return result.settings
  }

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault()
    if (savePending || checkPending) return
    const settings = validatedDraft()
    if (!settings) return
    setNotice(null)
    try {
      await saveProxySettings(settings)
      setNotice({ kind: 'success', text: '代理设置已保存，并已更新有效模型路由。' })
    } catch (error) {
      setNotice({ kind: 'error', text: `保存失败：${error instanceof Error ? error.message : String(error)}` })
    }
  }

  const handleCheck = async () => {
    if (savePending || checkPending) return
    const settings = validatedDraft()
    if (!settings) return
    setNotice(null)
    try {
      await checkProxyConnection(settings)
    } catch (error) {
      setNotice({ kind: 'error', text: `检查失败：${error instanceof Error ? error.message : String(error)}` })
    }
  }

  const pending = savePending || checkPending
  const unavailable = status !== 'ready' || !draft
  const dirty = Boolean(draft && snapshot && (
    draft.enabled !== snapshot.settings.enabled
    || draft.whenDisabled !== snapshot.settings.whenDisabled
    || draft.protocol !== snapshot.settings.protocol
    || draft.host !== snapshot.settings.host
    || draft.port !== (snapshot.settings.port === null ? '' : String(snapshot.settings.port))
  ))
  const controlClass = 'w-full rounded-lg border border-border-subtle bg-well px-3 py-2 text-[12.5px] text-text-main outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-focus-ring/30 disabled:cursor-not-allowed disabled:opacity-50'

  return (
    <div className="space-y-6">
      <header className="misaka-glass-panel relative rounded-xl border border-border-subtle bg-card p-4 shadow-e1">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-main">
          <Network className="h-4 w-4 text-accent" aria-hidden="true" />
          <span>网络与代理</span>
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          此代理应用于原生模型请求与原生 OAuth；工具、系统代理及其他流量使用各自独立策略。
        </p>
      </header>

      <form onSubmit={handleSave} className="misaka-glass-panel relative space-y-5 rounded-xl border border-border-subtle bg-card p-5 shadow-e1">
        <div className="flex items-center justify-between gap-4 border-b border-border-subtle/60 pb-4">
          <div>
            <div className="text-[13px] font-medium text-text-main">使用代理</div>
            <p className="mt-1 text-xs leading-relaxed text-muted">开启后使用下方自定义代理；关闭后按所选策略直连或沿用环境代理。</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label="使用代理"
            aria-checked={draft?.enabled ?? false}
            disabled={unavailable || pending}
            onClick={() => draft && updateDraft('enabled', !draft.enabled)}
            className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50 ${draft?.enabled ? 'bg-accent' : 'bg-surface-3'}`}
          >
            <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-switch-thumb shadow-lg transition-transform duration-200 ${draft?.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5 text-xs text-muted">
            <span className="font-medium text-text-main">关闭代理时</span>
            <select aria-label="关闭代理时" value={draft?.whenDisabled ?? 'environment'} disabled={unavailable || pending} onChange={(event) => updateDraft('whenDisabled', event.target.value as ProxySettingsDraft['whenDisabled'])} className={controlClass}>
              <option value="environment">沿用环境代理</option>
              <option value="direct">直接连接</option>
            </select>
            <span className="block leading-relaxed">现有安装默认沿用 HTTP(S)/ALL_PROXY 与 NO_PROXY 环境策略；自定义代理也继续遵循有效的 NO_PROXY 绕过列表。</span>
          </label>

          <label className="space-y-1.5 text-xs text-muted">
            <span className="font-medium text-text-main">代理协议</span>
            <select aria-label="代理协议" value={draft?.protocol ?? 'http'} disabled={unavailable || pending} onChange={(event) => updateDraft('protocol', event.target.value as ProxySettingsDraft['protocol'])} className={controlClass}>
              <option value="http">HTTP</option>
              <option value="https">HTTPS</option>
              <option value="socks5">SOCKS5</option>
              <option value="socks5h">SOCKS5h（代理解析 DNS）</option>
            </select>
          </label>

          <label className="space-y-1.5 text-xs text-muted sm:col-span-2">
            <span className="font-medium text-text-main">代理服务器</span>
            <input aria-label="代理服务器" aria-invalid={Boolean(errors.host)} aria-describedby={errors.host ? 'proxy-host-error' : undefined} type="text" autoComplete="off" spellCheck={false} value={draft?.host ?? ''} disabled={unavailable || pending} onChange={(event) => updateDraft('host', event.target.value)} className={controlClass} />
            <span className="block leading-relaxed">填写 IPv4、IPv6 或 DNS 主机名，不含协议、路径或凭据。</span>
            {errors.host && <span id="proxy-host-error" className="block text-danger">{errors.host}</span>}
          </label>

          <label className="space-y-1.5 text-xs text-muted sm:col-span-2">
            <span className="font-medium text-text-main">代理端口</span>
            <input aria-label="代理端口" aria-invalid={Boolean(errors.port)} aria-describedby={errors.port ? 'proxy-port-error' : 'proxy-port-help'} type="text" inputMode="numeric" autoComplete="off" value={draft?.port ?? ''} disabled={unavailable || pending} onChange={(event) => updateDraft('port', event.target.value)} className={controlClass} />
            <span id="proxy-port-help" className="block leading-relaxed">未预设任何代理软件端口；启用自定义代理时请输入 1–65535 的整数。</span>
            <span className="block leading-relaxed">具体模型适配器不支持所选协议时会显示错误，不会静默切换路由。</span>
            {errors.port && <span id="proxy-port-error" className="block text-danger">{errors.port}</span>}
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle/60 pt-4">
          {dirty && <span className="mr-auto text-xs text-warning">未保存的更改</span>}
          <button type="button" onClick={handleCheck} disabled={unavailable || pending} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-xs font-medium text-text-main transition-colors hover:bg-surface-3 focus:outline-none focus:ring-2 focus:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50">
            {checkPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <PlugZap className="h-3.5 w-3.5 text-accent" aria-hidden="true" />}
            <span>检查连接</span>
          </button>
          <button type="submit" disabled={unavailable || pending} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-accent/50 bg-accent px-3 py-2 text-xs font-medium text-on-accent transition-opacity hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50">
            {savePending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Save className="h-3.5 w-3.5" aria-hidden="true" />}
            <span>保存代理设置</span>
          </button>
        </div>
      </form>

      <section aria-labelledby="saved-route-heading" className="misaka-glass-panel relative rounded-xl border border-border-subtle bg-card p-4 shadow-e1">
        <h3 id="saved-route-heading" className="text-[13px] font-medium text-text-main">当前聊天模型的已保存有效路径</h3>
        <p className="mt-2 break-all rounded-lg border border-border-subtle bg-well px-3 py-2 font-mono text-xs text-muted">
          {status === 'ready' && snapshot ? routeLabel(snapshot.route)
            : status === 'loading' ? '正在读取…'
            : status === 'error' ? '读取失败，请重新读取当前配置。' : '尚未载入'}
        </p>
        {status === 'ready' && snapshot?.routeError && <p role="alert" className="mt-2 text-xs text-danger">{snapshot.routeError}</p>}
        {status === 'error' && (
          <button type="button" onClick={() => { setNotice(null); void loadProxySettings().catch(() => undefined) }} className="mt-3 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-xs text-text-main hover:bg-surface-3 focus:outline-none focus:ring-2 focus:ring-focus-ring">
            重新读取代理设置
          </button>
        )}
        <p className="mt-2 text-xs leading-relaxed text-muted">此处显示普通聊天当前模型的端点路径；其他原生模型请求会按各自端点应用同一设置。</p>
      </section>

      {checkResult && (
        <div role={checkResult.reachable ? 'status' : 'alert'} className={`flex items-start gap-2 rounded-lg border p-3 text-xs ${checkResult.reachable ? 'border-success-border bg-success-surface text-success' : 'border-danger-border bg-danger-surface text-danger'}`}>
          {checkResult.reachable ? <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
          <div>
            <div className="font-medium">{checkResult.reachable ? 'TCP 端口可达' : 'TCP 未连通'}</div>
            <div className="mt-1 opacity-90">{checkResult.error || routeLabel(checkResult.route)}。此检查不验证模型凭据、鉴权或模型服务可用性。</div>
          </div>
        </div>
      )}

      {notice && (
        <div role={notice.kind === 'error' ? 'alert' : 'status'} className={`flex items-center gap-2 rounded-lg border p-3 text-xs ${notice.kind === 'error' ? 'border-danger-border bg-danger-surface text-danger' : 'border-success-border bg-success-surface text-success'}`}>
          {notice.kind === 'error' ? <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" /> : <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
          <span>{notice.text}</span>
        </div>
      )}

      {!notice && storeError && <div role="alert" className="rounded-lg border border-danger-border bg-danger-surface p-3 text-xs text-danger">{storeError}</div>}
    </div>
  )
}
