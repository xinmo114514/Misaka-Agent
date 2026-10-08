import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Check, Download, FileText, GitBranch, Loader2, RefreshCw, RotateCcw, ShieldAlert, Square, X } from 'lucide-react'
import { newRequestId, request } from '../../lib/bridge'
import { addResearchSink, requestResearch } from '../../lib/researchBridge'
import { useSessionStore, type CompactStatus } from '../../store/useSessionStore'
import type { ResearchGraphNode, ResearchNodeDetail, ResearchOptionsPayload, ResearchRunDetail, ResearchRunSummary } from '../../types/research'
import { researchNodeLabel, researchOverview, researchPhaseLabel } from '../../lib/researchStatus'
import { MarkdownContent } from '../Timeline/MarkdownContent'
import { ResearchGraphCanvas } from './ResearchGraphCanvas'
import { ResearchStartForm } from './ResearchStartForm'
import { CompactDialog } from '../SessionTree/CompactDialog'

const ACTIVE = new Set(['active', 'waiting_input', 'stopping'])

function changedFileLabel(state: string): string {
  return state === 'changed' ? '文件内容已变更，冻结校验未通过'
    : state === 'missing' ? '登记文件缺失'
      : state === 'outside_workspace' ? '文件位于项目目录之外' : '已验证'
}

export const ResearchWorkbench: React.FC = () => {
  const currentWorkspace = useSessionStore(state => state.currentWorkspace)
  const researchRuns = useSessionStore(state => state.researchRuns)
  const researchGraph = useSessionStore(state => state.researchGraph)
  const researchRunId = useSessionStore(state => state.researchRunId)
  const fetchResearchRuns = useSessionStore(state => state.fetchResearchRuns)
  const fetchResearchGraph = useSessionStore(state => state.fetchResearchGraph)
  const [options, setOptions] = useState<ResearchOptionsPayload | null>(null)
  const [researchHostReady, setResearchHostReady] = useState(false)
  const [contextUsage, setContextUsage] = useState<Record<string, any> | null>(null)
  const [contextMessageCount, setContextMessageCount] = useState(0)
  const [compactOpen, setCompactOpen] = useState(false)
  const [compactBusy, setCompactBusy] = useState(false)
  const [compactOperationId, setCompactOperationId] = useState<string | null>(null)
  const [compactStatus, setCompactStatus] = useState<CompactStatus>({ state: 'idle' })
  const [activeRuns, setActiveRuns] = useState<Array<ResearchRunSummary & { workspace: string }>>([])
  const [runDetail, setRunDetail] = useState<ResearchRunDetail | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(researchRunId)
  const [selectedNode, setSelectedNode] = useState<ResearchGraphNode | null>(null)
  const [nodeDetail, setNodeDetail] = useState<ResearchNodeDetail | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [taskDetail, setTaskDetail] = useState<any>(null)
  const [report, setReport] = useState<any>(null)
  const [reportBusy, setReportBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  const activeRun = useMemo(() => activeRuns[0] ?? researchRuns.find(run => ACTIVE.has(run.status)), [activeRuns, researchRuns])
  const activeRunVisible = activeRun ? researchRuns.some(run => run.id === activeRun.id) : true
  const selectedRun = useMemo(() => researchRuns.find(run => run.id === selectedRunId) ?? null,
    [researchRuns, selectedRunId])
  const currentGraph = researchGraph?.run === selectedRunId ? researchGraph : null
  const runNodes = runDetail?.graph.nodes ?? currentGraph?.nodes ?? []
  const nodeOverview = useMemo(() => researchOverview(runNodes), [runNodes])

  useEffect(() => {
    fetchResearchRuns()
    void request<ResearchOptionsPayload>('get_research_options').then(setOptions).catch(failure => {
      setError(failure instanceof Error ? failure.message : String(failure))
    })
    const timer = window.setInterval(fetchResearchRuns, 4000)
    return () => window.clearInterval(timer)
  }, [fetchResearchRuns])

  useEffect(() => {
    let live = true
    const refreshActiveRuns = async () => {
      try {
        const result = await request<{ runs?: Array<ResearchRunSummary & { workspace: string }> }>('get_active_research_runs')
        if (live) setActiveRuns(result.runs || [])
      } catch { /* App shell maintains the native close prompt during bridge reconnects */ }
    }
    void refreshActiveRuns()
    const timer = window.setInterval(() => void refreshActiveRuns(), 4000)
    return () => { live = false; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    if (!researchHostReady) return
    let live = true
    const refreshContext = async () => {
      try {
        const reading = await requestResearch<{ stats?: any; contextUsage?: Record<string, any> }>('get_stats')
        if (!live) return
        setContextUsage(reading.contextUsage ?? null)
        setContextMessageCount(Number(reading.stats?.totalMessages ?? reading.stats?.messageCount ?? 0))
      } catch { /* the persisted session remains available after a bridge reconnect */ }
    }
    void refreshContext()
    const timer = window.setInterval(() => void refreshContext(), 5000)
    return () => { live = false; window.clearInterval(timer) }
  }, [researchHostReady])

  useEffect(() => addResearchSink(message => {
    if (!('event' in message)) return
    const event = message.event
    if (event.type === 'session_operation_end' && event.operation === 'compact_session') {
      if (!compactOperationId || event.requestId !== compactOperationId) return
      const status = event.status === 'done' ? 'done' : event.status === 'error' ? 'error' : 'aborted'
      const summary = event.compaction?.summary ?? event.compaction?.summaryText ??
        (status === 'done' ? '压缩完成；会话重载后已刷新上下文。' : event.error || '压缩未完成。')
      setCompactBusy(false)
      setCompactStatus({ state: status, message: String(summary) })
      setCompactOperationId(null)
    }
    if (event.type === 'compaction_start') {
      setCompactStatus({ state: 'running', message: '研究会话正在压缩上下文…' })
    } else if (event.type === 'compaction_end') {
      setCompactStatus({ state: 'done', message: '研究会话压缩完成。' })
      if (researchHostReady) {
        void requestResearch<{ contextUsage?: Record<string, any>; stats?: any }>('get_stats').then(result => {
          setContextUsage(result.contextUsage ?? null)
          setContextMessageCount(Number(result.stats?.totalMessages ?? result.stats?.messageCount ?? 0))
        }).catch(() => {})
      }
    }
  }), [compactOperationId, researchHostReady])

  useEffect(() => {
    if (!researchRuns.length) {
      setSelectedRunId(null)
      setRunDetail(null)
      return
    }
    if (!selectedRunId || !researchRuns.some(run => run.id === selectedRunId)) {
      setSelectedRunId(activeRun?.id ?? researchRuns[0].id)
    }
  }, [researchRuns, selectedRunId, activeRun])

  const refresh = useCallback(async (runId: string) => {
    fetchResearchGraph(runId)
    try {
      const workspace = useSessionStore.getState().researchRuns.find(run => run.id === runId)?.workspace
      const detail = await request<ResearchRunDetail>('get_research_details', { runId, workspace })
      if (detail.run?.id === runId) {
        setRunDetail(detail)
        if (detail.root_context?.contextUsage) setContextUsage(detail.root_context.contextUsage)
        if (detail.root_context?.stats) {
          setContextMessageCount(Number(detail.root_context.stats.totalMessages ?? detail.root_context.stats.messageCount ?? 0))
        }
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [fetchResearchGraph])

  useEffect(() => {
    if (!selectedRunId) return
    void refresh(selectedRunId)
    const timer = window.setInterval(() => void refresh(selectedRunId), 4000)
    return () => window.clearInterval(timer)
  }, [selectedRunId, refresh])

  useEffect(() => {
    setNodeDetail(null)
    setTaskDetail(null)
    setSelectedTaskId(null)
    setFeedback('')
    if (!selectedRunId || !selectedNode) return
    let current = true
    void request<{ detail: ResearchNodeDetail }>('get_research_node', {
      runId: selectedRunId, nodeId: selectedNode.id, workspace: selectedRun?.workspace,
    }).then(value => { if (current) setNodeDetail(value.detail) }).catch(failure => {
      if (current) setError(failure instanceof Error ? failure.message : String(failure))
    })
    return () => { current = false }
  }, [selectedRunId, selectedRun?.workspace, selectedNode])

  useEffect(() => {
    if (!selectedRunId || !selectedTaskId) return
    let current = true
    void request<{ detail: any }>('get_research_task', {
      runId: selectedRunId, taskId: selectedTaskId, workspace: selectedRun?.workspace,
    }).then(value => { if (current) setTaskDetail(value.detail) }).catch(failure => {
      if (current) setError(failure instanceof Error ? failure.message : String(failure))
    })
    return () => { current = false }
  }, [selectedRunId, selectedRun?.workspace, selectedTaskId])

  const runWorkerCommand = async (type: 'stop_research' | 'resume_research', run: ResearchRunDetail['run'], clarification?: string) => {
    if (!run.rootSession) throw new Error('这项研究尚未登记 Last Order 会话，刷新后再试。')
    const host = await window.app.startResearchBridge({ cwd: run.workspace, sessionFile: run.rootSession })
    setResearchHostReady(true)
    setContextUsage(host.contextUsage ?? null)
    setContextMessageCount(Number(host.stats?.totalMessages ?? 0))
    await requestResearch(type, { runId: run.id, clarification })
    await refresh(run.id)
  }

  const control = async (action: string, payload: Record<string, unknown> = {}) => {
    if (!selectedRunId) return
    setBusy(true)
    setError('')
    try {
      await request('control_research', {
        runId: selectedRunId, nodeId: nodeDetail?.node.id,
        workspace: runDetail?.run.workspace, action, payload,
        ...(action === 'approve_plan' ? { expectedPlanId: nodeDetail?.plan_tool_call_id } : {}),
        ...(action === 'approve_reconcile' ? { expectedRound: payload.expected_reconcile_round } : {}),
      })
      setFeedback('')
      await refresh(selectedRunId)
      if (selectedNode) {
        const value = await request<{ detail: ResearchNodeDetail }>('get_research_node', {
          runId: selectedRunId, nodeId: selectedNode.id, workspace: runDetail?.run.workspace,
        })
        setNodeDetail(value.detail)
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally { setBusy(false) }
  }

  const answer = async (nodeId: string) => {
    const value = answers[nodeId]?.trim()
    if (!value || !runDetail) return
    setBusy(true)
    setError('')
    try {
      await runWorkerCommand('resume_research', runDetail.run, value)
      setAnswers(current => ({ ...current, [nodeId]: '' }))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally { setBusy(false) }
  }

  const openReport = async (artifactId: string) => {
    if (!selectedRunId) return
    setReportBusy(true)
    setError('')
    try {
      const result = await request<{ detail: any }>('get_research_artifact', {
        runId: selectedRunId, artifactId, workspace: selectedRun?.workspace,
      })
      setReport(result.detail)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally { setReportBusy(false) }
  }

  const exportReport = () => {
    if (!report || report.state !== 'available') return
    const blob = new Blob([report.content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = report.path?.split('/').pop() || 'research-report.md'
    link.click()
    URL.revokeObjectURL(url)
  }

  const confirmResearchCompact = async (instructions: string | null) => {
    if (!runDetail || !runDetail.run.rootSession || ACTIVE.has(runDetail.run.status) || runDetail.run.driving) return
    setCompactBusy(true)
    setCompactStatus({ state: 'running', message: '研究会话正在压缩上下文…' })
    setError('')
    try {
      const host = await window.app.startResearchBridge({ cwd: runDetail.run.workspace, sessionFile: runDetail.run.rootSession })
      setResearchHostReady(true)
      setContextUsage(host.contextUsage ?? null)
      const requestId = newRequestId('research_compact')
      setCompactOperationId(requestId)
      await requestResearch('compact_session', { requestId, customInstructions: instructions })
      setCompactStatus({ state: 'running', message: '压缩任务已开始…' })
    } catch (failure) {
      setCompactBusy(false)
      setCompactStatus({ state: 'error', message: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  const contextTokens = Number(contextUsage?.tokens ?? contextUsage?.usedTokens ?? contextUsage?.totalTokens)
  const contextLimit = Number(contextUsage?.contextWindow ?? contextUsage?.contextWindowTokens ?? contextUsage?.limit)
  const contextPercent = Number.isFinite(Number(contextUsage?.percent))
    ? Number(contextUsage?.percent) * (Number(contextUsage?.percent) <= 1 ? 100 : 1)
    : contextLimit > 0 ? contextTokens / contextLimit * 100 : null

  const finalReport = runDetail?.run.final_artifact
  const reportMetadata = runDetail?.graph.final_artifacts?.find(item => item.id === finalReport)
  const tools = nodeDetail?.available_tools ?? []
  const planNeedsApproval = nodeDetail?.node.status === 'awaiting_approval' && tools.includes('misaka_research_start')
  const pendingReconciliation = runDetail?.graph.reconciles?.find(item => !item.applied)
  const reconcileNeedsApproval = nodeDetail?.node.kind === 'root' && Boolean(pendingReconciliation) && tools.includes('misaka_research_start')
  const canReturnPlan = planNeedsApproval && tools.includes('misaka_research_assign')
  const canSkip = tools.includes('misaka_research_skip')
  const rawRunStatus = runDetail?.run.status
  const nodeStates = new Set(nodeOverview.map(item => item.status))
  const phaseStatus = rawRunStatus === 'done' || rawRunStatus === 'failed' || rawRunStatus === 'stopping'
    ? rawRunStatus
    : nodeStates.has('awaiting_approval') ? 'awaiting_approval'
      : nodeStates.has('waiting_input') ? 'waiting_input'
        : nodeStates.has('critique') || nodeStates.has('critiquing') ? 'red_team_review'
          : nodeStates.has('diverging') || nodeStates.has('divergence') ? 'divergence_review'
            : runDetail?.run.phase || rawRunStatus

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-surface-0">
      <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border-subtle px-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-text-main">
            <GitBranch className="h-4 w-4 text-accent" /> 研究工作台
            {runDetail && <span className="rounded-md border border-border-subtle bg-surface-2 px-2 py-0.5 text-[10.5px] font-medium text-muted">
              {researchPhaseLabel(phaseStatus)}
            </span>}
          </div>
          <p className="truncate text-[10px] text-dim">{selectedRun?.question || '在此发起、审查并跟进完整研究流程'}</p>
        </div>
        {researchRuns.length > 0 && <select aria-label="选择研究运行" value={selectedRunId || ''}
          onChange={event => { setSelectedRunId(event.target.value); setSelectedNode(null) }}
          className="max-w-[280px] rounded-md border border-border-subtle bg-surface-1 px-2 py-1.5 text-[11px] text-text-main">
          {researchRuns.map(run => <option key={run.id} value={run.id}>{researchPhaseLabel(run.phase || run.status)} · {run.question}</option>)}
        </select>}
        <button type="button" aria-label="刷新研究状态" onClick={() => { fetchResearchRuns(); if (selectedRunId) void refresh(selectedRunId) }}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><RefreshCw className="h-3.5 w-3.5" /></button>
        {runDetail && ACTIVE.has(runDetail.run.status) && <button type="button" disabled={busy}
          onClick={() => void runWorkerCommand('stop_research', runDetail.run).catch(failure => setError(String(failure)))}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-danger-border px-2.5 text-[11px] text-danger hover:bg-danger-surface disabled:opacity-50"><Square className="h-3 w-3" /> 停止</button>}
        {runDetail && runDetail.run.status !== 'done' &&
          (!ACTIVE.has(runDetail.run.status) || runDetail.run.driving === false) && <button type="button" disabled={busy}
          onClick={() => void runWorkerCommand('resume_research', runDetail.run).catch(failure => setError(String(failure)))}
          className="misaka-luminous inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[11px] text-on-accent disabled:opacity-50"><RotateCcw className="h-3 w-3" /> 恢复</button>}
        {reportMetadata && <button type="button" disabled={reportBusy} onClick={() => void openReport(reportMetadata.id)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-subtle px-2.5 text-[11px] text-text-main hover:bg-surface-2 disabled:opacity-50"><FileText className="h-3.5 w-3.5" /> 打开最终报告</button>}
        {contextUsage && <span className="hidden text-[10px] text-dim 2xl:inline" title={`${contextMessageCount} 条会话消息`}>
          上下文 {Number.isFinite(contextTokens) ? contextTokens.toLocaleString() : '—'} / {Number.isFinite(contextLimit) ? contextLimit.toLocaleString() : '—'}{contextPercent !== null ? ` · ${contextPercent.toFixed(1)}%` : ''}
        </span>}
        {runDetail && !ACTIVE.has(runDetail.run.status) && !runDetail.run.driving && <button type="button" onClick={() => setCompactOpen(true)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-subtle px-2.5 text-[11px] text-text-main hover:bg-surface-2"><FileText className="h-3.5 w-3.5" /> 压缩研究会话</button>}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!activeRunVisible && activeRun && <div role="status" className="mb-2 flex items-center gap-2 rounded-lg border border-warning-border bg-warning-surface/40 px-3 py-2 text-[10.5px] text-text-main">
          <AlertCircle className="h-3.5 w-3.5 text-warning" /> 另一项目仍有研究运行：{activeRun.question} · {activeRun.workspace}。切换到对应项目查看；新运行会在其完成后开放。
        </div>}
        <ResearchStartForm workspace={currentWorkspace} options={options} active={Boolean(activeRuns.length || activeRun && ACTIVE.has(activeRun.status))} onStarted={(host) => {
          setResearchHostReady(true)
          setContextUsage(host.contextUsage ?? null)
          setContextMessageCount(Number(host.stats?.totalMessages ?? 0))
          fetchResearchRuns()
        }} />
        {error && <div role="alert" className="mt-2 flex items-start gap-2 rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-[11px] text-danger">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="flex-1">{error}</span><button aria-label="关闭错误" onClick={() => setError('')}><X className="h-3.5 w-3.5" /></button>
        </div>}
        {runDetail?.pending_questions?.map(item => <section key={`${item.node_id}:${item.question}`} className="mt-3 rounded-xl border border-warning-border bg-warning-surface/40 p-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-text-main"><AlertCircle className="h-4 w-4 text-warning" /> 待确认 · {item.node_id}</div>
          <p className="mt-2 text-xs leading-relaxed text-text-main">{item.question}</p>
          <div className="mt-2 flex gap-2"><input aria-label={`回答 ${item.question}`} value={answers[item.node_id] || ''}
            onChange={event => setAnswers(current => ({ ...current, [item.node_id]: event.target.value }))}
            className="min-w-0 flex-1 rounded-md border border-border-subtle bg-surface-1 px-2.5 py-2 text-xs text-text-main" />
            <button type="button" disabled={busy || !answers[item.node_id]?.trim()} onClick={() => void answer(item.node_id)}
              className="misaka-luminous rounded-md bg-accent px-3 text-xs font-medium text-on-accent disabled:opacity-40">回答并继续</button></div>
        </section>)}

        {runDetail ? <div className="mt-3 grid min-h-[440px] grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(340px,420px)]">
          <section className="relative h-[520px] min-h-[440px] overflow-hidden rounded-xl border border-border-subtle bg-surface-1">
            <div className="absolute left-3 top-3 z-20 flex items-center gap-3 rounded-lg border border-border-subtle bg-card/95 px-3 py-2 shadow-e1 backdrop-blur-sm">
              <div><div className="text-[10px] font-semibold uppercase tracking-wide text-dim">研究状态</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10.5px] text-text-main">
                  {nodeOverview.map(item => <span key={item.status} className="rounded border border-border-subtle bg-surface-1 px-1.5 py-0.5">{item.label} {item.count}</span>)}
                  {!nodeOverview.length && <span>{researchPhaseLabel(phaseStatus)}</span>}
                  <span className="ml-1 text-dim">· {runNodes.length} 节点 · {selectedRun?.tasks ?? 0} 任务</span>
                </div></div>
              <div className="h-7 w-px bg-border-subtle" />
              <div className="max-w-48 truncate text-[10px] text-dim" title={runDetail.run.workspace}>{runDetail.run.workspace}</div>
            </div>
            <ResearchGraphCanvas showRunPicker={false} showNodeDrawer={false} onSelectNode={setSelectedNode} />
          </section>

          <section className="min-h-[440px] overflow-y-auto rounded-xl border border-border-subtle bg-card">
            {selectedNode && nodeDetail ? <>
              <div className="sticky top-0 z-10 flex items-start justify-between gap-2 border-b border-border-subtle bg-card/95 px-3.5 py-3 backdrop-blur-sm">
                <div className="min-w-0"><div className="flex items-center gap-2 text-[10px] text-dim">节点 {nodeDetail.node.id} · D{nodeDetail.node.depth} · {researchNodeLabel(nodeDetail.node.status)}</div>
                  <h2 className="mt-1 text-xs font-semibold leading-relaxed text-text-main">{nodeDetail.node.question}</h2></div>
                <button aria-label="关闭节点详情" onClick={() => { setSelectedNode(null); setNodeDetail(null) }} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dim hover:bg-surface-2"><X className="h-4 w-4" /></button>
              </div>
              <div className="space-y-4 p-3.5">
                {reconcileNeedsApproval && pendingReconciliation && <section className="rounded-lg border border-warning-border bg-warning-surface/40 p-3">
                  <SectionHeading>分支汇总 · 第 {pendingReconciliation.round} 轮</SectionHeading>
                  <p className="mt-1 text-[10.5px] leading-relaxed text-muted">{pendingReconciliation.summary || '等待批准分支、汇合与未继续路径的处理方案。'}</p>
                  <button disabled={busy} onClick={() => void control('approve_reconcile', { expected_reconcile_round: pendingReconciliation.round })}
                    className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-md bg-success px-3 text-[11px] font-semibold text-on-accent disabled:opacity-50"><Check className="h-3.5 w-3.5" /> 批准分支汇总</button>
                </section>}
                {nodeDetail.plan && <section className="space-y-2">
                  <SectionHeading>研究计划 · 第 {nodeDetail.plan_round} 轮</SectionHeading>
                  <div className="rounded-lg border border-border-subtle bg-surface-1 p-3"><MarkdownContent content={nodeDetail.plan.plan_markdown || ''} /></div>
                  {!!nodeDetail.plan.tasks?.length && <div className="space-y-1.5">
                    {nodeDetail.plan.tasks.map((task: any) => <button key={task.local_id} type="button"
                      onClick={() => { const card = nodeDetail.cards.find(item => item.title === task.title); if (card) setSelectedTaskId(card.id) }}
                      className="block w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-left hover:border-border-accent">
                      <span className="block text-[11px] font-semibold text-text-main">{task.title}</span>
                      <span className="mt-1 line-clamp-3 whitespace-pre-wrap text-[10.5px] leading-relaxed text-muted">{task.body || task.question}</span>
                      {task.rationale && <span className="mt-1 block text-[10px] text-dim">依据：{task.rationale}</span>}
                      <span className="mt-1 block text-[10px] text-dim">{task.assignee} · {task.deliverable}</span>
                      {!!task.dependencies?.length && <span className="mt-1 block text-[10px] text-dim">依赖：{task.dependencies.join('、')}</span>}
                    </button>)}
                  </div>}
                  {planNeedsApproval && <div className="flex flex-wrap gap-2 border-t border-border-subtle pt-2">
                    <button disabled={busy} onClick={() => void control('approve_plan', { summary: 'Approved in the desktop research workbench.' })}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-success px-3 text-[11px] font-semibold text-on-accent disabled:opacity-50"><Check className="h-3.5 w-3.5" /> 批准计划</button>
                    {canReturnPlan && <div className="flex min-w-0 flex-1 gap-1.5"><input aria-label="计划退回意见" value={feedback} onChange={event => setFeedback(event.target.value)}
                      placeholder="填写退回修改意见" className="min-w-24 flex-1 rounded-md border border-border-subtle bg-surface-1 px-2 text-[10.5px] text-text-main" />
                      <button disabled={busy || !feedback.trim()} onClick={() => void control('return_plan', { feedback })}
                        className="h-8 rounded-md border border-border-subtle px-2.5 text-[10.5px] text-text-main disabled:opacity-40">退回修改</button></div>}
                    {canSkip && <button disabled={busy} onClick={() => void control('skip_node', { reason: feedback || '用户在桌面研究工作台选择跳过。' })}
                      className="h-8 rounded-md border border-border-subtle px-2.5 text-[10.5px] text-danger disabled:opacity-50">跳过节点</button>}
                  </div>}
                </section>}
                {selectedNode?.reached_by?.length ? <section className="space-y-2">
                  <SectionHeading>分支前提与来源</SectionHeading>
                  {selectedNode.reached_by.map((path, index) => <div key={`${path.option}:${index}`} className="rounded-lg border border-border-subtle bg-surface-1 p-2.5 text-[10.5px]">
                    <div className="font-medium text-text-main">{path.label || path.option}</div>
                    <div className="mt-1 leading-relaxed text-muted">{path.decision}</div>
                    <div className="mt-1 text-dim">前提：{path.premise}</div>
                  </div>)}
                </section> : null}
                {!!runDetail.graph.decisions?.filter(item => item.node === nodeDetail.node.id).length && <section className="space-y-2">
                  <SectionHeading>本节点记录的研究路径</SectionHeading>
                  {runDetail.graph.decisions.filter(item => item.node === nodeDetail.node.id).map((decision: any) => <div key={decision.id} className="rounded-lg border border-border-subtle bg-surface-1 p-2.5">
                    <div className="text-[10.5px] font-semibold text-text-main">{decision.question}</div>
                    <div className="mt-1 text-[10px] text-dim">关键影响：{decision.stakes}</div>
                    {decision.options.map((option: any) => <div key={option.id} className="mt-2 border-l-2 border-accent/50 pl-2 text-[10px] leading-relaxed text-muted">
                      <span className="font-medium text-text-main">{option.label}</span> · {option.premise}
                      <div className="text-dim">结果：{option.outcome || option.reason || '待汇总'}</div>
                    </div>)}
                  </div>)}
                </section>}
                {runDetail.graph.relations?.some(item => item.nodes?.includes(nodeDetail.node.id)) && <section className="space-y-2">
                  <SectionHeading>节点关系</SectionHeading>
                  {runDetail.graph.relations.filter(item => item.nodes?.includes(nodeDetail.node.id)).map((relation: any, index: number) => <div key={`${relation.kind}:${index}`} className="rounded-lg border border-border-subtle bg-surface-1 p-2.5 text-[10.5px]">
                    <span className="font-medium text-text-main">{relation.kind}</span> · {relation.note}
                  </div>)}
                </section>}
                {!!nodeDetail.cards.length && <section className="space-y-2">
                  <SectionHeading>专家任务与产出</SectionHeading>
                  <div className="space-y-2">{nodeDetail.cards.map(card => <article key={card.id} className="rounded-lg border border-border-subtle bg-surface-1 p-2.5">
                    <button className="w-full text-left" onClick={() => { setSelectedTaskId(card.id); setTaskDetail(card) }}>
                      <div className="flex items-start justify-between gap-2"><span className="text-[11px] font-semibold text-text-main">{card.title}</span><span className="shrink-0 text-[10px] text-dim">{card.assignee} · {researchNodeLabel(card.status)}</span></div>
                      <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[10.5px] leading-relaxed text-muted">{card.body}</p>
                    </button>
                    {card.artifacts.map((artifact: any) => <button key={artifact.id} onClick={() => void openReport(artifact.id)}
                      className="mt-2 flex w-full items-center gap-1.5 rounded border border-border-subtle px-2 py-1.5 text-left text-[10px] text-accent hover:bg-surface-2">
                      <FileText className="h-3 w-3" /> {artifact.title} · {changedFileLabel(artifact.state)}</button>)}
                    {card.findings.map((finding: any) => <div key={finding.id} className="mt-2 rounded border-l-2 border-accent/60 pl-2 text-[10px] leading-relaxed text-muted">
                      <span className="font-semibold text-text-main">{finding.claim_type}</span> · {finding.text}
                      {finding.citations.map((citation: any, i: number) => <div key={i} className="mt-1 text-dim">{citation.source_file} · “{citation.quote}”</div>)}
                    </div>)}
                  </article>)}</div>
                </section>}
                {nodeDetail.artifacts.filter((item: any) => !['plan', 'synthesis'].includes(item.kind)).map((artifact: any) => <section key={artifact.id} className="space-y-2">
                  <SectionHeading>{artifact.kind === 'critique' ? '红队审查' : artifact.kind === 'divergence' ? '歧路审查' : artifact.title}</SectionHeading>
                  <div className="rounded-lg border border-border-subtle bg-surface-1 p-3"><div className="mb-2 text-[10px] text-dim">{changedFileLabel(artifact.state)} · {artifact.path}</div>
                    {artifact.content ? <MarkdownContent content={artifact.content} /> : <p className="text-[11px] text-warning">该审查产物当前未通过完整性检查。</p>}</div>
                </section>)}
                {nodeDetail.artifacts.filter((item: any) => item.kind === 'synthesis').map((artifact: any, index: number) => <section key={artifact.id} className="space-y-2">
                  <SectionHeading>完整节点结论 · 第 {index + 1} 版</SectionHeading>
                  <div className="rounded-lg border border-border-subtle bg-surface-1 p-3"><div className="mb-2 text-[10px] text-dim">{changedFileLabel(artifact.state)} · {artifact.path}</div>
                    {artifact.content ? <MarkdownContent content={artifact.content} /> : <p className="text-[11px] text-warning">结论未通过冻结完整性校验，正文不展示。</p>}</div>
                </section>)}
                {!!nodeDetail.issues.length && <section className="space-y-2">
                  <SectionHeading><ShieldAlert className="mr-1 inline h-3.5 w-3.5" />审查意见与处理记录</SectionHeading>
                  {nodeDetail.issues.map((issue: any) => <div key={issue.id} className="rounded-lg border border-border-subtle bg-surface-1 p-2.5 text-[10.5px]">
                    <div className="font-medium text-text-main">{issue.question}</div><div className="mt-1 text-muted">{issue.rationale}</div>
                    <div className="mt-2 text-dim">{issue.disposition || '待处理'}{issue.reason ? ` · ${issue.reason}` : ''}</div>
                  </div>)}
                </section>}
                {!!nodeDetail.errata.length && <section className="space-y-2">
                  <SectionHeading>勘误与修订记录</SectionHeading>
                  {nodeDetail.errata.map((item: any, index: number) => <div key={item.id || index} className="rounded-lg border border-border-subtle bg-surface-1 p-2.5 text-[10.5px]">
                    <div className="font-medium text-text-main">{item.claim ? `原断言：${item.claim}` : '更正记录'}</div>
                    {item.correction && <div className="mt-1 text-success">更正：{item.correction}</div>}
                    {(item.grounds || item.reason) && <div className="mt-1 text-dim">依据：{item.grounds || item.reason}</div>}
                    {item.raised_by && <div className="mt-1 text-[9.5px] text-dim">由节点 {item.raised_by} 提出</div>}
                  </div>)}
                </section>}
                {nodeDetail.findings.length > 0 && <section className="space-y-2"><SectionHeading>节点证据与引用</SectionHeading>
                  {nodeDetail.findings.map((finding: any) => <div key={finding.id} className="rounded-lg border border-border-subtle bg-surface-1 p-2.5 text-[10.5px] text-muted">
                    <div><span className="font-semibold text-text-main">{finding.claim_type}</span> · {finding.text}</div>
                    {finding.citations.map((citation: any, i: number) => <div key={i} className="mt-1 text-dim">{citation.source_file}{citation.quote ? ` · “${citation.quote}”` : ''}</div>)}
                  </div>)}</section>}
                {nodeDetail.red_team && <div className="border-t border-border-subtle pt-2 text-[10.5px] text-dim">红队：{nodeDetail.red_team.assignee} · {nodeDetail.red_team.reason}</div>}
              </div>
            </> : selectedNode ? <div className="flex h-full items-center justify-center gap-2 text-xs text-muted"><Loader2 className="h-4 w-4 animate-spin" />读取节点完整详情…</div> : <div className="flex h-full min-h-56 flex-col items-center justify-center px-8 text-center">
              <GitBranch className="h-6 w-6 text-accent" /><h2 className="mt-2 text-xs font-semibold text-text-main">研究关系图</h2><p className="mt-1 max-w-xs text-[10.5px] leading-relaxed text-dim">选择任一节点查看完整计划、专家产出、结论、引用与审查记录。</p>
            </div>}
          </section>
        </div> : <section className="mt-3 flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border-subtle bg-card px-6 text-center">
          <GitBranch className="h-6 w-6 text-accent" /><p className="mt-2 text-xs font-semibold text-text-main">还没有研究运行</p><p className="mt-1 text-[10.5px] text-dim">填写上方课题，研究将由独立会话驱动并保留进度。</p>
        </section>}
      </div>

      {taskDetail && <div role="dialog" aria-modal="true" aria-label="专家任务详情" className="fixed inset-0 z-40 flex items-center justify-center bg-overlay p-5" onMouseDown={event => { if (event.target === event.currentTarget) { setTaskDetail(null); setSelectedTaskId(null) } }}>
        <div className="misaka-glass-popover relative max-h-[85vh] w-full max-w-2xl overflow-auto rounded-xl border border-border-subtle bg-card shadow-e3">
          <div className="sticky top-0 flex items-center justify-between border-b border-border-subtle bg-card px-4 py-3"><div><p className="text-[10px] text-dim">专家任务 · {taskDetail.assignee}</p><h2 className="text-sm font-semibold text-text-main">{taskDetail.title}</h2></div><button aria-label="关闭任务详情" onClick={() => { setTaskDetail(null); setSelectedTaskId(null) }}><X className="h-4 w-4" /></button></div>
          <div className="space-y-3 bg-surface-1 p-4"><div className="text-[10px] text-dim">状态：{researchNodeLabel(taskDetail.status)}</div><div className="rounded-lg bg-surface-1 p-3"><MarkdownContent content={taskDetail.body || ''} /></div>
            {(taskDetail.artifacts || []).map((artifact: any) => <section key={artifact.id} className="rounded-lg border border-border-subtle p-3"><SectionHeading>{artifact.title} · {changedFileLabel(artifact.state)}</SectionHeading>{artifact.content ? <MarkdownContent content={artifact.content} /> : <p className="text-xs text-warning">此任务产物不可用或摘要校验未通过。</p>}</section>)}
          </div>
        </div>
      </div>}

      <CompactDialog
        open={compactOpen}
        busy={compactBusy}
        status={compactStatus}
        messageCount={contextMessageCount}
        initialInstructions={null}
        onConfirm={instructions => { void confirmResearchCompact(instructions) }}
        onCancelOperation={() => {
          if (!compactOperationId) return
          void requestResearch('cancel_session_operation', {
            requestId: newRequestId('research_cancel_compact'), operationRequestId: compactOperationId,
          }).catch(failure => setCompactStatus({ state: 'error', message: String(failure) }))
        }}
        onClose={() => setCompactOpen(false)}
      />

      {report && <div role="dialog" aria-modal="true" aria-label="研究报告" className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-5" onMouseDown={event => { if (event.target === event.currentTarget) setReport(null) }}>
        <div className="misaka-glass-popover relative flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border-subtle bg-card shadow-e3">
          <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3"><div><p className="text-[10px] text-dim">{report.kind === 'partial' ? '阶段性报告' : report.kind === 'draft' ? '报告草稿' : '最终研究报告'}</p><h2 className="text-sm font-semibold text-text-main">{report.title}</h2></div><div className="flex gap-2">
            <button type="button" disabled={report.state !== 'available'} onClick={exportReport} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-subtle px-2.5 text-[11px] text-text-main disabled:opacity-40"><Download className="h-3.5 w-3.5" /> 导出 Markdown</button>
            <button aria-label="关闭报告" onClick={() => setReport(null)} className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-surface-2"><X className="h-4 w-4" /></button>
          </div></div>
          <div className="overflow-y-auto bg-surface-1 p-6">{report.state === 'available' ? <MarkdownContent content={report.content} /> : <div className="rounded-lg border border-warning-border bg-warning-surface p-4 text-sm text-warning">{changedFileLabel(report.state)}，报告正文不展示。</div>}</div>
        </div>
      </div>}
    </div>
  )
}

const SectionHeading: React.FC<React.PropsWithChildren> = ({ children }) =>
  <h3 className="text-[11px] font-semibold text-text-main">{children}</h3>
