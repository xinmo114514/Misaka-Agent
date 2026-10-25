import { beforeEach, expect, it, vi } from 'vitest'
const pending = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../../lib/bridge', async original => ({ ...await original(), request: pending.request }))
import { useSessionStore } from '../useSessionStore'
beforeEach(() => { useSessionStore.setState({ agentMode: 'research', researchPageView: 'new', researchNewEntryId: 'attach', researchView: {kind:'new',ownerKey:'new:work:attach',version:0}, researchEditors: {}, draft:'', attachments:[] }); pending.request.mockReset() })
it('files prepared after navigation remain in the captured editor bucket', async () => {
 let finish!: (value: any) => void
 pending.request.mockImplementationOnce(() => new Promise(resolve => {finish=resolve}))
 const action = useSessionStore.getState().prepareAttachments(['/same.txt'])
 useSessionStore.getState().selectResearchView({kind:'conversation',sessionId:'B',ownerKey:'conversation:B'})
 finish({attachments:[{path:'/same.txt',name:'same',size:1,kind:'text',text:'old content',images:[],error:null}]})
 await action
 expect(useSessionStore.getState().attachments).toEqual([])
 expect(useSessionStore.getState().researchEditors['new:work:attach'].attachments[0].status).toBe('ready')
})
it('a removed and re-added path rejects the old preparation result', async () => {
 let first!: (value: any) => void, second!: (value: any) => void
 pending.request.mockImplementationOnce(() => new Promise(resolve=>{first=resolve})).mockImplementationOnce(() => new Promise(resolve=>{second=resolve}))
 const a=useSessionStore.getState().prepareAttachments(['/same.txt'])
 useSessionStore.getState().removeAttachment('/same.txt')
 const b=useSessionStore.getState().prepareAttachments(['/same.txt'])
 first({attachments:[{path:'/same.txt',name:'same',size:1,kind:'text',text:'stale',images:[],error:null}]})
 await a
 expect(useSessionStore.getState().attachments[0].status).toBe('preparing')
 second({attachments:[{path:'/same.txt',name:'same',size:1,kind:'text',text:'fresh',images:[],error:null}]})
 await b
 expect(useSessionStore.getState().attachments[0].text).toBe('fresh')
})
