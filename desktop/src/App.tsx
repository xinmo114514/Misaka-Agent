import React, { useEffect, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import {
  ArrowLeft,
  ArrowRight,
  Folder,
  MoreHorizontal,
  Columns2,
  PanelRight,
  Network,
  MessageSquare,
} from 'lucide-react'
import { useTheme } from './theme/useTheme'
import { useSessionStore } from './store/useSessionStore'
import { Sidebar } from './components/Sidebar/Sidebar'
import { Timeline } from './components/Timeline/Timeline'
import { Composer } from './components/Composer/Composer'
import { ResearchGraphCanvas } from './components/ResearchGraph/ResearchGraphCanvas'

export default function App() {
  useTheme()
  const [viewMode, setViewMode] = useState<'timeline' | 'graph'>('timeline')
  const currentTitle = useSessionStore((s) => s.currentTitle)
  const handleBridgeMessage = useSessionStore((s) => s.handleBridgeMessage)

  useEffect(() => {
    if (window.bridge?.on) {
      const unsub = window.bridge.on((msg) => {
        handleBridgeMessage(msg)
      })
      return unsub
    }
  }, [handleBridgeMessage])

  return (
    <div className="flex flex-col h-screen w-screen bg-surface-0 text-text-main overflow-hidden select-none font-sans">
      {/* 1. Top Windows Frame Titlebar */}
      <header
        className="flex items-center justify-between px-3 h-9 bg-surface-1 border-b border-border text-xs select-none shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {/* Left top controls: Back, Forward, Menu items */}
        <div
          className="flex items-center gap-1 text-dim"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            type="button"
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-surface-2 hover:text-text-main transition-colors cursor-pointer"
            title="后退"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-surface-2 hover:text-text-main transition-colors cursor-pointer opacity-40 cursor-not-allowed"
            title="前进"
          >
            <ArrowRight className="w-3.5 h-3.5" />
          </button>

          <div className="flex items-center gap-3 ml-2 text-[12px] text-muted font-normal">
            <span className="hover:text-text-main cursor-pointer transition-colors">文件</span>
            <span className="hover:text-text-main cursor-pointer transition-colors">编辑</span>
            <span className="hover:text-text-main cursor-pointer transition-colors">视图</span>
            <span className="hover:text-text-main cursor-pointer transition-colors">帮助</span>
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
      <div className="flex-1 flex overflow-hidden">
        <Group orientation="horizontal" className="h-full w-full">
          {/* Left Panel: Sidebar */}
          <Panel id="sidebar" defaultSize="22%" minSize="16%" maxSize="38%" className="h-full overflow-hidden">
            <Sidebar />
          </Panel>

          {/* Draggable Divider */}
          <Separator className="w-[1px] bg-border hover:bg-accent transition-colors cursor-col-resize select-none" />

          {/* Right Panel: Active Workspace */}
          <Panel id="workspace" defaultSize="78%" minSize="50%" className="h-full flex flex-col overflow-hidden bg-surface-0">
            {/* Top Workspace Header matching screenshot */}
            <div className="flex items-center justify-between px-5 h-11 border-b border-border bg-surface-1/90 select-none shrink-0">
              {/* Task Title */}
              <div className="flex items-center gap-2.5 font-medium text-text-main text-[13px] truncate">
                <Folder className="w-4 h-4 text-dim shrink-0" />
                <span className="truncate">{currentTitle}</span>
                {viewMode === 'graph' && (
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-accent/20 text-rose-lite border border-accent/40 font-mono">
                    DAG 拓扑
                  </span>
                )}
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

                <div className="w-[1px] h-4 bg-border-subtle mx-1" />

                <button
                  type="button"
                  className="w-7 h-7 flex items-center justify-center rounded hover:bg-surface-2 hover:text-text-main transition-colors cursor-pointer"
                  title="更多会话选项"
                >
                  <MoreHorizontal className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  className="w-7 h-7 flex items-center justify-center rounded hover:bg-surface-2 hover:text-text-main transition-colors cursor-pointer"
                  title="分栏视图"
                >
                  <Columns2 className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  className="w-7 h-7 flex items-center justify-center rounded hover:bg-surface-2 hover:text-text-main transition-colors cursor-pointer"
                  title="折叠辅助面板"
                >
                  <PanelRight className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Viewport Content: Timeline or Research Graph */}
            <div className="relative flex-1 flex flex-col overflow-hidden">
              {viewMode === 'timeline' ? (
                <>
                  <Timeline />
                  <Composer />
                </>
              ) : (
                <ResearchGraphCanvas />
              )}
            </div>
          </Panel>
        </Group>
      </div>
    </div>
  )
}
