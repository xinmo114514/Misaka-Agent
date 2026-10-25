import { expect, it } from 'vitest'
import { describeResearchProgress } from './researchProgress'
import type { ResearchRunCard } from '../types/research'

const card = (status = 'active'): ResearchRunCard => ({
  runId: 'r1', question: '课题', status, phase: 'active', updatedAt: 1000,
  tasks: [{ id: 't1', title: '完成', assignee: 'a', status: 'done' },
    { id: 't2', title: '检索', assignee: 'b', status: 'running' },
    { id: 't3', title: '等待', assignee: 'c', status: 'todo' }],
})

it('shows real task counts and separates background activity from a finished model turn', () => {
  const value = describeResearchProgress({ card: card(), startedAt: 100, now: 160000 })
  expect(value.completed).toBe(1)
  expect(value.running).toBe(1)
  expect(value.total).toBe(3)
  expect(value.instruction).toBe('正在研究，暂无需回复')
  expect(value.elapsed).toBe('1 分钟')
  expect(value.live).toBe(true)
})

it('gives failure priority over the leftover active phase and surfaces its cause', () => {
  const value = describeResearchProgress({ card: { ...card('failed'), error: 'database is locked' }, now: 160000 })
  expect(value.label).toBe('失败')
  expect(value.error).toBe('database is locked')
  expect(value.live).toBe(false)
})

it('only asks for a reply when a waiting-input run actually has a question', () => {
  expect(describeResearchProgress({ card: card('waiting_input') }).instruction).toBe('研究已暂停，正在同步待回答问题')
  expect(describeResearchProgress({ card: { ...card('waiting_input'), pendingQuestions: ['请选范围'] } }).instruction)
    .toBe('等待你的回答')
})

it('shows prolonged lack of real activity as a warning, not a fabricated failure or ETA', () => {
  const value = describeResearchProgress({ card: card(), now: 400000, lastActivityAt: 1000 })
  expect(value.quietWarning).toBe('较长时间无更新，可查看详情')
  expect(value.label).toBe('执行中')
  expect(value.elapsed).toBeNull()
  expect(JSON.stringify(value)).not.toMatch(/%|预计剩余/)
})

it('does not reinterpret poll timestamps as meaningful activity or run age', () => {
  const value = describeResearchProgress({ card: { ...card(), updatedAt: 999999 }, now: 1000000 })
  expect(value.elapsed).toBeNull()
  expect(value.lastActivity).toBeNull()
  expect(value.quietWarning).toBeNull()
})

it('keeps completed business and report delivery distinct', () => {
  expect(describeResearchProgress({ card: card('done'), deliveryState: 'pending' }).label).toBe('研究完成，报告待交付')
  expect(describeResearchProgress({ card: card('done'), deliveryState: 'failed' }).label).toBe('研究完成，报告交付失败')
  expect(describeResearchProgress({ card: card('done'), deliveryState: 'delivered' }).label).toBe('报告已交付')
})
