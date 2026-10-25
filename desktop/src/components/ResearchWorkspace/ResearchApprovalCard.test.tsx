import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { ResearchApprovalCard, ResearchApprovalCards, useResearchApprovalState } from './ResearchApprovalCard'
import { request } from '../../lib/bridge'
import { executeResearchControl } from '../../lib/researchBridge'
import { useResearchActivityStore } from '../../lib/researchActivityStore'

vi.mock('../../lib/bridge', () => ({ request: vi.fn() }))
vi.mock('../../lib/researchBridge', () => ({ executeResearchControl: vi.fn() }))

const plan = { node_id: 'n1', round: 2, tool_call_id: 'plan-tool-abcdef', plan: { plan_markdown: 'Review evidence' } }
/** `get_research_details` answers the detail payload itself, not a wrapper. */
const detail = (extra: Record<string, unknown> = {}) => ({
  run: { id: 'r', status: 'waiting_input' },
  graph: { nodes: [{ id: 'n1', status: 'awaiting_approval' }], plans: [plan], reconciles: [] },
  pending_questions: [],
  ...extra,
})
/** The activity owner polls this run, so the shared detail is what the cards read. */
const share = (value: Record<string, unknown>) => useResearchActivityStore.setState({
  details: { r: value as never },
})

beforeEach(() => {
  vi.mocked(request).mockReset().mockResolvedValue(detail())
  vi.mocked(executeResearchControl).mockReset().mockResolvedValue(undefined)
  useResearchActivityStore.setState({ details: {} })
  share(detail())
})

describe('in-conversation plan approval', () => {
  it.each(['run', 'workspace', 'revision'])('fences hook reads and errors when the %s changes without unmounting', async change => {
    let rejectOld!: (reason: Error) => void
    let finishNew!: (value: any) => void
    vi.mocked(request).mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve }))
    const view = renderHook(({ runId, workspace, revision }) => useResearchApprovalState(runId, workspace, true, revision),
      { initialProps: { runId: 'r', workspace: 'C:/A', revision: '1' } })
    act(() => view.result.current.reload())
    view.rerender({ runId: change === 'run' ? 'B' : 'r', workspace: change === 'workspace' ? 'C:/B' : 'C:/A', revision: change === 'revision' ? '2' : '1' })
    act(() => view.result.current.reload())
    expect(request).toHaveBeenCalledTimes(2)
    await act(async () => { rejectOld(new Error('Old owner read failed')); await Promise.resolve() })
    expect(view.result.current.error).toBe('')
    await act(async () => { finishNew(detail({ pending_questions: [{ node_id: 'new', question: 'Current question' }] })); await Promise.resolve() })
    expect(view.result.current.questions).toEqual([{ node_id: 'new', question: 'Current question' }])
  })

  it.each(['owner', 'revision'])('discards a held approval reload after the %s changes and clears the old answer', async change => {
    let finish!: (value: any) => void
    const oldDetail = detail({ pending_questions: [{ node_id: 'n1', question: 'Question A' }] })
    const nextDetail = detail({ run: { id: change === 'owner' ? 'B' : 'r', status: 'waiting_input' },
      graph: { nodes: [], plans: [], reconciles: [] }, pending_questions: [{ node_id: 'n2', question: 'Question B' }] })
    share(oldDetail)
    vi.mocked(request).mockImplementation((type: string) => type === 'get_research_details' ? new Promise(resolve => { finish = resolve }) : Promise.resolve({}))
    const view = render(<ResearchApprovalCards runId="r" workspace="C:/A" enabled revision="1" />)
    fireEvent.change(screen.getByLabelText('澄清回答'), { target: { value: 'Answer for A' } })
    fireEvent.click(screen.getByRole('button', { name: '同意' }))
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    act(() => useResearchActivityStore.setState({ details: { r: nextDetail as never, B: nextDetail as never } }))
    view.rerender(<ResearchApprovalCards runId={change === 'owner' ? 'B' : 'r'} workspace={change === 'owner' ? 'C:/B' : 'C:/A'} enabled revision="2" />)
    await act(async () => { finish(oldDetail); await Promise.resolve() })
    expect(screen.getByText('Question B')).toBeInTheDocument()
    expect(screen.queryByText('Question A')).not.toBeInTheDocument()
    expect(screen.getByLabelText('澄清回答')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: '回答并继续' }))
    expect(executeResearchControl).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('澄清回答'), { target: { value: 'Answer for B' } })
    fireEvent.click(screen.getByRole('button', { name: '回答并继续' }))
    expect(executeResearchControl).toHaveBeenCalledExactlyOnceWith('resume_research', { runId: change === 'owner' ? 'B' : 'r', workspace: change === 'owner' ? 'C:/B' : 'C:/A', clarification: 'Answer for B' })
    await act(async () => { await Promise.resolve(); finish(nextDetail) })
  })

  it('reads the pending plan from the shared detail and sends the fenced approve control', async () => {
    render(<ResearchApprovalCards runId="r" workspace="C:/w" enabled />)
    const approve = await screen.findByRole('button', { name: '同意' })
    // No extra read: the activity owner already polled this run.
    expect(request).not.toHaveBeenCalledWith('get_research_details', expect.anything())
    fireEvent.click(approve)
    await waitFor(() => expect(request).toHaveBeenCalledWith('control_research', {
      runId: 'r', workspace: 'C:/w', action: 'approve_plan',
      payload: { summary: 'Approved in the desktop research workspace.' }, expectedPlanId: 'plan-tool-abcdef',
      // The bridge resolves the plan on this node; without it every approval reads as stale.
      nodeId: 'n1',
    }))
  })

  it('keeps a 稍后 card pending without pausing anything else', async () => {
    render(<ResearchApprovalCards runId="r" workspace="C:/w" enabled />)
    await screen.findByRole('button', { name: '同意' })
    fireEvent.click(screen.getByRole('button', { name: '稍后' }))
    expect(screen.getByText(/已稍后，仍在等待你的审批/)).toBeInTheDocument()
    // Collapsing is presentation only: no control was sent, so other cards keep running.
    expect(request).not.toHaveBeenCalledWith('control_research', expect.anything())
    fireEvent.click(screen.getByRole('button', { name: /已稍后/ }))
    expect(screen.getByRole('button', { name: '同意' })).toBeInTheDocument()
  })

  it('sends the revision request with the typed feedback', async () => {
    render(<ResearchApprovalCards runId="r" workspace="C:/w" enabled />)
    await screen.findByRole('button', { name: '同意' })
    fireEvent.click(screen.getByRole('button', { name: '还需修改' }))
    fireEvent.change(screen.getByLabelText('修改意见'), { target: { value: '补一个对照组' } })
    fireEvent.click(screen.getByRole('button', { name: '提交修改意见' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('control_research', {
      runId: 'r', workspace: 'C:/w', action: 'return_plan', payload: { feedback: '补一个对照组' }, nodeId: 'n1',
    }))
  })

  it('maps a stale-version rejection to Chinese and reloads the current version', async () => {
    vi.mocked(request).mockImplementation(async (type: string) => {
      if (type === 'control_research') throw new Error('This plan changed since it was displayed. Refresh and review the current version.')
      return detail()
    })
    render(<ResearchApprovalCards runId="r" workspace="C:/w" enabled />)
    fireEvent.click(await screen.findByRole('button', { name: '同意' }))
    expect(await screen.findByText('该计划已更新，请查看最新版本后再处理。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /查看最新版本/ })).toBeInTheDocument()
    // A stale plan is never silently approved a second time.
    expect(vi.mocked(request).mock.calls.filter(call => call[0] === 'control_research')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /查看最新版本/ }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('get_research_details', { runId: 'r', workspace: 'C:/w' }))
  })

  it('shows the reconciliation round fence instead of a plan fence', async () => {
    share(detail({
      graph: { nodes: [{ id: 'n1', status: 'awaiting_approval' }], plans: [], reconciles: [{ round: 3, summary: '汇总两个分支' }] },
    }))
    render(<ResearchApprovalCards runId="r" workspace="C:/w" enabled />)
    expect(await screen.findByText('分支汇总待审批 · 第 3 轮')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '同意' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('control_research', expect.objectContaining({
      action: 'approve_reconcile', expectedRound: 3,
    })))
  })

  it('answers a clarification through the resume control', async () => {
    share(detail({
      graph: { nodes: [{ id: 'n1', status: 'waiting_input' }], plans: [], reconciles: [] },
      pending_questions: [{ node_id: 'n1', question: '用哪个时间范围？' }],
    }))
    render(<ResearchApprovalCards runId="r" workspace="C:/w" enabled />)
    expect(await screen.findByText('用哪个时间范围？')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('澄清回答'), { target: { value: '最近五年' } })
    fireEvent.click(screen.getByRole('button', { name: '回答并继续' }))
    await waitFor(() => expect(executeResearchControl).toHaveBeenCalledWith('resume_research', {
      runId: 'r', workspace: 'C:/w', clarification: '最近五年',
    }))
  })

  it('renders nothing when nothing is pending', async () => {
    share(detail({ graph: { nodes: [], plans: [], reconciles: [] } }))
    const { container } = render(<ResearchApprovalCards runId="r" workspace="C:/w" enabled />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('keeps the revision history behind a disclosure', () => {
    render(<ResearchApprovalCard runId="r" plan={plan} revision={2} onReload={vi.fn()} />)
    const toggle = screen.getByRole('button', { name: /修订历史/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: '计划修订历史' })).not.toBeInTheDocument()
    fireEvent.click(toggle)
    const history = screen.getByRole('list', { name: '计划修订历史' })
    expect(within(history).getByText('第 2 轮')).toBeInTheDocument()
  })

  it('names the plan version so two pending rounds are distinguishable', () => {
    render(<ResearchApprovalCard runId="r" plan={plan} onReload={vi.fn()} />)
    expect(screen.getByText('版本 abcdef')).toBeInTheDocument()
    expect(screen.getByText('计划待审批 · 第 2 轮')).toBeInTheDocument()
  })

  it('reloads a replacement plan on the same pending node', async () => {
    let version = 1
    const current = () => detail({
      graph: { nodes: [{ id: 'n1', status: 'awaiting_approval' }], reconciles: [],
        plans: [{ node_id: 'n1', round: version, tool_call_id: `plan-${version}`, plan: { plan_markdown: `Design ${version}` } }] },
    })
    share(current())
    const view = render(<ResearchApprovalCards runId="r" workspace="C:/w" enabled revision="plan-1" />)
    await screen.findByText('Design 1')
    version = 2
    share(current())
    view.rerender(<ResearchApprovalCards runId="r" workspace="C:/w" enabled revision="plan-2" />)
    expect(await screen.findByText('Design 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '同意' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('control_research', expect.objectContaining({ expectedPlanId: 'plan-2' })))
  })
})
