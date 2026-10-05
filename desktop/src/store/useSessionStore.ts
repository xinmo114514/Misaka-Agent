import { create } from 'zustand'
import type { ChatMessage, PermissionMode, PermissionRequestPayload, ProjectGroup, SessionFilterScope, SessionInfoOut, ToolCall } from '../types/session'
import type { ResearchGraphPayload, ResearchRunSummary } from '../types/research'
import type { BridgeMessage } from '../types/global'

const STORAGE_RECENT_WORKSPACES_KEY = 'misaka_recent_workspaces'

export function projectNameForCwd(cwd: string): string {
  if (!cwd) return '未分组'
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : cwd
}

export function normalizeWorkspacePath(path: string): string {
  if (!path) return ''
  return path.trim().replace(/[\\/]+$/, '').toLowerCase()
}

function loadRecentWorkspaces(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_RECENT_WORKSPACES_KEY)
    if (raw) {
      const list = JSON.parse(raw)
      if (Array.isArray(list)) {
        return list.filter((p): p is string => typeof p === 'string' && !!p.trim())
      }
    }
  } catch {
    // fallback
  }
  return []
}

function saveRecentWorkspaces(paths: string[]): void {
  try {
    localStorage.setItem(STORAGE_RECENT_WORKSPACES_KEY, JSON.stringify(paths.slice(0, 10)))
  } catch {
    // ignore
  }
}

function addRecentWorkspace(path: string, current: string[]): string[] {
  if (!path || !path.trim()) return current
  const norm = normalizeWorkspacePath(path)
  const next = [path.trim(), ...current.filter((p) => normalizeWorkspacePath(p) !== norm)]
  return next.slice(0, 10)
}

interface SessionState {
  currentSessionId: string
  currentTitle: string
  currentSessionPath: string | null
  currentWorkspace: string
  recentWorkspaces: string[]
  sessionFilterScope: SessionFilterScope
  isStreaming: boolean
  /** The assistant message currently being streamed, by id. Deltas key on this, not on position. */
  streamingMessageId: string | null
  messages: ChatMessage[]
  sessions: SessionInfoOut[]
  projects: ProjectGroup[]
  researchRuns: ResearchRunSummary[]
  researchGraph: ResearchGraphPayload | null
  researchRunId: string | null
  currentModel: {
    provider: string
    modelId: string
    name: string
    thinking: string
  }
  permissionMode: PermissionMode
  pendingPermissionRequest: PermissionRequestPayload | null

  // Actions
  sendMessage: (text: string, streamingBehavior?: 'steer' | 'followUp') => void
  abortGeneration: () => void
  handleBridgeMessage: (msg: BridgeMessage) => void
  fetchSessions: () => void
  openSession: (path: string) => void
  createSession: (carryOverContext?: boolean) => void
  switchWorkspace: (workspacePath: string, targetSessionPath?: string) => void
  openWorkspaceDialog: () => Promise<string | null>
  setSessionFilterScope: (scope: SessionFilterScope) => void
  renameSession: (path: string, name: string) => void
  deleteSession: (path: string) => void
  forkSession: (entryId: string | null, position?: 'before' | 'at') => void
  exportSession: (path: string) => void
  fetchResearchRuns: () => void
  fetchResearchGraph: (runId?: string) => void
  setPermissionMode: (mode: PermissionMode) => void
  respondPermission: (requestId: string, decision: 'allow' | 'deny', scope?: 'once' | 'session', feedback?: string) => void
}

// Micro-batch buffer for rAF scheduling.
//
// Keyed to the turn actually being streamed. The deltas used to land on "whatever message is last"
// at flush time, so a steer (which puts a user bubble after the streaming assistant) or a session
// switch could append one turn's text into another turn's body. A flush whose target is gone just
// drops the fragment: an authoritative `message_end` replaces the whole message anyway.
const buffer: { targetId: string | null; text: string; thinking: string } = {
  targetId: null,
  text: '',
  thinking: '',
}
let rafId: number | null = null

function bufferDeltas(targetId: string, text: string, thinking: string): void {
  if (buffer.targetId !== targetId) {
    buffer.targetId = targetId
    buffer.text = ''
    buffer.thinking = ''
  }
  buffer.text += text
  buffer.thinking += thinking
}

function resetDeltaBuffer(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  buffer.targetId = null
  buffer.text = ''
  buffer.thinking = ''
}

/** Title for a session row: its saved name, else first user message, else a fallback. */
function deriveTitle(s: SessionInfoOut): string {
  const name = (s.name || '').trim()
  if (name) return name
  const first = (s.firstMessage || '').trim()
  if (first && first !== '(no messages)') return first.length > 60 ? `${first.slice(0, 60)}…` : first
  return '新对话'
}

/** A persisted transcript row from the bridge, in the timeline's shape. */
function toChatMessage(m: any): ChatMessage {
  return {
    id: m.id,
    entryId: m.entryId,
    role: m.role,
    content: m.content || '',
    customType: m.customType,
    details: m.details,
    display: m.display,
    thinking: m.thinking,
    toolCalls: m.toolCalls,
    timestamp: m.timestamp || Date.now(),
    tokens: m.tokens,
  }
}

/** Group sessions by cwd (project), newest first inside each group. */
function groupSessions(sessions: SessionInfoOut[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>()
  for (const s of sessions) {
    const key = s.cwd || ''
    if (!groups.has(key)) {
      groups.set(key, { id: key || 'ungrouped', name: projectNameForCwd(key), sessions: [] })
    }
    groups.get(key)!.sessions.push({
      id: s.id,
      path: s.path,
      cwd: s.cwd,
      title: deriveTitle(s),
      modified: s.modified,
      messageCount: s.messageCount,
    })
  }
  for (const group of groups.values()) {
    group.sessions.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0))
  }
  return [...groups.values()].sort((a, b) => {
    const aLatest = a.sessions[0]?.modified || ''
    const bLatest = b.sessions[0]?.modified || ''
    return aLatest < bLatest ? 1 : aLatest > bLatest ? -1 : 0
  })
}

let pendingOpen: { path: string; timer: number } | null = null

function sendBridge(cmd: Record<string, any>) {
  if (window.bridge?.send) window.bridge.send(cmd)
}

export const useSessionStore = create<SessionState>((set, get) => ({
  currentSessionId: '',
  currentTitle: '新对话',
  currentSessionPath: null,
  currentWorkspace: '',
  recentWorkspaces: loadRecentWorkspaces(),
  sessionFilterScope: 'here',
  isStreaming: false,
  permissionMode: 'default',
  pendingPermissionRequest: null,
  currentModel: {
    provider: 'deepseek',
    modelId: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    thinking: '高',
  },
  sessions: [],
  projects: [],
  researchRuns: [],
  researchGraph: null,
  researchRunId: null,
  messages: [],
  streamingMessageId: null,

  sendMessage: (text: string, streamingBehavior?: 'steer' | 'followUp') => {
    const trimmed = text.trim()
    if (!trimmed) return
    const streaming = get().isStreaming
    // While a turn runs the bridge refuses a plain prompt (it needs to know whether this message
    // redirects the turn or waits for it), and refusing silently made the composer a dead button.
    if (streaming && !streamingBehavior) return

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
    }

    if (streaming) {
      // The turn already streaming keeps streaming; no placeholder, or the live tail would show
      // an empty answer beside the one still arriving.
      set((state) => ({ messages: [...state.messages, userMessage] }))
    } else {
      const assistantPlaceholder: ChatMessage = {
        id: `assistant-${Date.now() + 1}`,
        role: 'assistant',
        content: '',
        thinking: '',
        timestamp: Date.now(),
        isStreaming: true,
      }
      resetDeltaBuffer()
      set((state) => ({
        messages: [...state.messages, userMessage, assistantPlaceholder],
        isStreaming: true,
        streamingMessageId: assistantPlaceholder.id,
      }))
    }

    if (window.bridge?.send) {
      window.bridge.send({
        type: 'prompt',
        requestId: `req-${Date.now()}`,
        text: trimmed,
        ...(streamingBehavior ? { streamingBehavior } : {}),
      })
    }
  },

  abortGeneration: () => {
    if (window.bridge?.send) {
      window.bridge.send({
        type: 'abort',
        requestId: `abort-${Date.now()}`,
      })
    }
    resetDeltaBuffer()
    const target = get().streamingMessageId
    set((state) => ({
      isStreaming: false,
      streamingMessageId: null,
      // The turn that was streaming, not the last row: a steer puts a user bubble after it.
      messages: state.messages.map((m) => (target && m.id === target ? { ...m, isStreaming: false } : m)),
    }))
  },

  fetchSessions: () => {
    sendBridge({ type: 'list_sessions', requestId: `req_ls_${Date.now()}` })
  },

  openSession: (path: string) => {
    const requestId = `req_load_${Date.now()}`
    if (pendingOpen) window.clearTimeout(pendingOpen.timer)
    const timer = window.setTimeout(() => {
      if (pendingOpen?.path === path) {
        pendingOpen = null
        resetDeltaBuffer()
        set({ isStreaming: false, streamingMessageId: null })
      }
    }, 8000)
    pendingOpen = { path, timer }
    set({ isStreaming: true })
    sendBridge({ type: 'load_session', requestId, path })
  },

  createSession: (carryOverContext = false) => {
    set({ isStreaming: true })
    sendBridge({
      type: 'new_session',
      requestId: `req_new_${Date.now()}`,
      carryOverContext,
      cwd: get().currentWorkspace || undefined,
    })
  },

  switchWorkspace: (workspacePath: string, targetSessionPath?: string) => {
    const normalized = workspacePath.trim()
    if (!normalized) return
    const updatedRecent = addRecentWorkspace(normalized, get().recentWorkspaces)
    saveRecentWorkspaces(updatedRecent)
    set({
      isStreaming: true,
      currentWorkspace: normalized,
      recentWorkspaces: updatedRecent,
    })
    const requestId = `req_sw_${Date.now()}`
    sendBridge({
      type: 'switch_workspace',
      requestId,
      path: normalized,
      sessionPath: targetSessionPath,
    })
  },

  openWorkspaceDialog: async () => {
    if (window.app?.pickDirectory) {
      const chosen = await window.app.pickDirectory()
      if (chosen) {
        get().switchWorkspace(chosen)
        return chosen
      }
    }
    return null
  },

  setSessionFilterScope: (scope: SessionFilterScope) => {
    set({ sessionFilterScope: scope })
  },

  renameSession: (path: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    sendBridge({ type: 'rename_session', requestId: `req_rn_${Date.now()}`, path, name: trimmed })
    get().fetchSessions()
  },

  deleteSession: (path: string) => {
    sendBridge({ type: 'delete_session', requestId: `req_del_${Date.now()}`, path })
    setTimeout(() => get().fetchSessions(), 300)
  },

  forkSession: (entryId: string | null, position: 'before' | 'at' = 'before') => {
    set({ isStreaming: true })
    sendBridge({
      type: 'fork_session',
      requestId: `req_fork_${Date.now()}`,
      entryId: entryId || undefined,
      position,
    })
  },

  exportSession: (path: string) => {
    sendBridge({ type: 'export_session', requestId: `req_export_${Date.now()}`, path })
  },

  fetchResearchRuns: () => {
    sendBridge({ type: 'list_research_runs', requestId: `req_runs_${Date.now()}` })
  },

  fetchResearchGraph: (runId?: string) => {
    sendBridge({ type: 'get_research_graph', requestId: `req_graph_${Date.now()}`, runId: runId || undefined })
  },

  setPermissionMode: (mode: PermissionMode) => {
    set({ permissionMode: mode })
    sendBridge({
      type: 'set_permission_mode',
      requestId: `req_perm_${Date.now()}`,
      mode,
    })
  },

  respondPermission: (requestId: string, decision: 'allow' | 'deny', scope = 'once', feedback?: string) => {
    set((state) => ({
      pendingPermissionRequest:
        state.pendingPermissionRequest?.requestId === requestId ? null : state.pendingPermissionRequest,
    }))
    sendBridge({
      type: 'permission_response',
      requestId,
      decision,
      scope,
      feedback,
    })
  },

  handleBridgeMessage: (msg: BridgeMessage) => {
    if ('type' in msg && msg.type === 'ack') {
      const data = msg.data || {}
      // list_sessions reply: refresh the sidebar groups.
      if (msg.requestId && msg.requestId.startsWith('req_ls_') && msg.ok) {
        const list: SessionInfoOut[] = data.sessions || []
        const currentWs = get().currentWorkspace
        let nextWs = currentWs
        let nextRecent = get().recentWorkspaces
        if (!nextWs && list.length > 0 && list[0].cwd) {
          nextWs = list[0].cwd
          nextRecent = addRecentWorkspace(nextWs, nextRecent)
          saveRecentWorkspaces(nextRecent)
        }
        set((state) => ({
          sessions: list,
          projects: groupSessions(list),
          currentWorkspace: nextWs,
          recentWorkspaces: nextRecent,
          currentTitle: state.currentSessionPath
            ? list.find((s) => s.path === state.currentSessionPath)?.name || state.currentTitle
            : state.currentTitle,
        }))
        return
      }

      // switch_workspace reply: update workspace, session and transcript.
      const isSwitch = msg.requestId && msg.requestId.startsWith('req_sw_')
      if (isSwitch && msg.ok) {
        const sessionInfo = data.session || {}
        const messages: ChatMessage[] = (data.messages || []).map(toChatMessage)
        const path = sessionInfo.file || null
        const ws = sessionInfo.cwd || data.workspace || get().currentWorkspace
        const updatedRecent = ws ? addRecentWorkspace(ws, get().recentWorkspaces) : get().recentWorkspaces
        saveRecentWorkspaces(updatedRecent)
        set({
          currentSessionId: sessionInfo.sessionId || '',
          currentSessionPath: path,
          currentTitle: sessionInfo.name || '新对话',
          currentWorkspace: ws,
          recentWorkspaces: updatedRecent,
          messages,
          isStreaming: false,
          streamingMessageId: null,
        })
        get().fetchSessions()
        return
      }
      if (isSwitch && !msg.ok) {
        resetDeltaBuffer()
        set({ isStreaming: false, streamingMessageId: null })
        return
      }

      // load_session / fork_session reply: hydrate the (new) transcript.
      const isLoad = msg.requestId && msg.requestId.startsWith('req_load_')
      const isFork = msg.requestId && msg.requestId.startsWith('req_fork_')
      if ((isLoad || isFork) && msg.ok) {
        if (pendingOpen) {
          window.clearTimeout(pendingOpen.timer)
          pendingOpen = null
        }
        const sessionInfo = data.session || {}
        const messages: ChatMessage[] = (data.messages || []).map(toChatMessage)
        const path = sessionInfo.file || null
        const existing = path ? get().sessions.find((s) => s.path === path) : undefined
        const ws = sessionInfo.cwd || get().currentWorkspace
        const updatedRecent = ws ? addRecentWorkspace(ws, get().recentWorkspaces) : get().recentWorkspaces
        saveRecentWorkspaces(updatedRecent)
        set({
          currentSessionId: sessionInfo.sessionId || '',
          currentSessionPath: path,
          currentTitle: sessionInfo.name || (existing ? deriveTitle(existing) : '新对话'),
          currentWorkspace: ws,
          recentWorkspaces: updatedRecent,
          messages,
          isStreaming: false,
          streamingMessageId: null,
        })
        get().fetchSessions()
        return
      }
      // A failed fork/load must clear the busy flag too.
      if ((isLoad || isFork) && !msg.ok) {
        resetDeltaBuffer()
        set({ isStreaming: false, streamingMessageId: null })
        return
      }
      // list_research_runs reply.
      if (msg.requestId && msg.requestId.startsWith('req_runs_') && msg.ok) {
        set({ researchRuns: data.runs || [] })
        return
      }
      // get_research_graph reply.
      if (msg.requestId && msg.requestId.startsWith('req_graph_') && msg.ok) {
        const graph: ResearchGraphPayload | null = data.graph || null
        set({ researchGraph: graph, researchRunId: data.run?.id || null })
        return
      }
      if (!msg.ok) {
        resetDeltaBuffer()
        set({ isStreaming: false, streamingMessageId: null })
      }
      return
    }

    if (!('event' in msg) || !msg.event) return
    const ev = msg.event
    const evType = ev.type

    // Session lifecycle: rebind/reset the view for the newly active session.
    if (evType === 'session_started') {
      if (pendingOpen) {
        window.clearTimeout(pendingOpen.timer)
        pendingOpen = null
      }
      // A new session is a new turn owner: anything buffered for the previous one is stale.
      resetDeltaBuffer()
      const ws = ev.cwd || get().currentWorkspace || ''
      const updatedRecent = ws ? addRecentWorkspace(ws, get().recentWorkspaces) : get().recentWorkspaces
      saveRecentWorkspaces(updatedRecent)
      set({
        currentSessionId: ev.sessionId || '',
        currentSessionPath: ev.file || get().currentSessionPath,
        currentTitle: ev.name || '新对话',
        currentWorkspace: ws,
        recentWorkspaces: updatedRecent,
        messages: [],
        isStreaming: false,
        streamingMessageId: null,
        permissionMode: (ev.permissionMode as PermissionMode) || get().permissionMode,
      })
      get().fetchSessions()
      return
    }

    if (evType === 'permission:request') {
      set({
        pendingPermissionRequest: {
          requestId: ev.requestId,
          toolName: ev.toolName,
          toolInput: ev.toolInput || {},
          reason: ev.reason,
          mode: ev.mode,
          agentId: ev.agentId,
        },
      })
      return
    }

    if (evType === 'permission_mode_change') {
      if (ev.mode) {
        set({ permissionMode: ev.mode as PermissionMode })
      }
      return
    }

    if (evType === 'session_info_changed') {
      set({ currentTitle: ev.name || get().currentTitle })
      get().fetchSessions()
      return
    }

    // 1. message_update: Buffer deltas into rAF queue
    if (evType === 'message_update') {
      const assistantEvent = ev.assistantMessageEvent
      const targetId = get().streamingMessageId
      if (assistantEvent && targetId) {
        if (assistantEvent.type === 'text_delta') {
          bufferDeltas(targetId, assistantEvent.delta || '', '')
        } else if (assistantEvent.type === 'thinking_delta') {
          bufferDeltas(targetId, '', assistantEvent.delta || '')
        } else if (assistantEvent.type === 'toolcall_start') {
          set((state) => {
            const index = state.messages.findIndex((m) => m.id === targetId)
            if (index < 0) return state
            const current = state.messages[index]
            const toolCalls: ToolCall[] = current.toolCalls ? [...current.toolCalls] : []
            if (!toolCalls.some((tc) => tc.id === assistantEvent.id)) {
              toolCalls.push({
                id: assistantEvent.id,
                name: assistantEvent.toolName || 'tool',
                status: 'running',
                arguments: {},
              })
            }
            const list = [...state.messages]
            list[index] = { ...current, toolCalls }
            return { messages: list }
          })
        }
      }

      if (rafId === null && (buffer.text || buffer.thinking)) {
        rafId = requestAnimationFrame(() => {
          rafId = null
          const target = buffer.targetId
          const tDelta = buffer.text
          const thDelta = buffer.thinking
          buffer.text = ''
          buffer.thinking = ''

          if (!tDelta && !thDelta) return

          set((state) => {
            const index = target ? state.messages.findIndex((m) => m.id === target) : -1
            if (index < 0) return state   // that turn is gone; message_end is authoritative anyway
            const current = state.messages[index]
            const list = [...state.messages]
            list[index] = {
              ...current,
              content: current.content + tDelta,
              thinking: (current.thinking || '') + thDelta,
              isStreaming: true,
            }
            return { messages: list }
          })
        })
      }
    }

    // 2. message_end: Authoritative full replacement
    else if (evType === 'message_end') {
      resetDeltaBuffer()

      const rawMsg = ev.message || {}

      if (rawMsg.role === 'toolResult') {
        set((state) => {
          const list = [...state.messages]
          for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].toolCalls) {
              const tc = list[i].toolCalls?.find((c) => c.id === rawMsg.toolCallId)
              if (tc) {
                tc.status = rawMsg.isError ? 'error' : 'success'
                tc.result = rawMsg.content
                break
              }
            }
          }
          return { messages: list }
        })
        return
      }

      // A research run reports itself to its own conversation as custom messages
      // (research-progress and friends); the timeline is the only place a user sees them.
      if (rawMsg.role === 'custom') {
        const blocks = Array.isArray(rawMsg.content) ? rawMsg.content : []
        const text = blocks.length
          ? blocks.filter((b: any) => b?.type === 'text').map((b: any) => b.text || '').join('')
          : String(rawMsg.content ?? '')
        set((state) => ({
          messages: [
            ...state.messages,
            {
              id: `custom-${rawMsg.timestamp || Date.now()}-${state.messages.length}`,
              role: 'custom',
              content: text,
              customType: rawMsg.customType || '',
              details: rawMsg.details || {},
              display: rawMsg.display !== false,
              timestamp: rawMsg.timestamp || Date.now(),
            },
          ],
        }))
        return
      }

      if (rawMsg.role === 'assistant') {
        let fullText = ''
        let fullThinking = ''
        const toolCalls: ToolCall[] = []

        const contentBlocks = Array.isArray(rawMsg.content)
          ? rawMsg.content
          : []
        for (const block of contentBlocks) {
          if (block.type === 'text') {
            fullText += block.text || ''
          } else if (block.type === 'thinking') {
            fullThinking += block.thinking || ''
          } else if (block.type === 'toolCall') {
            toolCalls.push({
              id: block.id,
              name: block.name,
              arguments: block.arguments,
              status: 'success',
            })
          }
        }

        set((state) => {
          const list = [...state.messages]
          // Replace the turn that was streaming. Falling back to the last assistant row keeps a
          // reopened session working, where no placeholder was ever made.
          let index = state.streamingMessageId
            ? list.findIndex((m) => m.id === state.streamingMessageId)
            : -1
          if (index < 0) {
            for (let i = list.length - 1; i >= 0; i--) {
              if (list[i].role === 'assistant') {
                index = i
                break
              }
            }
          }
          if (index >= 0) {
            list[index] = {
              ...list[index],
              content: fullText || list[index].content,
              thinking: fullThinking || list[index].thinking,
              toolCalls: toolCalls.length > 0 ? toolCalls : list[index].toolCalls,
              isStreaming: false,
              stopReason: rawMsg.stopReason,
              errorMessage: rawMsg.errorMessage,
              tokens: rawMsg.usage
                ? {
                    input: rawMsg.usage.input,
                    output: rawMsg.usage.output,
                    total: rawMsg.usage.totalTokens,
                  }
                : undefined,
            }
          }
          return { messages: list, isStreaming: false, streamingMessageId: null }
        })
        // A first turn persists the transcript; refresh so the sidebar picks it up.
        get().fetchSessions()
      }
    } else if (evType === 'agent_settled' || evType === 'agent_end') {
      resetDeltaBuffer()
      set({ isStreaming: false, streamingMessageId: null })
    }
  },
}))
