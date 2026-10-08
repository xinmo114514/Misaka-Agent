import React, { useState } from 'react'
import { Loader2, Play, Settings2 } from 'lucide-react'
import { requestResearch } from '../../lib/researchBridge'
import type { ResearchOptionsPayload, ResearchRunLimits } from '../../types/research'

export type ResearchLimits = ResearchRunLimits
export type ResearchOptions = ResearchOptionsPayload

interface Props {
  workspace: string
  options: ResearchOptionsPayload | null
  active: boolean
  onStarted: (host: Awaited<ReturnType<typeof window.app.startResearchBridge>>) => void
}

const visibleLimits: Array<[keyof ResearchRunLimits, string]> = [
  ['max_depth', '最大深度'], ['parallel', '节点并发'], ['sister_parallel', '专家并发'], ['max_nodes', '节点上限'],
]

function allowed(value: number, bounds?: { min: number; max?: number }): boolean {
  return Number.isInteger(value) && (!bounds || (value >= bounds.min && (bounds.max === undefined || value <= bounds.max)))
}

function inputValue(value: number | boolean): number | '' {
  const number = Number(value)
  return Number.isFinite(number) ? number : ''
}

export const ResearchStartForm: React.FC<Props> = ({ workspace, options, active, onStarted }) => {
  const [question, setQuestion] = useState('')
  const [limits, setLimits] = useState<ResearchLimits | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const values = limits ?? options?.defaults ?? null
  const canSubmit = Boolean(question.trim() && workspace && values && !active && !busy &&
    visibleLimits.every(([key]) => allowed(Number(values[key]), options?.constraints[key])))

  const setNumber = (key: keyof ResearchRunLimits, value: string) => {
    setLimits(current => ({ ...(current ?? options?.defaults ?? {
      max_depth: 1, parallel: 1, sister_parallel: 2, max_followups: 0, max_revisions: 0,
      max_nodes: 3, plan_approval: true,
    }), [key]: value === '' ? Number.NaN : Number(value) }))
  }

  const start = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmit || !values) return
    setBusy(true)
    setError('')
    try {
      const host = await window.app.startResearchBridge({ cwd: workspace })
      await requestResearch('start_research', { question: question.trim(), limits: values, workspace })
      setQuestion('')
      onStarted(host)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={start} className="space-y-3 rounded-xl border border-border-subtle bg-card px-4 py-3 shadow-e1">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-text-main">发起一项研究</h2>
          <p className="mt-0.5 text-[11px] text-dim">研究使用独立的 Last Order 会话；普通对话和会话树保持分开。</p>
        </div>
        <button type="button" onClick={() => setAdvanced(value => !value)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-subtle px-2.5 text-[11px] text-muted hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          aria-expanded={advanced}>
          <Settings2 className="h-3.5 w-3.5" /> 高级参数
        </button>
      </div>

      <label className="block text-[11px] font-medium text-muted" htmlFor="research-question">研究课题</label>
      <textarea id="research-question" value={question} onChange={event => setQuestion(event.target.value)}
        rows={2} maxLength={2000} required placeholder="说明你希望回答的问题、范围或比较维度"
        className="w-full resize-y rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-[13px] leading-relaxed text-text-main outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/30" />

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {visibleLimits.map(([key, label]) => {
          const bounds = options?.constraints[key]
          return <label key={key} className="space-y-1 text-[10.5px] text-muted">
            <span className="block">{label}{bounds ? ` (${bounds.min}${bounds.max === undefined ? '+' : `–${bounds.max}`})` : ''}</span>
            <input aria-label={label} type="number" min={bounds?.min} max={bounds?.max} step={1}
              value={values ? inputValue(values[key]) : ''} onChange={event => setNumber(key, event.target.value)}
              className="w-full rounded-md border border-border-subtle bg-surface-1 px-2.5 py-1.5 text-xs text-text-main outline-none focus:border-accent" />
          </label>
        })}
      </div>

      {advanced && values && <div className="grid grid-cols-1 gap-2 border-t border-border-subtle pt-3 md:grid-cols-3">
        {([['max_followups', '追加轮次'], ['max_revisions', '结论修订']] as Array<[keyof ResearchRunLimits, string]>).map(([key, label]) => {
          const bounds = options?.constraints[key]
          return <label key={key} className="space-y-1 text-[10.5px] text-muted">
            <span className="block">{label}</span>
            <input aria-label={label} type="number" min={bounds?.min ?? 0} max={bounds?.max ?? 6} step={1}
              value={inputValue(values[key])} onChange={event => setNumber(key, event.target.value)}
              className="w-full rounded-md border border-border-subtle bg-surface-1 px-2.5 py-1.5 text-xs text-text-main outline-none focus:border-accent" />
          </label>
        })}
        <label className="flex items-center gap-2 pt-5 text-[11px] text-muted">
          <input type="checkbox" checked={values.plan_approval}
            onChange={event => setLimits(current => ({ ...(current ?? values), plan_approval: event.target.checked }))} />
          每份计划与分支汇总均需审批
        </label>
      </div>}

      {active && <p className="text-[11px] text-warning" role="status">当前已有研究运行；完成或停止后可发起下一项。</p>}
      {options && options.sisters.length === 0 && <p className="text-[11px] text-dim" role="status">协调 Agent 会按课题自动准备专家，可直接开始研究。</p>}
      {error && <p className="text-[11px] text-danger" role="alert">启动失败：{error}</p>}
      <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-2">
        <span className="truncate text-[10.5px] text-dim" title={workspace}>{workspace || '请先选择项目目录'}</span>
        <button type="submit" disabled={!canSubmit}
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-accent px-3.5 text-xs font-semibold text-on-accent shadow-e1 transition-colors hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          {busy ? '正在启动…' : '开始研究'}
        </button>
      </div>
    </form>
  )
}
