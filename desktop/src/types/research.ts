export type ResearchNodeKind = 'root' | 'alt' | 'join'
export type ResearchNodeStatus = 'done' | 'running' | 'pending' | 'review' | 'failed'

export interface CardReply {
  id: string
  sender: string
  content: string
  timestamp: string
}

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
  findings: string[]
  evidence: string[]
  replies: CardReply[]
  [key: string]: any
}
