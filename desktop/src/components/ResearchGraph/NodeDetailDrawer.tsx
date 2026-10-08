import React from 'react'
import {
  X,
  BookOpen,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  Clock,
  XCircle,
  FileText,
  GitBranch,
} from 'lucide-react'
import type { ResearchNodeData } from '../../types/research'
import { researchNodeLabel } from '../../lib/researchStatus'

interface NodeDetailDrawerProps {
  node: ResearchNodeData | null
  onClose: () => void
}

/** Read-only detail for one research graph node. Steering and card replies live in the TUI. */
export const NodeDetailDrawer: React.FC<NodeDetailDrawerProps> = ({ node, onClose }) => {
  if (!node) return null

  const isDone = node.status === 'closed' || node.status === 'done'
  const isReview = ['critique', 'critiquing', 'diverging', 'divergence', 'divergence_review', 'red_team_review'].includes(node.status)
  const isFailed = node.status === 'failed'
  const isWaiting = ['awaiting_approval', 'waiting_input', 'parked', 'queued'].includes(node.status)
  const isRunning = !isDone && !isFailed && !isReview && !isWaiting

  return (
    <div className="misaka-glass-panel absolute top-0 right-0 bottom-0 w-[420px] bg-card border-l border-border-subtle shadow-e3 flex flex-col z-30 select-none animate-in slide-in-from-right duration-200">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface-2/60 shrink-0">
        <div className="flex items-center gap-2">
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold text-on-chart shrink-0"
            style={{ backgroundColor: node.assignee.avatarBg || 'var(--accent)' }}
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
      <div className="flex-1 overflow-y-auto bg-surface-1 p-4 space-y-4 text-xs font-sans">
        {/* Node Overview Card */}
        <div className="p-3 rounded-xl bg-surface-2/40 border border-border space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono text-dim">
              <GitBranch className="w-3 h-3 inline mr-1 -mt-0.5" />
              节点 {node.id} · {node.kind} · 深度 D{node.depth}
            </span>
            <div>
              {isDone ? (
                <span className="flex items-center gap-1 text-[11px] text-success font-medium">
                  <CheckCircle2 className="w-3 h-3" />
                  已完成
                </span>
              ) : isRunning ? (
                <span className="flex items-center gap-1 text-[11px] text-warning font-medium">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {researchNodeLabel(node.status)}
                </span>
              ) : isReview ? (
                <span className="flex items-center gap-1 text-[11px] text-danger font-medium">
                  <ShieldAlert className="w-3 h-3" />
                  {researchNodeLabel(node.status)}
                </span>
              ) : isFailed ? (
                <span className="flex items-center gap-1 text-[11px] text-danger font-medium">
                  <XCircle className="w-3 h-3" />
                  失败
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[11px] text-dim font-medium">
                  <Clock className="w-3 h-3" />
                  {researchNodeLabel(node.status)}
                </span>
              )}
            </div>
          </div>

          <h3 className="text-[13px] font-bold text-text-main leading-snug">{node.question}</h3>
        </div>

        {/* Conclusion (when the node dissolves/settles something) */}
        {node.summary && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-dim uppercase tracking-wider">
              <BookOpen className="w-3.5 h-3.5 text-accent" />
              <span>结论要点</span>
            </div>
            <div className="p-2.5 rounded-lg bg-surface-2/30 border border-border-subtle text-text-main/90 leading-relaxed text-[12px]">
              {node.summary}
            </div>
          </div>
        )}

        {/* Cards produced by this node */}
        {node.evidence && node.evidence.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-dim uppercase tracking-wider">
              <FileText className="w-3.5 h-3.5 text-rose-lite" />
              <span>节点卡片 ({node.evidence.length})</span>
            </div>
            <div className="space-y-1">
              {node.evidence.map((title, i) => (
                <div key={i} className="px-2.5 py-1.5 rounded bg-surface-0 border border-border-subtle text-[11.5px] text-muted">
                  {title}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="pt-2 border-t border-border-subtle text-[11px] text-dim leading-relaxed">
          桌面端为只读视图。要干预这次研究（审批计划、跳过节点、停止 / 继续运行），请回到 Last Order 的终端窗口使用
          <code className="font-mono text-rose-lite mx-1">/research</code> 命令。
        </div>
      </div>
    </div>
  )
}
