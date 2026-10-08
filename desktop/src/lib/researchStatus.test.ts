import { describe, expect, it } from 'vitest'
import { researchPhaseLabel, researchNodeLabel, researchOverview } from './researchStatus'

describe('research phase labels', () => {
  it.each([
    ['planning', '规划中'],
    ['awaiting_approval', '待审批'],
    ['executing', '执行中'],
    ['waiting_input', '待用户输入'],
    ['red_team_review', '红队审查'],
    ['divergence_review', '歧路审查'],
    ['adjudication_draft', '报告生成'],
    ['done', '已完成'],
    ['failed', '失败'],
    ['stopping', '正在停止'],
  ])('preserves %s as a distinct user-visible state', (value, label) => {
    expect(researchPhaseLabel(value)).toBe(label)
  })
})

describe('node status labels', () => {
  it.each([
    ['awaiting_approval', '待审批'],
    ['waiting_input', '待用户输入'],
    ['critique', '红队审查'],
    ['diverging', '歧路审查'],
    ['closed', '已完成'],
  ])('preserves %s as a distinct node state', (value, label) => {
    expect(researchNodeLabel(value)).toBe(label)
  })
})

describe('concurrent node overview', () => {
  it('keeps simultaneous approval, red-team and execution states visible as separate counts', () => {
    expect(researchOverview([
      { status: 'awaiting_approval' }, { status: 'critique' },
      { status: 'executing' }, { status: 'executing' }, { status: 'closed' },
    ])).toEqual([
      { status: 'awaiting_approval', label: '待审批', count: 1 },
      { status: 'critique', label: '红队审查', count: 1 },
      { status: 'executing', label: '执行中', count: 2 },
      { status: 'closed', label: '已完成', count: 1 },
    ])
  })
})
