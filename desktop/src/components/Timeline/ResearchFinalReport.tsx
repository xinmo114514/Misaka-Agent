import React, { useState } from 'react'
import { Check, Copy, Download, Flag, FolderOpen } from 'lucide-react'
import type { ChatMessage } from '../../types/session'
import { MarkdownContent } from './MarkdownContent'
import { copyTextToClipboard } from '../../lib/clipboard'
import { useSessionStore } from '../../store/useSessionStore'

interface ResearchFinalReportProps {
  message: ChatMessage
}

export const ResearchFinalReport: React.FC<ResearchFinalReportProps> = ({ message }) => {
  const [copied, setCopied] = useState(false)
  const runId = message.details?.run_id || message.details?.runId || ''
  const content = message.content || ''
  const status = message.details?.result?.status || message.details?.status
  const final = !status || status === 'done'
  const workspace = useSessionStore(s => s.researchCards[runId]?.workspace || s.researchBinding?.workspace)

  // Extract report path from message details or content
  const pathMatch = content.match(/Report:\s*`?([^\n`]+)`?/)
  const reportPath = (message.details?.result?.final?.path as string | undefined)
    || (message.details?.path as string | undefined)
    || (pathMatch ? pathMatch[1].trim() : undefined)
  const absolutePath = reportPath && (/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(reportPath)
    ? reportPath : workspace ? `${workspace.replace(/[\\/]+$/, '')}/${reportPath}` : undefined)

  const handleCopy = async () => {
    try {
      await copyTextToClipboard(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore
    }
  }

  const handleExport = () => {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = reportPath ? reportPath.split('/').pop() || 'research-report.md' : `research-${runId || 'report'}.md`
    link.click()
    URL.revokeObjectURL(url)
  }

  const handleShowInFolder = () => {
    if (absolutePath && window.app?.showItemInFolder) {
      void window.app.showItemInFolder(absolutePath)
    }
  }

  return (
    <div
      className="my-4 rounded-2xl border border-success-border/60 bg-surface-1 shadow-e2 overflow-hidden transition-all"
      data-testid="research-final-report"
    >
      {/* Report Header Banner */}
      <div className="flex items-center justify-between px-4 py-3 bg-success-surface/40 border-b border-border-subtle/80 text-xs">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-6 h-6 rounded-lg bg-success text-on-accent shadow-sm">
            <Flag className="w-3.5 h-3.5" />
          </div>
          <div>
            <div className="font-semibold text-text-main text-xs flex items-center gap-1.5">
              <span>{final ? '研究最终报告' : '研究阶段性报告'}</span>
              {runId && <span className="font-mono text-[10.5px] text-dim">({runId})</span>}
            </div>
            {reportPath && <div className="text-[10px] text-muted font-mono">{reportPath}</div>}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {absolutePath && Boolean(window.app?.showItemInFolder) && (
            <button
              type="button"
              onClick={handleShowInFolder}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-border-subtle bg-surface-2/60 hover:bg-surface-2 text-[11px] text-text-main transition-colors cursor-pointer"
              title="在本地文件夹中定位"
            >
              <FolderOpen className="w-3.5 h-3.5 text-dim" />
              <span>定位文件</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-border-subtle bg-surface-2/60 hover:bg-surface-2 text-[11px] text-text-main transition-colors cursor-pointer"
            title="复制完整报告"
            aria-label="复制报告"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5 text-dim" />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>

          <button
            type="button"
            onClick={handleExport}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-accent text-on-accent text-[11px] font-medium hover:brightness-105 transition-colors cursor-pointer shadow-sm"
            title="导出为 Markdown 文件"
            aria-label="导出 Markdown"
          >
            <Download className="w-3.5 h-3.5" />
            <span>导出 Markdown</span>
          </button>
        </div>
      </div>

      {/* Report Markdown Content */}
      <div className="p-5 text-[13px] leading-relaxed text-text-main">
        <MarkdownContent content={content} />
      </div>
    </div>
  )
}
