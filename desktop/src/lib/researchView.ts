import type { ChatMessage } from '../types/session'
import type { PreparedAttachment } from '../types/attachment'
export type ResearchView = { kind: 'new'; ownerKey: string; version: number } | { kind: 'conversation'; ownerKey: string; sessionId: string; version: number }
export type ResearchViewSelection = Omit<Extract<ResearchView, {kind:'new'}>, 'version'> | Omit<Extract<ResearchView, {kind:'conversation'}>, 'version'>
export interface ResearchEditor {
 text: string
 revision: number
 attachments: Array<PreparedAttachment & { attachmentId: string; preparationId: string }>
 model: { provider: string; modelId: string; name?: string; thinking?: string } | null
 lastOrderModel?: { provider: string; modelId: string; name?: string; thinking?: string } | null
 thinkingLevel: string
}
export type ResearchControlTarget =
 | { kind: 'startup'; requestId: string; workspace: string; sessionId?: string; streamId?: string }
 | { kind: 'run'; runId: string; workspace: string; rootSession?: string; sessionId?: string; sessionFile?: string | null; streamId?: string }
 | { kind: 'turn'; workspace: string; sessionId: string; streamId?: string }
export function emptyResearchEditor(): ResearchEditor { return { text: '', revision: 0, attachments: [], model: null, thinkingLevel: 'off' } }
export function newResearchOwner(workspace: string, entryId: string): string { return `new:${workspace.trim().replace(/[\\/]+$/, '').toLowerCase()}:${entryId}` }

export const EMPTY_RESEARCH_MESSAGES: ChatMessage[] = []
