import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResearchStartForm } from './ResearchStartForm'
import type { ResearchOptionsPayload } from '../../types/research'

const mocks = vi.hoisted(() => ({ startHost: vi.fn(), submit: vi.fn() }))
vi.mock('../../lib/researchBridge', () => ({ requestResearch: mocks.submit }))

const options: ResearchOptionsPayload = {
  defaults: { max_depth: 3, parallel: 4, sister_parallel: 4, max_followups: 2,
    max_revisions: 2, max_nodes: 30, plan_approval: true },
  constraints: {
    max_depth: { min: 0, max: 12 }, max_nodes: { min: 1, max: 500 },
    parallel: { min: 1 }, sister_parallel: { min: 1 },
    max_followups: { min: 0, max: 6 }, max_revisions: { min: 0, max: 6 },
  },
  sisters: [{ id: 'SISTER', name: 'Sister', description: 'Research profile' }],
}

beforeEach(() => {
  mocks.startHost.mockReset().mockResolvedValue({ enabled: true, session: { file: 'root.jsonl' } })
  mocks.submit.mockReset().mockResolvedValue({ accepted: true })
  window.app = { ...window.app, startResearchBridge: mocks.startHost } as typeof window.app
})

describe('ResearchStartForm', () => {
  it('allows the desktop coordinator to recruit experts from an empty shared catalog', () => {
    render(<ResearchStartForm workspace="C:/project" options={{ ...options, sisters: [] }} active={false} onStarted={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('研究课题'), { target: { value: 'A source-comparison question' } })
    expect(screen.getByRole('button', { name: '开始研究' })).toBeEnabled()
    expect(screen.queryByText(/请先创建至少一位 Sister/)).not.toBeInTheDocument()
  })
  it('requires a research question before creating the dedicated worker', () => {
    render(<ResearchStartForm workspace="C:/project" options={options} active={false} onStarted={vi.fn()} />)
    expect(screen.getByRole('button', { name: '开始研究' })).toBeDisabled()
    expect(mocks.startHost).not.toHaveBeenCalled()
  })

  it('starts the dedicated research context with the chosen engine limits', async () => {
    const onStarted = vi.fn()
    render(<ResearchStartForm workspace="C:/project" options={options} active={false} onStarted={onStarted} />)
    fireEvent.change(screen.getByLabelText('研究课题'), { target: { value: ' Compare RAG methods ' } })
    fireEvent.change(screen.getByLabelText('最大深度'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('节点并发'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('专家并发'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('节点上限'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: '开始研究' }))

    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1))
    expect(mocks.startHost).toHaveBeenCalledWith({ cwd: 'C:/project' })
    expect(mocks.submit).toHaveBeenCalledWith('start_research', expect.objectContaining({
      question: 'Compare RAG methods',
      workspace: 'C:/project',
      limits: expect.objectContaining({ max_depth: 1, parallel: 1, sister_parallel: 2, max_nodes: 3 }),
    }))
    expect(onStarted).toHaveBeenCalledOnce()
  })
  it('keeps optional global/model defaults absent and forwards explicit context/output choices', async () => {
    render(<ResearchStartForm workspace="C:/project" options={options} active={false} onStarted={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('研究课题'), { target: { value: 'Evidence' } })
    fireEvent.click(screen.getByRole('button', { name: '高级参数' }))
    fireEvent.change(screen.getByLabelText('上下文阈值'), { target: { value: '75' } })
    fireEvent.change(screen.getByLabelText('最大输出 token'), { target: { value: '2048' } })
    fireEvent.click(screen.getByRole('button', { name: '开始研究' }))
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledWith('start_research', expect.objectContaining({
      limits: expect.objectContaining({ context_threshold: .75, max_output_tokens: 2048 }),
    })))
  })

  it('leaves the form ready to retry after the bridge reports a startup error', async () => {
    mocks.submit.mockRejectedValueOnce(new Error('模型尚未配置'))
    render(<ResearchStartForm workspace="C:/project" options={options} active={false} onStarted={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('研究课题'), { target: { value: 'A small question' } })
    fireEvent.click(screen.getByRole('button', { name: '开始研究' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('模型尚未配置')
    expect(screen.getByLabelText('研究课题')).toHaveValue('A small question')
  })
})
