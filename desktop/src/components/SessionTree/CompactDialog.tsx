import React, { useEffect, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import type { CompactStatus } from '../../store/useSessionStore'

export interface CompactDialogProps {
  open: boolean
  busy: boolean
  status: CompactStatus
  messageCount: number
  /** Presented by /compact with instructions; still editable before running. */
  initialInstructions: string | null
  onConfirm: (customInstructions: string | null) => void
  onCancelOperation: () => void
  onClose: () => void
}

/**
 * Manual compaction. The engine already stops the current turn before compacting, so this only
 * has to collect the optional instructions and report what the engine did.
 */
export const CompactDialog: React.FC<CompactDialogProps> = ({
  open, busy, status, messageCount, initialInstructions, onConfirm, onCancelOperation, onClose,
}) => {
  const [instructions, setInstructions] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    setInstructions(initialInstructions ?? '')
    restoreFocusRef.current = document.activeElement as HTMLElement | null
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open, initialInstructions])

  useEffect(() => {
    if (open) return
    restoreFocusRef.current?.focus?.()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      // A running compaction is the only thing that can be cancelled; the dialog stays put
      // so the terminal state is still on screen.
      if (busy) onCancelOperation()
      else onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, busy, onCancelOperation, onClose])

  if (!open) return null

  const insufficient = messageCount < 2
  const statusText = status.message ?? (status.state === 'running' ? '正在压缩上下文…' : null)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <div role="dialog" aria-modal="true" aria-label="手动压缩会话" className="misaka-glass-popover relative w-full max-w-md rounded-xl border border-border-subtle bg-card shadow-e3">
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
          <div>
            <div className="text-xs font-semibold text-text-main">手动压缩</div>
            <div className="text-[10.5px] text-dim">当前会话共 {messageCount} 条消息</div>
          </div>
          <button type="button" onClick={onClose} disabled={busy} title="关闭"
            className="flex h-6 w-6 items-center justify-center rounded-md text-dim hover:bg-surface-2 hover:text-text-main disabled:opacity-40">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="space-y-2 px-4 py-3">
          <label className="block text-[11px] text-muted">自定义压缩指令（可选）</label>
          <textarea ref={textareaRef} value={instructions} rows={3}
            onChange={event => setInstructions(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !busy && !insufficient) {
                event.preventDefault()
                onConfirm(instructions.trim() || null)
              }
            }}
            placeholder="例如：保留未完成的实验与文件改动"
            aria-label="自定义压缩指令"
            className="w-full resize-none rounded-lg border border-border-subtle bg-surface-2/60 px-2.5 py-2 text-[11.5px] text-text-main placeholder-dim outline-none focus:border-border-accent/60" />
          {insufficient && <div className="text-[11px] text-warning">暂无可压缩的消息</div>}
          {statusText && (
            <div className={'text-[11px] ' + (status.state === 'error' ? 'text-danger' : status.state === 'done' ? 'text-accent' : 'text-muted')} role="status">
              {statusText}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-4 py-2.5">
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-md border border-border-subtle px-3 py-1.5 text-[11.5px] text-muted hover:bg-surface-2 hover:text-text-main disabled:opacity-40">关闭</button>
          {busy ? (
            <button type="button" onClick={onCancelOperation}
              className="flex items-center gap-1.5 rounded-md bg-danger px-3 py-1.5 text-[11.5px] text-on-danger hover:opacity-90">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /><span>取消压缩</span>
            </button>
          ) : (
            <button type="button" disabled={insufficient} onClick={() => onConfirm(instructions.trim() || null)}
              className="misaka-luminous rounded-md bg-accent px-3 py-1.5 text-[11.5px] text-on-accent hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">立即压缩</button>
          )}
        </div>
      </div>
    </div>
  )
}

export default CompactDialog
