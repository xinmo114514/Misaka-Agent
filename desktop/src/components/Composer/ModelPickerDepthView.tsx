import { useResearchEditorModel } from '../../lib/useResearchEditorModel'
import { ChevronRight } from 'lucide-react'
import { ThinkingSlider } from '../Thinking/ThinkingSlider'
import { resetTarget, type ThinkingStops } from '../../lib/thinkingLevels'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useSessionStore } from '../../store/useSessionStore'

export function ModelPickerDepthView({ stops, onModels, role = 'sister' }: { stops: ThinkingStops; onModels: () => void; role?: 'sister' | 'last_order' }) {
  const { currentModel, thinkingLevel, local } = useResearchEditorModel(role)
  const defaultLevel = useSettingsStore(s => s.configPaths?.defaultThinkingLevel)
  const busy = useSettingsStore(s => s.modelSwitchPending)
  const researchReadOnly = useSessionStore(s => s.agentMode === 'research' && s.researchPageView !== 'new' && Boolean(s.researchBinding))
  const setThinkingLevel = useSettingsStore(s => s.setThinkingLevel)
  const target = resetTarget(defaultLevel, stops.levels)
  const name = currentModel?.name || '选择模型'
  return <div className="misaka-picker-layer">
    <ThinkingSlider size="compact" levels={stops.levels} value={thinkingLevel} isFallback={stops.isFallback} busy={!local && busy} readOnly={researchReadOnly}
      modelDefault={Boolean(stops.isDefault || stops.isFallback)}
      resetTo={target} onReset={() => setThinkingLevel(target)} onChange={setThinkingLevel}
      afterHeader={<button type="button" onClick={onModels} aria-label={name} title={name} aria-haspopup="true"
        className="misaka-picker-model-link group flex w-full items-center justify-center gap-1 rounded-md px-5 text-muted transition-colors hover:bg-surface-hover hover:text-text-main focus-visible:ring-2 focus-visible:ring-focus-ring/40 cursor-pointer">
        <span className="min-w-0 truncate text-[12px] leading-5">{name}</span>
        <ChevronRight className="h-3 w-3 shrink-0 text-dim" />
      </button>} />
  </div>
}
