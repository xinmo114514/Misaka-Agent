export interface BridgeEventEnvelope {
  seq: number
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

export interface ThemeData {
  name: string
  colors: Record<string, string>
  desktop?: {
    surface2?: string
    surface3?: string
    surfaceHover?: string
    borderSubtle?: string
    border?: string
    borderAccent?: string
    disabled?: string
    focusRing?: string
    chart?: string[]
  }
}

export interface ThemeAPI {
  onChange: (handler: (themeData: ThemeData) => void) => () => void
  getTheme: () => Promise<ThemeData>
}

export interface AppAPI {
  getVersion: () => Promise<string>
}

declare global {
  interface Window {
    bridge: BridgeAPI
    theme: ThemeAPI
    app: AppAPI
  }
}
