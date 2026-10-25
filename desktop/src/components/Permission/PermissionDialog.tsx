import React, { useState } from 'react'
import { ShieldAlert, Terminal, FileCode, Check, X, Bot, ShieldCheck } from 'lucide-react'
import { useSessionStore } from '../../store/useSessionStore'
import { consumeEscape, ESCAPE_PRIORITY, useEscapeLayer } from '../../lib/useEscapeLayer'

export const PermissionDialog: React.FC = () => {
  const pending = useSessionStore((s) => s.pendingPermissionRequest)
  const respondPermission = useSessionStore((s) => s.respondPermission)
  const [feedback, setFeedback] = useState('')
  // This decision stays open until explicitly answered; Escape must not act on the reader below.
  useEscapeLayer(Boolean(pending), consumeEscape, ESCAPE_PRIORITY.dialog)

  if (!pending) return null

  const { requestId, toolName, toolInput, reason, agentId } = pending

  const handleAllowOnce = () => {
    respondPermission(requestId, 'allow', 'once', feedback)
  }

  const handleAllowSession = () => {
    respondPermission(requestId, 'allow', 'session', feedback)
  }

  const handleDeny = () => {
    respondPermission(requestId, 'deny', 'once', feedback)
  }

  const renderToolPreview = () => {
    if (toolName === 'bash' || toolName === 'powershell') {
      const cmd = toolInput?.command || toolInput?.cmd || ''
      return (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs text-muted font-medium">
            <Terminal className="w-3.5 h-3.5 text-accent" />
            <span>执行命令行</span>
          </div>
          <pre className="p-3 rounded-lg bg-surface-0 border border-border-subtle text-xs font-mono text-text-main overflow-x-auto max-h-40 whitespace-pre-wrap select-text">
            {cmd}
          </pre>
        </div>
      )
    }

    if (toolName === 'write' || toolName === 'edit') {
      const path = toolInput?.path || toolInput?.file_path || ''
      const fileContent = toolInput?.content || toolInput?.new_string || ''
      return (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs text-muted font-medium">
            <FileCode className="w-3.5 h-3.5 text-accent" />
            <span>文件写入/修改: <code className="text-text-main font-mono">{path}</code></span>
          </div>
          {fileContent && (
            <pre className="p-3 rounded-lg bg-surface-0 border border-border-subtle text-xs font-mono text-text-main overflow-x-auto max-h-40 whitespace-pre-wrap select-text">
              {fileContent.slice(0, 1000)}
              {fileContent.length > 1000 ? '\n... (已截断)' : ''}
            </pre>
          )}
        </div>
      )
    }

    return (
      <div className="space-y-1.5">
        <div className="text-xs text-muted font-medium">调用参数:</div>
        <pre className="p-3 rounded-lg bg-surface-0 border border-border-subtle text-xs font-mono text-text-main overflow-x-auto max-h-40 whitespace-pre-wrap select-text">
          {JSON.stringify(toolInput, null, 2)}
        </pre>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-overlay backdrop-blur-sm animate-in fade-in duration-200">
      <div className="misaka-glass-popover relative w-full max-w-lg bg-card border border-border-subtle shadow-e4 rounded-2xl p-5 flex flex-col gap-4 text-text-main">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-warning/15 text-warning border border-warning/20">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold text-sm text-text-main">操作审批请求</h3>
              <p className="text-xs text-muted mt-0.5">
                {reason || `Agent 正在申请调用工具 [${toolName}]`}
              </p>
            </div>
          </div>
          {agentId && (
            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-2 border border-border-subtle text-[11px] text-muted shrink-0">
              <Bot className="w-3 h-3 text-accent" />
              <span>{agentId}</span>
            </div>
          )}
        </div>

        {/* Tool Preview */}
        {renderToolPreview()}

        {/* Optional feedback text */}
        <div className="space-y-1.5">
          <label className="text-[11px] text-dim block">
            拒绝原因或给模型的补充说明（可选）:
          </label>
          <input
            type="text"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="例如：不要修改此文件，使用临时目录替代..."
            className="w-full px-3 py-1.5 text-xs rounded-lg bg-surface-0 border border-border-subtle text-text-main placeholder-dim outline-none focus:border-accent transition-colors"
          />
        </div>

        {/* Buttons Footer */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border-subtle">
          <button
            type="button"
            onClick={handleDeny}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-rose hover:bg-rose/10 border border-rose/20 transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
            <span>拒绝 (Deny)</span>
          </button>
          <button
            type="button"
            onClick={handleAllowOnce}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-surface-2 hover:bg-surface-3 border border-border text-text-main transition-colors cursor-pointer"
          >
            <Check className="w-3.5 h-3.5" />
            <span>本次允许</span>
          </button>
          <button
            type="button"
            onClick={handleAllowSession}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent hover:opacity-90 text-on-accent transition-colors cursor-pointer shadow-e2"
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>本会话始终允许</span>
          </button>
        </div>
      </div>
    </div>
  )
}
