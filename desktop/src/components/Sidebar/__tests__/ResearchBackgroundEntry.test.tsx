import { openResearchConversation } from '../../../lib/startComposerResearch'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ResearchBackgroundEntry } from '../ResearchBackgroundEntry'
import { useSessionStore } from '../../../store/useSessionStore'
import { useResearchStopStore } from '../../../store/useResearchStopStore'
import { useResearchRunStore } from '../../../store/useResearchRunStore'
vi.mock('../../../lib/startComposerResearch',()=>({openResearchConversation:vi.fn()}))
beforeEach(()=>{useResearchStopStore.setState({byRun:{}});useResearchRunStore.setState({runs:{}});useSessionStore.setState({researchRuns:[]});vi.spyOn(window,'confirm').mockReturnValue(true)})
afterEach(()=>{cleanup();vi.restoreAllMocks()})
/** The entry folds its actions behind a disclosure so the session list stays quiet. */
const expand = () => fireEvent.click(screen.getByRole('button',{name:/后台研究/}))
it('retains background stop and details while browsing a terminal history run',()=>{const stop=vi.fn();useSessionStore.setState({agentMode:'research',researchPageView:'conversation',researchBinding:{sessionId:'old',sessionFile:'/old',workspace:'/old',runId:'old'},researchCards:{old:{runId:'old',question:'Old',status:'done',phase:'done',tasks:[],updatedAt:1},live:{runId:'live',question:'Live topic',workspace:'/live',status:'active',phase:'research',tasks:[],updatedAt:1}},researchBindings:{},requestResearchStop:stop});render(<ResearchBackgroundEntry/>);expect(screen.getByText('后台研究 · Live topic')).toBeInTheDocument();expand();fireEvent.click(screen.getByRole('button',{name:'停止后台课题'}));expect(stop).toHaveBeenCalledWith(expect.objectContaining({kind:'run',runId:'live',workspace:'/live'}));fireEvent.click(screen.getByRole('button',{name:'查看研究详情'}));expect(useSessionStore.getState().activeResearchGraphRunId).toBe('live')})

it('dismissed background stop leaves the original run untouched',()=>{
 const stop=vi.fn();useSessionStore.setState({requestResearchStop:stop,researchCards:{live:{runId:'live',question:'Q',workspace:'/live',status:'active',phase:'active',tasks:[],updatedAt:1}},researchBinding:null,researchPageView:'new'})
 vi.mocked(window.confirm).mockReturnValue(false)
 render(<ResearchBackgroundEntry/>);expand();fireEvent.click(screen.getByRole('button',{name:'停止后台课题'}));expect(stop).not.toHaveBeenCalled()
})
it('confirmed stop retains the target captured before confirmation changed the page',()=>{
 const stop=vi.fn();useSessionStore.setState({requestResearchStop:stop,researchCards:{live:{runId:'live',question:'Q',workspace:'/live',status:'active',phase:'active',tasks:[],updatedAt:1}},researchBinding:null,researchPageView:'new'})
 vi.mocked(window.confirm).mockImplementation(()=>{useSessionStore.setState({researchPageVersion:42,researchBinding:{sessionId:'different',sessionFile:'/different',workspace:'/different',runId:'different'}});return true})
 render(<ResearchBackgroundEntry/>);expand();fireEvent.click(screen.getByRole('button',{name:'停止后台课题'}));expect(stop).toHaveBeenCalledWith(expect.objectContaining({runId:'live',workspace:'/live'}))
})
it('late open failure cannot contaminate a new background entry',async()=>{
 let reject!:(error:Error)=>void;vi.mocked(openResearchConversation).mockImplementationOnce(()=>new Promise((_,fail)=>{reject=fail}))
 useSessionStore.setState({researchPageVersion:1,researchCards:{live:{runId:'live',question:'Q',workspace:'/live',status:'active',phase:'active',tasks:[],updatedAt:1}},researchBinding:null,researchPageView:'new'})
 render(<ResearchBackgroundEntry/>);expand();fireEvent.click(screen.getByRole('button',{name:'返回研究'}))
 act(()=>useSessionStore.setState({researchPageVersion:2,researchCards:{next:{runId:'next',question:'New',workspace:'/next',status:'active',phase:'active',tasks:[],updatedAt:2}}}))
 await act(async()=>reject(new Error('old request failure')));expect(screen.queryByText('old request failure')).not.toBeInTheDocument()
})
it('keeps the last background failure visible instead of silently removing the entry',()=>{
 useSessionStore.setState({researchCards:{live:{runId:'live',question:'Q',workspace:'/live',status:'active',phase:'active',tasks:[],updatedAt:1}},researchBinding:null,researchPageView:'new'})
 render(<ResearchBackgroundEntry/>)
 act(()=>useSessionStore.setState(state=>({researchCards:{live:{...state.researchCards.live,status:'failed',error:'provider crashed'}}})))
 expect(screen.getByText('失败')).toBeInTheDocument();expect(screen.getByText('provider crashed')).toBeInTheDocument()
 expand();expect(screen.queryByRole('button',{name:'停止后台课题'})).not.toBeInTheDocument()
})
it('stays out of the way when the same research is already open',()=>{
 useSessionStore.setState({agentMode:'research',researchPageView:'conversation',
  researchBinding:{sessionId:'live',sessionFile:'/live',workspace:'/live',runId:'live'},
  researchCards:{live:{runId:'live',question:'Q',workspace:'/live',status:'active',phase:'active',tasks:[],updatedAt:1}}})
 const {container}=render(<ResearchBackgroundEntry/>)
 expect(container).toBeEmptyDOMElement()
})

it('shows shared pending feedback without describing a stopping run as running',()=>{
 useSessionStore.setState({researchCards:{live:{runId:'live',question:'Q',workspace:'/live',status:'stopping',phase:'active',tasks:[],updatedAt:1}},researchBinding:null,researchPageView:'new'})
 useResearchStopStore.getState().begin('live','attempt')
 render(<ResearchBackgroundEntry/>);expand()
 expect(screen.getAllByText('正在停止').length).toBeGreaterThan(0)
 expect(screen.queryByText('正在其他会话中继续运行')).not.toBeInTheDocument()
 expect(screen.queryByText('运行中')).not.toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'停止后台课题'})).not.toBeInTheDocument()
 expect(screen.getByRole('button',{name:'查看研究详情'})).toBeInTheDocument()
})
it('offers refresh and native-confirmed retry after an unconfirmed background stop',()=>{
 const request=vi.fn(), refresh=vi.fn().mockResolvedValue(undefined)
 useSessionStore.setState({requestResearchStop:request,fetchResearchCardDetails:refresh,researchCards:{live:{runId:'live',question:'Q',workspace:'/live',status:'stopping',phase:'active',tasks:[],updatedAt:1}},researchBinding:null,researchPageView:'new'})
 useResearchStopStore.getState().begin('live','attempt');useResearchStopStore.getState().unconfirm('live','attempt','still driving')
 render(<ResearchBackgroundEntry/>);expand()
 expect(screen.getByRole('status')).toHaveTextContent('still driving')
 fireEvent.click(screen.getByRole('button',{name:'刷新'}));expect(refresh).toHaveBeenCalledWith('live')
 vi.mocked(window.confirm).mockReturnValue(false)
 fireEvent.click(screen.getByRole('button',{name:'重试停止'}));expect(request).not.toHaveBeenCalled()
 vi.mocked(window.confirm).mockReturnValue(true)
 fireEvent.click(screen.getByRole('button',{name:'重试停止'}));expect(request).toHaveBeenCalledWith(expect.objectContaining({kind:'run',runId:'live',workspace:'/live'}))
})



it('uses a newer stopped summary for the background label instead of stale stopping activity',()=>{
 useResearchRunStore.getState().applyListing({runId:'fresh',run:{id:'fresh',question:'Q',workspace:'/live',status:'stopping',phase:'stopping',nodes:1,tasks:1,driving:true,stop_requested:true,updatedAt:1},graph:{run:'fresh',question:'Q',status:'stopping',phase:'stopping',nodes:[]},sessions:[],suspension:null,suspensions:[]} as never)
 useSessionStore.setState({researchRuns:[{id:'fresh',question:'Q',workspace:'/live',status:'stopped',phase:'stopped',nodes:1,tasks:1,driving:false,updatedAt:2}],researchCards:{fresh:{runId:'fresh',question:'Q',workspace:'/live',status:'stopping',phase:'active',tasks:[],updatedAt:1}},researchBinding:null,researchPageView:'new'})
 render(<ResearchBackgroundEntry/>);expand()
 expect(screen.getByText('已停止')).toBeInTheDocument()
 expect(screen.queryByText('正在其他会话中继续运行')).not.toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'重试停止'})).not.toBeInTheDocument()
})

it('keeps a stopped-but-driven run titled as background research until the lease rests',()=>{
 useSessionStore.setState({researchCards:{live:{runId:'live',question:'Q',workspace:'/live',status:'active',phase:'active',tasks:[],updatedAt:1}},researchBinding:null,researchPageView:'new'})
 const view=render(<ResearchBackgroundEntry/>)
 act(()=>{
   useResearchStopStore.getState().begin('live','attempt')
   useSessionStore.setState({researchRuns:[{id:'live',question:'Q',workspace:'/live',status:'stopped',phase:'stopped',nodes:1,tasks:1,driving:true,updatedAt:2}],researchCards:{live:{runId:'live',question:'Q',workspace:'/live',status:'stopped',phase:'stopped',tasks:[],updatedAt:2}}})
 })
 expect(view.getByText('后台研究 · Q')).toBeInTheDocument()
 expect(view.getByText('正在停止')).toBeInTheDocument()
 view.unmount()
 const remounted=render(<ResearchBackgroundEntry/>)
 expect(remounted.getByText('后台研究 · Q')).toBeInTheDocument()
 act(()=>{
   useResearchStopStore.getState().clear('live','attempt')
   useSessionStore.setState({researchRuns:[{id:'live',question:'Q',workspace:'/live',status:'stopped',phase:'stopped',nodes:1,tasks:1,driving:false,updatedAt:3}]})
 })
 expect(remounted.getByText('后台研究已结束 · Q')).toBeInTheDocument()
})
