import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { MultiPaneFrame } from './MultiPaneFrame'
import { ResearchPaneFooter } from './ResearchPaneFooter'
import { consumeEscape, ESCAPE_PRIORITY, useEscapeLayer } from '../../lib/useEscapeLayer'

function ForegroundDialog({ autofocus, onClose }: { autofocus: boolean; onClose: () => void }) {
  const action = useRef<HTMLButtonElement>(null)
  useEscapeLayer(true, event => { consumeEscape(event); onClose() }, ESCAPE_PRIORITY.dialog)
  useEffect(() => { if (autofocus) action.current?.focus() }, [autofocus])
  return createPortal(<div role="dialog" aria-label="异步审批" aria-modal="true" style={{ position: 'fixed', zIndex: 50 }}>
    <button ref={action}>审批处理</button>
  </div>, document.body)
}

function Fixture({ initiallyExpanded = true, foreground = false, focusForeground = false, onDismissForeground = () => {} }: {
  initiallyExpanded?: boolean; foreground?: boolean; focusForeground?: boolean; onDismissForeground?: () => void
} = {}) {
  const [expanded, setExpanded] = useState(initiallyExpanded)
  return <><textarea aria-label="任务草稿" defaultValue="Preserve my draft" />
    <MultiPaneFrame executorId="a" label="成员 A" expanded={expanded} onClose={() => setExpanded(false)}>
      <section data-testid="fixture-pane" className="research-agent-pane research-agent-pane--reading">
        <button className="research-pane-expand" onClick={() => setExpanded(value => !value)}>{expanded ? '收起会话' : '展开会话'}</button>
        <div className="research-pane-body">Transcript</div>
        <ResearchPaneFooter telemetry={null} sessionLabel="成员 A" />
      </section>
    </MultiPaneFrame>
    {foreground && <ForegroundDialog autofocus={focusForeground} onClose={onDismissForeground} />}
  </>
}

it.each([
  { expanded: true, autofocus: false }, { expanded: false, autofocus: false },
  { expanded: true, autofocus: true }, { expanded: false, autofocus: true },
])('yields an already-open details portal to an asynchronous higher dialog (expanded=$expanded, autofocus=$autofocus)', async ({ expanded, autofocus }) => {
  const view = render(<Fixture initiallyExpanded={expanded} />)
  const trigger = screen.getByRole('button', { name: '查看会话详情：成员 A' })
  fireEvent.click(trigger)
  const details = screen.getByRole('dialog', { name: '会话详情：成员 A' })
  await waitFor(() => expect(details).toHaveFocus())
  const dismissForeground = () => view.rerender(<Fixture initiallyExpanded={expanded} />)
  view.rerender(<Fixture initiallyExpanded={expanded} foreground focusForeground={autofocus} onDismissForeground={dismissForeground} />)
  const higher = screen.getByRole('dialog', { name: '异步审批' })
  await waitFor(() => expect(details).not.toBeInTheDocument())
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  expect(trigger).not.toHaveFocus()
  expect(higher.closest('[inert]')).toBeNull()
  if (autofocus) expect(within(higher).getByRole('button', { name: '审批处理' })).toHaveFocus()
  if (expanded) expect(screen.getByRole('dialog', { name: '展开 成员 A 会话' })).not.toHaveAttribute('aria-modal')
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(higher).not.toBeInTheDocument()
  expect(screen.queryByRole('dialog', { name: '会话详情：成员 A' })).not.toBeInTheDocument()
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  if (expanded) {
    const reader = screen.getByRole('dialog', { name: '展开 成员 A 会话' })
    expect(reader).toHaveAttribute('aria-modal', 'true')
    expect(reader.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '展开 成员 A 会话' })).not.toBeInTheDocument()
  }
})

it('waits for expanded-reader foreground handoff, then Escape returns to details before collapsing the pane', async () => {
  render(<Fixture />)
  const pane = screen.getByTestId('fixture-pane')
  const body = pane.querySelector<HTMLElement>('.research-pane-body')!
  body.scrollTop = 137
  const expanded = screen.getByRole('dialog', { name: '展开 成员 A 会话' })
  const trigger = within(pane).getByRole('button', { name: '查看会话详情：成员 A' })
  const draft = screen.getByLabelText('任务草稿')
  expect(draft.closest('[inert]')).not.toBeNull()
  fireEvent.click(trigger)
  const details = screen.getByRole('dialog', { name: '会话详情：成员 A' })
  await waitFor(() => expect(details).toHaveFocus())
  expect(details.closest('[inert]')).toBeNull()
  expect(expanded).toHaveAttribute('data-foreground-open')
  expect(expanded).not.toHaveAttribute('aria-modal')
  fireEvent.keyDown(details, { key: 'Escape' })
  expect(details).not.toBeInTheDocument()
  expect(expanded).toBeInTheDocument()
  expect(expanded).toHaveAttribute('aria-modal', 'true')
  expect(trigger).toHaveFocus()
  expect(body.scrollTop).toBe(137)
  fireEvent.keyDown(trigger, { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: '展开 成员 A 会话' })).not.toBeInTheDocument()
  expect(screen.getByTestId('fixture-pane')).toBe(pane)
  expect(screen.getByRole('button', { name: '展开会话' })).toHaveFocus()
  expect(body.scrollTop).toBe(137)
  expect(draft.closest('[inert]')).toBeNull()
  expect(draft).toHaveValue('Preserve my draft')
})

it('preserves a footer trigger focused by the close button when expanded modality resumes', async () => {
  render(<Fixture />)
  const trigger = screen.getByRole('button', { name: '查看会话详情：成员 A' })
  fireEvent.click(trigger)
  const details = screen.getByRole('dialog', { name: '会话详情：成员 A' })
  await waitFor(() => expect(details).toHaveFocus())
  fireEvent.click(within(details).getByRole('button', { name: '关闭会话详情' }))
  expect(details).not.toBeInTheDocument()
  expect(screen.getByRole('dialog', { name: '展开 成员 A 会话' })).toHaveAttribute('aria-modal', 'true')
  expect(trigger).toHaveFocus()
})

it('dismisses details before an outside expand-control click moves the pane host', async () => {
  render(<Fixture />)
  const pane = screen.getByTestId('fixture-pane')
  const trigger = screen.getByRole('button', { name: '查看会话详情：成员 A' })
  fireEvent.click(trigger)
  const details = screen.getByRole('dialog', { name: '会话详情：成员 A' })
  await waitFor(() => expect(details).toHaveFocus())
  const expandControl = screen.getByRole('button', { name: '收起会话' })
  fireEvent.pointerDown(expandControl)
  fireEvent.click(expandControl)
  expect(details).not.toBeInTheDocument()
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByTestId('fixture-pane')).toBe(pane)
  expect(screen.queryByRole('dialog', { name: '展开 成员 A 会话' })).not.toBeInTheDocument()
})

it('keeps IME cancellation local and removes the portal and all reader inertness on mode unmount', async () => {
  const view = render(<Fixture />)
  fireEvent.click(screen.getByRole('button', { name: '查看会话详情：成员 A' }))
  const details = screen.getByRole('dialog', { name: '会话详情：成员 A' })
  await waitFor(() => expect(details).toHaveFocus())
  fireEvent.keyDown(details, { key: 'Escape', isComposing: true })
  expect(details).toBeInTheDocument()
  fireEvent.compositionStart(details)
  fireEvent.keyDown(details, { key: 'Escape' })
  expect(details).toBeInTheDocument()
  fireEvent.compositionEnd(details)
  view.unmount()
  expect(document.querySelector('.research-telemetry-popover')).toBeNull()
  expect(document.querySelector('[data-research-expanded-pane]')).toBeNull()
  expect(document.querySelector('[inert]')).toBeNull()
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  act(() => document.dispatchEvent(escape))
  expect(escape.defaultPrevented).toBe(false)
})
