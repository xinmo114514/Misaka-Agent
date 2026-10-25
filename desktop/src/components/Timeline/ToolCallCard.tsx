import React, { useId, useMemo } from 'react'
import { Terminal, CheckCircle2, AlertCircle, Loader2, ChevronRight, CircleMinus, Clock } from 'lucide-react'
import type { ToolCall } from '../../types/session'
import { useDisclosure } from '../../lib/sessionViewState'
import { formatDuration, redactSecrets, toolCallElapsed, toolCallSummary, toolDisplayName } from '../../lib/toolDisplay'
import { useLiveClock } from '../../lib/useLiveClock'
import { useChatSurfaceKey } from './ChatSurface'

// Bridge outputs use content arrays, strings, and structured details. Render their
// actual text rather than dumping transport wrappers into the reading surface.
export function readableToolValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(readableToolValue).filter(Boolean).join('\n')
  if (typeof value === 'object') {
    const data = value as Record<string, unknown>
    if (Array.isArray(data.content)) return readableToolValue(data.content)
    if (data.type === 'text' && typeof data.text === 'string') return data.text
    if (data.type === 'image') return '[图片内容]'
    if (data.type === 'resource' && data.resource) return readableToolValue(data.resource)
    if (typeof data.text === 'string') return data.text
    return JSON.stringify(value, null, 2)
  }
  return String(value)
}

const STATUS = { pending: '等待中', running: '执行中', success: '完成', error: '失败', cancelled: '已取消' }
const STATUS_ICON = { pending: Clock, running: Loader2, success: CheckCircle2, error: AlertCircle, cancelled: CircleMinus }
const STATUS_CLASS = { pending: 'text-dim', running: 'text-warning', success: 'text-success', error: 'text-danger', cancelled: 'text-dim' }

export const ToolCallRow: React.FC<{ toolCall: ToolCall; now?: number }> = ({ toolCall, now: suppliedNow }) => {
  const surfaceKey = useChatSurfaceKey()
  const [manualExpanded, setExpanded] = useDisclosure(`tool:${toolCall.id}`, surfaceKey)
  const expanded = manualExpanded ?? false
  const contentId = useId()
  const isRunning = toolCall.status === 'running' || toolCall.status === 'pending'
  const now = useLiveClock(isRunning)
  const clock = suppliedNow ?? now
  const StatusIcon = STATUS_ICON[toolCall.status]
  const summary = useMemo(() => toolCallSummary(toolCall), [toolCall])
  const elapsed = useMemo(() => toolCallElapsed(toolCall, clock), [toolCall, clock])
  const sections = useMemo(() => expanded ? [
    // One-line summaries only read scalar arguments; MCP tools often pass nested objects,
    // so the expanded view is gated on having arguments, not on having a summary.
    ['参数', toolCall.arguments && Object.keys(toolCall.arguments).length ? redactSecrets(JSON.stringify(toolCall.arguments, null, 2)) : ''],
    ['实时输出', readableToolValue(toolCall.partialResult)],
    ['输出', readableToolValue(toolCall.result)],
    ['详情', readableToolValue(toolCall.details)],
    ['错误', redactSecrets(readableToolValue(toolCall.error))],
  ] : [], [expanded, toolCall])
  return <li className="conversation-execution-row" data-tool-status={toolCall.status}>
    <button type="button" className="conversation-row-toggle" aria-expanded={expanded} aria-controls={contentId}
      title={toolCall.name} onClick={() => setExpanded(!expanded)}>
      <Terminal className="conversation-row-icon text-dim" />
      <span className="conversation-tool-name">{toolDisplayName(toolCall.name)}</span>
      {summary && <span className="conversation-tool-summary" title={summary}>{summary}</span>}
      <span className={'conversation-tool-status ' + STATUS_CLASS[toolCall.status]}>
        <StatusIcon className={'conversation-status-icon ' + (isRunning ? 'animate-spin' : '')} />{STATUS[toolCall.status]}
        {elapsed !== null && <span className="conversation-tool-elapsed" aria-hidden="true">{formatDuration(elapsed)}</span>}
      </span>
      <ChevronRight className={'conversation-chevron ' + (expanded ? 'is-expanded' : '')} />
    </button>
    <div id={contentId} hidden={!expanded} className="conversation-tool-details">
      {expanded && sections.filter(([, value]) => value).map(([label, value]) => <div key={label} className={label === '错误' ? 'conversation-tool-error' : undefined}>
        <h4>{label}</h4><pre>{value}</pre>
      </div>)}
      {expanded && !sections.some(([, value]) => value) && <p className="text-dim">暂无详细输出</p>}
    </div>
  </li>
}

/** Standalone row for a turn that touched exactly one tool: same vocabulary, no timeline chrome. */
export const ToolCallCard: React.FC<{ toolCall: ToolCall; now?: number }> = ({ toolCall, now }) => (
  <ul className="conversation-execution-list is-standalone"><ToolCallRow toolCall={toolCall} now={now} /></ul>
)
