import type { ResearchRunDetail, ResearchRunSummary } from '../types/research'

export const RESEARCH_ACTIVITY_INTERVAL_MS = 4000
const LIVE = new Set(['active', 'waiting_input', 'stopping'])

export interface ResearchActivityOptions {
  /** Meaningful run notices only: token deltas do not invalidate board reads. */
  getRunVersions?: () => Record<string, number>
  fetchActive: () => Promise<ResearchRunSummary[]>
  fetchRuns: () => Promise<ResearchRunSummary[]>
  fetchDetail: (runId: string, workspace?: string) => Promise<ResearchRunDetail>
  applyRuns: (runs: ResearchRunSummary[], source: 'active' | 'history') => void
  applyDetail: (detail: ResearchRunDetail) => void
  onError: (source: string, error: Error) => void
  onSync: (source: string, at: number) => void
}

/** A shared read-only refresh owner. View navigation never belongs to this service. */
export function createResearchActivity(options: ResearchActivityOptions) {
  let running = false
  let generation = 0
  let historyUsers = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let flight: Promise<void> | null = null
  const watched = new Map<string, { count: number; workspace?: string }>()
  const knownLive = new Map<string, ResearchRunSummary>()
  const controls = new Map<string, number>()

  const epoch = (id: string) => controls.get(id) ?? 0
  const asError = (value: unknown) => value instanceof Error ? value : new Error(String(value))

  async function perform(token: number) {
    const captured = new Map(controls)
    const valid = () => running && generation === token
    const current = (id: string) => epoch(id) === (captured.get(id) ?? 0)
    const detailTargets = new Map<string, string | undefined>()
    for (const [id, view] of watched) detailTargets.set(id, view.workspace)

    const active = (async () => {
      const versions = options.getRunVersions?.() ?? {}
      const unchanged = (id:string) => (options.getRunVersions?.()[id] ?? 0) === (versions[id] ?? 0)
      try {
        const rows = await options.fetchActive()
        if (!valid()) return
        const present = new Set(rows.map(row => row.id))
        for (const [id, previous] of knownLive) {
          // Disappearance is not proof of success: query the exact run once to find its result.
          if (!present.has(id)) detailTargets.set(id, previous.workspace)
        }
        const accepted = rows.filter(row => current(row.id) && unchanged(row.id))
        for (const row of accepted) knownLive.set(row.id, row)
        options.applyRuns(accepted, 'active')
        options.onSync('active', Date.now())
      } catch (error) {
        if (valid()) options.onError('active', asError(error))
      }
    })()

    const history = historyUsers > 0 ? (async () => {
      const versions = options.getRunVersions?.() ?? {}
      const unchanged = (id:string) => (options.getRunVersions?.()[id] ?? 0) === (versions[id] ?? 0)
      try {
        const rows = await options.fetchRuns()
        if (!valid()) return
        options.applyRuns(rows.filter(row => current(row.id) && unchanged(row.id)), 'history')
        options.onSync('history', Date.now())
      } catch (error) {
        if (valid()) options.onError('history', asError(error))
      }
    })() : Promise.resolve()

    await Promise.all([active, history])
    if (!valid()) return
    // Subscriptions added while discovery was in flight share this same detail round.
    for (const [id, view] of watched) detailTargets.set(id, view.workspace)
    await Promise.all([...detailTargets].map(async ([id, workspace]) => {
      const version = options.getRunVersions?.()[id] ?? 0
      const unchanged = () => (options.getRunVersions?.()[id] ?? 0) === version
      try {
        const result = await options.fetchDetail(id, workspace)
        if (!valid() || !current(id) || !unchanged()) return
        if (!result?.run || result.run.id !== id) throw new Error('研究详情身份已变化，请重新同步。')
        options.applyDetail(result)
        // `stopped` is published before the driver's finally block releases its lease.
        // Keep the exact-run read alive until that second fact is observed as well.
        if (!LIVE.has(result.run.status) && !(result.run.status === 'stopped' && result.run.driving !== false)) knownLive.delete(id)
        else knownLive.set(id, result.run)
        options.onSync(`run:${id}`, Date.now())
      } catch (error) {
        if (valid() && current(id) && unchanged()) options.onError(`run:${id}`, asError(error))
      }
    }))
  }

  function refresh(): Promise<void> {
    if (!running) return Promise.resolve()
    if (flight) return flight
    const pending = perform(generation)
    flight = pending
    void pending.finally(() => { if (flight === pending) flight = null }).catch(() => {})
    return pending
  }

  return {
    start() {
      if (running) return
      running = true
      generation += 1
      void refresh()
      timer = setInterval(() => void refresh(), RESEARCH_ACTIVITY_INTERVAL_MS)
    },
    stop() {
      running = false
      generation += 1
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      // A request may still settle, but its generation has no authority over the new service.
      flight = null
    },
    refresh,
    subscribeHistory() {
      historyUsers += 1
      let subscribed = true
      return () => { if (subscribed) { subscribed = false; historyUsers -= 1 } }
    },
    watchRun(runId: string, workspace?: string) {
      const previous = watched.get(runId)
      watched.set(runId, { count: (previous?.count ?? 0) + 1, workspace: workspace ?? previous?.workspace })
      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        const view = watched.get(runId)
        if (view && view.count > 1) watched.set(runId, { ...view, count: view.count - 1 })
        else watched.delete(runId)
      }
    },
    invalidateRun(runId: string) {
      // Explicit resume/stop supplies a new control epoch. Old read responses cannot undo it.
      controls.set(runId, epoch(runId) + 1)
    },
  }
}
