import { beforeEach, expect, it } from 'vitest'
import { useSessionStore } from '../useSessionStore'
import { useSettingsStore } from '../useSettingsStore'
import { emptyResearchEditor, type ResearchEditor } from '../../lib/researchView'

beforeEach(() => {
  useSettingsStore.setState({ currentModel: { provider: 'ordinary', modelId: 'ordinary-model', name: 'Ordinary', thinking: 'off' }, thinkingLevel: 'off' })
  useSessionStore.setState({ agentMode: 'agent', currentWorkspace: '/work', researchNewEntryId: 'entry', researchPageView: 'new',
    researchView: { kind: 'new', ownerKey: 'new:/work:entry', version: 0 }, researchPageVersion: 0,
    researchEditors: {}, researchSnapshots: {}, researchBinding: null, draft: 'ordinary draft', draftRevision: 7, attachments: [],
    ordinaryEditor: { text: '', revision: 0, attachments: [] } })
})

it.each(['new', 'conversation'] as const)('round trips the %s editor through ordinary mode without replacing either owner', kind => {
  const ownerKey = kind === 'new' ? 'new:/work:entry' : 'conversation:A'
  const attachment = { path: '/research.txt', name: 'research.txt', status: 'ready', attachmentId: 'research-file', preparationId: 'research-prep', images: [], size: 1, kind: 'text', text: 'evidence', error: null } as const
  const ordinaryAttachment = { ...attachment, path: '/ordinary.txt', attachmentId: 'ordinary-file', preparationId: 'ordinary-prep' }
  const editor = { ...emptyResearchEditor(), text: 'research draft', revision: 19, attachments: [attachment] as any,
    model: { provider: 'research', modelId: 'research-model' }, lastOrderModel: { provider: 'research', modelId: 'last-order' }, thinkingLevel: 'high' }
  useSessionStore.setState({ researchPageView: kind, researchView: kind === 'new' ? { kind, ownerKey, version: 0 } : { kind, ownerKey, sessionId: 'A', version: 0 },
    researchBinding: kind === 'conversation' ? { sessionId: 'A', workspace: '/work', runId: 'run-A', sessionFile: '/A' } : null,
    researchEditors: { [ownerKey]: editor }, attachments: [ordinaryAttachment] as any })
  const store = useSessionStore.getState()
  store.setAgentMode('research')
  expect(useSessionStore.getState()).toMatchObject({ draft: 'research draft', draftRevision: 19, researchView: { ownerKey } })
  expect(useSessionStore.getState().attachments[0]).toBe(attachment)
  store.setDraft('edited research draft')
  store.setAgentMode('agent')
  expect(useSessionStore.getState()).toMatchObject({ draft: 'ordinary draft', draftRevision: 7 })
  expect(useSessionStore.getState().attachments[0]).toBe(ordinaryAttachment)
  store.setDraft('edited ordinary draft')
  store.setAgentMode('research')
  expect(useSessionStore.getState()).toMatchObject({ draft: 'edited research draft', draftRevision: 20 })
  expect(useSessionStore.getState().researchEditors[ownerKey]).toEqual({ ...editor, text: 'edited research draft', revision: 20 })
  expect(useSessionStore.getState().attachments[0]).toBe(attachment)
  store.setAgentMode('agent')
  expect(useSessionStore.getState()).toMatchObject({ draft: 'edited ordinary draft', draftRevision: 8 })
  expect(useSettingsStore.getState().currentModel?.modelId).toBe('ordinary-model')
})

it('publishes each mode switch atomically and invalidates pending research view actions on exit', () => {
  useSessionStore.setState({ researchEditors: { 'new:/work:entry': { ...emptyResearchEditor(), text: 'research draft', revision: 19 } } })
  const transitions: Array<{ mode: string; draft: string }> = []
  const unsubscribe = useSessionStore.subscribe(state => transitions.push({ mode: state.agentMode, draft: state.draft }))
  try {
    useSessionStore.getState().setAgentMode('research')
    const researchVersion = useSessionStore.getState().researchPageVersion
    useSessionStore.getState().setAgentMode('agent')
    expect(useSessionStore.getState().researchPageVersion).toBeGreaterThan(researchVersion)
    expect(transitions).toEqual([{ mode: 'research', draft: 'research draft' }, { mode: 'agent', draft: 'ordinary draft' }])
  } finally { unsubscribe() }
})

it.each([false, true])('derives the incoming new-entry owner after a workspace change (B saved: %s)', savedB => {
  const attachment = (owner: string): ResearchEditor['attachments'][number] => ({ path: `/${owner}.txt`, name: `${owner}.txt`, size: 1,
    kind: 'text', text: `evidence ${owner}`, images: [], error: null, status: 'ready', attachmentId: `file-${owner}`, preparationId: `prep-${owner}` })
  const fileA = attachment('A')
  const fileB = attachment('B')
  const editorA: ResearchEditor = { text: 'A draft', revision: 11, attachments: [fileA], model: { provider: 'A', modelId: 'model-A' },
    lastOrderModel: { provider: 'A', modelId: 'coordinator-A' }, thinkingLevel: 'high' }
  const editorB: ResearchEditor = { text: 'B draft', revision: 23, attachments: [fileB], model: { provider: 'B', modelId: 'model-B' },
    lastOrderModel: { provider: 'B', modelId: 'coordinator-B' }, thinkingLevel: 'low' }
  useSessionStore.setState({ agentMode: 'research', currentWorkspace: '/A', researchPageView: 'new',
    researchView: { kind: 'new', ownerKey: 'new:/a:entry', version: 0 }, draft: 'A draft', draftRevision: 11, attachments: [fileA],
    researchEditors: { 'new:/a:entry': editorA, ...(savedB ? { 'new:/b:entry': editorB } : {}) },
    ordinaryEditor: { text: 'ordinary draft', revision: 7, attachments: [] } })
  const store = useSessionStore.getState()
  store.setAgentMode('agent')
  expect(useSessionStore.getState().draft).toBe('ordinary draft')
  store.syncWorkspaceCwd('/B')
  store.setAgentMode('research')
  expect(useSessionStore.getState()).toMatchObject({ currentWorkspace: '/B', researchView: { kind: 'new', ownerKey: 'new:/b:entry' } })
  expect(useSessionStore.getState().researchEditors['new:/a:entry']).toEqual(editorA)
  if (savedB) {
    expect(useSessionStore.getState()).toMatchObject({ draft: 'B draft', draftRevision: 23 })
    expect(useSessionStore.getState().attachments[0]).toBe(fileB)
    expect(useSessionStore.getState().researchEditors['new:/b:entry']).toEqual(editorB)
  } else {
    expect(useSessionStore.getState()).toMatchObject({ draft: '', draftRevision: 0, attachments: [] })
    expect(useSessionStore.getState().researchEditors['new:/b:entry']).toMatchObject({ text: '', revision: 0, attachments: [],
      model: { provider: 'ordinary', modelId: 'ordinary-model' }, thinkingLevel: 'off' })
  }
  store.setDraft('B edited')
  store.setAgentMode('agent')
  expect(useSessionStore.getState()).toMatchObject({ draft: 'ordinary draft', draftRevision: 7, attachments: [] })
  store.syncWorkspaceCwd('/A')
  store.setAgentMode('research')
  expect(useSessionStore.getState()).toMatchObject({ draft: 'A draft', draftRevision: 11, researchView: { ownerKey: 'new:/a:entry' } })
  expect(useSessionStore.getState().attachments[0]).toBe(fileA)
  expect(useSessionStore.getState().researchEditors['new:/a:entry']).toEqual(editorA)
  expect(useSessionStore.getState().researchEditors['new:/b:entry'].text).toBe('B edited')
})
