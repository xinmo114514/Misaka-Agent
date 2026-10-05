export type MessageRole = 'user' | 'assistant' | 'system' | 'custom'

export interface ToolCall {
  id: string
  name: string
  arguments?: Record<string, any>
  result?: any
  status: 'pending' | 'running' | 'success' | 'error'
  error?: string
}

export interface ChatMessage {
  id: string
  /** The persisted session entry this message came from (absent for live/unsaved turns). */
  entryId?: string
  role: MessageRole
  content: string
  /** Set for `role === 'custom'`: what the engine called this notice. */
  customType?: string
  /** What the engine put on the feed, verbatim. */
  details?: Record<string, any>
  /** A custom message the engine keeps out of the feed. Shown nowhere, kept for the record. */
  display?: boolean
  thinking?: string
  toolCalls?: ToolCall[]
  timestamp: number
  isStreaming?: boolean
  stopReason?: string
  errorMessage?: string
  tokens?: {
    input?: number
    output?: number
    total?: number
  }
}

/** One session as reported by the bridge (a persisted JSONL transcript). */
export interface SessionInfoOut {
  id: string
  path: string
  cwd: string
  name?: string | null
  created: string
  modified: string
  messageCount: number
  firstMessage: string
  parentSessionPath?: string | null
}

/** A session row shown in the sidebar, with its display title + project folder. */
export interface SessionRow {
  id: string
  path: string
  cwd: string
  title: string
  modified: string
  messageCount: number
}

export interface ProjectGroup {
  id: string
  name: string
  sessions: SessionRow[]
}

export type SessionFilterScope = 'here' | 'all'

export interface WorkspaceItem {
  path: string
  name: string
  active?: boolean
  sessionCount?: number
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

export interface PermissionRequestPayload {
  requestId: string
  toolName: string
  toolInput: Record<string, any>
  reason?: string
  mode?: string
  agentId?: string | null
}
