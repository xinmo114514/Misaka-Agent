import { useEffect, useRef, useState } from 'react'
import { ArrowRight, BookOpen, Cpu, Layers3, SlidersHorizontal, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import type { ResearchOptionsPayload, ResearchRunLimits } from '../../types/research'

const fields: Array<[Exclude<keyof ResearchRunLimits, 'plan_approval' | 'context_threshold' | 'max_output_tokens'>, string]> = [
  ['max_depth', '最大深度'], ['parallel', '节点并发'], ['sister_parallel', '专家并发'],
  ['max_followups', '追加轮次'], ['max_revisions', '结论修订'], ['max_nodes', '节点上限'],
]

export function ResearchRunWizard({ options, onConfirm, onCancel }: {
  options: ResearchOptionsPayload; onConfirm: (limits: ResearchRunLimits) => void; onCancel: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [limits, setLimits] = useState<ResearchRunLimits>(() => ({ ...options.defaults }))
  const [contextPercent, setContextPercent] = useState(options.defaults.context_threshold == null ? '' : String(Math.round(options.defaults.context_threshold * 100)))
  const [output, setOutput] = useState(options.defaults.max_output_tokens == null ? '' : String(options.defaults.max_output_tokens))
  const valid = fields.every(([key]) => {
    const value = limits[key]
    const constraint = options.constraints[key]
    return Number.isInteger(value) && value >= (constraint?.min ?? 0) && (constraint?.max === undefined || value <= constraint.max)
  }) && (contextPercent === '' || (Number(contextPercent) >= 10 && Number(contextPercent) <= 95))
    && (output === '' || (Number.isInteger(Number(output)) && Number(output) >= (options.constraints.max_output_tokens?.min ?? 1024)))
  const confirm = () => {
    if (!valid) return
    const chosen = { ...limits }
    if (contextPercent === '') delete chosen.context_threshold
    else chosen.context_threshold = Number(contextPercent) / 100
    if (output === '') delete chosen.max_output_tokens
    else chosen.max_output_tokens = Number(output)
    onConfirm(chosen)
  }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.querySelector<HTMLElement>('[data-wizard-close]')?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  const hints: Record<string, string> = { max_depth: '分支向下探索的最大层级', max_nodes: '包含主控在内的图谱节点总量',
    max_followups: '首轮结束后的追加研究轮次', max_revisions: '审阅后允许修订结论的次数',
    parallel: '同时推进的 Last Order 节点', sister_parallel: '每个节点同时执行的 Sister 卡片' }
  const field = (key: typeof fields[number][0], label: string) => <label key={key} className="research-wizard-field"><span>{label}</span>
    <input type="number" aria-label={label} min={options.constraints[key]?.min} max={options.constraints[key]?.max} step="1"
      value={Number.isNaN(limits[key]) ? '' : limits[key]}
      onChange={event => setLimits(current => ({ ...current, [key]: event.target.value === '' ? NaN : Number(event.target.value) }))} />
    <small>{hints[key]}</small>
  </label>
  return createPortal(<div role="dialog" ref={dialogRef} aria-modal="true" aria-label="研究参数确认" className="research-wizard-backdrop"
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
      if (event.key === 'Tab') {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex="0"]') ?? [])
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
    <div className="research-wizard">
      <header className="research-wizard-heading"><div><div className="research-eyebrow"><Layers3 size={13} aria-hidden="true" />NEW RESEARCH</div><h2>配置这次研究</h2><p>确定探索边界，再让团队开始工作。</p></div>
        <button type="button" data-wizard-close aria-label="关闭参数向导" onClick={onCancel} className="research-icon-button"><X size={18} aria-hidden="true" /></button></header>
      <div className="research-wizard-scroll">
        <fieldset className="research-wizard-section"><legend><BookOpen size={15} aria-hidden="true" />研究范围</legend>
          <div className="research-preset-grid">{[{ value: 2, name: '快速概览', note: '聚焦主要线索' }, { value: 5, name: '标准研究', note: '兼顾深度与效率' }, { value: 10, name: '深入探索', note: '展开更多研究分支' }].map(preset =>
            <button type="button" key={preset.value} aria-pressed={limits.max_depth === preset.value} onClick={() => setLimits(current => ({ ...current, max_depth: preset.value }))}>
              <strong>{preset.name}<span>{preset.value} 层</span></strong><small>{preset.note}</small></button>)}</div>
          <div className="research-field-grid">{fields.filter(([key]) => !['parallel', 'sister_parallel'].includes(key)).map(([key, label]) => field(key, label))}</div>
        </fieldset>
        <fieldset className="research-wizard-section"><legend><Cpu size={15} aria-hidden="true" />并发与审批</legend>
          <div className="research-field-grid">{fields.filter(([key]) => ['parallel', 'sister_parallel'].includes(key)).map(([key, label]) => field(key, label))}</div>
          <label className="research-approval-toggle"><span><strong>计划审批</strong><small>每份研究计划与分支汇总先交由你确认</small></span><input type="checkbox" aria-label="计划审批" checked={limits.plan_approval} onChange={event => setLimits(current => ({ ...current, plan_approval: event.target.checked }))} /></label>
        </fieldset>
        <fieldset className="research-wizard-section"><legend><SlidersHorizontal size={15} aria-hidden="true" />上下文与输出</legend>
          <div className="research-field-grid"><label className="research-wizard-field"><span>上下文阈值 <small>10–95%</small></span><input aria-label="上下文阈值" type="number" min="10" max="95" placeholder="跟随全局设置" value={contextPercent} onChange={event => setContextPercent(event.target.value)} /><small>留空使用 Global setting</small></label>
          <label className="research-wizard-field"><span>最大输出 token</span><input aria-label="最大输出 token" type="number" min={options.constraints.max_output_tokens?.min ?? 1024} placeholder="模型默认" value={output} onChange={event => setOutput(event.target.value)} /><small>留空使用 Model default，或至少 1024</small></label></div>
        </fieldset>
        {options.questions?.length ? <details className="research-engine-options"><summary>引擎参数说明</summary>{options.questions.map(question => <p key={question.key}>{question.header} · {question.question}</p>)}</details> : null}
      </div>
      <footer className="research-wizard-footer"><span>仅应用于本次研究 · 9 项参数</span><button type="button" onClick={onCancel} className="research-button research-button--subtle">取消</button>
        <button type="button" disabled={!valid} onClick={confirm} className="research-button research-button--primary">确认并开始研究<ArrowRight size={14} aria-hidden="true" /></button></footer>
    </div>
  </div>, document.body)
}
