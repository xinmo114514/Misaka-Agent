import { useEffect, useRef } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { useSessionStore } from '../store/useSessionStore'
import { consumeEscape, ESCAPE_PRIORITY, useEscapeLayer } from '../lib/useEscapeLayer'

export function SessionDeleteDialog() {
  const deletion = useSessionStore(state => state.sessionDeletion)
  const sessions = useSessionStore(state => state.sessions)
  const currentSessionPath = useSessionStore(state => state.currentSessionPath)
  const activeSessionPath = useSessionStore(state => state.activeSessionPath)
  const isStreaming = useSessionStore(state => state.isStreaming)
  const isAborting = useSessionStore(state => state.isAborting)
  const isSessionLoading = useSessionStore(state => state.isSessionLoading)
  const isCompacting = useSessionStore(state => state.isCompacting)
  const sessionOperation = useSessionStore(state => state.sessionOperation)
  const pendingPermissionRequest = useSessionStore(state => state.pendingPermissionRequest)
  const cancelSessionDeletion = useSessionStore(state => state.cancelSessionDeletion)
  const confirmSessionDeletion = useSessionStore(state => state.confirmSessionDeletion)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)
  useEscapeLayer(Boolean(deletion), event => {
    consumeEscape(event)
    if (deletion && deletion.status !== 'pending') cancelSessionDeletion()
  }, ESCAPE_PRIORITY.dialog)

  useEffect(() => {
    const open = Boolean(deletion)
    if (open && !wasOpen.current) {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const timer = window.setTimeout(() => cancelRef.current?.focus(), 0)
      wasOpen.current = true
      return () => window.clearTimeout(timer)
    }
    if (!open && wasOpen.current) {
      wasOpen.current = false
      previousFocus.current?.focus()
      previousFocus.current = null
    }
  }, [Boolean(deletion), deletion?.path])

  if (!deletion) return null

  const session = sessions.find(item => item.path === deletion.path)
  const title = session ? (session.name || '').trim() || session.firstMessage || '新对话' : '此会话'
  const deletingActive = deletion.path === currentSessionPath || deletion.path === activeSessionPath
  const activeSessionBusy = deletingActive && (isStreaming || isAborting || isSessionLoading || isCompacting
    || Boolean(sessionOperation) || Boolean(pendingPermissionRequest))
  const submitting = deletion.status === 'pending'
  const dismiss = () => { if (!submitting) cancelSessionDeletion() }

  const submit = () => {
    if (submitting || activeSessionBusy) return
    void confirmSessionDeletion()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
      onMouseDown={event => { if (event.target === event.currentTarget) dismiss() }}
    >
      <div role="alertdialog" aria-modal="true" aria-labelledby="session-delete-title"
        className="misaka-glass-popover relative w-full max-w-sm overflow-hidden rounded-xl border border-border-subtle bg-card text-text-main shadow-e3">
        <div className="flex items-center gap-2.5 border-b border-border-subtle px-4 py-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-danger/10 text-danger">
            <Trash2 className="h-4 w-4" />
          </div>
          <h2 id="session-delete-title" className="text-sm font-semibold">删除会话</h2>
        </div>
        <div className="space-y-2 px-4 py-4 text-[12px] leading-relaxed text-muted">
          <p>确定永久删除“<span className="font-medium text-text-main">{title}</span>”吗？</p>
          <p className="text-[11px] text-dim">永久删除后，此会话记录将无法恢复。</p>
          {deletingActive && <p className="rounded-md bg-surface-2 px-2.5 py-2 text-[11px] text-muted">删除后会在当前项目打开一个空白会话。</p>}
          {activeSessionBusy && <p role="status" className="text-[11px] text-warning">当前会话仍在运行，请先停止任务或会话操作再删除。</p>}
          {deletion.error && <p role="status" className="text-[11px] text-danger">{deletion.error}</p>}
          {submitting && (
            <p role="status" className="flex items-center gap-1.5 text-[11px] text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在删除会话…
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border-subtle px-4 py-3">
          {deletion.status !== 'pending' && (
            <button ref={cancelRef} type="button" onClick={dismiss}
              className="rounded-md border border-border-subtle px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring/70">
              {deletion.status === 'error' ? '关闭' : '取消'}
            </button>
          )}
          {deletion.status !== 'error' && (
            <button type="button" onClick={submit} disabled={submitting || activeSessionBusy}
              className="rounded-md bg-danger px-3 py-1.5 text-xs text-on-danger transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring/70 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={submitting ? '正在删除…' : '永久删除会话'}>
              {submitting ? '删除中…' : '删除会话'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
