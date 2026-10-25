import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { ResearchTeamNavigator } from './ResearchTeamNavigator'
import { rootControllerId, sessionLabel, teamTotals, teamGroups } from './researchTeam'
import type { ResearchSessionDescriptor, ResearchSessionsPayload } from '../../types/research'

const card = (id: string, role: 'last_order' | 'sister', nodeId = 'root', extra: Partial<ResearchSessionDescriptor> = {}): ResearchSessionDescriptor => ({
  executorId: id, sessionId: id, sessionFile: null, nodeId, taskId: id, role, label: id,
  cardTitle: id, workspace: 'C:/fixture', status: 'done', generation: 1, attempt: 1,
  startedAt: 100, endedAt: 200, error: null, ...extra,
})
const listing = (sessions: ResearchSessionDescriptor[]): ResearchSessionsPayload => ({
  runId: 'r',
  run: { id: 'r', question: 'Q', workspace: 'C:/fixture', status: 'active', phase: 'cards', nodes: 2, tasks: sessions.length },
  graph: { run: 'r', question: 'Q', status: 'active', phase: 'cards', nodes: [
    { id: 'root', question: 'Q', depth: 0, status: 'active', kind: 'root', parents: [], children: ['branch'] },
    { id: 'branch', question: 'B', depth: 1, status: 'active', kind: 'alt', parents: ['root'], children: [] },
  ] },
  sessions, suspension: null, suspensions: [],
})
const open = (sessions: ResearchSessionDescriptor[], currentId: string | null = null) => {
  const handlers = { onOpenMain: vi.fn(), onOpenSide: vi.fn(), onReturnToMain: vi.fn() }
  render(<ResearchTeamNavigator listing={listing(sessions)} currentId={currentId} {...handlers} />)
  return handlers
}

beforeEach(() => { document.body.innerHTML = '' })

describe('naming a member', () => {
  it('calls only the root Last Order 主控, and names a branch coordinator after its node', () => {
    const sessions = [card('lo', 'last_order', 'root', { label: 'Last Order' }),
      card('blo', 'last_order', 'branch', { label: 'Last Order', cardTitle: '汇总节点主控' }),
      card('a', 'sister', 'branch', { cardTitle: '检索召回' })]
    const value = listing(sessions)
    expect(rootControllerId(value)).toBe('lo')
    expect(sessionLabel(sessions[0], 'lo')).toBe('主控')
    // A branch's Last Order coordinates its own node; calling it 主控 would misstate where the reader is.
    expect(sessionLabel(sessions[1], 'lo')).toBe('汇总节点主控')
    expect(sessionLabel(sessions[2], 'lo')).toBe('检索召回')
  })

  it('groups members by node and counts only current attempts as members', () => {
    const sessions = [card('lo', 'last_order', 'root'), card('old', 'sister', 'root', { isCurrent: false, attempt: 1 }),
      card('a', 'sister', 'root', { status: 'running' }), card('b', 'sister', 'branch')]
    const groups = teamGroups(listing(sessions))
    expect(groups).toHaveLength(2)
    expect(teamTotals(groups)).toMatchObject({ current: 3, live: 1 })
  })
})

describe('ResearchTeamNavigator', () => {
  it('moves focus inside only on an intentional focus-team open and preserves actual root identity', () => {
    const handlers = { onOpenMain: vi.fn(), onOpenSide: vi.fn(), onReturnToMain: vi.fn() }
    render(<ResearchTeamNavigator presentation="focus" listing={listing([card('branch-lo', 'last_order', 'branch'), card('root-lo', 'last_order'), card('a', 'sister')])} currentId="root-lo" {...handlers} />)
    const outside = document.createElement('button')
    document.body.append(outside); outside.focus()
    const trigger = screen.getByRole('button', { name: /研究团队/ })
    expect(trigger).toHaveTextContent('团队 · 3')
    expect(trigger).toHaveAccessibleName(/当前主控/)
    fireEvent.pointerEnter(trigger.parentElement!)
    expect(outside).toHaveFocus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const directory = screen.getByRole('dialog', { name: '研究团队目录' })
    expect(directory.contains(document.activeElement)).toBe(true)
    expect(within(directory).queryByRole('button', { name: '返回主控会话' })).not.toBeInTheDocument()
    fireEvent.click(within(directory).getByTestId('research-team-member-a'))
    expect(trigger).toHaveFocus()
    outside.remove()
  })
  it('portals the directory out of the clipping header, and closes it again on a choice', () => {
    const handlers = open([card('lo', 'last_order', 'root'), card('a', 'sister')])
    const pill = screen.getByRole('button', { name: '研究团队：2 个成员' })
    expect(screen.queryByRole('dialog', { name: '研究团队目录' })).not.toBeInTheDocument()
    fireEvent.click(pill)
    const directory = screen.getByRole('dialog', { name: '研究团队目录' })
    // Rendered at the body: the app header truncates its own children, so an in-place list is clipped.
    expect(directory.parentElement).toBe(document.body)
    expect(pill).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(within(directory).getByTestId('research-team-member-a'))
    expect(handlers.onOpenMain).toHaveBeenCalledWith(expect.objectContaining({ executorId: 'a' }))
    expect(screen.queryByRole('dialog', { name: '研究团队目录' })).not.toBeInTheDocument()
  })

  it('does not reopen itself from the pointer that made the choice', () => {
    open([card('lo', 'last_order', 'root'), card('a', 'sister')])
    const pill = screen.getByRole('button', { name: '研究团队：2 个成员' })
    fireEvent.click(pill)
    fireEvent.click(within(screen.getByRole('dialog', { name: '研究团队目录' })).getByTestId('research-team-member-a'))
    // Choosing unmounts the layer under a pointer still over the pill; the browser reports that as
    // another entry, which must not count as a fresh hover.
    const nav = pill.parentElement!
    fireEvent.pointerMove(nav)
    expect(screen.queryByRole('dialog', { name: '研究团队目录' })).not.toBeInTheDocument()
  })

  it('names the member being read, and offers the way back to the controller', () => {
    const handlers = open([card('lo', 'last_order', 'root'), card('a', 'sister', 'root', { cardTitle: '检索召回' })], 'a')
    expect(screen.getByRole('button', { name: '研究团队：2 个成员' })).toHaveTextContent('检索召回')
    fireEvent.click(screen.getByRole('button', { name: '研究团队：2 个成员' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '研究团队目录' })).getByRole('button', { name: '返回主控会话' }))
    expect(handlers.onReturnToMain).toHaveBeenCalledOnce()
  })

  it('opens a side viewer without changing which member the main area reads', () => {
    const handlers = open([card('lo', 'last_order', 'root'), card('a', 'sister')])
    fireEvent.click(screen.getByRole('button', { name: '研究团队：2 个成员' }))
    fireEvent.click(screen.getByRole('button', { name: '在右侧查看 a' }))
    expect(handlers.onOpenSide).toHaveBeenCalledWith(expect.objectContaining({ executorId: 'a' }))
    expect(handlers.onOpenMain).not.toHaveBeenCalled()
  })

  it('omits side actions when the directory is used for multi navigation', () => {
    const onOpenMain = vi.fn()
    render(<ResearchTeamNavigator presentation="focus" listing={listing([card('lo', 'last_order'), card('a', 'sister')])}
      currentId="lo" onOpenMain={onOpenMain} onReturnToMain={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: /研究团队/ })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const directory = screen.getByRole('dialog', { name: '研究团队目录' })
    expect(within(directory).queryAllByRole('button', { name: /在右侧查看/ })).toHaveLength(0)
    fireEvent.click(within(directory).getByTestId('research-team-member-a'))
    expect(onOpenMain).toHaveBeenCalledWith(expect.objectContaining({ executorId: 'a' }))
    expect(trigger).toHaveFocus()
  })

  it('closes on Escape and hands focus back to the pill', () => {
    open([card('lo', 'last_order', 'root')])
    const pill = screen.getByRole('button', { name: '研究团队：1 个成员' })
    fireEvent.click(pill)
    expect(screen.getByRole('dialog', { name: '研究团队目录' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '研究团队目录' })).not.toBeInTheDocument()
    expect(pill).toHaveFocus()
  })

  it('says plainly when the run has not dispatched anyone yet', () => {
    open([])
    fireEvent.click(screen.getByRole('button', { name: '研究团队：0 个成员' }))
    expect(screen.getByText('这项研究还没有派出子代理。')).toBeInTheDocument()
  })
})

describe('directory keyboard and preview lifecycle', () => {
  it.each(['Enter', ' ', 'ArrowDown'])('focuses the current member on %s, preserving adjacent side and history tab stops', key => {
    open([card('lo', 'last_order'), card('a', 'sister')], 'a')
    const trigger = screen.getByRole('button', { name: /研究团队/ }); trigger.focus()
    fireEvent.keyDown(trigger, { key })
    const directory = screen.getByRole('dialog', { name: '研究团队目录' })
    expect(within(directory).getByTestId('research-team-member-a')).toHaveFocus()
    expect(within(directory).getByRole('button', { name: '在右侧查看 a' })).not.toHaveAttribute('tabindex', '-1')
  })
  it('ends an unpinned preview when leaving its portalled layer, while a pinned directory stays open', () => {
    vi.useFakeTimers()
    try {
      open([card('lo', 'last_order')]); const trigger = screen.getByRole('button', { name: /研究团队/ }); trigger.focus()
      fireEvent.pointerEnter(trigger.parentElement!)
      let directory = screen.getByRole('dialog', { name: '研究团队目录' }); expect(trigger).toHaveFocus()
      fireEvent.pointerLeave(directory); act(() => vi.advanceTimersByTime(200)); expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      fireEvent.click(trigger); directory = screen.getByRole('dialog'); fireEvent.pointerLeave(directory); act(() => vi.advanceTimersByTime(200)); expect(directory).toBeInTheDocument()
    } finally { vi.useRealTimers() }
  })
})
