import { describe, it, expect } from 'vitest'
import { applyResearchNoticeToCard, hydrateCardsFromRuns, hydrateCardFromDetail } from './researchCards'
import type { ResearchRunCard, ResearchRunDetail } from '../types/research'
const terminal: ResearchRunCard = { runId:'r', question:'Q', status:'failed', phase:'active', tasks:[], error:'provider failed', updatedAt:10 }
describe('authoritative research metadata', () => {
  it('late list activity does not rewind terminal metadata', () => {
    const card = hydrateCardsFromRuns({r:terminal}, [{id:'r',question:'Q',workspace:'/w',status:'active',phase:'active',tasks:0,nodes:0}]).r
    expect(card.status).toBe('failed'); expect(card.error).toBe('provider failed')
  })
  it('late live progress does not rewind terminal metadata', () => {
    const card = applyResearchNoticeToCard(terminal,{customType:'research-progress',details:{run_id:'r',status:'active',phase:'research'}})
    expect(card.status).toBe('failed'); expect(card.error).toBe('provider failed')
  })
  it('stale questions do not override done and hydration does not invent activity', () => {
    const detail = {run:{id:'r',question:'Q',workspace:'/w',status:'done',phase:'done',tasks:0,nodes:0,createdAt:20,updatedAt:30},graph:{run:'r',question:'Q',status:'done',phase:'done',nodes:[]},pending_questions:[{node_id:'n',question:'old'}]} satisfies ResearchRunDetail
    const card = hydrateCardFromDetail(undefined,detail)
    expect(card.status).toBe('done'); expect(card.startedAt).toBe(20); expect(card.lastActivityAt).toBe(30000)
  })
})
it('host hydration follows the same terminal fence as discovery and notices', async () => {
 const {useSessionStore}=await import('../store/useSessionStore')
 useSessionStore.setState({researchCards:{r:terminal},researchBinding:null,researchSnapshots:{},researchBindings:{},researchConversations:{}})
 useSessionStore.getState().bindResearchConversation({enabled:true,session:{sessionId:'s',file:'/s',cwd:'/w'},messages:[],historyVersion:null,lastEventSeq:0,run:{id:'r',status:'active',phase:'active'},stats:{},contextUsage:null})
 expect(useSessionStore.getState().researchCards.r.status).toBe('failed')
 expect(useSessionStore.getState().researchCards.r.error).toBe('provider failed')
})
it.each(['stopped','failed','partial','active'])('real incomplete final notice preserves incomplete %s identity', status => {
 const previous={runId:'r',question:'Q',status,phase:'active',tasks:[],updatedAt:1}
 const result=applyResearchNoticeToCard(previous,{customType:'research-final',content:'真实局部报告',details:{run_id:'r',artifactId:'a',incomplete:true}})
 expect(result.status).toBe(status==='active'?'partial':status)
 expect(result.report?.content).toBe('真实局部报告')
 expect(result.report?.incomplete).toBe(true)
})
it('prefers meaningful backend activity and projects verified delivery independently',()=>{
 const result=hydrateCardsFromRuns({},[{id:'r',question:'Q',workspace:'/w',status:'done',phase:'done',tasks:0,nodes:0,updatedAt:999,lastActivityAt:12000,reportDelivery:{state:'failed',artifactId:'a',errorCode:'persist_failed'}}]).r
 expect(result.lastActivityAt).toBe(12000)
 expect(result.reportDelivery?.state).toBe('failed')
})
it('incomplete persisted output does not erase the known failure cause',()=>{
 const result=applyResearchNoticeToCard(terminal,{customType:'research-final',content:'Partial',details:{run_id:'r',incomplete:true}})
 expect(result.status).toBe('failed');expect(result.error).toBe('provider failed')
})
