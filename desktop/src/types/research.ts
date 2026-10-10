import type { ChatMessage } from './session'

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
}

/** Authoritative persisted transcript and host state, not a local run-start receipt. */
export interface ResearchHostSnapshot {
  enabled: boolean
  streamId?: string
  session: { sessionId: string; file: string; cwd: string; name?: string | null }
  messages: ChatMessage[]
  submissionReceipts?: Array<{ requestId: string; state: 'prepared' | 'accepted' | 'applied' | 'rejected' | 'unconfirmed'; runId?: string | null; mode?: string;
    retryable?: boolean; errorStage?: string; errorCode?: string; error?: string }>
  historyVersion: string | null
  lastEventSeq: number
  /** Native host lifecycle also covers follow-ups to a finished research run. */
  isStreaming?: boolean
  isIdle?: boolean
  run: { id: string; status: string; phase: string } | null
  stats: { totalMessages?: number; [key: string]: unknown }
  contextUsage: { tokens?: number; contextWindow?: number; percent?: number; [key: string]: unknown } | null
  team?: DesktopResearchTeam | null
  modelBinding?: ResearchModelBinding | null
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
  updatedAt?: number
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
}

export interface ResearchLimitConstraint {
  min: number
  max?: number
}

export interface ResearchOptionsPayload {
  defaults: ResearchRunLimits
  constraints: Partial<Record<keyof ResearchRunLimits, ResearchLimitConstraint>>
  sisters: Array<{ id: string; name: string; description: string }>
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
  } | null
  error?: string | null
  updatedAt: number
}
