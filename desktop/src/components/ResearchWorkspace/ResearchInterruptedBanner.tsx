import { AlertTriangle } from 'lucide-react'

/**
 * The interruption banner.
 *
 * It only ever states that the run was interrupted and points at the single 恢复研究 entry in the
 * run header; it never renders a second control, so two views can never disagree about it. A
 * pending approval keeps the run `active` without a live driver, which is a wait, not an
 * interruption, so that state stays silent here.
 */
export function ResearchInterruptedBanner({ status, driving, stopRequested, awaitingApproval }: {
  status?: string | null
  driving?: boolean
  stopRequested?: boolean
  awaitingApproval?: boolean
}) {
  const value = (status || '').toLowerCase()
  if (driving !== false || stopRequested) return null
  // A stopped/failed run has its own stop record; a pending approval is a wait, not an interruption.
  if (value !== 'active' || awaitingApproval) return null
  return <aside className="research-interrupted-banner" role="status" aria-label="研究执行已中断">
    <AlertTriangle size={14} aria-hidden="true" />
    <div>
      <strong>研究执行已中断，可恢复</strong>
      <p>点右上角「恢复研究」从上次中断处继续，不会新建课题。</p>
    </div>
  </aside>
}
