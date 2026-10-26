import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { researchSessionsBridge } from '../../lib/researchSessionsBridge'
import { useResearchRunStore } from '../../store/useResearchRunStore'
import { useResearchWorkspaceStore } from '../../store/useResearchWorkspaceStore'
import { readResearchViewMode, saveResearchViewMode, type ResearchViewMode } from '../../lib/researchViewMode'
import type { ResearchSessionDescriptor } from '../../types/research'
import { ResearchAgentPane } from './ResearchAgentPane'
import { ResearchStoppedBanner } from './ResearchStoppedBanner'
import { ResearchApprovalCards } from './ResearchApprovalCard'
import { ResearchLastOrderOverview } from './ResearchLastOrderOverview'
import { ResearchInterruptedBanner } from './ResearchInterruptedBanner'
import { ResearchFocusView } from './ResearchFocusView'
import { ResearchFocusToolbar } from './ResearchFocusToolbar'
import { ResearchRunPanel } from './ResearchRunPanel'
import { MultiPaneFrame } from './MultiPaneFrame'
import type { FocusChromeActions } from './ResearchFocusMenu'
import { resolveMainSession, resolveResearchNodeId } from './researchTeam'
import { selectResearchMultiSessions } from '../../lib/researchMultiLayout'
import { useResearchMosaicSizing } from './useResearchMosaicSizing'
import { normalizeWorkspacePath, useSessionStore } from '../../store/useSessionStore'
import { useResearchActivityStore } from '../../lib/researchActivityStore'
import { useMultiHistory } from './useMultiHistory'

/**
 * The research workspace.
 *
 * It owns loading, the visible subscription set and the layout. The layout choice arrives from the
 * page, because the header pill, the transcript and the composer must agree on it: focus is the
 * ordinary chat reading surface, multi is the tile grid with its compact composer.
 */
interface ResearchTilingWorkspaceProps {
  runId: string
  workspace: string
  /** Lifted so the page header and the composer can share the choice; standalone renders read it. */
  mode?: ResearchViewMode
  onModeChange?: (mode: ResearchViewMode) => void
  chromeActions?: FocusChromeActions
}

export function ResearchTilingWorkspace(props: ResearchTilingWorkspaceProps) {
  return <OwnedResearchTilingWorkspace key={JSON.stringify([props.runId, normalizeWorkspacePath(props.workspace)])} {...props} />
}

function OwnedResearchTilingWorkspace({ runId, workspace, mode: controlledMode, onModeChange, chromeActions }: ResearchTilingWorkspaceProps) {
  const cachedListing = useResearchRunStore(s => s.runs[runId])
  const listing = cachedListing && normalizeWorkspacePath(cachedListing.run.workspace) === normalizeWorkspacePath(workspace) ? cachedListing : undefined
  const view = useResearchWorkspaceStore(s => s.byRun[runId])
  const focus = useResearchWorkspaceStore(s => s.focusExecutor)
  const selectNode = useResearchWorkspaceStore(s => s.selectNode)
  const setViewMode = useResearchWorkspaceStore(s => s.setViewMode)
  const setExpanded = useResearchWorkspaceStore(s => s.setExpandedExecutor)
  const live = useRef(true)
  const loadEpoch = useRef(0)
  const watchEpoch = useRef(0)
  const retryEpoch = useRef(0)
  const [loadError, setLoadError] = useState('')
  const [watchFailure, setWatchFailure] = useState<{ key: string; message: string } | null>(null)
  useEffect(() => {
    live.current = true
    return () => { live.current = false; ++loadEpoch.current; ++watchEpoch.current; ++retryEpoch.current }
  }, [])
  // Default is the focus view; the user's last choice is remembered across sessions.
  const mode = controlledMode ?? view?.viewMode ?? readResearchViewMode()
  const switchMode = (next: ResearchViewMode) => {
    saveResearchViewMode(next)
    setViewMode(runId, next)
    onModeChange?.(next)
  }
  const refresh = async (propagateError = false) => {
    if (!live.current) return
    const epoch = ++loadEpoch.current
    try {
      await researchSessionsBridge.load(runId, workspace)
      if (live.current && loadEpoch.current === epoch) setLoadError('')
    } catch (error) {
      if (live.current && loadEpoch.current === epoch) setLoadError(String(error))
      if (propagateError) throw error
    }
  }
  useEffect(() => {
    void refresh()
  }, [runId, workspace])
  const nodeId = resolveResearchNodeId(listing, view?.selectedNodeId)
  const visible = useMemo(() => selectResearchMultiSessions(listing, nodeId, view?.focusedExecutorId, view?.pinnedExecutorIds ?? []),
    [listing, nodeId, view?.focusedExecutorId, view?.pinnedExecutorIds])
  const lo = visible.find(item => item.role === 'last_order')
  const sisters = visible.filter(item => item.role !== 'last_order')
  const sizing = useResearchMosaicSizing(sisters.length, Boolean(lo), Boolean(listing) && mode === 'multi', JSON.stringify([runId, nodeId]))
  // What is actually readable right now: the two focus transcripts, or the visible panes. Nothing
  // else is subscribed, so expanding the directory never starts loading chats nobody reads.
  const shown = useMemo(() => {
    if (!listing) return [] as ResearchSessionDescriptor[]
    if (mode === 'focus') {
      const main = resolveMainSession(listing, nodeId, view?.mainExecutorId)
      const side = view?.sideExecutorId ? listing.sessions.find(item => item.executorId === view.sideExecutorId) : undefined
      const wanted = [main, side].filter((item): item is ResearchSessionDescriptor => Boolean(item))
      return wanted.filter((item, index) => wanted.findIndex(other => other.executorId === item.executorId) === index)
    }
    return visible
  }, [listing, mode, nodeId, view?.mainExecutorId, view?.sideExecutorId, visible])
  const visibleIds = useMemo(() => shown.map(item => item.executorId), [shown])
  const ids = JSON.stringify(visibleIds)
  const currentIds = useRef(ids)
  currentIds.current = ids
  const watchError = watchFailure?.key === ids ? watchFailure.message : ''
  const history = useMultiHistory(runId, workspace, shown, Boolean(listing) && mode === 'multi')
  const historyError = history.error
  useEffect(() => {
    const epoch = ++watchEpoch.current
    if (!listing) return
    return researchSessionsBridge.retainVisible(runId, visibleIds, workspace, error => {
      if (live.current && watchEpoch.current === epoch && currentIds.current === ids) {
        setWatchFailure(error == null ? null : { key: ids, message: String(error) })
      }
    })
  }, [runId, workspace, ids, listing?.runId])
  const retryWatch = async () => {
    const epoch = ++retryEpoch.current
    try {
      await researchSessionsBridge.watch(runId, visibleIds, workspace)
      if (live.current && retryEpoch.current === epoch && currentIds.current === ids) setWatchFailure(null)
    } catch (error) {
      if (live.current && retryEpoch.current === epoch && currentIds.current === ids) setWatchFailure({ key: ids, message: String(error) })
    }
  }
  const toolbar = <ResearchFocusToolbar runId={runId} workspace={workspace} listing={listing}
    node={listing?.graph.nodes.find(item => item.id === nodeId)} nodeId={nodeId}
    mode={mode} onModeChange={switchMode} onSelectNode={id => {
      if (mode === 'focus') useResearchWorkspaceStore.getState().selectFocusNode(runId, id)
      else selectNode(runId, id)
    }}
    onGraph={() => useSessionStore.getState().setActiveResearchGraphRunId(runId)}
    onRefresh={async () => {
      await useSessionStore.getState().fetchResearchCardDetails(runId)
      if (!live.current) return
      await refresh(true)
      if (!live.current) return
      // The shared activity service settles polling failures into state rather than rejecting.
      const detailError = useResearchActivityStore.getState().errors[`run:${runId}`]
      if (detailError) throw new Error(detailError)
    }} chromeActions={chromeActions} />
  if (!listing) return <div className="research-tiling-container flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-research-view-mode={mode}>
    {toolbar}
    <div role="status" className="p-4 text-xs text-muted">{loadError ? <><span role="alert">{loadError}</span><button type="button" className="ml-2 text-accent underline" onClick={() => void refresh()}>重试读取</button></> : '读取研究会话…'}</div>
  </div>
  const node = listing.graph.nodes.find(item => item.id === nodeId)
  const rootNodeId = (listing.graph.nodes.find(item => item.kind === 'root') ?? listing.graph.nodes[0])?.id
  const reconciliation = listing.graph.reconciles?.find(item => !item.applied)
  const suspension = listing.suspension ?? listing.suspensions.find(item => item.scope === 'node' && item.nodeId === nodeId && !item.resolvedAt)
  const expandedId = view?.expandedExecutorId
  const alert = (loadError || watchError || historyError) && <div role="alert" className="research-load-alert">
    {loadError && <p>{loadError}</p>}{watchError && <p>{watchError}</p>}{historyError && <p>{historyError}</p>}
    <button type="button" onClick={() => {
      if (loadError) void refresh()
      if (watchError) void retryWatch()
      if (historyError) history.retry()
    }}>重试</button></div>
  return <div ref={sizing.workspaceRef} className="research-tiling-container flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-research-tiling-workspace={runId} data-research-view-mode={mode}>
      {toolbar}
      {alert}
      {suspension && <ResearchStoppedBanner suspension={suspension} runStatus={listing.run.status} workspace={workspace} sessions={listing.sessions} onFocus={item => {
        // 查看失败详情 opens that failure in the main area; it must not depend on the node list.
        if (mode === 'focus') useResearchWorkspaceStore.getState().setMainExecutor(runId, item.executorId)
        else focus(runId, item)
      }} driving={listing.run.driving} awaitingApproval={listing.run.awaitingApproval} />}
      <ResearchApprovalCards runId={runId} workspace={workspace}
        enabled={Boolean(node) && (node?.status === 'awaiting_approval' || listing.run.status === 'waiting_input'
          || Boolean(reconciliation))}
        revision={`${node?.plan_tool_call_id ?? ''}:${node?.plan_round ?? ''}:${listing.run.status}:${reconciliation?.round ?? ''}`} />
      <ResearchInterruptedBanner status={listing.run.status} driving={listing.run.driving}
        stopRequested={listing.run.stop_requested} awaitingApproval={listing.run.awaitingApproval} />
      {mode === 'focus' ? <ResearchFocusView runId={runId} workspace={workspace} listing={listing} nodeId={nodeId} /> : <>
      {view?.processOpen && <ResearchRunPanel runId={runId} workspace={workspace} listing={listing}
        onClose={() => useResearchWorkspaceStore.getState().setProcessOpen(runId, false)} />}
      <div ref={sizing.layoutRef} className="research-multi-layout" data-research-multi-layout data-has-controller={Boolean(lo)} data-member-count={sisters.length}
        data-solo-controller={sizing.mosaic.soloController} data-row-count={sizing.mosaic.rowCount} data-tiny-height={sizing.tinyHeight}
        style={{ '--research-mosaic-row-cap': `${sizing.rowCap}px` } as CSSProperties} onScroll={sizing.onScroll}>
        {lo && <MultiPaneFrame key={lo.executorId} executorId={lo.executorId} label={lo.label}
          style={{ gridColumn: `span ${sizing.mosaic.spans[0]}` }}
          className="research-multi-controller" expanded={expandedId === lo.executorId} onClose={() => setExpanded(runId, null)}>
          <ResearchAgentPane runId={runId} descriptor={lo} focused={view?.focusedExecutorId === lo.executorId} onFocus={() => focus(runId, lo)}
            isRootController={lo.nodeId === rootNodeId} expanded={expandedId === lo.executorId}
            onToggleExpanded={() => setExpanded(runId, expandedId === lo.executorId ? null : lo.executorId)}
            overview={node ? <ResearchLastOrderOverview runId={runId} workspace={workspace} node={node} /> : null} />
        </MultiPaneFrame>}
        {sisters.length > 0 && <div className="research-multi-task-grid" data-research-task-grid>
          {sisters.map((item, index) => <MultiPaneFrame key={item.executorId} executorId={item.executorId} label={item.cardTitle || item.label}
            style={{ gridColumn: `span ${sizing.mosaic.spans[index + (lo ? 1 : 0)]}` }}
            expanded={expandedId === item.executorId} onClose={() => setExpanded(runId, null)}>
            <ResearchAgentPane runId={runId} descriptor={item} focused={view?.focusedExecutorId === item.executorId} onFocus={() => focus(runId, item)}
              expanded={expandedId === item.executorId} onToggleExpanded={() => setExpanded(runId, expandedId === item.executorId ? null : item.executorId)} />
          </MultiPaneFrame>)}
        </div>}
        {lo && !sisters.length && <p className="research-multi-empty-note" role="status">当前节点暂无成员会话</p>}
        {!lo && !sisters.length && <p className="research-multi-empty-note" role="status">当前节点还没有可查看的会话。</p>}
      </div>
    </>}
  </div>
}
