import '@testing-library/jest-dom/vitest'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { act, render, screen, cleanup } from '@testing-library/react'
import { ResearchProgressArea } from '../ResearchProgressArea'
import { useSessionStore } from '../../../store/useSessionStore'
import { useResearchActivityStore } from '../../../lib/researchActivityStore'
vi.mock('../../../lib/bridge', () => ({request:vi.fn(async () => ({runs:[]})),newRequestId:()=> 'test'}))
beforeEach(() => { useResearchActivityStore.setState({errors:{},lastSuccess:{},now:700000}); useSessionStore.setState({researchCards:{r:{runId:'r',question:'Q',status:'active',phase:'research',tasks:[{id:'a',title:'A',assignee:'X',status:'done'},{id:'b',title:'B',assignee:'X',status:'running'},{id:'c',title:'C',assignee:'X',status:'failed'}],startedAt:100,lastActivityAt:300000,updatedAt:1}},researchSnapshots:{},researchBinding:null}) })
afterEach(cleanup)
describe('persistent real research progress', () => {
 it('shows actual counts, meaningful activity and no estimated percentage', () => { render(<ResearchProgressArea runId="r" />); expect(screen.getByText('已完成 1/3 · 运行 1 · 失败 1')).toBeInTheDocument(); expect(screen.getByText('正在研究，暂无需回复')).toBeInTheDocument(); expect(screen.getByText(/较长时间无更新/)).toBeInTheDocument(); expect(screen.getByText(/运行时长 10 分钟/)).toBeInTheDocument(); expect(screen.queryByText(/%|剩余时间/)).not.toBeInTheDocument() })
 it('shows sync error while preserving last successful data', () => { useResearchActivityStore.setState({errors:{'run:r':'bridge disconnected'},lastSuccess:{'run:r':650000}}); render(<ResearchProgressArea runId="r" />); expect(screen.getByRole('alert')).toHaveTextContent('bridge disconnected'); expect(screen.getByText(/最后成功同步/)).toBeInTheDocument(); expect(screen.getByText('已完成 1/3 · 运行 1 · 失败 1')).toBeInTheDocument() })
 it('status beats active phase and waiting requires actual questions', () => {render(<ResearchProgressArea runId="r" />); act(() => useSessionStore.setState(s=>({researchCards:{r:{...s.researchCards.r,status:'failed',phase:'active',error:'provider failed'}}}))); expect(screen.getByText('失败')).toBeInTheDocument(); expect(screen.queryByText('正在研究，暂无需回复')).not.toBeInTheDocument(); act(() => useSessionStore.setState(s=>({researchCards:{r:{...s.researchCards.r,status:'waiting_input',pendingQuestions:[]}}}))); expect(screen.queryByText('等待你的回答')).not.toBeInTheDocument(); act(() => useSessionStore.setState(s=>({researchCards:{r:{...s.researchCards.r,pendingQuestions:['why']}}}))); expect(screen.getByText('等待你的回答')).toBeInTheDocument() })
})
