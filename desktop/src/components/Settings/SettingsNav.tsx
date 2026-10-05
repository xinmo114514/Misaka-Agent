import React from 'react'
import {
  Package,
  Sliders,
  GraduationCap,
  Settings,
  Palette,
  Wrench,
  Database,
  Keyboard,
  Info,
  Search,
  X,
} from 'lucide-react'
import type { SettingsSectionId } from '../../types/settings'
import { useSettingsStore } from '../../store/useSettingsStore'

interface NavItem {
  id: SettingsSectionId
  label: string
  icon: React.ComponentType<{ className?: string }>
  badge?: string
}

interface NavGroup {
  groupTitle: string
  items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    groupTitle: '模型与智能体',
    items: [
      { id: 'models', label: '模型与供应商', icon: Package },
      { id: 'modelBehavior', label: '模型思考行为', icon: Sliders },
      { id: 'research', label: '研究规划与协作', icon: GraduationCap },
    ],
  },
  {
    groupTitle: '偏好与能力',
    items: [
      { id: 'general', label: '工作目录与通用', icon: Settings },
      { id: 'appearance', label: '外观与主题', icon: Palette },
      { id: 'tools', label: '工具与文献技能', icon: Wrench },
    ],
  },
  {
    groupTitle: '系统',
    items: [
      { id: 'data', label: '会话存储与导出', icon: Database },
      { id: 'shortcuts', label: '快捷键', icon: Keyboard },
      { id: 'about', label: '关于与诊断', icon: Info },
    ],
  },
]

export const SettingsNav: React.FC = () => {
  const activeSection = useSettingsStore((s) => s.activeSection)
  const setActiveSection = useSettingsStore((s) => s.setActiveSection)
  const searchQuery = useSettingsStore((s) => s.searchQuery)
  const setSearchQuery = useSettingsStore((s) => s.setSearchQuery)
  const providerGroups = useSettingsStore((s) => s.providerGroups)
  const customProviders = useSettingsStore((s) => s.customProviders)

  // The badge reports the desktop's own scope, not the registry's: how many of the shipped
  // brands are configured, plus any custom providers the user added.
  const visibleCount = providerGroups.length + customProviders.length
  const configuredCount =
    providerGroups.filter((group) => group.configured).length + customProviders.length
  const modelsBadge = visibleCount > 0 ? `${configuredCount}/${visibleCount}` : undefined

  return (
    <aside className="w-56 shrink-0 h-full border-r border-border-subtle/60 flex flex-col select-none text-xs">
      {/* Search Input Box matching ZCode */}
      <div className="p-3 border-b border-border-subtle/70">
        <div className="relative flex items-center">
          <Search className="w-3.5 h-3.5 absolute left-2.5 text-dim pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索设置项..."
            className="w-full bg-well text-text-main placeholder-dim pl-8 pr-7 py-1.5 rounded-lg border border-border-subtle outline-none focus:border-accent/80 focus:ring-1 focus:ring-focus-ring/30 text-[12px] transition-all"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 text-dim hover:text-text-main cursor-pointer"
              title="清空"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Nav Groups */}
      <div className="flex-1 overflow-y-auto p-2 space-y-4">
        {NAV_GROUPS.map((group) => {
          const visibleItems = group.items.filter((item) =>
            searchQuery ? item.label.toLowerCase().includes(searchQuery.toLowerCase()) : true,
          )

          if (visibleItems.length === 0) return null

          return (
            <div key={group.groupTitle} className="space-y-1">
              <div className="px-2.5 py-1 text-[11px] font-medium text-dim tracking-wider">
                {group.groupTitle}
              </div>
              <div className="space-y-0.5">
                {visibleItems.map((item) => {
                  const Icon = item.icon
                  const isActive = activeSection === item.id
                  return (
                    <button
                      key={item.id}
                      onClick={() => setActiveSection(item.id)}
                      className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left transition-colors cursor-pointer text-[12.5px] ${
                        isActive
                          ? 'bg-card text-text-main font-medium border border-border-subtle shadow-e1'
                          : 'text-muted hover:text-text-main hover:bg-surface-2/60'
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-accent' : 'text-dim'}`} />
                        <span className="truncate">{item.label}</span>
                      </div>
                      {(item.badge || (item.id === 'models' ? modelsBadge : undefined)) && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-accent/15 text-rose-lite border border-accent/30 font-medium">
                          {item.badge || (item.id === 'models' ? modelsBadge : undefined)}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
