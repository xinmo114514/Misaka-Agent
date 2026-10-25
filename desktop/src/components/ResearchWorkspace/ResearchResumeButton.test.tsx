import { beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

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
vi.mock('../../lib/researchActivityStore', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/researchActivityStore')>(),
  beginResearchControl: vi.fn(),
  acceptResearchResume: vi.fn(),
}))

import { ResearchResumeButton } from './ResearchResumeButton'
import { ResearchInterruptedBanner } from './ResearchInterruptedBanner'
import { confirmResearchDriving, resetResearchResumeTimers, RESEARCH_RESUME_CONFIRM_TIMEOUT_MS } from '../../lib/researchResume'
import { useResearchResumeStore } from '../../store/useResearchResumeStore'

const detail = (run: Record<string, unknown>) => ({
  run: { id: 'r', question: 'q', workspace: 'C:/w', status: 'active', phase: 'active', nodes: 1, tasks: 1, ...run },
  graph: {},
})

beforeEach(() => {
  bridgeRequest.mockReset().mockResolvedValue(detail({ status: 'active', driving: false }))
  control.mockReset().mockResolvedValue(undefined)
  resetResearchResumeTimers()
  useResearchResumeStore.setState({ byRun: {} })
})

it('hides the entry for a finished run', () => {
  const { container } = render(<ResearchResumeButton runId="r" status="done" driving={false} />)
  expect(container).toBeEmptyDOMElement()
})

it('never takes over a run that still has a live driver', () => {
  render(<ResearchResumeButton runId="r" status="active" driving />)
  const button = screen.getByRole('button', { name: '恢复研究' })
  expect(button).toBeDisabled()
  expect(button).toHaveAttribute('title', '研究仍在运行，不会接管正在进行的研究')
})

it('disables a stopping run', () => {
  render(<ResearchResumeButton runId="r" status="stopping" driving={false} />)
  expect(screen.getByRole('button', { name: '恢复研究' })).toBeDisabled()
})

it('disables a run waiting for clarification or approval', () => {
  render(<ResearchResumeButton runId="r" status="waiting_input" driving={false} />)
  const button = screen.getByRole('button', { name: '恢复研究' })
  expect(button).toBeDisabled()
  expect(button).toHaveAttribute('title', '研究正在等待你的澄清或审批，先处理当前问题')
})

it('reads the driver from the detail endpoint when the list omitted it, and stays unknown when that read fails', async () => {
  bridgeRequest.mockRejectedValueOnce(new Error('看板不可读'))
  render(<ResearchResumeButton runId="r" status="active" />)
  const button = screen.getByRole('button', { name: '恢复研究' })
  expect(button).toBeDisabled()
  await waitFor(() => expect(bridgeRequest).toHaveBeenCalledWith('get_research_details', { runId: 'r', workspace: undefined }))
  // The failed read leaves the state unknown, not lost.
  await waitFor(() => expect(screen.getByRole('button', { name: '恢复研究' })).toBeDisabled())
})

it('enables a lost driver and a stopped run once the detail read answers', async () => {
  bridgeRequest.mockResolvedValue(detail({ status: 'stopped', driving: false }))
  render(<ResearchResumeButton runId="r" status="stopped" />)
  await waitFor(() => expect(screen.getByRole('button', { name: '恢复研究' })).toBeEnabled())
})

it('enables active-with-no-driver and shows 正在确认恢复 after the acknowledgement', async () => {
  render(<ResearchResumeButton runId="r" status="active" driving={false} />)
  fireEvent.click(screen.getByRole('button', { name: '恢复研究' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '正在确认恢复' })).toBeDisabled())
  expect(control).toHaveBeenCalledWith('resume_research', expect.objectContaining({ runId: 'r' }))
})

it('reports 恢复成功 only after the observation chain confirms real driving', async () => {
  render(<ResearchResumeButton runId="r" status="active" driving={false} />)
  fireEvent.click(screen.getByRole('button', { name: '恢复研究' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '正在确认恢复' })).toBeInTheDocument())
  confirmResearchDriving('r')
  await waitFor(() => expect(screen.getByRole('button', { name: '恢复成功' })).toBeInTheDocument())
})

it('reads 结果待确认 after the confirmation timeout and offers only a refresh', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  render(<ResearchResumeButton runId="r" status="active" driving={false} onRefresh={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '恢复研究' }))
  await waitFor(() => expect(useResearchResumeStore.getState().byRun.r.phase).toBe('confirming'))
  await vi.advanceTimersByTimeAsync(RESEARCH_RESUME_CONFIRM_TIMEOUT_MS)
  expect(await screen.findByRole('button', { name: '结果待确认' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument()
  expect(control).toHaveBeenCalledOnce()
  vi.useRealTimers()
})

it('keeps a clear failure visible and lets the user retry manually', async () => {
  const { ResearchRequestError } = await import('../../lib/researchBridge')
  control.mockRejectedValueOnce(new ResearchRequestError('研究根会话尚未登记，请刷新研究状态。', { requestId: 'q' }))
  render(<ResearchResumeButton runId="r" status="stopped" driving={false} />)
  fireEvent.click(screen.getByRole('button', { name: '恢复研究' }))
  const retry = await screen.findByRole('button', { name: '重试恢复' })
  expect(retry).toBeEnabled()
  expect(retry).toHaveAttribute('title', '研究根会话尚未登记，请刷新研究状态。')
  fireEvent.click(retry)
  await waitFor(() => expect(control).toHaveBeenCalledTimes(2))
})

it('sends one request for a double click', async () => {
  let release!: () => void
  control.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
  render(<ResearchResumeButton runId="r" status="active" driving={false} />)
  const button = screen.getByRole('button', { name: '恢复研究' })
  fireEvent.click(button)
  fireEvent.click(button)
  await waitFor(() => expect(control).toHaveBeenCalledOnce())
  release()
  await waitFor(() => expect(screen.getByRole('button', { name: '正在确认恢复' })).toBeInTheDocument())
})

it('keeps the phase across a remount of the entry', async () => {
  const first = render(<ResearchResumeButton runId="r" status="active" driving={false} />)
  fireEvent.click(screen.getByRole('button', { name: '恢复研究' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '正在确认恢复' })).toBeInTheDocument())
  first.unmount()
  render(<ResearchResumeButton runId="r" status="active" driving={false} />)
  expect(screen.getByRole('button', { name: '正在确认恢复' })).toBeInTheDocument()
})

it('shows the interruption banner only for an active run without a driver', () => {
  const { rerender } = render(<ResearchInterruptedBanner status="active" driving={false} />)
  expect(screen.getByText('研究执行已中断，可恢复')).toBeInTheDocument()
  // The banner is a notice: the single resume control lives beside 研究图谱.
  expect(screen.queryByRole('button', { name: '恢复研究' })).not.toBeInTheDocument()
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  rerender(<ResearchInterruptedBanner status="waiting_input" driving={false} />)
  expect(screen.queryByText('研究执行已中断，可恢复')).not.toBeInTheDocument()
  rerender(<ResearchInterruptedBanner status="active" driving />)
  expect(screen.queryByText('研究执行已中断，可恢复')).not.toBeInTheDocument()
  rerender(<ResearchInterruptedBanner status="stopped" driving={false} />)
  expect(screen.queryByText('研究执行已中断，可恢复')).not.toBeInTheDocument()
  rerender(<ResearchInterruptedBanner status="active" driving={false} stopRequested />)
  expect(screen.queryByText('研究执行已中断，可恢复')).not.toBeInTheDocument()
  // A plan approval releases the lease on purpose: that wait is not an interruption.
  rerender(<ResearchInterruptedBanner status="active" driving={false} awaitingApproval />)
  expect(screen.queryByText('研究执行已中断，可恢复')).not.toBeInTheDocument()
})

it('hides only an unavailable idle entry in focus while default callers retain the disabled explanation', () => {
  const focus = render(<ResearchResumeButton runId="r" status="active" driving hideUnavailable />)
  expect(focus.container).toBeEmptyDOMElement()
  focus.rerender(<ResearchResumeButton runId="r" status="waiting_input" driving={false} hideUnavailable />)
  expect(focus.container).toBeEmptyDOMElement()
  focus.unmount()
  render(<ResearchResumeButton runId="r" status="waiting_input" driving={false} />)
  expect(screen.getByRole('button', { name: '恢复研究' })).toBeDisabled()
})

it('keeps the unknown-driver detail read alive while hidden and restores the action on a lost driver', async () => {
  let resolveDetail!: (value: ReturnType<typeof detail>) => void
  bridgeRequest.mockImplementation(() => new Promise(resolve => { resolveDetail = resolve }))
  const view = render(<ResearchResumeButton runId="r" status="stopped" hideUnavailable />)
  expect(view.container).toBeEmptyDOMElement()
  await waitFor(() => expect(bridgeRequest).toHaveBeenCalledWith('get_research_details', { runId: 'r', workspace: undefined }))
  await act(async () => resolveDetail(detail({ status: 'stopped', driving: false })))
  expect(screen.getByRole('button', { name: '恢复研究' })).toBeEnabled()
})

it('retains active feedback phases even when the run becomes unavailable', () => {
  const store = useResearchResumeStore.getState()
  const view = render(<ResearchResumeButton runId="r" status="active" driving hideUnavailable onRefresh={vi.fn()} />)
  expect(view.container).toBeEmptyDOMElement()
  act(() => store.begin('r'))
  expect(screen.getByRole('button', { name: '提交中' })).toBeDisabled()
  act(() => store.confirming('r'))
  expect(screen.getByRole('button', { name: '正在确认恢复' })).toHaveTextContent(/\d+s/)
  act(() => store.unconfirm('r', '结果未知'))
  expect(screen.getByRole('button', { name: '结果待确认' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument()
  act(() => store.fail('r', '请求失败'))
  expect(screen.getByRole('button', { name: '重试恢复' })).toHaveAttribute('title', '请求失败')
  act(() => store.confirmed('r'))
  expect(view.container).toBeEmptyDOMElement()
})

it('shares the pending lock with a second focus entry rather than sending twice', async () => {
  let release!: () => void
  control.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
  const first = render(<ResearchResumeButton runId="r" status="active" driving={false} hideUnavailable />)
  fireEvent.click(first.getByRole('button', { name: '恢复研究' }))
  const second = render(<ResearchResumeButton runId="r" status="active" driving hideUnavailable />)
  await waitFor(() => expect(within(second.container).getByRole('button', { name: '提交中' })).toBeDisabled())
  fireEvent.click(within(second.container).getByRole('button', { name: '提交中' }))
  await waitFor(() => expect(control).toHaveBeenCalledOnce())
  release()
  await waitFor(() => expect(within(second.container).getByRole('button', { name: '正在确认恢复' })).toBeInTheDocument())
})
