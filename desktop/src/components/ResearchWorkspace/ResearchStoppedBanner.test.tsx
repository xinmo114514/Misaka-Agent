import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ResearchSessionDescriptor, ResearchSuspension } from '../../types/research'

const bridgeRequest = vi.hoisted(() => vi.fn())
const control = vi.hoisted(() => vi.fn())
vi.mock('../../lib/bridge', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/bridge')>(),
  request: bridgeRequest,
}))
vi.mock('../../lib/researchBridge', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/researchBridge')>(),
  executeResearchControl: control,
}))

import { ResearchStoppedBanner } from './ResearchStoppedBanner'
import { useResearchResumeStore } from '../../store/useResearchResumeStore'

const descriptor = (executorId: string, nodeId: string, taskId: string, generation: number): ResearchSessionDescriptor => ({
  executorId, sessionId: executorId, sessionFile: null, nodeId, taskId, role: 'sister', label: executorId,
  workspace: 'C:/fixture', status: 'failed', generation, attempt: generation,
  startedAt: generation * 10, endedAt: generation * 11, error: 'stopped',
})
const suspension = (scope: 'run' | 'node'): ResearchSuspension => ({ id: 's', runId: 'r', nodeId: 'node-1', scope,
  reason: 'all_cards_stopped', hasAcceptedOutput: false,
  confirmations: [{ taskId: 'task-1', title: 'Card', generation: 2, status: 'failed', error: 'stopped' }],
  resumeCommand: '/research resume r', message: 'all stopped', createdAt: 1, resolvedAt: null })

beforeEach(() => {
  bridgeRequest.mockReset().mockResolvedValue({ run: { id: 'r', status: 'stopped', driving: false } })
  control.mockReset().mockResolvedValue(undefined)
  useResearchResumeStore.setState({ byRun: {} })
})

it('focuses the current confirmed failure in the suspended node, not another node or older attempt', () => {
  const onFocus = vi.fn()
  const old = descriptor('old', 'node-1', 'task-1', 1)
  const current = descriptor('current', 'node-1', 'task-1', 2)
  const unrelated = descriptor('other-node', 'node-2', 'task-2', 5)
  render(<ResearchStoppedBanner suspension={suspension('node')} runStatus="active" workspace="C:/fixture"
    sessions={[old, current, unrelated]} onFocus={onFocus} driving={false} />)
  fireEvent.click(screen.getByRole('button', { name: '查看失败详情' }))
  expect(onFocus).toHaveBeenCalledWith(current)
})

it('keeps the stop record and the native command behind disclosures', () => {
  render(<ResearchStoppedBanner suspension={suspension('run')} runStatus="stopped" workspace="C:/fixture"
    sessions={[]} onFocus={vi.fn()} driving={false} />)
  const record = screen.getByText('all stopped').closest('details')
  expect(record).not.toBeNull()
  expect(record).not.toHaveAttribute('open')
  expect(screen.getByText('/research resume r')).toBeInTheDocument()
  expect(screen.getByText(/已停止/)).toBeInTheDocument()
})

it('never renders its own resume control: the run header owns the only one', () => {
  // Two entries would be two locks over one run, and the views could disagree about ownership.
  render(<ResearchStoppedBanner suspension={suspension('run')} runStatus="stopped" workspace="C:/fixture"
    sessions={[]} onFocus={vi.fn()} driving={false} />)
  expect(screen.queryByRole('button', { name: '恢复研究' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /恢复/ })).not.toBeInTheDocument()
  // It points at that entry instead of duplicating it, and it never starts anything by itself.
  expect(screen.getByText(/点右上角「恢复研究」/)).toBeInTheDocument()
  expect(control).not.toHaveBeenCalled()
})

it('stays quiet about resuming when the run is still driven, finished, or waiting for the user', () => {
  const view = render(<ResearchStoppedBanner suspension={suspension('run')} runStatus="stopped"
    workspace="C:/fixture" sessions={[]} onFocus={vi.fn()} driving />)
  // A live lease: the header keeps the entry disabled, so the banner must not invite a resume.
  expect(screen.queryByText(/点右上角「恢复研究」/)).not.toBeInTheDocument()
  view.rerender(<ResearchStoppedBanner suspension={suspension('run')} runStatus="done"
    workspace="C:/fixture" sessions={[]} onFocus={vi.fn()} driving={false} />)
  expect(screen.queryByText(/点右上角「恢复研究」/)).not.toBeInTheDocument()
  view.rerender(<ResearchStoppedBanner suspension={suspension('node')} runStatus="active"
    workspace="C:/fixture" sessions={[]} onFocus={vi.fn()} driving={false} />)
  // A node wait is not a run interruption.
  expect(screen.queryByText(/点右上角「恢复研究」/)).not.toBeInTheDocument()
})

it('narrates the header entry phase without offering a second action', () => {
  useResearchResumeStore.setState({ byRun: { r: { runId: 'r', phase: 'confirming', startedAt: Date.now(), updatedAt: Date.now() } } })
  render(<ResearchStoppedBanner suspension={suspension('run')} runStatus="stopped" workspace="C:/fixture"
    sessions={[]} onFocus={vi.fn()} driving={false} />)
  expect(screen.getByText(/正在确认恢复/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /恢复/ })).not.toBeInTheDocument()
})
