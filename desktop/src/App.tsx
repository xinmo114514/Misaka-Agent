import React, { useEffect } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import {
  ArrowLeft,
  ArrowRight,
  Folder,
  MoreHorizontal,
  Columns2,
  PanelRight,
} from 'lucide-react'
import { useTheme } from './theme/useTheme'
import { useSessionStore } from './store/useSessionStore'
import { Sidebar } from './components/Sidebar/Sidebar'
import { Timeline } from './components/Timeline/Timeline'
import { Composer } from './components/Composer/Composer'

export default function App() {
  useTheme()
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
      {/* 1. Top Windows Frame Titlebar (matching user screenshot header) */}
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

        {/* Center / Drag region spacer */}
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

          {/* Right Panel: Active Workspace Timeline */}
          <Panel id="timeline" defaultSize="78%" minSize="50%" className="h-full flex flex-col overflow-hidden bg-surface-0">
            {/* Top Workspace Header matching screenshot */}
            <div className="flex items-center justify-between px-5 h-11 border-b border-border bg-surface-1/90 select-none shrink-0">
              {/* Task Title */}
              <div className="flex items-center gap-2.5 font-medium text-text-main text-[13px] truncate">
                <Folder className="w-4 h-4 text-dim shrink-0" />
                <span className="truncate">{currentTitle}</span>
              </div>

              {/* Right Action Icons */}
              <div className="flex items-center gap-1 text-dim">
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
                  title="布局分栏视图"
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

            {/* Main Chat Flow with Stick-to-bottom Timeline */}
            <div className="relative flex-1 flex flex-col overflow-hidden">
              <Timeline />
              <Composer />
            </div>
          </Panel>
        </Group>
      </div>
    </div>
  )
}
