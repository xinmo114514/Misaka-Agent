import React, { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { useSettingsStore } from '../store/useSettingsStore'

export interface CloseConfirmDialogProps {
  open: boolean
  onClose: () => void
  onConfirm?: (action: 'tray' | 'quit', dontAskAgain: boolean) => void
}

export const CloseConfirmDialog: React.FC<CloseConfirmDialogProps> = ({
  open,
  onClose,
  onConfirm,
}) => {
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const setCloseWindowAction = useSettingsStore((s) => s.setCloseWindowAction)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (open) {
      setDontAskAgain(false)
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const timer = window.setTimeout(() => cancelRef.current?.focus(), 0)
      return () => window.clearTimeout(timer)
    } else {
      previousFocus.current?.focus()
      previousFocus.current = null
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  const handleCancel = () => {
    onClose()
  }

  const handleQuit = () => {
    if (dontAskAgain) {
      setCloseWindowAction('quit')
    }
    if (onConfirm) {
      onConfirm('quit', dontAskAgain)
    } else {
      void window.app?.confirmClose?.('quit')
    }
    onClose()
  }

  const handleMinimizeToTray = () => {
    if (dontAskAgain) {
      setCloseWindowAction('tray')
    }
    if (onConfirm) {
      onConfirm('tray', dontAskAgain)
    } else {
      void window.app?.confirmClose?.('tray')
    }
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-xs p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleCancel()
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="close-dialog-title"
        aria-describedby="close-dialog-desc"
        className="misaka-glass-popover relative w-full max-w-[420px] rounded-2xl border border-border-subtle bg-card p-6 text-text-main shadow-e3"
      >
        <h2 id="close-dialog-title" className="text-base font-semibold text-text-main tracking-tight">
          关闭 Misaka 窗口？
        </h2>
        <p id="close-dialog-desc" className="mt-2.5 text-[13px] leading-relaxed text-muted">
          最小化到托盘后，Agent 和后台任务会继续运行；退出应用会停止正在进行的工作。
        </p>

        <div className="mt-5 flex items-center">
          <label className="group inline-flex items-center gap-2 cursor-pointer select-none text-[13px] text-muted hover:text-text-main transition-colors">
            <input
              type="checkbox"
              checked={dontAskAgain}
              onChange={(e) => setDontAskAgain(e.target.checked)}
              className="sr-only"
            />
            <div
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                dontAskAgain
                  ? 'border-accent bg-accent text-on-accent'
                  : 'border-border bg-surface-2 group-hover:border-border-accent'
              }`}
              aria-hidden="true"
            >
              {dontAskAgain && <Check className="h-3 w-3 stroke-[3]" />}
            </div>
            <span>不再询问</span>
          </label>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2.5">
          <button
            ref={cancelRef}
            type="button"
            onClick={handleCancel}
            className="rounded-lg border border-border-subtle bg-surface-2 px-3.5 py-1.5 text-xs font-medium text-text-main transition-colors hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring/70 cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleQuit}
            className="rounded-lg border border-transparent px-3.5 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger-surface hover:border-danger-border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring/70 cursor-pointer"
          >
            退出应用
          </button>
          <button
            type="button"
            onClick={handleMinimizeToTray}
            className="rounded-lg bg-accent px-3.5 py-1.5 text-xs font-medium text-on-accent shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring/70 cursor-pointer"
          >
            最小化到托盘
          </button>
        </div>
      </div>
    </div>
  )
}
