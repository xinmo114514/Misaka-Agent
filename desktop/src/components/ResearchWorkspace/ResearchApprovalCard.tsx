import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, Clock3, History, ListChecks, MessageSquareQuote, RefreshCw } from 'lucide-react'
import { request } from '../../lib/bridge'
import { executeResearchControl } from '../../lib/researchBridge'
import { useResearchActivityStore } from '../../lib/researchActivityStore'
import type { ResearchRunDetail } from '../../types/research'

interface PlanEntry { node_id: string; round: number; tool_call_id: string; plan: Record<string, any> }
interface Reconcile { round: number; summary?: string; applied?: boolean }

export interface ResearchApprovalState {
  loading: boolean
  error: string
  plans: PlanEntry[]
  reconciles: Reconcile[]
  questions: Array<{ node_id: string; question: string }>
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/**
 * One read per run/workspace/revision, shared by mounts asking for the same version.
 *
 * The activity owner normally supplies the detail, so this is the fallback for a run it does not
 * watch yet; it must not become a second poller, so concurrent mounts join one request.
 */
const approvalReads = new Map<string, Promise<ResearchRunDetail>>()
/** Wait this long for the shared detail before reading it once ourselves. */
export const APPROVAL_FALLBACK_DELAY_MS = 1200

function readApprovalDetail(runId: string, workspace: string | undefined, revision: string): Promise<ResearchRunDetail> {
  const key = JSON.stringify([runId, workspace, revision])
  const pending = approvalReads.get(key)
  if (pending) return pending
  const read = request<ResearchRunDetail>('get_research_details', { runId, workspace })
    .finally(() => { approvalReads.delete(key) })
  approvalReads.set(key, read)
  return read
}

/** Project one run detail onto the pending approval material the cards render. */
function pendingApprovals(detail: ResearchRunDetail | null | undefined): ResearchApprovalState {
  if (!detail) return { loading: false, error: '', plans: [], reconciles: [], questions: [] }
  const graph = (detail.graph ?? {}) as ResearchRunDetail['graph']
  const awaiting = new Set((graph.nodes ?? []).filter(node => node.status === 'awaiting_approval').map(node => node.id))
  const latest = new Map<string, PlanEntry>()
  for (const plan of (graph.plans ?? []) as PlanEntry[]) {
    const older = latest.get(plan.node_id)
    if (!older || plan.round > older.round) latest.set(plan.node_id, plan)
  }
  return {
    loading: false, error: '',
    plans: [...latest.values()].filter(plan => awaiting.has(plan.node_id)),
    reconciles: ((graph.reconciles ?? []) as Reconcile[]).filter(item => !item.applied),
    questions: detail.pending_questions ?? [],
  }
}

/**
 * Pending approval material, read from the run detail the activity owner already polls.
 *
 * The same run is rendered by several mounts at once (a pill in the timeline, a second pill in
 * the history dialog, the workspace). They must all show the same card, and none of them may add
 * its own polling: the shared detail is the source, and a one-off read happens only when nothing
 * shared exists yet (or when the user asks to see the current version after a conflict).
 */
export function useResearchApprovalState(runId: string, workspace: string | undefined, enabled: boolean, revision = '') {
  const detail = useResearchActivityStore(state => state.details[runId])
  const scope = useMemo(() => ({ request: 0 }), [runId, workspace, revision, enabled])
  const currentScope = useRef<typeof scope | null>(scope)
  currentScope.current = scope
  useEffect(() => {
    currentScope.current = scope
    return () => { if (currentScope.current === scope) currentScope.current = null }
  }, [scope])
  const [read, setRead] = useState<{ scope: typeof scope; fetched: ResearchRunDetail | null; loading: boolean; error: string } | null>(null)
  const ownedRead = read?.scope === scope ? read : null
  const source = ownedRead?.fetched ?? detail
  const load = useCallback(async () => {
    if (!enabled || currentScope.current !== scope) return
    const requestId = ++scope.request
    const isCurrent = () => currentScope.current === scope && scope.request === requestId
    setRead(previous => ({ scope, fetched: previous?.scope === scope ? previous.fetched : null, loading: true, error: '' }))
    try {
      const fetched = await readApprovalDetail(runId, workspace, revision)
      if (isCurrent()) setRead({ scope, fetched, loading: false, error: '' })
    } catch (failure) {
      if (isCurrent()) setRead(previous => ({ scope, fetched: previous?.scope === scope ? previous.fetched : null, loading: false, error: messageOf(failure) }))
    }
  }, [runId, workspace, revision, enabled, scope])
  useEffect(() => {
    if (!enabled || source) return
    // The activity owner polls this run's detail already. Give it a moment to arrive before
    // reading it here, so several mounts of the same run still cause no extra traffic.
    const timer = window.setTimeout(() => { void load() }, APPROVAL_FALLBACK_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [enabled, source, load])
  return { ...pendingApprovals(source), loading: Boolean(ownedRead?.loading && !source), error: ownedRead?.error ?? '', reload: () => void load() }
}

const planVersion = (plan: PlanEntry) => plan.tool_call_id.slice(-6)

/**
 * One pending approval, rendered inside the conversation instead of a detached panel.
 *
 * 同意 sends the fenced control; 稍后 only folds the card and keeps it pending (nothing already
 * approved is paused); 还需修改 sends the revision request. A stale version is never approved:
 * the server's fence rejects it and the card reloads the current version.
 */
interface ResearchApprovalCardProps {
  runId: string
  workspace?: string
  plan?: PlanEntry
  reconcile?: Reconcile
  questions?: Array<{ node_id: string; question: string }>
  revision?: number
  onReload: () => void
}

export function ResearchApprovalCard(props: ResearchApprovalCardProps) {
  return <OwnedResearchApprovalCard key={JSON.stringify([props.runId, props.workspace, props.revision, props.plan?.tool_call_id, props.reconcile?.round])} {...props} />
}

function OwnedResearchApprovalCard({ runId, workspace, plan, reconcile, questions, revision, onReload }: ResearchApprovalCardProps) {
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [folded, setFolded] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stale, setStale] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  useEffect(() => { setError(''); setStale(false) }, [revision, plan?.tool_call_id, reconcile?.round])

  const title = useMemo(() => {
    if (reconcile) return `分支汇总待审批 · 第 ${reconcile.round} 轮`
    if (plan) return `计划待审批 · 第 ${plan.round} 轮`
    return questions?.length ? '研究等待澄清' : ''
  }, [plan, reconcile, questions?.length])
  if (!title) return null

  const control = async (action: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    if (busy) return
    setBusy(true); setError(''); setStale(false)
    try {
      // The bridge fences `approve_plan` on the node whose plan is being approved, so the node
      // travels beside the plan id: without it the board looks the plan up on no node at all and
      // reports every approval as stale (2026-10-18 e2e: 同意 looped on 该计划已更新).
      const target = plan?.node_id
      await request('control_research', { runId, workspace, action, payload, ...(target ? { nodeId: target } : {}), ...extra })
      if (!mounted.current) return
      onReload()
    } catch (failure) {
      if (!mounted.current) return
      const message = failure instanceof Error ? failure.message : String(failure)
      // The server's fence is the authority on a stale version: say so and fetch the current one.
      if (/changed since it was displayed|no longer waiting/i.test(message)) {
        setStale(true)
        setError('该计划已更新，请查看最新版本后再处理。')
        onReload()
      } else setError(message)
    } finally { if (mounted.current) setBusy(false) }
  }

  if (folded) {
    return <section className="research-approval-card is-folded" aria-label="研究计划审批">
      <button type="button" className="research-approval-folded" onClick={() => setFolded(false)}>
        <Clock3 size={13} aria-hidden="true" />
        <span>{title} · 已稍后，仍在等待你的审批</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
    </section>
  }

  return <section className="research-approval-card" aria-label="研究计划审批">
    <header className="research-approval-heading">
      <AlertTriangle size={14} aria-hidden="true" />
      <strong>{title}</strong>
      {plan && <span className="research-approval-version" title={plan.tool_call_id}>版本 {planVersion(plan)}</span>}
      {reconcile && <span className="research-approval-version">第 {reconcile.round} 轮</span>}
    </header>
    {plan && <details className="research-approval-plan" open={Boolean(plan.plan?.plan_markdown)}>
      <summary><ListChecks size={12} aria-hidden="true" />查看计划全文</summary>
      <p>{String(plan.plan?.plan_markdown ?? '（计划正文待同步）')}</p>
    </details>}
    {reconcile?.summary && <p className="research-approval-summary">{reconcile.summary}</p>}
    {questions?.map(question => <p key={question.node_id} className="research-approval-question">
      <MessageSquareQuote size={12} aria-hidden="true" />{question.question}</p>)}
    {stale && <div className="research-approval-stale" role="alert">{error}
      <button type="button" className="research-button research-button--subtle" onClick={onReload}>
        <RefreshCw size={12} aria-hidden="true" /><span>查看最新版本</span></button></div>}
    {!stale && error && <p className="research-approval-error" role="alert">{error}</p>}
    {feedbackOpen && plan && <div className="research-approval-feedback">
      <input aria-label="修改意见" value={feedback} onChange={event => setFeedback(event.target.value)}
        placeholder="说明需要修改的地方…" disabled={busy} />
      <button type="button" className="research-button research-button--primary" disabled={busy || !feedback.trim()}
        onClick={() => void control('return_plan', { feedback }, {})}>提交修改意见</button>
    </div>}
    <footer className="research-approval-actions">
      <button type="button" className="research-button research-button--primary" disabled={busy}
        onClick={() => reconcile
          ? void control('approve_reconcile', { expected_reconcile_round: reconcile.round }, { expectedRound: reconcile.round })
          : void control('approve_plan', { summary: 'Approved in the desktop research workspace.' },
            { expectedPlanId: plan?.tool_call_id })}>
        <Check size={13} aria-hidden="true" /><span>同意</span>
      </button>
      <button type="button" className="research-button research-button--subtle" disabled={busy}
        onClick={() => setFolded(true)}>稍后</button>
      {plan && <button type="button" className="research-button research-button--subtle" disabled={busy}
        aria-expanded={feedbackOpen} onClick={() => setFeedbackOpen(open => !open)}>还需修改</button>}
      <button type="button" className="research-approval-history-toggle" aria-expanded={historyOpen}
        onClick={() => setHistoryOpen(open => !open)}>
        <History size={12} aria-hidden="true" /><span>修订历史</span>
      </button>
    </footer>
    {historyOpen && <ol className="research-approval-history" aria-label="计划修订历史">
      {plan && <li><span>第 {plan.round} 轮</span><small>当前待审批 · 版本 {planVersion(plan)}</small></li>}
      {reconcile && <li><span>分支汇总 第 {reconcile.round} 轮</span><small>当前待审批</small></li>}
      {!plan && !reconcile && <li><span>尚无历史轮次</span><small>等待研究生成计划</small></li>}
    </ol>}
  </section>
}

/** All pending approvals for a run, in conversation order. */
interface ResearchApprovalCardsProps {
  runId: string
  workspace?: string
  enabled: boolean
  revision?: string
  onAnswered?: (answer: string) => void
}

export function ResearchApprovalCards(props: ResearchApprovalCardsProps) {
  return <OwnedResearchApprovalCards key={JSON.stringify([props.runId, props.workspace, props.revision, props.enabled])} {...props} />
}

function OwnedResearchApprovalCards({ runId, workspace, enabled, revision, onAnswered }: ResearchApprovalCardsProps) {
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const state = useResearchApprovalState(runId, workspace, enabled, revision)
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!enabled) return null
  const empty = !state.plans.length && !state.reconciles.length && !state.questions.length
  if (empty && !state.loading) return state.error ? <p className="research-approval-error" role="alert">{state.error}
    <button type="button" className="ml-2 underline" onClick={state.reload}>重试读取</button></p> : null
  if (empty) return <p className="research-approval-loading" role="status">正在读取待审批计划…</p>
  return <div className="research-approval-stack">
    {state.plans.map(plan => <ResearchApprovalCard key={plan.tool_call_id} runId={runId} workspace={workspace}
      plan={plan} revision={state.plans.length} onReload={state.reload} />)}
    {state.reconciles.map(item => <ResearchApprovalCard key={`reconcile-${item.round}`} runId={runId} workspace={workspace}
      reconcile={item} revision={item.round} onReload={state.reload} />)}
    {state.questions.length > 0 && <section className="research-approval-card" aria-label="研究澄清问题">
      <header className="research-approval-heading"><MessageSquareQuote size={14} aria-hidden="true" />
        <strong>研究需要你的澄清</strong></header>
      <ul className="research-approval-questions">{state.questions.map(question =>
        <li key={question.node_id}>{question.question}</li>)}</ul>
      <div className="research-approval-feedback">
        <input aria-label="澄清回答" value={answer} onChange={event => setAnswer(event.target.value)}
          placeholder="输入你的澄清答复…" disabled={busy} />
        <button type="button" className="research-button research-button--primary" disabled={busy || !answer.trim()}
          onClick={() => {
            setBusy(true); setError('')
            void executeResearchControl('resume_research', { runId, workspace, clarification: answer })
              .then(() => { if (mounted.current) { setAnswer(''); onAnswered?.(answer); state.reload() } })
              .catch(failure => { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) })
              .finally(() => { if (mounted.current) setBusy(false) })
          }}>回答并继续</button>
      </div>
      {error && <p className="research-approval-error" role="alert">{error}</p>}
    </section>}
    {state.error && <p className="research-approval-error" role="alert">{state.error}
      <button type="button" className="ml-2 underline" onClick={state.reload}>重试读取</button></p>}
  </div>
}
