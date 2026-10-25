import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LoaderCircle, RefreshCw, Square } from 'lucide-react'
import { useAnchoredLayer } from '../../lib/useAnchoredLayer'
import { useDismiss } from '../../lib/useDismiss'
import type { ResearchControlTarget } from '../../lib/researchView'
import { useSessionStore } from '../../store/useSessionStore'
import { useResearchRunStore } from '../../store/useResearchRunStore'
import { useResearchStopStore } from '../../store/useResearchStopStore'
import { useResearchActivityStore } from '../../lib/researchActivityStore'
import { researchStopPresentation, resolveResearchStopBoard } from './researchPresentation'

type RunTarget = Extract<ResearchControlTarget, { kind: 'run' }>

/** The same stop/retry affordance in the sidebar, workbench, and timeline. */
export function ResearchStopButton({ runId, workspace, status, stopRequested, driving, target,
  stopLabel = '停止研究', nativeConfirmMessage, confirmationVariant = 'inline' }: {
  runId: string; workspace?: string; status?: string | null; stopRequested?: boolean; driving?: boolean
  target?: RunTarget; stopLabel?: string; nativeConfirmMessage?: string
  confirmationVariant?: 'inline' | 'popover'
}) {
  const [confirmTarget, setConfirmTarget] = useState<RunTarget | null>(null)
  const [refreshFailure, setRefreshFailure] = useState<{ runId: string; message: string } | null>(null)
  const previousRun = useRef(runId)
  const root = useRef<HTMLSpanElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const confirmationAction = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (previousRun.current === runId) return
    previousRun.current = runId
    if (confirmationVariant === 'popover') setConfirmTarget(null)
  }, [runId, confirmationVariant])
  const entry = useResearchStopStore(state => state.byRun[runId])
  const syncError = useResearchActivityStore(state => state.errors[`run:${runId}`] || state.errors.active)
  const listing = useResearchRunStore(state => state.runs[runId]?.run)
  const summary = useSessionStore(state => state.researchRuns.find(run => run.id === runId))
  const board = resolveResearchStopBoard({ status, driving, stopRequested }, listing, summary)
  const view = researchStopPresentation(board.status, entry?.phase, board.stopRequested, board.driving)
  const confirming = confirmTarget?.runId === runId && !nativeConfirmMessage
  const popoverOpen = confirmationVariant === 'popover' && confirming
    && (view === 'ready' || view === 'failed' || view === 'unconfirmed')
  const anchor = useAnchoredLayer(popoverOpen, trigger, 'end')
  useDismiss(popoverOpen, () => {
    // Pointer dismissal precedes the browser's focus transfer. Restore a removed layer's focus,
    // but leave a destination that already received focus (e.g. Tab) alone.
    if (layer.current?.contains(document.activeElement)) trigger.current?.focus()
    setConfirmTarget(null)
  }, [root, layer], trigger)
  useEffect(() => {
    if (confirmationVariant === 'popover' && confirming && !popoverOpen) setConfirmTarget(null)
  }, [confirmationVariant, confirming, popoverOpen])
  useEffect(() => {
    if (popoverOpen && anchor) confirmationAction.current?.focus()
  }, [popoverOpen, anchor])
  const makeTarget = (): RunTarget => {
    if (target) return { ...target }
    const state = useSessionStore.getState()
    const binding = state.researchBinding?.runId === runId ? state.researchBinding : null
    return { kind: 'run', runId, workspace: workspace ?? listing?.workspace ?? summary?.workspace ?? binding?.workspace ?? '',
      rootSession: listing?.rootSession ?? summary?.rootSession ?? undefined,
      sessionId: binding?.sessionId, sessionFile: binding?.sessionFile, streamId: binding?.streamId }
  }
  const beginConfirmation = () => {
    const captured = makeTarget() // Do not let a page switch retarget the confirmation.
    if (nativeConfirmMessage) {
      if (window.confirm(nativeConfirmMessage)) useSessionStore.getState().requestResearchStop(captured)
    } else setConfirmTarget(captured)
  }
  const confirm = () => {
    if (confirmTarget?.runId === runId) useSessionStore.getState().requestResearchStop(confirmTarget)
    setConfirmTarget(null)
  }
  const cancel = () => {
    setConfirmTarget(null)
    if (confirmationVariant === 'popover') trigger.current?.focus()
  }
  const popover = popoverOpen && anchor ? createPortal(
    <div ref={layer} className="research-stop-confirm-popover misaka-glass-popover" role="dialog"
      aria-label="确认停止研究" style={{ left: anchor.left, top: anchor.top, width: anchor.width, maxHeight: anchor.maxHeight }}>
      <p className="research-stop-confirm-message">确定要停止这项研究吗？已完成的卡片成果会保留。</p>
      <div className="research-stop-confirm-actions">
        <button ref={confirmationAction} type="button" className="research-button research-button--danger" onClick={confirm}>确认停止</button>
        <button type="button" className="research-button research-button--subtle" onClick={cancel}>取消</button>
      </div>
    </div>, document.body) : null
  const refresh = <button type="button" className="research-button research-button--subtle"
    onClick={() => {
      setRefreshFailure(null)
      void (async () => {
        try { await useSessionStore.getState().fetchResearchCardDetails(runId) }
        catch (error) { setRefreshFailure({ runId, message: error instanceof Error ? error.message : String(error) }) }
      })()
    }}>
    <RefreshCw size={12} aria-hidden="true" /><span>刷新</span>
  </button>
  const refreshAlert = (refreshFailure?.runId === runId ? refreshFailure.message : syncError)
    ? <span role="alert" className={`research-stop-entry-error${confirmationVariant === 'popover' ? ' research-stop-feedback' : ''}`}
      title={confirmationVariant === 'popover' ? `刷新失败：${refreshFailure?.runId === runId ? refreshFailure.message : syncError}` : undefined}>
      刷新失败：{refreshFailure?.runId === runId ? refreshFailure.message : syncError}</span>
    : null
  if (view === 'hidden') return null
  if (view === 'pending') {
    return <span className="research-stop-entry">
      <span className="research-stop-pending" role="status" aria-live="polite">
        <LoaderCircle className="research-spinner" size={12} aria-hidden="true" /><span>正在停止</span>
      </span>
      {refresh}
      {refreshAlert}
    </span>
  }
  if (view === 'unconfirmed' || view === 'failed') {
    return <><span ref={root} className={`research-stop-entry${confirmationVariant === 'popover' ? ' research-stop-entry--popover' : ''}`}>
      <span className={`${view === 'failed' ? 'research-stop-entry-error' : 'research-stop-unconfirmed'}${confirmationVariant === 'popover' ? ' research-stop-feedback' : ''}`}
        title={confirmationVariant === 'popover' ? entry?.error || '停止结果待确认' : undefined}
        role={view === 'failed' ? 'alert' : 'status'}>{entry?.error || '停止结果待确认'}</span>
      {refresh}
      {refreshAlert}
      {confirming && confirmationVariant === 'inline'
        ? <>
          <button type="button" className="research-button research-button--danger" onClick={confirm}>确认停止</button>
          <button type="button" className="research-button research-button--subtle" onClick={() => setConfirmTarget(null)}>取消</button>
        </>
        : <button ref={trigger} type="button" className="research-button research-button--danger"
          aria-haspopup={confirmationVariant === 'popover' ? 'dialog' : undefined}
          aria-expanded={confirmationVariant === 'popover' ? popoverOpen : undefined}
          onClick={popoverOpen ? cancel : beginConfirmation}>重试停止</button>}
    </span>{popover}</>
  }
  return <><span ref={root} className={`research-stop-entry${confirmationVariant === 'popover' ? ' research-stop-entry--popover' : ''}`}>
    {confirming && confirmationVariant === 'inline'
      ? <>
        <button type="button" className="research-button research-button--danger" onClick={confirm}>
          <Square size={12} aria-hidden="true" /><span>确认停止</span>
        </button>
        <button type="button" className="research-button research-button--subtle" onClick={() => setConfirmTarget(null)}>取消</button>
      </>
      : <button ref={trigger} type="button" className="research-button research-button--subtle"
        aria-haspopup={confirmationVariant === 'popover' ? 'dialog' : undefined}
        aria-expanded={confirmationVariant === 'popover' ? popoverOpen : undefined}
        onClick={popoverOpen ? cancel : beginConfirmation}
        title="停止这项研究（已完成的卡片成果会保留）">
        <Square size={12} aria-hidden="true" /><span>{stopLabel}</span>
      </button>}
  </span>{popover}</>
}
