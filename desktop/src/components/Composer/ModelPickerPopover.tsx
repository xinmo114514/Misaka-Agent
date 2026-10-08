import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSettingsStore } from '../../store/useSettingsStore'
import { thinkingStopsFor } from '../../lib/thinkingLevels'
import { ModelPickerDepthView } from './ModelPickerDepthView'
import { ModelPickerModelView } from './ModelPickerModelView'
import { useSessionStore } from '../../store/useSessionStore'

interface ModelPickerPopoverProps {
  triggerRef?: React.RefObject<HTMLElement | null>
  onOpenModelSettings?: () => void
  onClose: () => void
}

/** One anchored shell; two independently focusable views. */
export const ModelPickerPopover: React.FC<ModelPickerPopoverProps> = ({ triggerRef, onOpenModelSettings, onClose }) => {
  const models = useSettingsStore(s => s.models)
  const currentModel = useSettingsStore(s => s.currentModel)
  const availableThinkingLevels = useSettingsStore(s => s.availableThinkingLevels)
  const supportsThinking = useSettingsStore(s => s.supportsThinking)
  const thinkingCapability = useSettingsStore(s => s.thinkingCapability)
  const clearPickerError = useSettingsStore(s => s.clearPickerError)
  const pickerError = useSettingsStore(s => s.pickerError)
  const setSessionModel = useSettingsStore(s => s.setSessionModel)
  const researchScene = useSessionStore(s => s.agentMode === 'research' && Boolean(s.researchBinding))
  const researchTarget = useSettingsStore(s => s.researchModelTarget)
  const modelSwitchPending = useSettingsStore(s => s.modelSwitchPending)
  const retryResearchModelSwitch = useSettingsStore(s => s.retryResearchModelSwitch)
  const cancelResearchModelSwitch = useSettingsStore(s => s.cancelResearchModelSwitch)
  const [layer, setLayer] = useState<'depth' | 'models'>('depth')
  const [search, setSearch] = useState('')
  const cardRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 8, top: 8, maxHeight: window.innerHeight - 16 })
  const stops = useMemo(() => thinkingStopsFor({ currentModel, models, backendLevels: availableThinkingLevels, backendSupportsThinking: supportsThinking, backendCapability: thinkingCapability }), [currentModel, models, availableThinkingLevels, supportsThinking, thinkingCapability])
  const availableModels = useMemo(() => models.filter(m => m.configured).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, 'en', { sensitivity: 'base' })), [models])

  useEffect(() => {
    const trigger = triggerRef?.current
    return () => { clearPickerError(); trigger?.focus({ preventScroll: true }) }
  }, [triggerRef, clearPickerError])

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!cardRef.current?.contains(event.target as Node) && !triggerRef?.current?.contains(event.target as Node)) onClose()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      // A drag owns its first Escape (preview cancellation); the next leaves the layer.
      if (cardRef.current?.querySelector('[data-dragging]')) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (layer === 'models') setLayer('depth')
      else onClose()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true) }
  }, [layer, onClose, triggerRef])

  useLayoutEffect(() => {
    const measure = () => {
      const card = cardRef.current
      const anchor = triggerRef?.current
      if (!card || !anchor) return
      const rect = anchor.getBoundingClientRect()
      const margin = 8
      const maxHeight = Math.min(window.innerHeight - margin * 2, Math.max(120, rect.top - margin * 2))
      const height = Math.min(card.scrollHeight + 2, maxHeight)
      const left = Math.max(margin, Math.min(rect.right - card.offsetWidth, window.innerWidth - margin - card.offsetWidth))
      const top = Math.max(margin, Math.min(rect.top - margin - height, window.innerHeight - margin - height))
      setPosition(prev => prev.left === left && prev.top === top && prev.maxHeight === maxHeight ? prev : { left, top, maxHeight })
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (cardRef.current) observer.observe(cardRef.current)
    if (triggerRef?.current) observer.observe(triggerRef.current)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [layer, search, stops.levels, pickerError, triggerRef])

  const configure = () => { onClose(); onOpenModelSettings?.() }
  return createPortal(
    <div ref={cardRef} role="dialog" aria-label="模型与思考深度" data-model-picker="" data-layer={layer}
      style={{ ...position, width: 'min(288px, calc(100vw - 16px))' }}
      className="misaka-model-picker misaka-glass-popover fixed z-50 rounded-xl border border-border-subtle bg-card p-3 text-xs shadow-e3">
      {layer === 'depth'
        ? <ModelPickerDepthView key="depth" stops={stops} onModels={() => setLayer('models')} />
        : <ModelPickerModelView key="models" models={availableModels} search={search} onSearch={setSearch} onBack={() => setLayer('depth')} onConfigure={configure}
            onSelect={model => { setSessionModel(model.provider, model.id); setLayer('depth') }} />}
      {pickerError && <p role="status" className="mt-2 rounded-md border border-danger-border bg-danger-surface px-2 py-1 text-[11px] leading-normal text-danger">{pickerError}</p>}
      {researchScene && researchTarget && <div className="mt-2 space-y-2 border-t border-border-subtle pt-2">
        {modelSwitchPending && <p className="text-[11px] text-muted">正在切换至 {researchTarget.provider}/{researchTarget.modelId}</p>}
        <div className="flex justify-end gap-2">
          {!modelSwitchPending && pickerError && <button type="button" onClick={retryResearchModelSwitch} className="rounded-md bg-accent px-2 py-1 text-[11px] text-on-accent">重试模型切换</button>}
          <button type="button" onClick={cancelResearchModelSwitch} className="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-muted hover:bg-surface-hover">取消模型切换</button>
        </div>
      </div>}
    </div>, document.body,
  )
}
