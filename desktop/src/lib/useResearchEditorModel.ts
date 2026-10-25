import { useSessionStore } from '../store/useSessionStore'
import { useSettingsStore } from '../store/useSettingsStore'
/** Research new-entry configuration never depends on a later ordinary capability reply. */
export function useResearchEditorModel(role: 'sister' | 'last_order' = 'sister') {
 const editor = useSessionStore(s => s.agentMode === 'research' && s.researchPageView === 'new' ? s.researchEditors[s.researchView.ownerKey] : undefined)
 const roleBinding = useSessionStore(s => s.agentMode === 'research' && s.researchPageView !== 'new' ? s.researchModelBindings?.[role] : null)
 const fallback = useSettingsStore(s => s.currentModel)
 const fallbackLevel = useSettingsStore(s => s.thinkingLevel)
 const localModel = role === 'last_order' ? editor?.lastOrderModel : editor?.model
 const boundModel = roleBinding?.effective
 return { currentModel: localModel || (boundModel ? { ...boundModel, name: boundModel.modelId, thinking: fallbackLevel } : fallback),
   thinkingLevel: localModel ? editor?.thinkingLevel ?? fallbackLevel : fallbackLevel, local: Boolean(editor) }
}
