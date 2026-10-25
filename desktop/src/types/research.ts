import type { ChatMessage } from './session'

export interface ResearchConnectionRoute {
  mode: 'direct' | 'proxy'
  endpoint: string
  proxy?: string
}

export interface ResearchFailureDetails {
  role: 'last_order'
  provider: string
  modelId: string
  attempt: number
  category: string
  message: string
  stack?: string
  diagnostics?: unknown[]
  route?: ResearchConnectionRoute
  configurationError?: string
}

export interface ResearchFailureMetadata {
  errorDetails?: ResearchFailureDetails
  errorCode?: string
  errorStage?: string
  researchNeedsConfiguration?: boolean
}

export interface ResearchConnectionProbeResult {
  route: ResearchConnectionRoute | null
  reachable: boolean
  check: 'tcp'
  error?: string
}

export interface ResearchConversationBinding {
  sessionId: string
  sessionFile: string
  workspace: string
  runId: string | null
  streamId?: string
}

export interface ResearchModelRef { provider: string; modelId: string }

export interface ResearchModelBinding {
  effective: ResearchModelRef
  target: ResearchModelRef | null
  epoch: number
  state: 'ready' | 'switching' | 'failed'
  error?: string | null
}

export interface DesktopResearchMember {
  id: string
  name: string
  kind: 'task_agent' | 'borrowed_sister'
  sourceId?: string
  responsibility: string
  goal: string
  instructions: string
  tools: string[]
  skills: string[]
  status: string
  taskIds?: string[]
  retainedAs?: string | null
  effectiveModel?: ResearchModelRef
}

export interface DesktopResearchTeam {
  teamId: string
  scene: 'desktop_research'
  members: DesktopResearchMember[]
}

export interface ResearchTeamSnapshot {
  team?: DesktopResearchTeam | null
  modelBinding?: ResearchModelBinding | null
  modelBindings?: { last_order: ResearchModelBinding; sister: ResearchModelBinding } | null
}

/** Authoritative persisted transcript and host state, not a local run-start receipt. */
export interface ResearchHostSnapshot {
  enabled: boolean
  lifecycle?: { requestId?: string; stage?: string; startedAt?: number; deadlineAt?: number; canStop?: boolean } | null
  reportDelivery?: { artifactId?: string | null; state: 'pending' | 'delivered' | 'failed'; errorCode?: string | null; error?: string | null } | null
  streamId?: string
  session: { sessionId: string; file: string; cwd: string; name?: string | null }
  messages: ChatMessage[]
  submissionReceipts?: Array<{ requestId: string; state: 'prepared' | 'accepted' | 'applied' | 'rejected' | 'unconfirmed'; runId?: string | null; mode?: string;
    retryable?: boolean; errorStage?: string; errorCode?: string; error?: string; errorDetails?: ResearchFailureDetails; researchNeedsConfiguration?: boolean }>
  historyVersion: string | null
  lastEventSeq: number
  /** Native host lifecycle also covers follow-ups to a finished research run. */
  isStreaming?: boolean
  isIdle?: boolean
  run: { id: string; status: string; phase: string; driving?: boolean } | null
  stats: { totalMessages?: number; [key: string]: unknown }
  contextUsage: { tokens?: number; contextWindow?: number; percent?: number; [key: string]: unknown } | null
  team?: DesktopResearchTeam | null
  modelBinding?: ResearchModelBinding | null
  modelBindings?: ResearchTeamSnapshot['modelBindings']
}

export type ResearchNodeKind = 'root' | 'alt' | 'join'
export type ResearchNodeStatus = string

export interface ResearchNodeData {
  id: string
  kind: ResearchNodeKind
  title: string
  question: string
  assignee: {
    id: string
    name: string
    role: string
    avatarBg: string
  }
  status: ResearchNodeStatus
  depth: number
  summary: string
  evidence: string[]
  [key: string]: any
}

/** A research run as reported by the bridge (a product-board record). */
export interface ResearchRunSummary {
  id: string
  question: string
  workspace: string
  status: string
  phase: string
  nodes: number
  tasks: number
  pending_options?: number
  undisposed_issues?: number
  stop_requested?: boolean
  final_artifact?: string | null
  last_error?: string | null
  createdAt?: number
  /** Meaningful engine activity, Unix milliseconds; excludes polling and heartbeats. */
  lastActivityAt?: number
  reportDelivery?: ResearchHostSnapshot['reportDelivery']
  updatedAt?: number
  /**
   * Whether a live driver lease holds this run, straight from the board's own lease rule
   * (`runs.driver_is_live`). Absent means unknown: an old protocol or an unreadable board,
   * never "no driver" — the resume entry stays disabled until a read answers.
   */
  driving?: boolean
  /**
   * The run's root Last Order session, published by the bridge next to the lease fields
   * (`_serialize_research_run`), so a stop entered from a listing can rebind that host.
   */
  rootSession?: string | null
  /** The raw lease, published beside `driving` so a reader can explain the state. */
  driverLock?: string | null
  driverExpires?: number | null
  /**
   * A plan (or a level reconciliation) waits for the user's go-ahead. The run stays `active`
   * while its driver has finished its turn, so this wait must be told apart from an interruption.
   * Absent means unknown, like `driving`.
   */
  awaitingApproval?: boolean
}

/** One node of ``graph.snapshot``; ``[key: string]: any`` keeps it tolerant of new fields. */
export interface ResearchGraphNode {
  id: string
  question: string
  depth: number
  status: string
  kind: 'root' | 'alt' | 'join'
  parents: string[]
  children: string[]
  cards?: {
    id: string
    local_id?: string | null
    dependencies?: string[]
    title: string
    kind?: string
    status: string
    attempt?: number
    folder?: string | null
    assignee?: string | null
  }[]
  red_team?: { assignee?: string; reason?: string } | null
  reached_by?: { option: string; label: string; premise: string; decision: string; decided_at: string }[]
  issues?: string
  files?: Record<string, string[]>
  dissolves?: { question: string; grounds: string } | null
  [key: string]: any
}

export interface ResearchGraphPayload {
  run: string
  question: string
  status: string
  phase: string
  limits?: Record<string, number>
  nodes: ResearchGraphNode[]
  decisions?: any[]
  relations?: any[]
  reconciles?: any[]
  paths?: any[]
  errata?: any[]
  [key: string]: any
}

export interface ResearchRunLimits {
  max_depth: number
  parallel: number
  sister_parallel: number
  max_followups: number
  max_revisions: number
  max_nodes: number
  plan_approval: boolean
  context_threshold?: number | null
  max_output_tokens?: number | null
}

export interface ResearchLimitConstraint {
  min: number
  max?: number
}

export interface ResearchOptionsPayload {
  defaults: ResearchRunLimits
  constraints: Partial<Record<keyof ResearchRunLimits, ResearchLimitConstraint>>
  sisters: Array<{ id: string; name: string; description: string }>
  questions?: Array<{ key: string; header: string; question: string; options: Array<{ label: string; description: string; value: number | boolean | null }> }>
}

export interface ResearchSessionTelemetry {
  cwd: string
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number | null }
  cost: number | null
  cacheHitRate: number | null
  contextUsage: { tokens: number | null; contextWindow: number | null; percent: number | null }
  model: ResearchModelRef | null
  thinkingLevel: string | null
  permissionMode: string | null
  autoCompact: boolean | null
  compactionCount: number
  subscription: boolean | null
}
export interface ResearchSessionDescriptor {
  executorId: string; sessionId: string | null; sessionFile: string | null; nodeId: string; taskId: string | null
  role: 'last_order' | 'sister' | 'agent'; label: string; cardTitle?: string; workspace: string; status: string
  generation: number; attempt: number; startedAt: number | null; endedAt: number | null; error: string | null
  contract?: string | null; telemetry?: ResearchSessionTelemetry | null
    /** Native execution projection; retired attempts stay available in history. */
    isCurrent?: boolean
}
export interface ResearchSessionSnapshot {
  runId: string; executorId: string; sessionId: string | null; nodeId: string; taskId: string | null
  generation: number; attempt: number; revision: number; historyVersion: string | null
  streaming: ChatMessage | null; telemetry: ResearchSessionTelemetry | null; error: string | null; availability: string
  /** Provenance of runtime fields; saved usage totals may still be newer. */
  runtimeSource?: 'live' | 'saved'
}
export interface ResearchSuspension {
  id: string; runId: string; nodeId: string | null; scope: 'node' | 'run'; reason: 'all_cards_stopped'
  hasAcceptedOutput: boolean; confirmations: Array<{ taskId: string; title: string; generation: number; status: string; error: string | null }>
  resumeCommand: string; message: string; createdAt: number; resolvedAt: number | null
}
export interface ResearchSessionsPayload {
  runId: string; run: ResearchRunSummary; graph: ResearchGraphPayload; sessions: ResearchSessionDescriptor[]
  suspension: ResearchSuspension | null; suspensions: ResearchSuspension[]
}
export interface ResearchSessionHistory {
  runId: string; executorId: string; messages: ChatMessage[]; nextCursor: string | null; hasMore: boolean
  availability: 'available' | 'not_started' | 'missing' | 'interrupted'; historyVersion: string | null
  telemetry?: ResearchSessionTelemetry | null; error?: string | null
  direction?: 'older'; reset?: boolean
}

export interface ResearchArtifactDetail {
  id: string
  kind: string
  title: string
  path: string | null
  state: 'available' | 'changed' | 'missing' | 'outside_workspace'
  content: string | null
}

export interface ResearchCitation {
  artifact_id: string | null
  source_file: string
  quote: string
  evidence_sha: string
}

export interface ResearchFinding {
  id: string
  text: string
  claim_type: 'fact' | 'inference' | 'interpretation' | 'normative' | string
  citations: ResearchCitation[]
}

export interface ResearchTaskDetail {
  id: string
  title: string
  body: string
  status: string
  kind: string
  round: number
  attempt: number
  assignee: string
  artifacts: ResearchArtifactDetail[]
  findings: ResearchFinding[]
}

export interface ResearchNodeDetail {
  node: { id: string; question: string; depth: number; status: string; kind: ResearchNodeKind }
  plan_round: number
  plan: Record<string, any> | null
  plan_tool_call_id?: string | null
  available_tools: string[]
  cards: ResearchTaskDetail[]
  artifacts: ResearchArtifactDetail[]
  findings: ResearchFinding[]
  issues: Array<Record<string, any>>
  errata: Array<Record<string, any>>
  red_team: { assignee?: string; reason?: string } | null
}

export interface ResearchRunDetail {
  run: ResearchRunSummary & { rootSession?: string | null; driverLock?: string | null; driving?: boolean }
  graph: ResearchGraphPayload & {
    plans?: Array<{ node_id: string; round: number; tool_call_id: string; plan: Record<string, any> }>
    final_artifacts?: Array<Omit<ResearchArtifactDetail, 'content'> & { content?: never }>
  }
  pending_questions?: Array<{ node_id: string; question: string }>
  root_context?: {
    stats: { totalMessages?: number; [key: string]: unknown }
    contextUsage: { tokens?: number; contextWindow?: number; percent?: number; [key: string]: unknown }
  } | null
}

/** Result of the desktop's update check. */
export interface UpdateStatus {
  version: string | null
  kind: string | null
  behind: number | null
  upToDate: boolean | null
  reason: string | null
}

export interface ResearchTaskSummary {
  id: string
  nodeId?: string
  title: string
  assignee: string
  status: 'pending' | 'running' | 'closed' | 'error' | string
  summary?: string
  round?: number
  attempt?: number
  findingsCount?: number
  artifactsCount?: number
}

export interface ResearchRunCard {
  runId: string
  question: string
  status: string // 'active' | 'waiting_input' | 'done' | 'error' | 'stopped'
  phase: string
  stage?: string
  workspace?: string
  tasks: ResearchTaskSummary[]
  findings?: Array<string | ResearchFinding>
  pendingQuestions?: string[]
  report?: {
    artifactId?: string
    title?: string
    path?: string
    content?: string
    surveyPath?: string
    incomplete?: boolean
  } | null
  error?: string | null
  updatedAt: number
  startedAt?: number
  lastActivityAt?: number
  reportDelivery?: ResearchHostSnapshot['reportDelivery']
  controlEpoch?: number
  eventSeq?: number
  noticeRevision?: number
}

/** One execution of a card: a claimed run attempt, or the card's own recorded runtime. */
export interface ResearchExecutionInstance {
  instanceId: string
  taskId: string
  generation: number
  attempt: number
  phase: string
  status: string
  startedAt: number | null
  endedAt: number | null
  exitCode: number | null
  failureKind: string | null
  summary: string | null
  source: string
}

/** A tool call the sub-agent really made, as its transcript recorded it. */
export interface ResearchExecutionEntry {
  toolCallId: string
  toolName: string
  status: 'pending' | 'running' | 'success' | 'error' | 'cancelled'
  arguments: string | null
  argumentsTruncated: boolean
  resultTruncated: boolean
  result: string | null
  error: string | null
  startedAt: number | null
  endedAt: number | null
  recordIndex: number
}

export type ResearchExecutionAvailability = 'available' | 'not_started' | 'missing' | 'interrupted'

export interface ResearchExecutionPage {
  instances: ResearchExecutionInstance[]
  entries: ResearchExecutionEntry[]
  nextCursor: string | null
  hasMore: boolean
  availability: ResearchExecutionAvailability
  reason?: string | null
  runId: string
  taskId: string
  instanceId?: string
}
