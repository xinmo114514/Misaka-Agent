import React, { useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Loader2,
  Quote,
  Terminal,
  X,
} from 'lucide-react'
import { useSessionStore } from '../../store/useSessionStore'
import { request } from '../../lib/bridge'
import type { ResearchArtifactDetail, ResearchTaskDetail } from '../../types/research'
import { MarkdownContent } from './MarkdownContent'

export const ResearchTaskDrawer: React.FC = () => {
  const activeTask = useSessionStore(s => s.activeResearchTaskId)
  const setActiveTask = useSessionStore(s => s.setActiveResearchTask)
  const currentWorkspace = useSessionStore(s => s.currentWorkspace)
  const researchCard = useSessionStore(s => activeTask ? s.researchCards[activeTask.runId] : undefined)

  const [detail, setDetail] = useState<ResearchTaskDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedArtifact, setSelectedArtifact] = useState<ResearchArtifactDetail | null>(null)
  const [showLogs, setShowLogs] = useState(false)

  useEffect(() => {
    if (!activeTask) {
      setDetail(null)
      setSelectedArtifact(null)
      return
    }

    let live = true
    setLoading(true)
    setError(null)
    setDetail(null)
    setSelectedArtifact(null)
    setShowLogs(false)
    const workspace = researchCard?.workspace || currentWorkspace

    void request<{ detail: ResearchTaskDetail }>('get_research_task', {
      runId: activeTask.runId,
      taskId: activeTask.taskId,
      workspace,
    })
      .then(res => {
        if (!live) return
        if (res.detail) {
          setDetail(res.detail)
        } else {
          setError('未找到任务详情')
        }
      })
      .catch(err => {
        if (!live) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (live) setLoading(false)
      })

    return () => {
      live = false
    }
  }, [activeTask, currentWorkspace, researchCard?.workspace])

  if (!activeTask) return null

  const isClosed = detail?.status === 'closed' || detail?.status === 'done'
  const isRunning = detail?.status === 'running'

  return (
    <div
      className="flex h-full w-[380px] flex-col border-l border-border-subtle bg-card text-xs select-none shadow-e3 animate-in slide-in-from-right duration-200"
      data-testid="research-task-drawer"
    >
      {/* Drawer Header */}
      <div className="flex items-center justify-between border-b border-border-subtle bg-surface-2/60 px-4 py-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center justify-center w-6 h-6 rounded-lg bg-surface-3 text-text-main shrink-0">
            {isClosed ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-success" />
            ) : isRunning ? (
              <Loader2 className="w-3.5 h-3.5 text-accent animate-spin" />
            ) : (
              <Clock className="w-3.5 h-3.5 text-dim" />
            )}
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold text-text-main text-xs truncate">
              {detail?.title || '任务详情'}
            </h2>
            <div className="text-[10px] text-muted font-mono flex items-center gap-1.5">
              <span>Sister {detail?.assignee || '专家'}</span>
              {detail?.round !== undefined && <span>· 第 {detail.round} 轮</span>}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setActiveTask(null)}
          aria-label="关闭任务抽屉"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-dim hover:bg-surface-3 hover:text-text-main transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Drawer Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading && (
          <div className="py-8 text-center text-dim text-xs">
            <Loader2 className="w-4 h-4 animate-spin mx-auto mb-2 text-accent" />
            <span>正在加载任务详情…</span>
          </div>
        )}

        {error && (
          <div className="p-3 rounded-xl bg-danger-surface border border-danger-border text-danger text-xs flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {detail && (
          <>
            {/* Task Objective */}
            <div className="p-3 rounded-xl bg-surface-2/40 border border-border-subtle space-y-1.5">
              <span className="text-[10.5px] font-semibold text-muted uppercase tracking-wider block">
                任务目标与指示
              </span>
              <p className="text-[12px] leading-relaxed text-text-main whitespace-pre-wrap">
                {detail.body || '无详细目标描述'}
              </p>
            </div>

            {/* Artifacts Produced */}
            {detail.artifacts && detail.artifacts.length > 0 && (
              <div className="space-y-2">
                <span className="text-[10.5px] font-semibold text-muted uppercase tracking-wider block">
                  产出文件 ({detail.artifacts.length})
                </span>
                <div className="space-y-1.5">
                  {detail.artifacts.map(artifact => (
                    <div
                      key={artifact.id}
                      className="p-2.5 rounded-xl border border-border-subtle bg-surface-1 hover:bg-surface-2 transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText className="w-3.5 h-3.5 text-accent shrink-0" />
                          <span className="font-medium text-text-main truncate text-xs">
                            {artifact.title || artifact.path}
                          </span>
                        </div>
                        {artifact.content && (
                          <button
                            type="button"
                            onClick={() => setSelectedArtifact(selectedArtifact?.id === artifact.id ? null : artifact)}
                            className="text-[10.5px] text-accent hover:underline shrink-0"
                          >
                            {selectedArtifact?.id === artifact.id ? '收起' : '查看'}
                          </button>
                        )}
                      </div>
                      {selectedArtifact?.id === artifact.id && artifact.content && (
                        <div className="mt-2.5 pt-2.5 border-t border-border-subtle text-[11.5px] max-h-48 overflow-y-auto">
                          <MarkdownContent content={artifact.content} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Findings & Citations */}
            {detail.findings && detail.findings.length > 0 && (
              <div className="space-y-2">
                <span className="text-[10.5px] font-semibold text-muted uppercase tracking-wider block">
                  证据与核心发现 ({detail.findings.length})
                </span>
                <div className="space-y-2">
                  {detail.findings.map(finding => (
                    <div
                      key={finding.id}
                      className="p-3 rounded-xl border border-border-subtle bg-surface-1 space-y-2"
                    >
                      <p className="text-[12px] leading-relaxed text-text-main font-medium">
                        {finding.text}
                      </p>
                      {finding.citations && finding.citations.length > 0 && (
                        <div className="space-y-1 pt-1 border-t border-border-subtle/60">
                          {finding.citations.map((cite, cIdx) => (
                            <div key={cIdx} className="text-[10.5px] text-muted flex items-start gap-1.5">
                              <Quote className="w-3 h-3 text-accent shrink-0 mt-0.5" />
                              <span className="italic">“{cite.quote}”</span>
                              {cite.source_file && (
                                <span className="font-mono text-[10px] text-dim ml-auto shrink-0">
                                  ({cite.source_file})
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Execution / Tool Transcript (Accordion) */}
            <div className="border border-border-subtle rounded-xl overflow-hidden bg-surface-1">
              <button
                type="button"
                onClick={() => setShowLogs(prev => !prev)}
                className="w-full flex items-center justify-between p-3 text-left hover:bg-surface-2 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <Terminal className="w-3.5 h-3.5 text-dim" />
                  <span className="font-medium text-text-main text-xs">执行记录与工具调用</span>
                </div>
                {showLogs ? <ChevronDown className="w-3.5 h-3.5 text-dim" /> : <ChevronRight className="w-3.5 h-3.5 text-dim" />}
              </button>

              {showLogs && (
                <div className="p-3 border-t border-border-subtle bg-surface-2/40 text-[11px] text-muted font-mono leading-relaxed max-h-48 overflow-y-auto">
                  <div>该任务当前没有可展示的执行记录。任务产出和证据见上方详情。</div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
