import '@testing-library/jest-dom/vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResearchRunPill } from '../ResearchRunPill'
import { useSessionStore } from '../../../store/useSessionStore'
import { useResearchStopStore } from '../../../store/useResearchStopStore'
import { useResearchRunStore } from '../../../store/useResearchRunStore'
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
  useResearchStopStore.setState({byRun:{}})
  useResearchRunStore.setState({runs:{}})
  mocks.request.mockReset().mockResolvedValue({ detail: null })
  mocks.executeResearchControl.mockReset().mockResolvedValue(undefined)
  mocks.sendMessage.mockReset().mockResolvedValue({ enabled: true, session: { sessionId: 'root', file: 'root.jsonl', cwd: 'C:/project' }, messages: [], run: { id: 'r_test', status: 'active', phase: 'plan' }, lastEventSeq: 0, historyVersion: null, stats: {}, contextUsage: {} })
  useSessionStore.setState({
    researchCards: {},
    researchRuns: [],
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

it('clarification completion after A-to-new-to-A navigation leaves the editor untouched', async () => {
 let finish!: (host:any)=>void
 mocks.sendMessage.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
 useSessionStore.setState({agentMode:'research',researchPageView:'conversation',researchBinding:{sessionId:'root',sessionFile:'root.jsonl',workspace:'C:/project',runId:'r_test'},researchCards:{r_test:{runId:'r_test',question:'q',status:'waiting_input',phase:'active',tasks:[],pendingQuestions:['question'],updatedAt:1}}})
 render(<ResearchRunPill runId="r_test" />)
 fireEvent.change(screen.getByRole('textbox',{name:'澄清回答'}),{target:{value:'answer'}})
 fireEvent.click(screen.getByRole('button',{name:'提交回答'}))
 act(()=>useSessionStore.getState().setResearchPageView('new'))
 await act(async()=>finish({session:{sessionId:'root',file:'root.jsonl',cwd:'C:/project'},messages:[],run:{id:'r_test',status:'waiting_input'}}))
 expect(useSessionStore.getState().researchPageView).toBe('new')
 expect(screen.getByRole('textbox',{name:'澄清回答'})).toHaveValue('answer')
})
it.each(['waiting_input','failed','stopped','done'])('zero tasks do not pretend to plan while status is %s', status => {
 useSessionStore.setState({researchCards:{r_test:{runId:'r_test',question:'Q',status,phase:'active',tasks:[],pendingQuestions:status==='waiting_input'?['Which source?']:[],updatedAt:1}}})
 render(<ResearchRunPill runId="r_test" defaultExpanded/>)
 expect(screen.queryByText('正在根据课题规划研究节点与分工…')).not.toBeInTheDocument()
 expect(screen.getByText(status==='waiting_input'?'尚未创建任务，等待你的回答':'暂无任务记录')).toBeInTheDocument()
})

it('shows the shared stop wait in the title and actions, then exposes retry after uncertainty',()=>{
 const stop=vi.fn(), refresh=vi.fn().mockResolvedValue(undefined)
 useSessionStore.setState({requestResearchStop:stop,fetchResearchCardDetails:refresh,researchCards:{r_test:{runId:'r_test',question:'Q',workspace:'C:/project',status:'stopping',phase:'active',tasks:[],updatedAt:1}}})
 useResearchStopStore.getState().begin('r_test','attempt')
 const view=render(<ResearchRunPill runId="r_test" defaultExpanded/>)
 expect(view.getAllByText(/正在停止/).length).toBeGreaterThan(0)
 expect(view.queryByText(/正在进行研究/)).not.toBeInTheDocument()
 act(()=>useResearchStopStore.getState().unconfirm('r_test','attempt','lease unresolved'))
 expect(view.getByRole('status')).toHaveTextContent('lease unresolved')
 fireEvent.click(view.getByRole('button',{name:'刷新'}));expect(refresh).toHaveBeenCalledWith('r_test')
 fireEvent.click(view.getByRole('button',{name:'重试停止'}));expect(stop).not.toHaveBeenCalled()
 fireEvent.click(view.getByRole('button',{name:'确认停止'}))
 expect(stop).toHaveBeenCalledWith(expect.objectContaining({kind:'run',runId:'r_test',workspace:'C:/project'}))
})

it('does not mistake a rejected stop for a failed research run',()=>{
 useResearchStopStore.getState().begin('r_test','attempt')
 useResearchStopStore.getState().fail('r_test','attempt','stop rejected')
 useSessionStore.setState({researchCards:{r_test:{runId:'r_test',question:'Q',workspace:'C:/project',status:'active',phase:'active',error:'stop rejected',tasks:[],updatedAt:1}}})
 render(<ResearchRunPill runId="r_test" defaultExpanded />)
 expect(screen.getAllByRole('alert').some(node=>node.textContent?.includes('stop rejected'))).toBe(true)
 expect(screen.queryByText('研究遇到错误暂停')).not.toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'重试/恢复'})).not.toBeInTheDocument()
 expect(screen.getByRole('button',{name:'重试停止'})).toBeInTheDocument()
})

it('uses a fresh settled summary for the pill title over a stale stopping card/listing',()=>{
 useResearchRunStore.getState().applyListing({runId:'r_test',run:{id:'r_test',question:'Q',workspace:'C:/project',status:'stopping',phase:'stopping',nodes:1,tasks:1,driving:true,stop_requested:true,updatedAt:1},graph:{run:'r_test',question:'Q',status:'stopping',phase:'stopping',nodes:[]},sessions:[],suspension:null,suspensions:[]} as never)
 useSessionStore.setState({researchRuns:[{id:'r_test',question:'Q',workspace:'C:/project',status:'stopped',phase:'stopped',nodes:1,tasks:1,driving:false,updatedAt:2}],researchCards:{r_test:{runId:'r_test',question:'Q',workspace:'C:/project',status:'stopping',phase:'stopping',tasks:[],updatedAt:1}}})
 render(<ResearchRunPill runId="r_test" defaultExpanded />)
 expect(screen.getByText('研究已暂停')).toBeInTheDocument()
 expect(screen.queryByText(/正在进行研究/)).not.toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'重试停止'})).not.toBeInTheDocument()
})

it('titles a stopped row with live lease as stopping until authoritative rest',()=>{
 useResearchStopStore.getState().begin('r_test','attempt')
 useSessionStore.setState({researchRuns:[{id:'r_test',question:'Q',workspace:'C:/project',status:'stopped',phase:'stopped',nodes:1,tasks:1,driving:true,updatedAt:2}],researchCards:{r_test:{runId:'r_test',question:'Q',workspace:'C:/project',status:'stopped',phase:'stopped',tasks:[],updatedAt:2}}})
 const view=render(<ResearchRunPill runId="r_test" defaultExpanded />)
 expect(view.getByText('研究正在停止 · 等待结算')).toBeInTheDocument()
 expect(view.queryByText('研究已暂停')).not.toBeInTheDocument()
 act(()=>{
   useResearchStopStore.getState().clear('r_test','attempt')
   useSessionStore.setState({researchRuns:[{id:'r_test',question:'Q',workspace:'C:/project',status:'stopped',phase:'stopped',nodes:1,tasks:1,driving:false,updatedAt:3}]})
 })
 expect(view.getByText('研究已暂停')).toBeInTheDocument()
})
