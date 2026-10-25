import React, { useCallback, useMemo, useRef, useState } from 'react'
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowDownToLine, ChevronDown, ChevronRight, Folder, FolderPlus, Loader2,
  History, MoreHorizontal, Pencil, Plus, Search, Settings, SquarePen, Trash2, X,
} from 'lucide-react'
import { request } from '../../lib/bridge'
import { buildSidebarProjects, type SidebarProject } from '../../lib/sidebarProjects'
import type { UpdateStatus } from '../../types/research'
import type { SessionRow } from '../../types/session'
import { normalizeWorkspacePath, useSessionStore } from '../../store/useSessionStore'
import { SessionRenameDialog } from '../SessionRenameDialog'
import { useResearchRunStore } from '../../store/useResearchRunStore'
import { useResearchWorkspaceStore } from '../../store/useResearchWorkspaceStore'
import { ResearchSessionTree } from '../ResearchWorkspace/ResearchSessionTree'
import { ResearchBackgroundEntry } from './ResearchBackgroundEntry'
import { openResearchConversation } from '../../lib/startComposerResearch'
import type { ResearchSessionDescriptor } from '../../types/research'

interface SidebarProps {
  onOpenSettings?: () => void
  isSettingsActive?: boolean
}

type SidebarListRow =
  | { kind: 'section'; id: 'projects' | 'recent'; label: string }
  | { kind: 'project'; project: SidebarProject; expanded: boolean }
  | { kind: 'session'; session: SessionRow; section: 'project' | 'recent'; projectId?: string }
  | { kind: 'more'; id: string; label: string; onClick: () => void }
  | { kind: 'empty'; id: string; label: string }

function updateTooltip(status: UpdateStatus): string {
  if (status.upToDate === true) return `已是最新版本 (v${status.version ?? '?'})`
  if (typeof status.behind === 'number') return `落后 ${status.behind} 个提交 (当前 v${status.version ?? '?'})`
  if (status.reason) return `检查更新失败：${status.reason}`
  return `已检查更新 (v${status.version ?? '?'})`
}

function rowKey(row: SidebarListRow): string {
  if (row.kind === 'session') return `${row.section}:${row.projectId ?? ''}:${row.session.path}`
  if (row.kind === 'project') return `project:${row.project.id}`
  if (row.kind === 'section') return `section:${row.id}`
  if (row.kind === 'empty') return `empty:${row.id}`
  return `more:${row.id}`
}

function sessionTitle(session: { name?: string | null; firstMessage?: string }): string {
  const name = (session.name || '').trim()
  if (name) return name
  const firstMessage = (session.firstMessage || '').trim()
  if (firstMessage && firstMessage !== '(no messages)') return firstMessage.length > 60 ? `${firstMessage.slice(0, 60)}…` : firstMessage
  return '新对话'
}

export const Sidebar: React.FC<SidebarProps> = ({ onOpenSettings, isSettingsActive }) => {
  const sessions = useSessionStore(state => state.sessions)
  const currentWorkspace = useSessionStore(state => state.currentWorkspace)
  const currentSessionPath = useSessionStore(state => state.currentSessionPath)
  const recentWorkspaces = useSessionStore(state => state.recentWorkspaces)
  const openSession = useSessionStore(state => state.openSession)
  const createSession = useSessionStore(state => state.createSession)
  const openWorkspaceDialog = useSessionStore(state => state.openWorkspaceDialog)
  const requestSessionDeletion = useSessionStore(state => state.requestSessionDeletion)
  const renameSession = useSessionStore(state => state.renameSession)
  const setResearchHistoryOpen = useSessionStore(state => state.setResearchHistoryOpen)
  const researchListings = useResearchRunStore(state => state.runs)
  const focusResearchExecutor = useResearchWorkspaceStore(state => state.focusExecutor)
  const selectResearchNode = useResearchWorkspaceStore(state => state.selectNode)
  const [researchOpenError, setResearchOpenError] = useState('')
  const researchGroups = useMemo(() => Object.values(researchListings).reduce<Record<string, typeof researchListings[string][]>>((groups, listing) => {
    const key = listing.run.workspace
    ;(groups[key] ??= []).push(listing)
    return groups
  }, {}), [researchListings])
  const openResearchRun = async (runId: string, workspace: string) => {
    try {
      const state = useSessionStore.getState()
      if (state.researchBinding?.runId !== runId || state.researchPageView === 'new') {
        const host = await openResearchConversation(runId, workspace)
        state.bindResearchConversation(host)
        useSessionStore.getState().selectResearchView({ kind: 'conversation', sessionId: host.session.sessionId, ownerKey: `conversation:${host.session.sessionId}` })
        useSessionStore.getState().setAgentMode('research')
      }
    } catch (error) { setResearchOpenError(String(error)) }
  }
  const focusResearch = async (runId: string, item: ResearchSessionDescriptor) => {
    await openResearchRun(runId, item.workspace)
    focusResearchExecutor(runId, item)
  }

  const scrollRef = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({})
  const [projectLimit, setProjectLimit] = useState(5)
  const [sessionLimits, setSessionLimits] = useState<Record<string, number>>({})
  const [showAllRecent, setShowAllRecent] = useState(false)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const normalizedQuery = filter.trim().toLowerCase()

  const projects = useMemo(() => buildSidebarProjects(
    sessions,
    [currentWorkspace, ...recentWorkspaces].filter(Boolean),
  ), [sessions, currentWorkspace, recentWorkspaces])
  const sortedSessions = useMemo(() => sessions.slice().sort((a, b) => b.modified.localeCompare(a.modified)), [sessions])

  const listRows = useMemo<SidebarListRow[]>(() => {
    const rows: SidebarListRow[] = [{ kind: 'section', id: 'projects', label: '项目' }]
    const filteredProjects = projects.flatMap(project => {
      if (!normalizedQuery) return [{ project, sessions: project.sessions }]
      const matchesProject = project.name.toLowerCase().includes(normalizedQuery)
      const matchingSessions = project.sessions.filter(session => session.title.toLowerCase().includes(normalizedQuery))
      return matchesProject || matchingSessions.length
        ? [{ project, sessions: matchesProject ? project.sessions : matchingSessions }]
        : []
    })
    const visibleProjects = normalizedQuery ? filteredProjects : filteredProjects.slice(0, projectLimit)

    for (const { project, sessions: projectSessions } of visibleProjects) {
      const active = normalizeWorkspacePath(project.path) === normalizeWorkspacePath(currentWorkspace)
        || project.sessions.some(session => session.path === currentSessionPath)
      const collapsed = !normalizedQuery && (collapsedProjects[project.id] ?? !active)
      rows.push({ kind: 'project', project, expanded: !collapsed })
      if (collapsed) continue

      const limit = normalizedQuery ? projectSessions.length : (sessionLimits[project.id] ?? 5)
      for (const session of projectSessions.slice(0, limit)) {
        rows.push({ kind: 'session', session, section: 'project', projectId: project.id })
      }
      if (!normalizedQuery && projectSessions.length > limit) {
        rows.push({
          kind: 'more', id: `sessions:${project.id}`, label: '显示更多项目会话',
          onClick: () => setSessionLimits(current => ({ ...current, [project.id]: (current[project.id] ?? 5) + 5 })),
        })
      } else if (!projectSessions.length) {
        rows.push({ kind: 'empty', id: `project:${project.id}`, label: '暂无会话' })
      }
    }
    if (!normalizedQuery && filteredProjects.length > projectLimit) {
      rows.push({ kind: 'more', id: 'projects', label: '展开显示项目', onClick: () => setProjectLimit(limit => limit + 5) })
    }

    rows.push({ kind: 'section', id: 'recent', label: '最近' })
    const matchingRecent = normalizedQuery
      ? sortedSessions.filter(session => sessionTitle(session).toLowerCase().includes(normalizedQuery))
      : sortedSessions
    const recentLimit = normalizedQuery || showAllRecent ? matchingRecent.length : 10
    for (const session of matchingRecent.slice(0, recentLimit)) {
      const project = projects.find(item => normalizeWorkspacePath(item.path) === normalizeWorkspacePath(session.cwd))
      rows.push({
        kind: 'session',
        section: 'recent',
        projectId: project?.id,
        session: {
          id: session.id, path: session.path, cwd: session.cwd, title: sessionTitle(session),
          modified: session.modified, messageCount: session.messageCount,
        },
      })
    }
    if (!matchingRecent.length) {
      rows.push({ kind: 'empty', id: 'recent', label: normalizedQuery ? '没有匹配的会话' : '还没有会话' })
    } else if (!normalizedQuery && !showAllRecent && matchingRecent.length > 10) {
      rows.push({ kind: 'more', id: 'recent', label: '展开显示', onClick: () => setShowAllRecent(true) })
    } else if (!normalizedQuery && showAllRecent && matchingRecent.length > 10) {
      rows.push({ kind: 'more', id: 'recent-collapse', label: '收起', onClick: () => setShowAllRecent(false) })
    }
    return rows
  }, [projects, currentWorkspace, currentSessionPath, collapsedProjects, projectLimit, sessionLimits,
    sortedSessions, normalizedQuery, showAllRecent])

  const virtualized = listRows.length > 80
  const getItemKey = useCallback((index: number) => rowKey(listRows[index]), [listRows])
  const virtualizer = useVirtualizer({
    count: listRows.length,
    enabled: virtualized,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: index => listRows[index].kind === 'session' ? 34 : listRows[index].kind === 'section' ? 30 : 32,
    overscan: 6,
    initialRect: { width: 240, height: 560 },
    observeElementRect: (instance, callback) => observeElementRect(instance, rect => callback({ width: rect.width || 240, height: rect.height || 560 })),
    measureElement: (element, entry) => entry?.borderBoxSize?.[0]?.blockSize || element.getBoundingClientRect().height || 34,
  })

  const checkUpdate = async () => {
    setCheckingUpdate(true)
    setUpdateStatus(null)
    try {
      setUpdateStatus(await request<UpdateStatus>('check_update', {}, 60000))
    } catch (error) {
      setUpdateStatus({ version: null, kind: null, behind: null, upToDate: null,
        reason: error instanceof Error ? error.message : '检查失败' })
    } finally {
      setCheckingUpdate(false)
    }
  }

  const renameTarget = renamingPath ? projects.flatMap(project => project.sessions).find(session => session.path === renamingPath) : null

  const renderSession = (session: SessionRow, section: 'project' | 'recent', projectId?: string) => {
    const active = session.path === currentSessionPath
    return (
      <div
        key={`${section}:${projectId ?? ''}:${session.path}`}
        data-session-path={session.path}
        data-session-title={session.title}
        data-project-session={section === 'project' ? projectId : undefined}
        className={`group flex min-w-0 items-center rounded-lg transition-colors ${active ? 'bg-surface-2 text-text-main' : 'text-muted hover:bg-surface-2/70 hover:text-text-main'}`}
      >
        <button
          type="button"
          onClick={() => openSession(session.path)}
          className="min-w-0 flex-1 truncate rounded-lg px-2.5 py-1.5 text-left text-[12px] leading-5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring/70"
          title={session.title}
          aria-label={session.title}
          aria-current={active ? 'page' : undefined}
        >
          <span className="block truncate">{session.title}</span>
        </button>
        <div className="flex shrink-0 items-center gap-0.5 pr-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <button type="button" onClick={() => setRenamingPath(session.path)}
            className="rounded p-1 text-dim hover:bg-surface-3 hover:text-text-main focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring/70"
            title={`重命名会话 ${session.title}`} aria-label={`重命名会话 ${session.title}`}>
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={() => requestSessionDeletion(session.path)}
            className="rounded p-1 text-dim hover:bg-surface-3 hover:text-danger focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring/70"
            title={`删除会话 ${session.title}`} aria-label={`删除会话 ${session.title}`}>
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    )
  }

  const renderRow = (row: SidebarListRow) => {
    if (row.kind === 'section') {
      return (
        <div key={row.id} className="flex h-[30px] items-center justify-between px-2 text-[12px] font-medium text-muted">
          <span>{row.label}</span>
          {row.id === 'projects' ? (
            <button type="button" onClick={() => void openWorkspaceDialog()}
              className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-dim transition-colors hover:bg-surface-2 hover:text-text-main focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring/70"
              title="选择本地文件夹作为新项目">
              <FolderPlus className="h-3.5 w-3.5" /><span>新建项目</span>
            </button>
          ) : (
            <div className="flex items-center gap-0.5">
              <button type="button" onClick={() => createSession()}
                className="flex h-7 w-7 items-center justify-center rounded-md text-dim transition-colors hover:bg-surface-2 hover:text-text-main focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring/70"
                title="新建对话" aria-label="最近列表中新建对话">
                <Plus className="h-4 w-4" />
              </button>
              <div className="relative">
                <button type="button" onClick={() => setMoreMenuOpen(open => !open)}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-dim transition-colors hover:bg-surface-2 hover:text-text-main focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring/70"
                  title="最近列表更多选项" aria-label="最近列表更多选项" aria-expanded={moreMenuOpen}>
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                {moreMenuOpen && (
                  <div role="menu" className="misaka-glass-popover absolute right-0 top-8 z-20 w-40 rounded-lg border border-border-subtle bg-card p-1 shadow-e3">
                    <button type="button" role="menuitem"
                      onClick={() => { const next = !showSearch; setShowSearch(next); setMoreMenuOpen(false); if (!next) setFilter('') }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12px] text-muted hover:bg-surface-2 hover:text-text-main">
                      <Search className="h-3.5 w-3.5" /><span>{showSearch ? '关闭搜索' : '搜索会话'}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )
    }
    if (row.kind === 'project') {
      return (
        <button key={row.project.id} type="button"
          onClick={() => setCollapsedProjects(current => ({ ...current, [row.project.id]: row.expanded }))}
          className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[12px] text-muted transition-colors hover:bg-surface-2/70 hover:text-text-main focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring/70"
          title={row.project.path || row.project.name} aria-label={`展开项目 ${row.project.name}`} aria-expanded={row.expanded}>
          {row.expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-dim" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-dim" />}
          <Folder className="h-4 w-4 shrink-0 text-dim" /><span className="truncate">{row.project.name}</span>
        </button>
      )
    }
    if (row.kind === 'session') return renderSession(row.session, row.section, row.projectId)
    if (row.kind === 'empty') return <div key={`empty:${row.id}`} className="px-8 py-1 text-[11px] text-dim">{row.label}</div>
    return (
      <button key={`more:${row.id}`} type="button" onClick={row.onClick}
        aria-label={row.label === '显示更多项目会话' ? row.label : undefined}
        className="flex min-h-7 w-full items-center justify-center rounded-md px-2 text-[11px] text-dim transition-colors hover:bg-surface-2/70 hover:text-text-main focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring/70">
        <span>{row.label}</span>
      </button>
    )
  }

  return (
    <aside className="misaka-glass-chrome relative flex h-full w-full select-none flex-col bg-canvas text-xs font-sans">
      <div className="shrink-0 border-b border-border-subtle/70 p-2.5">
        <button type="button" onClick={() => createSession()}
          className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] font-medium text-text-main transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring/70"
          title="在当前工作区新建对话" aria-label="新聊天">
          <SquarePen className="h-4 w-4 text-muted" /><span>新聊天</span>
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2" aria-label="项目与最近会话">
        <ResearchBackgroundEntry />
        {showSearch && (
          <div className="misaka-chrome-sticky sticky top-0 z-10 pb-2 pt-0.5">
            <div className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-1 px-2.5 focus-within:border-border-accent/60">
              <Search className="h-3.5 w-3.5 shrink-0 text-dim" />
              <input autoFocus value={filter} onChange={event => setFilter(event.target.value)}
                onKeyDown={event => { if (event.key === 'Escape') { setFilter(''); setShowSearch(false) } }}
                placeholder="搜索会话" aria-label="搜索会话"
                className="h-8 min-w-0 flex-1 bg-transparent text-[12px] text-text-main outline-none placeholder:text-dim" />
              {filter && <button type="button" onClick={() => setFilter('')} aria-label="清除搜索" className="rounded p-1 text-dim hover:text-text-main"><X className="h-3.5 w-3.5" /></button>}
            </div>
          </div>
        )}
        {virtualized ? (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map(item => (
              <div key={item.key} ref={virtualizer.measureElement} data-index={item.index}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)`, paddingBottom: 1 }}>
                {renderRow(listRows[item.index])}
              </div>
            ))}
          </div>
        ) : <div className="space-y-0.5">{listRows.map(renderRow)}</div>}
        {Object.keys(researchGroups).length > 0 && <section aria-label="Sessions · Agents" className="mt-3 border-t border-border-subtle pt-2">
          <h2 className="px-2 text-[12px] font-semibold text-muted">Sessions · Agents</h2>
          {Object.entries(researchGroups).map(([workspace, runs]) => <div key={workspace} className="mt-2">
            <div className="truncate px-2 font-mono text-[10px] text-dim" title={workspace}>{workspace}</div>
            {runs.map(listing => <div key={listing.runId} className="mt-1">
              <div className="truncate px-2 text-[11px] text-muted" title={listing.run.question}>{listing.run.question} · {listing.run.status}</div>
              <ResearchSessionTree listing={listing} selectedNodeId={null}
                onSelectNode={nodeId => { void openResearchRun(listing.runId, listing.run.workspace).then(() => selectResearchNode(listing.runId, nodeId)) }}
                onFocus={item => { void focusResearch(listing.runId, item) }} />
            </div>)}
          </div>)}
          {researchOpenError && <p role="alert" className="px-2 text-danger">{researchOpenError}</p>}
        </section>}
      </div>

      {updateStatus && !checkingUpdate && (
        <div role="status" className={`mx-2 mb-1 rounded-md border px-2.5 py-1.5 text-[11px] leading-snug ${
          updateStatus.upToDate === false ? 'border-warning-border bg-warning-surface text-warning'
            : updateStatus.upToDate === true ? 'border-success-border bg-success-surface text-success'
              : 'border-border-subtle bg-surface-2 text-muted'}`}>
          {updateTooltip(updateStatus)}
        </div>
      )}
      <div className="flex shrink-0 items-center justify-between border-t border-border-subtle/70 p-2">
        <button type="button" onClick={onOpenSettings}
          className={`flex h-8 flex-1 items-center gap-2 rounded-lg px-2 text-left font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring/70 ${isSettingsActive ? 'bg-surface-2 text-accent' : 'text-text-main hover:bg-surface-2'}`}
          title="打开客户端设置">
          <Settings className={`h-4 w-4 ${isSettingsActive ? 'text-accent' : 'text-muted'}`} /><span>设置</span>
        </button>
        <button type="button" onClick={() => setResearchHistoryOpen(true)}
          className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-muted hover:text-text-main hover:bg-surface-2 transition-colors mr-1"
          title="查看研究历史记录" aria-label="研究历史">
          <History className="h-4 w-4 text-muted" />
          <span>研究历史</span>
        </button>
        <button type="button" onClick={() => void checkUpdate()} disabled={checkingUpdate}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-dim transition-colors hover:bg-surface-2 hover:text-accent disabled:opacity-50"
          title={updateStatus ? updateTooltip(updateStatus) : '检查客户端更新'} aria-label="检查客户端更新">
          {checkingUpdate ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowDownToLine className="h-3.5 w-3.5" />}
        </button>
      </div>

      <SessionRenameDialog open={Boolean(renamingPath && renameTarget)} path={renamingPath || ''}
        name={renameTarget?.title || ''} onRename={renameSession} onClose={() => setRenamingPath(null)} />
    </aside>
  )
}
