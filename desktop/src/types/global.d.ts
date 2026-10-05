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
    surface0?: string
    surface1?: string
    surface2?: string
    surface3?: string
    surfaceHover?: string
    borderSubtle?: string
    border?: string
    borderStrong?: string
    borderAccent?: string
    disabled?: string
    focusRing?: string
    chart?: string[]
  }
}

/** Outcome of window.theme.setTheme: `name` is the theme actually in effect. */
export interface ThemeSetResult {
  ok: boolean
  name: string
  error?: string
}

export interface ThemeAPI {
  onChange: (handler: (themeData: ThemeData) => void) => () => void
  /** Resolves to null for an unsupported name or an unreadable theme file. */
  getTheme: (name?: string) => Promise<ThemeData | null>
  setTheme: (name: string) => Promise<ThemeSetResult>
}

export interface AppAPI {
  getVersion: () => Promise<string>
  pickDirectory: () => Promise<string | null>
  openPath: (targetPath: string) => Promise<boolean>
  showItemInFolder: (targetPath: string) => Promise<void>
}

declare global {
  interface Window {
    bridge: BridgeAPI
    theme: ThemeAPI
    app: AppAPI
  }
}
