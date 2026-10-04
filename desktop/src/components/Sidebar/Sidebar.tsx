import React from 'react'
import {
  SquarePen,
  GitPullRequest,
  Clock,
  Blocks,
  Search,
  Bell,
  ChevronDown,
  Folder,
  Settings,
  ArrowDownToLine,
} from 'lucide-react'
import { useSessionStore } from '../../store/useSessionStore'

export const Sidebar: React.FC = () => {
  const projects = useSessionStore((s) => s.projects)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const selectSession = useSessionStore((s) => s.selectSession)
  const newSession = useSessionStore((s) => s.newSession)

  return (
    <aside className="h-full w-full bg-surface-1 flex flex-col border-r border-border select-none text-xs font-sans">
      {/* Top App Brand / Dropdown + Search + Bell */}
      <div className="flex items-center justify-between px-3.5 h-11 border-b border-border-subtle/70">
        <button
          type="button"
          className="flex items-center gap-1 font-semibold text-text-main hover:bg-surface-2 px-1.5 py-1 rounded transition-colors cursor-pointer text-[13px]"
        >
          <span>Misaka</span>
          <ChevronDown className="w-3.5 h-3.5 text-muted" />
        </button>

        <div className="flex items-center gap-1 text-dim">
          <button
            type="button"
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-surface-2 hover:text-text-main transition-colors cursor-pointer"
            title="搜索 (Ctrl+K)"
          >
            <Search className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-surface-2 hover:text-text-main transition-colors cursor-pointer"
            title="通知中心"
          >
            <Bell className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Action Shortcuts */}
      <div className="p-2 space-y-0.5 border-b border-border-subtle/50 text-[12.5px]">
        <button
          onClick={newSession}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-text-main hover:bg-surface-2 transition-colors cursor-pointer text-left font-medium"
        >
          <SquarePen className="w-4 h-4 text-muted" />
          <span>新对话</span>
        </button>

        <button
          type="button"
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-muted hover:text-text-main hover:bg-surface-2 transition-colors cursor-pointer text-left"
        >
          <GitPullRequest className="w-4 h-4 text-muted" />
          <span>Pull Request</span>
        </button>

        <button
          type="button"
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-muted hover:text-text-main hover:bg-surface-2 transition-colors cursor-pointer text-left"
        >
          <Clock className="w-4 h-4 text-muted" />
          <span>定时任务</span>
        </button>

        <button
          type="button"
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-muted hover:text-text-main hover:bg-surface-2 transition-colors cursor-pointer text-left"
        >
          <Blocks className="w-4 h-4 text-muted" />
          <span>插件</span>
        </button>
      </div>

      {/* Scrollable Project and Session Tree List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-4">
        {/* Pinned Section */}
        <div>
          <div className="px-2.5 py-1 text-[11px] font-medium text-dim tracking-wider">
            置顶
          </div>
          <div className="space-y-0.5 mt-0.5">
            <div className="px-2.5 py-1.5 rounded-lg text-muted hover:bg-surface-2 hover:text-text-main transition-colors cursor-pointer truncate">
              了解软件教学能力
            </div>
          </div>
        </div>

        {/* Projects Section */}
        <div>
          <div className="px-2.5 py-1 text-[11px] font-medium text-dim tracking-wider">
            项目
          </div>

          <div className="space-y-2 mt-1">
            {projects.map((project) => {
              return (
                <div key={project.id} className="space-y-1">
                  {/* Project Folder Header */}
                  <div className="flex items-center gap-2 px-2.5 py-1 text-muted font-medium hover:text-text-main cursor-pointer text-[12px]">
                    <Folder className="w-3.5 h-3.5 text-dim shrink-0" />
                    <span className="truncate">{project.name}</span>
                  </div>

                  {/* Sessions under this project */}
                  {project.sessions.length > 0 && (
                    <div className="ml-2 pl-2 border-l border-border-subtle/50 space-y-0.5">
                      {project.sessions.map((session) => {
                        const isActive = session.id === currentSessionId
                        return (
                          <button
                            key={session.id}
                            onClick={() => selectSession(session.id, session.title)}
                            className={`w-full text-left px-2.5 py-1.5 rounded-lg transition-all truncate text-[12px] cursor-pointer ${
                              isActive
                                ? 'bg-surface-2 text-text-main font-medium border border-border-subtle shadow-xs'
                                : 'text-muted hover:text-text-main hover:bg-surface-2/60'
                            }`}
                            title={session.title}
                          >
                            {session.title}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Bottom Profile and Settings bar */}
      <div className="p-2 border-t border-border-subtle/70 bg-surface-1/90 flex items-center justify-between">
        <button
          type="button"
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-2 transition-colors cursor-pointer text-text-main font-medium flex-1 text-left"
        >
          <Settings className="w-3.5 h-3.5 text-muted" />
          <span className="truncate">custom</span>
        </button>

        <button
          type="button"
          className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-surface-2 text-accent transition-colors cursor-pointer"
          title="检查客户端更新"
        >
          <ArrowDownToLine className="w-3.5 h-3.5" />
        </button>
      </div>
    </aside>
  )
}
