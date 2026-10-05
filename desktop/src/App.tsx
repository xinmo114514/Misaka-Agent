import React, { useEffect, useRef, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import {
  ArrowLeft,
  ArrowRight,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Network,
  MessageSquare,
  Settings as SettingsIcon,
  Pencil,
  GitFork,
  Download,
  ChevronDown,
  ChevronRight,
  Check,
  Copy,
} from 'lucide-react'
import { useTheme } from './theme/useTheme'
import { addSink, installBridge } from './lib/bridge'
import { normalizeWorkspacePath, projectNameForCwd, useSessionStore } from './store/useSessionStore'
import { useSettingsStore } from './store/useSettingsStore'
import { Sidebar } from './components/Sidebar/Sidebar'
import { Timeline } from './components/Timeline/Timeline'
import { Composer } from './components/Composer/Composer'
import { PermissionDialog } from './components/Permission/PermissionDialog'
import { ResearchGraphCanvas } from './components/ResearchGraph/ResearchGraphCanvas'
import { SettingsPage } from './components/Settings/SettingsPage'

export default function App() {
  useTheme()
  const [viewMode, setViewMode] = useState<'timeline' | 'graph' | 'settings'>('timeline')
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const currentTitle = useSessionStore((s) => s.currentTitle)
  const currentWorkspace = useSessionStore((s) => s.currentWorkspace)
  const recentWorkspaces = useSessionStore((s) => s.recentWorkspaces)
  const switchWorkspace = useSessionStore((s) => s.switchWorkspace)
  const openWorkspaceDialog = useSessionStore((s) => s.openWorkspaceDialog)
  const handleBridgeMessage = useSessionStore((s) => s.handleBridgeMessage)
  const fetchSessions = useSessionStore((s) => s.fetchSessions)
  const fetchSettingsData = useSettingsStore((s) => s.fetchInitialData)
  const handleSettingsBridgeMessage = useSettingsStore((s) => s.handleBridgeMessage)
  const setActiveSettingsSection = useSettingsStore((s) => s.setActiveSection)

  // Global keyboard shortcuts (Ctrl+K, Ctrl+,, Ctrl+N, Ctrl+B)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const isCmdOrCtrl = e.metaKey || e.ctrlKey

      // Ctrl + , : Open/Close Settings
      if (isCmdOrCtrl && e.key === ',') {
        e.preventDefault()
        setViewMode((m) => (m === 'settings' ? 'timeline' : 'settings'))
        return
      }

      // Ctrl + K : Open Settings with Search
      if (isCmdOrCtrl && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setViewMode('settings')
        setTimeout(() => {
          const searchInput = document.querySelector('input[placeholder*="搜索设置项"]') as HTMLInputElement | null
          if (searchInput) {
            searchInput.focus()
            searchInput.select()
          }
        }, 60)
        return
      }

      // Ctrl + N : New Session
      if (isCmdOrCtrl && (e.key === 'n' || e.key === 'N') && !e.shiftKey) {
        e.preventDefault()
        useSessionStore.getState().createSession()
        setViewMode('timeline')
        return
      }

      // Ctrl + B : Toggle Sidebar
      if (isCmdOrCtrl && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        setSidebarVisible((v) => !v)
        return
      }
    }

    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [])

  useEffect(() => {
    fetchSettingsData()
    fetchSessions()

    // One subscription for the whole app, fanned out by the bridge module. Each view used to
    // register its own `window.bridge.on`, which meant a reply could be answered twice.
    const stopSession = addSink(handleBridgeMessage)
    const stopSettings = addSink(handleSettingsBridgeMessage)
    const dispose = installBridge()
    return () => {
      stopSession()
      stopSettings()
      dispose()
    }
  }, [handleBridgeMessage, handleSettingsBridgeMessage, fetchSettingsData, fetchSessions])

  const currentSessionPath = useSessionStore((s) => s.currentSessionPath)
  const renameSession = useSessionStore((s) => s.renameSession)
  const forkSession = useSessionStore((s) => s.forkSession)
  const exportSession = useSessionStore((s) => s.exportSession)

  // --- View/session navigation history (back/forward) ----------------------
  const [navStack, setNavStack] = useState<
    { viewMode: 'timeline' | 'graph' | 'settings'; sessionPath: string | null }[]
  >([{ viewMode: 'timeline', sessionPath: null }])
  const [navIndex, setNavIndex] = useState(0)
  const pendingNav = useRef<{ viewMode: string; sessionPath: string | null } | null>(null)

  useEffect(() => {
    const pending = pendingNav.current
    if (pending) {
      const sessionSettled = pending.sessionPath === null || pending.sessionPath === currentSessionPath
      if (pending.viewMode === viewMode && sessionSettled) pendingNav.current = null
      return
    }
    setNavStack((stack) => {
      const current = stack[navIndex]
      if (current && current.viewMode === viewMode && current.sessionPath === currentSessionPath) return stack
      const next = [...stack.slice(0, navIndex + 1), { viewMode, sessionPath: currentSessionPath }]
      setNavIndex(next.length - 1)
      return next.slice(-50)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, currentSessionPath])

  const canGoBack = navIndex > 0
  const canGoForward = navIndex < navStack.length - 1

  const applyNav = (index: number) => {
    const target = navStack[index]
    if (!target) return
    pendingNav.current = { viewMode: target.viewMode, sessionPath: target.sessionPath }
    setNavIndex(index)
    setViewMode(target.viewMode)
    if (target.sessionPath && target.sessionPath !== currentSessionPath) {
      useSessionStore.getState().openSession(target.sessionPath)
    }
  }

  // --- "More session options" menu -----------------------------------------
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  // --- "Workspace switcher" popover ----------------------------------------
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [copiedPath, setCopiedPath] = useState(false)
  const workspaceMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!workspaceMenuOpen) return
    const close = (e: MouseEvent) => {
      if (workspaceMenuRef.current && !workspaceMenuRef.current.contains(e.target as Node)) {
        setWorkspaceMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [workspaceMenuOpen])

  const handleCopyWorkspacePath = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!currentWorkspace) return
    navigator.clipboard.writeText(currentWorkspace)
    setCopiedPath(true)
    setTimeout(() => setCopiedPath(false), 2000)
  }

  const handleRename = () => {
    setMenuOpen(false)
    if (!currentSessionPath) return
    const next = window.prompt('重命名会话', currentTitle)
    if (next && next.trim()) renameSession(currentSessionPath, next.trim())
  }
  const handleFork = () => {
    setMenuOpen(false)
    forkSession(null)
  }
  const handleExport = () => {
    setMenuOpen(false)
    if (currentSessionPath) exportSession(currentSessionPath)
  }

  const openModelSettings = () => {
    setActiveSettingsSection('models')
    setViewMode('settings')
  }

  return (
    <div className="relative flex flex-col h-screen w-screen bg-canvas text-text-main overflow-hidden select-none font-sans">
      <div className="misaka-atmosphere" aria-hidden="true" />
      {/* 1. Top Windows Frame Titlebar */}
      <header
        className="relative z-[1] flex items-center justify-between px-3 h-[38px] text-xs select-none shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {/* Left top controls: Back, Forward, Menu items */}
        <div
          className="flex items-center gap-1 text-dim"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            type="button"
            onClick={() => applyNav(navIndex - 1)}
            disabled={!canGoBack}
            className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${
              canGoBack
                ? 'hover:bg-surface-2 hover:text-text-main cursor-pointer'
                : 'opacity-40 cursor-not-allowed'
            }`}
            title="后退"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => applyNav(navIndex + 1)}
            disabled={!canGoForward}
            className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${
              canGoForward
                ? 'hover:bg-surface-2 hover:text-text-main cursor-pointer'
                : 'opacity-40 cursor-not-allowed'
            }`}
            title="前进"
          >
            <ArrowRight className="w-3.5 h-3.5" />
          </button>

          <div className="flex items-center gap-3 ml-2 text-[12px] text-muted font-normal">
            <span
              onClick={() => setViewMode('timeline')}
              className="hover:text-text-main cursor-pointer transition-colors"
            >
              文件
            </span>
            <span
              onClick={() => setViewMode('graph')}
              className="hover:text-text-main cursor-pointer transition-colors"
            >
              研究
            </span>
            <span
              onClick={() => setViewMode(viewMode === 'graph' ? 'timeline' : 'graph')}
              className="hover:text-text-main cursor-pointer transition-colors"
            >
              视图
            </span>
            <span
              onClick={openModelSettings}
              className="hover:text-text-main cursor-pointer transition-colors"
            >
              设置
            </span>
          </div>
        </div>

        {/* Center Title / Drag region */}
        <div className="flex-1 flex justify-center text-[11px] text-dim font-mono tracking-wider">
          MISAKA AGENT
        </div>

        {/* Right offset for Windows native window controls (min, max, close) */}
        <div className="w-28 shrink-0" />
      </header>

      {/* 2. Resizable Two-Panel Layout */}
      <div className="relative z-[1] flex-1 flex overflow-hidden">
        <Group orientation="horizontal" className="h-full w-full">
          {/* Left Panel: Sidebar */}
          {sidebarVisible && (
            <>
              <Panel
                id="sidebar"
                defaultSize={264}
                minSize={200}
                maxSize={400}
                groupResizeBehavior="preserve-pixel-size"
                className="h-full overflow-hidden"
              >
                <Sidebar
                  onOpenSettings={() => setViewMode('settings')}
                  isSettingsActive={viewMode === 'settings'}
                />
              </Panel>
              <Separator className="w-1.5 -mx-[2.5px] rounded-full bg-transparent hover:bg-accent/25 transition-colors cursor-col-resize select-none z-10" />
            </>
          )}

          {/* Right Panel: Active Workspace */}
          <Panel
            id="workspace"
            defaultSize={sidebarVisible ? '78%' : '100%'}
            minSize="50%"
            className="h-full flex flex-col overflow-hidden"
          >
            {viewMode === 'settings' ? (
              <SettingsPage onClose={() => setViewMode('timeline')} />
            ) : (
              <>
                {/* Top Workspace Header */}
                <div className="flex items-center justify-between px-4 h-11 select-none shrink-0">
                  {/* Task & Workspace Interactive Breadcrumb */}
                  <div className="flex items-center gap-1.5 font-medium text-text-main text-[13px] truncate min-w-0">
                    {/* Workspace Dropdown Button */}
                    <div className="relative" ref={workspaceMenuRef}>
                      <button
                        type="button"
                        onClick={() => setWorkspaceMenuOpen((v) => !v)}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-all cursor-pointer group shadow-e1 select-none ${
                          workspaceMenuOpen
                            ? 'bg-surface-3 text-text-main border border-accent/50'
                            : 'bg-surface-2 hover:bg-surface-3 text-text-main border border-border-subtle hover:border-border-accent/40'
                        }`}
                        title="点击快速切换工作区或打开新目录"
                      >
                        <Folder className="w-3.5 h-3.5 text-accent shrink-0" />
                        <span className="font-semibold text-text-main tracking-tight truncate max-w-[160px]">
                          {currentWorkspace ? projectNameForCwd(currentWorkspace) : '选择工作区'}
                        </span>
                        <ChevronDown className={`w-3 h-3 text-dim group-hover:text-text-main transition-transform ${workspaceMenuOpen ? 'rotate-180' : ''}`} />
                      </button>

                      {/* Workspace Dropdown Menu */}
                      {workspaceMenuOpen && (
                        <div className="absolute left-0 top-10 z-50 w-72 rounded-xl bg-card border border-border-subtle shadow-e3 p-1.5 text-xs select-none">
                          {/* Current workspace header info */}
                          <div className="px-2.5 py-2 border-b border-border-subtle/70 bg-surface-2/40 rounded-lg">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] uppercase font-semibold text-muted tracking-wider">
                                当前工作区
                              </span>
                              {currentWorkspace && (
                                <button
                                  type="button"
                                  onClick={handleCopyWorkspacePath}
                                  className="text-[10.5px] text-dim hover:text-accent flex items-center gap-1 cursor-pointer transition-colors"
                                  title="复制绝对路径"
                                >
                                  {copiedPath ? (
                                    <>
                                      <Check className="w-3 h-3 text-emerald-500" />
                                      <span className="text-emerald-500">已复制</span>
                                    </>
                                  ) : (
                                    <>
                                      <Copy className="w-3 h-3" />
                                      <span>复制路径</span>
                                    </>
                                  )}
                                </button>
                              )}
                            </div>
                            <div className="font-semibold text-text-main truncate text-[12.5px] mt-1">
                              {currentWorkspace ? projectNameForCwd(currentWorkspace) : '未指定工作区'}
                            </div>
                            {currentWorkspace && (
                              <div
                                className="font-mono text-[10px] text-dim/80 truncate mt-0.5"
                                title={currentWorkspace}
                              >
                                {currentWorkspace}
                              </div>
                            )}
                          </div>

                          {/* Recent workspaces switcher list */}
                          {recentWorkspaces.length > 0 && (
                            <div className="py-1 border-b border-border-subtle/70">
                              <div className="px-2 py-1 text-[10px] uppercase font-semibold text-muted tracking-wider">
                                快速切换空间
                              </div>
                              <div className="space-y-0.5 max-h-40 overflow-y-auto pr-0.5">
                                {recentWorkspaces.map((wsPath) => {
                                  const isCurrent =
                                    currentWorkspace &&
                                    normalizeWorkspacePath(wsPath) === normalizeWorkspacePath(currentWorkspace)
                                  const name = projectNameForCwd(wsPath)

                                  return (
                                    <button
                                      key={wsPath}
                                      type="button"
                                      onClick={() => {
                                        switchWorkspace(wsPath)
                                        setWorkspaceMenuOpen(false)
                                      }}
                                      className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors cursor-pointer ${
                                        isCurrent
                                          ? 'bg-surface-2 text-text-main font-semibold border border-border-subtle/70'
                                          : 'text-muted hover:text-text-main hover:bg-surface-2/60'
                                      }`}
                                      title={wsPath}
                                    >
                                      <Folder className={`w-3.5 h-3.5 shrink-0 ${isCurrent ? 'text-accent' : 'text-dim'}`} />
                                      <span className="truncate flex-1 text-[11.5px]">{name}</span>
                                      {isCurrent && <Check className="w-3.5 h-3.5 text-accent shrink-0" />}
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          )}

                          {/* Action: Open folder */}
                          <div className="pt-1">
                            <button
                              type="button"
                              onClick={() => {
                                setWorkspaceMenuOpen(false)
                                openWorkspaceDialog()
                              }}
                              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-dim hover:text-text-main hover:bg-surface-2 transition-colors cursor-pointer"
                            >
                              <FolderPlus className="w-3.5 h-3.5 text-accent shrink-0" />
                              <span className="text-[11.5px]">打开本地文件夹作为工作区...</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    <ChevronRight className="w-3.5 h-3.5 text-dim/40 shrink-0 mx-0.5" />

                    {/* Session Title & Mode Badge */}
                    <div className="flex items-center gap-1.5 min-w-0 truncate">
                      <MessageSquare className="w-3.5 h-3.5 text-dim shrink-0" />
                      <span className="truncate font-medium text-text-main text-[13px]">{currentTitle}</span>
                      {viewMode === 'graph' && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-accent/20 text-rose-lite border border-accent/40 font-mono shrink-0 ml-1">
                          DAG 拓扑
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Right Action Icons */}
                  <div className="flex items-center gap-1.5 text-dim">
                    {/* View Switcher Button (Timeline vs Research DAG) */}
                    <button
                      type="button"
                      onClick={() => setViewMode(viewMode === 'timeline' ? 'graph' : 'timeline')}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer ${
                        viewMode === 'graph'
                          ? 'bg-accent text-white shadow-sm'
                          : 'hover:bg-surface-2 text-muted hover:text-text-main border border-border-subtle'
                      }`}
                      title={viewMode === 'timeline' ? '切换到多 Agent 研究 DAG 视图' : '返回对话时间线'}
                    >
                      {viewMode === 'timeline' ? (
                        <>
                          <Network className="w-3.5 h-3.5" />
                          <span>研究 DAG</span>
                        </>
                      ) : (
                        <>
                          <MessageSquare className="w-3.5 h-3.5" />
                          <span>时间线</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={openModelSettings}
                      className="w-7 h-7 flex items-center justify-center rounded hover:bg-surface-2 hover:text-text-main transition-colors cursor-pointer"
                      title="模型与系统设置"
                    >
                      <SettingsIcon className="w-4 h-4" />
                    </button>

                    <div className="w-[1px] h-4 bg-border-subtle mx-1" />

                    <div className="relative" ref={menuRef}>
                      <button
                        type="button"
                        onClick={() => setMenuOpen((v) => !v)}
                        className={`w-7 h-7 flex items-center justify-center rounded transition-colors cursor-pointer ${
                          menuOpen ? 'bg-surface-2 text-text-main' : 'hover:bg-surface-2 hover:text-text-main'
                        }`}
                        title="更多会话选项"
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </button>

                      {menuOpen && (
                        <div className="absolute right-0 top-9 z-40 w-40 rounded-xl bg-card border border-border-subtle shadow-e3 p-1 text-xs">
                          <button
                            type="button"
                            onClick={handleRename}
                            disabled={!currentSessionPath}
                            className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-left text-muted hover:text-text-main hover:bg-surface-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                            <span>重命名会话</span>
                          </button>
                          <button
                            type="button"
                            onClick={handleFork}
                            className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-left text-muted hover:text-text-main hover:bg-surface-2 cursor-pointer"
                          >
                            <GitFork className="w-3.5 h-3.5" />
                            <span>分叉会话</span>
                          </button>
                          <button
                            type="button"
                            onClick={handleExport}
                            disabled={!currentSessionPath}
                            className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-left text-muted hover:text-text-main hover:bg-surface-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>导出为 JSONL</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Main Content Area */}
                <div className="flex-1 flex flex-col min-h-0 relative overflow-hidden">
                  {viewMode === 'graph' ? (
                    <ResearchGraphCanvas />
                  ) : (
                    <>
                      <Timeline />
                      <Composer onOpenModelSettings={openModelSettings} />
                    </>
                  )}
                </div>
              </>
            )}
          </Panel>
        </Group>
      </div>
      <PermissionDialog />
    </div>
  )
}
