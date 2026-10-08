import { useEffect, useState } from 'react'
import { Users } from 'lucide-react'
import { useSessionStore } from '../../store/useSessionStore'
import { requestResearch } from '../../lib/researchBridge'
import { newRequestId } from '../../lib/bridge'
import type { ResearchTeamSnapshot } from '../../types/research'

/** A view of the root host's real team; no roles are fabricated from task labels. */
export function DesktopResearchTeam({ runId, done }: { runId: string; done: boolean }) {
  const binding = useSessionStore(state => state.researchBinding)
  const team = useSessionStore(state => state.researchTeam)
  const modelBinding = useSessionStore(state => state.researchModelBinding)
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [names, setNames] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setSelected({}); setNames({}); setError(null) }, [runId, team?.teamId, binding?.sessionId])
  if (!team || binding?.runId !== runId) return null
  const choices = team.members.filter(member => selected[member.id] && member.kind === 'task_agent' && !member.retainedAs)
    .map(member => ({ id: member.id, name: (names[member.id] ?? member.name).trim() }))
  const retain = async () => {
    if (busy || choices.length === 0 || choices.some(choice => !choice.name)) return
    const sessionId = binding.sessionId
    setBusy(true); setError(null)
    try {
      const result = await requestResearch<ResearchTeamSnapshot & { snapshot?: ResearchTeamSnapshot }>('desktop_retain_roles', {
        sessionId, runId, requestId: newRequestId('retain_roles'), selections: choices,
      })
      useSessionStore.getState().applyResearchTeamSnapshot(sessionId, result.snapshot ?? result)
      if (useSessionStore.getState().researchBinding?.sessionId === sessionId) setSelected({})
    } catch (failure) {
      if (useSessionStore.getState().researchBinding?.sessionId === sessionId) setError(failure instanceof Error ? failure.message : String(failure))
    } finally { setBusy(false) }
  }
  return <section data-testid="desktop-research-team" aria-label="研究团队" className="space-y-2">
    <div className="flex items-center gap-1.5 text-[11px] font-medium text-dim"><Users className="h-3.5 w-3.5" />研究团队 · {team.members.length} 位成员</div>
    <div className="space-y-2">
      {team.members.map(member => {
        const effective = modelBinding?.effective ?? member.effectiveModel
        const exists = member.kind === 'borrowed_sister'
        const saved = Boolean(member.retainedAs)
        return <article key={member.id} className="space-y-2 rounded-xl border border-border-subtle bg-surface-2/40 p-2.5">
          <div className="flex items-center justify-between gap-2"><span className="font-medium text-text-main">{member.name}</span><span className="text-[10px] text-muted">{member.status}</span></div>
          <p className="text-[11px] text-muted">{member.responsibility}</p>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-dim">
            <span>{exists ? '借用共享角色' : '本次任务角色'}{member.sourceId && <> · <span>{member.sourceId}</span></>}</span>
            {effective && <span className="font-mono">{effective.provider}/{effective.modelId}</span>}
            {member.taskIds?.map(taskId => <button key={taskId} type="button" onClick={() => useSessionStore.getState().setActiveResearchTask({ runId, taskId })} className="text-accent hover:underline">{taskId}</button>)}
          </div>
          <details className="text-[11px] text-muted">
            <summary className="cursor-pointer text-dim hover:text-text-main">角色指令与能力</summary>
            <div className="mt-2 space-y-1.5 border-t border-border-subtle pt-2">
              <p><span className="text-dim">目标：</span>{member.goal}</p>
              <p className="whitespace-pre-wrap">{member.instructions}</p>
              <p>工具：{member.tools?.join(' · ') || '无'}</p>
              <p>技能：{member.skills?.join(' · ') || '无'}</p>
            </div>
          </details>
          {done && <div className="space-y-1.5 border-t border-border-subtle pt-2">
            <label className="flex items-center gap-2 text-[11px] text-text-main">
              <input type="checkbox" aria-label={`保留 ${member.name}`} disabled={busy || exists || saved} checked={Boolean(selected[member.id]) && !exists && !saved} onChange={event => setSelected(previous => ({ ...previous, [member.id]: event.target.checked }))} />
              {exists ? <span className="text-dim">已存在于共享角色</span> : saved ? <span className="text-success">已保留为 {member.retainedAs}</span> : '保留到共享角色库'}
            </label>
            {!exists && !saved && selected[member.id] && <input type="text" aria-label={`${member.name} 的保留名称`} value={names[member.id] ?? member.name} disabled={busy} onChange={event => setNames(previous => ({ ...previous, [member.id]: event.target.value }))} className="w-full rounded-lg border border-border-subtle bg-surface-1 px-2 py-1 text-xs text-text-main outline-none focus:border-accent" />}
          </div>}
        </article>
      })}
    </div>
    {done && <div className="space-y-2">
      <p className="text-[10px] text-dim">仅保留勾选的角色；默认不保存，现有共享角色保持原样。</p>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <button type="button" onClick={() => void retain()} disabled={busy || choices.length === 0 || choices.some(choice => !choice.name)} className="rounded-lg bg-accent px-3 py-1.5 text-[11px] font-medium text-on-accent disabled:opacity-50">{busy ? '正在保留…' : '确认保留所选角色'}</button>
    </div>}
  </section>
}
