import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
const open = vi.hoisted(()=>({run:vi.fn()}))
vi.mock('../../../lib/startComposerResearch',()=>({openResearchConversation:open.run}))
import { ResearchHistoryDialog } from '../ResearchHistoryDialog'
import {useSessionStore} from '../../../store/useSessionStore'
beforeEach(()=>{window.bridge={send:vi.fn(),on:()=>()=>{}}; useSessionStore.setState({researchHistoryOpen:true,researchHistoryGeneration:0,researchPageView:'new',researchPageVersion:0,researchBinding:null,researchRuns:[{id:'A',question:'question A',status:'done',tasks:0,workspace:'/work'}] as any,fetchResearchRuns:vi.fn(),fetchResearchCardDetails:vi.fn(async()=>{})})})
it('a closed and reopened dialog ignores the old navigation and finally',async()=>{
 let finish!: (host:any)=>void
 open.run.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
 render(<ResearchHistoryDialog />)
 fireEvent.click(screen.getByText('question A'))
 act(()=>{useSessionStore.getState().setResearchHistoryOpen(false);useSessionStore.getState().setResearchHistoryOpen(true)})
 await act(async()=>{finish({session:{sessionId:'A',file:'A',cwd:'/work'},messages:[],run:{id:'A',status:'done'}})})
 expect(useSessionStore.getState().researchHistoryOpen).toBe(true)
 expect(useSessionStore.getState().researchPageView).toBe('new')
})
