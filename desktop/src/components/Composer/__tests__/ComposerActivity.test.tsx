import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Composer } from '../Composer'
import { useSessionStore } from '../../../store/useSessionStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
const mocks=vi.hoisted(()=>({stop:vi.fn(),start:vi.fn()}))
vi.mock('../../../lib/startComposerResearch',()=>({startComposerResearch:mocks.start,cancelResearchStartup:vi.fn()}))
vi.mock('../../../lib/researchBridge',()=>({executeResearchControl:vi.fn(),requestResearch:vi.fn(),isResearchRequestTimeout:()=>false}))
beforeEach(()=>{mocks.stop.mockReset();mocks.start.mockReset().mockImplementation(()=>new Promise(()=>{}));useSettingsStore.setState({currentModel:{provider:'test',modelId:'model',name:'Model',thinking:'off'},models:[]});useSessionStore.setState({agentMode:'research',researchPageView:'new',draft:'new topic',researchBinding:{sessionId:'history',sessionFile:'/history',workspace:'/history',runId:'old'},researchConversation:{messages:[],isStreaming:false,isAborting:false,isIdle:true,stats:{},contextUsage:null} as any,researchCards:{old:{runId:'old',question:'Historical',status:'done',phase:'done',tasks:[],updatedAt:1},background:{runId:'background',question:'Background research',workspace:'/background',status:'active',phase:'research',tasks:[],updatedAt:2}},requestResearchStop:mocks.stop,isStreaming:false,isSessionLoading:false,sessionLoadError:null,researchPendingCreationRequestId:null})})
afterEach(cleanup)
it('global activity blocks a new research even when current binding is terminal history',()=>{render(<Composer/>);fireEvent.keyDown(screen.getByRole('textbox'),{key:'Enter'});expect(mocks.start).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toHaveTextContent('已有研究');expect(useSessionStore.getState().draft).toBe('new topic')})
it('native idle still offers a captured stop for the actual background run',()=>{render(<Composer/>);fireEvent.click(screen.getByRole('button',{name:'停止后台研究'}));expect(mocks.stop).toHaveBeenCalledWith(expect.objectContaining({kind:'run',runId:'background',workspace:'/background'}))})

it.each(['/stop old', '/research stop old'])('explicit %s stops the selected historical run, not another active run', command => {
  useSessionStore.setState({ researchPageView: 'conversation', researchView: { kind: 'conversation', ownerKey: 'conversation:history', sessionId: 'history', version: 1 }, draft: command })
  render(<Composer />)
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'run', runId: 'old', workspace: '/history', sessionId: 'history' }))
})

it('conversation stop button targets the selected binding while another run is active', () => {
  useSessionStore.setState({ researchPageView: 'conversation', researchView: { kind: 'conversation', ownerKey: 'conversation:history', sessionId: 'history', version: 1 } })
  render(<Composer />)
  fireEvent.click(screen.getByRole('button', { name: '中止生成 (Esc)' }))
  expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'run', runId: 'old', workspace: '/history', sessionId: 'history' }))
})

it.each(['startup', 'turn'] as const)('preserves selected %s cancellation while a different background run is active', kind => {
  useSessionStore.setState({ researchPageView: 'conversation', researchView: { kind: 'conversation', ownerKey: 'conversation:starting', sessionId: 'starting', version: 1 },
    researchBinding: { sessionId: 'starting', workspace: '/starting', runId: null, sessionFile: '/starting/session', streamId: 'starting-stream' },
    researchPendingCreationRequestId: kind === 'startup' ? 'pending-start' : null, draft: '/stop' })
  render(<Composer />)
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(mocks.stop).toHaveBeenCalledExactlyOnceWith({ kind, workspace: '/starting', sessionId: 'starting', streamId: 'starting-stream', ...(kind === 'startup' ? { requestId: 'pending-start' } : {}) })
})
