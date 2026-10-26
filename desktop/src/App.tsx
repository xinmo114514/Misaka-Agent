import { retainResearchActivity } from './lib/researchActivityStore'
import { EMPTY_RESEARCH_MESSAGES } from './lib/researchView'
import React, { useEffect, useRef, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import {
  ArrowLeft,
  ArrowRight,
  Folder,
  FolderPlus,
  MoreHorizontal,
  MessageSquare,
  Settings as SettingsIcon,
  Pencil,
  GitFork,
  Download,
  ChevronDown,
  ChevronRight,
  Check,
  Copy,
  LoaderCircle,
  X,
  ListTree,
  Archive,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'
import { useTheme } from './theme/useTheme'
import { addSink, installBridge, onEvent } from './lib/bridge'
import { addResearchSink, installResearchBridge } from './lib/researchBridge'
import { researchSessionsBridge } from './lib/researchSessionsBridge'
import { observeResearchDriving } from './lib/researchResumeObservation'
import { observeResearchStop } from './lib/researchStopObservation'
import { normalizeWorkspacePath, projectNameForCwd, useSessionStore } from './store/useSessionStore'
import { useSettingsStore } from './store/useSettingsStore'
import { clipboardErrorMessage, copyTextToClipboard } from './lib/clipboard'
import { readSidebarVisible, saveSidebarVisible } from './lib/sidebarPreference'
import { Sidebar } from './components/Sidebar/Sidebar'
import { Timeline } from './components/Timeline/Timeline'
import { Composer } from './components/Composer/Composer'
import { PermissionDialog } from './components/Permission/PermissionDialog'
import { ResearchGraphCanvas } from './components/ResearchGraph/ResearchGraphCanvas'
import { ResearchTilingWorkspace } from './components/ResearchWorkspace/ResearchTilingWorkspace'
import { ResearchTeamNavigator } from './components/ResearchWorkspace/ResearchTeamNavigator'
import { resolveMainSession, resolveResearchNodeId, rootControllerId } from './components/ResearchWorkspace/researchTeam'
import { useResearchRunStore } from './store/useResearchRunStore'
import { useResearchWorkspaceStore } from './store/useResearchWorkspaceStore'
import { readResearchViewMode, saveResearchViewMode, type ResearchViewMode } from './lib/researchViewMode'
import { ResearchTaskDrawer } from './components/Timeline/ResearchTaskDrawer'
import { ResearchGraphModal } from './components/Timeline/ResearchGraphModal'
import { ResearchHistoryDialog } from './components/Timeline/ResearchHistoryDialog'
import { SessionTreePanel } from './components/SessionTree/SessionTreePanel'
import { CompactDialog } from './components/SessionTree/CompactDialog'
import { SessionRenameDialog } from './components/SessionRenameDialog'
import { SessionDeleteDialog } from './components/SessionDeleteDialog'
import { SettingsPage } from './components/Settings/SettingsPage'
import { CloseConfirmDialog } from './components/CloseConfirmDialog'

export default function App() {
  useTheme()
  const [viewMode, setViewMode] = useState<'timeline' | 'graph' | 'settings'>('timeline')
  /** The close request the in-page dialog is answering; its id fences a late main-process reply. */
  const [closeRequest, setCloseRequest] = useState<{ closeRequestId: number } | null>(null)
  const [copyNotice, setCopyNotice] = useState<{ kind: 'pending' | 'success' | 'error'; text: string } | null>(null)
  const [exportNotice, setExportNotice] = useState<{ kind: 'pending' | 'success' | 'error'; text: string; path?: string } | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const copyFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyingRef = useRef(false)
  const [sidebarVisible, setSidebarVisible] = useState(readSidebarVisible)
  const sidebarPanelRef = useRef<PanelImperativeHandle | null>(null)
  const toggleSidebar = () => setSidebarVisible(visible => {
    const next = !visible
    saveSidebarVisible(next)
    return next
  })
  const currentTitle = useSessionStore(s => s.agentMode === 'research' ? (s.researchPageView === 'new' ? '新研究' : (s.researchBinding ? s.researchCards[s.researchBinding.runId || '']?.question || '研究对话' : '新研究')) : s.currentTitle)
  const currentWorkspace = useSessionStore((s) => s.currentWorkspace)
  const recentWorkspaces = useSessionStore((s) => s.recentWorkspaces)
  const switchWorkspace = useSessionStore((s) => s.switchWorkspace)
  const openWorkspaceDialog = useSessionStore((s) => s.openWorkspaceDialog)
  const handleBridgeMessage = useSessionStore((s) => s.handleBridgeMessage)
  const handleResearchBridgeMessage = useSessionStore(s => s.ingestResearchBridgeMessage)
  const researchTeamModelBinding = useSessionStore(s => s.researchModelBinding)
  const researchTeamSessionId = useSessionStore(s => s.researchBinding?.sessionId)
  const researchObservationRunId = useSessionStore(s => s.researchBinding?.runId)
  const researchObservationWorkspace = useSessionStore(s => s.researchBinding?.workspace)
  const researchObservationStream = useSessionStore(s => s.researchBinding?.streamId)
  const researchScene = useSessionStore(s => s.agentMode === 'research' && s.researchPageView !== 'new')
  const applyResearchModelBinding = useSettingsStore(s => s.applyResearchModelBinding)
  const fetchSessions = useSessionStore((s) => s.fetchSessions)
  const fetchSettingsData = useSettingsStore((s) => s.fetchInitialData)
  const exportCurrentSession = useSettingsStore((s) => s.exportCurrentSession)
  const handleSettingsBridgeMessage = useSettingsStore((s) => s.handleBridgeMessage)
  const setActiveSettingsSection = useSettingsStore((s) => s.setActiveSection)

  // Native window close events must reach the renderer even during a research run.
  useEffect(() => {
    return window.app?.onRequestClose?.((request) => {
      const action = useSettingsStore.getState().closeWindowAction
      if (action === 'tray' || action === 'quit') {
        // No dialog of our own, but the page is answering: say so before the main process
        // escalates to its native box.
        window.app?.reportClosePresented?.(request.closeRequestId)
        void window.app?.confirmClose?.(action)
        return
      }
      setCloseRequest(request)
    })
  }, [])

  // Only after the dialog is in the DOM -- "the page will handle it" must not be said about a
  // dialog that failed to paint.
  useEffect(() => {
    if (!closeRequest) return
    window.app?.reportClosePresented?.(closeRequest.closeRequestId)
  }, [closeRequest])

  useEffect(() => {
    if (researchScene && researchTeamSessionId && researchTeamModelBinding) {
      applyResearchModelBinding(researchTeamSessionId, researchTeamModelBinding)
    }
  }, [researchScene, researchTeamSessionId, researchTeamModelBinding, applyResearchModelBinding])

  useEffect(() => {
    const panel = sidebarPanelRef.current
    if (!panel) return
    if (sidebarVisible) panel.expand()
    else panel.collapse()
  }, [sidebarVisible])

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
        toggleSidebar()
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
    const stopResearch = addResearchSink(handleResearchBridgeMessage)
    const stopResearchSessions = researchSessionsBridge.listen()
    // The engine clamps a requested level to what the model supports and can change the
    // level on its own (a model switch, the TUI, /think). Mirror what it settled on.
    const stopThinking = onEvent('thinking_level_changed', (ev: { level?: unknown }) => {
      if (typeof ev?.level === 'string') useSettingsStore.setState({ thinkingLevel: ev.level })
    })
    const dispose = installBridge()
    const disposeResearch = installResearchBridge()
    return () => {
      stopSession()
      stopSettings()
      stopResearch()
      stopResearchSessions()
      stopThinking()
      dispose()
      disposeResearch()
    }
  }, [handleBridgeMessage, handleResearchBridgeMessage, handleSettingsBridgeMessage, fetchSettingsData, fetchSessions])

  // One board-wide refresh owner is shared by history, pills and the workbench.
  useEffect(() => retainResearchActivity(), [])
  // A resume is only accepted once the existing observation chain sees a live driver.
  useEffect(() => observeResearchDriving(), [])
  // A stop is only finished once the same chain sees the run at rest (stopped + no lease, or any terminal).
  useEffect(() => observeResearchStop(), [])
  useEffect(() => {
    if (researchObservationRunId) return researchSessionsBridge.retain(researchObservationRunId, researchObservationWorkspace)
  }, [researchObservationRunId, researchObservationWorkspace, researchObservationStream])

  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  const activeResearchTaskId = useSessionStore(s => s.activeResearchTaskId)
  const isSessionLoading = useSessionStore(s => s.isSessionLoading)
  const sessionLoadError = useSessionStore(s => s.sessionLoadError)
  const resyncModelCapability = useSettingsStore((s) => s.resyncModelCapability)

  // The live model and its thinking ladder are properties of the session, but the initial
  // fetch only ever runs once -- so a new, reopened or forked conversation would otherwise
  // keep the previous one's model in the composer pill. The first pass is skipped because
  // `fetchInitialData` above already covers it.
  const lastResyncedSession = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (isSessionLoading || sessionLoadError || activeSessionId !== currentSessionId) {
      lastResyncedSession.current = null
      resyncModelCapability() // invalidate previous-session requests without issuing new reads
      return
    }
    if (lastResyncedSession.current === undefined) {
      lastResyncedSession.current = currentSessionId
      return
    }
    if (lastResyncedSession.current === currentSessionId) return
    lastResyncedSession.current = currentSessionId
    resyncModelCapability()
  }, [currentSessionId, activeSessionId, isSessionLoading, sessionLoadError, resyncModelCapability])

  const currentSessionPath = useSessionStore((s) => s.currentSessionPath)
  const lastDeletedSessionPath = useSessionStore((s) => s.lastDeletedSessionPath)
  const renameSession = useSessionStore((s) => s.renameSession)
  const forkSession = useSessionStore((s) => s.forkSession)
  const treeOpen = useSessionStore((s) => s.treeOpen)
  const treePayload = useSessionStore((s) => s.treePayload)
  const treeLoading = useSessionStore((s) => s.treeLoading)
  const treeError = useSessionStore((s) => s.treeError)
  const treeFilterMode = useSessionStore((s) => s.treeFilterMode)
  const labelTimestampsVisible = useSessionStore((s) => s.labelTimestampsVisible)
  const skipSummaryPrompt = useSessionStore((s) => s.skipSummaryPrompt)
  const sessionOperation = useSessionStore((s) => s.sessionOperation)
  const compactOpen = useSessionStore((s) => s.compactOpen)
  const compactStatus = useSessionStore((s) => s.compactStatus)
  const compactDraft = useSessionStore((s) => s.compactDraft)
  const openTreePanel = useSessionStore((s) => s.openTreePanel)
  const closeTreePanel = useSessionStore((s) => s.closeTreePanel)
  const fetchSessionTree = useSessionStore((s) => s.fetchSessionTree)
  const setTreeFilterMode = useSessionStore((s) => s.setTreeFilterMode)
  const setLabelTimestampsVisible = useSessionStore((s) => s.setLabelTimestampsVisible)
  const toggleSkipSummaryPrompt = useSessionStore((s) => s.toggleSkipSummaryPrompt)
  const navigateTree = useSessionStore((s) => s.navigateTree)
  const setEntryLabel = useSessionStore((s) => s.setEntryLabel)
  const openCompactDialog = useSessionStore((s) => s.openCompactDialog)
  const closeCompactDialog = useSessionStore((s) => s.closeCompactDialog)
  const runCompact = useSessionStore((s) => s.runCompact)
  const cancelSessionOperation = useSessionStore((s) => s.cancelSessionOperation)

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

  useEffect(() => {
    if (!lastDeletedSessionPath) return
    const selected = navStack[navIndex]
    const retained = navStack.filter(entry => entry.sessionPath !== lastDeletedSessionPath)
    const nextStack = retained.length ? retained : [{ viewMode, sessionPath: currentSessionPath }]
    const nextIndex = selected?.sessionPath !== lastDeletedSessionPath
      ? Math.max(0, nextStack.indexOf(selected!))
      : Math.max(0, Math.min(navIndex, nextStack.length - 1))
    setNavStack(nextStack)
    setNavIndex(nextIndex)
    useSessionStore.setState({ lastDeletedSessionPath: null })
  }, [lastDeletedSessionPath, navStack, navIndex, viewMode, currentSessionPath])

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
  const [renameTarget, setRenameTarget] = useState<{ path: string; name: string } | null>(null)
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

  useEffect(() => () => {
    if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current)
  }, [])

  const handleCopyWorkspacePath = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!currentWorkspace || copyingRef.current) return
    copyingRef.current = true
    if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current)
    setCopyNotice({ kind: 'pending', text: '正在复制工作区路径…' })
    try {
      await copyTextToClipboard(currentWorkspace)
      setCopiedPath(true)
      setCopyNotice({ kind: 'success', text: '工作区路径已复制' })
      copyFeedbackTimer.current = setTimeout(() => {
        setCopiedPath(false)
        setCopyNotice(null)
        copyFeedbackTimer.current = null
      }, 2000)
    } catch (error) {
      setCopiedPath(false)
      setCopyNotice({ kind: 'error', text: `复制工作区路径失败：${clipboardErrorMessage(error)}` })
    } finally {
      copyingRef.current = false
    }
  }

  const handleRename = () => {
    setMenuOpen(false)
    if (!currentSessionPath) return
    setRenameTarget({ path: currentSessionPath, name: currentTitle })
  }
  const handleFork = () => {
    setMenuOpen(false)
    forkSession(null)
  }
  const handleExport = async () => {
    setMenuOpen(false)
    if (!currentSessionPath) {
      setExportNotice({ kind: 'error', text: '当前无活动会话可导出' })
      return
    }
    if (isExporting) return
    setIsExporting(true)
    setExportNotice({ kind: 'pending', text: '正在导出 JSONL…' })
    try {
      const result = await exportCurrentSession(currentSessionPath)
      if (result.ok && result.path) setExportNotice({ kind: 'success', text: `导出成功：${result.path}`, path: result.path })
      else setExportNotice({ kind: 'error', text: `导出失败：${result.error || '结果未确认'}` })
    } catch (error) {
      setExportNotice({ kind: 'error', text: `导出失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setIsExporting(false)
    }
  }
  const handleOpenTree = () => {
    setMenuOpen(false)
    openTreePanel()
  }
  const handleOpenCompact = () => {
    setMenuOpen(false)
    openCompactDialog(null)
  }
  const handleCopyTreeText = async (value: string) => {
    if (copyingRef.current) return
    copyingRef.current = true
    if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current)
    setCopyNotice({ kind: 'pending', text: '正在复制内容…' })
    try {
      await copyTextToClipboard(value)
      setCopyNotice({ kind: 'success', text: '内容已复制' })
      copyFeedbackTimer.current = setTimeout(() => {
        setCopyNotice(null)
        copyFeedbackTimer.current = null
      }, 2000)
    } catch (error) {
      setCopyNotice({ kind: 'error', text: `复制失败：${clipboardErrorMessage(error)}` })
    } finally {
      copyingRef.current = false
    }
  }

  const openModelSettings = () => {
    setActiveSettingsSection('models')
    setViewMode('settings')
  }

  const messages = useSessionStore(s => s.agentMode === 'research' ? (s.researchPageView === 'new' ? EMPTY_RESEARCH_MESSAGES : s.researchConversation.messages) : s.messages)
  const isStreaming = useSessionStore(s => s.agentMode === 'research' && s.researchBinding ? s.researchConversation.isStreaming : s.isStreaming)
  // A research conversation is never the empty welcome state: once its own host is bound -- or a
  // start is still being created there -- the surface belongs to that host, whose run may exist
  // while its first transcript row has not landed yet. Falling back to the welcome page hid a
  // live research conversation behind the composer.
  const researchSurface = useSessionStore(s => s.agentMode === 'research' && (Boolean(s.researchBinding) || Boolean(s.researchPendingCreationRequestId)))
  const tilingBinding = useSessionStore(s => s.agentMode === 'research' && s.researchPageView !== 'new' && s.researchBinding?.runId ? s.researchBinding : null)
  // The research layout is a page-level fact: the header pill, the workspace and the composer all
  // read the same choice, so the composer can only go compact when the tile grid is on screen.
  const researchRun = useResearchRunStore(s => tilingBinding?.runId ? s.runs[tilingBinding.runId] : undefined)
  const researchView = useResearchWorkspaceStore(s => tilingBinding?.runId ? s.byRun[tilingBinding.runId] : undefined)
  // Resolve the active run during render: a passive adoption effect exposes the old run's chrome
  // for one commit. New runs use the current preference rather than the previous run's layout.
  const researchViewMode = researchView?.viewMode ?? readResearchViewMode()
  const switchResearchViewMode = (next: ResearchViewMode) => {
    saveResearchViewMode(next)
    if (tilingBinding?.runId) useResearchWorkspaceStore.getState().setViewMode(tilingBinding.runId, next)
  }
  const researchCurrentId = researchRun ? resolveMainSession(researchRun, resolveResearchNodeId(researchRun, researchView?.selectedNodeId), researchView?.mainExecutorId)?.executorId ?? null : null
  const isWelcome = viewMode === 'timeline' && !researchSurface && messages.length === 0 && !isSessionLoading && !isStreaming && !sessionLoadError
  const isResearchWorkspace = viewMode === 'timeline' && Boolean(tilingBinding?.runId)
  // Render the existing switcher in exactly one place so its ref and menu stay shared.
  const workspaceSwitcher = (
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
        <div className="misaka-glass-popover absolute left-0 top-10 z-50 w-72 rounded-xl bg-card border border-border-subtle shadow-e3 p-1.5 text-xs select-none">
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
                  disabled={copyNotice?.kind === 'pending'}
                  className="text-[10.5px] text-dim hover:text-accent flex items-center gap-1 cursor-pointer transition-colors"
                  title="复制绝对路径"
                >
                  {copyNotice?.kind === 'pending' ? (
                    <><LoaderCircle className="w-3 h-3 animate-spin" /><span>复制中…</span></>
                  ) : copiedPath ? (
                    <>
                      <Check className="w-3 h-3 text-copy-success" />
                      <span className="text-copy-success">已复制</span>
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
  )

  return (
    <div className="relative flex flex-col h-screen w-screen bg-canvas text-text-main overflow-hidden select-none font-sans">
      <div className="misaka-atmosphere" aria-hidden="true" />
      {/* 1. Top Windows Frame Titlebar */}
      <header
        className="misaka-glass-chrome relative z-[1] flex items-center justify-between px-3 h-[38px] text-xs select-none shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {/* Left top controls: Back, Forward, Menu items */}
        <div
          className="flex items-center gap-1 text-dim"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            type="button"
            onClick={toggleSidebar}
            className="w-7 h-7 flex items-center justify-center rounded transition-colors hover:bg-surface-2 hover:text-text-main cursor-pointer"
            title={sidebarVisible ? '隐藏侧边栏' : '展开侧边栏'}
            aria-label={sidebarVisible ? '隐藏侧边栏' : '展开侧边栏'}
            aria-expanded={sidebarVisible}
            aria-controls="sidebar"
          >
            {sidebarVisible ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
          </button>
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
              onClick={() => useSessionStore.getState().setResearchHistoryOpen(true)}
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
          <Panel
            id="sidebar"
            panelRef={sidebarPanelRef}
            collapsible
            collapsedSize={0}
            defaultSize={sidebarVisible ? 264 : 0}
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
          {sidebarVisible && (
              <Separator className="w-1.5 -mx-[2.5px] rounded-full bg-transparent hover:bg-accent/25 transition-colors cursor-col-resize select-none z-10" />
          )}

          {/* Right Panel: Active Workspace */}
          <Panel
            id="workspace"
            defaultSize={sidebarVisible ? (treeOpen ? '72%' : '78%') : treeOpen ? '82%' : '100%'}
            minSize="40%"
            className="h-full flex flex-col overflow-hidden"
          >
            {viewMode === 'settings' ? (
              <SettingsPage onClose={() => setViewMode('timeline')} />
            ) : (
              <>
                {/* Background research now lives in the sidebar, where it stays reachable from
                    any session or research page instead of only above the conversation. */}
                {/* Top Workspace Header */}
                {!isResearchWorkspace && <div data-workspace-header className="misaka-glass-chrome relative z-40 flex items-center justify-between px-4 h-11 select-none shrink-0">
                  {/* Task & Workspace Interactive Breadcrumb */}
                  <div className="flex items-center gap-1.5 font-medium text-text-main text-[13px] truncate min-w-0">
                    {/* Workspace Dropdown Button */}
                    {!isWelcome && workspaceSwitcher}

                    {!isWelcome && <ChevronRight className="w-3.5 h-3.5 text-dim/40 shrink-0 mx-0.5" />}

                    {/* Session Title & Mode Badge */}
                    <div className="flex items-center gap-1.5 min-w-0 truncate">
                      <MessageSquare className="w-3.5 h-3.5 text-dim shrink-0" />
                      <span className="truncate font-medium text-text-main text-[13px]">{currentTitle}</span>
                      {viewMode === 'graph' && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-accent/20 text-rose-lite border border-accent/40 font-mono shrink-0 ml-1">
                          DAG 拓扑
                        </span>
                      )}
                      {/* The run's team, where an ordinary chat exposes its sub-agents: a count
                          that opens the directory. The transcript itself never moves in here. */}
                      {tilingBinding?.runId && researchRun && <ResearchTeamNavigator
                        listing={researchRun}
                        currentId={researchCurrentId}
                        onOpenMain={descriptor => {
                          useResearchWorkspaceStore.getState().setMainExecutor(tilingBinding!.runId!, descriptor.executorId)
                          // "Open in the main area" needs the main-area layout: the tile grid has no
                          // single reading column to put the choice in.
                          switchResearchViewMode('focus')
                        }}
                        onOpenSide={descriptor => {
                          useResearchWorkspaceStore.getState().setSideExecutor(tilingBinding!.runId!, descriptor.executorId)
                          switchResearchViewMode('focus')
                        }}
                        onReturnToMain={() => {
                          useResearchWorkspaceStore.getState().setMainExecutor(tilingBinding!.runId!, rootControllerId(researchRun))
                          useResearchWorkspaceStore.getState().setSideExecutor(tilingBinding!.runId!, null)
                        }} />}
                    </div>
                  </div>

                  {/* Right Action Icons */}
                  <div className="flex items-center gap-1.5 text-dim">
                    <button
                      type="button"
                      onClick={handleOpenTree}
                      disabled={!currentSessionId}
                      className={'w-7 h-7 flex items-center justify-center rounded transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ' + (treeOpen ? 'bg-surface-2 text-text-main' : 'hover:bg-surface-2 hover:text-text-main')}
                      title="会话树"
                    >
                      <ListTree className="w-4 h-4" />
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
                        <div className="misaka-glass-popover absolute right-0 top-9 z-40 w-40 rounded-xl bg-card border border-border-subtle shadow-e3 p-1 text-xs">
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
                            disabled={!currentSessionPath || isExporting}
                            className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-left text-muted hover:text-text-main hover:bg-surface-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>{isExporting ? '导出中…' : '导出为 JSONL'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={handleOpenTree}
                            disabled={!currentSessionId}
                            className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-left text-muted hover:text-text-main hover:bg-surface-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <ListTree className="w-3.5 h-3.5" />
                            <span>会话树</span>
                          </button>
                          <button
                            type="button"
                            onClick={handleOpenCompact}
                            disabled={!currentSessionId}
                            className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-left text-muted hover:text-text-main hover:bg-surface-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <Archive className="w-3.5 h-3.5" />
                            <span>手动压缩</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>}

                {(copyNotice || exportNotice) && <div role={(copyNotice?.kind === 'error' || exportNotice?.kind === 'error') ? 'alert' : 'status'} className={`mx-4 mb-2 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs ${(copyNotice?.kind === 'error' || exportNotice?.kind === 'error') ? 'bg-danger-surface text-danger border-danger-border' : (copyNotice?.kind === 'success' || exportNotice?.kind === 'success') ? 'bg-success-surface text-success border-success-border' : 'bg-surface-2 text-muted border-border-subtle'}`}>
                  <span className="min-w-0 truncate">{copyNotice?.text || exportNotice?.text}</span>
                  {(exportNotice?.kind === 'pending' || copyNotice?.kind === 'pending') && <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" />}
                  {exportNotice?.kind === 'success' && exportNotice.path && <button type="button" onClick={async () => {
                    if (!window.app?.showItemInFolder) {
                      setExportNotice({ kind: 'error', text: '系统文件定位功能不可用' })
                      return
                    }
                    try {
                      const result = await window.app.showItemInFolder(exportNotice.path!)
                      if (!result.ok) setExportNotice({ kind: 'error', text: `定位导出文件失败：${result.error || '系统未能定位该文件'}` })
                    } catch (error) {
                      setExportNotice({ kind: 'error', text: `定位导出文件失败：${error instanceof Error ? error.message : String(error)}` })
                    }
                  }} className="shrink-0 underline underline-offset-2">在文件夹中查看</button>}
                  {(copyNotice?.kind === 'error' || exportNotice?.kind === 'error') && <button type="button" onClick={() => { setCopyNotice(null); setExportNotice(null) }} aria-label="关闭提示" className="shrink-0"><X className="h-3.5 w-3.5" /></button>}
                </div>}

                {/* Main Content Area: conversation, with the session tree as a right column */}
                <div className="flex min-h-0 flex-1">
                  <div data-conversation-viewport data-welcome={isWelcome || undefined} data-research-workspace={tilingBinding?.runId || undefined} data-research-view-mode={tilingBinding?.runId ? researchViewMode : undefined} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                    {viewMode === 'graph' ? (
                      <ResearchGraphCanvas />
                    ) : (
                      <>
                        {tilingBinding?.runId ? <ResearchTilingWorkspace runId={tilingBinding.runId} workspace={tilingBinding.workspace}
                          mode={researchViewMode} onModeChange={switchResearchViewMode}
                          chromeActions={{ currentWorkspace, recentWorkspaces, onSwitchWorkspace: switchWorkspace,
                            onOpenWorkspaceDialog: openWorkspaceDialog, onOpenSettings: openModelSettings }} /> : <Timeline />}
                        <Composer welcome={isWelcome} presentation={tilingBinding?.runId && researchViewMode === 'multi' ? 'multi' : 'default'} workspaceControl={workspaceSwitcher} onOpenModelSettings={openModelSettings} onResearchStarted={() => setViewMode('timeline')} />
                      </>
                    )}
                  </div>
                  {activeResearchTaskId ? (
                    <ResearchTaskDrawer />
                  ) : treeOpen ? (
                    <div className="w-[340px] shrink-0 border-l border-border-subtle">
                      <SessionTreePanel
                        payload={treePayload}
                        loading={treeLoading}
                        error={treeError}
                        busy={Boolean(sessionOperation)}
                        operationKind={sessionOperation?.operation ?? null}
                        filterMode={treeFilterMode ?? 'default'}
                        showLabelTimestamps={labelTimestampsVisible}
                        skipSummaryPrompt={skipSummaryPrompt}
                        onFilterModeChange={setTreeFilterMode}
                        onToggleLabelTimestamps={() => setLabelTimestampsVisible(!labelTimestampsVisible)}
                        onToggleSkipSummaryPrompt={toggleSkipSummaryPrompt}
                        onNavigate={navigateTree}
                        onCancelOperation={cancelSessionOperation}
                        onRenameLabel={setEntryLabel}
                        onCopy={handleCopyTreeText}
                        onRefresh={fetchSessionTree}
                        onClose={closeTreePanel}
                      />
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </Panel>
        </Group>
      </div>
      <CompactDialog
        open={compactOpen}
        busy={sessionOperation?.operation === 'compact_session'}
        status={compactStatus}
        messageCount={messages.filter(message => message.role === 'user' || message.role === 'assistant').length}
        initialInstructions={compactDraft}
        onConfirm={runCompact}
        onCancelOperation={cancelSessionOperation}
        onClose={closeCompactDialog}
      />
      <SessionRenameDialog
        open={renameTarget !== null}
        path={renameTarget?.path ?? ''}
        name={renameTarget?.name ?? ''}
        onRename={renameSession}
        onClose={() => setRenameTarget(null)}
      />
      <SessionDeleteDialog />
      <PermissionDialog />
      <ResearchGraphModal />
      <ResearchHistoryDialog />
      <CloseConfirmDialog
        open={closeRequest !== null}
        onClose={() => {
          const requestId = closeRequest?.closeRequestId
          setCloseRequest(null)
          // The window close is available again: hand the decision back to the main process.
          if (requestId !== undefined) window.app?.reportCloseCancelled?.(requestId)
        }}
      />
    </div>
  )
}
