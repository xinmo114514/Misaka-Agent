import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResearchWorkbench } from './ResearchWorkbench'
import { useSessionStore } from '../../store/useSessionStore'

const mocks = vi.hoisted(() => ({ request: vi.fn(), newRequestId: vi.fn(() => 'research-operation-id'), requestResearch: vi.fn(), startHost: vi.fn(), refreshRuns: vi.fn(), refreshGraph: vi.fn(), selectNode: vi.fn() }))
vi.mock('../../lib/bridge', () => ({ request: mocks.request, newRequestId: mocks.newRequestId }))
vi.mock('../../lib/researchBridge', () => ({ requestResearch: mocks.requestResearch, addResearchSink: vi.fn(() => () => {}), installResearchBridge: vi.fn() }))
vi.mock('./ResearchGraphCanvas', () => ({
  ResearchGraphCanvas: (props: any) => <><div data-testid="research-graph">Research graph fixture</div>
    <button onClick={() => props.onSelectNode?.({ id: 'b_root', question: run.question, kind: 'root', depth: 0,
      status: 'awaiting_approval', parents: [], children: [], cards: [], reached_by: [] })}>选择根节点</button></>,
}))

const run = {
  id: 'r_workbench', question: 'RAG versus long context', workspace: 'C:/project',
  status: 'active', phase: 'active', nodes: 1, tasks: 2,
  final_artifact: 'a_report', rootSession: 'C:/session/root.jsonl',
}
const runDetail = {
  run,
  graph: {
    run: run.id, question: run.question, status: 'active', phase: 'active', limits: {},
    nodes: [{ id: 'b_root', question: run.question, depth: 0, status: 'awaiting_approval',
      kind: 'root', parents: [], children: [], cards: [] }],
    final_artifacts: [{ id: 'a_report', kind: 'final', title: 'Final report', path: 'final/report.md', state: 'available' }],
  },
  pending_questions: [],
}

beforeEach(() => {
  mocks.request.mockReset().mockImplementation(async (type: string) => {
    if (type === 'get_research_options') return { defaults: { max_depth: 3, parallel: 4, sister_parallel: 4,
      max_followups: 2, max_revisions: 2, max_nodes: 30, plan_approval: true },
      constraints: {}, sisters: [{ id: 'SISTER', name: 'Sister', description: '' }] }
    if (type === 'get_active_research_runs') return { runs: [run] }
    if (type === 'get_research_details') return runDetail
    if (type === 'get_research_artifact') return { detail: { ...runDetail.graph.final_artifacts[0], content: '# Report\n\nReferences\n\n[1] Source material.' } }
    if (type === 'get_research_node') return { detail: {
      node: { id: 'b_root', question: run.question, depth: 0, status: 'awaiting_approval', kind: 'root' },
      plan_round: 1, plan: { plan_markdown: 'Test plan', tasks: [] }, plan_tool_call_id: 'plan-revision-1',
      available_tools: ['misaka_research_assign', 'misaka_research_start'],
      cards: [], artifacts: [], findings: [], issues: [], errata: [], red_team: null,
    } }
    return { detail: null }
  })
  mocks.newRequestId.mockClear().mockReturnValue('research-operation-id')
  mocks.refreshRuns.mockClear()
  mocks.refreshGraph.mockClear()
  mocks.requestResearch.mockReset().mockResolvedValue({ accepted: true })
  mocks.startHost.mockReset().mockResolvedValue({ enabled: true, session: { file: 'root.jsonl' }, stats: { totalMessages: 12 }, contextUsage: { tokens: 3200, contextWindow: 128000, percent: 0.025 } })
  useSessionStore.setState({
    currentWorkspace: 'C:/project',
    researchRuns: [run],
    researchRunId: run.id,
    researchGraph: runDetail.graph as any,
    fetchResearchRuns: mocks.refreshRuns,
    fetchResearchGraph: mocks.refreshGraph,
  })
  window.app = { ...window.app, startResearchBridge: mocks.startHost, setResearchActive: vi.fn() } as typeof window.app
})

describe('ResearchWorkbench', () => {
  it('renders distinct simultaneous approval state and the live DAG', async () => {
    render(<ResearchWorkbench />)
    expect(await screen.findByText('研究工作台')).toBeInTheDocument()
    expect(await screen.findByText('待审批 1')).toBeInTheDocument()
    expect(screen.getByTestId('research-graph')).toBeInTheDocument()
  })

  it('opens the verified full report and exports a Markdown file', async () => {
    render(<ResearchWorkbench />)
    fireEvent.click(await screen.findByRole('button', { name: /打开最终报告/ }))
    expect(await screen.findByRole('dialog', { name: '研究报告' })).toBeInTheDocument()
    expect(await screen.findByText('References')).toBeInTheDocument()
    expect(mocks.request).toHaveBeenCalledWith('get_research_artifact', {
      runId: run.id, artifactId: 'a_report', workspace: run.workspace,
    })
    expect(screen.getByRole('button', { name: /导出 Markdown/ })).toBeEnabled()
  })

  it('binds plan approval to the exact plan version displayed in the detail pane', async () => {
    render(<ResearchWorkbench />)
    fireEvent.click(await screen.findByRole('button', { name: '选择根节点' }))
    fireEvent.click(await screen.findByRole('button', { name: '批准计划' }))
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('control_research', expect.objectContaining({
      runId: run.id, nodeId: 'b_root', action: 'approve_plan', expectedPlanId: 'plan-revision-1',
      workspace: run.workspace,
    })))
  })

  it('keeps context compaction disabled while the research driver is active', async () => {
    render(<ResearchWorkbench />)
    expect(await screen.findByText('研究工作台')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '压缩研究会话' })).not.toBeInTheDocument()
  })

  it('shows context usage and reuses engine compaction for a stopped research session', async () => {
    const stoppedRun = { ...run, status: 'stopped', phase: 'stopped', driving: false }
    const stoppedDetail = { ...runDetail, run: stoppedRun,
      root_context: { stats: { totalMessages: 12 }, contextUsage: { tokens: 3200, contextWindow: 128000, percent: 0.025 } } }
    useSessionStore.setState({ researchRuns: [stoppedRun], researchGraph: { ...runDetail.graph, status: 'stopped', phase: 'stopped' } as any })
    mocks.request.mockImplementation(async (type: string) => {
      if (type === 'get_research_options') return { defaults: runDetail.graph.limits, constraints: {}, sisters: [{ id: 'SISTER', name: 'Sister', description: '' }] }
      if (type === 'get_active_research_runs') return { runs: [] }
      if (type === 'get_research_details') return stoppedDetail
      return { detail: null }
    })
    render(<ResearchWorkbench />)

    expect(await screen.findByText(/上下文 3,200 \/ 128,000/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '压缩研究会话' }))
    const dialog = await screen.findByRole('dialog', { name: '手动压缩会话' })
    fireEvent.change(screen.getByRole('textbox', { name: '自定义压缩指令' }), { target: { value: '保留全部来源页码' } })
    fireEvent.click(screen.getByRole('button', { name: '立即压缩' }))

    await waitFor(() => expect(mocks.startHost).toHaveBeenCalledWith({ cwd: run.workspace, sessionFile: run.rootSession }))
    await waitFor(() => expect(mocks.requestResearch).toHaveBeenCalledWith('compact_session', expect.objectContaining({
      customInstructions: '保留全部来源页码',
    })))
    expect(dialog).toBeInTheDocument()
  })
})
