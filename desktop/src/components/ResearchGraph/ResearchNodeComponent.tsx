import React from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import { CheckCircle2, Loader2, ShieldAlert, Clock, GitMerge, Sparkles, XCircle, FileText } from 'lucide-react'
import type { ResearchNodeData } from '../../types/research'

export const ResearchNodeComponent: React.FC<NodeProps<Node<ResearchNodeData>>> = ({
  data,
  selected,
}) => {
  const isRoot = data.kind === 'root'
  const isJoin = data.kind === 'join'
  const isRunning = data.status === 'running'
  const isReview = data.status === 'review'
  const isDone = data.status === 'done'
  const isFailed = data.status === 'failed'
  const evidenceCount = data.evidence?.length || 0

  return (
    <div
      className={`w-80 rounded-xl bg-card border transition-all cursor-pointer shadow-e2 select-none ${
        selected
          ? 'border-accent ring-2 ring-accent/30'
          : 'border-border hover:border-border-accent'
      }`}
    >
      {/* Target Handle (Left) */}
      {!isRoot && (
        <Handle
          type="target"
          position={Position.Left}
          className="w-2.5 h-2.5 !bg-border-accent !border-surface-1 -left-1.5"
        />
      )}

      {/* Header bar */}
      <div className="flex items-center justify-between px-3.5 py-2.5 bg-surface-2/60 border-b border-border-subtle rounded-t-xl text-xs">
        {/* Assignee Badge */}
        <div className="flex items-center gap-1.5 font-medium text-text-main">
          <div
            className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
            style={{ backgroundColor: data.assignee.avatarBg || 'var(--accent)' }}
          >
            {data.assignee.id === 'lo' ? 'LO' : data.assignee.id.slice(-2)}
          </div>
          <span className="truncate max-w-[120px] text-[11.5px]">{data.assignee.name}</span>
        </div>

        {/* Status Badge */}
        <div>
          {isDone ? (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10.5px] font-medium bg-success-surface text-success border border-success-border">
              <CheckCircle2 className="w-3 h-3" />
              <span>已完成</span>
            </span>
          ) : isRunning ? (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10.5px] font-medium bg-warning-surface text-warning border border-warning-border animate-pulse">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>研究中</span>
            </span>
          ) : isReview ? (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10.5px] font-medium bg-danger-surface text-danger border border-danger-border">
              <ShieldAlert className="w-3 h-3" />
              <span>红队审阅</span>
            </span>
          ) : isFailed ? (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10.5px] font-medium bg-danger-surface text-danger border border-danger-border">
              <XCircle className="w-3 h-3" />
              <span>失败</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10.5px] font-medium bg-surface-3 text-dim border border-border-subtle">
              <Clock className="w-3 h-3" />
              <span>待启动</span>
            </span>
          )}
        </div>
      </div>

      {/* Body: Node Title & Inquiry */}
      <div className="p-3.5 space-y-2">
        <div className="flex items-start gap-1.5">
          {isRoot ? (
            <Sparkles className="w-3.5 h-3.5 text-rose-lite shrink-0 mt-0.5" />
          ) : isJoin ? (
            <GitMerge className="w-3.5 h-3.5 text-accent shrink-0 mt-0.5" />
          ) : null}
          <h4 className="text-xs font-semibold text-text-main leading-snug line-clamp-2">
            {data.title}
          </h4>
        </div>

        <p className="text-[11.5px] text-muted line-clamp-2 leading-relaxed font-sans">
          {data.question}
        </p>
      </div>

      {/* Footer Info: Findings & Replies */}
      <div className="px-3.5 py-2 bg-surface-0/60 border-t border-border-subtle rounded-b-xl flex items-center justify-between text-[11px] text-dim font-mono">
        <div className="flex items-center gap-2">
          <span>节点 #{data.id}</span>
          <span>·</span>
          <span>深度 D{data.depth}</span>
        </div>

        {evidenceCount > 0 && (
          <span className="flex items-center gap-1 text-accent font-medium" title="该节点的卡片产出">
            <FileText className="w-3 h-3" />
            <span>{evidenceCount} 项产出</span>
          </span>
        )}
      </div>

      {/* Source Handle (Right) */}
      {!isJoin && (
        <Handle
          type="source"
          position={Position.Right}
          className="w-2.5 h-2.5 !bg-accent !border-surface-1 -right-1.5"
        />
      )}
    </div>
  )
}
