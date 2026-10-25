export type MessageRole = 'user' | 'assistant' | 'system' | 'custom'

import type { PromptImage } from './attachment'
import type { ResearchSubmissionInput } from '../lib/startComposerResearch'
import type { ResearchFailureMetadata } from './research'

export interface ToolCall {
  id: string
  name: string
  argumentsTruncated?: boolean
  resultTruncated?: boolean
  arguments?: Record<string, any>
  result?: any
  status: 'pending' | 'running' | 'success' | 'error' | 'cancelled'
  partialResult?: any
  partialArguments?: string
  details?: any
  error?: string
  /** Observed locally: transcripts carry no per-call clock, so history may omit both. */
  startedAt?: number
  endedAt?: number
}

export type MessageBlock =
  | { type: 'text'; id: string; contentIndex: number; text: string; isStreaming?: boolean }
  | { type: 'thinking'; id: string; contentIndex: number; thinking: string; isStreaming?: boolean }
  | { type: 'toolCall'; id: string; contentIndex: number; toolCall: ToolCall }

export interface ChatMessage extends ResearchFailureMetadata {
  id: string
  /** The persisted session entry this message came from (absent for live/unsaved turns). */
  entryId?: string
  role: MessageRole
  content: string
  contentTruncated?: boolean
  /** Image inputs preserved on optimistic rows and hydrated session history. */
  images?: PromptImage[]
  /** Canonical ordered content; legacy text/tool fields are derived projections. */
  blocks?: MessageBlock[]
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
  /** Pending local user echo until the engine acknowledges the user message. */
  optimistic?: boolean
  /** Research delivery acknowledgement is distinct from persisted message creation. */
  requestId?: string
  deliveryStatus?: 'pending' | 'unconfirmed' | 'accepted' | 'created' | 'failed'
  /** A host snapshot/history refresh completed after an acknowledgement timeout. */
  deliveryReconciled?: boolean
  /** False when authoritative delivery uncertainty requires manual reconciliation. */
  deliveryRetryable?: boolean
  /** Local delivery intent; acknowledgement means accepted, not consumed. */
  streamingBehavior?: 'steer' | 'followUp'
  submissionError?: string
  /** Immutable original native input, retained for request-idempotent retry. */
  researchSubmission?: Readonly<ResearchSubmissionInput>
  researchDraft?: { ownerKey?: string; attachmentIdentities?: Array<{attachmentId: string; preparationId: string}>; text: string; attachmentPaths: string[]; sessionId: string; streamId?: string; mode: 'research'; revision?: number }
  /** Delivery succeeded; execution subsequently failed. */
  executionError?: string
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
  /** Filesystem revision; activity time alone misses external edits. */
  fileRevision?: string
  messageCount: number
  firstMessage: string
  /** Persisted desktop research intake/recruitment, including roots without a Run. */
  desktopResearch?: boolean
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

export type TreeFilterMode = 'default' | 'no-tools' | 'user-only' | 'labeled-only' | 'all'
export interface SessionTreeSerialNode { entry: Record<string, any>; label: string | null; labelTimestamp: string | null; children: SessionTreeSerialNode[] }
export interface SessionTreePayload { sessionId: string; sessionFile: string | null; historyVersion: string | null; leafId: string | null; tree: SessionTreeSerialNode[]; settings?: { treeFilterMode?: TreeFilterMode | null; branchSummarySkipPrompt?: boolean | null } | null }
export type SessionOperationKind = 'navigate_tree' | 'compact_session'
export interface SessionOperationResult { requestId: string; sessionId: string; operation: SessionOperationKind; status: 'done'|'cancelled'|'aborted'|'error'; error?: string | null; editorText?: string | null; leafId?: string | null; historyVersion?: string | null; messages?: ChatMessage[]; summaryEntry?: Record<string, any> | null }
