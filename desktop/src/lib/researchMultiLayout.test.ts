import { describe, expect, it } from 'vitest'
import type { ResearchSessionDescriptor } from '../types/research'
import {
  getResearchMosaicLayout,
  researchMosaicRowCap,
  selectResearchMultiSessions,
} from './researchMultiLayout'

const descriptor = (
  executorId: string,
  overrides: Partial<ResearchSessionDescriptor> = {},
): ResearchSessionDescriptor => ({
  executorId,
  sessionId: executorId,
  sessionFile: null,
  nodeId: 'node-a',
  taskId: executorId,
  role: 'sister',
  label: executorId,
  workspace: 'C:/fixture',
  status: 'running',
  generation: 1,
  attempt: 1,
  startedAt: 100,
  endedAt: null,
  error: null,
  ...overrides,
})

const ids = (sessions: ResearchSessionDescriptor[]) => sessions.map(session => session.executorId)

const packedRowTotals = (spans: number[]) => {
  const totals: number[] = []
  for (const span of spans) {
    const last = totals.length - 1
    if (last < 0 || totals[last] + span > 6) totals.push(span)
    else totals[last] += span
  }
  return totals
}

describe('research mosaic layout policy', () => {
  const controllerWide = [
    [6],
    [3, 3],
    [2, 2, 2],
    [3, 3, 3, 3],
    [4, 2, 2, 2, 2],
    [2, 2, 2, 2, 2, 2],
    [6, 2, 2, 2, 2, 2, 2],
  ]
  const controllerMedium = [
    [6],
    [3, 3],
    [6, 3, 3],
    [3, 3, 3, 3],
    [6, 3, 3, 3, 3],
    [3, 3, 3, 3, 3, 3],
    [6, 3, 3, 3, 3, 3, 3],
  ]
  const memberOnlyWide = [
    [],
    [6],
    [3, 3],
    [2, 2, 2],
    [3, 3, 3, 3],
    [2, 2, 2, 3, 3],
    [2, 2, 2, 2, 2, 2],
  ]
  const memberOnlyMedium = [
    [],
    [6],
    [3, 3],
    [3, 3, 6],
    [3, 3, 3, 3],
    [3, 3, 3, 3, 6],
    [3, 3, 3, 3, 3, 3],
  ]

  it.each([
    ['wide with controller', 1100, true, controllerWide],
    ['medium with controller', 1099, true, controllerMedium],
    ['wide without controller', 1100, false, memberOnlyWide],
    ['medium without controller', 820, false, memberOnlyMedium],
  ] as const)('returns the complete 0-6 matrix for %s', (_name, width, hasController, expected) => {
    expected.forEach((spans, memberCount) => {
      const layout = getResearchMosaicLayout(width, memberCount, hasController)
      expect(layout).toEqual({
        spans,
        rowCount: packedRowTotals(spans).length,
        columns: 6,
        soloController: hasController && memberCount === 0,
      })
      expect(packedRowTotals(layout.spans)).toEqual(Array(layout.rowCount).fill(6))
    })
  })

  it.each([true, false])('uses one full-width row per real pane below 820px (controller=%s)', hasController => {
    for (let memberCount = 0; memberCount <= 6; memberCount += 1) {
      const paneCount = memberCount + (hasController ? 1 : 0)
      expect(getResearchMosaicLayout(819, memberCount, hasController)).toEqual({
        spans: Array(paneCount).fill(6),
        rowCount: paneCount,
        columns: 6,
        soloController: hasController && memberCount === 0,
      })
    }
  })

  it('computes a row cap from measured height while retaining the 264 floor and 420 multi-row ceiling', () => {
    expect(researchMosaicRowCap(900, 2, false)).toBe(420)
    expect(researchMosaicRowCap(700, 2, false)).toBe(344)
    expect(researchMosaicRowCap(500, 2, false)).toBe(264)
    expect(researchMosaicRowCap(263, 1, false)).toBe(264)
  })

  it('caps a solo controller at measured height or 720 and safely falls back for unusable measurements', () => {
    expect(researchMosaicRowCap(900, 1, true)).toBe(720)
    expect(researchMosaicRowCap(600, 1, true)).toBe(600)
    expect(researchMosaicRowCap(100, 1, true)).toBe(264)
    for (const height of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(researchMosaicRowCap(height, 2, false)).toBe(264)
      expect(researchMosaicRowCap(height, 1, true)).toBe(264)
    }
    expect(researchMosaicRowCap(600, 0, false)).toBe(264)
  })
})

describe('research multi-session selection', () => {
  it('keeps the controller first and preserves current-before-history status and recency ranking', () => {
    const sessions = [
      descriptor('history-running', { taskId: 'retry', generation: 1, isCurrent: false }),
      descriptor('done-old', { status: 'done', startedAt: 200, endedAt: 300 }),
      descriptor('ready', { status: 'ready', startedAt: 800 }),
      descriptor('failed-old', { status: 'failed', startedAt: 500, endedAt: 600 }),
      descriptor('running-old', { startedAt: 400 }),
      descriptor('failed-new', { status: 'error', startedAt: 700, endedAt: 900 }),
      descriptor('running-new', { startedAt: 1000 }),
      descriptor('controller', { role: 'last_order' }),
    ]

    expect(ids(selectResearchMultiSessions({ sessions }, 'node-a', null, []))).toEqual([
      'controller',
      'running-new',
      'running-old',
      'failed-new',
      'failed-old',
      'ready',
      'done-old',
    ])
  })

  it('lets the focused and MRU sessions replace excess ranked members without duplicates', () => {
    const sessions = [
      descriptor('controller', { role: 'last_order' }),
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id, index) => descriptor(id, { startedAt: index + 1 })),
    ]

    expect(ids(selectResearchMultiSessions({ sessions }, 'node-a', 'a', ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']))).toEqual([
      'controller', 'a', 'h', 'g', 'f', 'e', 'd',
    ])
  })

  it('isolates the selected node and keeps inferred retired attempts behind current executions', () => {
    const sessions = [
      descriptor('other-controller', { nodeId: 'node-b', role: 'last_order' }),
      descriptor('other-focused', { nodeId: 'node-b', startedAt: 5000 }),
      descriptor('retry-old', { taskId: 'retry', generation: 1, attempt: 2, startedAt: 900 }),
      descriptor('retry-current', { taskId: 'retry', generation: 2, attempt: 1, startedAt: 100 }),
      descriptor('peer', { taskId: 'peer', startedAt: 200 }),
    ]

    expect(ids(selectResearchMultiSessions({ sessions }, 'node-a', 'other-focused', []))).toEqual([
      'peer', 'retry-current', 'retry-old',
    ])
    expect(selectResearchMultiSessions({ sessions }, 'missing-node', null, [])).toEqual([])
  })
})
