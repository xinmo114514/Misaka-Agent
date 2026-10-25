import { useResearchEditorModel } from '../../lib/useResearchEditorModel'
import { useEffect, useRef } from 'react'
import { ArrowLeft, Check, Search, Settings, Star } from 'lucide-react'
import type { ModelDetail } from '../../types/settings'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useSessionStore } from '../../store/useSessionStore'
import { hasThinkingCapability, resolveSupportedLevels } from '../../lib/thinkingLevels'

interface Props {
  models: ModelDetail[]
  search: string
  onSearch: (search: string) => void
  onBack: () => void
  onConfigure: () => void
  onSelect: (model: ModelDetail) => void
}
const iconButton = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-text-main focus-visible:ring-2 focus-visible:ring-focus-ring/40 cursor-pointer'

export function ModelPickerModelView({ models, search, onSearch, onBack, onConfigure, onSelect }: Props) {
  const { currentModel, local } = useResearchEditorModel()
  const modelSwitchPending = useSettingsStore(s => s.modelSwitchPending)
  const unready = useSessionStore(s => s.agentMode === 'research'
    ? false : s.isSessionLoading || Boolean(s.sessionLoadError) || s.currentSessionId !== s.activeSessionId)
  const blocked = unready || (!local && modelSwitchPending && !currentModel)
  const defaultProvider = useSettingsStore(s => s.defaultProvider)
  const defaultModel = useSettingsStore(s => s.defaultModel)
  const backRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const searchable = models.length > 5
  useEffect(() => { (searchable ? searchRef.current : backRef.current)?.focus({ preventScroll: true }) }, [searchable])
  const query = search.trim().toLowerCase()
  const filtered = searchable && query ? models.filter(m => `${m.name} ${m.provider} ${m.id}`.toLowerCase().includes(query)) : models

  return <div className="misaka-picker-layer misaka-picker-models flex min-h-0 flex-col gap-2">
    <div className="flex shrink-0 items-center gap-1 border-b border-border-subtle/80 pb-2">
      <button ref={backRef} type="button" aria-label="返回思考深度" onClick={onBack} className={iconButton}><ArrowLeft className="h-3.5 w-3.5" /></button>
      <span className="flex-1 text-[12px] font-semibold text-text-main">会话模型</span>
      <span className="text-[11px] tabular-nums text-muted">{models.length} 个可用</span>
      <button type="button" aria-label="配置凭据" title="配置凭据" onClick={onConfigure} className={iconButton}><Settings className="h-3.5 w-3.5" /></button>
    </div>
    {searchable && <div className="relative shrink-0">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted" />
      <input ref={searchRef} type="text" value={search} onChange={event => onSearch(event.target.value)} placeholder="搜索模型…" aria-label="搜索模型"
        className="w-full rounded-md border border-border-subtle bg-surface-2 py-1.5 pl-7 pr-2.5 text-[12px] text-text-main outline-none placeholder:text-muted focus:border-accent" />
    </div>}
    <div className="misaka-picker-model-list min-h-0 space-y-0.5 overflow-y-auto overscroll-contain">
      {models.length === 0 ? <div className="space-y-2 px-1 py-3 text-center">
        <p className="text-[12px] text-text-main">暂无可用模型</p>
        <p className="text-[11px] leading-relaxed text-muted">在「模型与供应商」中配置凭据后，模型会显示在这里。</p>
        <button type="button" onClick={onConfigure} className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-on-accent hover:opacity-90 focus-visible:ring-2 focus-visible:ring-focus-ring/40 cursor-pointer">前往配置模型</button>
      </div> : filtered.length === 0 ? <p className="p-3 text-center text-[12px] text-muted">未匹配到模型</p> : filtered.map(model => {
        const selected = currentModel?.provider === model.provider && currentModel.modelId === model.id
        const isDefault = defaultProvider === model.provider && defaultModel === model.id
        const levels = resolveSupportedLevels(model)
        const badge = model.thinkingCapability?.status === 'default' || !hasThinkingCapability(model) || model.thinkingCapability?.status === 'unknown' ? '模型默认'
            : (model.supportsThinking ?? model.reasoning) === false ? '不支持深度' : levels.length === 0 ? '无可选档位' : `${levels.length} 档`
        return <button key={`${model.provider}:${model.id}`} type="button" disabled={blocked} aria-current={selected ? 'true' : undefined}
          title={`${model.name || model.id} · ${model.provider}/${model.id}`} onClick={() => onSelect(model)}
          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring/40 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${selected ? 'bg-surface-hover' : 'hover:bg-surface-hover'}`}>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[12px] font-medium text-text-main">{model.name || model.id}</span>
              {isDefault && <Star aria-label="默认模型" className="h-3 w-3 shrink-0 fill-warning text-warning" />}
            </span>
            <span className="block truncate text-[10px] leading-4 text-muted">{model.provider}/{model.id}</span>
          </span>
          <span className="shrink-0 text-[10px] text-muted">{badge}</span>
          <span className="flex w-3.5 shrink-0 justify-center">{selected && <Check className="h-3.5 w-3.5 text-rose" />}</span>
        </button>
      })}
    </div>
  </div>
}
