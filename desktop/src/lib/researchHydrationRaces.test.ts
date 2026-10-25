import {expect,it,vi} from 'vitest'
import {createResearchActivity} from './researchActivity'
import {applyResearchNoticeToCard,hydrateCardFromDetail} from './researchCards'
import {useSessionStore} from '../store/useSessionStore'
import {emptyResearchConversation} from './researchConversation'

it.each(['status','task'])('in-flight detail must not undo newer same-epoch live %s', async(kind)=>{
 let finish!: (detail:any)=>void
 let card:any={runId:'r',question:'fixture',status:'waiting_input',phase:'planning',tasks:[],pendingQuestions:['old question'],updatedAt:1,eventSeq:10}
 const activity=createResearchActivity({getRunVersions:()=>({r:card.noticeRevision ?? 0}),fetchActive:async()=>[],fetchRuns:async()=>[],fetchDetail:()=>new Promise(resolve=>finish=resolve),applyRuns:()=>{},applyDetail:d=>{card=hydrateCardFromDetail(card,d)},onSync:()=>{},onError:()=>{}})
 activity.watchRun('r','/fixture');activity.start();const flight=activity.refresh()
 await Promise.resolve();await Promise.resolve();await Promise.resolve()
 card=applyResearchNoticeToCard(card,{customType:'research-progress',details:{run_id:'r',node_id:'node',phase:'executing',seq:11,tasks:[{id:'task',status:'done',title:'finished'}]}})
 expect(card.status).toBe('active');expect(card.tasks[0].status).toBe('done')
 finish({run:{id:'r',question:'fixture',workspace:'/fixture',status:'waiting_input',phase:'planning'},pending_questions:[{question:'old question'}],graph:{nodes:[{id:'node',cards:[{id:'task',status:'running',title:'finished'}]}]}})
 await flight;activity.stop()
 if (kind === 'status') expect(card.status).toBe('active')
 else expect(card.tasks[0].status).toBe('done')
})

it.each(['seq','content'])('background hydration must not discard newer transcript %s',kind=>{
 window.bridge={send:vi.fn(),on:()=>()=>{}} as any
 const host=(id:string,seq:number,messages:any[]=[])=>({enabled:true,session:{sessionId:id,file:id,cwd:'/fixture'},streamId:`stream-${id}`,messages,lastEventSeq:seq,run:{id:`run-${id}`,status:'active',phase:'executing'},stats:{},historyVersion:null,contextUsage:null} as any)
 useSessionStore.setState({researchBinding:null,researchSnapshots:{},researchBindings:{},researchConversations:{},researchCards:{},researchConversation:emptyResearchConversation()})
 const store=useSessionStore.getState()
 store.bindResearchConversation(host('A',1),true)
 store.bindResearchConversation(host('B',1),true)
 store.handleResearchBridgeMessage({sessionId:'A',streamId:'stream-A',seq:2,event:{type:'message_end',message:{role:'assistant',content:'new result',timestamp:2}}} as any)
 expect(useSessionStore.getState().researchConversations.A.lastEventSeq).toBe(2)
 expect(useSessionStore.getState().researchConversations.A.messages.some(row=>row.content==='new result')).toBe(true)
 store.bindResearchConversation(host('A',1))
 expect(useSessionStore.getState().researchBinding?.sessionId).toBe('B')
 if(kind === 'seq') expect(useSessionStore.getState().researchConversations.A.lastEventSeq).toBe(2)
 else expect(useSessionStore.getState().researchConversations.A.messages.some(row=>row.content==='new result')).toBe(true)
})

it('explicit navigation is not permission to resurrect an older transport',()=>{
 const host=(streamId:string)=>({enabled:true,session:{sessionId:'force-owner',file:'force-owner',cwd:'/fixture'},streamId,messages:[],lastEventSeq:1,run:null,stats:{},historyVersion:null,contextUsage:null} as any)
 useSessionStore.setState({researchBinding:null,researchSnapshots:{},researchBindings:{},researchConversations:{},researchCards:{},researchConversation:emptyResearchConversation()})
 const store=useSessionStore.getState()
 store.bindResearchConversation(host('force-old'),true)
 store.bindResearchConversation(host('force-current'),true)
 store.bindResearchConversation({...host('other-stream'),session:{sessionId:'other-owner',file:'other-owner',cwd:'/fixture'}},true)
 store.bindResearchConversation(host('force-old'),true)
 expect(useSessionStore.getState().researchBindings['force-owner'].streamId).toBe('force-current')
})


it('background old-stream hydration must preserve the current binding stream',()=>{
 window.bridge={send:vi.fn(),on:()=>()=>{}} as any
 const host=(id:string,stream:string)=>({enabled:true,session:{sessionId:id,file:id,cwd:'/fixture'},streamId:stream,messages:[],lastEventSeq:1,run:{id:`run-${id}`,status:'active',phase:'executing'},stats:{},historyVersion:null,contextUsage:null} as any)
 useSessionStore.setState({researchBinding:null,researchSnapshots:{},researchBindings:{},researchConversations:{},researchCards:{},researchConversation:emptyResearchConversation()})
 const store=useSessionStore.getState()
 store.bindResearchConversation(host('A','old'),true)
 store.bindResearchConversation(host('A','current'),true)
 store.bindResearchConversation(host('B','B'),true)
 store.bindResearchConversation(host('A','old'))
 expect(useSessionStore.getState().researchBindings.A.streamId).toBe('current')
})
