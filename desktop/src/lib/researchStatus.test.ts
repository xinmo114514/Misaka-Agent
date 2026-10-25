import { describe, expect, it } from 'vitest'
import { researchRunLabel, researchPhaseLabel, researchNodeLabel, researchOverview } from './researchStatus'

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

describe('researchRunLabel terminal priority', () => {
  it('keeps a failed run failed even when its phase still says active', () => {
    expect(researchRunLabel({ status: 'failed', phase: 'active' })).toBe('失败')
  })

  it('shows the phase for an active run', () => {
    expect(researchRunLabel({ status: 'active', phase: 'executing' })).toBe('执行中')
  })

  it('treats stopped and done as terminal too', () => {
    expect(researchRunLabel({ status: 'stopped', phase: 'active' })).toBe('已停止')
    expect(researchRunLabel({ status: 'done', phase: 'finalizing' })).toBe('已完成')
  })
})
it.each([['stopping','正在停止'],['waiting_input','待用户输入']])('run status %s takes priority over old active phase', (status,label) => {expect(researchRunLabel({status,phase:'active'})).toBe(label)})
it.each([['partial','已暂停'],['cancelled','已停止'],['closed','已完成']])('terminal %s has a localized label', (status,label)=>{expect(researchRunLabel({status,phase:'active'})).toBe(label)})
