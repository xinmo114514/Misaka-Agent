import React, { useEffect, useRef, useState } from 'react'
import { Activity, ArrowUpRight, ChevronDown } from 'lucide-react'
import { useSessionStore } from '../../store/useSessionStore'
import { useResearchActivityStore } from '../../lib/researchActivityStore'
import { openResearchConversation } from '../../lib/startComposerResearch'
import { ResearchStatusBadge } from '../ResearchWorkspace/ResearchStatusBadge'
import { ResearchStopButton } from '../ResearchWorkspace/ResearchStopButton'
import { researchStopPresentation, resolveResearchStopBoard } from '../ResearchWorkspace/researchPresentation'
import { useResearchStopStore } from '../../store/useResearchStopStore'
import { useResearchRunStore } from '../../store/useResearchRunStore'

/**
 * The background research entry that belongs to the sidebar, not to the conversation.
 *
 * A running research is a global activity: it must stay reachable and stoppable while the user
 * reads another session or another research, so it lives beside the session list and only hides
 * when that same run is already on screen.
 */
export const ResearchBackgroundEntry: React.FC = () => {
  const cards = useSessionStore(s => s.researchCards)
  const liveCard = Object.values(cards).find(run => ['active', 'waiting_input', 'stopping'].includes(run.status))
  const stopEntries = useResearchStopStore(s => s.byRun)
  // The board may say stopped before the driver lease rests; keep that run reachable on remount.
  const recoveryCard = Object.values(cards).find(run => run.status === 'stopped' && Boolean(stopEntries[run.runId]))
  const lastRun = useRef<string | null>(null)
  if (liveCard || recoveryCard) lastRun.current = (liveCard || recoveryCard)!.runId
  const card = liveCard ?? recoveryCard ?? (lastRun.current ? cards[lastRun.current] : undefined)
  const stopEntry = card ? stopEntries[card.runId] : undefined
  const boardRun = useResearchRunStore(s => card ? s.runs[card.runId]?.run : undefined)
  const runSummary = useSessionStore(s => s.researchRuns.find(run => run.id === card?.runId))
  const board = resolveResearchStopBoard({ status: card?.status }, boardRun, runSummary)
  const stopView = researchStopPresentation(board.status, stopEntry?.phase, board.stopRequested, board.driving)
  const stopping = stopView === 'pending' || stopView === 'unconfirmed' || stopView === 'failed'
  const presentedLive = stopping || (Boolean(liveCard) && !['stopped', 'done', 'completed', 'closed', 'cancelled', 'canceled', 'partial', 'error', 'failed'].includes(board.status || ''))
  const visible = useSessionStore(s => s.agentMode !== 'research' || s.researchPageView === 'new' || s.researchBinding?.runId !== card?.runId)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  useEffect(() => { generation.current += 1; setError(null); return () => { generation.current += 1 } }, [card?.runId, visible])
  if (!card || !visible) return null
  const owner = Object.values(useSessionStore.getState().researchBindings).find(binding => binding.runId === card?.runId)
  const detail = card ? useResearchActivityStore.getState().details[card.runId] : undefined
  const target = card ? { kind: 'run' as const, runId: card.runId, workspace: card.workspace || owner?.workspace || detail?.run.workspace || '',
    rootSession: detail?.run.rootSession || owner?.sessionFile || '', sessionId: owner?.sessionId,
    sessionFile: owner?.sessionFile, streamId: owner?.streamId } : undefined
  const openRun = async () => {
    const version = useSessionStore.getState().researchPageVersion
    const operation = ++generation.current
    const owns = () => generation.current === operation && useSessionStore.getState().researchPageVersion === version && lastRun.current === card.runId && Boolean(useSessionStore.getState().researchCards[card.runId])
    try {
      const snapshot = await openResearchConversation(card.runId, card.workspace)
      const state = useSessionStore.getState(); state.bindResearchConversation(snapshot)
      if (!owns()) return
      state.setAgentMode('research'); state.selectResearchView({ kind: 'conversation', ownerKey: `conversation:${snapshot.session.sessionId}`, sessionId: snapshot.session.sessionId })
    } catch (failure) { if (owns()) setError(failure instanceof Error ? failure.message : String(failure)) }
  }
  return <section aria-label="后台研究活动" className="mx-2.5 mb-1 rounded-lg border border-border-subtle bg-surface-1">
    <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}
      className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2">
      <Activity className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-text-main">{presentedLive ? '后台研究' : '后台研究已结束'} · {card.question || card.runId}</span>
        <span className="block truncate text-[11px] text-dim">{stopping ? stopView === 'pending' ? '正在停止' : stopView === 'failed' ? '停止失败，请查看原因并重试' : '停止结果待确认，请刷新核对' : presentedLive ? '正在其他会话中继续运行' : '上次研究已结束，可查看结果'}</span>
      </span>
      <ResearchStatusBadge status={board.status || card.status} />
      <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-dim transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
    </button>
    {open && <div className="space-y-1.5 border-t border-border-subtle px-2 py-1.5">
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
        <span>{card.tasks.filter(task => task.status === 'done' || task.status === 'closed').length}/{card.tasks.length} 项任务</span>
        <span>{stopping ? stopView === 'pending' ? '正在停止' : stopView === 'failed' ? '停止失败' : '停止结果待确认' : card.error ? '有错误待查看' : presentedLive ? '运行中' : '已结束'}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void openRun()} className="inline-flex items-center gap-1 text-[11px] text-accent">
          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />返回研究
        </button>
        <button type="button" onClick={() => useSessionStore.getState().setActiveResearchGraphRunId(card.runId)} className="text-[11px] text-accent">查看研究详情</button>
        <span className="ml-auto"><ResearchStopButton runId={card.runId} workspace={target?.workspace}
          status={board.status} driving={board.driving} target={target}
          stopRequested={board.stopRequested}
          stopLabel="停止后台课题"
          nativeConfirmMessage={`确定停止后台课题“${card.question || card.runId}”吗？已完成的卡片和证据将保留。`} /></span>
      </div>
    </div>}
    {card.error && <p role="alert" className="px-2 pb-1.5 text-[11px] text-danger">{card.error}</p>}
    {error && <p role="alert" className="px-2 pb-1.5 text-[11px] text-danger">{error}</p>}
  </section>
}
