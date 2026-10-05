import React, { useState, useRef, useEffect, useMemo } from 'react'
import {
  Plus,
  ArrowUp,
  Square,
  ShieldCheck,
  ChevronDown,
  Check,
  Settings,
  Star,
  Brain,
  BookOpen,
  FileEdit,
  Zap,
} from 'lucide-react'
import { useSessionStore } from '../../store/useSessionStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import type { PermissionMode } from '../../types/session'

interface ComposerProps {
  onOpenModelSettings?: () => void
}

const PERMISSION_MODE_OPTIONS: {
  id: PermissionMode
  label: string
  icon: React.ComponentType<{ className?: string }>
  badgeColor: string
  desc: string
}[] = [
  {
    id: 'default',
    label: '标准模式',
    icon: ShieldCheck,
    badgeColor: 'text-warning',
    desc: '敏感与越界命令需人工审批（推荐）',
  },
  {
    id: 'plan',
    label: '只读规划',
    icon: BookOpen,
    badgeColor: 'text-sky-400',
    desc: '严格只读，禁止改动文件，文献研读/大纲论证专用',
  },
  {
    id: 'acceptEdits',
    label: '自动编辑',
    icon: FileEdit,
    badgeColor: 'text-emerald-400',
    desc: '工作区内文件自由读写修改，无需逐次审批',
  },
  {
    id: 'bypassPermissions',
    label: '完全放行',
    icon: Zap,
    badgeColor: 'text-rose-400',
    desc: '完全自主执行，跳过所有权限询问（无阻执行）',
  },
]

export const Composer: React.FC<ComposerProps> = ({ onOpenModelSettings }) => {
  const [text, setText] = useState('')
  const [showPicker, setShowPicker] = useState(false)
  const [pickerSearch, setPickerSearch] = useState('')
  const [showModePicker, setShowModePicker] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const modePickerRef = useRef<HTMLDivElement>(null)

  const isStreaming = useSessionStore((s) => s.isStreaming)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const abortGeneration = useSessionStore((s) => s.abortGeneration)
  const permissionMode = useSessionStore((s) => s.permissionMode)
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode)

  const models = useSettingsStore((s) => s.models)
  const currentModel = useSettingsStore((s) => s.currentModel)
  const thinkingLevel = useSettingsStore((s) => s.thinkingLevel)
  const availableThinkingLevels = useSettingsStore((s) => s.availableThinkingLevels)
  const defaultProvider = useSettingsStore((s) => s.defaultProvider)
  const defaultModel = useSettingsStore((s) => s.defaultModel)
  const setSessionModel = useSettingsStore((s) => s.setSessionModel)
  const setThinkingLevel = useSettingsStore((s) => s.setThinkingLevel)

  const modelDisplayName = currentModel ? currentModel.name : '选择模型'
  const currentThinkingLabel = thinkingLevel ? thinkingLevel.toUpperCase() : 'OFF'

  const currentModeConfig = useMemo(() => {
    return (
      PERMISSION_MODE_OPTIONS.find((opt) => opt.id === permissionMode) ||
      PERMISSION_MODE_OPTIONS[0]
    )
  }, [permissionMode])

  const CurrentModeIcon = currentModeConfig.icon

  // Only display models from providers where API credentials have been configured
  // Sorted in English alphabetical order (case-insensitive A-Z)
  const availableModels = useMemo(() => {
    return models
      .filter((m) => m.configured)
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, 'en', { sensitivity: 'base' }))
  }, [models])

  const filteredPickerModels = useMemo(() => {
    if (!pickerSearch.trim()) return availableModels
    const q = pickerSearch.toLowerCase()
    return availableModels.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q),
    )
  }, [availableModels, pickerSearch])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false)
      }
      if (modePickerRef.current && !modePickerRef.current.contains(e.target as Node)) {
        setShowModePicker(false)
      }
    }
    if (showPicker || showModePicker) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showPicker, showModePicker])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (text.trim() && !isStreaming) {
        sendMessage(text)
        setText('')
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto'
        }
      }
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px'
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (isStreaming) {
      abortGeneration()
    } else if (text.trim()) {
      sendMessage(text)
      setText('')
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    }
  }

  const hasText = text.trim().length > 0

  return (
    <div className="absolute bottom-6 left-0 right-0 px-6 sm:px-12 md:px-20 lg:px-28 pointer-events-none z-10">
      <form
        onSubmit={handleSubmit}
        className="pointer-events-auto max-w-4xl mx-auto rounded-2xl bg-card border border-border-subtle shadow-e3 p-3 flex flex-col gap-2.5 transition-all focus-within:border-border-accent/70 focus-within:ring-1 focus-within:ring-focus-ring/40 relative"
      >
        {/* Main Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="给 Misaka 发送研究任务或指令..."
          rows={1}
          className="w-full bg-transparent border-0 outline-none text-text-main placeholder-dim text-[13.5px] leading-relaxed resize-none px-2 py-1 max-h-44"
        />

        {/* Bottom Toolbar */}
        <div className="flex items-center justify-between pt-1 border-t border-border-subtle/50 text-xs select-none">
          {/* Left Controls: Plus + Mode Picker */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-surface-2 text-dim hover:text-text-main transition-colors cursor-pointer"
              title="附加上下文或附件"
            >
              <Plus className="w-4 h-4" />
            </button>

            {/* Interactive Mode Picker Pill */}
            <div className="relative" ref={modePickerRef}>
              <button
                type="button"
                onClick={() => setShowModePicker(!showModePicker)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-surface-2/60 hover:bg-surface-2 border border-border-subtle transition-colors cursor-pointer"
                title="点击切换 Agent 权限模式"
              >
                <CurrentModeIcon className={"w-3.5 h-3.5 " + currentModeConfig.badgeColor} />
                <span className={currentModeConfig.badgeColor}>{currentModeConfig.label}</span>
                <ChevronDown className="w-3 h-3 text-dim" />
              </button>

              {/* Mode Selection Popover */}
              {showModePicker && (
                <div className="absolute bottom-full left-0 mb-2 w-72 rounded-xl bg-card border border-border-subtle shadow-e3 p-2 z-50 text-xs space-y-1">
                  <div className="px-2 py-1 text-[11px] font-semibold text-text-main border-b border-border-subtle">
                    选择 Agent 权限模式
                  </div>
                  {PERMISSION_MODE_OPTIONS.map((opt) => {
                    const OptIcon = opt.icon
                    const isSelected = permissionMode === opt.id
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => {
                          setPermissionMode(opt.id)
                          setShowModePicker(false)
                        }}
                        className={
                          "w-full flex items-start gap-2.5 p-2 rounded-lg text-left transition-colors cursor-pointer " +
                          (isSelected ? "bg-surface-2" : "hover:bg-surface-2/60")
                        }
                      >
                        <OptIcon className={"w-4 h-4 mt-0.5 shrink-0 " + opt.badgeColor} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-text-main text-xs">{opt.label}</span>
                            {isSelected && <Check className="w-3.5 h-3.5 text-accent shrink-0" />}
                          </div>
                          <p className="text-[10.5px] text-muted mt-0.5 leading-normal">{opt.desc}</p>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right Controls: Model Pill + Submit Button */}
          <div className="flex items-center gap-2.5">
            {/* Interactive Model & Thinking Level Selector Pill */}
            <div className="relative" ref={pickerRef}>
              <button
                type="button"
                onClick={() => setShowPicker(!showPicker)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-2/60 hover:bg-surface-2 border border-border-subtle text-[11.5px] text-muted hover:text-text-main transition-colors cursor-pointer font-medium"
                title="点击切换模型与思考级别"
              >
                <span className="truncate max-w-[140px]">{modelDisplayName}</span>
                <span className="text-dim text-[10.5px]">({currentThinkingLabel})</span>
                <ChevronDown className="w-3 h-3 text-dim" />
              </button>

              {/* Floating Quick Model Picker Popover */}
              {showPicker && (
                <div className="absolute bottom-full right-0 mb-2 w-80 rounded-xl bg-card border border-border-subtle shadow-e3 p-2.5 z-50 text-xs space-y-2.5">
                  <div className="px-1 py-0.5 flex items-center justify-between border-b border-border-subtle/80 pb-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-text-main text-[12px]">切换会话模型</span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-accent/15 text-rose-lite border border-accent/30 font-medium">
                        {availableModels.length} 个可用
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setShowPicker(false)
                        onOpenModelSettings?.()
                      }}
                      className="flex items-center gap-1 text-[11px] text-dim hover:text-accent cursor-pointer transition-colors"
                    >
                      <Settings className="w-3 h-3" />
                      <span>配置凭据</span>
                    </button>
                  </div>

                  {/* Thinking levels pill selector */}
                  <div className="px-1 py-0.5 space-y-1">
                    <div className="text-[10.5px] text-dim flex items-center gap-1">
                      <Brain className="w-3 h-3" />
                      <span>思考强度 (Thinking)</span>
                    </div>
                    <div className="grid grid-cols-4 gap-1 bg-surface-2 p-0.5 rounded-lg border border-border-subtle text-[10.5px]">
                      {availableThinkingLevels.map((lvl) => (
                        <button
                          key={lvl}
                          type="button"
                          onClick={() => setThinkingLevel(lvl)}
                          className={
                            "py-0.5 rounded text-center font-medium transition-all cursor-pointer " +
                            (thinkingLevel === lvl
                              ? "bg-accent text-white shadow-xs"
                              : "text-dim hover:text-text-main")
                          }
                        >
                          {lvl.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Model Search Input */}
                  {availableModels.length > 5 && (
                    <div className="px-1">
                      <input
                        type="text"
                        value={pickerSearch}
                        onChange={(e) => setPickerSearch(e.target.value)}
                        placeholder="搜索可用模型..."
                        className="w-full bg-surface-2 text-text-main placeholder-dim px-2.5 py-1 rounded-md border border-border-subtle outline-none focus:border-accent text-[11.5px]"
                      />
                    </div>
                  )}

                  {/* Model list */}
                  <div className="max-h-56 overflow-y-auto space-y-0.5 pr-1 divide-y divide-border-subtle/30">
                    {availableModels.length === 0 ? (
                      <div className="p-4 text-center space-y-2">
                        <p className="text-dim text-[11.5px]">未检测到已配置凭据的可用模型</p>
                        <p className="text-[10.5px] text-muted leading-relaxed">
                          请在「设置 - 模型与供应商」中录入 API Key，配置后模型将在此列出。
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            setShowPicker(false)
                            onOpenModelSettings?.()
                          }}
                          className="px-3 py-1 rounded-md bg-accent hover:opacity-90 text-white text-[11px] font-medium transition-colors cursor-pointer"
                        >
                          前往配置模型
                        </button>
                      </div>
                    ) : filteredPickerModels.length === 0 ? (
                      <div className="p-3 text-center text-dim text-xs">
                        未匹配到模型
                      </div>
                    ) : (
                      filteredPickerModels.map((m) => {
                        const isCurrent = currentModel?.provider === m.provider && currentModel?.modelId === m.id
                        const isDefault = defaultProvider === m.provider && defaultModel === m.id

                        return (
                          <div
                            key={m.provider + ":" + m.id}
                            className={
                              "flex items-center justify-between p-1.5 rounded-lg transition-colors cursor-pointer " +
                              (isCurrent ? "bg-accent/15 text-text-main" : "hover:bg-surface-2/70 text-muted")
                            }
                            onClick={() => {
                              setSessionModel(m.provider, m.id)
                              setShowPicker(false)
                            }}
                          >
                            <div className="truncate pr-2 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="font-medium text-[12px] text-text-main truncate">{m.name}</span>
                                {m.reasoning && (
                                  <span className="text-[9.5px] px-1 rounded bg-info-surface text-info border border-info-border">
                                    思考
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] text-dim font-mono truncate">
                                {m.provider}/{m.id}
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              {isDefault && (
                                <span title="默认模型"><Star className="w-3 h-3 text-warning fill-warning" /></span>
                              )}
                              {isCurrent && <Check className="w-3.5 h-3.5 text-accent" />}
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Circular Submit / Stop Action Button */}
            <button
              type="submit"
              disabled={!hasText && !isStreaming}
              className={
                "w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer shadow-sm " +
                (isStreaming
                  ? "bg-danger hover:opacity-90 text-white active:scale-95"
                  : hasText
                  ? "bg-accent hover:opacity-90 text-white active:scale-95 shadow-cta"
                  : "bg-surface-2 text-dim opacity-50 cursor-not-allowed")
              }
              title={isStreaming ? "中止生成 (Esc)" : "发送指令 (Enter)"}
            >
              {isStreaming ? <Square className="w-3.5 h-3.5 fill-current" /> : <ArrowUp className="w-4 h-4 stroke-[2.5]" />}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
