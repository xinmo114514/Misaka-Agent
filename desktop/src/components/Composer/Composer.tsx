import React, { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react'
import {
  Plus,
  ArrowUp,
  Square,
  Loader2,
  ShieldCheck,
  ChevronDown,
  Check,
  BookOpen,
  FileEdit,
  Zap,
  FileImage,
  RotateCw,
  X,
  Network,
} from 'lucide-react'
import { useSessionStore } from '../../store/useSessionStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { ModelPickerPopover } from './ModelPickerPopover'
import { MisakaLogo } from '../MisakaLogo'
import type { PermissionMode } from '../../types/session'
import { startComposerResearch } from '../../lib/startComposerResearch'
import { newRequestId } from '../../lib/bridge'
import { executeResearchControl } from '../../lib/researchBridge'

interface ComposerProps {
  onOpenModelSettings?: () => void
  welcome?: boolean
  workspaceControl?: React.ReactNode
  onResearchStarted?: () => void
}

const PERMISSION_MODE_OPTIONS: {
  id: PermissionMode | 'research'
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
    badgeColor: 'text-permission-plan',
    desc: '严格只读，禁止改动文件，文献研读/大纲论证专用',
  },
  {
    id: 'acceptEdits',
    label: '自动编辑',
    icon: FileEdit,
    badgeColor: 'text-permission-edit',
    desc: '工作区内文件自由读写修改，无需逐次审批',
  },
  {
    id: 'bypassPermissions',
    label: '完全放行',
    icon: Zap,
    badgeColor: 'text-permission-bypass',
    desc: '完全自主执行，跳过所有权限询问（无阻执行）',
  },
  {
    id: 'research',
    label: '研究模式',
    icon: Network,
    badgeColor: 'text-accent',
    desc: '直接输入课题发起研究，完全放行权限，计划与分支汇总自动审批',
  },
]

export const Composer: React.FC<ComposerProps> = ({ onOpenModelSettings, welcome = false, workspaceControl, onResearchStarted }) => {
  const text = useSessionStore(s => s.draft)
  const setText = useSessionStore(s => s.setDraft)
  const attachments = useSessionStore(s => s.attachments)
  const prepareAttachments = useSessionStore(s => s.prepareAttachments)
  const retryAttachment = useSessionStore(s => s.retryAttachment)
  const removeAttachment = useSessionStore(s => s.removeAttachment)
  const clearAttachments = useSessionStore(s => s.clearAttachments)
  const [showPicker, setShowPicker] = useState(false)
  const [showModePicker, setShowModePicker] = useState(false)
  const [showSendMenu, setShowSendMenu] = useState(false)
  const [isPickingFiles, setIsPickingFiles] = useState(false)
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null)
  const [researchStarting, setResearchStarting] = useState(false)
  const [researchError, setResearchError] = useState<string | null>(null)
  const researchStartingRef = useRef(false)
  const sendMenuRef = useRef<HTMLDivElement>(null)
  const sendMenuTriggerRef = useRef<HTMLButtonElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const composing = useRef(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  // The pill owns focus when the popover closes on the keyboard: the popover is an
  // unmounted element by then, so the handoff has to be explicit.
  const pickerTriggerRef = useRef<HTMLButtonElement>(null)
  const modePickerRef = useRef<HTMLDivElement>(null)

  const isStreaming = useSessionStore(s => s.agentMode === 'research' && s.researchBinding ? s.researchConversation.isStreaming : s.isStreaming)
  const isSessionLoading = useSessionStore(s => s.isSessionLoading)
  const sessionLoadError = useSessionStore(s => s.sessionLoadError)
  const isAborting = useSessionStore(s => s.agentMode === 'research' && s.researchBinding ? s.researchConversation.isAborting : s.isAborting)
  const sessionOperation = useSessionStore(s => s.sessionOperation)
  const isCompacting = useSessionStore(s => s.isCompacting)
  const retainedEditorText = useSessionStore(s => s.retainedEditorText)
  const takeRetainedEditorText = useSessionStore(s => s.takeRetainedEditorText)
  const runSlashCommand = useSessionStore(s => s.runSlashCommand)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const ordinaryAbort = useSessionStore(s => s.abortGeneration)
  const abortGeneration = useCallback(() => {
    const state = useSessionStore.getState()
    if (state.agentMode === 'research' && state.researchBinding?.runId) {
      void executeResearchControl('stop_research', { runId: state.researchBinding.runId, workspace: state.researchBinding.workspace, sessionFile: state.researchBinding.sessionFile }).catch(error => setResearchError(String(error)))
    } else ordinaryAbort()
  }, [ordinaryAbort])
  const permissionMode = useSessionStore((s) => s.permissionMode)
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode)
  const agentMode = useSessionStore(s => s.agentMode)
  const setAgentMode = useSessionStore(s => s.setAgentMode)
  const currentWorkspace = useSessionStore(s => s.currentWorkspace)
  const isResearch = agentMode === 'research'
  const researchBinding = useSessionStore(s => s.researchBinding)
  const researchConnectionError = useSessionStore(s => s.researchConnectionError)
  const researchCard = useSessionStore(s => s.researchBinding?.runId ? s.researchCards[s.researchBinding.runId] : undefined)

  const currentModel = useSettingsStore((s) => s.currentModel)
  const models = useSettingsStore(s => s.models)
  const thinkingLevel = useSettingsStore((s) => s.thinkingLevel)

  const modelDisplayName = currentModel ? (currentModel.name || currentModel.modelId) : '选择模型'

  const supportsImageInput = Boolean(currentModel && models.find(model => model.provider === currentModel.provider && model.id === currentModel.modelId)?.input.includes('image'))

  const handleAddAttachments = async () => {
    if (isPickingFiles) return
    setIsPickingFiles(true)
    setAttachmentNotice(null)
    try {
      const paths = await window.app?.pickFiles()
      if (paths?.length) await prepareAttachments(paths)
    } catch (error) {
      setAttachmentNotice(error instanceof Error ? error.message : '打开附件选择窗口失败')
    } finally {
      setIsPickingFiles(false)
    }
  }

  const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024 / (bytes < 1024 * 1024 ? 1 : 1024)).toFixed(1)} ${bytes < 1024 * 1024 ? 'KiB' : 'MiB'}`

  const currentModeConfig = useMemo(() => {
    return (
      PERMISSION_MODE_OPTIONS.find((opt) => opt.id === (isResearch ? 'research' : permissionMode)) ||
      PERMISSION_MODE_OPTIONS[0]
    )
  }, [permissionMode, isResearch])

  const CurrentModeIcon = currentModeConfig.icon

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modePickerRef.current && !modePickerRef.current.contains(e.target as Node)) {
        setShowModePicker(false)
      }
    }
    if (showModePicker) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showModePicker])

  useLayoutEffect(() => {
    const form = formRef.current
    const viewport = form?.closest<HTMLElement>('[data-conversation-viewport]')
    if (!form || !viewport) return
    const measure = () => viewport.style.setProperty('--composer-height', `${Math.ceil(form.getBoundingClientRect().height)}px`)
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(form)
    return () => observer?.disconnect()
  }, [])

  useEffect(() => {
    if (!showSendMenu && !showModePicker && (!isStreaming || isSessionLoading || isAborting)) return
    const stopOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || composing.current) return
      if (showSendMenu) {
        event.preventDefault()
        setShowSendMenu(false)
        sendMenuTriggerRef.current?.focus()
      } else if (showModePicker) {
        event.preventDefault()
        setShowModePicker(false)
        modePickerRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
      } else if (!isSessionLoading && !isAborting) abortGeneration()
    }
    document.addEventListener('keydown', stopOnEscape)
    return () => document.removeEventListener('keydown', stopOnEscape)
  }, [isStreaming, isSessionLoading, isAborting, abortGeneration, showSendMenu, showModePicker])

  useEffect(() => {
    if (!showSendMenu) return
    if (!isStreaming || isSessionLoading || sessionLoadError || isAborting) {
      setShowSendMenu(false)
      return
    }
    sendMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const outside = (event: MouseEvent) => {
      if (!sendMenuRef.current?.contains(event.target as Node)) setShowSendMenu(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [showSendMenu, isStreaming, isSessionLoading, sessionLoadError, isAborting])

  const submitText = (mode: 'steer' | 'followUp' = 'steer') => {
    if (researchStartingRef.current) return
    if (isPickingFiles || attachments.some(item => item.status !== 'ready') || isSessionLoading || sessionLoadError || isAborting || sessionOperation || isCompacting || composing.current) return
    if (!text.trim() && !attachments.length) return
    const attachedText = attachments.map(item => item.text).filter(Boolean)
    const messageText = [text.trim(), ...attachedText].filter(Boolean).join('\n\n')
    const images = attachments.flatMap(item => item.images)
    if (images.length && !supportsImageInput) {
      setAttachmentNotice('当前模型不支持图片输入，请切换到支持图片的模型。附件仍保留在草稿中。')
      return
    }
    if (isResearch && researchBinding && /^\/(?:tree|compact)(?:\s|$)/.test(text.trim())) {
      setResearchError('研究对话的原会话由协调 Agent 持有；请先停止研究，再从普通对话入口执行会话操作。')
      return
    }
    if (!attachments.length && runSlashCommand(text)) {
      setText('')
      setShowSendMenu(false)
      if (textareaRef.current) { textareaRef.current.style.height = 'auto'; textareaRef.current.focus() }
      return
    }
    if (isResearch) {
      if (isStreaming && !researchBinding) {
        setResearchError('请先结束或停止当前对话，再开始研究。')
        return
      }
      if (images.length) {
        setResearchError('研究消息请使用文字或文本附件；图片仍保留在草稿中。')
        return
      }
      const requestId = newRequestId('research_input')
      researchStartingRef.current = true
      setResearchStarting(true)
      setResearchError(null)
      void startComposerResearch({ question: messageText, workspace: researchBinding?.workspace || currentWorkspace,
        model: currentModel, thinkingLevel, binding: researchBinding, requestId,
        onBound: host => {
          useSessionStore.getState().bindResearchConversation(host)
          useSessionStore.getState().queueResearchMessage(requestId, messageText)
        },
        onAccepted: () => useSessionStore.getState().acceptResearchMessage(requestId),
      }).then(host => {
        useSessionStore.getState().bindResearchConversation(host)
        if (useSessionStore.getState().draft === text) setText('')
        for (const attachment of attachments) removeAttachment(attachment.path)
        setAttachmentNotice(null)
        setShowSendMenu(false)
        useSessionStore.getState().fetchResearchRuns()
        onResearchStarted?.()
      }).catch(error => {
        const message = error instanceof Error ? error.message : String(error)
        useSessionStore.getState().failResearchMessage(requestId, message)
        setResearchError(message)
      }).finally(() => {
        researchStartingRef.current = false
        setResearchStarting(false)
      })
      return
    }
    if (images.length) sendMessage(messageText, mode, images)
    else sendMessage(messageText, mode)
    setText('')
    clearAttachments()
    setAttachmentNotice(null)
    setShowSendMenu(false)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.focus()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submitText(e.altKey && isStreaming ? 'followUp' : 'steer')
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px'
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    submitText()
  }

  const hasText = text.trim().length > 0
  const hasContent = hasText || attachments.length > 0
  const hasPendingAttachment = isPickingFiles || attachments.some(item => item.status === 'preparing')
  const hasAttachmentError = attachments.some(item => item.status === 'error')
  const hasUnsupportedImageModel = attachments.some(item => item.images.length > 0) && !supportsImageInput
  const pendingLabel = researchStarting ? '研究启动中' : sessionLoadError ? '会话尚未就绪' : isSessionLoading ? '会话加载中' : isAborting ? '停止中' : sessionOperation ? '会话操作中' : isCompacting ? '压缩中' : ''
  const sendDisabled = Boolean(pendingLabel) || !hasContent || hasPendingAttachment || hasAttachmentError || hasUnsupportedImageModel
  const sendLabel = isStreaming ? '干预当前运行 (Enter)' : isResearch ? (researchBinding?.runId ? '发送研究消息 (Enter)' : '开始研究 (Enter)') : '发送指令 (Enter)'

  return (
    <div className={'conversation-composer-dock pointer-events-none z-10' + (welcome ? ' conversation-composer-dock--welcome' : '')}>
      {welcome && (
        <div className="flex flex-col items-center pointer-events-auto select-none">
          <div className="mb-4 flex items-center justify-center rounded-2xl shadow-e2 transition-transform hover:scale-105">
            <MisakaLogo size={60} />
          </div>
          <h1 className="conversation-welcome-title">欢迎使用 Misaka-Agent</h1>
        </div>
      )}
      <div className={welcome ? 'conversation-welcome-card pointer-events-auto' : 'conversation-composer-shell'}>
        {welcome && <div className="conversation-welcome-workspace">{workspaceControl}</div>}
        <form
          ref={formRef}
          onSubmit={handleSubmit}
          className="conversation-composer misaka-glass-panel pointer-events-auto flex flex-col gap-2.5 relative"
        >
          {retainedEditorText && <div className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-surface-2/60 px-3 py-2 text-xs text-muted" role="status">
            <span className="min-w-0 truncate" title={retainedEditorText}>所选消息已返回：{retainedEditorText}</span>
            <button type="button" className="shrink-0 text-accent hover:underline" onClick={() => {
              const held = takeRetainedEditorText()
              if (held) setText(text.trim() ? `${text}\n\n${held}` : held)
            }}>恢复到草稿</button>
          </div>}
          {/* Main Textarea */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => { composing.current = true }}
            onCompositionEnd={() => { composing.current = false }}
            aria-label="给 Misaka 发送任务"
            placeholder={isResearch ? (researchBinding?.runId ? '补充要求、回答澄清或追问研究报告…' : '输入研究课题，Enter 开始研究…') : welcome ? "向 Misaka-Agent 提问或描述任务…" : "给 Misaka 发送研究任务或指令..."}
            rows={1}
            className="w-full bg-transparent border-0 outline-none text-text-main placeholder-dim text-[length:var(--font-size-body)] leading-[1.75] resize-none px-2 py-1 max-h-44"
          />

          {attachments.length > 0 && <div className="flex flex-wrap gap-1.5" aria-label="待发送附件">
            {attachments.map(attachment => <div key={attachment.path} className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2/60 px-2 py-1 text-[11px] text-muted">
              <FileImage className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="max-w-48 truncate" title={attachment.name}>{attachment.name}</span>
              {attachment.status === 'preparing' ? <span role="status" className="shrink-0 text-dim">处理中…</span>
                : attachment.error ? <span role="status" className="max-w-64 truncate text-danger" title={attachment.error}>{attachment.error}</span>
                  : <span className="shrink-0 text-dim">{formatBytes(attachment.size)}</span>}
              {attachment.status === 'error' && <button type="button" onClick={() => void retryAttachment(attachment.path)} className="shrink-0 rounded p-0.5 hover:bg-surface-3" aria-label={`重试附件 ${attachment.name}`} title="重试处理"><RotateCw className="h-3 w-3" /></button>}
              <button type="button" onClick={() => removeAttachment(attachment.path)} className="shrink-0 rounded p-0.5 hover:bg-surface-3" aria-label={`移除附件 ${attachment.name}`} title="移除附件"><X className="h-3 w-3" /></button>
            </div>)}
          </div>}
          {(attachmentNotice || hasUnsupportedImageModel) && <div role="status" className="text-[11px] text-warning">
            {attachmentNotice || '当前模型不支持图片输入，请切换到支持图片的模型。附件仍保留在草稿中。'}
          </div>}
          {(researchError || researchConnectionError && isResearch) && <div role="alert" className="text-[11px] text-danger">{researchError || researchConnectionError}</div>}
          {researchStarting && !researchBinding?.runId && <div role="status" className="text-[11px] text-dim">正在准备研究团队…</div>}

          {/* Bottom Toolbar */}
          <div className="conversation-composer-toolbar flex items-center justify-between pt-1 border-t border-border-subtle/50 text-xs select-none">
            {/* Left Controls: Plus + Mode Picker */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleAddAttachments()}
                disabled={isPickingFiles}
                aria-label="添加附件"
                className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-surface-2 text-dim hover:text-text-main transition-colors cursor-pointer"
                title={isPickingFiles ? '正在选择附件…' : '附加上下文或附件'}
              >
                <Plus className="w-4 h-4" />
              </button>

              {/* Interactive Mode Picker Pill */}
              <div className="relative" ref={modePickerRef}>
                <button
                  type="button"
                  onClick={() => setShowModePicker(!showModePicker)}
                  className="conversation-permission-trigger flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-surface-2/60 hover:bg-surface-2 border border-border-subtle transition-colors cursor-pointer"
                  aria-expanded={showModePicker}
                  aria-haspopup="menu"
                disabled={researchStarting || isSessionLoading || Boolean(sessionLoadError) || Boolean(sessionOperation) || isCompacting}
                  title="点击切换 Agent 模式"
                >
                  <CurrentModeIcon className={"w-3.5 h-3.5 " + currentModeConfig.badgeColor} />
                  <span className={currentModeConfig.badgeColor}>{currentModeConfig.label}</span>
                  <ChevronDown className="w-3 h-3 text-dim" />
                </button>

                {/* Mode Selection Popover */}
                {showModePicker && (
                  <div className="conversation-permission-popover misaka-glass-popover absolute bottom-full left-0 mb-2 w-72 max-h-[min(24rem,calc(100dvh-10rem))] overflow-y-auto rounded-xl bg-card border border-border-subtle shadow-e3 p-2 z-50 text-xs space-y-1">
                    <div className="px-2 py-1 text-[11px] font-semibold text-text-main border-b border-border-subtle">
                      选择 Agent 模式
                    </div>
                    {PERMISSION_MODE_OPTIONS.map((opt) => {
                      const OptIcon = opt.icon
                      const isSelected = isResearch ? opt.id === 'research' : permissionMode === opt.id
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => {
                            if (opt.id === 'research') setAgentMode('research')
                            else setPermissionMode(opt.id)
                            setResearchError(null)
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

            {isResearch && researchBinding && <button type="button" disabled={researchStarting || isStreaming || !researchCard || ['active', 'stopping', 'waiting_input'].includes(researchCard.status)} onClick={() => { useSessionStore.getState().clearResearchConversation(); setResearchError(null) }} className="text-[11px] text-muted hover:text-accent disabled:opacity-40" title="保留当前报告并开启新的研究对话">新研究</button>}

            {/* Right Controls: Model Pill + Submit Button */}
            <div className="flex items-center gap-2.5">
              {/* Interactive Model & Thinking Level Selector Pill */}
              <div className="relative" ref={pickerRef}>
                <button
                  type="button"
                  ref={pickerTriggerRef}
                  onClick={() => setShowPicker(!showPicker)}
                  aria-expanded={showPicker}
                  aria-haspopup="dialog"
                disabled={isSessionLoading || Boolean(sessionLoadError)}
                  aria-label="模型与思考深度"
                  aria-description={modelDisplayName}
                  className={
                    'conversation-model-trigger flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-2/60 hover:bg-surface-hover border border-border-subtle text-[11.5px] text-muted hover:text-text-main transition-colors cursor-pointer font-medium ' +
                    (showPicker ? 'text-text-main border-border-accent/60' : '')
                  }
                  title="模型与思考深度"
                >
                  <span className="truncate max-w-[140px]">{modelDisplayName}</span>
                  <ChevronDown
                    className={'w-3 h-3 text-dim transition-transform ' + (showPicker ? 'rotate-180' : '')}
                  />
                </button>

                {showPicker && (
                  <ModelPickerPopover
                    triggerRef={pickerTriggerRef}
                    onOpenModelSettings={onOpenModelSettings}
                    onClose={() => setShowPicker(false)}
                  />
                )}
              </div>

              {pendingLabel && !isAborting && <span className="text-[11px] text-dim" role="status">{pendingLabel}</span>}
              <div className="conversation-send-controls relative flex items-center gap-1" ref={sendMenuRef}>
              <button
                type="submit"
                disabled={sendDisabled}
                className={
                  "conversation-send-button w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer shadow-sm " +
                  (pendingLabel
                    ? "bg-surface-2 text-dim cursor-wait"
                    : hasContent
                    ? "misaka-luminous bg-accent hover:opacity-90 text-on-accent active:scale-95 shadow-cta"
                    : "bg-surface-2 text-dim opacity-50 cursor-not-allowed")
                }
                aria-label={isAborting ? sendLabel : pendingLabel || sendLabel}
                title={isStreaming ? '干预当前运行：在当前工具执行后的处理边界生效 (Enter)' : sendLabel}
              >
                <ArrowUp className="w-4 h-4 stroke-[2.5]" />
              </button>
              {isStreaming && <>
                <button type="button" ref={sendMenuTriggerRef} aria-label="发送选项" aria-haspopup="menu" aria-expanded={showSendMenu}
                  disabled={sendDisabled} onClick={() => setShowSendMenu(!showSendMenu)}
                  className="conversation-send-options w-7 h-8 rounded-md flex items-center justify-center text-muted hover:bg-surface-2 disabled:opacity-40">
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
                {showSendMenu && <div role="menu" aria-label="发送选项" className="conversation-send-menu misaka-glass-popover absolute bottom-full right-0 mb-2 w-64 max-w-[80vw] rounded-xl bg-card border border-border-subtle shadow-e3 p-2 z-50"
                  onKeyDown={event => {
                    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
                    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                      event.preventDefault()
                      const current = items.indexOf(document.activeElement as HTMLButtonElement)
                      const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
                      items[index]?.focus()
                    } else if (event.key === 'Tab') setShowSendMenu(false)
                  }}>
                  <button type="button" role="menuitem" disabled={sendDisabled} onClick={() => submitText('steer')} className="w-full rounded-lg p-2 text-left hover:bg-surface-2">
                    <span className="block text-xs text-text-main">干预当前运行 · Enter</span>
                    <span className="block text-[11px] text-muted mt-1">在当前工具执行后的处理边界生效</span>
                  </button>
                  <button type="button" role="menuitem" disabled={sendDisabled} onClick={() => submitText('followUp')} className="w-full rounded-lg p-2 text-left hover:bg-surface-2">
                    <span className="block text-xs text-text-main">后续排队 · Alt+Enter</span>
                    <span className="block text-[11px] text-muted mt-1">等待当前任务结束后处理</span>
                  </button>
                </div>}
              </>}
              </div>
              {isStreaming && <button type="button" onClick={abortGeneration} disabled={Boolean(pendingLabel)}
                aria-label={isAborting ? '停止中' : '中止生成 (Esc)'} title={isAborting ? '停止中' : '中止生成 (Esc)'}
                className="conversation-stop-button h-8 min-w-8 px-2 rounded-full flex items-center justify-center gap-1 bg-danger text-on-danger hover:opacity-90 disabled:opacity-50 disabled:cursor-wait">
                {isAborting ? <><Loader2 className="w-4 h-4 animate-spin" /><span className="text-[11px]">停止中</span></> : <Square className="w-3.5 h-3.5 fill-current" />}
              </button>}
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
