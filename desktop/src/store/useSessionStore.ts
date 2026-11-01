import { researchActivity, subscribeResearchRun, retainResearchActivity, beginResearchControl, upsertActivityDetail } from '../lib/researchActivityStore'
import { useSettingsStore } from './useSettingsStore'
import { emptyResearchEditor, newResearchOwner, type ResearchEditor, type ResearchView, type ResearchViewSelection, type ResearchControlTarget } from '../lib/researchView'
import { create } from 'zustand'
import type { ChatMessage, PermissionMode, PermissionRequestPayload, ProjectGroup, SessionFilterScope, SessionInfoOut, SessionOperationKind, SessionOperationResult, SessionTreePayload, TreeFilterMode } from '../types/session'
import type { DesktopResearchTeam, ResearchModelBinding, ResearchTeamSnapshot, ResearchConversationBinding, ResearchGraphPayload, ResearchHostSnapshot, ResearchRunSummary, ResearchFailureMetadata } from '../types/research'
import {
  applyResearchNoticeToCard,
  mergeResearchCard,
  hydrateCardsFromRuns,
  type ResearchRunCard,
} from '../lib/researchCards'
import type { BridgeMessage, BridgeEventEnvelope } from '../types/global'
import { reduceConversationEvent, type ConversationState } from '../lib/conversationEvents'
import { createResearchIngest } from '../lib/researchEventIngest'
import { normalizeChatMessage } from '../lib/messageBlocks'
import { clearResearchStartupRequest, emptyResearchConversation, hydrateResearchHistoryCards, isResearchRunActive, isResearchStartupFailure, projectResearchHistory, reconcileResearchPendingHistory, reduceResearchConversationEvent, researchNoticeRunId } from '../lib/researchConversation'
import { newRequestId, request } from '../lib/bridge'
import {
  beginResearchStop,
  clearResearchStop,
  confirmResearchStopped,
  failResearchStop,
  noteResearchStopAck,
  researchRunAtRest,
  unconfirmResearchStop,
} from '../lib/researchStop'
import { researchStopEntry } from './useResearchStopStore'
import { refreshResearchStopTarget, sameResearchStopPath, type ResearchStopTarget } from '../lib/researchStopRecovery'
import { cancelResearchStartup, startComposerResearch, type ResearchSubmissionInput } from '../lib/startComposerResearch'
import { executeResearchControl, isResearchRequestTimeout, requestResearch } from '../lib/researchBridge'
import { sessionHistoryCache } from '../lib/sessionHistoryCache'
import { forgetSessionView, migrateEntryDisclosures } from '../lib/sessionViewState'
import type { AttachmentPreparation, PreparedAttachment, PromptImage } from '../types/attachment'

/**
 * Settle a pending stop from the root session's own final notice.
 *
 * A final report can arrive before the driver's finally block releases its lease. A stopped
 * label alone is not lease evidence: retain the shared wait until an authoritative read.
 */
function settleStopFromFinalNotice(runId: string | undefined, raw: ChatMessage | null): void {
  if (!runId || !raw || raw.customType !== 'research-final') return
  const status = String(raw.details?.result?.status ?? raw.details?.status ?? '')
  if (!status) return
  const driving = raw.details?.result?.driving ?? raw.details?.driving
  if (!confirmResearchStopped(runId, status, typeof driving === 'boolean' ? driving : undefined)
    && status === 'stopped' && researchStopEntry(runId)) {
    void Promise.resolve().then(() => useSessionStore.getState().fetchResearchCardDetails(runId)).catch(() => {})
  }
}

function failureMetadata(metadata?: ResearchFailureMetadata): ResearchFailureMetadata {
  if (!metadata) return {}
  return { errorDetails: metadata.errorDetails, errorCode: metadata.errorCode, errorStage: metadata.errorStage,
    researchNeedsConfiguration: metadata.researchNeedsConfiguration }
}

function clearConfirmedSnapshotStartup(state: ConversationState, snapshot: ResearchHostSnapshot): ConversationState {
  if (!snapshot.run) return state
  const successful = snapshot.messages.filter(message => (message.role === 'user' || message.customType === 'research-question') &&
    message.deliveryStatus !== 'failed' && message.deliveryStatus !== 'unconfirmed')
  const ids = new Set<string>(successful.map(message => message.requestId || message.details?.requestId).filter(Boolean))
  for (const receipt of snapshot.submissionReceipts || []) {
    if (receipt.state === 'applied' && receipt.runId === snapshot.run.id) ids.add(receipt.requestId)
  }
  let next = state
  for (const requestId of ids) next = clearResearchStartupRequest(next, requestId)
  return next
}

function ownedResearchMutation(original: SessionState, requestId: string, update: (state: SessionState) => Partial<SessionState> | SessionState): Partial<SessionState> | SessionState {
 const owner = researchDeliveryBindings.get(requestId)
 if (!owner || deliveryBelongsToBinding(requestId, original.researchBinding)) return update(original)
 const binding = original.researchBindings[owner.sessionId]
 const conversation = original.researchConversations[owner.sessionId]
 if (!binding || !conversation) return original
 const state = {...original, researchBinding:binding, researchConversation:conversation}
 const result = update(state)
 return result.researchConversation ? {researchConversations:{...original.researchConversations,[owner.sessionId]:result.researchConversation}} : original
}

const STORAGE_RECENT_WORKSPACES_KEY = 'misaka_recent_workspaces'

/**
 * Research events arrive one per streamed token, each carrying the whole message so far. Applying
 * them as they land means one render per token, and the reader's own click queues behind all of
 * them. `createResearchIngest` keeps the order and every state-changing event, merges only the
 * superseded whole-message snapshots, and spends a bounded slice of each task.
 */
const researchIngest = createResearchIngest({
  apply: message => useSessionStore.getState().handleResearchBridgeMessage(message),
})

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
  researchModelBindings: ResearchTeamSnapshot['modelBindings']
  researchTeamEventSeq: number
  activeResearchTaskId: { runId: string; taskId: string } | null
  activeResearchGraphRunId: string | null
  researchHistoryOpen: boolean
  researchHistoryGeneration: number
  currentModel: {
    provider: string
    modelId: string
    name: string
    thinking: string
  }
  permissionMode: PermissionMode
  agentMode: 'agent' | 'research'
  researchPageView: 'new' | 'conversation'
  researchView: ResearchView
  researchNewEntryId: string
  researchEditors: Record<string, ResearchEditor>
  ordinaryEditor: { text: string; revision: number; attachments: PreparedAttachment[] }
  researchSnapshots: Record<string, ResearchHostSnapshot>
  researchConversations: Record<string, ConversationState>
  researchBindings: Record<string, ResearchConversationBinding>
  selectResearchView: (view: ResearchViewSelection) => void
  setResearchEditorConfig: (config: Partial<Pick<ResearchEditor, 'model' | 'lastOrderModel' | 'thinkingLevel'>>, ownerKey?: string) => void
  clearResearchEditor: (ownerKey: string, revision: number, attachmentIdentities?: Array<{attachmentId: string; preparationId: string}>) => void
  researchPageVersion: number
  newResearchDraft: string
  setResearchPageView: (view: 'new' | 'conversation') => void
  setNewResearchDraft: (text: string) => void
  pendingPermissionRequest: PermissionRequestPayload | null
  /** The composer's text, mirrored here so a tree navigation can hand a message back to it. */
  draft: string
  draftRevision: number
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
  prepareAttachments: (paths: string[], ownerKey?: string | null) => Promise<void>
  retryAttachment: (path: string) => Promise<void>
  removeAttachment: (path: string) => void
  clearAttachments: () => void
  retryMessage: (messageId: string) => void
  retryResearchMessage: (messageId: string) => void
  restoreResearchMessageDraft: (messageId: string) => void
  abortGeneration: () => void
  handleBridgeMessage: (msg: BridgeMessage) => void
  bindResearchConversation: (snapshot: ResearchHostSnapshot, force?: boolean) => void
  applyResearchTeamSnapshot: (sessionId: string, snapshot: ResearchTeamSnapshot, seq?: number) => void
  handleResearchBridgeMessage: (msg: BridgeMessage) => void
  /** Queue an event for bounded-slice application; an ack is applied immediately. */
  ingestResearchBridgeMessage: (msg: BridgeMessage) => void
  /** Apply everything waiting, in order, before the caller reads the transcript back. */
  flushResearchIngest: () => void
  clearResearchConversation: () => void
  queueResearchMessage: (requestId: string, text: string, binding?: ResearchConversationBinding) => void
  acceptResearchMessage: (requestId: string) => void
  unconfirmResearchMessage: (requestId: string, error: string, retryable?: boolean, reconciled?: boolean, metadata?: ResearchFailureMetadata) => void
  failResearchMessage: (requestId: string, error: string, retryable?: boolean, metadata?: ResearchFailureMetadata) => void
  failResearchExecution: (requestId: string, error: string, metadata?: ResearchFailureMetadata) => void
  rememberResearchSubmission: (requestId: string, submission: ResearchSubmissionInput, draft?: ChatMessage['researchDraft']) => void
  requestResearchStop: (target?: ResearchControlTarget) => void
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
  respondPermission: (requestId: string, decision: 'allow' | 'deny', scope?: 'once' | 'suggested', feedback?: string) => void
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
let pendingResearchOpenCancel: (() => void) | null = null
let researchOpenRetryPath: string | null = null
const confirmedDeletedSessions = new Set<string>()
const pendingPrompts = new Map<string, { sessionId: string; userMessageId: string; placeholderId: string | null }>()
const researchDeliveryBindings = new Map<string, { sessionId: string; streamId?: string }>()
const retiredResearchBindings = new Set<string>()
const MAX_ATTACHMENTS = 10
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

function attachmentName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path
}

function attachmentIdentity(path: string): string { return path.toLowerCase() }
let pendingTreeRequestId: string | null = null

function researchBindingKey(binding: { sessionId: string; streamId?: string }): string {
  return `${binding.sessionId}\u0000${binding.streamId || ''}`
}

function deliveryBelongsToBinding(requestId: string, binding: ResearchConversationBinding | null): boolean {
  const owner = researchDeliveryBindings.get(requestId)
  return Boolean(owner && binding && owner.sessionId === binding.sessionId && owner.streamId === binding.streamId)
}

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
  cancelResearchSessionOpen()
  if (useSessionStore.getState().agentMode === 'research') useSessionStore.getState().setAgentMode('agent')
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
    agentMode: 'agent', researchConnectionError: null,
    researchPageView: 'new', researchPageVersion: state.researchPageVersion + 1,
    sessionHistoryVersion: cached?.historyVersion ?? null,
    ...(targetPath ? { currentSessionPath: targetPath, currentSessionId: cached?.sessionId ?? known?.id ?? '',
      currentTitle: cached?.title ?? (known ? deriveTitle(known) : '加载会话'),
      currentWorkspace: cached?.workspace ?? known?.cwd ?? state.currentWorkspace,
      messages: cached?.messages ?? [] } : { messages: [], currentSessionPath: null, currentSessionId: '', currentTitle: '新对话' }) })
  sendBridge(command)
}

function cancelResearchSessionOpen(): void {
  pendingResearchOpenCancel?.()
  if (researchOpenRetryPath) {
    researchOpenRetryPath = null
    useSessionStore.setState({ sessionLoadError: null })
  }
}

function sameModelChoice(left?: { provider?: string; modelId?: string } | null, right?: { provider?: string; modelId?: string } | null): boolean {
  return left?.provider === right?.provider && left?.modelId === right?.modelId
}

/** Reconnect persisted research intent; opening history never submits a topic. */
function openResearchSession(path: string, sessionId: string, cwd: string): void {
  cancelResearchSessionOpen()
  clearPendingHydration()
  const captured = useSessionStore.getState()
  const settings = useSettingsStore.getState()
  researchOpenRetryPath = path
  useSessionStore.setState({ isSessionLoading: true, sessionLoadError: null, researchConnectionError: null })
  let active = true
  let timer: number
  let unsubscribeSession = () => {}
  let unsubscribeSettings = () => {}
  const retire = () => {
    if (!active) return
    active = false
    window.clearTimeout(timer)
    unsubscribeSession()
    unsubscribeSettings()
    if (pendingResearchOpenCancel === retire) pendingResearchOpenCancel = null
    useSessionStore.setState({ isSessionLoading: false })
  }
  pendingResearchOpenCancel = retire
  const fail = (error: unknown) => {
    if (!active) return
    retire()
    useSessionStore.setState({ sessionLoadError: error instanceof Error ? error.message : String(error) })
  }
  unsubscribeSession = useSessionStore.subscribe(current => {
    const editor = current.researchEditors[captured.researchView.ownerKey]
    const previousEditor = captured.researchEditors[captured.researchView.ownerKey]
    if (current.agentMode !== captured.agentMode || current.researchPageVersion !== captured.researchPageVersion ||
      current.currentSessionId !== captured.currentSessionId || current.currentSessionPath !== captured.currentSessionPath ||
      current.currentWorkspace !== captured.currentWorkspace || !sameModelChoice(current.currentModel, captured.currentModel) ||
      current.researchBinding?.sessionId !== captured.researchBinding?.sessionId || current.researchBinding?.streamId !== captured.researchBinding?.streamId ||
      !sameModelChoice(editor?.model, previousEditor?.model) || !sameModelChoice(editor?.lastOrderModel, previousEditor?.lastOrderModel) ||
      editor?.thinkingLevel !== previousEditor?.thinkingLevel) {
      cancelResearchSessionOpen()
    }
  })
  unsubscribeSettings = useSettingsStore.subscribe(current => {
    // Capability reads also toggle modelSwitchPending and recreate metadata objects.
    // Only a changed model choice/reasoning level supersedes this read-only open.
    if (!sameModelChoice(current.currentModel, settings.currentModel) || current.thinkingLevel !== settings.thinkingLevel) cancelResearchSessionOpen()
  })
  timer = window.setTimeout(() => fail(new Error('研究会话连接超时，请重试。')), 30000)
  void (async () => {
    try {
      const host = await window.app.startResearchBridge({ cwd, sessionFile: path })
      if (!active) return
      if (!host.enabled || host.session?.sessionId !== sessionId ||
        normalizeWorkspacePath(host.session.file) !== normalizeWorkspacePath(path) ||
        normalizeWorkspacePath(host.session.cwd) !== normalizeWorkspacePath(cwd)) {
        throw new Error('研究会话标识已变更，请重试打开原研究。')
      }
      retire()
      researchOpenRetryPath = null
      const actions = useSessionStore.getState()
      actions.bindResearchConversation({ ...host, messages: host.messages ?? [], historyVersion: host.historyVersion ?? null,
        lastEventSeq: host.lastEventSeq ?? 0, run: host.run ?? null }, true)
      actions.setAgentMode('research')
      actions.selectResearchView({ kind: 'conversation', sessionId, ownerKey: `conversation:${sessionId}` })
      useSessionStore.setState({ sessionLoadError: null, researchConnectionError: null })
    } catch (error) { fail(error) }
  })()
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
  researchPageView: 'new',
  researchPageVersion: 0,
  researchView: { kind: 'new', ownerKey: 'new::initial', version: 0 },
  researchNewEntryId: 'initial',
  researchEditors: {},
  ordinaryEditor: { text: '', revision: 0, attachments: [] },
  researchSnapshots: {},
  researchConversations: {},
  researchBindings: {},
  newResearchDraft: '',
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
  researchModelBindings: null,
  researchTeamEventSeq: 0,
  activeResearchTaskId: null,
  activeResearchGraphRunId: null,
  researchHistoryOpen: false,
  researchHistoryGeneration: 0,
  messages: [],
  streamingMessageId: null,
  draft: '',
  draftRevision: 0,
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

  setDraft: (text: string) => set(state => {
    const revision = state.draftRevision + 1
    return { draft: text, draftRevision: revision, ...(state.agentMode === 'research' ? {
      researchEditors: { ...state.researchEditors, [state.researchView.ownerKey]: { ...(state.researchEditors[state.researchView.ownerKey] || emptyResearchEditor()), text, revision } }
    } : {}) }
  }),
  setResearchEditorConfig: (config, ownerKey) => set(state => {
    const owner = ownerKey || state.researchView.ownerKey
    return { researchEditors: { ...state.researchEditors, [owner]: { ...(state.researchEditors[owner] || emptyResearchEditor()), ...config } } }
  }),
  clearResearchEditor: (ownerKey, revision, attachmentIdentities) => set(state => {
    const editor = state.researchEditors[ownerKey]
    if (!editor || editor.revision !== revision) return state
    if (attachmentIdentities && (editor.attachments.length !== attachmentIdentities.length || editor.attachments.some((item,index)=>item.attachmentId !== attachmentIdentities[index].attachmentId || item.preparationId !== attachmentIdentities[index].preparationId))) return state
    return { researchEditors: { ...state.researchEditors, [ownerKey]: { ...editor, text: '', attachments: [], revision: revision + 1 } },
      ...(state.agentMode === 'research' && state.researchView.ownerKey === ownerKey ? { draft: '', attachments: [], draftRevision: revision + 1 } : {}) }
  }),
  selectResearchView: view => {
    cancelResearchSessionOpen()
    const state = get()
    const snapshots = state.researchSnapshots
    set(current => {
      const sourceOwner = current.researchView.kind === current.researchPageView ? current.researchView.ownerKey : `conversation:${current.researchBinding?.sessionId || 'unbound'}`
      // Only the visible research editor belongs to a research owner. Ordinary text must
      // never be checkpointed into the remembered research selection.
      const editors = current.agentMode === 'research'
        ? { ...current.researchEditors, [sourceOwner]: { ...(current.researchEditors[sourceOwner] || emptyResearchEditor()), text: current.draft, revision: current.draftRevision, attachments: current.attachments as ResearchEditor['attachments'] } }
        : { ...current.researchEditors }
      const editor = editors[view.ownerKey] || { ...emptyResearchEditor(), model:useSettingsStore.getState().currentModel, thinkingLevel:useSettingsStore.getState().thinkingLevel }
      const version = current.researchPageVersion + 1
      return { researchEditors: { ...editors, [view.ownerKey]: editor }, researchView: { ...view, version }, researchPageView: view.kind, researchPageVersion: version,
        ...(current.agentMode === 'research' ? { draft: editor.text, draftRevision: editor.revision, attachments: editor.attachments } : {}) }
    })
    if (view.kind === 'conversation' && snapshots[view.sessionId]) {
      const cached = state.researchBinding?.sessionId === view.sessionId ? state.researchConversation : state.researchConversations[view.sessionId]
      get().bindResearchConversation(snapshots[view.sessionId], true)
      if (cached && cached.lastEventSeq >= get().researchConversation.lastEventSeq) set({researchConversation:cached})
    }
  },

  bindResearchConversation: (snapshot, force = false) => {
    if (!snapshot.session?.sessionId || !Array.isArray(snapshot.messages)) return
    set(state => {
      const incomingOwner = snapshot.session.sessionId
      const currentOwner = state.researchBinding?.sessionId === incomingOwner
      const cachedBinding = currentOwner ? state.researchBinding : state.researchBindings[incomingOwner]
      const cachedConversation = currentOwner ? state.researchConversation : state.researchConversations[incomingOwner]
      const ownerStream = snapshot.streamId ?? cachedBinding?.streamId
      const ownerKey = researchBindingKey({sessionId:incomingOwner,streamId:ownerStream})
      const ownerSameStream = Boolean(cachedBinding) && ownerStream === cachedBinding?.streamId
      // Validate the incoming owner's cache BEFORE publishing either binding or transcript.
      // A stream retired by navigation remains a valid background owner; a different,
      // retired stream must never replace that owner's current transport.
      if (cachedBinding && !ownerSameStream && retiredResearchBindings.has(ownerKey)) return state
      if (ownerSameStream && cachedConversation && snapshot.lastEventSeq < cachedConversation.lastEventSeq) {
        const knownRunId = snapshot.run?.id
        if (force && !currentOwner) {
          // Explicit selection may navigate to this owner, but still uses its newer cache.
          snapshot = {...snapshot,messages:cachedConversation.messages,lastEventSeq:cachedConversation.lastEventSeq,
            run:state.researchSnapshots[incomingOwner]?.run ?? snapshot.run}
        } else if (knownRunId && !cachedBinding?.runId) {
          const learnedBinding = {...cachedBinding!,runId:knownRunId}
          const learnedConversation = clearConfirmedSnapshotStartup(cachedConversation, snapshot)
          const previousSnapshot = state.researchSnapshots[incomingOwner]
          return {researchBindings:{...state.researchBindings,[incomingOwner]:learnedBinding},
            researchConversations:{...state.researchConversations,[incomingOwner]:learnedConversation},
            ...(previousSnapshot ? {researchSnapshots:{...state.researchSnapshots,[incomingOwner]:{...previousSnapshot,run:snapshot.run}}} : {}),
            ...(currentOwner ? {researchBinding:learnedBinding,researchPendingCreationRequestId:null,researchConversation:learnedConversation} : {})}
        } else return state
      }
      if (cachedBinding && !ownerSameStream && !currentOwner) {
        retiredResearchBindings.add(researchBindingKey(cachedBinding))
        retiredResearchBindings.delete(ownerKey)
      }
      const researchSnapshots = { ...state.researchSnapshots, [incomingOwner]: snapshot }
      const researchBindings = {...state.researchBindings, [incomingOwner]:{sessionId:incomingOwner,sessionFile:snapshot.session.file,workspace:snapshot.session.cwd,runId:snapshot.run?.id || null,streamId:snapshot.streamId ?? cachedBinding?.streamId}}
      const researchConversations = {...state.researchConversations, ...(state.researchBinding ? {[state.researchBinding.sessionId]:state.researchConversation} : {})}
      const backgroundHistory = projectResearchHistory(snapshot.messages)
      researchConversations[incomingOwner] = {...emptyResearchConversation(), currentSessionId:incomingOwner, messages:reconcileResearchPendingHistory(backgroundHistory, state.researchBinding ? researchConversations[incomingOwner]?.messages || [] : [],snapshot.submissionReceipts, Boolean(snapshot.run)),lastEventSeq:snapshot.lastEventSeq || 0}

      if (!force && state.researchBinding && state.researchBinding.sessionId !== snapshot.session.sessionId) return { researchSnapshots, researchBindings, researchConversations, researchCards: hydrateResearchHistoryCards(state.researchCards, snapshot.messages) }
      const sameSession = state.researchBinding?.sessionId === snapshot.session.sessionId
      // Legacy snapshots omit streamId; that absence is not a transport change.
      const snapshotStreamId = snapshot.streamId ?? (sameSession ? state.researchBinding?.streamId : undefined)
      const incomingBinding = { sessionId: snapshot.session.sessionId, streamId: snapshotStreamId }
      const incomingKey = researchBindingKey(incomingBinding)
      if (!state.researchBinding) retiredResearchBindings.clear()
      else if (researchBindingKey(state.researchBinding) !== incomingKey) {
        // Opening a run from history or the run pill is the user's own decision and stays
        // authoritative even if that binding was retired by an earlier automatic switch.
        if (retiredResearchBindings.has(incomingKey) && !force) return state
        retiredResearchBindings.delete(incomingKey)
        retiredResearchBindings.add(researchBindingKey(state.researchBinding))
      }
      const sameStream = sameSession && snapshotStreamId && state.researchBinding?.streamId === snapshotStreamId
      if (sameStream && snapshot.lastEventSeq < state.researchConversation.lastEventSeq) {
        // An older snapshot must not replace a newer transcript, but a run identity it
        // alone knows about is still authoritative: refusing it would pin the binding at
        // `runId: null` and keep the UI on the welcome page after the run exists.
        const knownRunId = snapshot.run?.id
        if (knownRunId && !state.researchBinding?.runId) {
          return { researchBinding: { ...state.researchBinding!, runId: knownRunId },
            researchConversation: clearConfirmedSnapshotStartup(state.researchConversation, snapshot),
            researchPendingCreationRequestId: null }
        }
        return state
      }
      const history = projectResearchHistory(snapshot.messages)
      const owner = sameStream ? state.researchConversation.messages.find(message => message.id === state.researchConversation.streamingMessageId && message.isStreaming) : undefined
      const runStatus = snapshot.run?.status
      const runSettled = snapshot.isIdle === true || runStatus === 'waiting_input' || Boolean(runStatus && !isResearchRunActive(runStatus))
      const liveOwner = !runSettled && owner && !history.some(message => message.role === 'assistant' &&
        (message.id === owner.id || message.timestamp === owner.timestamp || Boolean(owner.entryId && message.entryId === owner.entryId))) ? owner : undefined
      const hasNativeLifecycle = typeof snapshot.isStreaming === 'boolean' || typeof snapshot.isIdle === 'boolean'
      const nativeBusy = snapshot.isStreaming === true || snapshot.isIdle === false
      const isStreaming = liveOwner ? state.researchConversation.isStreaming
        : hasNativeLifecycle ? nativeBusy
          : Boolean(sameStream && state.researchConversation.isStreaming) || isResearchRunActive(snapshot.run?.status)
      const messages = reconcileResearchPendingHistory(liveOwner ? [...history, liveOwner] : history, sameSession ? state.researchConversation.messages : state.researchBinding ? researchConversations[incomingOwner]?.messages || [] : [], snapshot.submissionReceipts, Boolean(snapshot.run))
      for (const message of messages) {
        if (message.requestId && message.deliveryStatus === 'created') researchDeliveryBindings.delete(message.requestId)
      }
      const cards = hydrateResearchHistoryCards(state.researchCards, snapshot.messages)
      for (const message of snapshot.messages) {
        const runId = researchNoticeRunId(message)
        if (runId && cards[runId] && !cards[runId].workspace) cards[runId] = { ...cards[runId], workspace: snapshot.session.cwd }
      }
      if (snapshot.run) {
        const run = snapshot.run
        const question = messages.find(message => message.customType === 'research-question')?.content
          || messages.find(message => message.role === 'user')?.content || ''
        cards[run.id] = mergeResearchCard(cards[run.id], { ...(cards[run.id] || { runId: run.id, question, workspace: snapshot.session.cwd, tasks: [], updatedAt: Date.now() }),
          status: run.status, phase: run.phase,
          ...(run.status !== 'waiting_input' ? { pendingQuestions: [] } : {}),
          ...(isResearchRunActive(run.status) ? { error: null } : {}),
          ...(snapshot.reportDelivery ? {reportDelivery:snapshot.reportDelivery} : {}) })
      }
      return {
        researchSnapshots, researchBindings, researchConversations,
        researchBinding: { sessionId: snapshot.session.sessionId, sessionFile: snapshot.session.file, workspace: snapshot.session.cwd, runId: snapshot.run?.id ?? null,
          ...(snapshotStreamId ? { streamId: snapshotStreamId } : {}) },
        researchConversation: { ...emptyResearchConversation(), currentSessionId: snapshot.session.sessionId,
          messages, lastEventSeq: snapshot.lastEventSeq ?? 0,
          streamingMessageId: liveOwner?.id ?? null,
          isStreaming,
          isAborting: Boolean(sameStream && state.researchConversation.isAborting && !runSettled) },
        researchCards: cards, researchConnectionError: null,
        researchPendingCreationRequestId: snapshot.run || !sameSession || (snapshot.isIdle === true && !snapshot.run && messages.some(message =>
          message.requestId === state.researchPendingCreationRequestId && (message.deliveryStatus === 'failed' || message.deliveryStatus === 'unconfirmed'))) || snapshot.submissionReceipts?.some(receipt =>
          receipt.requestId === state.researchPendingCreationRequestId && receipt.state === 'rejected')
          ? null : state.researchPendingCreationRequestId,
        researchHistoryVersion: snapshot.historyVersion,
        researchHostStats: snapshot.stats, researchContextUsage: snapshot.contextUsage,
        researchTeam: snapshot.team === undefined && sameSession ? state.researchTeam : snapshot.team ?? null,
        researchModelBinding: sameSession && state.researchModelBinding && (!snapshot.modelBinding || snapshot.modelBinding.epoch < state.researchModelBinding.epoch)
          ? state.researchModelBinding : snapshot.modelBinding ?? null,
        researchModelBindings: snapshot.modelBindings ? {
          last_order: sameSession && state.researchModelBindings?.last_order && state.researchModelBindings.last_order.epoch > snapshot.modelBindings.last_order.epoch
            ? state.researchModelBindings.last_order : snapshot.modelBindings.last_order,
          sister: sameSession && state.researchModelBindings?.sister && state.researchModelBindings.sister.epoch > snapshot.modelBindings.sister.epoch
            ? state.researchModelBindings.sister : snapshot.modelBindings.sister,
        } : sameSession ? state.researchModelBindings : null,
        researchTeamEventSeq: Math.max(snapshot.lastEventSeq ?? 0, sameSession ? state.researchTeamEventSeq : 0),
      }
    })
  },

  applyResearchTeamSnapshot: (sessionId, snapshot, seq) => {
    set(state => {
      if (sessionId !== state.researchBinding?.sessionId) return state
      if (seq !== undefined && seq <= state.researchTeamEventSeq) return state
      const oldRoles = state.researchModelBindings
      const nextRoles = snapshot.modelBindings && {
        last_order: oldRoles?.last_order && oldRoles.last_order.epoch > snapshot.modelBindings.last_order.epoch
          ? oldRoles.last_order : snapshot.modelBindings.last_order,
        sister: oldRoles?.sister && oldRoles.sister.epoch > snapshot.modelBindings.sister.epoch
          ? oldRoles.sister : snapshot.modelBindings.sister,
      }
      return {
        ...(snapshot.team !== undefined ? { researchTeam: snapshot.team } : {}),
        ...(snapshot.modelBinding !== undefined && (!state.researchModelBinding || !snapshot.modelBinding || snapshot.modelBinding.epoch >= state.researchModelBinding.epoch)
          ? { researchModelBinding: snapshot.modelBinding } : {}),
        ...(nextRoles ? { researchModelBindings: nextRoles } : {}),
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
    const entryId = newRequestId('research_entry')
    const ownerKey = newResearchOwner(state.currentWorkspace, entryId)
    get().selectResearchView({kind:'new',ownerKey})
    set({ researchNewEntryId:entryId, researchView:{kind:'new',ownerKey,version:get().researchPageVersion}, draft:'', attachments:[], researchBinding: null, researchConversation: emptyResearchConversation(), researchConnectionError: null,
      researchPageView: 'new', researchPageVersion: state.researchPageVersion + 1, newResearchDraft: '',
      researchPendingCreationRequestId: null,
      researchHistoryVersion: null, researchHostStats: {}, researchContextUsage: null,
      researchTeam: null, researchModelBinding: null, researchModelBindings: null, researchTeamEventSeq: 0,
      activeResearchTaskId: null, activeResearchGraphRunId: null })
  },

  queueResearchMessage: (requestId, text, capturedBinding) => {
    const binding = capturedBinding || get().researchBinding
    if (!binding || !text.trim()) return
    researchDeliveryBindings.set(requestId, { sessionId: binding.sessionId, streamId: binding.streamId })
    set(original => ownedResearchMutation(original, requestId, state => {
      if (state.researchConversation.messages.some(message => message.requestId === requestId)) return state
      const message: ChatMessage = { id: `research-user-${requestId}`, role: 'user', content: text.trim(), timestamp: Date.now(),
        requestId, optimistic: true, deliveryStatus: 'pending' }
      return { researchConnectionError: null, researchPendingCreationRequestId: state.researchBinding?.runId ? null : requestId,
        researchConversation: { ...state.researchConversation, messages: [...state.researchConversation.messages, message] } }
    }))
  },

  acceptResearchMessage: (requestId) => set(original => ownedResearchMutation(original, requestId, state => {
    if (!deliveryBelongsToBinding(requestId, state.researchBinding)) return state
    return { researchConnectionError: null, researchConversation: { ...state.researchConversation,
      messages: state.researchConversation.messages.map(message => message.requestId === requestId &&
        (message.deliveryStatus === 'pending' || message.deliveryStatus === 'unconfirmed')
        ? { ...message, deliveryStatus: 'accepted', submissionError: undefined, deliveryReconciled: undefined,
          errorDetails: undefined, errorCode: undefined, errorStage: undefined, researchNeedsConfiguration: undefined } : message) } }
  })),

  rememberResearchSubmission: (requestId, submission, draft) => set(original => ownedResearchMutation(original, requestId, state => {
    if (!deliveryBelongsToBinding(requestId, state.researchBinding)) return state
    const original = Object.freeze({ ...submission, ...(submission.limits ? { limits: Object.freeze({ ...submission.limits }) } : {}) })
    return { researchConversation: { ...state.researchConversation, messages: state.researchConversation.messages.map(message =>
      message.requestId === requestId && !message.researchSubmission ? { ...message, researchSubmission: original,
        ...(draft ? { researchDraft: { ...draft, attachmentPaths: [...draft.attachmentPaths] } } : {}) } : message) } }
  })),

  failResearchExecution: (requestId, error, metadata) => set(original => ownedResearchMutation(original, requestId, state => {
    if (!deliveryBelongsToBinding(requestId, state.researchBinding) && !state.researchConversation.messages.some(message => message.requestId === requestId && message.deliveryStatus === 'created')) return state
    return { researchPendingCreationRequestId: state.researchPendingCreationRequestId === requestId ? null : state.researchPendingCreationRequestId,
      researchConversation: { ...state.researchConversation, messages: state.researchConversation.messages.map(message => message.requestId === requestId
        ? { ...message, ...failureMetadata(metadata), errorStage: metadata?.errorStage ?? (state.researchBinding?.runId ? 'execution' : 'startup'), optimistic: false, executionError: error, submissionError: undefined,
          deliveryStatus: message.deliveryStatus === 'created' ? 'created' : 'accepted' } : message) } }
  })),

  unconfirmResearchMessage: (requestId, error, retryable, reconciled, metadata) => set(original => ownedResearchMutation(original, requestId, state => {
    if (!deliveryBelongsToBinding(requestId, state.researchBinding)) return state
    // A retryable unconfirmed send has to give its creation fence back: while the fence is
    // held, the retry finder refuses this very row. A backend that said "not retryable" keeps
    // it, so no second research creation can fire behind an unknown outcome.
    const releaseFence = retryable !== false && state.researchPendingCreationRequestId === requestId
    return { ...(releaseFence ? { researchPendingCreationRequestId: null } : {}),
      researchConversation: { ...state.researchConversation,
      messages: state.researchConversation.messages.map(message => message.requestId === requestId && message.deliveryStatus !== 'created' && message.deliveryStatus !== 'accepted'
        ? { ...message, ...failureMetadata(metadata), optimistic: true, deliveryStatus: 'unconfirmed', submissionError: error,
          ...(retryable !== undefined ? { deliveryRetryable: retryable } : {}),
          deliveryReconciled: reconciled ? true
            : message.deliveryStatus === 'unconfirmed' ? message.deliveryReconciled : false } : message) } }
  })),

  failResearchMessage: (requestId, error, retryable = true, metadata) => {
    set(original => ownedResearchMutation(original, requestId, state => {
      if (!deliveryBelongsToBinding(requestId, state.researchBinding) ||
        !state.researchConversation.messages.some(message => message.requestId === requestId && message.deliveryStatus !== 'created' && message.deliveryStatus !== 'accepted')) return state
      return { researchConnectionError: null,
        researchPendingCreationRequestId: state.researchPendingCreationRequestId === requestId ? null : state.researchPendingCreationRequestId,
        researchConversation: { ...state.researchConversation,
          messages: state.researchConversation.messages.map(message => message.requestId === requestId
            ? { ...message, ...failureMetadata(metadata), optimistic: false, deliveryStatus: 'failed', submissionError: error, deliveryRetryable: retryable } : message) } }
    }))
    // Recruitment journals are already durable even when no native Run exists.
    // Discovery is best effort and must not replace the actual startup failure.
    if (metadata?.errorStage === 'recruitment') {
      try { get().fetchSessions() } catch { /* Original row remains actionable. */ }
    }
  },

  restoreResearchMessageDraft: messageId => {
    const state = get()
    const message = state.researchConversation.messages.find(row => row.id === messageId && row.role === 'user')
    if (!message || state.agentMode !== 'research' || !state.researchBinding || state.researchBinding.runId ||
      state.isSessionLoading || state.sessionLoadError || state.researchConversation.isAborting || state.researchPendingCreationRequestId) return
    get().setDraft(message.content)
    window.dispatchEvent(new Event('research-editor-focus'))
  },

  retryResearchMessage: (messageId) => {
    const state = get()
    const binding = state.researchBinding
    const legacy = state.researchConversation.messages.find(row => row.id === messageId &&
      (row.researchNeedsConfiguration || (row.errorStage === 'recruitment' && !row.researchSubmission)))
    if (legacy) { get().restoreResearchMessageDraft(messageId); return }
    const message = state.researchConversation.messages.find(row => row.id === messageId && row.role === 'user' && row.requestId &&
      row.deliveryRetryable !== false && (row.deliveryStatus === 'failed' || (row.deliveryStatus === 'unconfirmed' && row.deliveryReconciled) ||
        (Boolean(row.executionError) && Boolean(row.researchSubmission) && !binding?.runId)))
    if (!binding || !message?.requestId || state.researchConversation.isAborting ||
      (!binding.runId && state.researchPendingCreationRequestId) ||
      state.researchConversation.messages.some(row => row.requestId === message.requestId && row.deliveryStatus === 'pending')) return
    const requestId = message.requestId
    let owner = binding
    const navigationVersion = state.researchPageVersion
    const ownsContext = () => get().researchPageVersion === navigationVersion && get().agentMode === 'research' && get().researchBinding?.sessionId === owner.sessionId && get().researchBinding?.streamId === owner.streamId
    researchDeliveryBindings.set(requestId, { sessionId: binding.sessionId, streamId: binding.streamId })
    set(current => ({ researchConnectionError: null,
      researchPendingCreationRequestId: binding.runId ? current.researchPendingCreationRequestId : requestId,
      researchConversation: { ...current.researchConversation,
      messages: current.researchConversation.messages.map(row => row.id === messageId
        ? { ...row, optimistic: true, deliveryStatus: 'pending', deliveryReconciled: undefined, submissionError: undefined, executionError: undefined,
          errorDetails: undefined, errorCode: undefined, errorStage: undefined, researchNeedsConfiguration: undefined } : row) } }))
    void startComposerResearch({ question: message.content, workspace: binding.workspace, binding, requestId, submission: message.researchSubmission,
      onSubmission: submission => get().rememberResearchSubmission(requestId, submission, message.researchDraft),
      onBound: host => {
        get().bindResearchConversation(host)
        const rebound = get().researchBindings[host.session.sessionId]
        if (rebound) {
          owner = rebound
          researchDeliveryBindings.set(requestId, { sessionId: rebound.sessionId, streamId: rebound.streamId })
        }
        // This reconnect snapshot precedes the replay: a durable row from the
        // previous attempt must not restore its error or release this retry's fence.
        set(current => ownedResearchMutation(current, requestId, state => ({
          researchPendingCreationRequestId: state.researchBinding?.runId ? state.researchPendingCreationRequestId : requestId,
          researchConversation: { ...state.researchConversation, messages: state.researchConversation.messages.map(row => row.requestId === requestId
            ? { ...row, optimistic: true, deliveryStatus: 'pending', deliveryReconciled: undefined, submissionError: undefined,
              executionError: undefined, errorDetails: undefined, errorCode: undefined, errorStage: undefined, researchNeedsConfiguration: undefined } : row) },
        })))
      },
      onAccepted: () => get().acceptResearchMessage(requestId),
      onUnconfirmed: (error, reconciled) => get().unconfirmResearchMessage(requestId, error.message, (error as Error & { retryable?: boolean }).retryable, reconciled, error),
    }).then(host => {
      get().bindResearchConversation(host)
      const draft = message.researchDraft
      if (draft?.ownerKey && draft.revision !== undefined) get().clearResearchEditor(draft.ownerKey, draft.revision, draft.attachmentIdentities)
      if (!ownsContext()) return
      const current = get()
      if (draft && draft.mode === current.agentMode && draft.sessionId === current.researchBinding?.sessionId &&
        current.draft === draft.text &&
        (draft.revision === undefined || draft.revision === current.draftRevision) &&
        current.attachments.length === draft.attachmentPaths.length && current.attachments.every((item, index) => item.path === draft.attachmentPaths[index])) {
        set({ draft: '', attachments: [] })
      }
      if (host.syncError) set({ researchConnectionError: host.syncError })
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      if (isResearchStartupFailure(error)) get().failResearchExecution(requestId, message, error)
      else if (isResearchRequestTimeout(error) || error?.errorCode === 'RESEARCH_DELIVERY_UNCONFIRMED') get().unconfirmResearchMessage(requestId, message, error?.retryable, undefined, error)
      else get().failResearchMessage(requestId, message, error?.retryable, error)
    })
  },

  requestResearchStop: target => {
    const state = get()
    if (target?.kind === 'startup') {
      if (target.sessionId) cancelResearchStartup(target.sessionId)
      else cancelResearchStartup(target.requestId)
      return
    }
    if (target?.kind === 'turn') {
      void requestResearch('abort', {sessionId:target.sessionId, ...(target.streamId ? {streamId:target.streamId} : {})}).catch(error => {
        if (get().researchBinding?.sessionId === target.sessionId) set({researchConnectionError:error instanceof Error ? error.message : String(error)})
      })
      return
    }
    if (target?.kind === 'run') beginResearchControl(target.runId)
    const binding = state.researchBinding
    const captured: ResearchStopTarget | null = target?.kind === 'run' ? { ...target }
      : binding?.runId ? { kind: 'run', runId: binding.runId, workspace: binding.workspace,
        sessionId: binding.sessionId, sessionFile: binding.sessionFile, streamId: binding.streamId } : null
    const previousStop = captured ? researchStopEntry(captured.runId) : undefined
    const recovering = captured && (previousStop?.phase === 'failed' || previousStop?.phase === 'unconfirmed'
      || (!previousStop && state.researchCards[captured.runId]?.status === 'stopping'))
    if (captured && recovering) {
      const runId = captured.runId
      const attemptId = beginResearchStop(runId)
      if (!attemptId) return
      beginResearchControl(runId)
      // Lock before the read, not merely before the eventual control command: two clicks or
      // a layout switch cannot create parallel preflights and dispatch two stops.
      void (async () => {
        const detail = await refreshResearchStopTarget(captured)
        if (researchStopEntry(runId)?.attemptId !== attemptId) return
        upsertActivityDetail(detail)
        if (researchRunAtRest(detail.run.status, detail.run.driving)) {
          clearResearchStop(runId, attemptId)
          return
        }
        if (!['active', 'waiting_input', 'stopping'].includes(detail.run.status)) {
          unconfirmResearchStop(runId, attemptId, '停止结果待确认：尚未确认后台驱动已退出，请刷新状态。')
          return
        }
        await executeResearchControl('stop_research', { runId, workspace: detail.run.workspace,
          sessionFile: detail.run.rootSession,
          isCurrent: () => researchStopEntry(runId)?.attemptId === attemptId && researchStopEntry(runId)?.phase === 'pending',
          onBound: host => {
            if (host.run?.id !== runId || !sameResearchStopPath(host.session.file, detail.run.rootSession!)
              || !sameResearchStopPath(host.session.cwd, detail.run.workspace)) {
              throw new Error('研究控制目标已变更，请重新打开原研究。')
            }
            if (researchRunAtRest(host.run.status, host.run.driving)) clearResearchStop(runId, attemptId)
            // A background recovery must not navigate away from a conversation selected in
            // the meantime. Binding is only a refresh of the same captured current owner.
            if (get().researchBinding?.runId === runId && get().researchBinding?.sessionId === captured.sessionId) {
              get().bindResearchConversation(host)
            }
          } })
        noteResearchStopAck(runId, attemptId)
      })().catch(error => {
        if (researchStopEntry(runId)?.attemptId !== attemptId) return
        const message = error instanceof Error ? error.message : String(error)
        if (isResearchRequestTimeout(error)) unconfirmResearchStop(runId, attemptId, message)
        else failResearchStop(runId, attemptId, message)
      })
      return
    }
    // One shared lock per run: the workbench header, the focus bar, the timeline pill and the
    // sidebar entry all stop the same way, and a second click while a stop is in flight sends
    // nothing. The engine's reply only means the command landed -- the wait ends when the board
    // reports the run at rest (researchStopObservation), never on the ACK alone.
    const dispatchStop = (runId: string, dispatch: (attemptId: string) => Promise<void>, failed: (error: unknown) => void) => {
      const attemptId = beginResearchStop(runId)
      if (!attemptId) return
      void dispatch(attemptId).then(() => {
        noteResearchStopAck(runId, attemptId)
      }).catch(error => {
        if (researchStopEntry(runId)?.attemptId !== attemptId) return
        failed(error)
        if (isResearchRequestTimeout(error)) unconfirmResearchStop(runId, attemptId, error.message)
        else failResearchStop(runId, attemptId, error instanceof Error ? error.message : String(error))
      })
    }
    if (target?.kind === 'run' && (state.researchBinding?.runId !== target.runId || state.researchBinding?.sessionId !== target.sessionId)) {
      const runId = target.runId
      dispatchStop(runId, attemptId => executeResearchControl('stop_research', {runId, workspace:target.workspace, sessionFile:target.sessionFile || target.rootSession,
        isCurrent: () => researchStopEntry(runId)?.attemptId === attemptId && researchStopEntry(runId)?.phase === 'pending',
        onBound: host => get().bindResearchConversation(host)}).then(() => { void get().fetchResearchCardDetails(runId).catch(() => {}) }),
        error => set(current=>({researchCards:{...current.researchCards,[runId]:{...current.researchCards[runId],runId,
          error:isResearchRequestTimeout(error) ? '停止请求没有回应，结果待确认，请刷新研究状态核对。' : error instanceof Error ? error.message : String(error)}}})))
      return
    }
    if (!binding) return
    if (state.researchConversation.isAborting) return
    if (!binding.runId) {
      // A start that has no run *yet* is owned by the research host; the ordinary session's
      // abort channel must never receive this cancel. The run is durable on the board, though,
      // so ask the owning host before deciding: a missed creation notice must not turn the
      // user's "stop" into a cancel of a research that is already running.
      set({ researchConnectionError: null, researchConversation: { ...state.researchConversation, isAborting: true } })
      void requestResearch<ResearchHostSnapshot>('get_research_host', {}, 5_000)
        .then(latest => {
          const current = get()
          if (researchBindingKey(current.researchBinding || { sessionId: '' }) !== researchBindingKey(binding)) return
          const discovered = latest?.session?.sessionId === binding.sessionId ? latest.run?.id : undefined
          if (discovered) {
            set(state => ({ researchBinding: state.researchBinding ? { ...state.researchBinding, runId: String(discovered) } : state.researchBinding,
              researchPendingCreationRequestId: null, researchConversation: { ...state.researchConversation, isAborting: false } }))
            get().requestResearchStop()
            return
          }
          set(state => ({ researchConversation: { ...state.researchConversation, isAborting: false } }))
          cancelResearchStartup(binding.sessionId)
        })
        .catch(() => {
          const current = get()
          if (researchBindingKey(current.researchBinding || { sessionId: '' }) !== researchBindingKey(binding)) return
          // The host did not answer, so the run is still unconfirmed; cancelling the start is
          // the only safe door, and the outcome is reported rather than implied.
          set({ researchConnectionError: '未能确认研究是否已创建，已按取消启动处理；请刷新研究状态核对。',
            researchConversation: { ...current.researchConversation, isAborting: false } })
          cancelResearchStartup(binding.sessionId)
        })
      return
    }
    const runId = binding.runId
    const attemptId = beginResearchStop(runId)
    if (!attemptId) return
    let owner = binding
    const ownsContext = () => get().agentMode === 'research' &&
      researchBindingKey(get().researchBinding || { sessionId: '' }) === researchBindingKey(owner)
    set({ researchConnectionError: null, researchConversation: { ...state.researchConversation, isAborting: true } })
    void executeResearchControl('stop_research', { runId, workspace: binding.workspace, sessionFile: binding.sessionFile,
      isCurrent: () => researchStopEntry(runId)?.attemptId === attemptId && researchStopEntry(runId)?.phase === 'pending',
      onBound: host => {
        if (host.session.sessionId !== binding.sessionId || (host.run && host.run.id !== runId)) {
          throw new Error('研究控制目标已变更，请重新打开原研究。')
        }
        if (!ownsContext()) return
        get().bindResearchConversation(host)
        const rebound = get().researchBinding
        if (!rebound) return
        owner = rebound
        const settled = host.run && researchRunAtRest(host.run.status, host.run.driving)
        // The bound host IS the run's root session: when its own board read already reports the
        // run at rest, the stop is finished -- the shared wait ends here, with its terminal state.
        if (settled && host.run) clearResearchStop(runId, attemptId)
        set(current => ({ researchConversation: { ...current.researchConversation, isAborting: !settled } }))
      },
    }).then(() => {
      // An acknowledgement only means the command was received: the conversation keeps
      // 正在停止 until the observation chain (or a later authoritative snapshot) confirms rest.
      noteResearchStopAck(runId, attemptId)
    })
      .catch(error => {
        if (researchStopEntry(runId)?.attemptId !== attemptId) return
        if (isResearchRequestTimeout(error)) {
          unconfirmResearchStop(runId, attemptId, '停止请求没有回应，结果待确认，请刷新研究状态核对。')
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        failResearchStop(runId, attemptId, message)
        set(current => {
          if (researchBindingKey(current.researchBinding || { sessionId: '' }) !== researchBindingKey(owner)) return current
          return { researchConnectionError: message,
            researchConversation: { ...current.researchConversation, isAborting: false } }
        })
      })
  },

  handleResearchBridgeMessage: (msg) => {
    if ('type' in msg && msg.type === 'ack') {
      if (msg.requestId) {
        const owner = researchDeliveryBindings.get(msg.requestId)
        if (owner && ((typeof msg.sessionId === 'string' && msg.sessionId !== owner.sessionId) ||
          (typeof msg.streamId === 'string' && owner.streamId && msg.streamId !== owner.streamId))) return
        if (msg.ok) get().acceptResearchMessage(msg.requestId)
        else if (msg.errorCode === 'RESEARCH_DELIVERY_UNCONFIRMED') get().unconfirmResearchMessage(msg.requestId, msg.error || '研究消息结果尚未确认', false, undefined, msg)
        else get().failResearchMessage(msg.requestId, msg.error || '研究消息提交失败', msg.retryable, msg)
      }
      return
    }
    if (!('event' in msg) || !msg.event) return
    const binding = get().researchBinding
    const streamId = (msg as BridgeEventEnvelope & { streamId?: string }).streamId
    if (msg.sessionId && msg.sessionId !== binding?.sessionId) {
      const owner = get().researchBindings[msg.sessionId]
      if (!owner || (owner.streamId && streamId && owner.streamId !== streamId) || typeof msg.seq !== 'number') return
      set(current => {
        const previous = current.researchConversations[msg.sessionId] || emptyResearchConversation()
        if (msg.seq <= previous.lastEventSeq) return {}
        const conversation = reduceResearchConversationEvent(previous, msg as BridgeEventEnvelope)
        const raw = msg.event.type === 'message_end' ? msg.event.message : null
        const runId = raw ? researchNoticeRunId(raw) : ''
        if (raw?.customType === 'research-final') settleStopFromFinalNotice(runId || undefined, raw)
        const card = runId && raw ? {...applyResearchNoticeToCard(current.researchCards[runId], {...raw,details:{...raw.details,seq:msg.seq}}),workspace:owner.workspace} : null
        return {researchConversations:{...current.researchConversations,[msg.sessionId]:conversation},...(card ? {researchCards:{...current.researchCards,[runId]:card}} : {})}
      })
      return
    }
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
    if (!state.researchBinding || msg.sessionId !== state.researchBinding.sessionId) return
    if (msg.seq <= state.researchConversation.lastEventSeq) {
      // The arrival cursor dedupes the message flow, not the run's identity. A
      // `research-discipline` notice carries the run id the UI needs to leave the
      // welcome page; dropping it here strands the binding at `runId: null` forever,
      // because no later event re-publishes that identity. Only the identity is
      // adopted -- no message row is inserted for an already-consumed seq.
      const raw = msg.event.type === 'message_end' ? msg.event.message : null
      if (raw?.customType === 'research-discipline') {
        const lateRunId = researchNoticeRunId(raw)
        const pendingRequestId = state.researchPendingCreationRequestId
        const noticeRequestId = raw.details?.requestId
        if (lateRunId && !state.researchBinding.runId &&
          (!pendingRequestId || !noticeRequestId || noticeRequestId === pendingRequestId)) {
          set(current => ({ researchBinding: current.researchBinding ? { ...current.researchBinding, runId: lateRunId } : current.researchBinding,
            researchConversation: clearResearchStartupRequest(current.researchConversation, noticeRequestId || pendingRequestId || undefined),
            researchPendingCreationRequestId: null }))
        }
      }
      return
    }
    if (msg.event.type === 'desktop-team' || msg.event.type === 'desktop-model-switch') {
      get().applyResearchTeamSnapshot(msg.sessionId, msg.event.details ?? msg.event, msg.seq)
    }
    set(current => {
      let conversation = reduceResearchConversationEvent(current.researchConversation, envelope)
      const raw = msg.event.type === 'message_end' ? msg.event.message : null
      const runId = raw?.customType?.startsWith('research-') && raw.customType !== 'research-input' ? researchNoticeRunId(raw) : ''
      if (raw?.customType === 'research-discipline' && runId && !current.researchBinding?.runId) {
        const requestId = raw.details?.requestId || current.researchPendingCreationRequestId
        conversation = clearResearchStartupRequest(conversation, requestId || undefined)
      }
      let cards = current.researchCards
      if (raw?.customType === 'research-final') settleStopFromFinalNotice(runId || undefined, raw)
      if (runId) {
        const card = applyResearchNoticeToCard(cards[runId], {...raw,details:{...raw.details,seq:msg.seq}})
        if (!card.workspace) card.workspace = current.researchBinding?.workspace
        if (!card.question) {
          const question = [...conversation.messages].reverse().find(message => message.customType === 'research-question')
          if (question) card.question = question.content
        }
        cards = { ...cards, [runId]: card }
      }
      const startupError = raw?.customType === 'research-progress' && raw.details?.stage === 'startup_error'
      const failedExecutionRequestId = startupError ? raw.details?.requestId || current.researchPendingCreationRequestId : null
      const settledConversation = failedExecutionRequestId ? { ...conversation, messages: conversation.messages.map(message => message.requestId === failedExecutionRequestId
        ? { ...message, executionError: raw.content || '研究启动失败', submissionError: undefined, optimistic: false,
          deliveryStatus: message.deliveryStatus === 'created' ? 'created' as const : 'accepted' as const } : message) } : conversation
      return { researchConversation: settledConversation, researchCards: cards,
        researchBinding: raw?.customType === 'research-discipline' && runId ? { ...current.researchBinding!, runId } : current.researchBinding,
        researchPendingCreationRequestId: (raw?.customType === 'research-discipline' && runId) || startupError ? null
          : raw?.customType === 'research-question' && !current.researchBinding?.runId
            ? raw.details?.requestId || current.researchPendingCreationRequestId || `research-question-${msg.seq}` : current.researchPendingCreationRequestId,
        researchConnectionError: startupError ? raw.content || '研究启动失败' : current.researchConnectionError }
    })
  },

  ingestResearchBridgeMessage: (msg) => {
    // An ack answers a promise the page is already waiting on; queueing it would delay the result
    // of a send the reader can see happening.
    if ('type' in msg && msg.type === 'ack') { get().handleResearchBridgeMessage(msg); return }
    researchIngest.push(msg)
  },

  flushResearchIngest: () => { researchIngest.flushNow() },

  prepareAttachments: async (paths, capturedOwner) => {
    const start = get()
    const owner = capturedOwner === undefined ? (start.agentMode === 'research' ? start.researchView.ownerKey : null) : capturedOwner
    const read = (state: SessionState): PreparedAttachment[] => owner ? (state.agentMode === 'research' && state.researchView.ownerKey === owner ? state.attachments : state.researchEditors[owner]?.attachments || []) : state.agentMode === 'agent' ? state.attachments : state.ordinaryEditor.attachments
    const update = (transform: (items: PreparedAttachment[]) => PreparedAttachment[]) => set(state => {
      const attachments = transform(read(state))
      if (owner) return { researchEditors: { ...state.researchEditors, [owner]: { ...(state.researchEditors[owner] || emptyResearchEditor()), attachments: attachments as ResearchEditor['attachments'] } },
        ...(state.agentMode === 'research' && state.researchView.ownerKey === owner ? {attachments} : {}) }
      return state.agentMode === 'agent' ? {attachments} : { ordinaryEditor: {...state.ordinaryEditor, attachments} }
    })
    const current = read(start)
    const seen = new Set(current.map(item => attachmentIdentity(item.path)))
    const unique = paths.filter(path => {
      if (typeof path !== 'string' || !path.trim() || seen.has(attachmentIdentity(path))) return false
      seen.add(attachmentIdentity(path)); return true
    })
    if (!unique.length) return
    const selected = unique.slice(0, Math.max(0, MAX_ATTACHMENTS-current.length))
    const pending = unique.map(path => ({ path, attachmentId: newRequestId('attachment'), preparationId: newRequestId('preparation'), name: attachmentName(path), size:0, kind:'unsupported' as const, text:'', images:[], error: selected.includes(path) ? null : `最多可添加 ${MAX_ATTACHMENTS} 个附件`, status: selected.includes(path) ? 'preparing' as const : 'error' as const }))
    update(items => [...items, ...pending])
    if (owner) set(state => {
      const editor=state.researchEditors[owner]
      if (!editor) return state
      const revision=editor.revision+1
      return {researchEditors:{...state.researchEditors,[owner]:{...editor,revision}},...(state.agentMode==='research' && state.researchView.ownerKey===owner ? {draftRevision:revision} : {})}
    })
    if (!selected.length) return
    const owns = (item: PreparedAttachment) => pending.some(p => p.attachmentId === (item as ResearchEditor['attachments'][number]).attachmentId && p.preparationId === (item as ResearchEditor['attachments'][number]).preparationId && selected.includes(p.path)) && item.status === 'preparing'
    try {
      const result = await request<{attachments?: AttachmentPreparation[]}>('prepare_attachments', {paths:selected},120000)
      const byPath = new Map((result.attachments || []).map(item=>[item.path,item]))
      update(items => {
        let total = items.reduce((sum,item)=>sum+(item.status === 'ready' ? item.size : 0),0)
        return items.map(item => {
          if (!owns(item)) return item
          const value=byPath.get(item.path)
          if (!value) return {...item,status:'error' as const,error:'附件处理没有返回结果'}
          if (value.error) return {...item,...value,status:'error' as const}
          if (value.size > 10*1024*1024 || total+value.size > MAX_ATTACHMENT_BYTES) return {...item,...value,images:[],status:'error' as const,error:'附件总大小超过 25 MiB'}
          total+=value.size; return {...item,...value,status:'ready' as const}
        })
      })
    } catch(error) { update(items=>items.map(item=>owns(item) ? {...item,status:'error' as const,error:error instanceof Error ? error.message : '附件处理失败'} : item)) }
  },
  retryAttachment: async path => {
    if (!get().attachments.some(item=>item.path===path && item.status==='error')) return
    get().removeAttachment(path)
    await get().prepareAttachments([path])
  },
  removeAttachment: path => set(state => {
    const attachments=state.attachments.filter(item=>item.path!==path)
    return {attachments,...(state.agentMode==='research' ? {researchEditors:{...state.researchEditors,[state.researchView.ownerKey]:{...(state.researchEditors[state.researchView.ownerKey] || emptyResearchEditor()),attachments:attachments as ResearchEditor['attachments'],revision:state.draftRevision+1}},draftRevision:state.draftRevision+1} : {})}
  }),
  clearAttachments: () => {
    for (const item of get().attachments) get().removeAttachment(item.path)
  },

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
    const state = get()
    const row = state.sessions.find(session => session.path === path)
    const cached = Object.values(state.researchBindings).find(binding => binding.sessionFile === path)
    if (row?.desktopResearch || cached) {
      openResearchSession(path, row?.id || cached!.sessionId, row?.cwd || cached!.workspace)
      return
    }
    if (path === get().currentSessionPath && get().agentMode !== 'research' && !get().isSessionLoading && !get().sessionLoadError) return
    beginHydration({ type: 'load_session', requestId: newRequestId('load'), path, preview: true }, path)
  },

  retrySessionLoad: () => {
    if (researchOpenRetryPath) { get().openSession(researchOpenRetryPath); return }
    if (!retryCommand) return
    const prefix = retryCommand.type === 'switch_workspace' ? 'sw' : retryCommand.type === 'new_session' ? 'new' : retryCommand.type === 'fork_session' ? 'fork' : 'load'
    const command: HydrationCommand = { ...retryCommand, requestId: newRequestId(prefix) }
    beginHydration(command, retryTargetPath, true)
  },

  createSession: (carryOverContext = false) => {
    const entryId = newRequestId('research_entry')
    const ownerKey = newResearchOwner(get().currentWorkspace, entryId)
    if (get().agentMode === 'research') get().setAgentMode('agent')
    set({researchNewEntryId: entryId, researchView: {kind:'new',ownerKey,version:get().researchPageVersion+1}, draft:'',attachments:[],ordinaryEditor:{text:'',revision:0,attachments:[]}})
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
    const release = retainResearchActivity()
    const unsubscribe = researchActivity.subscribeHistory()
    void researchActivity.refresh().finally(() => {unsubscribe();release()})
  },

  fetchResearchGraph: (runId?: string) => {
    sendBridge({ type: 'get_research_graph', requestId: `req_graph_${Date.now()}`, runId: runId || undefined })
  },

  upsertResearchCard: (card) => {
    set(state => {
      const previous = state.researchCards[card.runId]
      const incoming: ResearchRunCard = {...(previous ?? {runId:card.runId,question:'',status:'active',phase:'active',tasks:[],updatedAt:Date.now()}),...card}
      return {researchCards:{...state.researchCards,[card.runId]:mergeResearchCard(previous,incoming)}}
    })
  },

  setActiveResearchTask: (target) => set({ activeResearchTaskId: target }),
  setActiveResearchGraphRunId: (runId) => set({ activeResearchGraphRunId: runId }),
  setResearchHistoryOpen: (open) => set(state => ({ researchHistoryOpen: open, researchHistoryGeneration: state.researchHistoryGeneration + 1 })),

  fetchResearchCardDetails: async (runId: string) => {
    const workspace = get().researchCards[runId]?.workspace || get().researchRuns.find(run=>run.id === runId)?.workspace || get().currentWorkspace
    const release = subscribeResearchRun(runId, workspace)
    try { await researchActivity.refresh() } finally {release()}
  },

  setResearchPageView: view => {
    const state = get()
    if (view === 'conversation') get().selectResearchView({ kind: 'conversation', ownerKey: `conversation:${state.researchBinding?.sessionId || 'unbound'}`, sessionId: state.researchBinding?.sessionId || 'unbound' })
    else get().selectResearchView({ kind: 'new', ownerKey: newResearchOwner(state.currentWorkspace, state.researchNewEntryId) })
  },
  setNewResearchDraft: text => set({ newResearchDraft: text }),
  setAgentMode: mode => {
    const state = get()
    if (state.agentMode === mode) return
    cancelResearchSessionOpen()
    if (mode === 'research') {
      const view: ResearchViewSelection = state.researchPageView === 'new' ? { kind: 'new', ownerKey: newResearchOwner(state.currentWorkspace, state.researchNewEntryId) }
        : state.researchView.kind === 'conversation' ? state.researchView
          : { kind: 'conversation', ownerKey: `conversation:${state.researchBinding?.sessionId || 'unbound'}`, sessionId: state.researchBinding?.sessionId || 'unbound' }
      const editor = state.researchEditors[view.ownerKey] || { ...emptyResearchEditor(), model: useSettingsStore.getState().currentModel, thinkingLevel: useSettingsStore.getState().thinkingLevel }
      const version = state.researchPageVersion + 1
      // Save the outgoing owner and restore the incoming owner in one publication; no
      // subscriber can observe a cleared research draft and save it over its bucket.
      set({ ordinaryEditor: { text: state.draft, revision: state.draftRevision, attachments: state.attachments }, permissionMode:'bypassPermissions', agentMode: mode,
        researchEditors: { ...state.researchEditors, [view.ownerKey]: editor }, researchView: { ...view, version }, researchPageVersion: version,
        draft: editor.text, draftRevision: editor.revision, attachments: editor.attachments })
    } else {
      const owner = state.researchView.kind === state.researchPageView ? state.researchView.ownerKey : `conversation:${state.researchBinding?.sessionId || 'unbound'}`
      const version = state.researchPageVersion + 1
      set({ researchEditors: { ...state.researchEditors, [owner]: { ...(state.researchEditors[owner] || emptyResearchEditor()), text: state.draft, revision: state.draftRevision, attachments: state.attachments as ResearchEditor['attachments'] } },
        researchView: { ...state.researchView, version }, researchPageVersion: version,
        agentMode: mode, draft: state.ordinaryEditor.text, draftRevision: state.ordinaryEditor.revision, attachments: state.ordinaryEditor.attachments })
    }
  },

  setPermissionMode: (mode: PermissionMode) => {
    if (get().isSessionLoading || get().sessionLoadError || get().sessionOperation || get().isCompacting) return
    if (get().agentMode === 'research') get().setAgentMode('agent')
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
          suggestionLabel: ev.suggestionLabel,
          canApplySuggestions: ev.canApplySuggestions,
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
