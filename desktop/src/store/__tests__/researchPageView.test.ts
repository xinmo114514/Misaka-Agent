import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../useSessionStore'
import { emptyResearchConversation } from '../../lib/researchConversation'
import { selectSessionViewKey } from '../../lib/sessionViewState'

beforeEach(() => {
  window.bridge = { send: vi.fn(), on: () => () => {} }
  useSessionStore.setState({
    agentMode: 'agent',
    researchPageView: 'new',
    researchBinding: null,
    researchCards: {},
    researchConversation: emptyResearchConversation(),
    researchPendingCreationRequestId: null,
    draft: '',
    newResearchDraft: '',
    researchEditors: {},
    researchNewEntryId: 'test-entry',
  })
})

describe('research page view and draft isolation', () => {
  it('defaults to new page view on new session', () => {
    useSessionStore.getState().createSession()
    expect(useSessionStore.getState().researchPageView).toBe('new')
  })

  it('keeps new research draft separate from active research conversation draft', () => {
    useSessionStore.setState({
      agentMode: 'research',
      researchPageView: 'conversation',
      draft: '继续研究的补充问题',
    })
    useSessionStore.getState().setResearchPageView('new')
    expect(useSessionStore.getState().researchPageView).toBe('new')
    expect(useSessionStore.getState().draft).toBe('')

    useSessionStore.getState().setDraft('全新的研究课题')
    expect(useSessionStore.getState().draft).toBe('全新的研究课题')

    useSessionStore.getState().setResearchPageView('conversation')
    expect(useSessionStore.getState().researchPageView).toBe('conversation')
    expect(useSessionStore.getState().draft).toBe('继续研究的补充问题')

    useSessionStore.getState().setResearchPageView('new')
    expect(useSessionStore.getState().draft).toBe('全新的研究课题')
  })

  it('hydrates research conversation without navigating', () => {
    useSessionStore.setState({
      agentMode: 'research',
      researchPageView: 'new',
      researchBinding: null,
    })
    useSessionStore.getState().bindResearchConversation({
      enabled: true,
      session: { sessionId: 'res-1', file: 'res-1.jsonl', cwd: 'C:/project' },
      messages: [],
      historyVersion: 'v1',
      lastEventSeq: 1,
      run: { id: 'run-1', status: 'active', phase: 'plan' },
      stats: {},
      contextUsage: null,
    })
    expect(useSessionStore.getState().researchPageView).toBe('new')
    expect(useSessionStore.getState().researchBinding?.runId).toBe('run-1')
  })

  it('clears research conversation and resets view to new', () => {
    useSessionStore.setState({
      agentMode: 'research',
      researchPageView: 'conversation',
      researchConversation: emptyResearchConversation(),
      researchBinding: { sessionId: 'res-1', sessionFile: 'res-1.jsonl', workspace: 'C:/project', runId: 'run-done' },
      researchCards: { 'run-done': { runId: 'run-done', question: 'Done', status: 'done', phase: 'done', tasks: [], updatedAt: 1 } as any },
    })
    useSessionStore.getState().clearResearchConversation()
    expect(useSessionStore.getState().researchPageView).toBe('new')
    expect(useSessionStore.getState().researchBinding).toBeNull()
  })

  it('selects ordinary transcript key when on new page view even if researchBinding exists', () => {
    const state = {
      agentMode: 'research',
      currentSessionPath: 'normal.jsonl',
      researchBinding: { sessionFile: 'research.jsonl' },
      researchPageView: 'new' as const,
    }
    expect(selectSessionViewKey(state)).not.toBe('normal.jsonl')
  })

  it('selects research transcript key when on conversation page view', () => {
    const state = {
      agentMode: 'research',
      currentSessionPath: 'normal.jsonl',
      researchBinding: { sessionFile: 'research.jsonl' },
      researchPageView: 'conversation' as const,
    }
    expect(selectSessionViewKey(state)).toBe('research.jsonl')
  })
})


 it('keeps ordinary text apart from research editors and restores each owner', () => {
   const store = useSessionStore.getState()
   store.setDraft('ordinary')
   store.setAgentMode('research')
   store.setDraft('new topic')
   const owner = useSessionStore.getState().researchView.ownerKey
   store.selectResearchView({ kind: 'conversation', ownerKey: 'conversation:A', sessionId: 'A' })
   store.setDraft('answer A')
   store.selectResearchView({ kind: 'new', ownerKey: owner })
   expect(useSessionStore.getState().draft).toBe('new topic')
   store.setAgentMode('agent')
   expect(useSessionStore.getState().draft).toBe('ordinary')
 })

it('late delivery receipts update the original research owner without selecting it', () => {
 const store=useSessionStore.getState()
 const host=(id:string)=>({session:{sessionId:id,file:id,cwd:'/work'},messages:[],run:{id:`run-${id}`,status:'active'},lastEventSeq:1,stats:{},contextUsage:null,historyVersion:null,enabled:true} as any)
 store.bindResearchConversation(host('A'),true)
 store.selectResearchView({kind:'conversation',sessionId:'A',ownerKey:'conversation:A'})
 store.queueResearchMessage('request-A','question A')
 store.bindResearchConversation(host('B'),true)
 store.selectResearchView({kind:'conversation',sessionId:'B',ownerKey:'conversation:B'})
 store.acceptResearchMessage('request-A')
 expect(useSessionStore.getState().researchView.ownerKey).toBe('conversation:B')
 expect(useSessionStore.getState().researchConversations.A.messages[0].deliveryStatus).toBe('accepted')
})
