export type ResearchNodeKind = 'root' | 'alt' | 'join'
export type ResearchNodeStatus = 'done' | 'running' | 'pending' | 'review' | 'failed'

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

/** Result of the desktop's update check. */
export interface UpdateStatus {
  version: string | null
  kind: string | null
  behind: number | null
  upToDate: boolean | null
  reason: string | null
}
