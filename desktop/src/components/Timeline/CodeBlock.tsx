import React, { useState } from 'react'
import { Check, Copy, Code2 } from 'lucide-react'

interface CodeBlockProps {
  language: string
  code: string
}

export const CodeBlock: React.FC<CodeBlockProps> = ({ language, code }) => {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback
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
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] hover:bg-surface-3 hover:text-text-main transition-colors text-dim cursor-pointer"
          title="复制全部代码"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-success" />
              <span className="text-success font-medium">已复制</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>复制</span>
            </>
          )}
        </button>
      </div>

      {/* Code content */}
      <div className="p-3.5 overflow-x-auto font-mono text-[length:var(--font-size-code)] leading-relaxed text-text-main/90 selection:bg-accent/30">
        <pre className="m-0 whitespace-pre">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  )
}
