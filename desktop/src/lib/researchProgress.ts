import type { ResearchRunCard } from '../types/research'
import { researchRunLabel } from './researchStatus'

interface ProgressInput {
  card?: ResearchRunCard
  /** Persisted run creation time, in Unix seconds. */
  startedAt?: number
  /** Meaningful engine activity time, in milliseconds, not a hydration timestamp. */
  lastActivityAt?: number
  now?: number
  deliveryState?: 'pending' | 'delivered' | 'failed'
}

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}

export function describeResearchProgress(input: ProgressInput) {
  const { card, deliveryState } = input
  const now = input.now ?? Date.now()
  const status = card?.status?.toLowerCase()
  const live = status === 'active' || status === 'waiting_input' || status === 'stopping'
  const tasks = card?.tasks ?? []
  let label = researchRunLabel(card)
  if (status === 'stopping') label = '正在停止'
  if (status === 'waiting_input') label = '待用户输入'
  if (status === 'done') {
    label = deliveryState === 'delivered' ? '报告已交付'
      : deliveryState === 'failed' ? '研究完成，报告交付失败'
      : '研究完成，报告待交付'
  }
  const instruction = status === 'waiting_input'
    ? card?.pendingQuestions?.length ? '等待你的回答' : '研究已暂停，正在同步待回答问题'
    : status === 'stopping' ? '停止已请求，等待结算'
    : live ? '正在研究，暂无需回复' : null
  const activity = input.lastActivityAt
  return {
    label, live, instruction,
    completed: tasks.filter(task => task.status === 'done' || task.status === 'closed').length,
    running: tasks.filter(task => task.status === 'running').length,
    failed: tasks.filter(task => task.status === 'failed' || task.status === 'error').length,
    total: tasks.length,
    elapsed: input.startedAt === undefined ? null : duration(now - input.startedAt * 1000),
    lastActivity: activity === undefined ? null : `${duration(now - activity)}前`,
    quietWarning: live && status !== 'waiting_input' && status !== 'stopping'
      && activity !== undefined && now - activity > 300000 ? '较长时间无更新，可查看详情' : null,
    error: card?.error ?? null,
  }
}
