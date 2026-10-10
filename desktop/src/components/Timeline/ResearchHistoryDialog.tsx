import React, { useEffect, useState } from 'react'
import {
  CheckCircle2,
  History,
  Loader2,
  PauseCircle,
  Search,
  X,
} from 'lucide-react'
import { useSessionStore } from '../../store/useSessionStore'
import { researchPhaseLabel } from '../../lib/researchStatus'
import type { ResearchRunSummary } from '../../types/research'
import { openResearchConversation } from '../../lib/startComposerResearch'

export const ResearchHistoryDialog: React.FC = () => {
  const open = useSessionStore(s => s.researchHistoryOpen)
  const setOpen = useSessionStore(s => s.setResearchHistoryOpen)
  const researchRuns = useSessionStore(s => s.researchRuns)
  const fetchRuns = useSessionStore(s => s.fetchResearchRuns)
  const fetchCardDetails = useSessionStore(s => s.fetchResearchCardDetails)
  const [filter, setFilter] = useState('')
  const [loadingRun, setLoadingRun] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      fetchRuns()
    }
  }, [open, fetchRuns])

  if (!open) return null

  const query = filter.trim().toLowerCase()
  const filteredRuns = researchRuns.filter(r =>
    !query || r.question.toLowerCase().includes(query) || r.id.toLowerCase().includes(query)
  )

  const handleSelectRun = async (run: ResearchRunSummary) => {
    if (loadingRun) return
    setLoadingRun(run.id)
    setError(null)
    try {
      const snapshot = await openResearchConversation(run.id, run.workspace)
      useSessionStore.getState().bindResearchConversation(snapshot, true)
      useSessionStore.getState().setAgentMode('research')
      useSessionStore.setState({ researchRunId: run.id })
      await fetchCardDetails(run.id)
      setOpen(false)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setLoadingRun(null) }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm p-4 animate-in fade-in duration-200"
      role="dialog"
      aria-label="研究历史记录"
    >
      <div className="relative flex flex-col w-full max-w-2xl max-h-[80vh] rounded-2xl bg-card border border-border-subtle shadow-e3 overflow-hidden text-xs">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle bg-surface-2/60 shrink-0">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-accent" />
            <span className="font-semibold text-text-main text-xs">研究历史记录</span>
            <span className="text-[10px] text-muted">({researchRuns.length})</span>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-3 text-dim hover:text-text-main transition-colors cursor-pointer"
            aria-label="关闭研究历史"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search */}
        <div className="p-3 border-b border-border-subtle/60 bg-surface-1">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-border-subtle bg-surface-2/50">
            <Search className="w-3.5 h-3.5 text-dim shrink-0" />
            <input
              type="text"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="搜索研究课题或编号…"
              className="w-full bg-transparent outline-none text-text-main placeholder-dim text-xs"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {error && <p role="alert" className="text-danger">{error}</p>}
          {filteredRuns.length === 0 ? (
            <div className="py-12 text-center text-dim text-xs">
              <span>未找到匹配的研究记录</span>
            </div>
          ) : (
            filteredRuns.map(run => {
              const isDone = run.status === 'done'
              const isRunning = run.status === 'active' || run.status === 'waiting_input'

              return (
                <button
                  key={run.id}
                  type="button"
                  disabled={Boolean(loadingRun)}
                  onClick={() => handleSelectRun(run)}
                  className="w-full flex items-start justify-between gap-3 p-3 rounded-xl border border-border-subtle bg-surface-1 hover:bg-surface-2 transition-colors text-left cursor-pointer group"
                >
                  <div className="flex items-start gap-2.5 min-w-0">
                    <div className="mt-0.5">
                      {isDone ? (
                        <CheckCircle2 className="w-4 h-4 text-success" />
                      ) : isRunning ? (
                        <Loader2 className="w-4 h-4 text-accent animate-spin" />
                      ) : (
                        <PauseCircle className="w-4 h-4 text-dim" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium text-text-main text-xs group-hover:text-accent transition-colors line-clamp-2">
                        {run.question}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-[10.5px] text-muted font-mono">
                        <span>{run.id}</span>
                        <span>·</span>
                        <span>{researchPhaseLabel(run.phase || run.status)}</span>
                        {run.workspace && (
                          <>
                            <span>·</span>
                            <span className="truncate max-w-[200px]" title={run.workspace}>
                              {run.workspace}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="text-[10px] text-dim shrink-0 font-mono mt-0.5">
                    {run.tasks || 0} 任务
                  </div>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
