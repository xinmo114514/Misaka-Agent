import { Check, Circle, CircleAlert, CircleDot, Pause } from 'lucide-react'
import { researchStatusLabels, researchStatusTone } from './researchPresentation'

export function ResearchStatusBadge({ status }: { status: string }) {
  const tone = researchStatusTone(status)
  const Icon = tone === 'success' ? Check : tone === 'danger' ? CircleAlert : tone === 'active' ? CircleDot : tone === 'warning' ? Pause : Circle
  return <span className={`research-status research-status--${tone}`} title={status}>
    <Icon size={11} aria-hidden="true" /><span>{researchStatusLabels[status] || status}</span>
  </span>
}
