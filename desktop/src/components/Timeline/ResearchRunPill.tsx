import React, { useEffect, useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Loader2,
  Network,
  PauseCircle,
  RefreshCw,
  RotateCcw,
  Square,
  Users,
} from 'lucide-react'
import { useSessionStore } from '../../store/useSessionStore'
import { executeResearchControl } from '../../lib/researchBridge'
import { researchPhaseLabel } from '../../lib/researchStatus'
import type { ResearchTaskSummary } from '../../types/research'
import { newRequestId } from '../../lib/bridge'
import { openResearchConversation, startComposerResearch } from '../../lib/startComposerResearch'
import { DesktopResearchTeam } from './DesktopResearchTeam'

interface ResearchRunPillProps {
  runId: string
  defaultExpanded?: boolean
}

function taskStatusIcon(status: string) {
  if (status === 'closed' || status === 'done') {
    return <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
  }
  if (status === 'error' || status === 'failed') {
    return <AlertCircle className="w-3.5 h-3.5 text-danger shrink-0" />
  }
  if (status === 'running') {
    return <Loader2 className="w-3.5 h-3.5 text-accent animate-spin shrink-0" />
  }
  return <Clock className="w-3.5 h-3.5 text-dim shrink-0" />
}

export const ResearchRunPill: React.FC<ResearchRunPillProps> = ({ runId, defaultExpanded = false }) => {
  const card = useSessionStore(s => s.researchCards[runId])
  const runSummary = useSessionStore(s => s.researchRuns.find(r => r.id === runId))
  const fetchCardDetails = useSessionStore(s => s.fetchResearchCardDetails)
  const setActiveResearchTask = useSessionStore(s => s.setActiveResearchTask)
  const setActiveResearchGraphRunId = useSessionStore(s => s.setActiveResearchGraphRunId)
  const hasBoundTeam = useSessionStore(s => s.researchBinding?.runId === runId && Boolean(s.researchTeam))

  const isWaitingInput = card?.status === 'waiting_input'
  const isError = card?.status === 'error' || card?.status === 'failed' || Boolean(card?.error)
  const isDone = card?.status === 'done'
  const isStopped = card?.status === 'stopped' || card?.status === 'partial' || card?.status === 'cancelled'
  const isActive = !isDone && !isStopped && !isError

  const [expanded, setExpanded] = useState(defaultExpanded || isWaitingInput || isError)
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmedEnd, setConfirmedEnd] = useState(false)
  const canEndForRetention = card?.status === 'failed' || card?.status === 'stopped'

  useEffect(() => { setConfirmedEnd(false) }, [runId, card?.status])

  useEffect(() => {
    void fetchCardDetails(runId)
    const timer = window.setInterval(() => void fetchCardDetails(runId), 4000)
    return () => window.clearInterval(timer)
  }, [runId, fetchCardDetails])

  useEffect(() => {
    if (isWaitingInput || isError) {
      setExpanded(true)
    }
  }, [isWaitingInput, isError])

  const tasks: ResearchTaskSummary[] = card?.tasks || []
  const completedTasks = tasks.filter(t => t.status === 'closed' || t.status === 'done').length
  const totalTasks = tasks.length

  const handleToggle = () => {
    setExpanded(prev => !prev)
  }

  const handleAnswerClarification = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!answer.trim()) return
    setBusy(true)
    setActionError(null)
    try {
      const state = useSessionStore.getState()
      if (state.researchBinding?.runId !== runId) {
        state.bindResearchConversation(await openResearchConversation(runId, card?.workspace || runSummary?.workspace))
      }
      const binding = useSessionStore.getState().researchBinding!
      const requestId = newRequestId('research_input')
      const host = await startComposerResearch({ question: answer.trim(), workspace: binding.workspace, binding, requestId,
        onBound: snapshot => { state.bindResearchConversation(snapshot); state.queueResearchMessage(requestId, answer.trim()) },
        onAccepted: () => state.acceptResearchMessage(requestId),
      })
      state.bindResearchConversation(host)
      setAnswer('')
      await fetchCardDetails(runId)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleStop = async () => {
    setBusy(true)
    setActionError(null)
    try {
      await executeResearchControl('stop_research', {
        runId,
        workspace: card?.workspace || runSummary?.workspace,
      })
      await fetchCardDetails(runId)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleResume = async () => {
    setBusy(true)
    setActionError(null)
    try {
      await executeResearchControl('resume_research', {
        runId,
        workspace: card?.workspace || runSummary?.workspace,
      })
      await fetchCardDetails(runId)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="my-3 rounded-2xl border border-border-subtle bg-surface-1/90 shadow-sm transition-all overflow-hidden"
      data-testid="research-run-pill"
      data-run-id={runId}
    >
      {/* Top Capsule Bar */}
      <div
        className="flex items-center justify-between px-3.5 py-2.5 cursor-pointer hover:bg-surface-2/60 transition-colors select-none"
        onClick={handleToggle}
        role="button"
        aria-expanded={expanded}
        aria-label={expanded ? '收起研究过程' : '展开研究过程'}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex items-center justify-center w-6 h-6 rounded-lg bg-surface-2 shrink-0">
            {isDone ? (
              <CheckCircle2 className="w-4 h-4 text-success" />
            ) : isWaitingInput ? (
              <AlertTriangle className="w-4 h-4 text-warning" />
            ) : isError ? (
              <AlertCircle className="w-4 h-4 text-danger" />
            ) : isStopped ? (
              <PauseCircle className="w-4 h-4 text-dim" />
            ) : (
              <Loader2 className="w-4 h-4 text-accent animate-spin" />
            )}
          </div>

          <div className="min-w-0 flex items-center gap-2">
            <span className="text-xs font-semibold text-text-main truncate">
              {isDone
                ? '研究已完成 · 查看全部分析过程'
                : isWaitingInput
                ? '研究等待澄清 · 需要你的确认'
                : isError
                ? '研究中断 · 点击查看详情'
                : isStopped
                ? '研究已暂停'
                : `正在进行研究 · ${researchPhaseLabel(card?.phase || card?.stage || '多节点协同')}`}
            </span>

            {card?.question && (
              <span className="hidden sm:inline-block text-[11px] text-dim max-w-xs truncate" title={card.question}>
                · {card.question}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs shrink-0">
          {totalTasks > 0 ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-2 text-[10.5px] font-mono text-muted">
              <Users className="w-3 h-3 text-dim" />
              {completedTasks}/{totalTasks} 项任务
            </span>
          ) : (
            <span className="text-[10.5px] text-dim font-mono">多 Agent 协同</span>
          )}

          <div className="text-dim hover:text-text-main p-0.5">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </div>
        </div>
      </div>

      {/* Expanded View */}
      {expanded && (
        <div className="px-4 pb-3.5 pt-1 border-t border-border-subtle/60 space-y-3 text-xs">
          {/* Clarification prompt if waiting input */}
          {isWaitingInput && (
            <div className="p-3 rounded-xl bg-warning-surface/60 border border-warning-border space-y-2">
              <div className="flex items-center gap-1.5 font-medium text-warning text-xs">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>研究需要你进一步澄清以下问题：</span>
              </div>
              {card?.pendingQuestions && card.pendingQuestions.length > 0 && (
                <ul className="list-disc list-inside space-y-1 text-text-main text-[11.5px] leading-relaxed">
                  {card.pendingQuestions.map((q, idx) => (
                    <li key={idx}>{q}</li>
                  ))}
                </ul>
              )}
              <form onSubmit={handleAnswerClarification} className="flex gap-2 pt-1">
                <input
                  type="text"
                  aria-label="澄清回答"
                  value={answer}
                  onChange={e => setAnswer(e.target.value)}
                  placeholder="输入你的澄清答复并提交…"
                  disabled={busy}
                  className="flex-1 rounded-lg border border-border-subtle bg-surface-1 px-3 py-1.5 text-xs text-text-main outline-none focus:border-accent"
                />
                <button
                  type="submit"
                  disabled={busy || !answer.trim()}
                  className="px-3 py-1.5 rounded-lg bg-accent text-on-accent font-medium text-xs hover:brightness-105 disabled:opacity-50 transition-all cursor-pointer"
                >
                  {busy ? '正在提交…' : '提交回答'}
                </button>
              </form>
            </div>
          )}

          {/* Error notice if failed */}
          {isError && (
            <div className="p-3 rounded-xl bg-danger-surface border border-danger-border text-danger space-y-2">
              <div className="flex items-center gap-1.5 font-semibold text-xs">
                <AlertCircle className="w-3.5 h-3.5" />
                <span>研究遇到错误暂停</span>
              </div>
              <p className="text-[11.5px] leading-relaxed">{card?.error || '未知错误'}</p>
              <button
                type="button"
                onClick={handleResume}
                disabled={busy}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-accent text-on-accent text-xs font-medium cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                重试/恢复
              </button>
            </div>
          )}

          {actionError && (
            <p className="text-xs text-danger" role="alert">
              操作失败：{actionError}
            </p>
          )}

          {/* Multi-Agent Tasks List */}
          {hasBoundTeam && canEndForRetention && !confirmedEnd && <div className="space-y-1.5">
            <button type="button" disabled={busy} onClick={() => setConfirmedEnd(true)}
              className="rounded-lg border border-border-subtle px-3 py-1.5 text-[11px] text-text-main disabled:opacity-50">
              结束本次研究并选择保留角色
            </button>
            <p className="text-[10px] text-dim">保留全部研究与恢复资料；下一步仅保存你勾选并确认的角色。</p>
          </div>}
          <DesktopResearchTeam runId={runId} done={isDone || (canEndForRetention && confirmedEnd)} />
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] font-medium text-dim px-0.5">
              <span>协同任务与专家分工</span>
              <span>{tasks.length} 个任务</span>
            </div>

            {tasks.length === 0 ? (
              <div className="py-4 text-center text-dim text-[11.5px] bg-surface-2/40 rounded-xl">
                <Loader2 className="w-4 h-4 animate-spin mx-auto mb-1 text-accent" />
                <span>正在根据课题规划研究节点与分工…</span>
              </div>
            ) : (
              <div className="space-y-1.5 max-h-64 overflow-y-auto pr-0.5">
                {tasks.map(task => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => setActiveResearchTask({ runId, taskId: task.id })}
                    aria-label={`查看任务 ${task.title}`}
                    className="w-full flex items-center justify-between gap-3 p-2.5 rounded-xl border border-border-subtle/80 bg-surface-2/40 hover:bg-surface-2 hover:border-border transition-colors text-left cursor-pointer group"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {taskStatusIcon(task.status)}
                      <div className="min-w-0">
                        <div className="font-medium text-text-main text-xs truncate group-hover:text-accent transition-colors">
                          {task.title}
                        </div>
                        {task.summary && (
                          <div className="text-[10.5px] text-muted truncate max-w-sm mt-0.5">
                            {task.summary}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className="px-2 py-0.5 rounded-md bg-surface-3/70 text-[10px] text-muted font-mono">
                        Sister {task.assignee}
                      </span>
                      <ChevronRight className="w-3.5 h-3.5 text-dim group-hover:text-text-main transition-colors" />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Actions Bar */}
          <div className="flex items-center justify-between pt-2 border-t border-border-subtle/50 text-xs">
            <button
              type="button"
              onClick={() => setActiveResearchGraphRunId(runId)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border-subtle bg-surface-2/60 hover:bg-surface-2 text-text-main text-[11px] font-medium transition-colors cursor-pointer"
            >
              <Network className="w-3.5 h-3.5 text-accent" />
              <span>查看研究拓扑图</span>
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void fetchCardDetails(runId)}
                className="p-1.5 rounded-lg text-dim hover:text-text-main hover:bg-surface-2 transition-colors cursor-pointer"
                title="刷新任务进度"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>

              {isActive && (
                <button
                  type="button"
                  onClick={handleStop}
                  disabled={busy}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-danger-border text-danger hover:bg-danger-surface text-[11px] transition-colors cursor-pointer disabled:opacity-50"
                >
                  <Square className="w-3 h-3" />
                  <span>停止研究</span>
                </button>
              )}

              {isStopped && (
                <button
                  type="button"
                  onClick={handleResume}
                  disabled={busy}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-accent text-on-accent text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-50"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>恢复研究</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
