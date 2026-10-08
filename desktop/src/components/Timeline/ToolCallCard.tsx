import React, { useId, useMemo } from 'react'
import { Terminal, CheckCircle2, AlertCircle, Loader2, ChevronRight, CircleMinus } from 'lucide-react'
import type { ToolCall } from '../../types/session'
import { useDisclosure } from '../../lib/sessionViewState'

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

export const ToolCallCard: React.FC<{ toolCall: ToolCall }> = ({ toolCall }) => {
  const [manualExpanded, setExpanded] = useDisclosure(`tool:${toolCall.id}`)
  const expanded = manualExpanded ?? false
  const contentId = useId()
  const isRunning = toolCall.status === 'running' || toolCall.status === 'pending'
  const isError = toolCall.status === 'error'
  const StatusIcon = isRunning ? Loader2 : isError ? AlertCircle : toolCall.status === 'cancelled' ? CircleMinus : CheckCircle2
  const statusClass = isRunning ? 'text-warning' : isError ? 'text-danger' : toolCall.status === 'cancelled' ? 'text-dim' : 'text-success'
  const sections = useMemo(() => expanded ? [
    ['参数', toolCall.arguments === undefined ? '' : JSON.stringify(toolCall.arguments, null, 2)],
    ['实时输出', readableToolValue(toolCall.partialResult)],
    ['输出', readableToolValue(toolCall.result)],
    ['详情', readableToolValue(toolCall.details)],
    ['错误', readableToolValue(toolCall.error)],
  ] : [], [expanded, toolCall])
  return <section className="conversation-execution-row" data-tool-status={toolCall.status}>
    <button type="button" className="conversation-row-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(!expanded)}>
      <Terminal className="conversation-row-icon text-dim" />
      <span className="conversation-tool-name">{toolCall.name}</span>
      <span className={'conversation-tool-status ' + statusClass}><StatusIcon className={'conversation-status-icon ' + (isRunning ? 'animate-spin' : '')} />{STATUS[toolCall.status]}</span>
      <ChevronRight className={'conversation-chevron ' + (expanded ? 'is-expanded' : '')} />
    </button>
    <div id={contentId} hidden={!expanded} className="conversation-tool-details">
      {expanded && sections.filter(([, value]) => value).map(([label, value]) => <div key={label} className={label === '错误' ? 'conversation-tool-error' : undefined}>
        <h4>{label}</h4><pre>{value}</pre>
      </div>)}
      {expanded && !sections.some(([, value]) => value) && <p className="text-dim">暂无详细输出</p>}
    </div>
  </section>
}
