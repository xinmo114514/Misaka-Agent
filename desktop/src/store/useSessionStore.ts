import { create } from 'zustand'
import type { ChatMessage, PermissionMode, PermissionRequestPayload, ProjectGroup, SessionFilterScope, SessionInfoOut, SessionOperationKind, SessionOperationResult, SessionTreePayload, TreeFilterMode } from '../types/session'
import type { DesktopResearchTeam, ResearchModelBinding, ResearchTeamSnapshot, ResearchConversationBinding, ResearchGraphPayload, ResearchHostSnapshot, ResearchRunDetail, ResearchRunSummary } from '../types/research'
import {
  applyResearchNoticeToCard,
  hydrateCardFromDetail,
  hydrateCardsFromRuns,
  type ResearchRunCard,
} from '../lib/researchCards'
import type { BridgeMessage, BridgeEventEnvelope } from '../types/global'
import { reduceConversationEvent, type ConversationState } from '../lib/conversationEvents'
import { normalizeChatMessage } from '../lib/messageBlocks'
import { emptyResearchConversation, hydrateResearchHistoryCards, isResearchRunActive, projectResearchHistory, reconcileResearchPendingHistory, reduceResearchConversationEvent, researchNoticeRunId } from '../lib/researchConversation'
import { newRequestId, request } from '../lib/bridge'
import { sessionHistoryCache } from '../lib/sessionHistoryCache'
import { forgetSessionView, migrateEntryDisclosures } from '../lib/sessionViewState'
import type { AttachmentPreparation, PreparedAttachment, PromptImage } from '../types/attachment'

const STORAGE_RECENT_WORKSPACES_KEY = 'misaka_recent_workspaces'

/** What the compact dialog and the auto-compaction notices show while an operation runs. */
export interface CompactStatus {
  state: 'idle' | 'running' | 'done' | 'error' | 'aborted'
  message?: string | null
}

export interface SessionDeletionState {
  path: string
  requestId: string | null
  status: 'confirm' | 'pending' | 'error'
  error?: string
}

/** Slash commands the desktop resolves itself instead of sending them to the model. */
const TREE_FILTER_MODES: TreeFilterMode[] = ['default', 'no-tools', 'user-only', 'labeled-only', 'all']

export function projectNameForCwd(cwd: string): string {
  if (!cwd) return '未分组'
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : cwd
}

export function normalizeWorkspacePath(path: string): string {
  if (!path) return ''
  return path.trim().replace(/[\\/]+$/, '').toLowerCase()
}

function loadRecentWorkspaces(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_RECENT_WORKSPACES_KEY)
    if (raw) {
      const list = JSON.parse(raw)
      if (Array.isArray(list)) {
        return list.filter((p): p is string => typeof p === 'string' && !!p.trim())
      }
    }
  } catch {
    // fallback
  }
  return []
}

function saveRecentWorkspaces(paths: string[]): void {
  try {
    localStorage.setItem(STORAGE_RECENT_WORKSPACES_KEY, JSON.stringify(paths.slice(0, 10)))
  } catch {
    // ignore
  }
}

const STORAGE_SKIP_SUMMARY_KEY = 'misaka_tree_skip_summary_prompt'
const STORAGE_LABEL_TIMESTAMPS_KEY = 'misaka_tree_label_timestamps'

/** A local choice only: the engine's own branchSummary.skipPrompt setting is read from the tree reply. */
function readSkipSummaryPrompt(): boolean {
  try {
    return localStorage.getItem(STORAGE_SKIP_SUMMARY_KEY) === '1'
  } catch {
    return false
  }
}

function saveSkipSummaryPrompt(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_SKIP_SUMMARY_KEY, value ? '1' : '0')
  } catch {
    // ignore
  }
}

function readLabelTimestampsVisible(): boolean {
  try { return localStorage.getItem(STORAGE_LABEL_TIMESTAMPS_KEY) === '1' } catch { return false }
}

function addRecentWorkspace(path: string, current: string[]): string[] {
  if (!path || !path.trim()) return current
  const norm = normalizeWorkspacePath(path)
  const next = [path.trim(), ...current.filter((p) => normalizeWorkspacePath(p) !== norm)]
  return next.slice(0, 10)
}

interface SessionState {
  currentSessionId: string
  activeSessionId: string
  activeSessionPath: string | null
  sessionHistoryVersion: string | null
  sessionLoadError: string | null
  sessionSwitchTimings: Record<string, number> | null
  currentTitle: string
  currentSessionPath: string | null
  currentWorkspace: string
  recentWorkspaces: string[]
  sessionFilterScope: SessionFilterScope
  isStreaming: boolean
  isAborting: boolean
  isSessionLoading: boolean
  lastEventSeq: number
  /** The assistant message currently being streamed, by id. Deltas key on this, not on position. */
  streamingMessageId: string | null
  messages: ChatMessage[]
  sessions: SessionInfoOut[]
  sessionDeletion: SessionDeletionState | null
  lastDeletedSessionPath: string | null
  projects: ProjectGroup[]
  researchRuns: ResearchRunSummary[]
  researchGraph: ResearchGraphPayload | null
  researchRunId: string | null
  researchCards: Record<string, ResearchRunCard>
  researchConversation: ConversationState
  researchBinding: ResearchConversationBinding | null
  researchConnectionError: string | null
  researchPendingCreationRequestId: string | null
  researchHistoryVersion: string | null
  researchHostStats: ResearchHostSnapshot['stats']
  researchContextUsage: ResearchHostSnapshot['contextUsage']
  researchTeam: DesktopResearchTeam | null
  researchModelBinding: ResearchModelBinding | null
  researchTeamEventSeq: number
  activeResearchTaskId: { runId: string; taskId: string } | null
  activeResearchGraphRunId: string | null
  researchHistoryOpen: boolean
  currentModel: {
    provider: string
    modelId: string
    name: string
    thinking: string
  }
  permissionMode: PermissionMode
  agentMode: 'agent' | 'research'
  pendingPermissionRequest: PermissionRequestPayload | null
  /** The composer's text, mirrored here so a tree navigation can hand a message back to it. */
  draft: string
  /** Kept when a navigation returned text but the composer already had a draft; nothing is silently dropped. */
  retainedEditorText: string | null
  treeOpen: boolean
  treePayload: SessionTreePayload | null
  treeLoading: boolean
  treeError: string | null
  /** Null until the engine's own treeFilterMode setting has been read. */
  treeFilterMode: TreeFilterMode | null
  treeFilterModeTouched: boolean
  labelTimestampsVisible: boolean
  skipSummaryPrompt: boolean
  compactOpen: boolean
  compactStatus: CompactStatus
  /** The long session operation the engine accepted, if any; drives every busy gate. */
  sessionOperation: { requestId: string; operation: SessionOperationKind; sessionId: string } | null

  // Actions
  sendMessage: (text: string, streamingBehavior?: 'steer' | 'followUp', images?: PromptImage[]) => void
  attachments: PreparedAttachment[]
  prepareAttachments: (paths: string[]) => Promise<void>
  retryAttachment: (path: string) => Promise<void>
  removeAttachment: (path: string) => void
  clearAttachments: () => void
  retryMessage: (messageId: string) => void
  abortGeneration: () => void
  handleBridgeMessage: (msg: BridgeMessage) => void
  bindResearchConversation: (snapshot: ResearchHostSnapshot) => void
  applyResearchTeamSnapshot: (sessionId: string, snapshot: ResearchTeamSnapshot, seq?: number) => void
  handleResearchBridgeMessage: (msg: BridgeMessage) => void
  clearResearchConversation: () => void
  queueResearchMessage: (requestId: string, text: string) => void
  acceptResearchMessage: (requestId: string) => void
  failResearchMessage: (requestId: string, error: string) => void
  fetchSessions: () => void
  openSession: (path: string) => void
  retrySessionLoad: () => void
  createSession: (carryOverContext?: boolean) => void
  switchWorkspace: (workspacePath: string, targetSessionPath?: string) => void
  syncWorkspaceCwd: (workspacePath: string) => void
  openWorkspaceDialog: () => Promise<string | null>
  setSessionFilterScope: (scope: SessionFilterScope) => void
  renameSession: (path: string, name: string) => Promise<void>
  deleteSession: (path: string) => void
  requestSessionDeletion: (path: string) => void
  cancelSessionDeletion: () => void
  confirmSessionDeletion: () => Promise<boolean>
  forkSession: (entryId: string | null, position?: 'before' | 'at') => void
  fetchResearchRuns: () => void
  fetchResearchGraph: (runId?: string) => void
  setPermissionMode: (mode: PermissionMode) => void
  setAgentMode: (mode: 'agent' | 'research') => void
  upsertResearchCard: (card: Partial<ResearchRunCard> & { runId: string }) => void
  setActiveResearchTask: (target: { runId: string; taskId: string } | null) => void
  setActiveResearchGraphRunId: (runId: string | null) => void
  setResearchHistoryOpen: (open: boolean) => void
  fetchResearchCardDetails: (runId: string) => Promise<void>
  respondPermission: (requestId: string, decision: 'allow' | 'deny', scope?: 'once' | 'session', feedback?: string) => void
  setDraft: (text: string) => void
  takeRetainedEditorText: () => string | null
  /** Runs `/tree` and `/compact [instructions]`; reports whether the text was a command. */
  runSlashCommand: (raw: string) => boolean
  openTreePanel: () => void
  closeTreePanel: () => void
  fetchSessionTree: () => void
  setTreeFilterMode: (mode: TreeFilterMode) => void
  toggleSkipSummaryPrompt: () => void
  setLabelTimestampsVisible: (visible: boolean) => void
  navigateTree: (input: { targetId: string; summarize: boolean; customInstructions?: string | null }) => void
  setEntryLabel: (targetId: string, label: string | null) => void
  openCompactDialog: (customInstructions?: string | null) => void
  closeCompactDialog: () => void
  runCompact: (customInstructions: string | null) => void
  cancelSessionOperation: () => void
  /** Prefill for the dialog when it was opened by /compact with instructions. */
  compactDraft: string | null
  /** True while the engine compacts, however it was started (manual, auto, or retry). */
  isCompacting: boolean
}

// Batch complete, indexed events instead of flattening text/thinking into one bucket.
// Lifecycle/tool boundaries flush the batch before they mutate message ownership.
let bufferedEvents: BridgeEventEnvelope[] = []
let rafId: number | null = null

function resetDeltaBuffer(): void {
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = null
  bufferedEvents = []
}

function flushDeltaBuffer(apply: (events: BridgeEventEnvelope[]) => void): void {
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = null
  const events = bufferedEvents
  bufferedEvents = []
  if (events.length) apply(events)
}

function replayEvents(state: ConversationState, events: BridgeEventEnvelope[]): ConversationState {
  return events.reduce(reduceConversationEvent, state)
}

/** Title for a session row: its saved name, else first user message, else a fallback. */
function deriveTitle(s: SessionInfoOut): string {
  const name = (s.name || '').trim()
  if (name) return name
  const first = (s.firstMessage || '').trim()
  if (first && first !== '(no messages)') return first.length > 60 ? `${first.slice(0, 60)}…` : first
  return '新对话'
}

/** Group sessions by cwd (project), newest first inside each group. */
function groupSessions(sessions: SessionInfoOut[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>()
  for (const s of sessions) {
    const key = s.cwd || ''
    if (!groups.has(key)) {
      groups.set(key, { id: key || 'ungrouped', name: projectNameForCwd(key), sessions: [] })
    }
    groups.get(key)!.sessions.push({
      id: s.id,
      path: s.path,
      cwd: s.cwd,
      title: deriveTitle(s),
      modified: s.modified,
      messageCount: s.messageCount,
    })
  }
  for (const group of groups.values()) {
    group.sessions.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0))
  }
  return [...groups.values()].sort((a, b) => {
    const aLatest = a.sessions[0]?.modified || ''
    const bLatest = b.sessions[0]?.modified || ''
    return aLatest < bLatest ? 1 : aLatest > bLatest ? -1 : 0
  })
}

type HydrationCommand = { type: string; requestId: string; [key: string]: unknown }
let pendingHydrationRequestId: string | null = null
let pendingHydration: { command: HydrationCommand; timer: number; previewVersion: string | null; started?: Record<string, any> } | null = null
let retryCommand: HydrationCommand | null = null
let retryTargetPath: string | undefined
let listRequestId: string | null = null
let listTimer: number | null = null
let listDirty = false
const confirmedDeletedSessions = new Set<string>()
const pendingPrompts = new Map<string, { sessionId: string; userMessageId: string; placeholderId: string | null }>()
const MAX_ATTACHMENTS = 10
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

function attachmentName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path
}

function attachmentIdentity(path: string): string { return path.toLowerCase() }
let pendingTreeRequestId: string | null = null

function markSessionDeleted(path: string): void {
  confirmedDeletedSessions.add(path)
  sessionHistoryCache.delete(path)
  forgetSessionView(path)
  useSessionStore.setState(state => {
    const sessions = state.sessions.filter(session => session.path !== path)
    return { sessions, projects: groupSessions(sessions), sessionDeletion: null, lastDeletedSessionPath: path }
  })
}

function clearPendingHydration(): void {
  if (pendingHydration) window.clearTimeout(pendingHydration.timer)
  pendingHydration = null
  pendingHydrationRequestId = null
}

function cacheCurrentSession(state: SessionState): void {
  if (!state.currentSessionPath || state.isSessionLoading || state.sessionLoadError) return
  sessionHistoryCache.put({ path: state.currentSessionPath, sessionId: state.currentSessionId,
    title: state.currentTitle, workspace: state.currentWorkspace, messages: state.messages,
    historyVersion: state.sessionHistoryVersion,
    modified: state.sessions.find(session => session.path === state.currentSessionPath)?.modified,
    fileRevision: state.sessions.find(session => session.path === state.currentSessionPath)?.fileRevision })
}

/** A session swap makes any in-flight tree/compaction claim stale; its late reply must not land. */
function resetSessionOperationState(): Partial<SessionState> {
  return {
    sessionOperation: null,
    treePayload: null,
    treeLoading: false,
    treeError: null,
    treeFilterMode: null,
    compactStatus: { state: 'idle' },
    isCompacting: false,
  }
}

function beginHydration(command: HydrationCommand, targetPath?: string, keepDisplayedHistory = false): void {
  const state = useSessionStore.getState()
  flushDeltaBuffer(events => useSessionStore.setState(current => replayEvents(current, events)))
  cacheCurrentSession(useSessionStore.getState())
  clearPendingHydration()
  resetDeltaBuffer()
  retryCommand = command
  retryTargetPath = targetPath
  pendingHydrationRequestId = command.requestId
  const timer = window.setTimeout(() => {
    if (pendingHydrationRequestId !== command.requestId) return
    // Timeout is not readiness. Keep correlation so a late genuine ACK can settle.
    useSessionStore.setState({ isSessionLoading: false, isStreaming: false, isAborting: false,
      streamingMessageId: null, sessionLoadError: '会话准备超时，历史仍可阅读，请重试。' })
  }, 30000)
  pendingHydration = { command, timer, previewVersion: null }
  const cached = keepDisplayedHistory && state.currentSessionPath ? {
    path: state.currentSessionPath, sessionId: state.currentSessionId, title: state.currentTitle,
    workspace: state.currentWorkspace, messages: state.messages, historyVersion: state.sessionHistoryVersion,
  } : targetPath ? sessionHistoryCache.get(targetPath) : undefined
  if (keepDisplayedHistory && cached) targetPath = cached.path
  const known = state.sessions.find(session => session.path === targetPath)
  useSessionStore.setState({ ...resetSessionOperationState(), isSessionLoading: true, isStreaming: true, isAborting: false,
    streamingMessageId: null, pendingPermissionRequest: null, sessionLoadError: null, treeOpen: false,
    sessionHistoryVersion: cached?.historyVersion ?? null,
    ...(targetPath ? { currentSessionPath: targetPath, currentSessionId: cached?.sessionId ?? known?.id ?? '',
      currentTitle: cached?.title ?? (known ? deriveTitle(known) : '加载会话'),
      currentWorkspace: cached?.workspace ?? known?.cwd ?? state.currentWorkspace,
      messages: cached?.messages ?? [] } : { messages: [], currentSessionPath: null, currentSessionId: '', currentTitle: '新对话' }) })
  sendBridge(command)
}

function sendBridge(cmd: Record<string, any>) {
  if (window.bridge?.send) window.bridge.send(cmd)
}

export const useSessionStore = create<SessionState>((set, get) => ({
  currentSessionId: '',
  activeSessionId: '',
  activeSessionPath: null,
  sessionHistoryVersion: null,
  sessionLoadError: null,
  sessionSwitchTimings: null,
  currentTitle: '新对话',
  currentSessionPath: null,
  currentWorkspace: '',
  recentWorkspaces: loadRecentWorkspaces(),
  sessionFilterScope: 'here',
  isStreaming: false,
  isAborting: false,
  isSessionLoading: false,
  lastEventSeq: 0,
  permissionMode: 'default',
  agentMode: 'agent',
  pendingPermissionRequest: null,
  currentModel: {
    provider: 'deepseek',
    modelId: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    thinking: '高',
  },
  sessions: [],
  sessionDeletion: null,
  lastDeletedSessionPath: null,
  projects: [],
  researchRuns: [],
  researchGraph: null,
  researchRunId: null,
  researchCards: {},
  researchConversation: emptyResearchConversation(),
  researchBinding: null,
  researchConnectionError: null,
  researchPendingCreationRequestId: null,
  researchHistoryVersion: null,
  researchHostStats: {},
  researchContextUsage: null,
  researchTeam: null,
  researchModelBinding: null,
  researchTeamEventSeq: 0,
  activeResearchTaskId: null,
  activeResearchGraphRunId: null,
  researchHistoryOpen: false,
  messages: [],
  streamingMessageId: null,
  draft: '',
  attachments: [],
  retainedEditorText: null,
  treeOpen: false,
  treePayload: null,
  treeLoading: false,
  treeError: null,
  treeFilterMode: null,
  treeFilterModeTouched: false,
  labelTimestampsVisible: readLabelTimestampsVisible(),
  skipSummaryPrompt: readSkipSummaryPrompt(),
  compactOpen: false,
  compactStatus: { state: 'idle' },
  sessionOperation: null,
  compactDraft: null,
  isCompacting: false,

  setDraft: (text: string) => set({ draft: text }),

  bindResearchConversation: (snapshot) => {
    if (!snapshot.session?.sessionId || !Array.isArray(snapshot.messages)) return
    set(state => {
      const sameSession = state.researchBinding?.sessionId === snapshot.session.sessionId
      const sameStream = sameSession && snapshot.streamId && state.researchBinding?.streamId === snapshot.streamId
      if (sameStream && snapshot.lastEventSeq < state.researchConversation.lastEventSeq) return state
      const history = projectResearchHistory(snapshot.messages)
      const owner = sameStream ? state.researchConversation.messages.find(message => message.id === state.researchConversation.streamingMessageId && message.isStreaming) : undefined
      const liveOwner = owner && !history.some(message => message.role === 'assistant' &&
        (message.id === owner.id || message.timestamp === owner.timestamp || Boolean(owner.entryId && message.entryId === owner.entryId))) ? owner : undefined
      const hasNativeLifecycle = typeof snapshot.isStreaming === 'boolean' || typeof snapshot.isIdle === 'boolean'
      const nativeBusy = snapshot.isStreaming === true || snapshot.isIdle === false
      const isStreaming = liveOwner ? state.researchConversation.isStreaming
        : hasNativeLifecycle ? nativeBusy
          : Boolean(sameStream && state.researchConversation.isStreaming) || isResearchRunActive(snapshot.run?.status)
      const messages = reconcileResearchPendingHistory(liveOwner ? [...history, liveOwner] : history, sameSession ? state.researchConversation.messages : [])
      const cards = hydrateResearchHistoryCards(state.researchCards, snapshot.messages)
      for (const message of snapshot.messages) {
        const runId = researchNoticeRunId(message)
        if (runId && cards[runId] && !cards[runId].workspace) cards[runId] = { ...cards[runId], workspace: snapshot.session.cwd }
      }
      if (snapshot.run) {
        const run = snapshot.run
        const question = messages.find(message => message.customType === 'research-question')?.content
          || messages.find(message => message.role === 'user')?.content || ''
        cards[run.id] = { ...(cards[run.id] || { runId: run.id, question, workspace: snapshot.session.cwd, tasks: [], updatedAt: Date.now() }),
          status: run.status, phase: run.phase,
          ...(run.status !== 'waiting_input' ? { pendingQuestions: [] } : {}),
          ...(isResearchRunActive(run.status) ? { error: null } : {}) }
      }
      return {
        researchBinding: { sessionId: snapshot.session.sessionId, sessionFile: snapshot.session.file, workspace: snapshot.session.cwd, runId: snapshot.run?.id ?? null,
          ...(snapshot.streamId ? { streamId: snapshot.streamId } : {}) },
        researchConversation: { ...emptyResearchConversation(), currentSessionId: snapshot.session.sessionId,
          messages, lastEventSeq: snapshot.lastEventSeq ?? 0,
          streamingMessageId: liveOwner?.id ?? null,
          isStreaming,
          isAborting: liveOwner ? state.researchConversation.isAborting : false },
        researchCards: cards, researchConnectionError: null,
        researchPendingCreationRequestId: snapshot.run || !sameSession ? null : state.researchPendingCreationRequestId,
        researchHistoryVersion: snapshot.historyVersion,
        researchHostStats: snapshot.stats, researchContextUsage: snapshot.contextUsage,
        researchTeam: snapshot.team === undefined && sameSession ? state.researchTeam : snapshot.team ?? null,
        researchModelBinding: sameSession && state.researchModelBinding && (!snapshot.modelBinding || snapshot.modelBinding.epoch < state.researchModelBinding.epoch)
          ? state.researchModelBinding : snapshot.modelBinding ?? null,
        researchTeamEventSeq: Math.max(snapshot.lastEventSeq ?? 0, sameSession ? state.researchTeamEventSeq : 0),
      }
    })
  },

  applyResearchTeamSnapshot: (sessionId, snapshot, seq) => {
    set(state => {
      if (sessionId !== state.researchBinding?.sessionId) return state
      if (seq !== undefined && seq <= state.researchTeamEventSeq) return state
      if (snapshot.modelBinding && state.researchModelBinding && snapshot.modelBinding.epoch < state.researchModelBinding.epoch) return state
      return {
        ...(snapshot.team !== undefined ? { researchTeam: snapshot.team } : {}),
        ...(snapshot.modelBinding !== undefined ? { researchModelBinding: snapshot.modelBinding } : {}),
        ...(seq !== undefined ? { researchTeamEventSeq: seq } : {}),
      }
    })
  },

  clearResearchConversation: () => {
    const state = get()
    const runStatus = state.researchBinding?.runId ? state.researchCards[state.researchBinding.runId]?.status : undefined
    if (state.researchConversation.isStreaming || state.researchConversation.isAborting || state.researchPendingCreationRequestId ||
      isResearchRunActive(runStatus) || runStatus === 'waiting_input' ||
      state.researchConversation.messages.some(message => message.optimistic)) return
    set({ researchBinding: null, researchConversation: emptyResearchConversation(), researchConnectionError: null,
      researchPendingCreationRequestId: null,
      researchHistoryVersion: null, researchHostStats: {}, researchContextUsage: null,
      researchTeam: null, researchModelBinding: null, researchTeamEventSeq: 0,
      activeResearchTaskId: null, activeResearchGraphRunId: null })
  },

  queueResearchMessage: (requestId, text) => {
    if (!get().researchBinding || !text.trim()) return
    set(state => {
      if (state.researchConversation.messages.some(message => message.requestId === requestId)) return state
      const message: ChatMessage = { id: `research-user-${requestId}`, role: 'user', content: text.trim(), timestamp: Date.now(),
        requestId, optimistic: true, deliveryStatus: 'pending' }
      return { researchConnectionError: null, researchPendingCreationRequestId: state.researchBinding?.runId ? null : requestId,
        researchConversation: { ...state.researchConversation, messages: [...state.researchConversation.messages, message] } }
    })
  },

  acceptResearchMessage: (requestId) => set(state => ({ researchConversation: { ...state.researchConversation,
    messages: state.researchConversation.messages.map(message => message.requestId === requestId && message.deliveryStatus === 'pending'
      ? { ...message, deliveryStatus: 'accepted' } : message) } })),

  failResearchMessage: (requestId, error) => set(state => {
    if (!state.researchConversation.messages.some(message => message.requestId === requestId)) return state
    return { researchConnectionError: error,
      researchPendingCreationRequestId: state.researchPendingCreationRequestId === requestId ? null : state.researchPendingCreationRequestId,
      researchConversation: { ...state.researchConversation,
      messages: state.researchConversation.messages.map(message => message.requestId === requestId
        ? { ...message, optimistic: false, deliveryStatus: 'failed', submissionError: error } : message) } }
  }),

  handleResearchBridgeMessage: (msg) => {
    if ('type' in msg && msg.type === 'ack') {
      if (msg.requestId) {
        if (msg.ok) get().acceptResearchMessage(msg.requestId)
        else get().failResearchMessage(msg.requestId, msg.error || '研究消息提交失败')
      }
      return
    }
    if (!('event' in msg) || !msg.event) return
    const binding = get().researchBinding
    const streamId = (msg as BridgeEventEnvelope & { streamId?: string }).streamId
    if (binding?.streamId && streamId && streamId !== binding.streamId) return
    if (msg.event.type === 'research_connection_error') {
      if (binding && (!msg.sessionId || msg.sessionId === binding.sessionId)) {
        set({ researchConnectionError: String(msg.event.error || msg.event.message || '研究连接已断开') })
      }
      return
    }
    if (typeof msg.seq !== 'number') return
    const envelope = msg as BridgeEventEnvelope
    const state = get()
    if (!state.researchBinding || msg.sessionId !== state.researchBinding.sessionId || msg.seq <= state.researchConversation.lastEventSeq) return
    if (msg.event.type === 'desktop-team' || msg.event.type === 'desktop-model-switch') {
      get().applyResearchTeamSnapshot(msg.sessionId, msg.event.details ?? msg.event, msg.seq)
    }
    set(current => {
      const conversation = reduceResearchConversationEvent(current.researchConversation, envelope)
      const raw = msg.event.type === 'message_end' ? msg.event.message : null
      const runId = raw?.customType?.startsWith('research-') && raw.customType !== 'research-input' ? researchNoticeRunId(raw) : ''
      let cards = current.researchCards
      if (runId) {
        const card = applyResearchNoticeToCard(cards[runId], raw)
        if (!card.workspace) card.workspace = current.researchBinding?.workspace
        if (!card.question) {
          const question = [...conversation.messages].reverse().find(message => message.customType === 'research-question')
          if (question) card.question = question.content
        }
        cards = { ...cards, [runId]: card }
      }
      const startupError = raw?.customType === 'research-progress' && raw.details?.stage === 'startup_error'
      return { researchConversation: conversation, researchCards: cards,
        researchBinding: raw?.customType === 'research-discipline' && runId ? { ...current.researchBinding!, runId } : current.researchBinding,
        researchPendingCreationRequestId: (raw?.customType === 'research-discipline' && runId) || startupError ? null
          : raw?.customType === 'research-question' && !current.researchBinding?.runId
            ? raw.details?.requestId || current.researchPendingCreationRequestId || `research-question-${msg.seq}` : current.researchPendingCreationRequestId,
        researchConnectionError: startupError ? raw.content || '研究启动失败' : current.researchConnectionError }
    })
  },

  prepareAttachments: async (paths: string[]) => {
    const current = get().attachments
    const seen = new Set(current.map(item => attachmentIdentity(item.path)))
    const unique = paths.filter(path => {
      if (typeof path !== 'string' || !path.trim()) return false
      const identity = attachmentIdentity(path)
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    })
    if (!unique.length) return

    const available = Math.max(0, MAX_ATTACHMENTS - current.length)
    const selected = unique.slice(0, available)
    const tooMany = unique.slice(available)
    const pending: PreparedAttachment[] = [
      ...selected.map(path => ({ path, name: attachmentName(path), size: 0, kind: 'unsupported' as const, text: '', images: [], error: null, status: 'preparing' as const })),
      ...tooMany.map(path => ({ path, name: attachmentName(path), size: 0, kind: 'unsupported' as const, text: '', images: [], error: `最多可添加 ${MAX_ATTACHMENTS} 个附件`, status: 'error' as const })),
    ]
    set(state => ({ attachments: [...state.attachments, ...pending] }))
    if (!selected.length) return

    try {
      const result = await request<{ attachments?: AttachmentPreparation[] }>('prepare_attachments', { paths: selected }, 120000)
      const prepared = result.attachments ?? []
      const byPath = new Map(prepared.map(item => [item.path, item]))
      set(state => {
        let totalBytes = state.attachments.reduce((sum, item) => item.status === 'ready' && !selected.includes(item.path) ? sum + item.size : sum, 0)
        const attachments = state.attachments.map(item => {
          if (!selected.includes(item.path) || item.status !== 'preparing') return item
          const value = byPath.get(item.path)
          if (!value) return { ...item, status: 'error' as const, error: '附件处理没有返回结果' }
          if (value.error) return { ...item, ...value, status: 'error' as const }
          if (value.size > 10 * 1024 * 1024 || totalBytes + value.size > MAX_ATTACHMENT_BYTES) {
            return { ...item, ...value, images: [], status: 'error' as const, error: '附件总大小超过 25 MiB' }
          }
          totalBytes += value.size
          return { ...item, ...value, status: 'ready' as const }
        })
        return { attachments }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '附件处理失败'
      set(state => ({ attachments: state.attachments.map(item => selected.includes(item.path) && item.status === 'preparing'
        ? { ...item, status: 'error' as const, error: message } : item) }))
    }
  },

  retryAttachment: async (path: string) => {
    if (!get().attachments.some(item => item.path === path && item.status === 'error')) return
    set(state => ({ attachments: state.attachments.filter(item => item.path !== path) }))
    await get().prepareAttachments([path])
  },

  removeAttachment: (path: string) => set(state => ({ attachments: state.attachments.filter(item => item.path !== path) })),
  clearAttachments: () => set({ attachments: [] }),

  takeRetainedEditorText: () => {
    const held = get().retainedEditorText
    if (held !== null) set({ retainedEditorText: null })
    return held
  },

  runSlashCommand: (raw: string) => {
    const trimmed = raw.trim()
    const compactMatch = trimmed.match(/^\/compact(?:\s+(.*))?$/s)
    if (trimmed !== '/tree' && !compactMatch) return false
    // Resolve commands before the composer creates an optimistic user row.
    set({ draft: '' })
    if (trimmed === '/tree') get().openTreePanel()
    else get().openCompactDialog(compactMatch?.[1]?.trim() || null)
    return true
  },

  sendMessage: (text: string, streamingBehavior: 'steer' | 'followUp' = 'steer', images: PromptImage[] = []) => {
    if (get().isSessionLoading || get().sessionLoadError || get().isAborting || get().sessionOperation) return
    const requestId = newRequestId('prompt')
    const trimmed = text.trim()
    if (!trimmed && !images.length) return
    const streaming = get().isStreaming

    const userMessage: ChatMessage = {
      id: `user-${requestId}`,
      role: 'user',
      content: trimmed,
      ...(images.length ? { images } : {}),
      optimistic: true,
      streamingBehavior,
      timestamp: Date.now(),
    }

    if (streaming) {
      // The turn already streaming keeps streaming; no placeholder, or the live tail would show
      // an empty answer beside the one still arriving.
      set((state) => ({ messages: [...state.messages, userMessage] }))
    } else {
      const assistantPlaceholder: ChatMessage = {
        id: `assistant-${requestId}`,
        role: 'assistant',
        content: '',
        blocks: [],
        thinking: '',
        timestamp: Date.now(),
        isStreaming: true,
      }
      resetDeltaBuffer()
      set((state) => ({
        messages: [...state.messages, userMessage, assistantPlaceholder],
        isStreaming: true,
        isAborting: false,
        streamingMessageId: assistantPlaceholder.id,
      }))
    }

    pendingPrompts.set(requestId, { sessionId: get().currentSessionId, userMessageId: userMessage.id, placeholderId: streaming ? null : get().streamingMessageId })
    try {
      if (!window.bridge?.send) throw new Error('桌面桥接进程尚未就绪')
      window.bridge.send({
        type: 'prompt',
        requestId,
        text: trimmed,
        streamingBehavior,
        ...(images.length ? { images: images.map(({ type, mimeType, data }) => ({ type, mimeType, data })) } : {}),
      })
    } catch (error) {
      get().handleBridgeMessage({ type: 'ack', requestId, ok: false, error: error instanceof Error ? error.message : '任务提交失败' })
    }
  },

  retryMessage: (messageId: string) => {
    if (get().isSessionLoading || get().sessionLoadError || get().isAborting) return
    const message = get().messages.find(m => m.id === messageId && m.role === 'user' && m.submissionError)
    if (!message) return
    set(state => ({ messages: state.messages.filter(m => m.id !== messageId) }))
    get().sendMessage(message.content, message.streamingBehavior ?? 'steer', message.images)
  },

  abortGeneration: () => {
    if (!get().isStreaming || get().isAborting || get().isSessionLoading) return
    flushDeltaBuffer((events) => set((state) => replayEvents(state, events)))
    // Abort is a request, not an idle notification. Keep Stop/busy active until settled.
    set({ isAborting: true })
    sendBridge({ type: 'abort', requestId: `abort-${Date.now()}` })
  },

  fetchSessions: () => {
    if (listRequestId) { listDirty = true; return }
    listRequestId = newRequestId('ls')
    listDirty = false
    listTimer = window.setTimeout(() => { listRequestId = null; listTimer = null; listDirty = false }, 20000)
    sendBridge({ type: 'list_sessions', requestId: listRequestId })
  },

  openSession: (path: string) => {
    if (path === get().currentSessionPath && !get().isSessionLoading && !get().sessionLoadError) return
    beginHydration({ type: 'load_session', requestId: newRequestId('load'), path, preview: true }, path)
  },

  retrySessionLoad: () => {
    if (!retryCommand) return
    const prefix = retryCommand.type === 'switch_workspace' ? 'sw' : retryCommand.type === 'new_session' ? 'new' : retryCommand.type === 'fork_session' ? 'fork' : 'load'
    const command: HydrationCommand = { ...retryCommand, requestId: newRequestId(prefix) }
    beginHydration(command, retryTargetPath, true)
  },

  createSession: (carryOverContext = false) => {
    beginHydration({ type: 'new_session', requestId: newRequestId('new'), carryOverContext,
      cwd: get().currentWorkspace || undefined })
  },

  switchWorkspace: (workspacePath: string, targetSessionPath?: string) => {
    const normalized = workspacePath.trim()
    if (!normalized) return
    if (normalizeWorkspacePath(normalized) === normalizeWorkspacePath(get().currentWorkspace) && !targetSessionPath && !get().sessionLoadError && !get().isSessionLoading) return
    const target = targetSessionPath ?? get().sessions.filter(session => normalizeWorkspacePath(session.cwd) === normalizeWorkspacePath(normalized))
      .sort((a, b) => b.modified.localeCompare(a.modified))[0]?.path
    const updatedRecent = addRecentWorkspace(normalized, get().recentWorkspaces)
    saveRecentWorkspaces(updatedRecent)
    beginHydration({ type: 'switch_workspace', requestId: newRequestId('sw'), path: normalized,
      sessionPath: targetSessionPath, preview: true }, target)
    set({ currentWorkspace: normalized, recentWorkspaces: updatedRecent })
  },

  syncWorkspaceCwd: (workspacePath: string) => {
    const normalized = workspacePath.trim()
    if (!normalized) return
    const recentWorkspaces = addRecentWorkspace(normalized, get().recentWorkspaces)
    saveRecentWorkspaces(recentWorkspaces)
    set({ currentWorkspace: normalized, recentWorkspaces })
  },

  openWorkspaceDialog: async () => {
    if (window.app?.pickDirectory) {
      const chosen = await window.app.pickDirectory()
      if (chosen) {
        get().switchWorkspace(chosen)
        return chosen
      }
    }
    return null
  },

  setSessionFilterScope: (scope: SessionFilterScope) => {
    set({ sessionFilterScope: scope })
  },

  renameSession: async (path: string, name: string) => {
    const trimmed = name.trim()
    if (!path || !trimmed) return
    if (get().sessions.find(session => session.path === path)?.name === trimmed) return
    await request('rename_session', { path, name: trimmed })
    sessionHistoryCache.delete(path)
    set(state => ({
      sessions: state.sessions.map(session => session.path === path ? { ...session, name: trimmed } : session),
      ...(state.currentSessionPath === path ? { currentTitle: trimmed } : {}),
    }))
    get().fetchSessions()
  },

  deleteSession: (path: string) => get().requestSessionDeletion(path),

  requestSessionDeletion: (path: string) => {
    if (!path) return
    const pending = get().sessionDeletion
    if (pending?.status === 'pending') return
    set({ sessionDeletion: { path, requestId: null, status: 'confirm' } })
  },

  cancelSessionDeletion: () => {
    if (get().sessionDeletion?.status === 'pending') return
    set({ sessionDeletion: null })
  },

  confirmSessionDeletion: async () => {
    const deletion = get().sessionDeletion
    if (!deletion || deletion.status === 'pending') return false

    const state = get()
    const deletingActive = deletion.path === state.currentSessionPath || deletion.path === state.activeSessionPath
    if (deletingActive && (state.isStreaming || state.isAborting || state.isSessionLoading || state.sessionLoadError
      || state.sessionOperation || state.isCompacting || state.pendingPermissionRequest)) {
      set({ sessionDeletion: { ...deletion, status: 'error', error: '当前会话仍有任务或会话操作，请先停止后再删除。' } })
      return false
    }

    const requestId = newRequestId('delete')
    set({ sessionDeletion: { ...deletion, requestId, status: 'pending', error: undefined } })
    try {
      await request<{ path: string; session?: Record<string, any> }>('delete_session', { requestId, path: deletion.path }, 20000)
      const latest = get().sessionDeletion
      if (latest?.requestId !== requestId) return false
      markSessionDeleted(deletion.path)
      get().fetchSessions()
      return true
    } catch (error) {
      const latest = get().sessionDeletion
      if (latest?.requestId === requestId) {
        set({ sessionDeletion: { ...latest, status: 'error', error: error instanceof Error ? error.message : '删除会话失败' } })
      }
      get().fetchSessions()
      return false
    }
  },

  forkSession: (entryId: string | null, position: 'before' | 'at' = 'before') => {
    if (get().isSessionLoading || get().sessionLoadError || get().sessionOperation || get().isCompacting) return
    beginHydration({ type: 'fork_session', requestId: newRequestId('fork'), entryId: entryId || undefined, position })
  },

  fetchResearchRuns: () => {
    sendBridge({ type: 'list_research_runs', requestId: `req_runs_${Date.now()}` })
  },

  fetchResearchGraph: (runId?: string) => {
    sendBridge({ type: 'get_research_graph', requestId: `req_graph_${Date.now()}`, runId: runId || undefined })
  },

  upsertResearchCard: (card) => {
    set(state => ({
      researchCards: {
        ...state.researchCards,
        [card.runId]: {
          ...(state.researchCards[card.runId] || {
            runId: card.runId,
            question: '',
            status: 'active',
            phase: 'active',
            tasks: [],
            findings: [],
            pendingQuestions: [],
            report: null,
            error: null,
            updatedAt: Date.now(),
          }),
          ...card,
          updatedAt: Date.now(),
        },
      },
    }))
  },

  setActiveResearchTask: (target) => set({ activeResearchTaskId: target }),
  setActiveResearchGraphRunId: (runId) => set({ activeResearchGraphRunId: runId }),
  setResearchHistoryOpen: (open) => set({ researchHistoryOpen: open }),

  fetchResearchCardDetails: async (runId: string) => {
    try {
      const workspace = get().researchCards[runId]?.workspace
        || get().researchRuns.find(r => r.id === runId)?.workspace
        || get().currentWorkspace
      const detail = await request<ResearchRunDetail>('get_research_details', { runId, workspace })
      if (detail?.run?.id === runId) {
        set(state => ({
          researchCards: {
            ...state.researchCards,
            [runId]: hydrateCardFromDetail(state.researchCards[runId], detail),
          },
        }))
      }
    } catch {
      // ignore errors
    }
  },

  setAgentMode: (mode) => {
    if (get().isSessionLoading || get().sessionLoadError || get().sessionOperation || get().isCompacting) return
    if (mode === 'research') get().setPermissionMode('bypassPermissions')
    set({ agentMode: mode })
  },

  setPermissionMode: (mode: PermissionMode) => {
    if (get().isSessionLoading || get().sessionLoadError || get().sessionOperation || get().isCompacting) return
    set({ permissionMode: mode, agentMode: 'agent' })
    sendBridge({
      type: 'set_permission_mode',
      requestId: `req_perm_${Date.now()}`,
      mode,
    })
  },

  respondPermission: (requestId: string, decision: 'allow' | 'deny', scope = 'once', feedback?: string) => {
    set((state) => ({
      pendingPermissionRequest:
        state.pendingPermissionRequest?.requestId === requestId ? null : state.pendingPermissionRequest,
    }))
    sendBridge({
      type: 'permission_response',
      requestId,
      decision,
      scope,
      feedback,
    })
  },

  openTreePanel: () => {
    if (get().isSessionLoading || get().sessionLoadError) return
    set({ treeOpen: true })
    get().fetchSessionTree()
  },

  closeTreePanel: () => set({ treeOpen: false }),

  setLabelTimestampsVisible: (visible: boolean) => {
    try { localStorage.setItem(STORAGE_LABEL_TIMESTAMPS_KEY, visible ? '1' : '0') } catch {}
    set({ labelTimestampsVisible: visible })
  },

  openCompactDialog: (customInstructions = null) => {
    set({ compactOpen: true, compactDraft: typeof customInstructions === 'string' ? customInstructions : null })
  },

  closeCompactDialog: () => set({ compactOpen: false }),

  fetchSessionTree: () => {
    const state = get()
    if (state.isSessionLoading || state.sessionLoadError || !state.currentSessionId) return
    const requestId = newRequestId('tree')
    pendingTreeRequestId = requestId
    set({ treeLoading: true, treeError: null })
    sendBridge({ type: 'get_session_tree', requestId })
  },

  setTreeFilterMode: (mode: TreeFilterMode) => {
    if (!TREE_FILTER_MODES.includes(mode) || get().sessionOperation) return
    set({ treeFilterMode: mode, treeFilterModeTouched: true })
    sendBridge({ type: 'set_tree_filter_mode', requestId: newRequestId('tree_filter'), mode })
  },

  toggleSkipSummaryPrompt: () => {
    const next = !get().skipSummaryPrompt
    set({ skipSummaryPrompt: next })
    saveSkipSummaryPrompt(next)
    sendBridge({ type: 'set_setting', requestId: `req_set_skip_prompt_${Date.now()}`, section: 'branchSummary', key: 'skipPrompt', value: next })
  },

  navigateTree: ({ targetId, summarize, customInstructions = null }) => {
    const state = get()
    if (!targetId || state.sessionOperation || state.isSessionLoading || state.sessionLoadError) return
    const requestId = newRequestId('op')
    set({
      sessionOperation: { requestId, operation: 'navigate_tree', sessionId: state.currentSessionId },
      treeError: null,
    })
    sendBridge({ type: 'navigate_tree', requestId, targetId, summarize, customInstructions })
  },

  setEntryLabel: (targetId, label) => {
    if (!targetId || get().sessionOperation || get().isCompacting) return
    sendBridge({ type: 'set_entry_label', requestId: newRequestId('label'), targetId, label })
  },

  runCompact: (customInstructions) => {
    const state = get()
    if (state.sessionOperation || state.isSessionLoading || state.sessionLoadError) return
    const requestId = newRequestId('op')
    set({
      sessionOperation: { requestId, operation: 'compact_session', sessionId: state.currentSessionId },
      compactStatus: { state: 'running' },
    })
    sendBridge({ type: 'compact_session', requestId, customInstructions })
  },

  cancelSessionOperation: () => {
    const active = get().sessionOperation
    if (!active) return
    sendBridge({ type: 'cancel_session_operation', requestId: `req_cancel_${Date.now()}`, operationRequestId: active.requestId })
  },

  handleBridgeMessage: (msg: BridgeMessage) => {
    if ('type' in msg && msg.type === 'ack') {
      const deletion = get().sessionDeletion
      if (deletion?.status === 'error' && deletion.requestId && msg.requestId === deletion.requestId) {
        if (msg.ok) {
          markSessionDeleted(deletion.path)
          get().fetchSessions()
        } else {
          set({ sessionDeletion: { ...deletion, error: msg.error || deletion.error } })
        }
        return
      }
      const data = msg.data || {}
      let supersededSessionList = false
      const prompt = msg.requestId ? pendingPrompts.get(msg.requestId) : undefined
      if (prompt) {
        pendingPrompts.delete(msg.requestId!)
        if (!msg.ok && prompt.sessionId === get().currentSessionId) {
          flushDeltaBuffer(events => set(state => replayEvents(state, events)))
          const user = get().messages.find(m => m.id === prompt.userMessageId)
          // Text-only echoes are FIFO guesses, not request-level acceptance evidence.
          if (!user) return
          set(state => ({ messages: state.messages.map(m => m.id === user.id
            ? { ...m, optimistic: false, submissionError: msg.error || '任务提交失败' } : m) }))
          const owner = get().messages.find(m => m.id === prompt.placeholderId)
          if (owner && !owner.content && !owner.thinking && !owner.toolCalls?.length) {
            set(state => ({ messages: state.messages.filter(m => m.id !== owner.id),
              ...(state.streamingMessageId === owner.id ? { isStreaming: false, streamingMessageId: null } : {}) }))
          }
        }
        return
      }
      if (msg.requestId && msg.requestId === pendingTreeRequestId) {
        pendingTreeRequestId = null
        set({ treeLoading: false, ...(msg.ok ? { treePayload: data as SessionTreePayload, treeError: null,
          ...(data.settings?.treeFilterMode && !get().treeFilterModeTouched ? { treeFilterMode: data.settings.treeFilterMode as TreeFilterMode } : {}),
          ...(typeof data.settings?.branchSummarySkipPrompt === 'boolean' ? { skipSummaryPrompt: data.settings.branchSummarySkipPrompt } : {}) }
          : { treeError: msg.error || '读取会话树失败' }) })
        return
      }
      if (msg.requestId?.startsWith('req_label_')) {
        if (msg.ok) get().fetchSessionTree()
        else set({ treeError: msg.error || '保存标签失败' })
        return
      }
      const activeOperation = get().sessionOperation
      if (activeOperation && msg.requestId === activeOperation.requestId && !msg.ok) {
        set({ sessionOperation: null, compactStatus: activeOperation.operation === 'compact_session'
          ? { state: 'error', message: msg.error || '操作失败' } : get().compactStatus,
          treeError: activeOperation.operation === 'navigate_tree' ? (msg.error || '切换分支失败') : get().treeError })
        return
      }
      const hydrationReply = Boolean(msg.requestId && /^(req_load_|req_fork_|req_sw_|req_new_)/.test(msg.requestId))
      if (hydrationReply) {
        if (!pendingHydrationRequestId || msg.requestId !== pendingHydrationRequestId) return
        if (!msg.ok) {
          clearPendingHydration()
          resetDeltaBuffer()
          set({ isStreaming: false, isSessionLoading: false, isAborting: false, streamingMessageId: null,
            sessionLoadError: msg.error || '会话加载失败，请重试。' })
          return
        }
        const info = data.session || pendingHydration?.started || {}
        if (data.historyUnchanged && (pendingHydration?.previewVersion !== data.historyVersion || get().currentSessionPath !== info.file)) {
          clearPendingHydration()
          set({ isSessionLoading: false, isStreaming: false, sessionLoadError: '历史同步未完成，请重试。' })
          return
        }
        const messages = data.historyUnchanged ? get().messages : (data.messages || []).map(normalizeChatMessage)
        const ws = info.cwd || data.workspace || get().currentWorkspace
        const path = info.file || null
        const existing = get().sessions.find(session => session.path === path)
        const recent = ws ? addRecentWorkspace(ws, get().recentWorkspaces) : get().recentWorkspaces
        saveRecentWorkspaces(recent)
        clearPendingHydration()
        resetDeltaBuffer()
        retryCommand = null
        set({ currentSessionId: info.sessionId || '', activeSessionId: info.sessionId || '',
          currentSessionPath: path, activeSessionPath: path, currentWorkspace: ws, recentWorkspaces: recent,
          currentTitle: info.name || (existing ? deriveTitle(existing) : '新对话'), messages,
          sessionHistoryVersion: data.historyVersion || null, sessionLoadError: null,
          sessionSwitchTimings: data.timings || null, isStreaming: false, isSessionLoading: false,
          isAborting: false, streamingMessageId: null,
          permissionMode: info.permissionMode || get().permissionMode })
        cacheCurrentSession(get())
        get().fetchSessions()
        return
      }
      if (msg.requestId?.startsWith('req_ls_')) {
        if (listRequestId && msg.requestId !== listRequestId) return
        supersededSessionList = listDirty
        if (listTimer !== null) window.clearTimeout(listTimer)
        listTimer = null
        listRequestId = null
        if (listDirty) { listDirty = false; window.setTimeout(() => get().fetchSessions(), 100) }
      }
      // list_sessions reply: refresh the sidebar groups.
      if (msg.requestId && msg.requestId.startsWith('req_ls_') && msg.ok) {
        const backendList: SessionInfoOut[] = data.sessions || []
        const list = backendList.filter(session => !confirmedDeletedSessions.has(session.path))
        if (!supersededSessionList) {
          for (const path of confirmedDeletedSessions) {
            if (!backendList.some(session => session.path === path)) confirmedDeletedSessions.delete(path)
          }
        }
        sessionHistoryCache.invalidateChanged(list)
        const currentWs = get().currentWorkspace
        let nextWs = currentWs
        let nextRecent = get().recentWorkspaces
        if (!nextWs && list.length > 0 && list[0].cwd) {
          nextWs = list[0].cwd
          nextRecent = addRecentWorkspace(nextWs, nextRecent)
          saveRecentWorkspaces(nextRecent)
        }
        set((state) => ({
          sessions: list,
          projects: groupSessions(list),
          currentWorkspace: nextWs,
          recentWorkspaces: nextRecent,
          currentTitle: state.currentSessionPath
            ? list.find((s) => s.path === state.currentSessionPath)?.name || state.currentTitle
            : state.currentTitle,
        }))
        return
      }

      // list_research_runs reply.
      if (msg.requestId && msg.requestId.startsWith('req_runs_') && msg.ok) {
        const runs = data.runs || []
        set(state => ({
          researchRuns: runs,
          researchCards: hydrateCardsFromRuns(state.researchCards, runs),
        }))
        return
      }
      // get_research_graph reply.
      if (msg.requestId && msg.requestId.startsWith('req_graph_') && msg.ok) {
        const graph: ResearchGraphPayload | null = data.graph || null
        set({ researchGraph: graph, researchRunId: data.run?.id || null })
        return
      }
      // Only correlated session operations may release loading; background query errors
      // must not abort an unrelated run or discard its buffered deltas.
      if (!msg.ok && msg.requestId?.startsWith('req_new_') && get().isSessionLoading) {
        set({ isStreaming:false, isSessionLoading:false })
      }
      return
    }

    if (!('event' in msg) || !msg.event) return
    const ev = msg.event
    const evType = ev.type
    if (evType === 'session_operation_end') {
      const active = get().sessionOperation
      if (!active || active.requestId !== ev.requestId) return
      if (active.sessionId !== get().currentSessionId || msg.sessionId !== get().currentSessionId) {
        set({ sessionOperation: null, isCompacting: false, compactStatus: { state: 'idle' } })
        return
      }
      const status = ev.status as SessionOperationResult['status']
      const isCompact = active.operation === 'compact_session'
      if (status === 'done' && active.operation === 'navigate_tree') {
        flushDeltaBuffer(events => set(state => replayEvents(state, events)))
        const messages = (Array.isArray(ev.messages) ? ev.messages : []).map(normalizeChatMessage)
        const returned = typeof ev.editorText === 'string' && ev.editorText ? ev.editorText : null
        const currentDraft = get().draft
        set({ messages, sessionHistoryVersion: ev.historyVersion || get().sessionHistoryVersion,
          ...(returned ? currentDraft.trim() ? { retainedEditorText: returned } : { draft: returned } : {}),
          sessionOperation: null, treeError: null, treeLoading: false })
        cacheCurrentSession(get())
        get().fetchSessions()
        if (get().treeOpen) get().fetchSessionTree()
        return
      }
      set({ sessionOperation: null, isCompacting: false,
        compactStatus: isCompact ? { state: status === 'done' ? 'done' : status === 'error' ? 'error' : 'aborted',
          message: ev.error || (status === 'done' ? '压缩完成' : status === 'aborted' || status === 'cancelled' ? '压缩已取消' : '压缩失败') } : get().compactStatus,
        ...(active.operation === 'navigate_tree' && status === 'error' ? { treeError: ev.error || '切换分支失败' } : {}) })
      if (isCompact && status === 'done') {
        get().fetchSessions()
        if (get().treeOpen) get().fetchSessionTree()
      }
      return
    }
    if (evType === 'compaction_start') {
      if (msg.sessionId && get().currentSessionId && msg.sessionId !== get().currentSessionId) return
      set({ isCompacting: true, compactStatus: { state: 'running', message: '正在压缩上下文…' } })
      return
    }
    if (evType === 'compaction_end') {
      set({ isCompacting: false, compactStatus: ev.errorMessage
        ? { state: ev.aborted ? 'aborted' : 'error', message: ev.errorMessage }
        : ev.aborted ? { state: 'aborted', message: '压缩已取消' }
          : ev.result ? { state: 'done', message: '压缩完成' } : { state: 'idle' } })
      return
    }
    if (evType === 'session_operation_start') return
    if (evType === 'session_preview') {
      if (!pendingHydration || ev.requestId !== pendingHydrationRequestId) return
      resetDeltaBuffer()
      const info = ev.session || {}
      const messages = (ev.messages || []).map(normalizeChatMessage)
      pendingHydration.previewVersion = ev.historyVersion || null
      retryTargetPath = info.file || undefined
      set({ currentSessionId: info.sessionId || '', currentSessionPath: info.file || null,
        currentTitle: info.name || get().sessions.find(session => session.path === info.file)?.name || '新对话',
        currentWorkspace: info.cwd || get().currentWorkspace, messages, sessionHistoryVersion: ev.historyVersion || null })
      return
    }
    if (evType === 'session_started') {
      if (msg.seq <= get().lastEventSeq && get().currentSessionId) return
      const deletion = get().sessionDeletion
      if ((deletion?.status === 'pending' || deletion?.status === 'error') && deletion.requestId === ev.requestId) {
        resetDeltaBuffer()
        const ws = ev.cwd || get().currentWorkspace || ''
        const recent = ws ? addRecentWorkspace(ws, get().recentWorkspaces) : get().recentWorkspaces
        saveRecentWorkspaces(recent)
        set({ ...resetSessionOperationState(), currentSessionId: ev.sessionId || '', activeSessionId: ev.sessionId || '',
          currentSessionPath: ev.file || null, activeSessionPath: ev.file || null, currentTitle: ev.name || '新对话',
          currentWorkspace: ws, recentWorkspaces: recent, messages: [], sessionHistoryVersion: null,
          sessionLoadError: null, isStreaming: false, isAborting: false, isSessionLoading: false,
          streamingMessageId: null, lastEventSeq: msg.seq, treeOpen: false, treePayload: null, treeLoading: false,
          treeError: null, compactOpen: false, compactStatus: { state: 'idle' }, isCompacting: false })
        return
      }
      if (ev.requestId && ev.requestId !== pendingHydrationRequestId) return
      if (pendingHydration) {
        if (!ev.requestId && pendingHydration.command.type === 'load_session' && ev.file && ev.file !== pendingHydration.command.path) return
        pendingHydration.started = ev
        set({ activeSessionId: ev.sessionId || '', activeSessionPath: ev.file || null, lastEventSeq: msg.seq })
        return
      }
      resetDeltaBuffer()
      const ws = ev.cwd || get().currentWorkspace || ''
      const recent = ws ? addRecentWorkspace(ws, get().recentWorkspaces) : get().recentWorkspaces
      saveRecentWorkspaces(recent)
      retryCommand = null
      set({ ...resetSessionOperationState(), currentSessionId: ev.sessionId || '', activeSessionId: ev.sessionId || '',
        currentSessionPath: ev.file || null, activeSessionPath: ev.file || null,
        currentTitle: ev.name || '新对话', currentWorkspace: ws, recentWorkspaces: recent,
        messages: [], sessionHistoryVersion: null, sessionLoadError: null,
        isStreaming: false, isSessionLoading: false, streamingMessageId: null,
        isAborting: false, lastEventSeq: msg.seq, treeOpen: false, compactOpen: false,
        permissionMode: (ev.permissionMode as PermissionMode) || get().permissionMode })
      get().fetchSessions()
      return
    }
    if (pendingHydration) return
    if (msg.sessionId && get().currentSessionId && msg.sessionId !== get().currentSessionId) {
      const active = get().sessionOperation
      if (active && active.requestId === ev.requestId && active.sessionId !== get().currentSessionId) {
        set({ sessionOperation: null, isCompacting: false, compactStatus: { state: 'idle' } })
      }
      return
    }

    if (evType === 'permission:request') {
      set({
        pendingPermissionRequest: {
          requestId: ev.requestId,
          toolName: ev.toolName,
          toolInput: ev.toolInput || {},
          reason: ev.reason,
          mode: ev.mode,
          agentId: ev.agentId,
        },
      })
      return
    }

    if (evType === 'permission_mode_change') {
      if (ev.mode) {
        set({ permissionMode: ev.mode as PermissionMode })
      }
      return
    }

    if (evType === 'session_info_changed') {
      set({ currentTitle: ev.name || get().currentTitle })
      get().fetchSessions()
      return
    }

    const apply = (events: BridgeEventEnvelope[]) => set((state) => replayEvents(state, events))
    if (evType === 'message_update') {
      bufferedEvents.push(msg as BridgeEventEnvelope)
      if (rafId === null) rafId = requestAnimationFrame(() => flushDeltaBuffer(apply))
      return
    }
    flushDeltaBuffer(apply)
    if (evType === 'entry_appended') {
      const entry = ev.entry
      if (entry?.type === 'message' && entry.message) {
        const source = entry.message
        const match = [...get().messages].reverse().find(m => m.role === source.role && m.timestamp === source.timestamp && !m.entryId)
        const path = get().currentSessionPath
        if (match && path && entry.id) {
          migrateEntryDisclosures(path, match.id, String(entry.id))
        }
      }
    }
    set((state) => reduceConversationEvent(state, msg as BridgeEventEnvelope))
    if (evType === 'agent_settled') { cacheCurrentSession(get()); get().fetchSessions() }
  },
}))

export const useResearchCards = () => useSessionStore(state => state.researchCards)
