import '@testing-library/jest-dom/vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResearchRunPill } from '../ResearchRunPill'
import { useSessionStore } from '../../../store/useSessionStore'
import type { ResearchRunCard } from '../../../lib/researchCards'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  requestResearch: vi.fn(),
  executeResearchControl: vi.fn(),
  sendMessage: vi.fn(),
}))

vi.mock('../../../lib/bridge', () => ({ request: mocks.request, newRequestId: () => 'answer-id' }))
vi.mock('../../../lib/startComposerResearch', () => ({ startComposerResearch: mocks.sendMessage, openResearchConversation: vi.fn() }))
vi.mock('../../../lib/researchBridge', () => ({
  requestResearch: mocks.requestResearch,
  executeResearchControl: mocks.executeResearchControl,
}))

beforeEach(() => {
  cleanup()
  mocks.request.mockReset().mockResolvedValue({ detail: null })
  mocks.executeResearchControl.mockReset().mockResolvedValue(undefined)
  mocks.sendMessage.mockReset().mockResolvedValue({ enabled: true, session: { sessionId: 'root', file: 'root.jsonl', cwd: 'C:/project' }, messages: [], run: { id: 'r_test', status: 'active', phase: 'plan' }, lastEventSeq: 0, historyVersion: null, stats: {}, contextUsage: {} })
  useSessionStore.setState({
    researchCards: {},
    activeResearchTaskId: null,
    activeResearchGraphRunId: null,
    researchTeam: null,
  })
})

describe('ResearchRunPill', () => {
  it.each(['failed', 'stopped'])('requires explicit ending before role choices after %s', status => {
    const card: ResearchRunCard = { runId: 'r_test', question: 'Compare evidence', status,
      phase: status, tasks: [], updatedAt: 100 }
    useSessionStore.setState({
      researchCards: { r_test: card },
      researchBinding: { sessionId: 'root', sessionFile: 'root.jsonl', workspace: 'C:/project', runId: 'r_test' },
      researchTeam: { teamId: 'root', scene: 'desktop_research', members: [{ id: 'reviewer', name: 'Reviewer', kind: 'task_agent',
        responsibility: 'Check evidence', goal: 'Review sources', instructions: 'Cite claims', tools: [], skills: [], status: 'ready' }] },
    })
    render(<ResearchRunPill runId="r_test" defaultExpanded />)
    expect(screen.queryByRole('checkbox', { name: '保留 Reviewer' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '结束本次研究并选择保留角色' }))
    expect(screen.getByRole('checkbox', { name: '保留 Reviewer' })).not.toBeChecked()
    expect(useSessionStore.getState().researchCards.r_test.status).toBe(status)
    expect(mocks.requestResearch).not.toHaveBeenCalled()
    // Returning to work invalidates the local ending confirmation.
    act(() => useSessionStore.setState({ researchCards: { r_test: { ...card, status: 'active' } } }))
    expect(screen.queryByRole('checkbox', { name: '保留 Reviewer' })).not.toBeInTheDocument()
  })
  it('renders collapsed state with stage and task count', () => {
    const card: ResearchRunCard = {
      runId: 'r_test',
      question: 'Comparison research',
      status: 'active',
      phase: 'critique',
      tasks: [
        { id: 't1', title: '文献检索', assignee: 'reviewer', status: 'closed' },
        { id: 't2', title: '红队审查', assignee: 'red-team', status: 'running' },
      ],
      updatedAt: 100,
    }
    useSessionStore.setState({ researchCards: { r_test: card } })

    render(<ResearchRunPill runId="r_test" />)
    expect(screen.getByText(/正在进行研究/)).toBeInTheDocument()
    expect(screen.getByText(/1\/2 项任务/)).toBeInTheDocument()
    expect(screen.queryByText('文献检索')).not.toBeInTheDocument()
  })

  it('expands to reveal multi-agent tasks and opens task drawer on task click', () => {
    const card: ResearchRunCard = {
      runId: 'r_test',
      question: 'Comparison research',
      status: 'active',
      phase: 'branches',
      tasks: [
        { id: 't1', title: '文献检索', assignee: 'reviewer', status: 'closed' },
        { id: 't2', title: '红队审查', assignee: 'red-team', status: 'running' },
      ],
      updatedAt: 100,
    }
    useSessionStore.setState({ researchCards: { r_test: card } })

    render(<ResearchRunPill runId="r_test" />)
    fireEvent.click(screen.getByRole('button', { name: /展开研究过程|收起研究过程/ }))

    expect(screen.getByText('文献检索')).toBeInTheDocument()
    expect(screen.getByText('红队审查')).toBeInTheDocument()
    expect(screen.getByText(/Sister reviewer/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /查看任务 文献检索/ }))
    expect(useSessionStore.getState().activeResearchTaskId).toEqual({
      runId: 'r_test',
      taskId: 't1',
    })
  })

  it('allows answering clarification questions and resumes the run', async () => {
    useSessionStore.setState({ researchBinding: { sessionId: 'root', sessionFile: 'root.jsonl', workspace: 'C:/project', runId: 'r_test' } })
    const card: ResearchRunCard = {
      runId: 'r_test',
      question: 'Comparison research',
      status: 'waiting_input',
      phase: 'active',
      tasks: [],
      pendingQuestions: ['是否包含非开源模型？'],
      updatedAt: 100,
    }
    useSessionStore.setState({ researchCards: { r_test: card } })

    render(<ResearchRunPill runId="r_test" />)
    expect(screen.getByText('是否包含非开源模型？')).toBeInTheDocument()

    const input = screen.getByRole('textbox', { name: '澄清回答' })
    fireEvent.change(input, { target: { value: '只考虑开源模型' } })
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))

    await waitFor(() => {
      expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        binding: expect.objectContaining({ runId: 'r_test' }),
        question: '只考虑开源模型',
      }))
    })
  })

  it('triggers opening research graph DAG modal', () => {
    const card: ResearchRunCard = {
      runId: 'r_test',
      question: 'Comparison research',
      status: 'active',
      phase: 'active',
      tasks: [],
      updatedAt: 100,
    }
    useSessionStore.setState({ researchCards: { r_test: card } })

    render(<ResearchRunPill runId="r_test" defaultExpanded />)
    fireEvent.click(screen.getByRole('button', { name: /查看研究拓扑图/ }))
    expect(useSessionStore.getState().activeResearchGraphRunId).toBe('r_test')
  })
})
