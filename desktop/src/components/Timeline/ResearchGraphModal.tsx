import React from 'react'
import { Network, X } from 'lucide-react'
import { useSessionStore } from '../../store/useSessionStore'
import { ResearchGraphCanvas } from '../ResearchGraph/ResearchGraphCanvas'

export const ResearchGraphModal: React.FC = () => {
  const activeGraphRunId = useSessionStore(s => s.activeResearchGraphRunId)
  const setActiveGraphRunId = useSessionStore(s => s.setActiveResearchGraphRunId)

  if (!activeGraphRunId) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm p-4 animate-in fade-in duration-200"
      role="dialog"
      aria-label="研究拓扑图"
    >
      <div className="relative flex flex-col w-full max-w-5xl h-[85vh] rounded-2xl bg-card border border-border-subtle shadow-e3 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle bg-surface-2/60 shrink-0">
          <div className="flex items-center gap-2">
            <Network className="w-4 h-4 text-accent" />
            <span className="font-semibold text-text-main text-xs">研究拓扑关系图 (DAG)</span>
            <span className="text-[10px] text-muted font-mono">({activeGraphRunId})</span>
          </div>
          <button
            type="button"
            onClick={() => setActiveGraphRunId(null)}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-3 text-dim hover:text-text-main transition-colors cursor-pointer"
            aria-label="关闭研究图"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0 relative">
          <ResearchGraphCanvas showRunPicker={false} showNodeDrawer={true} />
        </div>
      </div>
    </div>
  )
}
