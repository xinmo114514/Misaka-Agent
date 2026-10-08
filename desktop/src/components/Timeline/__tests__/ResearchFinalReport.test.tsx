import '@testing-library/jest-dom/vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ResearchFinalReport } from '../ResearchFinalReport'
import type { ChatMessage } from '../../../types/session'

beforeEach(() => {
  window.app = {
    ...window.app,
    showItemInFolder: vi.fn().mockResolvedValue({ ok: true }),
  } as any
})

describe('ResearchFinalReport', () => {
  const message: ChatMessage = {
    id: 'msg_final',
    role: 'custom',
    customType: 'research-final',
    timestamp: 1000,
    content: '# Delivered final report — r_test\n\nReport: `artifacts/report.md`\n\n---\n\n## 核心结论\n两种方法在不同场景各具优势。',
    details: {
      run_id: 'r_test',
      final_artifact: 'a_report',
    },
  }

  it('renders final report markdown and metadata header', () => {
    render(<ResearchFinalReport message={message} />)
    expect(screen.getByText('研究最终报告')).toBeInTheDocument()
    expect(screen.getByText(/核心结论/)).toBeInTheDocument()
    expect(screen.getByText(/两种方法在不同场景各具优势/)).toBeInTheDocument()
  })

  it('allows copying and exporting report content', async () => {
    render(<ResearchFinalReport message={message} />)
    expect(screen.getByRole('button', { name: /复制报告/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /导出 Markdown/ })).toBeInTheDocument()
  })

  it('labels interrupted output as a partial report rather than a completed conclusion', () => {
    render(<ResearchFinalReport message={{ ...message, details: { run_id: 'r_test', result: { status: 'stopped' } } }} />)
    expect(screen.getByText('研究阶段性报告')).toBeInTheDocument()
    expect(screen.queryByText('研究最终报告')).not.toBeInTheDocument()
  })
})
