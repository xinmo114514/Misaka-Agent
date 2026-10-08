import '@testing-library/jest-dom/vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ResearchTaskDrawer } from '../ResearchTaskDrawer'
import { useSessionStore } from '../../../store/useSessionStore'
import type { ResearchTaskDetail } from '../../../types/research'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../../../lib/bridge', () => ({ request: mocks.request }))

describe('ResearchTaskDrawer', () => {
  const taskDetail: ResearchTaskDetail = {
    id: 't_card_1',
    title: '跨文献基准比较任务',
    body: '核验文献问答中的检索召回、长上下文整合与证据引用。',
    status: 'closed',
    kind: 'research',
    round: 1,
    attempt: 1,
    assignee: 'literature-reviewer',
    artifacts: [
      {
        id: 'a1',
        kind: 'research',
        title: '比较报告草案',
        path: 'artifacts/draft.md',
        state: 'available',
        content: '# Draft content',
      },
    ],
    findings: [
      {
        id: 'f1',
        text: '长上下文在跨段整合上更稳',
        claim_type: 'fact',
        citations: [
          {
            artifact_id: 'a1',
            source_file: 'benchmarks.md',
            quote: '跨段召回率高出 14%',
            evidence_sha: 'sha123',
          },
        ],
      },
    ],
  }

  beforeEach(() => {
    mocks.request.mockReset().mockResolvedValue({ detail: taskDetail })
    useSessionStore.setState({
      activeResearchTaskId: { runId: 'r_1', taskId: 't_card_1' },
      currentWorkspace: 'C:/project',
    })
  })

  it('renders task details, objective, artifacts, and findings', async () => {
    render(<ResearchTaskDrawer />)
    expect(await screen.findByText('跨文献基准比较任务')).toBeInTheDocument()
    expect(screen.getByText(/Sister literature-reviewer/)).toBeInTheDocument()
    expect(screen.getByText('核验文献问答中的检索召回、长上下文整合与证据引用。')).toBeInTheDocument()
    expect(screen.getByText('比较报告草案')).toBeInTheDocument()
    expect(screen.getByText('长上下文在跨段整合上更稳')).toBeInTheDocument()
    expect(screen.getByText(/跨段召回率高出 14%/)).toBeInTheDocument()
  })

  it('closes drawer on close button click', async () => {
    render(<ResearchTaskDrawer />)
    const closeBtn = await screen.findByRole('button', { name: /关闭任务抽屉/ })
    fireEvent.click(closeBtn)
    expect(useSessionStore.getState().activeResearchTaskId).toBeNull()
  })
})
