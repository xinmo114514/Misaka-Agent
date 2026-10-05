export type SettingsSectionId =
  | 'models'
  | 'modelBehavior'
  | 'research'
  | 'general'
  | 'appearance'
  | 'tools'
  | 'data'
  | 'shortcuts'
  | 'about'

export interface ModelProviderInfo {
  id: string
  name: string
  configured: boolean
  source?: string
  label?: string
  isOAuth?: boolean
}

export interface ModelDetail {
  id: string
  name: string
  provider: string
  api?: string
  reasoning: boolean
  input: string[]
  contextWindow: number
  maxTokens: number
  configured: boolean
  thinkingLevelMap?: Record<string, string | null>
  source?: 'builtin' | 'custom'
}

export interface CurrentModelConfig {
  provider: string
  modelId: string
  name: string
  thinking: string
}

export interface ConfigPaths {
  cwd: string
  agentDir: string
  authPath: string
  sessionsDir: string
  theme: string
  defaultProvider?: string | null
  defaultModel?: string | null
  defaultThinkingLevel?: string | null
  product?: Record<string, any>
}

/** One provider id the desktop can configure, and how its credential is obtained. */
export type ProviderConnectionKind = 'api-key' | 'oauth' | 'compat'

export interface ProviderConnection {
  providerId: string
  kind: ProviderConnectionKind
  label: string
  detail: string
  modelCount: number
  configured: boolean
  source: string
  authLabel: string
}

export interface ProviderGroup {
  brandId: string
  displayName: string
  subtitle: string
  configured: boolean
  connections: ProviderConnection[]
}

export interface CustomModelDraft {
  id: string
  name?: string
  api?: string
  reasoning?: boolean
  contextWindow?: number
  maxTokens?: number
}

export interface CustomProviderDraft {
  providerId: string
  name: string
  baseUrl: string
  api: string
  hasApiKey: boolean
  headers: Record<string, string>
  models: CustomModelDraft[]
}

export interface ConnectivityResult {
  ok: boolean
  error?: string
  latencyMs?: number
  responseText?: string
  modelId?: string
}

export type CustomProviderApiFormat = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

export const CUSTOM_API_FORMATS: Array<{ value: CustomProviderApiFormat; label: string; path: string }> = [
  { value: 'openai-completions', label: 'OpenAI 兼容 (Chat Completions)', path: '/chat/completions' },
  { value: 'openai-responses', label: 'OpenAI Responses', path: '/responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages', path: '/v1/messages' },
]

/** Logo key per brand, resolved by the shared BrandLogo component. */
export const BRAND_LOGO_KEYS: Record<string, string> = {
  zhipu: 'zhipu',
  deepseek: 'deepseek',
  anthropic: 'anthropic',
  openai: 'openai',
  kimi: 'kimi',
  xiaomi: 'xiaomi',
  qwen: 'qwen',
  custom: 'custom',
}


export interface ToolParameterProperty {
  type?: string
  description?: string
  title?: string
  default?: any
}

export interface ToolInfo {
  name: string
  description: string
  parameters?: {
    type?: string
    properties?: Record<string, ToolParameterProperty>
    required?: string[]
  }
  promptGuidelines?: string[]
}

export interface DiagnosticsInfo {
  pythonVersion: string
  platform: string
  uvPath: string
  cwd: string
  cwdWritable: boolean
  modelsTotal: number
  modelsConfigured: number
  sessionFilesCount: number
  agentDir: string
  authPath: string
  sessionsDir: string
  bridgeStatus: string
  timestamp: number
  latencyMs?: number
}

export interface UpdateCheckResult {
  version?: string
  kind?: string
  behind?: number | null
  upToDate?: boolean | null
  reason?: string | null
}

export type FontSizeOption = 'compact' | 'standard' | 'spacious'
