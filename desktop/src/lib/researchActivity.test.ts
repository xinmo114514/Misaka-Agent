import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createResearchActivity } from './researchActivity'
import type { ResearchRunDetail, ResearchRunSummary } from '../types/research'

const run = (id = 'r1', status = 'active'): ResearchRunSummary => ({
  id, status, phase: 'executing', question: id, workspace: 'C:/work', nodes: 1, tasks: 2,
})
const detail = (id = 'r1', status = 'active'): ResearchRunDetail => ({
  run: run(id, status), graph: { run: id, question: id, status, phase: 'executing', nodes: [] },
})
function fixture() {
  const options = {
    fetchActive: vi.fn(async () => [run()]),
    fetchRuns: vi.fn(async () => [run()]),
    fetchDetail: vi.fn(async (id: string) => detail(id)),
    applyRuns: vi.fn(), applyDetail: vi.fn(), onError: vi.fn(), onSync: vi.fn(),
  }
  return { options, activity: createResearchActivity(options) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

it('coalesces simultaneous refreshes and polls board-wide activity only once per tick', async () => {
  const { activity, options } = fixture()
  let finish!: (value: ResearchRunSummary[]) => void
  options.fetchActive.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  activity.start()
  const one = activity.refresh(), two = activity.refresh()
  expect(options.fetchActive).toHaveBeenCalledTimes(1)
  finish([run()])
  await Promise.all([one, two])
  await vi.advanceTimersByTimeAsync(4000)
  expect(options.fetchActive).toHaveBeenCalledTimes(2)
  activity.stop()
})

it('shares history list polling across subscribers and stops it when the last one leaves', async () => {
  const { activity, options } = fixture()
  const leaveOne = activity.subscribeHistory(), leaveTwo = activity.subscribeHistory()
  activity.start()
  await activity.refresh()
  expect(options.fetchRuns).toHaveBeenCalledTimes(1)
  leaveOne()
  await vi.advanceTimersByTimeAsync(4000)
  expect(options.fetchRuns).toHaveBeenCalledTimes(2)
  leaveTwo()
  await vi.advanceTimersByTimeAsync(4000)
  expect(options.fetchRuns).toHaveBeenCalledTimes(2)
  activity.stop()
})

it('deduplicates detail subscriptions and confirms terminal state when a live run disappears', async () => {
  const { activity, options } = fixture()
  const one = activity.watchRun('r1', 'C:/work'), two = activity.watchRun('r1', 'C:/work')
  activity.start()
  await activity.refresh()
  expect(options.fetchDetail).toHaveBeenCalledTimes(1)
  one(); two()
  options.fetchActive.mockResolvedValueOnce([])
  options.fetchDetail.mockResolvedValueOnce(detail('r1', 'failed'))
  await vi.advanceTimersByTimeAsync(4000)
  expect(options.fetchDetail).toHaveBeenCalledTimes(2)
  expect(options.applyDetail).toHaveBeenLastCalledWith(detail('r1', 'failed'))
  options.fetchActive.mockResolvedValue([])
  await vi.advanceTimersByTimeAsync(4000)
  expect(options.fetchDetail).toHaveBeenCalledTimes(2)
  activity.stop()
})

it.each([true, undefined])('keeps observing a disappeared stopped run until its lease is released (driving=%s)', async driving => {
  const { activity, options } = fixture()
  activity.start(); await activity.refresh()
  options.fetchActive.mockResolvedValue([])
  options.fetchDetail.mockResolvedValueOnce({ ...detail('r1', 'stopped'), run: { ...run('r1', 'stopped'), driving } })
  await vi.advanceTimersByTimeAsync(4000)
  expect(options.fetchDetail).toHaveBeenCalledTimes(1)
  const released = { ...detail('r1', 'stopped'), run: { ...run('r1', 'stopped'), driving: false } }
  options.fetchDetail.mockResolvedValue(released)
  await vi.advanceTimersByTimeAsync(4000)
  expect(options.fetchDetail).toHaveBeenCalledTimes(2)
  expect(options.applyDetail).toHaveBeenLastCalledWith(released)
  await vi.advanceTimersByTimeAsync(4000)
  expect(options.fetchDetail).toHaveBeenCalledTimes(2)
  activity.stop()
})

it('does not infer completion or erase activity after a failed board query', async () => {
  const { activity, options } = fixture()
  activity.start(); await activity.refresh()
  options.fetchActive.mockRejectedValueOnce(new Error('bridge disconnected'))
  await vi.advanceTimersByTimeAsync(4000)
  expect(options.onError).toHaveBeenCalledWith('active', expect.any(Error))
  expect(options.applyRuns.mock.calls.flatMap(args => args[0])).not.toEqual([])
  expect(options.fetchDetail).not.toHaveBeenCalled()
  activity.stop()
})

it('ignores stopped coordinator responses and stale run responses after an explicit control', async () => {
  const { activity, options } = fixture()
  let finish!: (value: ResearchRunDetail) => void
  options.fetchDetail.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  activity.watchRun('r1', 'C:/work'); activity.start()
  await vi.advanceTimersByTimeAsync(0)
  activity.invalidateRun('r1')
  finish(detail('r1', 'active'))
  await activity.refresh()
  expect(options.applyDetail).not.toHaveBeenCalled()
  let finishActive!: (value: ResearchRunSummary[]) => void
  options.fetchActive.mockImplementationOnce(() => new Promise(resolve => { finishActive = resolve }))
  const before = options.applyRuns.mock.calls.length
  const pending = activity.refresh()
  activity.stop()
  finishActive([run('r2')]); await pending
  expect(options.applyRuns.mock.calls.length).toBe(before)
})

it('allows an explicit resume to publish a new active epoch instead of freezing a terminal run', async () => {
  const { activity, options } = fixture()
  activity.watchRun('r1', 'C:/work')
  options.fetchActive.mockResolvedValue([])
  options.fetchDetail.mockResolvedValueOnce(detail('r1', 'failed'))
  activity.start(); await activity.refresh()
  activity.invalidateRun('r1')
  options.fetchActive.mockResolvedValueOnce([run()])
  options.fetchDetail.mockResolvedValueOnce(detail())
  await activity.refresh()
  expect(options.applyDetail).toHaveBeenLastCalledWith(detail())
  activity.stop()
})
