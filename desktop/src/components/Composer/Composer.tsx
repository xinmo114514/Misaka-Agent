import { useResearchActivityStore } from '../../lib/researchActivityStore'
import { useResearchEditorModel } from '../../lib/useResearchEditorModel'
import { consumeEscape, useEscapeLayer } from '../../lib/useEscapeLayer'
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
  Cpu,
} from 'lucide-react'
import { useSessionStore } from '../../store/useSessionStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { ModelPickerPopover } from './ModelPickerPopover'
import { MisakaLogo } from '../MisakaLogo'
import type { PermissionMode } from '../../types/session'
import { cancelResearchStartup, startComposerResearch, openResearchConversation } from '../../lib/startComposerResearch'
import { isResearchStartupFailure } from '../../lib/researchConversation'
import { newRequestId } from '../../lib/bridge'
import { request } from '../../lib/bridge'
import { recordResearchSubmissionDiagnostic } from '../../lib/researchDiagnostics'
import type { ResearchOptionsPayload, ResearchRunLimits } from '../../types/research'
import { ResearchRunWizard } from '../ResearchWorkspace/ResearchRunWizard'

interface ComposerProps {
  onOpenModelSettings?: () => void
  welcome?: boolean
  workspaceControl?: React.ReactNode
  onResearchStarted?: () => void
  presentation?: 'default' | 'multi'
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
    desc: '仅当前会话：敏感与越界命令需人工审批（推荐）',
  },
  {
    id: 'plan',
    label: '只读规划',
    icon: BookOpen,
    badgeColor: 'text-permission-plan',
    desc: '仅当前会话：严格只读，禁止改动文件，文献研读/大纲论证专用',
  },
  {
    id: 'acceptEdits',
    label: '自动编辑',
    icon: FileEdit,
    badgeColor: 'text-permission-edit',
    desc: '仅当前会话：工作区内文件自由读写修改，无需逐次审批',
  },
  {
    id: 'bypassPermissions',
    label: '完全放行',
    icon: Zap,
    badgeColor: 'text-permission-bypass',
    desc: '仅当前会话：完全自主执行，跳过所有权限询问（无阻执行）',
  },
  {
    id: 'research',
    label: '研究模式',
    icon: Network,
    badgeColor: 'text-accent',
    desc: '直接输入课题发起研究，完全放行权限，计划与分支汇总自动审批',
  },
]

export const Composer: React.FC<ComposerProps> = ({ onOpenModelSettings, welcome = false, workspaceControl, onResearchStarted, presentation = 'default' }) => {
  const text = useSessionStore(s => s.draft)
  const setText = useSessionStore(s => s.setDraft)
  const researchPageView = useSessionStore(s => s.researchPageView)
  const setResearchPageView = useSessionStore(s => s.setResearchPageView)
  const isResearchNew = useSessionStore(s => s.agentMode === 'research' && s.researchPageView === 'new')
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
  const [researchCancelling, setResearchCancelling] = useState(false)
  const [researchError, setResearchError] = useState<string | null>(null)
  const [wizardOptions, setWizardOptions] = useState<ResearchOptionsPayload | null>(null)
  const [wizardLoading, setWizardLoading] = useState(false)
  const attachmentPickerGeneration = useRef(0)
  const researchPageVersion = useSessionStore(s=>s.researchPageVersion)
  useEffect(()=>{attachmentPickerGeneration.current += 1; setIsPickingFiles(false)},[researchPageVersion])
  const researchStartingRef = useRef(false)
  const researchStartingRequestRef = useRef<string | null>(null)
  const sendMenuRef = useRef<HTMLDivElement>(null)
  const sendMenuTriggerRef = useRef<HTMLButtonElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const focusEditor = () => { if (useSessionStore.getState().agentMode === 'research') textareaRef.current?.focus() }
    window.addEventListener('research-editor-focus', focusEditor)
    return () => window.removeEventListener('research-editor-focus', focusEditor)
  }, [])
  const formRef = useRef<HTMLFormElement>(null)
  const wasMultiPresentation = useRef(false)
  const composing = useRef(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  // The pill owns focus when the popover closes on the keyboard: the popover is an
  // unmounted element by then, so the handoff has to be explicit.
  const pickerTriggerRef = useRef<HTMLButtonElement>(null)
  const modePickerRef = useRef<HTMLDivElement>(null)

  const isStreaming = useSessionStore(s => s.agentMode === 'research' && s.researchBinding ? s.researchConversation.isStreaming : s.isStreaming)
  const isSessionLoading = useSessionStore(s => s.agentMode === 'research' ? false : s.isSessionLoading)
  const sessionLoadError = useSessionStore(s => s.agentMode === 'research' ? null : s.sessionLoadError)
  const isAborting = useSessionStore(s => s.agentMode === 'research' && s.researchBinding ? s.researchConversation.isAborting : s.isAborting)
  const sessionOperation = useSessionStore(s => s.sessionOperation)
  const isCompacting = useSessionStore(s => s.isCompacting)
  const retainedEditorText = useSessionStore(s => s.retainedEditorText)
  const takeRetainedEditorText = useSessionStore(s => s.takeRetainedEditorText)
  const runSlashCommand = useSessionStore(s => s.runSlashCommand)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const ordinaryAbort = useSessionStore(s => s.abortGeneration)
  const requestResearchStop = useSessionStore(s => s.requestResearchStop)
  const abortGeneration = useCallback((background = false) => {
    const state = useSessionStore.getState()
    const liveRun = Object.values(state.researchCards).find(card => ['active', 'waiting_input', 'stopping'].includes(card.status))
    if (state.agentMode === 'research' && background && liveRun) {
      const binding = Object.values(state.researchBindings).find(owner => owner.runId === liveRun.runId)
      const detail = useResearchActivityStore.getState().details[liveRun.runId]
      requestResearchStop({kind:'run',runId:liveRun.runId,workspace:liveRun.workspace || binding?.workspace || detail?.run.workspace || '',rootSession:detail?.run.rootSession || binding?.sessionFile || '',sessionId:binding?.sessionId,sessionFile:binding?.sessionFile,streamId:binding?.streamId})
    } else if (state.agentMode === 'research' && state.researchBinding) {
      setResearchError(null)
      // A start with no run id is owned by the research host, never this window's ordinary session.
      if (!state.researchBinding.runId) setResearchCancelling(true)
      const binding = state.researchBinding
      requestResearchStop(binding.runId ? {kind:'run',runId:binding.runId,workspace:binding.workspace,rootSession:binding.sessionFile || '',sessionFile:binding.sessionFile,sessionId:binding.sessionId,streamId:binding.streamId} : state.researchPendingCreationRequestId ? {kind:'startup',requestId:state.researchPendingCreationRequestId,workspace:binding.workspace,sessionId:binding.sessionId,streamId:binding.streamId} : {kind:'turn',workspace:binding.workspace,sessionId:binding.sessionId,streamId:binding.streamId})
    } else if (state.agentMode === 'research' && researchStartingRef.current && researchStartingRequestRef.current) {
      setResearchError(null)
      setResearchCancelling(true)
      cancelResearchStartup(researchStartingRequestRef.current)
    } else ordinaryAbort()
  }, [ordinaryAbort, requestResearchStop])
  const permissionMode = useSessionStore((s) => s.permissionMode)
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode)
  const agentMode = useSessionStore(s => s.agentMode)
  const setAgentMode = useSessionStore(s => s.setAgentMode)
  const currentWorkspace = useSessionStore(s => s.currentWorkspace)
  const isResearch = agentMode === 'research'
  const researchBinding = useSessionStore(s => s.researchBinding)
  const researchConnectionError = useSessionStore(s => s.researchConnectionError)
  const researchLatestDelivery = useSessionStore(s => {
    const rows = s.researchConversation.messages
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]
      if (row.role === 'user' && row.requestId) {
        return `${row.requestId}:${row.deliveryStatus}:${row.submissionError || ''}:${row.executionError || ''}`
      }
    }
    return ''
  })
  const researchCard = useSessionStore(s => s.researchBinding?.runId ? s.researchCards[s.researchBinding.runId] : undefined)
  const backgroundCard = useSessionStore(s => Object.values(s.researchCards).find(card => ['active','stopping','waiting_input'].includes(card.status)))
  const hasActiveBackgroundResearch = isResearch && Boolean(backgroundCard)
  const researchTeam = useSessionStore(s => s.researchTeam)

  const { currentModel, thinkingLevel } = useResearchEditorModel()
  const models = useSettingsStore(s => s.models)

  const modelDisplayName = currentModel ? (currentModel.name || currentModel.modelId) : '选择模型'

  const supportsImageInput = Boolean(currentModel && models.find(model => model.provider === currentModel.provider && model.id === currentModel.modelId)?.input.includes('image'))

  const handleAddAttachments = async () => {
    if (isPickingFiles) return
    const operation = ++attachmentPickerGeneration.current
    const pickerState = useSessionStore.getState()
    const pickerOwner = pickerState.agentMode === 'research' ? pickerState.researchView.ownerKey : null
    setIsPickingFiles(true)
    setAttachmentNotice(null)
    try {
      const paths = await window.app?.pickFiles()
      if (paths?.length) await prepareAttachments(paths, pickerOwner)
    } catch (error) {
      if (attachmentPickerGeneration.current === operation) setAttachmentNotice(error instanceof Error ? error.message : '打开附件选择窗口失败')
    } finally {
      if (attachmentPickerGeneration.current === operation) setIsPickingFiles(false)
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

  useEffect(() => { setResearchError(null) }, [isResearch, researchBinding?.sessionId, researchBinding?.streamId])
  useEffect(() => {
    if (isResearch) return
    researchStartingRef.current = false
    researchStartingRequestRef.current = null
    setResearchStarting(false)
    setResearchCancelling(false)
  }, [isResearch])
  useEffect(() => {
    const message = [...useSessionStore.getState().researchConversation.messages].reverse().find(row => row.role === 'user' && row.requestId)
    // A fast retry can pass through pending and accepted in one React batch.
    // Clear its old local error on either state, not only on a visible pending row.
    if (message && ['pending', 'accepted', 'created'].includes(message.deliveryStatus || '') &&
      !message.submissionError && !message.executionError) setResearchError(null)
  }, [researchLatestDelivery])
  useEffect(() => { if (!researchStarting) setResearchCancelling(false) }, [researchStarting])

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

  // The same textarea survives presentation changes. Re-measure its current controlled
  // draft after the card has its new width; a former multi cap must not linger in chat.
  const resizeEditor = useCallback((limit: number) => {
    const editor = textareaRef.current
    if (!editor) return
    editor.style.height = 'auto'
    editor.style.height = `${Math.min(editor.scrollHeight, limit)}px`
  }, [])
  useLayoutEffect(() => {
    if (presentation === 'multi' || wasMultiPresentation.current) resizeEditor(presentation === 'multi' ? 88 : 180)
    wasMultiPresentation.current = presentation === 'multi'
  }, [presentation, text, resizeEditor])
  useLayoutEffect(() => {
    if (presentation !== 'multi' || !formRef.current || typeof ResizeObserver === 'undefined') return
    const card = formRef.current
    let width = card.getBoundingClientRect().width
    const observer = new ResizeObserver(() => {
      const nextWidth = card.getBoundingClientRect().width
      if (nextWidth === width) return // Height changes must not drive their own resize loop.
      width = nextWidth
      resizeEditor(88)
    })
    observer.observe(card)
    return () => observer.disconnect()
  }, [presentation, resizeEditor])

  const closeComposerMenu = useCallback(() => {
    if (showSendMenu) {
      setShowSendMenu(false)
      sendMenuTriggerRef.current?.focus()
    } else if (showModePicker) {
      setShowModePicker(false)
      modePickerRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    }
  }, [showSendMenu, showModePicker])

  useEscapeLayer(showSendMenu || showModePicker, event => {
    consumeEscape(event)
    closeComposerMenu()
  })

  useEffect(() => {
    if (!showSendMenu && !showModePicker && (!isStreaming || isSessionLoading || isAborting)) return
    const stopOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || composing.current) return
      if (showSendMenu || showModePicker) {
        event.preventDefault()
        closeComposerMenu()
      } else if (!isSessionLoading && !isAborting) abortGeneration()
    }
    document.addEventListener('keydown', stopOnEscape)
    return () => document.removeEventListener('keydown', stopOnEscape)
  }, [isStreaming, isSessionLoading, isAborting, abortGeneration, showSendMenu, showModePicker, closeComposerMenu])

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

  const submitText = (mode: 'steer' | 'followUp' = 'steer', confirmedLimits?: ResearchRunLimits) => {
    const submissionState = useSessionStore.getState()
    if (composing.current) return
    const commandText = text.trim()
    // Stop is control input, not another message: it must pass a pending input's
    // delivery gate, while retaining explicit target and syntax validation.
    if (isResearch && /^\/(?:research\s+)?stop(?:\s|$)/i.test(commandText)) {
      const stopCommand = /^\/(?:research\s+)?stop(?:\s+(\S+))?$/i.exec(commandText)
      if (!stopCommand) {
        setResearchError('停止命令仅接受一个研究 ID；原始输入已保留。')
        return
      }
      if (stopCommand[1] && stopCommand[1] !== submissionState.researchBinding?.runId) {
        setResearchError('停止目标与当前研究不一致，请打开对应的研究会话。')
        return
      }
      if (!submissionState.researchBinding) {
        setResearchError('当前研究宿主尚未就绪，请等待启动完成。')
        return
      }
      if (submissionState.researchConversation.isAborting || researchCancelling) return
      abortGeneration()
      setText('')
      setResearchError(null)
      setShowSendMenu(false)
      return
    }
    if (isResearch && researchStartingRef.current) return
    if (isResearch && !submissionState.researchBinding?.runId && submissionState.researchPendingCreationRequestId) return
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
      if (researchBinding?.runId && researchCard?.status === 'stopping') {
        setResearchError('研究正在停止，请等待停止完成后再发送。')
        return
      }
      if (images.length) {
        setResearchError('研究消息请使用文字或文本附件；图片仍保留在草稿中。')
        return
      }
      useSessionStore.setState({ researchConnectionError: null })
      const requestId = newRequestId('research_input')
      recordResearchSubmissionDiagnostic({ requestId, text: messageText, sessionId: researchBinding?.sessionId })
      let owner = researchBinding
      const editorOwner = submissionState.researchView.ownerKey
      let navigationVersion = submissionState.researchPageVersion
      const ownsContext = () => {
        const current = useSessionStore.getState()
        return current.researchPageVersion === navigationVersion && current.agentMode === 'research' && current.currentWorkspace === currentWorkspace &&
          (owner ? current.researchBinding?.sessionId === owner.sessionId && current.researchBinding?.streamId === owner.streamId : !current.researchBinding)
      }
      // The synchronous gates run BEFORE any busy flag: the old order set researchStarting
      // and then returned, so the finally that clears it never ran and every later send was
      // blocked (2026-10-11 audit; see researchPageView tests).
      if (isResearchNew && hasActiveBackgroundResearch) {
        setResearchError(`当前已有研究正在运行中（${backgroundCard?.question || backgroundCard?.runId}），请先返回或停止当前研究。`)
        return
      }
      const bindingToUse = isResearchNew ? null : researchBinding
      const isStartingNew = isResearchNew || !bindingToUse?.runId
      if (isStartingNew && !confirmedLimits) {
        if (wizardLoading || wizardOptions) return
        setWizardLoading(true)
        void request<ResearchOptionsPayload>('get_research_options').then(options => setWizardOptions(options))
          .catch(error => setResearchError(error instanceof Error ? error.message : String(error)))
          .finally(() => setWizardLoading(false))
        return
      }
      researchStartingRef.current = true
      researchStartingRequestRef.current = requestId
      setResearchStarting(true)
      setResearchError(null)
      void startComposerResearch({ question: messageText, workspace: bindingToUse?.workspace || currentWorkspace,
        model: currentModel, thinkingLevel, binding: bindingToUse, requestId, startNew: isStartingNew,
        ...(confirmedLimits ? { limits: confirmedLimits } : {}),
        lastOrderModel: isStartingNew ? submissionState.researchEditors[editorOwner]?.lastOrderModel : null,
        onBound: host => {
          const mayNavigate = ownsContext()
          useSessionStore.getState().bindResearchConversation(host)
          const capturedBinding = {sessionId:host.session.sessionId, sessionFile:host.session.file, workspace:host.session.cwd, runId:host.run?.id || null, streamId:host.streamId}
          useSessionStore.getState().queueResearchMessage(requestId, messageText, capturedBinding)
          owner = capturedBinding
          if (!mayNavigate) return
          useSessionStore.getState().selectResearchView({kind:'conversation', sessionId:host.session.sessionId, ownerKey:`conversation:${host.session.sessionId}`})
          navigationVersion = useSessionStore.getState().researchPageVersion
          owner = useSessionStore.getState().researchBinding
          useSessionStore.getState().queueResearchMessage(requestId, messageText)
        },
        onSubmission: submission => {
          if (!owner) return
          useSessionStore.getState().rememberResearchSubmission(requestId, submission, {
            text, ownerKey:editorOwner, attachmentIdentities: attachments.map(item => ({attachmentId:'attachmentId' in item ? String(item.attachmentId) : item.path,preparationId:'preparationId' in item ? String(item.preparationId) : ''})), attachmentPaths: attachments.map(item => item.path), sessionId: owner.sessionId, streamId: owner.streamId, mode: 'research', revision: submissionState.draftRevision,
          })
        },
        onAccepted: () => useSessionStore.getState().acceptResearchMessage(requestId),
        onUnconfirmed: (error, reconciled) => useSessionStore.getState().unconfirmResearchMessage(requestId, error.message, (error as Error & { retryable?: boolean }).retryable, reconciled, error),
      }).then(host => {
        useSessionStore.getState().bindResearchConversation(host)
        useSessionStore.getState().clearResearchEditor(editorOwner, submissionState.draftRevision, attachments.map(item => ({attachmentId:'attachmentId' in item ? String(item.attachmentId) : item.path,preparationId:'preparationId' in item ? String(item.preparationId) : ''})))
        if (!ownsContext()) return
        const state = useSessionStore.getState()
        if (state.researchView.ownerKey === editorOwner && state.draft === text && state.draftRevision === submissionState.draftRevision && state.attachments.length === attachments.length && state.attachments.every((item, index) => item === attachments[index])) {
          setText('')
          for (const attachment of attachments) removeAttachment(attachment.path)
        }
        if (host.syncError) useSessionStore.setState({ researchConnectionError: host.syncError })
        setAttachmentNotice(null)
        setShowSendMenu(false)
        useSessionStore.getState().fetchResearchRuns()
        onResearchStarted?.()
      }).catch(error => {
        const message = error instanceof Error ? error.message : String(error)
        const state = useSessionStore.getState()
        if (isResearchStartupFailure(error)) state.failResearchExecution(requestId, message, error)
        else if ((error instanceof Error && error.name === 'ResearchRequestTimeoutError') || error?.errorCode === 'RESEARCH_DELIVERY_UNCONFIRMED') state.unconfirmResearchMessage(requestId, message, error?.retryable, undefined, error)
        else state.failResearchMessage(requestId, message, error?.retryable, error)
        if (ownsContext()) setResearchError(message)
      }).finally(() => {
        if (researchStartingRequestRef.current !== requestId) return
        researchStartingRef.current = false
        researchStartingRequestRef.current = null
        setResearchStarting(false)
      })
      return
    }
    if (images.length) sendMessage(messageText, mode, images)
    else sendMessage(messageText, mode)
    setText('')
    setResearchError(null)
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
    e.target.style.height = Math.min(e.target.scrollHeight, presentation === 'multi' ? 88 : 180) + 'px'
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
  const sendLabel = isStreaming ? '干预当前运行 (Enter)' : isResearch ? (researchBinding?.runId ? '发送给根协调 Last Order (Enter)' : '开始研究 (Enter)') : '发送指令 (Enter)'
  // A start without a run id is cancelled on the research host, so its button is never the ordinary abort.
  const cancellingStartup = isResearch && researchStarting && !researchBinding?.runId
  // Say which step the startup is on, so a slow deep-research initialization does not read as
  // a frozen app: recruitment has its own visible ending, and the planner takes over after it.
  const recruitedCount = researchTeam?.members.length ?? 0
  const researchStartupLabel = recruitedCount
    ? `研究团队已就绪（${recruitedCount} 名成员），正在启动研究规划…`
    : '正在准备研究团队…（招募可能需要数分钟，可随时取消）'
  const stopLabel = isResearchNew && hasActiveBackgroundResearch ? '停止后台研究' : cancellingStartup ? (researchCancelling ? '取消中' : '取消研究启动') : isAborting ? '停止中' : '中止生成 (Esc)'
  const stopDisabled = cancellingStartup ? researchCancelling : Boolean(pendingLabel)
  const hasStopButton = isStreaming || hasActiveBackgroundResearch || (isResearch && (isAborting || researchStarting))

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
          data-composer-presentation={presentation === 'multi' ? 'multi' : undefined}
          data-composer-expanded-stop={presentation === 'multi' && hasStopButton && (isAborting || researchCancelling) ? 'true' : undefined}
          data-composer-dense-operations={presentation === 'multi' && (isStreaming || Boolean(pendingLabel)) ? 'true' : undefined}
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
          {isResearchNew && hasActiveBackgroundResearch && (
            <div className="flex items-center justify-between px-3 py-2 rounded-xl border border-warning-border bg-warning-surface text-warning text-xs">
              <div className="flex items-center gap-2 truncate min-w-0">
                <span className="font-medium shrink-0">已有研究正在后台进行中：</span>
                <span className="truncate opacity-90">{backgroundCard?.question || backgroundCard?.runId}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-2">
                <button
                  type="button"
                  onClick={() => {
                    if (!backgroundCard) return
                    const version=useSessionStore.getState().researchPageVersion
                    void openResearchConversation(backgroundCard.runId,backgroundCard.workspace).then(snapshot=>{
                      const state=useSessionStore.getState(); state.bindResearchConversation(snapshot)
                      if (state.researchPageVersion === version) state.selectResearchView({kind:'conversation',ownerKey:`conversation:${snapshot.session.sessionId}`,sessionId:snapshot.session.sessionId})
                    }).catch(error=>setResearchError(error instanceof Error ? error.message : String(error)))
                  }}
                  className="px-2.5 py-1 rounded-md bg-surface-2 hover:bg-surface-3 text-text-main text-[11px] font-medium transition-colors cursor-pointer"
                >
                  返回当前研究
                </button>
                <button
                  type="button"
                  disabled={researchCancelling || isAborting}
                  onClick={() => {
                    if (window.confirm('确定要停止当前正在进行的研究吗？已完成的卡片和证据将被保存。')) {
                      abortGeneration(true)
                    }
                  }}
                  className="px-2.5 py-1 rounded-md bg-danger/20 hover:bg-danger/30 text-danger text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-50"
                >
                  停止当前研究
                </button>
              </div>
            </div>
          )}
          {isResearch && (researchError || researchConnectionError) && <div role="alert" className="text-[11px] text-danger">{researchError || researchConnectionError}</div>}
          {researchStarting && !researchBinding?.runId && <div role="status" className="text-[11px] text-dim">{researchStartupLabel}</div>}

          {/* Bottom Toolbar */}
          <div className="conversation-composer-toolbar flex items-center justify-between pt-1 border-t border-border-subtle/50 text-xs select-none">
            {/* Left Controls: Plus + Mode Picker */}
            <div className="conversation-composer-context-controls flex items-center gap-2">
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
                  title="点击切换 Agent 模式；权限设置仅对当前会话生效"
                >
                  <CurrentModeIcon className={"w-3.5 h-3.5 " + currentModeConfig.badgeColor} />
                  <span className={currentModeConfig.badgeColor}>{currentModeConfig.label}</span>
                  <ChevronDown className="w-3 h-3 text-dim" />
                </button>

                {/* Mode Selection Popover */}
                {showModePicker && (
                  <div className="conversation-permission-popover misaka-glass-popover absolute bottom-full left-0 mb-2 w-72 max-h-[min(24rem,calc(100dvh-10rem))] overflow-y-auto rounded-xl bg-card border border-border-subtle shadow-e3 p-2 z-50 text-xs space-y-1">
                    <div className="px-2 py-1 text-[11px] font-semibold text-text-main border-b border-border-subtle">
                      选择 Agent 模式（权限仅当前会话生效）
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

            {isResearch && (
              <button
                type="button"
                onClick={() => {
                  setResearchPageView(researchPageView === 'new' ? 'conversation' : 'new')
                  setResearchError(null)
                }}
                className="conversation-new-research-trigger text-[11px] text-muted hover:text-accent font-medium transition-colors cursor-pointer"
                title={researchPageView === 'new' ? '返回正在进行的研究对话' : '开启新研究入口（后台研究继续运行）'}
              >
                {researchPageView === 'new' ? (researchBinding ? '返回当前研究' : '新研究') : '新研究'}
              </button>
            )}

            {/* Right Controls: Model Pill + Submit Button */}
            <div className="conversation-composer-operation-controls flex items-center gap-2.5">
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
                  <span className="truncate max-w-[140px]" title={presentation === 'multi' ? modelDisplayName : undefined}>{modelDisplayName}</span>
                  <span className="conversation-model-compact-icon hidden" title={presentation === 'multi' ? modelDisplayName : undefined} aria-hidden="true"><Cpu className="w-4 h-4" /></span>
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
              {hasStopButton && <button type="button" onClick={() => abortGeneration(isResearchNew && hasActiveBackgroundResearch)} disabled={stopDisabled}
                aria-label={stopLabel} title={stopLabel}
                className="conversation-stop-button h-8 min-w-8 px-2 rounded-full flex items-center justify-center gap-1 bg-danger text-on-danger hover:opacity-90 disabled:opacity-50 disabled:cursor-wait">
                {(isAborting || researchCancelling) ? <><Loader2 className="w-4 h-4 animate-spin" /><span className="text-[11px]">{stopLabel}</span></> : <Square className="w-3.5 h-3.5 fill-current" />}
              </button>}
            </div>
          </div>
        </form>
      </div>
      {wizardOptions && <ResearchRunWizard options={wizardOptions} onCancel={() => setWizardOptions(null)} onConfirm={limits => {
        setWizardOptions(null)
        submitText('steer', limits)
      }} />}
    </div>
  )
}
