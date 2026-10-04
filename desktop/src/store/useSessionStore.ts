import { create } from 'zustand'
import type { ChatMessage, ProjectGroup, ToolCall } from '../types/session'
import type { BridgeMessage } from '../types/global'

interface SessionState {
  currentSessionId: string
  currentTitle: string
  isStreaming: boolean
  messages: ChatMessage[]
  projects: ProjectGroup[]
  currentModel: {
    provider: string
    modelId: string
    name: string
    thinking: string
  }

  // Actions
  sendMessage: (text: string) => void
  abortGeneration: () => void
  handleBridgeMessage: (msg: BridgeMessage) => void
  selectSession: (sessionId: string, title: string) => void
  newSession: () => void
}

// Micro-batch buffer for rAF scheduling
let pendingTextDelta = ''
let pendingThinkingDelta = ''
let rafId: number | null = null

export const useSessionStore = create<SessionState>((set, get) => ({
  currentSessionId: 'session-main',
  currentTitle: '实现 Misaka-Agent 桌面客户端',
  isStreaming: false,
  currentModel: {
    provider: 'deepseek',
    modelId: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    thinking: '高',
  },
  projects: [
    {
      id: 'proj-misaka',
      name: 'Misaka-Agent',
      sessions: [
        {
          id: 'session-main',
          title: '实现 Misaka-Agent 桌面客户端',
          active: true,
          modified: '刚刚',
        },
      ],
    },
    {
      id: 'proj-xinchat',
      name: 'XinChat',
      sessions: [
        {
          id: 'session-xin-1',
          title: '排查 Edge 网站打不开问题',
          active: false,
          modified: '昨天',
        },
        {
          id: 'session-xin-2',
          title: '写视频简介',
          active: false,
          modified: '3天前',
        },
      ],
    },
    {
      id: 'proj-rewards',
      name: 'rewards-fix',
      sessions: [
        {
          id: 'session-rewards-1',
          title: '搜索 GPT6SOL GPTplus token 信息',
          active: false,
          modified: '9月28日',
        },
      ],
    },
    {
      id: 'proj-new',
      name: 'New project',
      sessions: [
        {
          id: 'session-new-1',
          title: '查看 Downloads 目录文件',
          active: false,
          modified: '9月25日',
        },
        {
          id: 'session-new-2',
          title: '将第二张图角色Q版化',
          active: false,
          modified: '9月22日',
        },
      ],
    },
  ],
  messages: [
    {
      id: 'welcome-assistant',
      role: 'assistant',
      content:
        '我是 **MISAKA** 协作研究系统中的一名领域专家（Sister），专注于人文社科研究任务的规划与执行。\n\n当前已就绪桌面客户端环境，随时可以输入任务指令。',
      thinking:
        '系统初始化就绪：已载入暗色主题令牌，完成与 Python 后端长连接通信通道绑定。准备响应用户请求。',
      timestamp: Date.now() - 60000,
    },
  ],

  sendMessage: (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || get().isStreaming) return

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
    }

    const assistantPlaceholder: ChatMessage = {
      id: `assistant-${Date.now() + 1}`,
      role: 'assistant',
      content: '',
      thinking: '',
      timestamp: Date.now(),
      isStreaming: true,
    }

    set((state) => ({
      messages: [...state.messages, userMessage, assistantPlaceholder],
      isStreaming: true,
    }))

    if (window.bridge?.send) {
      window.bridge.send({
        type: 'prompt',
        requestId: `req-${Date.now()}`,
        text: trimmed,
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
    set((state) => ({
      isStreaming: false,
      messages: state.messages.map((m, idx) =>
        idx === state.messages.length - 1 ? { ...m, isStreaming: false } : m,
      ),
    }))
  },

  selectSession: (sessionId: string, title: string) => {
    set((state) => ({
      currentSessionId: sessionId,
      currentTitle: title,
      projects: state.projects.map((p) => ({
        ...p,
        sessions: p.sessions.map((s) => ({
          ...s,
          active: s.id === sessionId,
        })),
      })),
    }))
  },

  newSession: () => {
    const newId = `session-${Date.now()}`
    const newTitle = '新对话'
    set((state) => ({
      currentSessionId: newId,
      currentTitle: newTitle,
      messages: [],
      isStreaming: false,
      projects: state.projects.map((p, idx) =>
        idx === 0
          ? {
              ...p,
              sessions: [
                { id: newId, title: newTitle, active: true, modified: '刚刚' },
                ...p.sessions.map((s) => ({ ...s, active: false })),
              ],
            }
          : { ...p, sessions: p.sessions.map((s) => ({ ...s, active: false })) },
      ),
    }))
  },

  handleBridgeMessage: (msg: BridgeMessage) => {
    if ('type' in msg && msg.type === 'ack') {
      if (!msg.ok) {
        set({ isStreaming: false })
      }
      return
    }

    if (!('event' in msg) || !msg.event) return
    const ev = msg.event
    const evType = ev.type

    // 1. message_update: Buffer deltas into rAF queue
    if (evType === 'message_update') {
      const assistantEvent = ev.assistantMessageEvent
      if (assistantEvent) {
        if (assistantEvent.type === 'text_delta') {
          pendingTextDelta += assistantEvent.delta || ''
        } else if (assistantEvent.type === 'thinking_delta') {
          pendingThinkingDelta += assistantEvent.delta || ''
        } else if (assistantEvent.type === 'toolcall_start') {
          set((state) => {
            const list = [...state.messages]
            const lastIdx = list.length - 1
            if (lastIdx >= 0 && list[lastIdx].role === 'assistant') {
              const current = list[lastIdx]
              const toolCalls: ToolCall[] = current.toolCalls ? [...current.toolCalls] : []
              if (!toolCalls.some((tc) => tc.id === assistantEvent.id)) {
                toolCalls.push({
                  id: assistantEvent.id,
                  name: assistantEvent.toolName || 'tool',
                  status: 'running',
                  arguments: {},
                })
              }
              list[lastIdx] = { ...current, toolCalls }
            }
            return { messages: list }
          })
        }
      }

      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          rafId = null
          const tDelta = pendingTextDelta
          const thDelta = pendingThinkingDelta
          pendingTextDelta = ''
          pendingThinkingDelta = ''

          if (!tDelta && !thDelta) return

          set((state) => {
            const list = [...state.messages]
            const lastIdx = list.length - 1
            if (lastIdx >= 0 && list[lastIdx].role === 'assistant') {
              const current = list[lastIdx]
              list[lastIdx] = {
                ...current,
                content: current.content + tDelta,
                thinking: (current.thinking || '') + thDelta,
                isStreaming: true,
              }
            }
            return { messages: list }
          })
        })
      }
    }

    // 2. message_end: Authoritative full replacement
    else if (evType === 'message_end') {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      pendingTextDelta = ''
      pendingThinkingDelta = ''

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
          const lastIdx = list.length - 1
          if (lastIdx >= 0 && list[lastIdx].role === 'assistant') {
            list[lastIdx] = {
              ...list[lastIdx],
              content: fullText || list[lastIdx].content,
              thinking: fullThinking || list[lastIdx].thinking,
              toolCalls: toolCalls.length > 0 ? toolCalls : list[lastIdx].toolCalls,
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
          return { messages: list, isStreaming: false }
        })
      }
    } else if (evType === 'agent_settled' || evType === 'agent_end') {
      set({ isStreaming: false })
    }
  },
}))
