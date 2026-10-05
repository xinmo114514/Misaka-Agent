import React, { useMemo, useState } from 'react'
import {
  SquarePen,
  Search,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Layers,
  Settings,
  ArrowDownToLine,
  Trash2,
  Pencil,
  Loader2,
  Plus,
  MessageSquare,
} from 'lucide-react'
import {
  normalizeWorkspacePath,
  projectNameForCwd,
  useSessionStore,
} from '../../store/useSessionStore'
import { request } from '../../lib/bridge'
import type { SessionRow } from '../../types/session'
import type { UpdateStatus } from '../../types/research'

interface SidebarProps {
  onOpenSettings?: () => void
  isSettingsActive?: boolean
}

/** Compact relative time: "刚刚" / "5分钟前" / "3小时前" / "2天前" / a date. */
function relativeTime(iso: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = Date.now() - then
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  return new Date(then).toLocaleDateString()
}

/** Human text for an update-check result, used as the button tooltip. */
function updateTooltip(status: UpdateStatus): string {
  if (status.upToDate === true) return `已是最新版本 (v${status.version ?? '?'})`
  if (typeof status.behind === 'number') return `落后 ${status.behind} 个提交 (当前 v${status.version ?? '?'})`
  if (status.reason) return `无法检查更新：${status.reason}`
  return `已检查更新 (v${status.version ?? '?'})`
}

export const Sidebar: React.FC<SidebarProps> = ({ onOpenSettings, isSettingsActive }) => {
  const projects = useSessionStore((s) => s.projects)
  const sessions = useSessionStore((s) => s.sessions)
  const currentSessionPath = useSessionStore((s) => s.currentSessionPath)
  const currentWorkspace = useSessionStore((s) => s.currentWorkspace)
  const recentWorkspaces = useSessionStore((s) => s.recentWorkspaces)
  const sessionFilterScope = useSessionStore((s) => s.sessionFilterScope)
  const openSession = useSessionStore((s) => s.openSession)
  const createSession = useSessionStore((s) => s.createSession)
  const switchWorkspace = useSessionStore((s) => s.switchWorkspace)
  const openWorkspaceDialog = useSessionStore((s) => s.openWorkspaceDialog)
  const setSessionFilterScope = useSessionStore((s) => s.setSessionFilterScope)
  const renameSession = useSessionStore((s) => s.renameSession)
  const deleteSession = useSessionStore((s) => s.deleteSession)

  const [filter, setFilter] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)

  // App.tsx already lists sessions on mount; doing it here too asked the bridge twice for the
  // same transcript at startup, and each streamed turn re-triggers it.

  const checkUpdate = async () => {
    setCheckingUpdate(true)
    setUpdateStatus(null)
    try {
      setUpdateStatus(await request<UpdateStatus>('check_update', {}, 60000))
    } catch (error) {
      setUpdateStatus({
        version: null,
        kind: null,
        behind: null,
        upToDate: null,
        reason: error instanceof Error ? error.message : '检查失败',
      })
    } finally {
      setCheckingUpdate(false)
    }
  }

  const query = filter.trim().toLowerCase()

  const submitRename = (path: string) => {
    const next = renameDraft.trim()
    if (next) renameSession(path, next)
    setRenaming(null)
    setRenameDraft('')
  }

  // Combined workspaces list (current + recent + known projects)
  const displayedWorkspaces = useMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []

    const add = (p: string) => {
      if (!p || !p.trim()) return
      const norm = normalizeWorkspacePath(p)
      if (!seen.has(norm)) {
        seen.add(norm)
        list.push(p.trim())
      }
    }

    if (currentWorkspace) add(currentWorkspace)
    recentWorkspaces.forEach(add)
    projects.forEach((pr) => add(pr.id))

    return list
  }, [currentWorkspace, recentWorkspaces, projects])

  const sessionCountByWorkspace = useMemo(() => {
    const counts = new Map<string, number>()
    sessions.forEach((s) => {
      const norm = normalizeWorkspacePath(s.cwd)
      counts.set(norm, (counts.get(norm) || 0) + 1)
    })
    return counts
  }, [sessions])

  const currentWorkspaceSessionCount = useMemo(() => {
    if (!currentWorkspace) return 0
    return sessionCountByWorkspace.get(normalizeWorkspacePath(currentWorkspace)) || 0
  }, [currentWorkspace, sessionCountByWorkspace])

  const inactiveWorkspaces = useMemo(() => {
    const curNorm = normalizeWorkspacePath(currentWorkspace)
    return displayedWorkspaces.filter((ws) => normalizeWorkspacePath(ws) !== curNorm)
  }, [displayedWorkspaces, currentWorkspace])

  // Current workspace sessions for 'here' scope
  const hereSessions = useMemo(() => {
    const normWs = normalizeWorkspacePath(currentWorkspace)
    const matching = normWs
      ? sessions.filter((s) => normalizeWorkspacePath(s.cwd) === normWs)
      : sessions
    const rows: SessionRow[] = matching.map((s) => ({
      id: s.id,
      path: s.path,
      cwd: s.cwd,
      title: s.name || s.firstMessage || '新对话',
      modified: s.modified,
      messageCount: s.messageCount,
    }))
    return rows.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0))
  }, [sessions, currentWorkspace])

  const renderSessionItem = (session: SessionRow) => {
    const isActive = session.path === currentSessionPath
    const isRenaming = renaming === session.path

    if (isRenaming) {
      return (
        <div key={session.id} className="px-1.5 py-1">
          <input
            autoFocus
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onBlur={() => submitRename(session.path)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename(session.path)
              if (e.key === 'Escape') setRenaming(null)
            }}
            className="w-full bg-surface-2 text-text-main px-2 py-1 rounded border border-accent/70 outline-none text-[12px]"
          />
        </div>
      )
    }

    return (
      <div
        key={session.id}
        className={`group relative flex items-center gap-1 rounded-lg transition-all ${
          isActive
            ? 'bg-card text-text-main border border-border-subtle shadow-e1 border-l-[3px] border-l-accent pl-2'
            : 'text-muted hover:text-text-main hover:bg-surface-2/60 pl-2.5'
        }`}
      >
        <button
          type="button"
          onClick={() => openSession(session.path)}
          className="flex-1 min-w-0 text-left py-1.5 pr-1.5 cursor-pointer"
          title={session.title}
        >
          <div className="truncate text-[12px] font-medium leading-snug">{session.title}</div>
          <div className="text-[10.5px] text-dim mt-0.5 flex items-center gap-1.5 font-mono">
            <span>{relativeTime(session.modified)}</span>
            {session.messageCount > 0 && (
              <span className="opacity-75">· {session.messageCount} 条</span>
            )}
          </div>
        </button>

        <div className="hidden group-hover:flex items-center gap-0.5 pr-1.5 shrink-0">
          <button
            type="button"
            onClick={() => {
              setRenaming(session.path)
              setRenameDraft(session.title)
            }}
            className="p-1 rounded text-dim hover:text-text-main hover:bg-surface-3 transition-colors cursor-pointer"
            title="重命名会话"
          >
            <Pencil className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => deleteSession(session.path)}
            className="p-1 rounded text-dim hover:text-danger hover:bg-surface-3 transition-colors cursor-pointer"
            title="删除会话"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <aside className="h-full w-full flex flex-col select-none text-xs font-sans">
      {/* Top brand + search toggle */}
      <div className="flex items-center justify-between px-3 h-10 border-b border-border-subtle/70 shrink-0">
        <div className="flex items-center gap-1.5 font-semibold text-text-main text-[13px]">
          <span className="tracking-wide">MISAKA</span>
          <span className="text-[10px] text-dim font-normal px-1 py-0.2 rounded bg-surface-2 border border-border-subtle">
            Desktop
          </span>
        </div>

        <div className="flex items-center gap-1 text-dim">
          <button
            type="button"
            onClick={() => setShowSearch((v) => !v)}
            className={`w-6.5 h-6.5 flex items-center justify-center rounded transition-colors cursor-pointer ${
              showSearch ? 'bg-surface-2 text-accent' : 'hover:bg-surface-2 hover:text-text-main'
            }`}
            title="搜索会话"
          >
            <Search className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Session filter input */}
      {showSearch && (
        <div className="px-2.5 pt-2 pb-1 shrink-0">
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="过滤会话..."
            className="w-full bg-well text-text-main placeholder-dim px-2.5 py-1.5 rounded-lg border border-border-subtle outline-none focus:border-accent/80 focus:ring-1 focus:ring-focus-ring/30 text-[12px]"
          />
        </div>
      )}

      {/* Spaces (空间) 专区 */}
      <div className="p-2.5 border-b border-border-subtle/70 space-y-2 shrink-0">
        <div className="flex items-center justify-between px-1 text-[10.5px] font-semibold text-muted uppercase tracking-wider">
          <span className="flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-accent" />
            <span>空间 (Spaces)</span>
          </span>
          <button
            type="button"
            onClick={() => openWorkspaceDialog()}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-normal text-dim hover:text-text-main hover:bg-surface-2 transition-colors cursor-pointer"
            title="打开本地文件夹作为新工作区"
          >
            <FolderPlus className="w-3.5 h-3.5 text-dim hover:text-accent" />
            <span>打开</span>
          </button>
        </div>

        {/* 1. 当前活动工作区 Hero 聚焦卡片 */}
        {currentWorkspace ? (
          <div className="group relative bg-card border border-border-subtle hover:border-border-accent/50 rounded-xl p-2.5 transition-all shadow-e1 hover:shadow-e2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent/20 to-accent/5 border border-accent/25 flex items-center justify-center text-accent shrink-0 shadow-2xs">
                  <Folder className="w-3.5 h-3.5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-text-main text-[12.5px] tracking-tight truncate">
                      {projectNameForCwd(currentWorkspace)}
                    </span>
                    <span className="relative flex h-1.5 w-1.5 shrink-0" title="活动工作区">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                    </span>
                  </div>
                  <div
                    className="font-mono text-[10px] text-dim/80 truncate max-w-[150px] mt-0.5"
                    title={currentWorkspace}
                  >
                    {currentWorkspace}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <span className="text-[10px] text-dim font-mono px-1.5 py-0.5 rounded bg-surface-1/70 border border-border-subtle/50">
                  {currentWorkspaceSessionCount} 会话
                </span>
              </div>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => openWorkspaceDialog()}
            className="w-full flex items-center justify-center gap-2 p-3 rounded-xl border border-dashed border-border-subtle hover:border-accent/60 bg-surface-2/40 hover:bg-surface-2 text-dim hover:text-text-main transition-all cursor-pointer text-[12px]"
          >
            <FolderPlus className="w-4 h-4 text-accent" />
            <span>选择或打开本地工作区</span>
          </button>
        )}

        {/* 2. 最近工作区列表（Inactive Workspaces） */}
        {inactiveWorkspaces.length > 0 && (
          <div className="space-y-0.5 pt-0.5">
            <div className="flex items-center justify-between px-1 text-[10px] text-dim/80 font-medium">
              <span>最近空间</span>
              <span className="text-[10px] text-dim/70 font-mono">{inactiveWorkspaces.length}</span>
            </div>
            <div className="space-y-0.5 max-h-24 overflow-y-auto pr-0.5">
              {inactiveWorkspaces.map((wsPath) => {
                const name = projectNameForCwd(wsPath)
                const count = sessionCountByWorkspace.get(normalizeWorkspacePath(wsPath)) || 0

                return (
                  <button
                    key={wsPath}
                    type="button"
                    onClick={() => switchWorkspace(wsPath)}
                    className="w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-left transition-colors cursor-pointer group text-muted hover:bg-surface-2/60 hover:text-text-main"
                    title={`点击切换到工作区: ${wsPath}`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-dim/40 shrink-0 group-hover:bg-dim/70" />
                    <Folder className="w-3.5 h-3.5 shrink-0 text-dim group-hover:text-muted" />
                    <span className="truncate flex-1 text-[11.5px]">{name}</span>
                    {count > 0 && (
                      <span className="text-[10px] text-dim/70 shrink-0 font-mono px-1 rounded bg-surface-1/50">
                        {count}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* 3. 虚线快捷添加按钮 */}
        {currentWorkspace && (
          <button
            type="button"
            onClick={() => openWorkspaceDialog()}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg border border-dashed border-border-subtle/80 hover:border-accent/60 bg-surface-2/20 hover:bg-surface-2/50 text-dim hover:text-text-main text-[11px] transition-all cursor-pointer"
          >
            <FolderPlus className="w-3.5 h-3.5 text-dim/80" />
            <span>打开新项目文件夹...</span>
          </button>
        )}
      </div>

      {/* Sessions (会话) 专区 Header + Mode Switcher */}
      <div className="px-3 pt-2.5 pb-1 flex items-center justify-between text-[11px] text-muted font-medium shrink-0">
        <span className="uppercase tracking-wider text-[10.5px] text-muted font-semibold">
          会话 (Sessions)
        </span>
        <div className="flex items-center bg-surface-2/90 border border-border-subtle/70 p-0.5 rounded-lg text-[10.5px]">
          <button
            type="button"
            onClick={() => setSessionFilterScope('here')}
            className={`px-2 py-0.5 rounded-md cursor-pointer transition-all ${
              sessionFilterScope === 'here'
                ? 'bg-surface-1 text-text-main font-semibold shadow-xs'
                : 'text-dim hover:text-text-main'
            }`}
            title="仅展示当前活动工作区的会话"
          >
            当前空间
          </button>
          <button
            type="button"
            onClick={() => setSessionFilterScope('all')}
            className={`px-2 py-0.5 rounded-md cursor-pointer transition-all ${
              sessionFilterScope === 'all'
                ? 'bg-surface-1 text-text-main font-semibold shadow-xs'
                : 'text-dim hover:text-text-main'
            }`}
            title="展示所有工作区的历史会话"
          >
            全部
          </button>
        </div>
      </div>

      {/* Primary action: New conversation in current workspace */}
      <div className="p-2 border-b border-border-subtle/50 text-[12px] shrink-0">
        <button
          type="button"
          onClick={() => createSession()}
          className="w-full flex items-center justify-between px-2.5 py-2 rounded-xl bg-card border border-border-subtle hover:border-accent/40 text-text-main transition-all cursor-pointer group shadow-e1 hover:shadow-e2"
          title="在当前工作区发起新的研究会话"
        >
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded-md bg-accent/15 text-accent flex items-center justify-center shrink-0 group-hover:bg-accent/25 transition-colors">
              <SquarePen className="w-3.5 h-3.5" />
            </div>
            <span className="font-medium text-[12.5px]">新建对话</span>
          </div>
          {currentWorkspace && (
            <span className="text-[10px] text-dim font-mono px-1.5 py-0.5 rounded bg-surface-1/70 border border-border-subtle/50 truncate max-w-[85px]">
              {projectNameForCwd(currentWorkspace)}
            </span>
          )}
        </button>
      </div>

      {/* Sessions List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {sessionFilterScope === 'here' ? (
          /* Here mode: flat sessions for current workspace */
          <div className="space-y-0.5">
            {(() => {
              const rows = hereSessions.filter((s) =>
                query ? s.title.toLowerCase().includes(query) : true,
              )
              if (rows.length === 0) {
                return (
                  <div className="px-3 py-8 text-center flex flex-col items-center justify-center space-y-2.5">
                    <div className="w-9 h-9 rounded-full bg-surface-2 border border-border-subtle/80 flex items-center justify-center text-dim/70">
                      <MessageSquare className="w-4 h-4" />
                    </div>
                    <div className="text-dim text-[11.5px] leading-relaxed">
                      当前空间暂无会话记录
                    </div>
                    <button
                      type="button"
                      onClick={() => createSession()}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-accent hover:text-accent/90 bg-accent/10 hover:bg-accent/15 border border-accent/20 rounded-lg transition-colors cursor-pointer"
                    >
                      <Plus className="w-3 h-3" />
                      <span>开启首个研究对话</span>
                    </button>
                  </div>
                )
              }
              return rows.map((session) => renderSessionItem(session))
            })()}
          </div>
        ) : (
          /* All mode: grouped tree by workspace */
          <div className="space-y-3">
            {projects.length === 0 ? (
              <div className="px-2.5 py-6 text-center text-dim text-[11.5px] leading-relaxed">
                暂无历史会话
                <br />
                发送第一条研究指令后会自动出现在这里
              </div>
            ) : (
              projects.map((project) => {
                const rows = project.sessions.filter((s) =>
                  query ? s.title.toLowerCase().includes(query) : true,
                )
                if (rows.length === 0 && query) return null
                const isCollapsed = collapsed[project.id]

                return (
                  <div key={project.id} className="space-y-1">
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsed((c) => ({ ...c, [project.id]: !c[project.id] }))
                      }
                      className="w-full flex items-center gap-1.5 px-2 py-1 text-muted font-medium hover:text-text-main cursor-pointer text-[12px] rounded transition-colors"
                      title={project.name}
                    >
                      {isCollapsed ? (
                        <ChevronRight className="w-3.5 h-3.5 text-dim shrink-0" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5 text-dim shrink-0" />
                      )}
                      <Folder className="w-3.5 h-3.5 text-dim shrink-0" />
                      <span className="truncate">{project.name}</span>
                      <span className="ml-auto text-[10.5px] text-dim shrink-0">
                        {rows.length}
                      </span>
                    </button>

                    {!isCollapsed && (
                      <div className="ml-3 pl-2 border-l border-border-subtle/50 space-y-0.5">
                        {rows.map((session) => renderSessionItem(session))}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>

      {/* Update result banner */}
      {updateStatus && !checkingUpdate && (
        <div
          onClick={() => setUpdateStatus(null)}
          className={`mx-2 mb-1 px-2.5 py-1.5 rounded-lg text-[11px] leading-snug cursor-pointer border ${
            updateStatus.upToDate === false
              ? 'bg-warning-surface text-warning border-warning-border'
              : updateStatus.upToDate === true
              ? 'bg-success-surface text-success border-success-border'
              : 'bg-surface-2 text-muted border-border-subtle'
          }`}
          title="点击关闭"
        >
          {updateTooltip(updateStatus)}
        </div>
      )}

      {/* Bottom: settings entry */}
      <div className="p-2 border-t border-border-subtle/70 flex items-center justify-between shrink-0">
        <button
          type="button"
          onClick={onOpenSettings}
          className={`flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors cursor-pointer font-medium flex-1 text-left ${
            isSettingsActive
              ? 'bg-surface-2 text-accent'
              : 'text-text-main hover:bg-surface-2'
          }`}
          title="打开客户端设置"
        >
          <Settings className={`w-4 h-4 ${isSettingsActive ? 'text-accent' : 'text-muted'}`} />
          <span className="truncate">设置</span>
        </button>

        <button
          type="button"
          onClick={checkUpdate}
          disabled={checkingUpdate}
          className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-surface-2 text-dim hover:text-accent transition-colors cursor-pointer disabled:opacity-50"
          title={updateStatus ? updateTooltip(updateStatus) : '检查客户端更新'}
        >
          {checkingUpdate ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <ArrowDownToLine className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </aside>
  )
}
