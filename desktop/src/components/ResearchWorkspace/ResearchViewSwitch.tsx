import { Columns3, PanelLeft } from 'lucide-react'
import type { ResearchViewMode } from '../../lib/researchViewMode'

/**
 * 专注 / 多窗. The choice is the user's and is remembered; switching never changes what is
 * selected or how far a transcript is read, because that state lives in the workspace store.
 */
export function ResearchViewSwitch({ mode, onChange }: {
  mode: ResearchViewMode
  onChange: (mode: ResearchViewMode) => void
}) {
  return <div className="research-view-switch" role="group" aria-label="研究视图">
    <button type="button" className={`research-view-option ${mode === 'focus' ? 'is-active' : ''}`}
      aria-label="专注" aria-pressed={mode === 'focus'} onClick={() => onChange('focus')} title="专注视图：一个会话，其余成员在团队列表">
      <PanelLeft size={13} aria-hidden="true" /><span>专注</span>
    </button>
    <button type="button" className={`research-view-option ${mode === 'multi' ? 'is-active' : ''}`}
      aria-label="多窗" aria-pressed={mode === 'multi'} onClick={() => onChange('multi')} title="多窗视图：并排查看多个成员会话">
      <Columns3 size={13} aria-hidden="true" /><span>多窗</span>
    </button>
  </div>
}
