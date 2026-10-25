import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { ResearchRunPill } from '../ResearchRunPill'
import { ResearchHistoryDialog } from '../ResearchHistoryDialog'
import { useSessionStore } from '../../../store/useSessionStore'
import { useResearchActivityStore, acceptResearchResume, beginResearchControl, researchActivity } from '../../../lib/researchActivityStore'
const mocks=vi.hoisted(()=>({request:vi.fn(),control:vi.fn()}))
vi.mock('../../../lib/bridge',()=>({request:mocks.request,newRequestId:()=> 'test'}))
vi.mock('../../../lib/researchBridge',()=>({executeResearchControl:mocks.control,requestResearch:vi.fn()}))
const run={id:'r',question:'Test research',status:'active',phase:'active',workspace:'/w',tasks:0,nodes:0}
let status='active'
beforeEach(()=> {vi.useFakeTimers();status='active';mocks.request.mockReset().mockImplementation(async(type:string)=> type==='get_research_details' ? {run:{...run,status,last_error:status==='failed'?'provider failed':null},graph:{run:'r',question:'Test research',status,phase:'active',nodes:[]}} : {runs:type==='get_active_research_runs' && status!=='active'?[]:[{...run,status}]});useSessionStore.setState({researchCards:{},researchRuns:[run],researchHistoryOpen:true,researchBinding:null,researchTeam:null,researchSnapshots:{}});useResearchActivityStore.setState({errors:{},lastSuccess:{},details:{},activeIds:[]})})
afterEach(()=> {cleanup();researchActivity.stop();vi.useRealTimers()})
describe('shared activity UI integration',()=>{
 it('history and two pills share one activity and detail refresh and converge to failed',async()=>{render(<><ResearchHistoryDialog/><ResearchRunPill runId="r"/><ResearchRunPill runId="r"/></>); await act(async()=>{await vi.advanceTimersByTimeAsync(1)});expect(mocks.request.mock.calls.filter(([type])=>type==='get_active_research_runs')).toHaveLength(1);expect(mocks.request.mock.calls.filter(([type])=>type==='get_research_details')).toHaveLength(1);status='failed';await act(async()=>{await vi.advanceTimersByTimeAsync(4000)});expect(useSessionStore.getState().researchCards.r.status).toBe('failed');expect(screen.getAllByText('provider failed').length).toBeGreaterThan(0);expect(screen.getAllByText('失败').length).toBeGreaterThan(0)})
 it('sync failure remains visible without erasing cached tasks',async()=> {render(<ResearchRunPill runId="r"/>);await act(async()=>{await vi.advanceTimersByTimeAsync(1)});mocks.request.mockRejectedValue(new Error('bridge disconnected'));await act(async()=>{await vi.advanceTimersByTimeAsync(4000)});expect(screen.getByRole('alert')).toHaveTextContent('bridge disconnected');expect(useSessionStore.getState().researchCards.r.status).toBe('active')})
 it('explicit resume opens epoch while an earlier active response stays fenced',async()=>{useSessionStore.setState({researchCards:{r:{runId:'r',question:'Q',status:'failed',phase:'active',tasks:[],updatedAt:1}}});beginResearchControl('r');acceptResearchResume('r');expect(useSessionStore.getState().researchCards.r.status).toBe('active');expect(useSessionStore.getState().researchCards.r.controlEpoch).toBe(1)})
})
