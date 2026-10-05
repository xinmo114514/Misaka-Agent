import React, { useState, useEffect, useMemo } from 'react'
import {
  Wrench,
  CheckCircle2,
  RefreshCw,
  Search,
  Code2,
  FileText,
  Terminal,
  ChevronDown,
  ChevronRight,
  Sparkles,
} from 'lucide-react'
import { useSettingsStore } from '../../../store/useSettingsStore'

const TOOL_CATEGORY_MAP: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  read: { label: '文件与文档', icon: FileText },
  write: { label: '文件与文档', icon: FileText },
  edit: { label: '文件与文档', icon: FileText },
  office: { label: '办公文档', icon: FileText },
  bash: { label: '终端执行', icon: Terminal },
  powershell: { label: '终端执行', icon: Terminal },
  grep: { label: '学术检索', icon: Search },
  find: { label: '学术检索', icon: Search },
  ls: { label: '目录浏览', icon: FileText },
}

export const ToolsSection: React.FC = () => {
  const tools = useSettingsStore((s) => s.tools)
  const slashCommands = useSettingsStore((s) => s.slashCommands)
  const isLoadingTools = useSettingsStore((s) => s.isLoadingTools)
  const fetchTools = useSettingsStore((s) => s.fetchTools)

  const [search, setSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string>('all')
  const [expandedTool, setExpandedTool] = useState<string | null>(null)

  useEffect(() => {
    fetchTools()
  }, [fetchTools])

  const categories = useMemo(() => {
    const set = new Set<string>()
    tools.forEach((t) => {
      const cat = TOOL_CATEGORY_MAP[t.name]?.label || '扩展工具'
      set.add(cat)
    })
    return ['all', ...Array.from(set)]
  }, [tools])

  const filteredTools = useMemo(() => {
    return tools.filter((tool) => {
      const matchesSearch =
        search === '' ||
        tool.name.toLowerCase().includes(search.toLowerCase()) ||
        tool.description.toLowerCase().includes(search.toLowerCase())
      const cat = TOOL_CATEGORY_MAP[tool.name]?.label || '扩展工具'
      const matchesCategory = selectedCategory === 'all' || cat === selectedCategory
      return matchesSearch && matchesCategory
    })
  }, [tools, search, selectedCategory])

  const toggleExpand = (toolName: string) => {
    setExpandedTool((prev) => (prev === toolName ? null : toolName))
  }

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="p-4 rounded-xl bg-card shadow-e1 border border-border-subtle flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-text-main flex items-center gap-2">
            <Wrench className="w-4 h-4 text-accent" />
            <span>智能体工具与文献技能链</span>
          </h2>
          <p className="text-xs text-muted mt-1 leading-relaxed">
            实时展示 Misaka Agent Python 内核注册并激活的系统核心工具与文献分析技能。所有工具支持动态参数校验与沙箱执行。
          </p>
        </div>
        <button
          type="button"
          onClick={fetchTools}
          disabled={isLoadingTools}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-text-main border border-border-subtle text-xs transition-colors cursor-pointer shrink-0 disabled:opacity-50"
          title="重新扫描内核工具链"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoadingTools ? 'animate-spin text-accent' : 'text-dim'}`} />
          <span>{isLoadingTools ? '扫描中...' : '刷新工具'}</span>
        </button>
      </div>

      {/* Controls: Search & Category Filter */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
        {/* Search */}
        <div className="relative w-full sm:w-72">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-dim pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索可用工具..."
            className="w-full bg-well text-text-main placeholder-dim pl-8 pr-3 py-1.5 rounded-lg border border-border text-xs outline-none focus:border-accent"
          />
        </div>

        {/* Category Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto pb-1 sm:pb-0">
          {categories.map((cat) => {
            const isSelected = selectedCategory === cat
            const label = cat === 'all' ? '全部 (' + tools.length + ')' : cat
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer shrink-0 ${
                  isSelected
                    ? 'bg-accent text-white shadow-xs'
                    : 'bg-surface-1 text-muted hover:text-text-main border border-border-subtle'
                }`}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Tools List */}
      <div className="rounded-xl border border-border-subtle bg-card shadow-e1 divide-y divide-border-subtle overflow-hidden">
        {isLoadingTools && tools.length === 0 ? (
          <div className="p-8 text-center text-xs text-muted">
            <RefreshCw className="w-5 h-5 mx-auto mb-2 text-accent animate-spin" />
            <span>正在连接 Python 内核获取工具清单...</span>
          </div>
        ) : filteredTools.length === 0 ? (
          <div className="p-8 text-center text-xs text-muted">
            <span>未找到匹配的工具</span>
          </div>
        ) : (
          filteredTools.map((t) => {
            const isExpanded = expandedTool === t.name
            const meta = TOOL_CATEGORY_MAP[t.name]
            const Icon = meta?.icon || Code2
            const categoryLabel = meta?.label || '核心工具'
            const properties = t.parameters?.properties || {}
            const requiredProps = new Set(t.parameters?.required || [])
            const propKeys = Object.keys(properties)

            return (
              <div key={t.name} className="p-4 hover:bg-surface-2/40 transition-colors">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-surface-2 border border-border-subtle flex items-center justify-center shrink-0 mt-0.5 text-accent">
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-[13px] font-semibold text-text-main">
                          {t.name}
                        </span>
                        <span className="text-[10px] px-2 py-0.2 rounded bg-surface-2 text-dim border border-border-subtle font-medium">
                          {categoryLabel}
                        </span>
                      </div>
                      <p className="text-xs text-muted leading-relaxed line-clamp-2">
                        {t.description}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-success-surface text-success border border-success-border font-medium">
                      <CheckCircle2 className="w-3 h-3" />
                      <span>内核就绪</span>
                    </span>

                    <button
                      type="button"
                      onClick={() => toggleExpand(t.name)}
                      className="p-1 rounded hover:bg-surface-3 text-dim hover:text-text-main transition-colors cursor-pointer"
                      title={isExpanded ? '收起参数' : '查看参数结构'}
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-4 h-4" />
                      ) : (
                        <ChevronRight className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Expanded Parameter Details Drawer */}
                {isExpanded && (
                  <div className="mt-3 pt-3 border-t border-border-subtle space-y-2">
                    <div className="text-[11px] font-medium text-dim flex items-center gap-1.5">
                      <Code2 className="w-3.5 h-3.5 text-accent" />
                      <span>调用参数结构规范 (JSON Schema Properties)</span>
                    </div>

                    {propKeys.length === 0 ? (
                      <div className="text-xs text-dim italic pl-2">无需传入参数</div>
                    ) : (
                      <div className="grid grid-cols-1 gap-2 pl-2">
                        {propKeys.map((pKey) => {
                          const prop = properties[pKey] || {}
                          const isReq = requiredProps.has(pKey)
                          return (
                            <div
                              key={pKey}
                              className="p-2.5 rounded-lg bg-surface-2/80 border border-border-subtle/80 text-xs font-mono"
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold text-text-main">{pKey}</span>
                                  <span className="text-[10px] text-accent/80 font-normal">
                                    {prop.type || 'any'}
                                  </span>
                                </div>
                                {isReq ? (
                                  <span className="text-[10px] text-danger font-sans">必填 (Required)</span>
                                ) : (
                                  <span className="text-[10px] text-dim font-sans">选填</span>
                                )}
                              </div>
                              {prop.description && (
                                <p className="text-[11px] text-muted font-sans mt-1 leading-normal">
                                  {prop.description}
                                </p>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {t.promptGuidelines && t.promptGuidelines.length > 0 && (
                      <div className="mt-2 pl-2">
                        <span className="text-[11px] text-dim font-medium">使用指引：</span>
                        <ul className="list-disc list-inside text-[11px] text-muted space-y-0.5 mt-0.5">
                          {t.promptGuidelines.map((g, idx) => (
                            <li key={idx}>{g}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* Slash Commands Support Footer */}
      {slashCommands.length > 0 && (
        <div className="p-4 rounded-xl bg-card shadow-e1 border border-border-subtle">
          <div className="text-xs font-semibold text-text-main flex items-center gap-1.5 mb-2">
            <Sparkles className="w-3.5 h-3.5 text-accent" />
            <span>可用快捷斜杠指令 (Slash Commands)</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {slashCommands.map((cmd) => (
              <span
                key={cmd}
                className="text-xs font-mono px-2.5 py-1 rounded-md bg-surface-2 border border-border-subtle text-text-main"
              >
                /{cmd}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
