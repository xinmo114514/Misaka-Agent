import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Copy, Loader2, RefreshCw, Tag, X } from 'lucide-react'
import type { SessionOperationKind, SessionTreePayload, TreeFilterMode } from '../../types/session'
import { nodeCopyText, nodePreview, roleBadge, selectRows, TREE_FILTER_MODES, type FlatRow } from '../../lib/sessionTree'

const ROW_HEIGHT = 34
const OVERSCAN = 8

const FILTER_LABELS: Record<TreeFilterMode, string> = {
  default: '默认',
  'no-tools': '隐藏工具',
  'user-only': '仅用户',
  'labeled-only': '仅标签',
  all: '全部',
}

export interface SessionTreePanelProps {
  payload: SessionTreePayload | null
  loading: boolean
  error: string | null
  /** An engine operation is in flight: row actions are held back, browsing is not. */
  busy: boolean
  operationKind: SessionOperationKind | null
  filterMode: TreeFilterMode
  showLabelTimestamps: boolean
  skipSummaryPrompt: boolean
  onFilterModeChange: (mode: TreeFilterMode) => void
  onToggleLabelTimestamps: () => void
  onToggleSkipSummaryPrompt: () => void
  onNavigate: (input: { targetId: string; summarize: boolean; customInstructions?: string | null }) => void
  onCancelOperation: () => void
  onRenameLabel: (targetId: string, label: string | null) => void
  onCopy: (text: string) => void
  onRefresh: () => void
  onClose: () => void
}

function formatLabelTime(value: string | null): string {
  if (!value) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return pad(parsed.getMonth() + 1) + '-' + pad(parsed.getDate()) + ' ' + pad(parsed.getHours()) + ':' + pad(parsed.getMinutes())
}

function isUserMessage(row: FlatRow): boolean {
  return row.entry?.type === 'message' && row.entry?.message?.role === 'user'
}

export const SessionTreePanel: React.FC<SessionTreePanelProps> = ({
  payload, loading, error, busy, operationKind, filterMode, showLabelTimestamps, skipSummaryPrompt,
  onFilterModeChange, onToggleLabelTimestamps, onToggleSkipSummaryPrompt, onNavigate,
  onCancelOperation, onRenameLabel, onCopy, onRefresh, onClose,
}) => {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(480)
  const [confirming, setConfirming] = useState<{ targetId: string; showCustom: boolean; custom: string } | null>(null)
  const [editingLabel, setEditingLabel] = useState<{ targetId: string; value: string } | null>(null)
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null)

  const listRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const labelInputRef = useRef<HTMLInputElement>(null)

  const rows = useMemo(
    () => selectRows(payload, { mode: filterMode, query, collapsed }),
    [payload, filterMode, query, collapsed],
  )

  // Selection survives a refresh when the entry is still there; otherwise fall back to the leaf.
  useEffect(() => {
    if (!rows.length) { setSelectedId(null); return }
    setSelectedId(current => {
      if (current && rows.some(row => row.id === current)) return current
      const leaf = rows.find(row => row.isLeaf)
      return (payload?.leafId && rows.some(row => row.id === payload.leafId)) ? payload.leafId : (leaf?.id ?? rows[0].id)
    })
  }, [rows, payload?.leafId])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const measure = () => setViewportHeight(element.clientHeight || 480)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => { if (editingLabel) labelInputRef.current?.focus() }, [editingLabel])

  const selectedIndex = rows.findIndex(row => row.id === selectedId)
  const selectedRow = selectedIndex >= 0 ? rows[selectedIndex] : null

  const scrollToId = useCallback((id: string) => {
    const element = scrollRef.current
    const index = rows.findIndex(row => row.id === id)
    if (!element || index < 0) return
    const top = index * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    if (top < element.scrollTop) element.scrollTop = top
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight
  }, [rows])

  useEffect(() => {
    if (!pendingFocusId) return
    scrollToId(pendingFocusId)
    setPendingFocusId(null)
  }, [pendingFocusId, scrollToId])

  const moveSelection = useCallback((delta: number | 'home' | 'end' | 'pageUp' | 'pageDown') => {
    if (!rows.length) return
    const index = Math.max(0, rows.findIndex(row => row.id === selectedId))
    const page = Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT) - 1)
    let next = index
    if (delta === 'home') next = 0
    else if (delta === 'end') next = rows.length - 1
    else if (delta === 'pageUp') next = index - page
    else if (delta === 'pageDown') next = index + page
    else next = index + delta
    next = Math.min(rows.length - 1, Math.max(0, next))
    const row = rows[next]
    if (!row) return
    setSelectedId(row.id)
    setPendingFocusId(row.id)
  }, [rows, selectedId, viewportHeight])

  const toggleCollapse = useCallback((row: FlatRow) => {
    if (!row.foldable) return
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(row.id)) next.delete(row.id)
      else next.add(row.id)
      return next
    })
  }, [])

  const beginActivate = useCallback((row: FlatRow) => {
    if (busy) return
    if (skipSummaryPrompt) {
      onNavigate({ targetId: row.id, summarize: true })
      return
    }
    setConfirming({ targetId: row.id, showCustom: false, custom: '' })
  }, [busy, skipSummaryPrompt, onNavigate])

  const activate = useCallback((row: FlatRow | null) => {
    if (!row) return
    if (row.isLeaf) { beginActivate(row); return }
    beginActivate(row)
  }, [beginActivate])

  const copyRow = useCallback((row: FlatRow | null) => {
    if (!row) return
    const text = nodeCopyText(row)
    if (text) onCopy(text)
  }, [onCopy])

  const cycleFilter = useCallback((step: number) => {
    const index = TREE_FILTER_MODES.indexOf(filterMode)
    const next = TREE_FILTER_MODES[(index + step + TREE_FILTER_MODES.length) % TREE_FILTER_MODES.length]
    onFilterModeChange(next)
  }, [filterMode, onFilterModeChange])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (editingLabel) return
    const key = event.key
    const handled = true
    if (key === 'ArrowDown') moveSelection(1)
    else if (key === 'ArrowUp') moveSelection(-1)
    else if (key === 'Home') moveSelection('home')
    else if (key === 'End') moveSelection('end')
    else if (key === 'PageDown') moveSelection('pageDown')
    else if (key === 'PageUp') moveSelection('pageUp')
    else if (key === '[') cycleFilter(-1)
    else if (key === ']') cycleFilter(1)
    else if (key === 'ArrowLeft') { if (selectedRow) toggleCollapse(selectedRow) }
    else if (key === 'ArrowRight') { if (selectedRow && selectedRow.collapsed) toggleCollapse(selectedRow) }
    else if (key === 'Enter') activate(selectedRow)
    else if (key === 'c') copyRow(selectedRow)
    else if (key === 'l') { if (selectedRow) setEditingLabel({ targetId: selectedRow.id, value: selectedRow.label ?? '' }) }
    else if (key === 'Escape') {
      if (confirming) setConfirming(null)
      else if (query) setQuery('')
      else onClose()
    }
    else return
    if (handled) event.preventDefault()
  }, [activate, confirming, copyRow, cycleFilter, editingLabel, moveSelection, onClose, query, selectedRow, toggleCollapse])

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN)
  const windowRows = rows.slice(first, last)

  return (
    <div data-testid="session-tree-panel" className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-text-main">会话树</div>
          <div className="text-[10.5px] text-dim">{rows.length} 条 · {busy ? (operationKind === 'compact_session' ? '压缩中' : '切换中') : '就绪'}</div>
        </div>
        <div className="flex items-center gap-1">
          {busy && (
            <button type="button" onClick={onCancelOperation}
              className="flex h-6 items-center gap-1 rounded-md border border-border-subtle px-2 text-[11px] text-muted hover:text-text-main hover:bg-surface-2">
              <X className="h-3 w-3" /><span>取消</span>
            </button>
          )}
          <button type="button" onClick={onRefresh} title="刷新会话树"
            className="flex h-6 w-6 items-center justify-center rounded-md text-dim hover:bg-surface-2 hover:text-text-main">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
          <button type="button" onClick={onClose} title="关闭会话树"
            className="flex h-6 w-6 items-center justify-center rounded-md text-dim hover:bg-surface-2 hover:text-text-main">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 border-b border-border-subtle px-3 py-2">
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="搜索节点内容…"
          aria-label="搜索会话树"
          className="w-full rounded-md border border-border-subtle bg-surface-2/60 px-2 py-1 text-[11.5px] text-text-main placeholder-dim outline-none focus:border-border-accent/60"
        />
        <div className="flex flex-wrap items-center gap-1">
          {TREE_FILTER_MODES.map(mode => (
            <button key={mode} type="button" onClick={() => onFilterModeChange(mode)} aria-pressed={filterMode === mode}
              className={'rounded-full border px-2 py-0.5 text-[10.5px] transition-colors ' + (filterMode === mode
                ? 'border-accent/60 bg-accent/15 text-text-main'
                : 'border-border-subtle text-muted hover:bg-surface-2 hover:text-text-main')}>
              {FILTER_LABELS[mode]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10.5px] text-dim">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={showLabelTimestamps} onChange={onToggleLabelTimestamps} className="accent-current" />
            <span>标签时间</span>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={skipSummaryPrompt} onChange={onToggleSkipSummaryPrompt} className="accent-current" />
            <span>切换时跳过摘要询问</span>
          </label>
        </div>
      </div>

      <div ref={scrollRef} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div className="m-3 rounded-lg border border-border-subtle bg-surface-2/60 p-3 text-[11.5px] text-muted">
            <div>{error}</div>
            <button type="button" onClick={onRefresh} className="mt-2 rounded-md border border-border-subtle px-2 py-1 text-[11px] hover:bg-surface-2 hover:text-text-main">重试</button>
          </div>
        )}
        {!error && !rows.length && (
          <div className="p-4 text-center text-[11.5px] text-dim">{loading ? '正在读取会话树…' : '没有符合当前筛选的节点'}</div>
        )}
        {!error && rows.length > 0 && (
          <div ref={listRef} role="tree" tabIndex={0} onKeyDown={handleKeyDown}
            aria-label="会话树节点"
            className="outline-none focus-visible:ring-1 focus-visible:ring-border-accent/60">
            <div style={{ height: first * ROW_HEIGHT }} />
            {windowRows.map(row => {
              const preview = nodePreview(row)
              const badge = roleBadge(row)
              const isSelected = row.id === selectedId
              const labelTime = showLabelTimestamps ? formatLabelTime(row.labelTimestamp) : ''
              return (
                <div key={row.id} role="treeitem" data-row-id={row.id} data-entry-id={row.id} aria-selected={isSelected} aria-level={row.depth + 1}
                  title={isUserMessage(row) ? '该消息会放回输入框' : preview.text}
                  onClick={() => { setSelectedId(row.id); activate(row) }}
                  style={{ height: ROW_HEIGHT, paddingLeft: 8 + row.depth * 14 }}
                  className={'group flex cursor-pointer items-center gap-1.5 pr-2 text-[11.5px] ' + (isSelected ? 'bg-surface-3 text-text-main' : 'text-muted hover:bg-surface-2')}>
                  <button type="button" tabIndex={-1}
                    onClick={event => { event.stopPropagation(); toggleCollapse(row) }}
                    className={'flex h-4 w-4 shrink-0 items-center justify-center rounded ' + (row.foldable ? 'text-dim hover:bg-surface-3 hover:text-text-main' : 'invisible')}>
                    {row.collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  </button>
                  {row.isLeaf && <span className="shrink-0 text-[10px] text-accent">●</span>}
                  {row.label && (
                    <span className="shrink-0 rounded bg-surface-2 px-1 text-[10px] text-warning">{row.label}</span>
                  )}
                  {labelTime && <span className="shrink-0 text-[10px] text-dim">{labelTime}</span>}
                  <span className={'shrink-0 rounded px-1 text-[10px] ' + (row.onActivePath ? 'bg-surface-2 text-text-main' : 'text-dim')}>{badge}</span>
                  <span className="min-w-0 flex-1 truncate">{preview.text}</span>
                  {row.truncatedBranch && <span className="shrink-0 text-[10px] text-dim">└</span>}
                  {row.hiddenCount > 0 && <span className="shrink-0 text-[10px] text-dim">+{row.hiddenCount}</span>}
                  <button type="button" tabIndex={-1} title="复制节点内容"
                    onClick={event => { event.stopPropagation(); copyRow(row) }}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-dim opacity-0 hover:bg-surface-3 hover:text-text-main group-hover:opacity-100 focus:opacity-100">
                    <Copy className="h-3 w-3" />
                  </button>
                  <button type="button" tabIndex={-1} title="编辑标签"
                    onClick={event => { event.stopPropagation(); setEditingLabel({ targetId: row.id, value: row.label ?? '' }) }}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-dim opacity-0 group-hover:opacity-100 hover:bg-surface-3 hover:text-text-main focus:opacity-100">
                    <Tag className="h-3 w-3" />
                  </button>
                </div>
              )
            })}
            <div style={{ height: Math.max(0, rows.length - last) * ROW_HEIGHT }} />
          </div>
        )}
      </div>

      {editingLabel && (
        <div className="border-t border-border-subtle px-3 py-2">
          <div className="mb-1 text-[10.5px] text-dim">标签（留空清除）</div>
          <div className="flex items-center gap-1.5">
            <input ref={labelInputRef} value={editingLabel.value} aria-label="节点标签"
              onChange={event => setEditingLabel({ ...editingLabel, value: event.target.value })}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  onRenameLabel(editingLabel.targetId, editingLabel.value.trim() || null)
                  setEditingLabel(null)
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setEditingLabel(null)
                }
              }}
              className="min-w-0 flex-1 rounded-md border border-border-subtle bg-surface-2/60 px-2 py-1 text-[11.5px] text-text-main outline-none focus:border-border-accent/60" />
            <button type="button"
              onClick={() => { onRenameLabel(editingLabel.targetId, editingLabel.value.trim() || null); setEditingLabel(null) }}
              className="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-muted hover:bg-surface-2 hover:text-text-main">保存</button>
          </div>
        </div>
      )}

      {confirming && (
        <div className="border-t border-border-subtle bg-surface-2/40 px-3 py-2 text-[11px] text-muted">
          <div className="mb-1 text-text-main">切换到此节点前要摘要当前分支吗？</div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button"
              onClick={() => { onNavigate({ targetId: confirming.targetId, summarize: false }); setConfirming(null) }}
              className="rounded-md border border-border-subtle px-2 py-1 hover:bg-surface-2 hover:text-text-main">不摘要</button>
            <button type="button"
              onClick={() => { onNavigate({ targetId: confirming.targetId, summarize: true }); setConfirming(null) }}
              className="rounded-md border border-border-subtle px-2 py-1 hover:bg-surface-2 hover:text-text-main">摘要</button>
            <button type="button"
              onClick={() => setConfirming({ ...confirming, showCustom: !confirming.showCustom })}
              className="rounded-md border border-border-subtle px-2 py-1 hover:bg-surface-2 hover:text-text-main">自定义摘要提示</button>
            <button type="button" onClick={() => setConfirming(null)}
              className="rounded-md px-2 py-1 text-dim hover:bg-surface-2 hover:text-text-main">取消</button>
          </div>
          {confirming.showCustom && (
            <div className="mt-1.5 flex items-start gap-1.5">
              <textarea value={confirming.custom} rows={2} aria-label="自定义摘要提示"
                onChange={event => setConfirming({ ...confirming, custom: event.target.value })}
                className="min-h-0 flex-1 resize-none rounded-md border border-border-subtle bg-surface-1 px-2 py-1 text-[11px] text-text-main outline-none focus:border-border-accent/60" />
              <button type="button"
                onClick={() => { onNavigate({ targetId: confirming.targetId, summarize: true, customInstructions: confirming.custom.trim() }); setConfirming(null) }}
                className="rounded-md border border-border-subtle px-2 py-1 hover:bg-surface-2 hover:text-text-main">确定</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default SessionTreePanel