import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface SessionRenameDialogProps {
  open: boolean
  path: string
  name: string
  onRename: (path: string, name: string) => Promise<void>
  onClose: () => void
}

export function SessionRenameDialog({ open, path, name, onRename, onClose }: SessionRenameDialogProps) {
  const [draft, setDraft] = useState(name)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setDraft(name)
    setError(null)
    setBusy(false)
    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [open, path, name])

  if (!open) return null

  const close = () => { if (!busy) onClose() }
  const submit = async () => {
    if (busy) return
    const next = draft.trim()
    if (!next) { setError('会话名称不能为空'); return }
    if (next === name) { onClose(); return }
    setBusy(true)
    setError(null)
    try {
      await onRename(path, next)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '重命名失败')
    } finally {
      setBusy(false)
    }
  }

  // Backdrop-filter on a sidebar creates a containing block for fixed children.
  // Keep the fullscreen overlay outside that block without changing its handlers.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
      <div role="dialog" aria-modal="true" aria-labelledby="session-rename-title" className="misaka-glass-popover relative w-full max-w-sm rounded-xl border border-border-subtle bg-card shadow-e3">
        <form onSubmit={event => { event.preventDefault(); void submit() }}>
          <div className="border-b border-border-subtle px-4 py-3">
            <h2 id="session-rename-title" className="text-sm font-semibold text-text-main">重命名会话</h2>
          </div>
          <div className="space-y-2 px-4 py-4">
            <label htmlFor="session-rename-input" className="text-xs text-muted">会话名称</label>
            <input
              id="session-rename-input" ref={inputRef} value={draft} disabled={busy}
              onChange={event => { setDraft(event.target.value); setError(null) }}
              onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); void submit() }
                if (event.key === 'Escape') { event.preventDefault(); close() }
              }}
              aria-label="会话名称"
              className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-text-main outline-none focus:border-border-accent/60"
            />
            {error && <div role="status" className="text-xs text-danger">{error}</div>}
          </div>
          <div className="flex justify-end gap-2 border-t border-border-subtle px-4 py-3">
            <button type="button" onClick={close} disabled={busy} className="rounded-md border border-border-subtle px-3 py-1.5 text-xs text-muted hover:bg-surface-2 disabled:opacity-40">取消</button>
            <button type="submit" disabled={busy} className="misaka-luminous rounded-md bg-accent px-3 py-1.5 text-xs text-on-accent hover:opacity-90 disabled:opacity-50">{busy ? '保存中…' : '保存名称'}</button>
          </div>
        </form>
      </div>
    </div>, document.body,
  )
}
