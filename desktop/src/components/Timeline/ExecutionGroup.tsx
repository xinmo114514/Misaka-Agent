import React, { useCallback, useEffect, useId, useMemo, useRef } from 'react'
import { AlertCircle, CheckCircle2, ChevronRight, CircleMinus, Loader2 } from 'lucide-react'
import type { ChatMessage, ToolCall } from '../../types/session'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallRow } from './ToolCallCard'
import { hasOpenDisclosure, useDisclosure, useSessionViewKey } from '../../lib/sessionViewState'
import { formatDuration, toolDisplayName } from '../../lib/toolDisplay'
import { useLiveClock } from '../../lib/useLiveClock'

type Block = NonNullable<ChatMessage['blocks']>[number]
type ExecutionBlock = Exclude<Block, { type: 'text' }>

const TERMINAL = new Set(['success', 'error', 'cancelled'])
const FOLLOW_EPSILON = 24
const SUMMARY_TAIL = 4

function summarizeExecution(blocks: ExecutionBlock[]) {
  const calls = blocks.filter((block): block is Extract<ExecutionBlock, { type: 'toolCall' }> => block.type === 'toolCall').map(b => b.toolCall)
  const failed = calls.filter(call => call.status === 'error').length
  const cancelled = calls.filter(call => call.status === 'cancelled').length
  const done = calls.filter(call => TERMINAL.has(call.status)).length
  const thinking = blocks.some(block => block.type === 'thinking' && block.isStreaming)
  const running = thinking || calls.some(call => !TERMINAL.has(call.status))
  const status = running ? '执行中'
    : failed && done > failed ? '部分失败'
      : failed ? '执行失败'
        : cancelled && cancelled === calls.length ? '已取消' : '已完成'
  return { calls, done, failed, cancelled, running, status }
}

function groupElapsed(calls: ToolCall[], running: boolean, now: number): number | null {
  if (!calls.length || !calls.every(call => call.startedAt)) return null
  const start = Math.min(...calls.map(call => call.startedAt!))
  if (running) return Math.max(0, now - start)
  if (!calls.every(call => call.endedAt)) return null
  return Math.max(...calls.map(call => call.endedAt!)) - start
}

export const ExecutionGroup: React.FC<{ blocks: ExecutionBlock[]; stateKey?: string; active?: boolean }> = ({ blocks, stateKey, active }) => {
  const [manualExpanded, setExpanded] = useDisclosure(`group:${stateKey ?? blocks[0].id}`)
  const { calls, done, failed, running, status } = useMemo(() => summarizeExecution(blocks), [blocks])
  const path = useSessionViewKey()
  const childKeys = useMemo(() => blocks.map(block => block.type === 'thinking'
    ? `thinking:${stateKey ? `${stateKey}:${block.contentIndex}` : block.id}`
    : `tool:${block.toolCall.id}`), [blocks, stateKey])
  // Open while it is the live tail of the turn, and afterwards only if the reader left
  // a row open by hand. An explicit click on the lane beats all three defaults.
  const expanded = manualExpanded ?? (running || Boolean(active) || hasOpenDisclosure(path, childKeys))
  const now = useLiveClock(running)
  const elapsed = groupElapsed(calls, running, now)
  const contentId = useId()
  const listRef = useRef<HTMLOListElement>(null)
  const following = useRef(true)
  const StatusIcon = running ? Loader2 : failed ? AlertCircle : status === '已取消' ? CircleMinus : CheckCircle2
  // Repeating the same tool a hundred times says nothing; count it once.
  const names = useMemo(() => {
    const counts = new Map<string, number>()
    for (const block of blocks) {
      const label = block.type === 'toolCall' ? toolDisplayName(block.toolCall.name) : '深度思考'
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    const parts = [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label))
    return parts.length > SUMMARY_TAIL ? `…${parts.slice(-SUMMARY_TAIL).join(' · ')}` : parts.join(' · ')
  }, [blocks])

  useEffect(() => { if (expanded) following.current = true }, [expanded])
  useEffect(() => {
    const list = listRef.current
    if (!list || !expanded || !following.current) return
    list.scrollTop = list.scrollHeight
  }, [blocks, expanded, now])

  const handleScroll = useCallback(() => {
    const list = listRef.current
    if (!list) return
    following.current = list.scrollHeight - list.scrollTop - list.clientHeight <= FOLLOW_EPSILON
  }, [])

  const counter = calls.length
    ? (running ? `已完成 ${done}/${calls.length}` : `${calls.length} 次工具调用`)
    : `${blocks.length} 步`
  const label = ['执行记录', status, counter, failed ? `${failed} 项失败` : ''].filter(Boolean).join(' · ')

  return <section className="conversation-execution-group" data-execution-group={blocks[0].id} data-execution-status={status}>
    <button type="button" className="conversation-group-toggle" aria-label={label}
      aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(!expanded)}>
      <ChevronRight className={'conversation-chevron is-leading ' + (expanded ? 'is-expanded' : '')} />
      <StatusIcon className={'conversation-row-icon ' + (running ? 'animate-spin text-accent' : failed ? 'text-danger' : 'text-dim')} />
      <span className="conversation-group-status">{status}</span>
      <span className="conversation-row-meta">{counter}</span>
      {elapsed !== null && <span className="conversation-row-meta conversation-group-duration" aria-hidden="true">{formatDuration(elapsed)}</span>}
      <span className="conversation-group-summary">{names}</span>
      {failed ? <span className="conversation-group-failure">{failed} 项失败</span> : null}
    </button>
    <ol ref={listRef} id={contentId} className="conversation-execution-list" hidden={!expanded} onScroll={handleScroll}>
      {blocks.map(block => block.type === 'thinking'
        ? <li key={block.id} className="conversation-execution-row">
          <ThinkingBlock stateKey={stateKey ? `${stateKey}:${block.contentIndex}` : block.id} thinking={block.thinking} isStreaming={Boolean(block.isStreaming)} />
        </li>
        : <ToolCallRow key={block.id} toolCall={block.toolCall} now={now} />)}
    </ol>
  </section>
}
