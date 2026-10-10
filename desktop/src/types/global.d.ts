import type { ResolvedThemeData } from '../theme/types'

export interface BridgeEventEnvelope {
  seq: number
  streamId?: string
  sessionId: string
  event: {
    type: string
    [key: string]: any
  }
}

export interface BridgeAck {
  type: 'ack'
  requestId: string | null
  ok: boolean
  error?: string
  data?: any
  [key: string]: any
}

export type BridgeMessage = BridgeEventEnvelope | BridgeAck

export interface BridgeAPI {
  send: (cmd: unknown) => void
  on: (handler: (message: BridgeMessage) => void) => () => void
}

export interface ThemeData extends ResolvedThemeData {}

/** Outcome of window.theme.setTheme: `name` is the theme actually in effect. */
export interface ThemeSetResult {
  ok: boolean
  name: string
  error?: string
}

export interface ThemeAPI {
  listThemes: () => Promise<import('../theme/types').ThemeSummary[]>
  onChange: (handler: (themeData: ThemeData) => void) => () => void
  /** Resolves to null for an unsupported name or an unreadable theme file. */
  getTheme: (name?: string) => Promise<ThemeData | null>
  setTheme: (name: string) => Promise<ThemeSetResult>
}

export interface AppAPI {
  getVersion: () => Promise<string>
  pickDirectory: () => Promise<string | null>
  pickFiles: () => Promise<string[]>
  openPath: (targetPath: string) => Promise<PathActionResult>
  openExternal: (url: string) => Promise<boolean>
  showItemInFolder: (targetPath: string) => Promise<PathActionResult>
  startResearchBridge: (input: { cwd: string; sessionFile?: string | null }) => Promise<{
    enabled: boolean
    session: { sessionId: string; file: string; cwd: string }
    stats: { totalMessages?: number; [key: string]: unknown }
    contextUsage: { tokens?: number; contextWindow?: number; percent?: number; [key: string]: unknown }
    messages?: import('./session').ChatMessage[]
    submissionReceipts?: import('./research').ResearchHostSnapshot['submissionReceipts']
    historyVersion?: string | null
    lastEventSeq?: number
    streamId?: string
    isStreaming?: boolean
    isIdle?: boolean
    run?: { id: string; status: string; phase: string } | null
    team?: import('./research').DesktopResearchTeam | null
    modelBinding?: import('./research').ResearchModelBinding | null
  }>
  setResearchActive: (state: boolean | { active: boolean; pendingCount: number }) => void
  onRequestClose?: (handler: () => void) => () => void
  confirmClose?: (action: 'tray' | 'quit') => Promise<void>
}

export interface PathActionResult {
  ok: boolean
  error?: string
}

declare global {
  interface Window {
    bridge: BridgeAPI
    researchBridge: BridgeAPI
    theme: ThemeAPI
    app: AppAPI
  }
}
