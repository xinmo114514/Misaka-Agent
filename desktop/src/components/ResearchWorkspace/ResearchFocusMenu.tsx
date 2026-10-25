import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Check, ChevronRight, Folder, FolderPlus, GitBranch, Info, ListTree, MoreHorizontal, Network, RefreshCw, Settings } from 'lucide-react'
import type { ResearchGraphNode, ResearchSessionsPayload } from '../../types/research'
import { useAnchoredLayer } from '../../lib/useAnchoredLayer'
import { useDismiss } from '../../lib/useDismiss'
import { normalizeWorkspacePath, projectNameForCwd } from '../../store/useSessionStore'
import { elapsedLabel, researchStatusLabels } from './researchPresentation'
import { rootControllerId, sessionLabel } from './researchTeam'

export interface FocusChromeActions {
  currentWorkspace: string | null
  recentWorkspaces: string[]
  onSwitchWorkspace: (path: string) => void
  onOpenWorkspaceDialog: () => void
  onOpenSettings: () => void
}

export function ResearchFocusMenu({ listing, node, question, processOpen, onToggleProcess, onSelectNode, onGraph, onRefresh, chromeActions }: {
  listing?: ResearchSessionsPayload
  node?: ResearchGraphNode
  question: string
  processOpen: boolean
  onToggleProcess: () => void
  onSelectNode: (id: string) => void
  onGraph: () => void
  onRefresh: () => Promise<void>
  chromeActions?: FocusChromeActions
}) {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<'main' | 'nodes' | 'workspaces' | 'details'>('main')
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  // The caller keys this layer by run. Fence completions after that run's layer is removed.
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const anchor = useAnchoredLayer(open, trigger, 'end')
  const close = () => {
    if (layer.current?.contains(document.activeElement)) trigger.current?.focus()
    setOpen(false)
  }
  useDismiss(open, close, [root, layer], trigger)
  useEffect(() => {
    if (open && anchor) layer.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [open, anchor, page])
  const show = () => { setPage('main'); setOpen(true) }
  const choose = (action: () => void) => { close(); action() }
  const refresh = async () => {
    setRefreshing(true); setError('')
    try { await onRefresh() } catch (cause) { if (live.current) setError(`刷新失败：${cause instanceof Error ? cause.message : String(cause)}`) }
    finally { if (live.current) setRefreshing(false) }
  }
  return <div className="research-focus-menu" ref={root}>
    <button ref={trigger} type="button" className="research-focus-more" aria-label="更多研究选项" title="更多研究选项"
      aria-haspopup="dialog" aria-expanded={open} onClick={() => open ? close() : show()}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); show() } }}>
      <MoreHorizontal size={18} aria-hidden="true" />
    </button>
    {open && anchor && createPortal(<div ref={layer} role="dialog" aria-label="研究更多选项" className="research-focus-menu-layer misaka-glass-popover"
      style={{ left: anchor.left, top: anchor.top, width: anchor.width, maxHeight: Math.min(anchor.maxHeight, window.innerHeight - anchor.top - 8) }}>
      {page !== 'main' && <div className="research-focus-menu-heading"><button type="button" aria-label="返回研究选项" onClick={() => setPage('main')}><ArrowLeft size={14} aria-hidden="true" /></button><strong>{page === 'nodes' ? '当前节点' : page === 'workspaces' ? '切换工作区' : '研究详情'}</strong></div>}
      {page === 'main' && <>
        <button type="button" className="research-focus-menu-item" aria-expanded={processOpen} aria-controls={processOpen && listing ? `research-process-${listing.runId}` : undefined} onClick={() => choose(onToggleProcess)}><ListTree size={15} aria-hidden="true" /><span>研究过程</span>{processOpen && <Check size={14} aria-hidden="true" />}</button>
        <div className="research-focus-menu-separator" />
        <button type="button" className="research-focus-menu-item" disabled={!listing} onClick={() => setPage('nodes')}><GitBranch size={15} aria-hidden="true" /><span>当前节点</span><ChevronRight size={14} aria-hidden="true" /></button>
        <button type="button" className="research-focus-menu-item" onClick={() => choose(onGraph)}><Network size={15} aria-hidden="true" /><span>研究图谱</span></button>
        {chromeActions && <><div className="research-focus-menu-separator" />
          <button type="button" className="research-focus-menu-item" onClick={() => setPage('workspaces')}><Folder size={15} aria-hidden="true" /><span>切换工作区</span></button>
          <button type="button" className="research-focus-menu-item" onClick={() => choose(chromeActions.onOpenSettings)}><Settings size={15} aria-hidden="true" /><span>模型与设置</span></button></>}
        <div className="research-focus-menu-separator" />
        <button type="button" className="research-focus-menu-item research-focus-menu-detail" onClick={() => setPage('details')}><Info size={14} aria-hidden="true" /><span>研究详情</span><ChevronRight size={14} aria-hidden="true" /></button>
      </>}
      {page === 'nodes' && listing?.graph.nodes.map(item => <button key={item.id} type="button" className="research-focus-menu-item" aria-current={item.id === node?.id ? 'true' : undefined}
        onClick={() => choose(() => onSelectNode(item.id))}><GitBranch size={14} aria-hidden="true" /><span>{item.question}</span>{item.id === node?.id && <Check size={14} aria-hidden="true" />}</button>)}
      {page === 'workspaces' && chromeActions && <>
        {chromeActions.currentWorkspace && <p className="research-focus-workspace-current" title={chromeActions.currentWorkspace}>{chromeActions.currentWorkspace}</p>}
        {[...new Set(chromeActions.recentWorkspaces)].map(path => <button key={path} type="button" className="research-focus-menu-item" title={path} onClick={() => choose(() => chromeActions.onSwitchWorkspace(path))}>
          <Folder size={14} aria-hidden="true" /><span>{projectNameForCwd(path)}</span>{normalizeWorkspacePath(path) === normalizeWorkspacePath(chromeActions.currentWorkspace || '') && <Check size={14} aria-hidden="true" />}</button>)}
        <div className="research-focus-menu-separator" /><button type="button" className="research-focus-menu-item" onClick={() => choose(chromeActions.onOpenWorkspaceDialog)}><FolderPlus size={15} aria-hidden="true" /><span>打开目录…</span></button>
      </>}
      {page === 'details' && <>
        <details className="research-focus-question-disclosure"><summary>研究问题</summary><p>{question}</p></details>
        <dl className="research-focus-details"><dt>运行 ID</dt><dd>{listing?.runId || '读取中'}</dd><dt>阶段</dt><dd>{researchStatusLabels[listing?.run.phase || ''] || listing?.run.phase || '读取中'}</dd>
          {listing?.sessions.map(item => <div key={item.executorId}><dt>{sessionLabel(item, rootControllerId(listing))}</dt><dd>{researchStatusLabels[item.status] || item.status} · {elapsedLabel(item, Date.now())}</dd></div>)}</dl>
        <button type="button" className="research-focus-menu-item" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" /><span>{refreshing ? '正在刷新…' : '刷新研究状态'}</span></button>
        {error && <p role="alert" className="research-focus-menu-error">{error}</p>}
      </>}
    </div>, document.body)}
  </div>
}
