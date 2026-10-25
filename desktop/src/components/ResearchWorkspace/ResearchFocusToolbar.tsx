import { useEffect, useRef, useState, type ComponentProps } from 'react'
import type { ResearchGraphNode, ResearchSessionsPayload } from '../../types/research'
import { useResearchWorkspaceStore } from '../../store/useResearchWorkspaceStore'
import { useSessionStore } from '../../store/useSessionStore'
import { useResearchActivityStore } from '../../lib/researchActivityStore'
import type { ResearchViewMode } from '../../lib/researchViewMode'
import { ResearchFocusMenu, type FocusChromeActions } from './ResearchFocusMenu'
import { ResearchTeamNavigator } from './ResearchTeamNavigator'
import { ResearchStatusBadge } from './ResearchStatusBadge'
import { ResearchStopButton } from './ResearchStopButton'
import { ResearchResumeButton } from './ResearchResumeButton'
import { ResearchViewSwitch } from './ResearchViewSwitch'
import { resolveMainSession, rootControllerId } from './researchTeam'

/** Own only refresh feedback here; eligibility and the resume request stay in the shared entry. */
function ResearchFocusResumeAction({ refresh, ...props }: ComponentProps<typeof ResearchResumeButton> & { refresh: () => Promise<void> }) {
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null)
  const live = useRef(true)
  const pending = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const refreshDirectly = async () => {
    if (pending.current) return
    pending.current = true
    setFeedback({ error: false, text: '正在刷新…' })
    try { await refresh(); if (live.current) setFeedback(null) }
    catch (cause) { if (live.current) setFeedback({ error: true, text: `刷新失败：${cause instanceof Error ? cause.message : String(cause)}` }) }
    finally { pending.current = false }
  }
  return <>
    <ResearchResumeButton {...props} onRefresh={() => void refreshDirectly()} />
    {feedback && <span className="research-stop-feedback" role={feedback.error ? 'alert' : 'status'} title={feedback.text}>{feedback.text}</span>}
  </>
}

export function ResearchFocusToolbar({ runId, workspace, listing, node, nodeId, mode, onModeChange, onSelectNode, onGraph, onRefresh, chromeActions }: {
  runId: string; workspace: string; listing?: ResearchSessionsPayload; node?: ResearchGraphNode; nodeId: string | null
  mode: ResearchViewMode; onModeChange: (mode: ResearchViewMode) => void
  onSelectNode: (id: string) => void; onGraph: () => void; onRefresh: () => Promise<void>
  chromeActions?: FocusChromeActions
}) {
  const view = useResearchWorkspaceStore(state => state.byRun[runId])
  const summary = useSessionStore(state => state.researchCards[runId])
  const detail = useResearchActivityStore(state => state.details[runId]?.run)
  // A successful explicit detail refresh can resolve old listings that omit driver metadata.
  // Defined listing values remain authoritative; unknown is never converted to false.
  const driving = listing?.run.driving ?? detail?.driving
  const stopRequested = listing?.run.stop_requested ?? detail?.stop_requested
  const awaitingApproval = listing?.run.awaitingApproval ?? detail?.awaitingApproval
  const question = listing?.run.question || summary?.question || '研究对话'
  // Multi navigation follows its selected node and MRU target, never the independent focus reader.
  const local = listing?.sessions.filter(item => item.nodeId === nodeId) ?? []
  const currentId = mode === 'multi'
    ? (local.find(item => item.executorId === view?.focusedExecutorId) ?? local.find(item => item.role === 'last_order') ?? local[0])?.executorId ?? null
    : listing ? resolveMainSession(listing, nodeId, view?.mainExecutorId)?.executorId ?? null : null
  return <header data-research-workspace-toolbar data-research-focus-toolbar={mode === 'focus' || undefined} className="research-focus-toolbar misaka-glass-chrome">
    <h1 className="research-focus-title" title={question}>{question}</h1>
    <div className="research-focus-toolbar-actions">
      {listing ? <ResearchTeamNavigator presentation="focus" listing={listing} currentId={currentId}
        onOpenMain={descriptor => {
          const store = useResearchWorkspaceStore.getState()
          if (mode === 'multi') store.focusExecutor(runId, descriptor)
          else store.setMainExecutor(runId, descriptor.executorId)
        }}
        onOpenSide={mode === 'focus' ? descriptor => useResearchWorkspaceStore.getState().setSideExecutor(runId, descriptor.executorId) : undefined}
        onReturnToMain={() => {
          const store = useResearchWorkspaceStore.getState()
          const rootId = rootControllerId(listing)
          if (mode === 'multi') {
            const root = listing.sessions.find(item => item.executorId === rootId)
            if (root) store.focusExecutor(runId, root)
          } else {
            store.setMainExecutor(runId, rootId)
            store.setSideExecutor(runId, null)
          }
        }} />
        : <button type="button" className="research-team-pill research-team-pill--focus" aria-label="研究团队：读取中" disabled>团队</button>}
      {listing && <ResearchStatusBadge status={listing.run.status} />}
      <ResearchStopButton runId={runId} workspace={workspace} status={listing?.run.status} driving={driving} stopRequested={stopRequested} confirmationVariant="popover" />
      <ResearchFocusResumeAction key={`resume:${runId}`} runId={runId} workspace={workspace} status={listing?.run.status} driving={driving} stopRequested={stopRequested}
        awaitingApproval={awaitingApproval} hideUnavailable refresh={onRefresh} onBound={snapshot => useSessionStore.getState().bindResearchConversation(snapshot)} />
      <ResearchViewSwitch mode={mode} onChange={onModeChange} />
      <ResearchFocusMenu key={`menu:${runId}`} listing={listing} node={node} question={question} processOpen={view?.processOpen ?? false}
        onToggleProcess={() => useResearchWorkspaceStore.getState().setProcessOpen(runId, !view?.processOpen)}
        onSelectNode={onSelectNode} onGraph={onGraph} onRefresh={onRefresh} chromeActions={chromeActions} />
    </div>
  </header>
}
