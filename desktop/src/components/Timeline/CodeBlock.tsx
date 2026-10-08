import React, { useEffect, useRef, useState } from 'react'
import { Check, Copy, Code2 } from 'lucide-react'
import { clipboardErrorMessage, copyTextToClipboard } from '../../lib/clipboard'

interface CodeBlockProps {
  language: string
  code: string
}

export const CodeBlock: React.FC<CodeBlockProps> = ({ language, code }) => {
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const copyingRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const handleCopy = async () => {
    if (copyingRef.current) return
    copyingRef.current = true
    setCopying(true)
    setCopied(false)
    setCopyError(null)
    if (timerRef.current) clearTimeout(timerRef.current)
    try {
      await copyTextToClipboard(code)
      setCopied(true)
      timerRef.current = setTimeout(() => {
        setCopied(false)
        timerRef.current = null
      }, 2000)
    } catch (error) {
      setCopyError(`复制失败：${clipboardErrorMessage(error)}`)
    } finally {
      copyingRef.current = false
      setCopying(false)
    }
  }

  return (
    <div className="my-3 rounded-xl border border-border-subtle bg-card overflow-hidden shadow-e1">
      {/* Header bar matching screenshot: < /> language + copy button */}
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-well border-b border-border-subtle text-xs text-muted select-none">
        <div className="flex items-center gap-1.5 font-mono text-[11px] font-medium text-text-main">
          <Code2 className="w-3.5 h-3.5 text-rose-lite" />
          <span>{language || 'text'}</span>
        </div>
        <button
          onClick={handleCopy}
          disabled={copying}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] hover:bg-surface-3 hover:text-text-main transition-colors text-dim cursor-pointer disabled:opacity-50 disabled:cursor-wait"
          title={copying ? '正在复制代码' : '复制全部代码'}
        >
          {copying ? (
            <span role="status">复制中…</span>
          ) : copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-success" />
              <span role="status" className="text-success font-medium">已复制</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>复制</span>
            </>
          )}
        </button>
      </div>
      {copyError && <div role="alert" className="px-3.5 py-1.5 text-[11px] text-danger">{copyError}</div>}

      {/* Code content */}
      <div className="p-3.5 overflow-x-auto font-mono text-[length:var(--font-size-code)] leading-relaxed text-text-main/90 selection:bg-accent/30">
        <pre className="m-0 whitespace-pre">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  )
}
