export type MessageRole = 'user' | 'assistant' | 'system'

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
  role: MessageRole
  content: string
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

export interface ProjectGroup {
  id: string
  name: string
  sessions: {
    id: string
    title: string
    active?: boolean
    modified: string
  }[]
}
