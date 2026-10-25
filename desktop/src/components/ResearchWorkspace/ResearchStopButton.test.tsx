import { beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const control = vi.hoisted(() => vi.fn())
vi.mock('../../lib/researchBridge', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/researchBridge')>(),
  executeResearchControl: control,
}))

import { ResearchStopButton } from './ResearchStopButton'
import { useResearchStopStore } from '../../store/useResearchStopStore'
import { useResearchActivityStore } from '../../lib/researchActivityStore'
import { useResearchRunStore } from '../../store/useResearchRunStore'
import { useSessionStore } from '../../store/useSessionStore'
import { observeResearchStop } from '../../lib/researchStopObservation'
import { resetResearchStopTimers } from '../../lib/researchStop'

beforeEach(() => {
  control.mockReset().mockResolvedValue(undefined)
  resetResearchStopTimers()
  useResearchStopStore.setState({ byRun: {} })
  useResearchActivityStore.setState({errors:{}})
  useResearchRunStore.setState({ runs: {} })
  // The component takes the run-target door unless the page itself owns this run's host.
  useSessionStore.setState({ researchBinding: null, researchCards: {}, researchRuns: [] })
})

it('asks for confirmation once, then dispatches and keeps the wait visible', async () => {
  render(<ResearchStopButton runId="r_stop_flow" workspace="C:/fixture" status="waiting_input" />)
  fireEvent.click(screen.getByRole('button', { name: '停止研究' }))
  expect(control).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认停止' }))
  await waitFor(() => expect(control).toHaveBeenCalledWith('stop_research',
    expect.objectContaining({ runId: 'r_stop_flow', workspace: 'C:/fixture' })))
  expect(control).toHaveBeenCalledOnce()
  // An ACK only means the command landed: the entry stays 正在停止, never a fresh stop button.
  expect(screen.getByRole('status')).toHaveTextContent('正在停止')
  expect(screen.queryByRole('button', { name: '停止研究' })).not.toBeInTheDocument()
})

it('survives a layout switch: the remounted entry still reports the same wait, once', async () => {
  const first = render(<ResearchStopButton runId="r_switch" workspace="C:/fixture" status="active" />)
  fireEvent.click(screen.getByRole('button', { name: '停止研究' }))
  fireEvent.click(screen.getByRole('button', { name: '确认停止' }))
  await waitFor(() => expect(control).toHaveBeenCalledOnce())
  first.unmount()
  // 专注 <-> 多窗 unmounts and remounts the header; the wait lives in the shared store.
  const again = render(<ResearchStopButton runId="r_switch" workspace="C:/fixture" status="active" />)
  expect(again.getByRole('status')).toHaveTextContent('正在停止')
  expect(again.queryByRole('button', { name: '停止研究' })).not.toBeInTheDocument()
  again.unmount()
  // A repeat dispatch on the same run sends nothing: the pending lock still owns it.
  useSessionStore.getState().requestResearchStop({ kind: 'run', runId: 'r_switch', workspace: 'C:/fixture' })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(control).toHaveBeenCalledOnce()
})

it('can be backed out of without sending anything', () => {
  render(<ResearchStopButton runId="r_cancel" status="active" />)
  fireEvent.click(screen.getByRole('button', { name: '停止研究' }))
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(screen.getByRole('button', { name: '停止研究' })).toBeInTheDocument()
  expect(control).not.toHaveBeenCalled()
})

it('keeps the stop feedback while the engine itself reports stopping', () => {
  const stopping = render(<ResearchStopButton runId="r_stopping" status="stopping" />)
  expect(stopping.getByRole('status')).toHaveTextContent('正在停止')
  stopping.unmount()
  // A board stop flag beside a still-live status reads the same way, never as a fresh button.
  const flagged = render(<ResearchStopButton runId="r_flag" status="active" stopRequested />)
  expect(flagged.getByRole('status')).toHaveTextContent('正在停止')
})

it('is absent once the run can no longer be stopped', () => {
  for (const status of ['done', 'failed', 'closed']) {
    const view = render(<ResearchStopButton runId="r_gone" status={status} />)
    expect(screen.queryByRole('button', { name: '停止研究' })).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    view.unmount()
  }
})

it('reports a rejected stop instead of pretending the run stopped', async () => {
  control.mockRejectedValue(new Error('研究根会话尚未登记，请刷新研究状态。'))
  render(<ResearchStopButton runId="r_reject" workspace="C:/fixture" status="active" />)
  fireEvent.click(screen.getByRole('button', { name: '停止研究' }))
  fireEvent.click(screen.getByRole('button', { name: '确认停止' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('研究根会话尚未登记')
  // The rejected attempt releases the lock: 停止研究 is clickable again for a deliberate retry.
  expect(screen.getByRole('button', { name: '重试停止' })).toBeInTheDocument()
})

it('settles the wait when the observation chain reports the run at rest', async () => {
  const stopObserving = observeResearchStop()
  try {
    const view = render(<ResearchStopButton runId="r_rest" workspace="C:/fixture" status="active" />)
    fireEvent.click(screen.getByRole('button', { name: '停止研究' }))
    fireEvent.click(screen.getByRole('button', { name: '确认停止' }))
    await waitFor(() => expect(view.getByRole('status')).toHaveTextContent('正在停止'))
    // A stopping row whose lease is still live is not rest yet: the wait stays honest.
    useResearchRunStore.getState().applyListing({
      runId: 'r_rest',
      run: { id: 'r_rest', question: 'q', workspace: 'C:/fixture', status: 'stopping', phase: 'stopping',
        nodes: 1, tasks: 1, driving: true },
      graph: { run: 'r_rest', question: 'q', status: 'stopping', phase: 'stopping', nodes: [] },
      sessions: [], suspension: null, suspensions: [],
    } as never)
    await waitFor(() => expect(view.getByRole('status')).toHaveTextContent('正在停止'))
    useResearchRunStore.getState().applyListing({
      runId: 'r_rest',
      run: { id: 'r_rest', question: 'q', workspace: 'C:/fixture', status: 'stopped', phase: 'stopped',
        nodes: 1, tasks: 1, driving: false },
      graph: { run: 'r_rest', question: 'q', status: 'stopped', phase: 'stopped', nodes: [] },
      sessions: [], suspension: null, suspensions: [],
    } as never)
    await waitFor(() => expect(view.queryByRole('status')).not.toBeInTheDocument())
    // The listing is now the run's truth: the header rerenders at rest, with no stop entry left.
    view.rerender(<ResearchStopButton runId="r_rest" workspace="C:/fixture" status="stopped" />)
    expect(view.queryByRole('button', { name: '停止研究' })).not.toBeInTheDocument()
  } finally {
    stopObserving()
  }
})

it('keeps refresh and confirmed retry available when the board is still stopping', () => {
  const request = vi.fn()
  const refresh = vi.fn().mockResolvedValue(undefined)
  useSessionStore.setState({ requestResearchStop: request, fetchResearchCardDetails: refresh, researchBinding: null })
  // Seed a previous timed-out attempt, as the shared stop machine would.
  useResearchStopStore.getState().begin('r_uncertain', 'attempt')
  useResearchStopStore.getState().unconfirm('r_uncertain', 'attempt', 'lease is still live')
  render(<ResearchStopButton runId="r_uncertain" workspace="C:/fixture" status="stopping" stopRequested />)
  expect(screen.getByRole('status')).toHaveTextContent('lease is still live')
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  expect(refresh).toHaveBeenCalledWith('r_uncertain')
  fireEvent.click(screen.getByRole('button', { name: '重试停止' }))
  expect(request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认停止' }))
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'run', runId: 'r_uncertain', workspace: 'C:/fixture' }))
})

it('shows failed reason and a deliberate retry even over a board stop flag', () => {
  const request = vi.fn()
  useSessionStore.setState({ requestResearchStop: request, researchBinding: null })
  useResearchStopStore.getState().begin('r_failed', 'attempt')
  useResearchStopStore.getState().fail('r_failed', 'attempt', 'stop rejected')
  render(<ResearchStopButton runId="r_failed" status="active" stopRequested />)
  expect(screen.getByRole('alert')).toHaveTextContent('stop rejected')
  fireEvent.click(screen.getByRole('button', { name: '重试停止' }))
  expect(request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认停止' }))
  expect(request).toHaveBeenCalledOnce()
})

it('hides stale stop actions at terminal truth, but offers refresh while stopped lease is unknown', () => {
  useResearchStopStore.getState().begin('r_terminal', 'attempt')
  useResearchStopStore.getState().unconfirm('r_terminal', 'attempt', 'not verified')
  const view = render(<ResearchStopButton runId="r_terminal" status="done" />)
  expect(view.queryByRole('button', { name: '重试停止' })).not.toBeInTheDocument()
  expect(view.queryByRole('status')).not.toBeInTheDocument()
  view.rerender(<ResearchStopButton runId="r_terminal" status="stopped" driving />)
  expect(view.getByRole('button', { name: '刷新' })).toBeInTheDocument()
  view.rerender(<ResearchStopButton runId="r_terminal" status="stopped" driving={false} />)
  expect(view.queryByRole('button', { name: '重试停止' })).not.toBeInTheDocument()
})


it('keeps a refresh action available during an in-flight stop without another stop affordance', () => {
  const refresh = vi.fn().mockResolvedValue(undefined)
  useSessionStore.setState({ fetchResearchCardDetails: refresh })
  useResearchStopStore.getState().begin('r_pending_refresh', 'attempt')
  render(<ResearchStopButton runId="r_pending_refresh" status="stopping" />)
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  expect(refresh).toHaveBeenCalledWith('r_pending_refresh')
  expect(screen.queryByRole('button', { name: '重试停止' })).not.toBeInTheDocument()
})

it('prefers a newer stopped summary over stale live listing and stale workbench props', () => {
  useResearchRunStore.getState().applyListing({ runId: 'r_fresh', run: {
    id: 'r_fresh', question: 'Q', workspace: 'C:/fixture', status: 'stopping', phase: 'stopping',
    nodes: 1, tasks: 1, driving: true, stop_requested: true, updatedAt: 1,
  }, graph: { run: 'r_fresh', question: 'Q', status: 'stopping', phase: 'stopping', nodes: [] },
    sessions: [], suspension: null, suspensions: [] } as never)
  useSessionStore.setState({ researchRuns: [{
    id: 'r_fresh', question: 'Q', workspace: 'C:/fixture', status: 'stopped', phase: 'stopped',
    nodes: 1, tasks: 1, driving: false, updatedAt: 2,
  }] })
  render(<ResearchStopButton runId="r_fresh" workspace="C:/fixture" status="stopping" driving stopRequested />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '重试停止' })).not.toBeInTheDocument()
})

it('lets a fresh summary clear a stale stop flag without faking an in-flight stop', () => {
  useResearchRunStore.getState().applyListing({ runId: 'r_resume', run: {
    id: 'r_resume', question: 'Q', workspace: 'C:/fixture', status: 'active', phase: 'active',
    nodes: 1, tasks: 1, driving: true, stop_requested: true, updatedAt: 1,
  }, graph: { run: 'r_resume', question: 'Q', status: 'active', phase: 'active', nodes: [] },
    sessions: [], suspension: null, suspensions: [] } as never)
  useSessionStore.setState({ researchRuns: [{
    id: 'r_resume', question: 'Q', workspace: 'C:/fixture', status: 'active', phase: 'active',
    nodes: 1, tasks: 1, driving: true, stop_requested: false, updatedAt: 2,
  }] })
  render(<ResearchStopButton runId="r_resume" status="active" stopRequested />)
  expect(screen.getByRole('button', { name: '停止研究' })).toBeInTheDocument()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('keeps final card status terminal over a stale active board cache', () => {
  useSessionStore.setState({ researchRuns: [{
    id: 'r_final', question: 'Q', workspace: 'C:/fixture', status: 'active', phase: 'active',
    nodes: 1, tasks: 1, driving: true, updatedAt: 1,
  }] })
  render(<ResearchStopButton runId="r_final" status="done" />)
  expect(screen.queryByRole('button', { name: '停止研究' })).not.toBeInTheDocument()
})

it('reports a rejected refresh while keeping the uncertain stop available for deliberate retry', async () => {
  useSessionStore.setState({ fetchResearchCardDetails: vi.fn().mockRejectedValue(new Error('refresh offline')) })
  useResearchStopStore.getState().begin('r_refresh_error', 'attempt')
  useResearchStopStore.getState().unconfirm('r_refresh_error', 'attempt', 'lease unresolved')
  render(<ResearchStopButton runId="r_refresh_error" status="stopping" />)
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('refresh offline')
  expect(screen.getByRole('button', { name: '重试停止' })).toBeInTheDocument()
  expect(useResearchStopStore.getState().byRun.r_refresh_error.phase).toBe('unconfirmed')
})

it('surfaces a refresh detail sync error swallowed by the activity service', async () => {
  useSessionStore.setState({ fetchResearchCardDetails: vi.fn().mockImplementation(async () => {
    useResearchActivityStore.setState({ errors: { 'run:r_sync_error': 'detail unavailable' } })
  }) })
  useResearchStopStore.getState().begin('r_sync_error', 'attempt')
  useResearchStopStore.getState().unconfirm('r_sync_error', 'attempt', 'lease unresolved')
  render(<ResearchStopButton runId="r_sync_error" status="stopping" />)
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('detail unavailable')
  expect(screen.getByRole('button', { name: '重试停止' })).toBeInTheDocument()
})

it('portals stop confirmation without replacing the toolbar trigger and submits its opening target', () => {
  const request = vi.fn()
  useSessionStore.setState({ requestResearchStop: request })
  const target = { kind: 'run' as const, runId: 'r_portal', workspace: 'C:/opening', sessionId: 'session-A' }
  const view = render(<ResearchStopButton runId="r_portal" status="active" target={target} confirmationVariant="popover" />)
  const trigger = view.getByRole('button', { name: '停止研究' })
  trigger.focus()
  fireEvent.click(trigger)
  const confirm = screen.getByRole('button', { name: '确认停止' })
  expect(confirm).toHaveFocus()
  expect(view.container).toContainElement(trigger)
  expect(view.container).not.toContainElement(confirm)
  expect(screen.getByRole('dialog', { name: '确认停止研究' }).parentElement).toBe(document.body)
  expect(request).not.toHaveBeenCalled()
  fireEvent.click(confirm)
  expect(request).toHaveBeenCalledWith(target)
})

it('treats Escape and outside pointer as cancellation, restores focus, and consumes Escape before Composer', () => {
  const request = vi.fn()
  useSessionStore.setState({ requestResearchStop: request })
  const view = render(<ResearchStopButton runId="r_escape" status="active" confirmationVariant="popover" />)
  const trigger = view.getByRole('button', { name: '停止研究' })
  const composerStop = vi.fn()
  document.addEventListener('keydown', composerStop)
  try {
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('button', { name: '确认停止' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '确认停止研究' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(composerStop).not.toHaveBeenCalled()
    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog', { name: '确认停止研究' })).not.toBeInTheDocument()
    expect(request).not.toHaveBeenCalled()
  } finally { document.removeEventListener('keydown', composerStop) }
})

it('does not let run B confirm run A after the confirmation target changes', () => {
  const request = vi.fn()
  useSessionStore.setState({ requestResearchStop: request })
  const view = render(<ResearchStopButton runId="run-A" workspace="C:/A" status="active" confirmationVariant="popover" />)
  fireEvent.click(view.getByRole('button', { name: '停止研究' }))
  expect(screen.getByRole('dialog', { name: '确认停止研究' })).toBeInTheDocument()
  view.rerender(<ResearchStopButton runId="run-B" workspace="C:/B" status="active" confirmationVariant="popover" />)
  expect(screen.queryByRole('dialog', { name: '确认停止研究' })).not.toBeInTheDocument()
  expect(request).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: '停止研究' }))
  fireEvent.click(screen.getByRole('button', { name: '确认停止' }))
  expect(request).toHaveBeenCalledOnce()
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'run', runId: 'run-B', workspace: 'C:/B' }))
})

it('discards an unconfirmed target after a run switch even if the previous run returns', () => {
  const request = vi.fn()
  useSessionStore.setState({ requestResearchStop: request })
  const view = render(<ResearchStopButton runId="run-A" status="active" confirmationVariant="popover" />)
  fireEvent.click(view.getByRole('button', { name: '停止研究' }))
  view.rerender(<ResearchStopButton runId="run-B" status="active" confirmationVariant="popover" />)
  view.rerender(<ResearchStopButton runId="run-A" status="active" confirmationVariant="popover" />)
  expect(screen.queryByRole('dialog', { name: '确认停止研究' })).not.toBeInTheDocument()
  expect(request).not.toHaveBeenCalled()
})

it('keeps the exact opened run target when its props change before confirmation', () => {
  const request = vi.fn()
  useSessionStore.setState({ requestResearchStop: request })
  const opened = { kind: 'run' as const, runId: 'same-run', workspace: 'C:/A', streamId: 'stream-A' }
  const view = render(<ResearchStopButton runId="same-run" status="active" target={opened} confirmationVariant="popover" />)
  fireEvent.click(view.getByRole('button', { name: '停止研究' }))
  view.rerender(<ResearchStopButton runId="same-run" status="active"
    target={{ kind: 'run', runId: 'same-run', workspace: 'C:/B', streamId: 'stream-B' }} confirmationVariant="popover" />)
  fireEvent.click(screen.getByRole('button', { name: '确认停止' }))
  expect(request).toHaveBeenCalledWith(opened)
})

it('keeps complete failure feedback and refresh/retry controls in the compact popover variant', () => {
  const message = '非常长的停止失败说明：请重新读取研究根会话状态后，再决定是否重试停止该研究。'
  useResearchStopStore.getState().begin('r_long', 'attempt')
  useResearchStopStore.getState().fail('r_long', 'attempt', message)
  render(<ResearchStopButton runId="r_long" status="active" confirmationVariant="popover" />)
  expect(screen.getByRole('alert')).toHaveTextContent(message)
  expect(screen.getByRole('alert')).toHaveAttribute('title', message)
  expect(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '重试停止' }))
  expect(screen.getByRole('button', { name: '确认停止' })).toHaveFocus()
})

it.each(['failed', 'unconfirmed'] as const)('cancels an open confirmation through pending before %s feedback', phase => {
  const request = vi.fn()
  useSessionStore.setState({ requestResearchStop: request })
  render(<ResearchStopButton runId="r_transition" status="active" confirmationVariant="popover" />)
  fireEvent.click(screen.getByRole('button', { name: '停止研究' }))
  expect(screen.getByRole('dialog', { name: '确认停止研究' })).toBeInTheDocument()
  act(() => useResearchStopStore.getState().begin('r_transition', 'other-attempt'))
  expect(screen.queryByRole('dialog', { name: '确认停止研究' })).not.toBeInTheDocument()
  act(() => useResearchStopStore.getState()[phase === 'failed' ? 'fail' : 'unconfirm']('r_transition', 'other-attempt', 'other attempt settled'))
  expect(screen.queryByRole('dialog', { name: '确认停止研究' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '重试停止' })).toBeInTheDocument()
  expect(request).not.toHaveBeenCalled()
})

it('cancels an open confirmation when presentation becomes hidden on the same run', () => {
  const view = render(<ResearchStopButton runId="r_hidden" status="active" confirmationVariant="popover" />)
  fireEvent.click(screen.getByRole('button', { name: '停止研究' }))
  view.rerender(<ResearchStopButton runId="r_hidden" status="done" confirmationVariant="popover" />)
  view.rerender(<ResearchStopButton runId="r_hidden" status="active" confirmationVariant="popover" />)
  expect(screen.queryByRole('dialog', { name: '确认停止研究' })).not.toBeInTheDocument()
})

it('restores the trigger after an outside pointer dismissal from inside the confirmation', () => {
  render(<ResearchStopButton runId="r_outside" status="active" confirmationVariant="popover" />)
  const trigger = screen.getByRole('button', { name: '停止研究' })
  fireEvent.click(trigger)
  expect(screen.getByRole('button', { name: '确认停止' })).toHaveFocus()
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('dialog', { name: '确认停止研究' })).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
})

it('preserves deliberate pointer/focus navigation to an outside focusable control', () => {
  const outside = document.createElement('button')
  outside.textContent = '另一控件'
  document.body.append(outside)
  try {
    render(<ResearchStopButton runId="r_focus_out" status="active" confirmationVariant="popover" />)
    fireEvent.click(screen.getByRole('button', { name: '停止研究' }))
    fireEvent.pointerDown(outside)
    outside.focus() // The browser's default pointer action follows pointerdown listeners.
    expect(screen.queryByRole('dialog', { name: '确认停止研究' })).not.toBeInTheDocument()
    expect(outside).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: '停止研究' }))
    expect(screen.getByRole('button', { name: '确认停止' })).toHaveFocus()
    act(() => outside.focus()) // Tabbing/focusing elsewhere must not be trapped at the stop trigger.
    expect(screen.queryByRole('dialog', { name: '确认停止研究' })).not.toBeInTheDocument()
    expect(outside).toHaveFocus()
  } finally { outside.remove() }
})
