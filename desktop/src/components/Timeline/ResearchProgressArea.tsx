import React from 'react'
import { useSessionStore } from '../../store/useSessionStore'
import { useResearchActivityStore } from '../../lib/researchActivityStore'
import { describeResearchProgress } from '../../lib/researchProgress'

/** Remains visible when the task list is collapsed, including native-host idle periods. */
export const ResearchProgressArea: React.FC<{runId:string}> = ({runId}) => {
 const card = useSessionStore(s=>s.researchCards[runId])
 const snapshot = useSessionStore(s=>Object.values(s.researchSnapshots).find(host=>host.run?.id === runId))
 const now=useResearchActivityStore(s=>s.now)
 const error=useResearchActivityStore(s=>s.errors[`run:${runId}`] || s.errors.active)
 const success=useResearchActivityStore(s=>s.lastSuccess[`run:${runId}`] || s.lastSuccess.active)
 const progress=describeResearchProgress({card,startedAt:card?.startedAt,lastActivityAt:card?.lastActivityAt,now,deliveryState:snapshot?.reportDelivery?.state ?? card?.reportDelivery?.state})
 return <section aria-label="研究持续进度" className="border-t border-border-subtle px-3.5 py-2 text-[11px] text-muted space-y-1">
   <div className="flex flex-wrap gap-x-3 gap-y-1"><span className="font-medium text-text-main">{progress.label}</span><span>已完成 {progress.completed}/{progress.total} · 运行 {progress.running} · 失败 {progress.failed}</span></div>
   {progress.instruction && <p>{progress.instruction}</p>}
   <p>{progress.elapsed ? `运行时长 ${progress.elapsed}` : '运行时长待同步'} · {progress.lastActivity ? `最近活动 ${progress.lastActivity}` : '最近活动待同步'}</p>
   {progress.quietWarning && <p className="text-warning">{progress.quietWarning}</p>}
   {error && <p role="alert" className="text-warning">同步错误：{error} · {success ? `最后成功同步 ${new Date(success).toLocaleTimeString()}` : '尚无成功同步记录'}</p>}
 </section>
}
