import { afterEach, beforeEach, expect, it } from 'vitest'
import { useSessionStore } from '../useSessionStore'
import { useSettingsStore } from '../useSettingsStore'
import { installResearchBridge } from '../../lib/researchBridge'
import type { BridgeMessage } from '../../types/global'

let ordinary: any[] = [], research: any[] = []
let deliver: (message: BridgeMessage) => void
let release: () => void
const host = () => ({ enabled: true, session: { sessionId: 'root', file: '/root.jsonl', cwd: '/work' }, messages: [], historyVersion: 'v1', lastEventSeq: 0, run: { id: 'run', status: 'done', phase: 'done' }, stats: {}, contextUsage: null })
const effective = { provider: 'fixture', modelId: 'a' }
const binding = (epoch = 1, state = 'ready', target: any = null) => ({ effective, target, epoch, state })
const team = { teamId: 'team', scene: 'desktop_research', members: [{ id: 'expert', name: 'Evidence', kind: 'task_agent', responsibility: 'Check evidence', goal: 'Verify', instructions: 'Cite sources', tools: ['read'], skills: ['analysis'], status: 'done', taskIds: ['t1'], effectiveModel: effective }] }
beforeEach(() => {
  ordinary = []; research = []
  window.bridge = { send: command => ordinary.push(command), on: () => () => {} }
  window.researchBridge = { send: command => research.push(command), on: handler => { deliver = handler; return () => {} } }
  release = installResearchBridge()
  useSessionStore.setState({ agentMode: 'research', researchBinding: null, researchTeam: null, researchModelBinding: null } as any)
  useSessionStore.getState().bindResearchConversation({ ...host(), team, modelBinding: binding() } as any)
  useSettingsStore.setState({ models: ['a', 'b'].map(id => ({ id, name: id.toUpperCase(), provider: 'fixture', reasoning: true, thinkingLevels: id === 'b' ? ['high'] : ['low', 'high'], input: [], maxTokens: 100, contextWindow: 1000, configured: true })), currentModel: { ...effective, name: 'A', thinking: 'low' }, thinkingLevel: 'low', defaultProvider: 'fixture', defaultModel: 'a', modelSwitchPending: false, pickerError: null, researchModelBinding: null } as any)
})
afterEach(() => release())
it('hydrates only backend team members and rejects another session or older epoch', () => {
  expect((useSessionStore.getState() as any).researchTeam).toEqual(team)
  ;(useSessionStore.getState() as any).applyResearchTeamSnapshot('other', { modelBinding: binding(3, 'switching', { provider: 'fixture', modelId: 'b' }) })
  expect((useSessionStore.getState() as any).researchModelBinding.epoch).toBe(1)
  ;(useSessionStore.getState() as any).applyResearchTeamSnapshot('root', { modelBinding: binding(3) })
  ;(useSessionStore.getState() as any).applyResearchTeamSnapshot('root', { modelBinding: binding(2) })
  expect((useSessionStore.getState() as any).researchModelBinding.epoch).toBe(3)
})
it('routes a research model selection only to its root and keeps old committed model until ready', async () => {
  useSettingsStore.getState().setSessionModel('fixture', 'b', true)
  expect(ordinary).toEqual([])
  expect(research[0]).toMatchObject({ type: 'desktop_set_team_model', sessionId: 'root', provider: 'fixture', modelId: 'b', action: 'switch' })
  expect(useSettingsStore.getState().currentModel?.modelId).toBe('a')
  deliver({ type: 'ack', ok: true, requestId: research[0].requestId, data: { modelBinding: binding(2, 'switching', { provider: 'fixture', modelId: 'b' }) } })
  await Promise.resolve(); await Promise.resolve()
  expect(useSettingsStore.getState().modelSwitchPending).toBe(true)
  ;(useSettingsStore.getState() as any).applyResearchModelBinding('root', { effective: { provider: 'fixture', modelId: 'b' }, target: null, epoch: 2, state: 'ready' })
  expect(useSettingsStore.getState().currentModel?.modelId).toBe('b')
  expect(useSettingsStore.getState().availableThinkingLevels).toEqual(['high'])
  expect(useSettingsStore.getState().defaultModel).toBe('a')
})
it('keeps research failure available for retry and cancellation without ordinary settings writes', async () => {
  ;(useSettingsStore.getState() as any).applyResearchModelBinding('root', { ...binding(2, 'failed', { provider: 'fixture', modelId: 'b' }), error: 'worker failed' })
  expect(useSettingsStore.getState().pickerError).toContain('worker failed')
  ;(useSettingsStore.getState() as any).retryResearchModelSwitch()
  expect(research[0]).toMatchObject({ action: 'retry', modelId: 'b' })
  ;(useSettingsStore.getState() as any).cancelResearchModelSwitch()
  expect(research[1]).toMatchObject({ action: 'cancel', sessionId: 'root' })
  deliver({ type: 'ack', ok: true, requestId: research[1].requestId, data: { modelBinding: binding(3) } })
  deliver({ type: 'ack', ok: true, requestId: research[0].requestId, data: { modelBinding: binding(2, 'switching', { provider: 'fixture', modelId: 'b' }) } })
  await Promise.resolve(); await Promise.resolve()
  expect(useSettingsStore.getState().modelSwitchPending).toBe(false)
  expect(useSettingsStore.getState().currentModel?.modelId).toBe('a')
  expect(ordinary).toEqual([])
})
it('keeps root effective model and its real registry ladder when ordinary catalog reads arrive', () => {
  useSessionStore.setState({ currentSessionId: 'ordinary', activeSessionId: 'ordinary', isSessionLoading: false, sessionLoadError: null })
  const rootBinding = { effective: { provider: 'fixture', modelId: 'b' }, target: null, epoch: 4, state: 'ready' as const }
  useSessionStore.getState().applyResearchTeamSnapshot('root', { modelBinding: rootBinding })
  useSettingsStore.getState().applyResearchModelBinding('root', rootBinding)
  useSettingsStore.getState().resyncModelCapability()
  const modelRead = ordinary.find(command => command.type === 'get_models')
  const thinkingRead = ordinary.find(command => command.type === 'get_thinking_levels')
  useSettingsStore.getState().handleBridgeMessage({ type: 'ack', requestId: modelRead.requestId, ok: true, data: { models: useSettingsStore.getState().models, currentModel: { ...effective, name: 'A', thinking: 'low' } } })
  useSettingsStore.getState().handleBridgeMessage({ type: 'ack', requestId: thinkingRead.requestId, ok: true, data: { level: 'low', levels: ['low', 'high'], supportsThinking: true } })
  expect(useSettingsStore.getState().currentModel?.modelId).toBe('b')
  expect(useSettingsStore.getState().availableThinkingLevels).toEqual(['high'])
})
it('applies custom team notices in session and sequence order without creating members from tasks', () => {
  useSessionStore.getState().handleResearchBridgeMessage({ sessionId: 'root', seq: 3, event: { type: 'desktop-team', details: { team: { ...team, members: [] }, modelBinding: binding(5) } } })
  expect(useSessionStore.getState().researchTeam?.members).toEqual([])
  useSessionStore.getState().handleResearchBridgeMessage({ sessionId: 'root', seq: 2, event: { type: 'desktop-team', details: { team, modelBinding: binding(4) } } })
  expect(useSessionStore.getState().researchTeam?.members).toEqual([])
})
it('rejects a team notice older than the persisted root snapshot sequence', () => {
  useSessionStore.getState().bindResearchConversation({ ...host(), lastEventSeq: 8, team, modelBinding: binding(5) } as any)
  useSessionStore.getState().handleResearchBridgeMessage({ sessionId: 'root', seq: 7, event: { type: 'desktop-team', details: { team: { ...team, members: [] }, modelBinding: binding(5) } } })
  expect(useSessionStore.getState().researchTeam?.members).toHaveLength(1)
})
it('does not borrow ordinary depth or blank the root effective model during registry resync', () => {
  useSessionStore.setState({ currentSessionId: 'ordinary-depth', activeSessionId: 'ordinary-depth', isSessionLoading: false, sessionLoadError: null })
  useSettingsStore.setState({ thinkingLevel: 'high' })
  useSettingsStore.getState().applyResearchModelBinding('root', binding() as any)
  useSettingsStore.getState().resyncModelCapability()
  expect(useSettingsStore.getState().thinkingLevel).toBe('high')
  const modelRead = ordinary.find(command => command.type === 'get_models')
  const thinkingRead = ordinary.find(command => command.type === 'get_thinking_levels')
  useSettingsStore.getState().handleBridgeMessage({ type: 'ack', requestId: modelRead.requestId, ok: true, data: { models: useSettingsStore.getState().models, currentModel: { ...effective, name: 'A', thinking: 'low' } } })
  useSettingsStore.getState().handleBridgeMessage({ type: 'ack', requestId: thinkingRead.requestId, ok: true, data: { level: 'low', levels: ['low'], supportsThinking: true } })
  expect(useSettingsStore.getState().thinkingLevel).toBe('high')
})
it('keeps an unacknowledged local target visible when polling repeats the earlier ready binding', async () => {
  useSettingsStore.getState().applyResearchModelBinding('root', binding() as any)
  useSettingsStore.getState().setSessionModel('fixture', 'b')
  useSettingsStore.getState().applyResearchModelBinding('root', binding() as any)
  expect(useSettingsStore.getState().modelSwitchPending).toBe(true)
  expect(useSettingsStore.getState().researchModelTarget).toEqual({ provider: 'fixture', modelId: 'b' })
  deliver({ type: 'ack', requestId: research[0].requestId, ok: true, data: { modelBinding: binding(2, 'switching', { provider: 'fixture', modelId: 'b' }) } })
  await Promise.resolve(); await Promise.resolve()
})
it('keeps the fresh pick over an old team binding until the binding catches up', () => {
  // Ordinary-mode pick: no research binding exists yet, so this writes the model
  // on the ordinary path and records the choice as still uncommitted for research.
  useSessionStore.setState({ agentMode: 'agent', researchBinding: null } as any)
  useSettingsStore.getState().setSessionModel('fixture', 'b')
  expect(useSettingsStore.getState().currentModel?.modelId).toBe('b')
  // Entering research mode adopts the team's settled (old) binding; the fresh pick wins.
  useSessionStore.setState({ agentMode: 'research', researchBinding: { sessionId: 'root', sessionFile: '/root.jsonl', workspace: '/work', runId: 'run' } } as any)
  useSettingsStore.getState().applyResearchModelBinding('root', binding(4) as any)
  expect(useSettingsStore.getState().currentModel?.modelId).toBe('b')
  // Once the team commits the choice, the binding legitimately paints it.
  useSettingsStore.getState().applyResearchModelBinding('root', { effective: { provider: 'fixture', modelId: 'b' }, target: null, epoch: 5, state: 'ready' })
  expect(useSettingsStore.getState().currentModel?.modelId).toBe('b')
})
