import { create } from 'zustand'
import { request } from './bridge'
import { createResearchActivity } from './researchActivity'
import { clearResearchStop } from './researchStop'
import { useResearchStopStore } from '../store/useResearchStopStore'
import { useResearchRunStore } from '../store/useResearchRunStore'
import { hydrateCardFromDetail, hydrateCardsFromRuns } from './researchCards'
import { useSessionStore } from '../store/useSessionStore'
import type { ResearchRunDetail, ResearchRunSummary } from '../types/research'

const LIVE = new Set(['active', 'waiting_input', 'stopping'])
let boardKnown = false
interface ActivityState {
  errors: Record<string, string>
  lastSuccess: Record<string, number>
  now: number
  details: Record<string, ResearchRunDetail>
  activeIds: string[]
}
export const useResearchActivityStore = create<ActivityState>(() => ({errors:{},lastSuccess:{},now:Date.now(),details:{},activeIds:[]}))

export function upsertActivityRuns(runs: ResearchRunSummary[], source: 'active' | 'history') {
  if (source === 'active') boardKnown = true
  useSessionStore.setState(state => {
    const researchCards = hydrateCardsFromRuns(state.researchCards, runs)
    const discovered = new Map(state.researchRuns.map(run => [run.id, run]))
    for (const run of runs) {
      const card = researchCards[run.id]
      discovered.set(run.id, {...run, status:card.status, phase:card.phase, last_error:card.error})
    }
    return {researchCards, researchRuns:[...discovered.values()]}
  })
  if (source === 'active') {
    // Keep a disappeared live run until its detail confirms a terminal business result.
    const cards = useSessionStore.getState().researchCards
    useResearchActivityStore.setState({activeIds:Object.values(cards).filter(card => LIVE.has(card.status)).map(card => card.runId)})
  }
  publishCloseState()
}

export function upsertActivityDetail(detail: ResearchRunDetail) {
  useSessionStore.setState(state => {
    const card = hydrateCardFromDetail(state.researchCards[detail.run.id], detail)
    const summary = {...detail.run,status:card.status,phase:card.phase,last_error:card.error}
    const runs = state.researchRuns.some(run=>run.id === detail.run.id) ? state.researchRuns.map(run=>run.id === detail.run.id ? summary : run) : [...state.researchRuns,summary]
    return {researchCards:{...state.researchCards,[card.runId]:card},researchRuns:runs}
  })
  const card = useSessionStore.getState().researchCards[detail.run.id]
  const normalized = {...detail,run:{...detail.run,status:card.status,phase:card.phase,last_error:card.error}}
  useResearchActivityStore.setState(state => ({details:{...state.details,[detail.run.id]:normalized},
    activeIds:Object.values(useSessionStore.getState().researchCards).filter(card => LIVE.has(card.status)).map(card => card.runId)}))
  publishCloseState()
}

function publishCloseState() {
  const state = useSessionStore.getState()
  const stops = useResearchStopStore.getState().byRun
  const live = Object.values(state.researchCards).filter(card => LIVE.has(card.status) || Boolean(stops[card.runId]))
  const activeIds = new Set([...live.map(card=>card.runId), ...Object.keys(stops)])
  window.app?.setResearchActive?.({...(boardKnown || activeIds.size ? {active:activeIds.size > 0,pendingCount:live.reduce((count,card)=>count + (card.pendingQuestions?.length ?? 0) + Number(card.phase === 'awaiting_approval'),0)} : {}),pendingStart:Boolean(state.researchPendingCreationRequestId)})
}

export const researchActivity = createResearchActivity({
  getRunVersions: () => Object.fromEntries(Object.values(useSessionStore.getState().researchCards).map(card=>[card.runId,card.noticeRevision ?? 0])),
  fetchActive: async () => (await request<{runs?:ResearchRunSummary[]}>('get_active_research_runs')).runs ?? [],
  fetchRuns: async () => (await request<{runs?:ResearchRunSummary[]}>('list_research_runs')).runs ?? [],
  fetchDetail: (runId,workspace) => request<ResearchRunDetail>('get_research_details',{runId,workspace}),
  applyRuns:upsertActivityRuns,
  applyDetail:upsertActivityDetail,
  onError: (source,error) => useResearchActivityStore.setState(state => ({errors:{...state.errors,[source]:error.message},now:Date.now()})),
  onSync: (source,at) => useResearchActivityStore.setState(state => {const errors={...state.errors}; delete errors[source]; return {errors,lastSuccess:{...state.lastSuccess,[source]:at},now:at}}),
})
let owners = 0
let stopStoreSync: (()=>void) | null = null
let stopAttemptSync: (()=>void) | null = null
let stopRunSync: (()=>void) | null = null
const liveWatches = new Map<string,{ release:()=>void; workspace?:string }>()
function syncLiveWatches() {
  const state=useSessionStore.getState()
  const wanted=new Map(Object.values(state.researchCards).filter(card=>LIVE.has(card.status)).map(card=>[card.runId,card.workspace]))
  for (const id of Object.keys(useResearchStopStore.getState().byRun)) {
    const owner=state.researchBinding?.runId===id ? state.researchBinding : Object.values(state.researchBindings).find(binding=>binding.runId===id)
    wanted.set(id,state.researchCards[id]?.workspace || state.researchRuns.find(run=>run.id===id)?.workspace
      || useResearchRunStore.getState().runs[id]?.run.workspace || owner?.workspace)
  }
  for (const [id,watch] of liveWatches) if (!wanted.has(id) || wanted.get(id)!==watch.workspace) {watch.release();liveWatches.delete(id)}
  for (const [id,workspace] of wanted) if (!liveWatches.has(id)) liveWatches.set(id,{release:researchActivity.watchRun(id,workspace),workspace})
  publishCloseState()
}
export function retainResearchActivity() {
  owners += 1
  if (owners === 1) {
    boardKnown=false
    syncLiveWatches()
    stopStoreSync=useSessionStore.subscribe(syncLiveWatches)
    stopAttemptSync=useResearchStopStore.subscribe(syncLiveWatches)
    stopRunSync=useResearchRunStore.subscribe(syncLiveWatches)
  }
  researchActivity.start()
  let active = true
  return () => { if (!active) return; active=false; owners -= 1; if (!owners) {researchActivity.stop();stopStoreSync?.();stopStoreSync=null;stopAttemptSync?.();stopAttemptSync=null;stopRunSync?.();stopRunSync=null;for (const watch of liveWatches.values()) watch.release();liveWatches.clear()} }
}
export function subscribeResearchHistory() {
  const unsubscribe = researchActivity.subscribeHistory()
  const release = retainResearchActivity()
  void researchActivity.refresh()
  return () => {unsubscribe();release()}
}
export function subscribeResearchRun(runId:string,workspace?:string) {
  const unsubscribe = researchActivity.watchRun(runId,workspace)
  const release = retainResearchActivity()
  void researchActivity.refresh()
  return () => {unsubscribe();release()}
}
/** Called before a control command so in-flight reads lose authority. */
export function beginResearchControl(runId:string) { researchActivity.invalidateRun(runId) }
/** Only a confirmed explicit resume opens a new epoch that may leave a terminal status. */
export function acceptResearchResume(runId:string) {
  // A confirmed resume takes the run back: a stop that was still settling (or left 结果待确认)
  // must not keep holding the lock -- the next stop click has to reach the engine again.
  clearResearchStop(runId)
  researchActivity.invalidateRun(runId)
  useSessionStore.setState(state => {
    const card=state.researchCards[runId]
    if (!card || card.status === 'done') return {}
    return {researchCards:{...state.researchCards,[runId]:{...card,status:'active',phase:'active',error:null,pendingQuestions:[],controlEpoch:(card.controlEpoch ?? 0)+1,eventSeq:undefined}}}
  })
}
