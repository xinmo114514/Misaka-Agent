import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { ResearchTilingWorkspace } from './ResearchTilingWorkspace'
import { ResearchStoppedBanner } from './ResearchStoppedBanner'
import { ResearchRunWizard } from './ResearchRunWizard'
import { ResearchSessionTree } from './ResearchSessionTree'
import { ResearchAgentPane } from './ResearchAgentPane'
import { useResearchRunStore } from '../../store/useResearchRunStore'
import { useResearchWorkspaceStore } from '../../store/useResearchWorkspaceStore'
import { useResearchSessionsStore } from '../../store/useResearchSessionsStore'
import { useSessionStore } from '../../store/useSessionStore'
import { researchSessionsBridge } from '../../lib/researchSessionsBridge'
import { request } from '../../lib/bridge'
import type { ResearchOptionsPayload, ResearchSessionDescriptor, ResearchSessionsPayload, ResearchSuspension } from '../../types/research'

vi.mock('../../lib/researchSessionsBridge', () => ({ researchSessionsBridge: {
  retainVisible: vi.fn((runId: string, ids: string[], workspace?: string, status?: (error: unknown | null) => void) => {
    let live = true
    void researchSessionsBridge.watch(runId, ids, workspace).then(
      () => { if (live) status?.(null) }, error => { if (live) status?.(error) },
    )
    return () => { live = false }
  }),
  load: vi.fn().mockResolvedValue(null), watch: vi.fn().mockResolvedValue(null), history: vi.fn().mockResolvedValue(null),
} }))
vi.mock('../../lib/bridge', () => ({ request: vi.fn().mockResolvedValue({ detail: { plan: null } }) }))
const descriptor = (id: string, status = 'running'): ResearchSessionDescriptor => ({ executorId: id, taskId: id,
  sessionId: id, sessionFile: null, nodeId: 'root', role: 'sister', label: id, cardTitle: id,
  workspace: 'C:/fixture', status, generation: 1, attempt: 1, startedAt: 1, endedAt: null, error: null })
const options: ResearchOptionsPayload = { defaults: { max_depth: 3, parallel: 4, sister_parallel: 4,
  max_followups: 2, max_revisions: 2, max_nodes: 30, plan_approval: true }, constraints: {
  max_depth: { min: 0, max: 12 }, parallel: { min: 1 }, sister_parallel: { min: 1 },
  max_followups: { min: 0, max: 6 }, max_revisions: { min: 0, max: 6 }, max_nodes: { min: 1, max: 500 },
  max_output_tokens: { min: 1024 } }, sisters: [] }
function listing(): ResearchSessionsPayload {
  return { runId: 'r', run: { id: 'r', question: '比较来源与证据', workspace: 'C:/fixture', status: 'active', phase: 'active', nodes: 2, tasks: 3 },
    graph: { run: 'r', question: '比较来源与证据', status: 'active', phase: 'active', nodes: [
      { id: 'root', question: '比较来源与证据', kind: 'root', depth: 0, status: 'executing', parents: [], children: ['branch'],
        cards: [{ id: 'a', title: '来源审计', status: 'running' }, { id: 'b', title: '证据比较', status: 'ready' }, { id: 'c', title: '背景梳理', status: 'done' }] },
      { id: 'branch', question: '另一条研究分支', kind: 'alt', depth: 1, status: 'planning', parents: ['root'], children: [] },
    ] }, sessions: [{ ...descriptor('lo'), taskId: null, role: 'last_order', label: 'Last Order' }, descriptor('a')], suspension: null, suspensions: [] }
}
beforeEach(() => {
  vi.mocked(researchSessionsBridge.load).mockResolvedValue(null as never)
  vi.mocked(researchSessionsBridge.watch).mockResolvedValue(undefined)
  vi.mocked(researchSessionsBridge.history).mockResolvedValue(null as never)
  vi.mocked(request).mockResolvedValue({ detail: { plan: null } })
  useResearchRunStore.setState({ runs: {} })
  useResearchWorkspaceStore.setState({ byRun: {} })
  useResearchSessionsStore.setState({ byExecutor: {} })
})
it('keeps node selection and the existing graph action behind More, with counters in process', () => {
  const value = listing()
  useResearchRunStore.getState().applyListing(value)
  useResearchSessionsStore.getState().upsertDescriptors('r', value.sessions)
  const graph = vi.spyOn(useSessionStore.getState(), 'setActiveResearchGraphRunId')
  render(<ResearchTilingWorkspace runId="r" workspace="C:/fixture" />)
  fireEvent.click(screen.getByRole('button', { name: '更多研究选项' }))
  const overview = screen.getByRole('dialog', { name: '研究更多选项' })
  expect(overview).not.toHaveTextContent('完成 1/3')
  fireEvent.click(within(overview).getByRole('button', { name: '当前节点' }))
  fireEvent.click(within(overview).getByRole('button', { name: '另一条研究分支' }))
  expect(useResearchWorkspaceStore.getState().byRun.r.selectedNodeId).toBe('branch')
  expect(screen.queryByRole('dialog', { name: '研究更多选项' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '更多研究选项' }))
  fireEvent.click(screen.getByRole('button', { name: '研究图谱' }))
  expect(graph).toHaveBeenCalledWith('r')
})
it('keeps all deterministic stop evidence behind a disclosure without burying Resume', () => {
  const suspension: ResearchSuspension = { id: 's', runId: 'r', scope: 'run', nodeId: null, reason: 'all_cards_stopped',
    hasAcceptedOutput: false, confirmations: [{ taskId: 'a', title: '来源审计', generation: 1, status: 'failed', error: '429 quota' }],
    resumeCommand: '/research resume r', message: '逐卡停止确认：a，generation 1，429 quota', createdAt: 1, resolvedAt: null }
  render(<ResearchStoppedBanner suspension={suspension} runStatus="stopped" workspace="C:/fixture" sessions={[]} onFocus={vi.fn()} driving={false} />)
  const disclosure = screen.getByText('逐卡停止确认：a，generation 1，429 quota').closest('details')
  expect(disclosure).not.toBeNull()
  expect(disclosure).not.toHaveAttribute('open')
  // The resume action lives in the run header only; this banner points at it rather than burying
  // a second control behind its evidence.
  expect(screen.queryByRole('button', { name: '恢复研究' })).not.toBeInTheDocument()
  expect(screen.getByText(/点右上角「恢复研究」/)).toBeInTheDocument()
  expect(screen.getByText('/research resume r')).toBeInTheDocument()
})
it('groups native wizard fields, names presets and manages dialog keyboard focus', () => {
  const cancel = vi.fn()
  const confirm = vi.fn()
  const original = document.createElement('button')
  document.body.append(original); original.focus()
  const view = render(<ResearchRunWizard options={options} onConfirm={confirm} onCancel={cancel} />)
  const dialog = screen.getByRole('dialog', { name: '研究参数确认' })
  expect(within(dialog).getByRole('group', { name: '研究范围' })).toBeInTheDocument()
  expect(within(dialog).getByRole('group', { name: '并发与审批' })).toBeInTheDocument()
  expect(within(dialog).getByRole('group', { name: '上下文与输出' })).toBeInTheDocument()
  fireEvent.click(within(dialog).getByRole('button', { name: /标准研究/ }))
  expect(within(dialog).getByLabelText('最大深度')).toHaveValue(5)
  fireEvent.keyDown(dialog, { key: 'Escape' })
  expect(cancel).toHaveBeenCalledOnce()
  view.unmount()
  expect(original).toHaveFocus()
  original.remove()
})
it('distinguishes current cards from expandable historical attempts without removing either', () => {
  const value = listing()
  value.sessions = [{ ...descriptor('old', 'failed'), taskId: 'shared', generation: 1, attempt: 1 },
    { ...descriptor('current', 'done'), taskId: 'shared', generation: 2, attempt: 2 }]
  const focus = vi.fn()
  render(<ResearchSessionTree listing={value} selectedNodeId="root" onSelectNode={vi.fn()} onFocus={focus} />)
  expect(screen.getByText('current')).toBeVisible()
  const history = screen.getByText('old').closest('details')
  expect(history).not.toBeNull()
  expect(history).not.toHaveAttribute('open')
  fireEvent.click(screen.getByRole('button', { name: /current/ }))
  expect(focus).toHaveBeenCalledWith(value.sessions[1])
  expect(value.sessions).toHaveLength(2)
})
it('collapses engine instructions but gives delivered reports a dedicated reading surface', () => {
  const value = descriptor('content')
  useResearchSessionsStore.getState().upsertDescriptors('r', [value])
  useResearchSessionsStore.getState().applyHistory({ runId: 'r', executorId: 'content', messages: [
    { id: 'phase', role: 'custom', customType: 'research-phase', content: 'Long internal phase instructions', timestamp: 1 },
    { id: 'final', role: 'custom', customType: 'research-final', content: 'Delivered final report', timestamp: 2 },
  ], historyVersion: 'v1', nextCursor: null, hasMore: false, availability: 'available' })
  render(<ResearchAgentPane runId="r" descriptor={value} />)
  const instructions = screen.getByText('Long internal phase instructions').closest('details')
  expect(instructions).not.toBeNull()
  expect(instructions).not.toHaveAttribute('open')
  expect(screen.getByText('Delivered final report').closest('article')).toHaveClass('research-message--report')
})

it('collapses only the initial contract-bearing task input and leaves user follow-ups readable', () => {
  const value = { ...descriptor('brief'), contract: 'Use sources and submit evidence.' }
  useResearchSessionsStore.getState().upsertDescriptors('r', [value])
  const initial = 'Initial research brief ' + 'a'.repeat(700)
  const followUp = 'User follow-up ' + 'b'.repeat(700)
  useResearchSessionsStore.getState().applyHistory({ runId: 'r', executorId: 'brief', messages: [
    { id: 'initial', role: 'user', content: initial, timestamp: 1 },
    { id: 'reply', role: 'assistant', content: 'Checking the source.', timestamp: 2 },
    { id: 'follow-up', role: 'user', content: followUp, timestamp: 3 },
  ], historyVersion: 'v1', nextCursor: null, hasMore: false, availability: 'available' })
  render(<ResearchAgentPane runId="r" descriptor={value} />)
  expect(screen.getByText(initial).closest('details')).not.toBeNull()
  expect(screen.getByText(followUp).closest('details')).toBeNull()
})
