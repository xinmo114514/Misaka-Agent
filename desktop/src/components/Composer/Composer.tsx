import React, { useState, useRef, useEffect } from 'react'
import { Plus, ArrowUp, Square, ShieldCheck, ChevronDown } from 'lucide-react'
import { useSessionStore } from '../../store/useSessionStore'

export const Composer: React.FC = () => {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isStreaming = useSessionStore((s) => s.isStreaming)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const abortGeneration = useSessionStore((s) => s.abortGeneration)
  const currentModel = useSessionStore((s) => s.currentModel)

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
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`
    }
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

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [])

  const hasText = text.trim().length > 0

  return (
    <div className="absolute bottom-6 left-0 right-0 px-6 sm:px-12 md:px-20 lg:px-28 pointer-events-none z-10">
      <form
        onSubmit={handleSubmit}
        className="pointer-events-auto max-w-4xl mx-auto rounded-2xl bg-surface-1 border border-border shadow-2xl p-3 flex flex-col gap-2.5 transition-all focus-within:border-border-strong/90 focus-within:ring-1 focus-within:ring-focus-ring/40"
      >
        {/* Main Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="给 Misaka 发送研究课题或指令..."
          rows={1}
          className="w-full bg-transparent border-0 outline-none text-text-main placeholder-dim text-[13.5px] leading-relaxed resize-none px-2 py-1 max-h-44"
        />

        {/* Bottom Toolbar matching screenshot */}
        <div className="flex items-center justify-between pt-1 border-t border-border-subtle/50 text-xs select-none">
          {/* Left Controls: Plus + Security Badge */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-surface-2 text-dim hover:text-text-main transition-colors cursor-pointer"
              title="添加上下文或附件"
            >
              <Plus className="w-4 h-4" />
            </button>

            <div
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium text-amber-500/90 hover:bg-surface-2 transition-colors cursor-pointer"
              title="当前运行模式：本地完整沙箱"
            >
              <ShieldCheck className="w-3.5 h-3.5 text-amber-500" />
              <span>完全访问</span>
            </div>
          </div>

          {/* Right Controls: Model Pill + Submit Button */}
          <div className="flex items-center gap-2.5">
            {/* Model & Thinking Level Selector Pill */}
            <div
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-2/60 hover:bg-surface-2 border border-border-subtle text-[11.5px] text-muted hover:text-text-main transition-colors cursor-pointer font-medium"
              title="当前模型与思考配置"
            >
              <span>{currentModel.name}</span>
              <span className="text-dim text-[10.5px]">({currentModel.thinking})</span>
              <ChevronDown className="w-3 h-3 text-dim" />
            </div>

            {/* Circular Submit / Stop Action Button */}
            <button
              type="submit"
              disabled={!hasText && !isStreaming}
              className={`w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer shadow-sm ${
                isStreaming
                  ? 'bg-rose-600 hover:bg-rose-500 text-white active:scale-95'
                  : hasText
                  ? 'bg-accent hover:opacity-90 text-white active:scale-95 shadow-md shadow-accent/20'
                  : 'bg-surface-2 text-dim opacity-50 cursor-not-allowed'
              }`}
              title={isStreaming ? '停止生成' : '发送消息 (Enter)'}
            >
              {isStreaming ? (
                <Square className="w-3.5 h-3.5 fill-current" />
              ) : (
                <ArrowUp className="w-4 h-4 stroke-[2.5]" />
              )}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
