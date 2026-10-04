import React, { useEffect, useState, useRef } from 'react'
import { useTheme } from './theme/useTheme'
import {
  Activity,
  Layers,
  Palette,
  Terminal,
  Send,
  RefreshCw,
  Cpu,
} from 'lucide-react'
import type { BridgeMessage, BridgeAck } from './types/global'

function isAck(msg: BridgeMessage): msg is BridgeAck {
  return 'type' in msg && msg.type === 'ack'
}

export default function App() {
  const theme = useTheme()
  const [version, setVersion] = useState<string>('0.18.5')
  const [messages, setMessages] = useState<BridgeMessage[]>([])
  const [inputPrompt, setInputPrompt] = useState<string>('')
  const [isSending, setIsSending] = useState<boolean>(false)
  const [lastStats, setLastStats] = useState<any>(null)
  const logContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (window.app?.getVersion) {
      window.app.getVersion().then((v) => {
        if (v) setVersion(v)
      })
    }

    if (window.bridge?.on) {
      const unsub = window.bridge.on((msg) => {
        setMessages((prev) => [...prev.slice(-99), msg])
        if (isAck(msg)) {
          if (msg.data?.stats) {
            setLastStats(msg.data.stats)
          }
          if (!msg.ok) {
            setIsSending(false)
          }
        } else {
          if (
            msg.event?.type === 'agent_settled' ||
            msg.event?.type === 'message_end'
          ) {
            setIsSending(false)
          }
        }
      })
      return unsub
    }
  }, [])

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
    }
  }, [messages])

  const handlePing = () => {
    if (!window.bridge?.send) return
    window.bridge.send({
      type: 'get_stats',
      requestId: `ping-${Date.now()}`,
    })
  }

  const handleSendPrompt = (e: React.FormEvent) => {
    e.preventDefault()
    if (!inputPrompt.trim() || !window.bridge?.send) return
    setIsSending(true)
    window.bridge.send({
      type: 'prompt',
      requestId: `prompt-${Date.now()}`,
      text: inputPrompt.trim(),
    })
    setInputPrompt('')
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-surface-0 text-text-main overflow-hidden select-none font-sans">
      {/* Titlebar with draggable region */}
      <header
        className="flex items-center justify-between px-4 h-9 bg-surface-1 border-b border-border text-xs shrink-0 select-none"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2 font-medium tracking-wide">
          <div className="w-2.5 h-2.5 rounded-full bg-accent" />
          <span>MISAKA Desktop</span>
          <span className="text-[11px] text-muted px-1.5 py-0.5 rounded bg-surface-2 border border-border-subtle">
            v{version}
          </span>
          <span className="text-[11px] text-muted px-1.5 py-0.5 rounded bg-surface-2 border border-border-subtle">
            Phase 2 Shell
          </span>
        </div>

        {/* Status in titlebar */}
        <div
          className="flex items-center gap-2 pr-28 text-[11px] text-muted"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Bridge Active
          </span>
          <span className="text-border-subtle">|</span>
          <span>Theme: {theme?.name || 'dark'}</span>
        </div>
      </header>

      {/* Main Workspace Layout */}
      <main className="flex-1 flex overflow-hidden">
        {/* Left Panel: Theme & Palette Matrix (Phase 2 core deliverable) */}
        <section className="w-80 shrink-0 border-r border-border bg-surface-1 flex flex-col p-4 gap-4 overflow-y-auto">
          <div className="flex items-center gap-2 pb-2 border-b border-border-subtle">
            <Palette className="w-4 h-4 text-accent" />
            <h2 className="text-sm font-semibold text-text-main">
              主题注入链路 (Phase 2)
            </h2>
          </div>

          <div className="text-xs text-muted leading-relaxed">
            前端零硬编码色值。通过 IPC 监听{' '}
            <code className="text-rose-lite font-mono">theme/*.json</code>，动态注入
            CSS 变量并映射到 Tailwind v4{' '}
            <code className="text-rose-lite font-mono">@theme inline</code>。
          </div>

          {/* Surfaces Matrix */}
          <div className="flex flex-col gap-2">
            <label className="text-[11px] font-medium text-dim uppercase tracking-wider">
              表面层级 (Surfaces)
            </label>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="p-2.5 rounded bg-surface-0 border border-border text-center">
                <span className="block font-mono text-[10px] text-muted">
                  surface-0
                </span>
                <span className="text-[11px] font-medium">#18181e</span>
              </div>
              <div className="p-2.5 rounded bg-surface-1 border border-border text-center">
                <span className="block font-mono text-[10px] text-muted">
                  surface-1
                </span>
                <span className="text-[11px] font-medium">#1e1e24</span>
              </div>
              <div className="p-2.5 rounded bg-surface-2 border border-border text-center">
                <span className="block font-mono text-[10px] text-muted">
                  surface-2
                </span>
                <span className="text-[11px] font-medium">#25252d</span>
              </div>
              <div className="p-2.5 rounded bg-surface-3 border border-border text-center">
                <span className="block font-mono text-[10px] text-muted">
                  surface-3
                </span>
                <span className="text-[11px] font-medium">#2c2c36</span>
              </div>
            </div>
            <div className="p-2 rounded bg-surface-hover border border-border text-center text-xs">
              <span className="font-mono text-[10px] text-muted mr-2">
                surface-hover:
              </span>
              <span className="text-[11px]">#232329</span>
            </div>
          </div>

          {/* Borders Matrix */}
          <div className="flex flex-col gap-2">
            <label className="text-[11px] font-medium text-dim uppercase tracking-wider">
              边框层级 (Borders)
            </label>
            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between items-center px-2 py-1.5 rounded border border-border-subtle bg-surface-2">
                <span className="text-muted">border-subtle</span>
                <span className="font-mono text-[10px] text-dim">#2a2a33</span>
              </div>
              <div className="flex justify-between items-center px-2 py-1.5 rounded border border-border bg-surface-2">
                <span className="text-muted">border</span>
                <span className="font-mono text-[10px] text-dim">#37373f</span>
              </div>
              <div className="flex justify-between items-center px-2 py-1.5 rounded border border-border-strong bg-surface-2">
                <span className="text-muted">border-strong</span>
                <span className="font-mono text-[10px] text-dim">#4a3d42</span>
              </div>
              <div className="flex justify-between items-center px-2 py-1.5 rounded border border-border-accent bg-surface-2">
                <span className="text-accent font-medium">border-accent</span>
                <span className="font-mono text-[10px] text-accent">#8f2545</span>
              </div>
            </div>
          </div>

          {/* Typography Contrast Check */}
          <div className="flex flex-col gap-2">
            <label className="text-[11px] font-medium text-dim uppercase tracking-wider">
              正文对比度 (WCAG AA 达标)
            </label>
            <div className="p-2.5 rounded bg-surface-2 border border-border text-xs space-y-1.5">
              <div className="flex justify-between">
                <span className="text-text-main">text (17.67:1)</span>
                <span className="text-text-main font-mono text-[10px]">
                  #ffffff
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-rose-lite font-medium">
                  heading (5.75:1)
                </span>
                <span className="text-rose-lite font-mono text-[10px]">
                  #e8698c
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-thinking-text font-medium">
                  thinking (7.43:1)
                </span>
                <span className="text-thinking-text font-mono text-[10px]">
                  #c99bb4
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">muted (7.84:1)</span>
                <span className="text-muted font-mono text-[10px]">
                  #bba8ad
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-dim">dim (6.16:1)</span>
                <span className="text-dim font-mono text-[10px]">
                  #a99398
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-disabled">disabled (非正文)</span>
                <span className="text-disabled font-mono text-[10px]">
                  #6e5f64
                </span>
              </div>
            </div>
          </div>

          {/* Chart 6 Colors */}
          <div className="flex flex-col gap-2">
            <label className="text-[11px] font-medium text-dim uppercase tracking-wider">
              图表 6 色色板 (CIELAB ΔE ≥ 31)
            </label>
            <div className="grid grid-cols-6 gap-1 h-7">
              <div className="rounded bg-chart-1" title="Chart 1: #cb3862" />
              <div className="rounded bg-chart-2" title="Chart 2: #e0b23e" />
              <div className="rounded bg-chart-3" title="Chart 3: #acd39c" />
              <div className="rounded bg-chart-4" title="Chart 4: #3c9a80" />
              <div className="rounded bg-chart-5" title="Chart 5: #4f70c4" />
              <div className="rounded bg-chart-6" title="Chart 6: #c191d4" />
            </div>
          </div>

          {/* Primary Action Button (Accenting ≤ 10%) */}
          <button
            onClick={handlePing}
            className="mt-auto flex items-center justify-center gap-2 px-3 py-2 rounded bg-accent text-white font-medium text-xs hover:opacity-90 active:scale-[0.98] transition-all cursor-pointer shadow-sm focus:outline-none focus:ring-2 focus:ring-focus-ring"
          >
            <Activity className="w-3.5 h-3.5" />
            <span>发送 get_stats 状态探针</span>
          </button>
        </section>

        {/* Right Panel: Bridge Stdio Event Stream Log */}
        <section className="flex-1 flex flex-col bg-surface-0 overflow-hidden">
          {/* Section Header */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-surface-1 shrink-0">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-rose-lite" />
              <span className="text-xs font-semibold text-text-main">
                Bridge 协议实时通信流 (JSONL)
              </span>
              <span className="text-[11px] text-muted">
                ({messages.length} 条已接收)
              </span>
            </div>
            {lastStats && (
              <div className="flex items-center gap-3 text-xs text-muted">
                <span className="flex items-center gap-1">
                  <Cpu className="w-3.5 h-3.5 text-rose-lite" />
                  Tokens: {lastStats.tokens?.total || 0}
                </span>
                <span>Messages: {lastStats.totalMessages || 0}</span>
              </div>
            )}
          </div>

          {/* Event Stream Log */}
          <div
            ref={logContainerRef}
            className="flex-1 p-4 overflow-y-auto font-mono text-xs space-y-2 bg-surface-0"
          >
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-muted gap-2">
                <Layers className="w-8 h-8 text-dim opacity-50" />
                <p>等待 Bridge 事件或点击左下角发送探针...</p>
              </div>
            ) : (
              messages.map((msg, index) => {
                const isAckMsg = isAck(msg)
                return (
                  <div
                    key={index}
                    className="p-2 rounded bg-surface-1 border border-border-subtle hover:border-border transition-colors leading-relaxed break-all"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {isAckMsg ? (
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                            msg.ok
                              ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800/60'
                              : 'bg-rose-950/80 text-rose-400 border border-rose-800/60'
                          }`}
                        >
                          ACK ({msg.requestId})
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-surface-2 text-rose-lite border border-border">
                          SEQ #{msg.seq} · {msg.event?.type}
                        </span>
                      )}
                      <span className="text-[10px] text-dim ml-auto">
                        {new Date().toLocaleTimeString()}
                      </span>
                    </div>
                    <pre className="text-[11px] text-muted overflow-x-auto whitespace-pre-wrap">
                      {JSON.stringify(
                        isAckMsg ? msg : msg.event,
                        null,
                        2,
                      )}
                    </pre>
                  </div>
                )
              })
            )}
          </div>

          {/* Prompt Input Form */}
          <form
            onSubmit={handleSendPrompt}
            className="p-3 bg-surface-1 border-t border-border flex items-center gap-2 shrink-0"
          >
            <input
              type="text"
              value={inputPrompt}
              onChange={(e) => setInputPrompt(e.target.value)}
              placeholder="测试发送 prompt 指令（如：用一句话说明你的定位）..."
              disabled={isSending}
              className="flex-1 px-3 py-2 rounded bg-surface-2 border border-border text-xs text-text-main placeholder-dim focus:outline-none focus:ring-1 focus:ring-focus-ring disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={isSending || !inputPrompt.trim()}
              className="flex items-center gap-1.5 px-4 py-2 rounded bg-accent text-white text-xs font-medium hover:opacity-90 active:scale-[0.98] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
            >
              {isSending ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>处理中</span>
                </>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  <span>发送</span>
                </>
              )}
            </button>
          </form>
        </section>
      </main>
    </div>
  )
}
