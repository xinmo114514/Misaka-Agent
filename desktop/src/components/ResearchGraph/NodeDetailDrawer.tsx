import React, { useState } from 'react'
import {
  X,
  Send,
  BookOpen,
  MessageSquareReply,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  Clock,
  Quote,
} from 'lucide-react'
import type { ResearchNodeData } from '../../types/research'

interface NodeDetailDrawerProps {
  node: ResearchNodeData | null
  onClose: () => void
  onAddReply: (nodeId: string, text: string) => void
}

export const NodeDetailDrawer: React.FC<NodeDetailDrawerProps> = ({
  node,
  onClose,
  onAddReply,
}) => {
  const [replyText, setReplyText] = useState('')

  if (!node) return null

  const handleSendReply = (e: React.FormEvent) => {
    e.preventDefault()
    if (!replyText.trim()) return
    onAddReply(node.id, replyText.trim())
    setReplyText('')
  }

  const isDone = node.status === 'done'
  const isRunning = node.status === 'running'
  const isReview = node.status === 'review'

  return (
    <div className="absolute top-0 right-0 bottom-0 w-[420px] bg-surface-1 border-l border-border shadow-2xl flex flex-col z-30 select-none animate-in slide-in-from-right duration-200">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface-2/60 shrink-0">
        <div className="flex items-center gap-2">
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0"
            style={{ backgroundColor: node.assignee.avatarBg || '#cb3862' }}
          >
            {node.assignee.id === 'lo' ? 'LO' : node.assignee.id.slice(-2)}
          </div>
          <div>
            <div className="font-semibold text-text-main text-xs">{node.assignee.name}</div>
            <div className="text-[10.5px] text-muted">{node.assignee.role}</div>
          </div>
        </div>

        <button
          onClick={onClose}
          className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-surface-3 text-dim hover:text-text-main transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs font-sans">
        {/* Node Overview Card */}
        <div className="p-3 rounded-xl bg-surface-2/40 border border-border space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono text-dim">节点 #{node.id} · 深度 D{node.depth}</span>
            <div>
              {isDone ? (
                <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-medium">
                  <CheckCircle2 className="w-3 h-3" />
                  已完成
                </span>
              ) : isRunning ? (
                <span className="flex items-center gap-1 text-[11px] text-amber-400 font-medium">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  研究中
                </span>
              ) : isReview ? (
                <span className="flex items-center gap-1 text-[11px] text-rose-400 font-medium">
                  <ShieldAlert className="w-3 h-3" />
                  红队审阅
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[11px] text-dim font-medium">
                  <Clock className="w-3 h-3" />
                  待启动
                </span>
              )}
            </div>
          </div>

          <h3 className="text-[13px] font-bold text-text-main leading-snug">{node.title}</h3>
          <p className="text-[12px] text-muted leading-relaxed">{node.question}</p>
        </div>

        {/* Core Findings Section */}
        {node.findings && node.findings.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-dim uppercase tracking-wider">
              <BookOpen className="w-3.5 h-3.5 text-accent" />
              <span>核心实证结论与观点</span>
            </div>
            <div className="space-y-1.5">
              {node.findings.map((f, i) => (
                <div key={i} className="p-2.5 rounded-lg bg-surface-2/30 border border-border-subtle text-text-main/90 leading-relaxed text-[12px]">
                  {f}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Evidence / Citations Section */}
        {node.evidence && node.evidence.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-dim uppercase tracking-wider">
              <Quote className="w-3.5 h-3.5 text-rose-lite" />
              <span>理论文献与实证材料</span>
            </div>
            <div className="space-y-1">
              {node.evidence.map((ev, i) => (
                <div key={i} className="px-2.5 py-1.5 rounded bg-surface-0 border border-border-subtle font-mono text-[11px] text-muted">
                  {ev}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Card Replies / Steering History */}
        <div className="space-y-2 pt-2 border-t border-border-subtle">
          <div className="flex items-center justify-between text-[11px] font-medium text-dim uppercase tracking-wider">
            <div className="flex items-center gap-1.5">
              <MessageSquareReply className="w-3.5 h-3.5 text-accent" />
              <span>卡片应答历史 ({node.replies?.length || 0})</span>
            </div>
          </div>

          {node.replies && node.replies.length > 0 ? (
            <div className="space-y-2">
              {node.replies.map((reply) => (
                <div key={reply.id} className="p-2.5 rounded-lg bg-surface-2 border border-border-subtle space-y-1">
                  <div className="flex items-center justify-between text-[10.5px] text-dim">
                    <span className="font-semibold text-text-main">{reply.sender}</span>
                    <span>{reply.timestamp}</span>
                  </div>
                  <div className="text-[12px] text-text-main/90 whitespace-pre-wrap">{reply.content}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-3 text-center text-dim text-[11.5px] rounded bg-surface-0/40 border border-dashed border-border-subtle">
              暂无对此节点的介入应答
            </div>
          )}
        </div>
      </div>

      {/* Bottom Card Response Input (卡片应答输入框) */}
      <form onSubmit={handleSendReply} className="p-3 border-t border-border bg-surface-2/80 flex items-center gap-2 shrink-0">
        <input
          type="text"
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          placeholder={`对 ${node.assignee.name} 发送指导指令或追问...`}
          className="flex-1 px-3 py-2 rounded-lg bg-surface-1 border border-border text-xs text-text-main placeholder-dim focus:outline-none focus:ring-1 focus:ring-focus-ring"
        />
        <button
          type="submit"
          disabled={!replyText.trim()}
          className="flex items-center gap-1 px-3.5 py-2 rounded-lg bg-accent text-white text-xs font-medium hover:opacity-90 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          <Send className="w-3.5 h-3.5" />
          <span>应答</span>
        </button>
      </form>
    </div>
  )
}
