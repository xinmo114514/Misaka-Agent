import type { ToolCall } from '../types/session'

const TOOL_LABELS: Record<string, string> = {
  read: '读取文件', write: '写入文件', edit: '编辑文件', office: '处理办公文档',
  bash: '终端命令', powershell: '终端命令',
  grep: '搜索代码', find: '查找文件', ls: '浏览目录',
  web_fetch: '浏览网页', web_search: '搜索资料', web_extract: '提取网页', x_search: '搜索社区',
  download_file: '下载文件',
  Agent: '委派子 Agent', Task: '委派子 Agent', TaskOutput: '读取子任务输出',
  TaskStop: '停止子任务', KillShell: '停止子任务', StructuredOutput: '整理结构化结论',
  AskUserQuestion: '向你提问', Skill: '使用技能', skill_view: '查看技能',
  skills_list: '列出技能', skill_manage: '管理技能',
  browser_cdp: '操作浏览器', browser_exec: '操作浏览器', browser_dialog: '处理浏览器弹窗',
  ListMcpResourcesTool: '列出知识资源', ReadMcpResourceTool: '读取知识资源', SendMessage: '发送消息',
}

// Per-tool preference for which argument carries the readable intent.
const DETAIL_KEYS: Record<string, string[]> = {
  read: ['path'], write: ['path'], edit: ['path'], office: ['path'],
  bash: ['command', 'description'], powershell: ['command', 'description'],
  grep: ['pattern', 'path'], find: ['pattern', 'path'], ls: ['path'],
  web_fetch: ['url'], download_file: ['url', 'path'],
  web_search: ['query'], x_search: ['query'], web_extract: ['urls'],
  Agent: ['description'], Task: ['description'],
  TaskOutput: ['task_id'], TaskStop: ['task_id'], KillShell: ['task_id'],
  skill_view: ['name'], skill_manage: ['name'],
}

const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|access[-_]?key|private[-_]?key|authorization|cookie|credential)/i
const MAX_DETAIL = 320
/**
 * The summary never shows more than MAX_DETAIL characters, so redacting further than that is pure
 * cost -- and this runs on every streamed snapshot of a call whose arguments can be tens of KiB.
 * The margin keeps a credential that starts before the cut from being sliced out of view.
 */
const REDACT_WINDOW = MAX_DETAIL * 8

function scalar(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const parts = value.map(scalar).filter(Boolean)
    return parts.length > 3 ? `${parts.slice(0, 3).join('、')} 等 ${parts.length} 项` : parts.join('、')
  }
  return ''
}

/** Redact credential-looking values before a parameter summary reaches the DOM. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_match, scheme: string) => `${scheme} ••••`)
    .replace(/(["']?[\w-]*(?:token|secret|password|passwd|api[-_]?key|access[-_]?key|authorization|cookie|credential)[\w-]*["']?\s*[:=]\s*["']?)(?!(?:bearer|basic)\b)[^\s,"'&;]+/gi,
      (_match, head: string) => `${head}••••`)
}

export function toolDisplayName(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name]
  const words = String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim()
  return words || '工具调用'
}

/** One-line, credential-safe preview of what a call asked for. */
export function toolCallSummary(toolCall: ToolCall): string {
  const args = toolCall.arguments
  if (!args || typeof args !== 'object') return ''
  const keys = DETAIL_KEYS[toolCall.name] ?? Object.keys(args).filter(key => !SECRET_KEY.test(key))
  let raw = ''
  for (const key of keys) {
    raw = scalar(args[key])
    if (raw.trim()) break
  }
  if (!raw.trim()) {
    for (const key of Object.keys(args)) {
      if (SECRET_KEY.test(key)) continue
      raw = scalar(args[key])
      if (raw.trim()) break
    }
  }
  const flat = redactSecrets(raw.length > REDACT_WINDOW ? raw.slice(0, REDACT_WINDOW) : raw).replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL)}…` : flat
}

/** Real elapsed time, or null when the transcript never carried a clock. */
export function toolCallElapsed(toolCall: ToolCall, until = Date.now()): number | null {
  if (!toolCall.startedAt) return null
  const end = toolCall.endedAt ?? (toolCall.status === 'pending' || toolCall.status === 'running' ? until : null)
  if (!end || end < toolCall.startedAt) return null
  return end - toolCall.startedAt
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 1) return '不足 1 秒'
  if (seconds < 10) return `${seconds.toFixed(1)} 秒`
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${Math.round(seconds % 60)} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}
