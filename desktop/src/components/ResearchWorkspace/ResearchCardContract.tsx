import { FileKey2 } from 'lucide-react'

export function ResearchCardContract({ contract }: { contract?: string | null }) {
  return contract ? <details className="research-card-contract">
    <summary><FileKey2 size={12} aria-hidden="true" /><span>任务说明</span></summary>
    <p>{contract}</p>
  </details> : null
}
