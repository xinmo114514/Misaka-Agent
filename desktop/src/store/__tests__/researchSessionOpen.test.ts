import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSessionStore } from '../useSessionStore'
import { useSettingsStore } from '../useSettingsStore'
import type { ResearchHostSnapshot } from '../../types/research'

const row = { id: 'cold-root', path: 'C:/sessions/cold-root.jsonl', cwd: 'C:/research-project',
  created: '2026-10-16', modified: '2026-10-16', firstMessage: 'Original topic', messageCount: 1, desktopResearch: true }
const failed = { id: 'failed-input', role: 'user' as const, content: 'Original topic', timestamp: 1,
  requestId: 'cold-request', deliveryStatus: 'failed' as const, submissionError: 'Recruitment failed', errorStage: 'recruitment' }
const host: ResearchHostSnapshot = { enabled: true, streamId: 'cold-stream', session: { sessionId: row.id, file: row.path, cwd: row.cwd },
  messages: [failed], historyVersion: 'cold-v1', lastEventSeq: 1, run: null, isIdle: true, stats: {}, contextUsage: null }
const ordinary = [{ id: 'ordinary-message', role: 'assistant' as const, content: 'Ordinary transcript', timestamp: 1 }]
const start = vi.fn()
const send = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  send.mockReset()
  start.mockReset().mockResolvedValue(host)
  window.bridge = { send, on: () => () => {} }
  window.app = { ...window.app, startResearchBridge: start }
  useSettingsStore.setState({ currentModel: { provider: 'fixture', modelId: 'before-open', name: 'Before open', thinking: 'off' },
    modelSwitchPending: false, thinkingLevel: 'off' })
  useSessionStore.setState({ agentMode: 'agent', currentSessionId: 'ordinary-root', currentSessionPath: 'C:/sessions/ordinary.jsonl',
    currentWorkspace: 'C:/ordinary', sessions: [row], messages: ordinary, draft: 'Ordinary draft', draftRevision: 5,
    attachments: [], isSessionLoading: false, sessionLoadError: null, isStreaming: false,
    researchBinding: null, researchBindings: {}, researchSnapshots: {}, researchConversations: {}, researchEditors: {},
    researchPendingCreationRequestId: null, researchPageView: 'new', researchPageVersion: 0,
    researchView: { kind: 'new', ownerKey: 'new::cold', version: 0 } })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

it('keeps read-only research opening through same-model metadata and capability refresh', async () => {
  let finish!: (snapshot: ResearchHostSnapshot) => void
  start.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  useSessionStore.getState().openSession(row.path)
  useSessionStore.setState(state => ({ currentModel: { ...state.currentModel } }))
  useSettingsStore.setState(state => ({ currentModel: state.currentModel ? { ...state.currentModel, name: 'Refreshed label' } : null,
    modelSwitchPending: true }))
  useSettingsStore.setState({ modelSwitchPending: false })
  finish(host)
  await settle()
  expect(useSessionStore.getState()).toMatchObject({ agentMode: 'research', researchBinding: { sessionId: row.id } })
})

it('opens a cold persisted research marker on the same root without ordinary load or submission', async () => {
  useSessionStore.getState().openSession(row.path)
  await settle()
  expect(start).toHaveBeenCalledWith({ cwd: row.cwd, sessionFile: row.path })
  expect(send.mock.calls.some(([command]) => command.type === 'load_session' || command.type === 'send_message')).toBe(false)
  expect(useSessionStore.getState()).toMatchObject({ agentMode: 'research', isSessionLoading: false,
    researchBinding: { sessionId: row.id, sessionFile: row.path, runId: null },
    researchView: { kind: 'conversation', sessionId: row.id, ownerKey: `conversation:${row.id}` },
    ordinaryEditor: { text: 'Ordinary draft', revision: 5 }, messages: ordinary })
  expect(useSessionStore.getState().researchConversation.messages[0]).toMatchObject(failed)
  // Legacy missing envelopes restore the topic for explicit wizard confirmation; opening sends nothing.
  useSessionStore.getState().restoreResearchMessageDraft(failed.id)
  expect(useSessionStore.getState().draft).toBe('Original topic')
  expect(send.mock.calls.some(([command]) => command.type === 'send_research_message')).toBe(false)
})

it.each(['ordinary session', 'research view', 'mode', 'model'])('fences a late research open after later %s navigation', async navigation => {
  let finish!: (snapshot: ResearchHostSnapshot) => void
  start.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  useSessionStore.getState().openSession(row.path)
  expect(start).toHaveBeenCalledOnce()
  if (navigation === 'ordinary session') useSessionStore.getState().openSession('C:/sessions/later.jsonl')
  if (navigation === 'research view') useSessionStore.getState().selectResearchView({ kind: 'new', ownerKey: 'new::later' })
  if (navigation === 'mode') useSessionStore.getState().setAgentMode('research')
  if (navigation === 'model') useSettingsStore.setState({ currentModel: { provider: 'fixture', modelId: 'later-model', name: 'Later', thinking: 'off' } })
  const later = useSessionStore.getState()
  const editor = later.draft
  finish(host)
  await settle()
  expect(useSessionStore.getState().researchBinding).toBeNull()
  expect(useSessionStore.getState().researchView).toEqual(later.researchView)
  expect(useSessionStore.getState().draft).toBe(editor)
  expect(useSessionStore.getState().messages).toBe(later.messages)
  expect(useSessionStore.getState().isSessionLoading).toBe(navigation === 'ordinary session')
})

it('fences a late research open when the current research editor model changes', async () => {
  useSessionStore.getState().setAgentMode('research')
  let finish!: (snapshot: ResearchHostSnapshot) => void
  start.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  useSessionStore.getState().openSession(row.path)
  useSessionStore.getState().setResearchEditorConfig({ lastOrderModel: { provider: 'fixture', modelId: 'new-coordinator', name: 'New coordinator', thinking: 'off' } })
  finish(host)
  await settle()
  expect(useSessionStore.getState().researchBinding).toBeNull()
  expect(useSessionStore.getState().isSessionLoading).toBe(false)
})

it('rejects a changed host identity without replacing ordinary content and retries the same research root', async () => {
  start.mockResolvedValueOnce({ ...host, session: { ...host.session, sessionId: 'wrong-root' } })
  useSessionStore.getState().openSession(row.path)
  await settle()
  expect(useSessionStore.getState()).toMatchObject({ agentMode: 'agent', researchBinding: null, messages: ordinary,
    draft: 'Ordinary draft', isSessionLoading: false })
  expect(useSessionStore.getState().sessionLoadError).toBeTruthy()
  useSessionStore.getState().retrySessionLoad()
  await settle()
  expect(start).toHaveBeenLastCalledWith({ cwd: row.cwd, sessionFile: row.path })
  expect(useSessionStore.getState().researchBinding?.sessionId).toBe(row.id)
  expect(useSessionStore.getState().sessionLoadError).toBeNull()
})

it('settles a research-open timeout and ignores a host that arrives after timeout', async () => {
  let finish!: (snapshot: ResearchHostSnapshot) => void
  start.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  useSessionStore.getState().openSession(row.path)
  expect(start).toHaveBeenCalledOnce()
  expect(useSessionStore.getState().isSessionLoading).toBe(true)
  await vi.advanceTimersByTimeAsync(30000)
  expect(useSessionStore.getState().isSessionLoading).toBe(false)
  expect(useSessionStore.getState().sessionLoadError).toBeTruthy()
  finish(host)
  await settle()
  expect(useSessionStore.getState().researchBinding).toBeNull()
})

it('refreshes persisted session discovery after recruitment failure without masking the original error', () => {
  const actions = useSessionStore.getState()
  actions.bindResearchConversation({ ...host, messages: [] })
  actions.queueResearchMessage('failed-recruitment', 'Discover this topic')
  const refresh = vi.fn(() => { throw new Error('Session discovery failed') })
  useSessionStore.setState({ fetchSessions: refresh })
  try {
    useSessionStore.getState().failResearchMessage('failed-recruitment', 'Original recruitment failure', true, { errorStage: 'recruitment' })
    expect(refresh).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().researchConversation.messages[0]).toMatchObject({
      submissionError: 'Original recruitment failure', deliveryStatus: 'failed' })
  } finally { useSessionStore.setState({ fetchSessions: actions.fetchSessions }) }
})
