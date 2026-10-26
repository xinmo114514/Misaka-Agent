import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResearchTilingWorkspace } from './ResearchTilingWorkspace'
import { Composer } from '../Composer/Composer'
import { ResearchHistoryDialog } from '../Timeline/ResearchHistoryDialog'
import { useResearchRunStore } from '../../store/useResearchRunStore'
import { useResearchSessionsStore } from '../../store/useResearchSessionsStore'
import { useResearchWorkspaceStore } from '../../store/useResearchWorkspaceStore'
import { useSessionStore } from '../../store/useSessionStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { researchSessionsBridge } from '../../lib/researchSessionsBridge'
import { request } from '../../lib/bridge'
import type { ResearchSessionDescriptor, ResearchSessionsPayload } from '../../types/research'

vi.mock('../../lib/researchSessionsBridge', () => ({ researchSessionsBridge: {
  retainVisible: vi.fn((runId: string, ids: string[], workspace?: string, status?: (error: unknown | null) => void) => {
    let live = true
    void researchSessionsBridge.watch(runId, ids, workspace).then(
      () => { if (live) status?.(null) }, error => { if (live) status?.(error) },
    )
    return () => { live = false }
  }),
  load: vi.fn().mockResolvedValue(null), watch: vi.fn().mockResolvedValue(undefined),
  history: vi.fn().mockResolvedValue(null), content: vi.fn(),
} }))
vi.mock('../../lib/bridge', async original => ({ ...await original<typeof import('../../lib/bridge')>(), request: vi.fn() }))
vi.mock('../../lib/researchActivityStore', async original => ({
  ...await original<typeof import('../../lib/researchActivityStore')>(),
  subscribeResearchRun: () => () => {}, subscribeResearchHistory: () => () => {},
}))

const stop = vi.fn()
const member = (id: string, role: 'last_order' | 'sister'): ResearchSessionDescriptor => ({
  executorId: id, sessionId: id, sessionFile: null, nodeId: 'root', taskId: id, role,
  label: id, cardTitle: `${id} task`, workspace: '/fixture', status: 'running',
  generation: 1, attempt: 1, startedAt: 1, endedAt: null, error: null,
})

function publish(count = 2, controller = true) {
  const sessions = [...(controller ? [member('lo', 'last_order')] : []),
    ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].slice(0, count).map(id => member(id, 'sister'))]
  const listing: ResearchSessionsPayload = {
    runId: 'r', run: { id: 'r', question: 'Research question', workspace: '/fixture', status: 'active',
      phase: 'cards', driving: true, nodes: 1, tasks: count },
    graph: { run: 'r', question: 'Research question', status: 'active', phase: 'cards', nodes: [{
      id: 'root', question: 'Root question', kind: 'root', depth: 0, status: 'active', parents: [], children: [],
      cards: [{ id: 'task-a', title: 'Evidence collection', status: 'running' }],
    }] }, sessions, suspension: null, suspensions: [],
  }
  useResearchRunStore.setState({ runs: { r: listing } })
  useResearchSessionsStore.getState().upsertDescriptors('r', sessions)
  return listing
}

function open() {
  return render(<div data-conversation-viewport>
    <ResearchTilingWorkspace runId="r" workspace="/fixture" />
    <Composer />
    <ResearchHistoryDialog />
  </div>)
}

beforeEach(() => {
  localStorage.clear()
  stop.mockReset()
  vi.mocked(request).mockResolvedValue({ detail: { plan: null } })
  vi.mocked(researchSessionsBridge.load).mockReset().mockResolvedValue(null as never)
  vi.mocked(researchSessionsBridge.watch).mockReset().mockResolvedValue(undefined)
  vi.mocked(researchSessionsBridge.history).mockReset().mockResolvedValue(null as never)
  useResearchWorkspaceStore.setState({ byRun: {} })
  useResearchWorkspaceStore.getState().setViewMode('r', 'multi')
  useResearchSessionsStore.setState({ byExecutor: {} })
  useResearchRunStore.setState({ runs: {} })
  useSessionStore.setState({ agentMode: 'research', researchPageView: 'conversation',
    researchBinding: { runId: 'r', sessionId: 'root-session', sessionFile: '/root', workspace: '/fixture' } as never,
    researchConversation: { messages: [], isStreaming: true, isAborting: false, isIdle: false, stats: {}, contextUsage: null } as never,
    draft: 'Preserve my multi draft', researchCards: {}, researchRuns: [], researchTeam: null,
    requestResearchStop: stop, researchHistoryOpen: false, isSessionLoading: false, sessionLoadError: null,
  })
  useSettingsStore.setState({ currentModel: { provider: 'test', modelId: 'model', name: 'Model', thinking: 'off' }, models: [] })
})
afterEach(() => vi.unstubAllGlobals())

describe('multi research workspace integration', () => {
  it('keeps the common toolbar available during a failed listing load and retry', async () => {
    vi.mocked(researchSessionsBridge.load).mockRejectedValueOnce(new Error('multi listing offline'))
    const result = open()
    expect(result.container.querySelectorAll('[data-research-workspace-toolbar]')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '专注' })).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('multi listing offline')
    fireEvent.click(screen.getByRole('button', { name: '重试读取' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(result.container.querySelectorAll('[data-research-workspace-toolbar]')).toHaveLength(1)
  })

  it.each([0, 1, 2, 3, 4, 5, 6])('lays out only the controller and %i real members without artificial waiting panes', count => {
    publish(count)
    const result = open()
    expect(screen.getAllByRole('region', { name: /会话$/ })).toHaveLength(count + 1)
    expect(result.container.querySelectorAll('[data-research-multi-layout]')).toHaveLength(1)
    expect(result.container.querySelectorAll('[data-research-task-grid] > [data-research-pane-frame]')).toHaveLength(count)
    expect(result.container.querySelector('.research-empty-pane')).toBeNull()
    expect(Boolean(screen.queryByText('当前节点暂无成员会话'))).toBe(count === 0)
  })

  it('subscribes to at most six real members and replaces an overflow member on focus', () => {
    const listing = publish(7)
    const result = open()
    expect(result.container.querySelectorAll('[data-research-pane-frame]')).toHaveLength(7)
    expect(researchSessionsBridge.watch).toHaveBeenLastCalledWith('r', ['lo', 'a', 'b', 'c', 'd', 'e', 'f'], '/fixture')
    act(() => useResearchWorkspaceStore.getState().focusExecutor('r', listing.sessions.find(item => item.executorId === 'g')!))
    expect(screen.getByTestId('research-pane-g')).toBeInTheDocument()
    expect(screen.queryByTestId('research-pane-f')).not.toBeInTheDocument()
    expect(result.container.querySelectorAll('[data-research-pane-frame]')).toHaveLength(7)
    expect(researchSessionsBridge.watch).toHaveBeenLastCalledWith('r', ['lo', 'g', 'a', 'b', 'c', 'd', 'e'], '/fixture')
  })

  it('uses the actual workspace width and layout client height, preserving panes through resize and streaming', () => {
    let width = 1100
    let height = 780
    const resized = new Set<() => void>()
    const disconnected = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized.add(callback) }
      observe() {}
      disconnect() { disconnected() }
    })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('research-tiling-container') ? width : width - 24
    })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-research-multi-layout') ? height : 0
    })
    publish(4)
    const result = open()
    const layout = result.container.querySelector<HTMLElement>('[data-research-multi-layout]')!
    const pane = screen.getByTestId('research-pane-a')
    const frame = pane.closest<HTMLElement>('[data-research-pane-frame]')!
    const spans = () => Array.from(layout.querySelectorAll<HTMLElement>('[data-research-pane-frame]')).map(item => item.style.gridColumn)
    expect(spans()).toEqual(['span 4', 'span 2', 'span 2', 'span 2', 'span 2'])
    expect(layout.style.getPropertyValue('--research-mosaic-row-cap')).toBe('384px')
    act(() => { width = 1099; resized.forEach(callback => callback()) })
    expect(spans()).toEqual(['span 6', 'span 3', 'span 3', 'span 3', 'span 3'])
    expect(layout.style.getPropertyValue('--research-mosaic-row-cap')).toBe('264px')
    act(() => { width = 819; height = 180; resized.forEach(callback => callback()) })
    expect(spans()).toEqual(['span 6', 'span 6', 'span 6', 'span 6', 'span 6'])
    expect(layout).toHaveAttribute('data-tiny-height', 'true')
    act(() => useResearchSessionsStore.setState(state => ({ byExecutor: { ...state.byExecutor,
      a: { ...state.byExecutor.a, streaming: { id: 'stream-a', role: 'assistant', content: 'New streamed words', timestamp: 1 } },
    } })))
    expect(screen.getByTestId('research-pane-a')).toBe(pane)
    expect(pane.closest('[data-research-pane-frame]')).toBe(frame)
    expect(spans()).toEqual(['span 6', 'span 6', 'span 6', 'span 6', 'span 6'])
    expect(pane).toHaveTextContent('New streamed words')
    result.unmount()
    expect(disconnected).toHaveBeenCalled()
  })

  it('restores the outer mosaic reading position independently for each node and across focus mode', () => {
    const listing = publish(6)
    listing.graph.nodes.push({ ...listing.graph.nodes[0], id: 'other', question: 'Other node' })
    const other = member('other-member', 'sister')
    other.nodeId = 'other'
    listing.sessions.push(other)
    useResearchSessionsStore.getState().upsertDescriptors('r', [other])
    const result = open()
    const layout = () => result.container.querySelector<HTMLElement>('[data-research-multi-layout]')!
    layout().scrollTop = 411
    fireEvent.scroll(layout())
    act(() => useResearchWorkspaceStore.getState().selectNode('r', 'other'))
    expect(layout().scrollTop).toBe(0)
    layout().scrollTop = 93
    fireEvent.scroll(layout())
    act(() => useResearchWorkspaceStore.getState().selectNode('r', 'root'))
    expect(layout().scrollTop).toBe(411)
    fireEvent.click(screen.getByRole('button', { name: '专注' }))
    fireEvent.click(screen.getByRole('button', { name: '多窗' }))
    expect(layout().scrollTop).toBe(411)
    act(() => useResearchWorkspaceStore.getState().selectNode('r', 'other'))
    expect(layout().scrollTop).toBe(93)
  })

  it('retains the natural grid slot footprint only while its pane is expanded', () => {
    publish()
    const result = open()
    const pane = screen.getByTestId('research-pane-a')
    const frame = pane.closest<HTMLElement>('[data-research-pane-frame]')!
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({ height: 229 } as DOMRect)
    const entry = within(pane).getByRole('button', { name: '展开会话' })
    fireEvent.click(entry)
    expect(frame.style.height).toBe('229px')
    expect(screen.getByRole('dialog', { name: /展开.*会话/ })).toContainElement(pane)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(frame.style.height).toBe('')
    expect(frame).toContainElement(pane)
    expect(result.container.querySelectorAll('[data-research-pane-frame]')).toHaveLength(3)
  })

  it('uses actual member sessions when a selected node has no coordinator', () => {
    publish(3, false)
    const result = open()
    expect(screen.getAllByRole('region', { name: /会话$/ })).toHaveLength(3)
    expect(result.container.querySelector('[data-research-multi-layout]')).toHaveAttribute('data-has-controller', 'false')
    expect(result.container.querySelector('.research-agent-pane--coordinator')).toBeNull()
    expect(result.container.querySelector('.research-empty-pane')).toBeNull()
  })

  it('opens one process panel in multi and preserves the only Composer while switching modes', () => {
    publish()
    const result = open()
    const input = screen.getByRole('textbox', { name: '给 Misaka 发送任务' })
    expect(screen.queryByRole('region', { name: '研究运行过程' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '更多研究选项' }))
    fireEvent.click(screen.getByRole('button', { name: '研究过程' }))
    expect(screen.getAllByRole('region', { name: '研究运行过程' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '专注' }))
    expect(screen.getAllByRole('region', { name: '研究运行过程' })).toHaveLength(1)
    expect(result.container.querySelectorAll('[data-research-workspace-toolbar]')).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBe(input)
    expect(input).toHaveValue('Preserve my multi draft')
    fireEvent.click(screen.getByRole('button', { name: '多窗' }))
    expect(screen.getAllByRole('region', { name: '研究运行过程' })).toHaveLength(1)
    expect(screen.queryByRole('region', { name: '研究运行概览' })).not.toBeInTheDocument()
    expect(result.container.querySelector('.research-workspace-toolbar')).toBeNull()
    expect(screen.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBe(input)
  })

  it('moves the same pane into a full-window modal and restores its entry without stopping research', () => {
    publish()
    const result = open()
    const pane = screen.getByTestId('research-pane-a')
    const body = pane.querySelector<HTMLElement>('.research-pane-body')!
    body.scrollTop = 137
    fireEvent.scroll(body)
    const entry = within(pane).getByRole('button', { name: '展开会话' })
    entry.focus()
    fireEvent.click(entry)
    const dialog = screen.getByRole('dialog', { name: /展开.*会话/ })
    expect(dialog.parentElement).toBe(document.body)
    expect(within(dialog).getByTestId('research-pane-a')).toBe(pane)
    expect(body.scrollTop).toBe(137)
    expect(dialog.contains(document.activeElement)).toBe(true)
    const input = result.container.querySelector('textarea')!
    expect(input.closest('[inert]')).not.toBeNull()
    const controls = within(dialog).getAllByRole('button')
    const lastStop = within(dialog.querySelector('footer')!).getByRole('button', { name: /查看会话详情/ })
    lastStop.focus()
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(controls[0]).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
    expect(lastStop).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: /展开.*会话/ })).not.toBeInTheDocument()
    expect(screen.getByTestId('research-pane-a')).toBe(pane)
    expect(entry).toHaveFocus()
    expect(body.scrollTop).toBe(137)
    expect(input.closest('[inert]')).toBeNull()
    expect(input).toHaveValue('Preserve my multi draft')
    expect(stop).not.toHaveBeenCalled()
    expect(researchSessionsBridge.watch).toHaveBeenCalledOnce()
  })

  it('yields focus and Escape to a foreground history dialog before collapsing an expanded pane', () => {
    publish()
    const result = open()
    const entry = within(screen.getByTestId('research-pane-lo')).getByRole('button', { name: '展开会话' })
    entry.focus()
    fireEvent.click(entry)
    const expanded = screen.getByRole('dialog', { name: /展开.*会话/ })
    act(() => useSessionStore.getState().setResearchHistoryOpen(true))
    const history = screen.getByRole('dialog', { name: '研究历史记录' })
    expect(history.closest('[inert]')).toBeNull()
    expect(expanded).not.toHaveAttribute('aria-modal')
    const close = within(history).getByRole('button', { name: '关闭研究历史' })
    close.focus()
    expect(close).toHaveFocus()
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(history).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: /展开.*会话/ })).toBe(expanded)
    expect(expanded).toHaveAttribute('aria-modal', 'true')
    expect(expanded.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: /展开.*会话/ })).not.toBeInTheDocument()
    expect(entry).toHaveFocus()
    expect(stop).not.toHaveBeenCalled()
    expect(result.container.querySelector('textarea')?.closest('[inert]')).toBeNull()
  })

  it('retains the expanded owner over IME Escape and releases all inertness when unmounted', () => {
    publish()
    const result = open()
    const entry = within(screen.getByTestId('research-pane-lo')).getByRole('button', { name: '展开会话' })
    fireEvent.click(entry)
    const dialog = screen.getByRole('dialog', { name: /展开.*会话/ })
    fireEvent.keyDown(dialog, { key: 'Escape', isComposing: true })
    expect(dialog).toBeInTheDocument()
    expect(stop).not.toHaveBeenCalled()
    result.unmount()
    expect(document.querySelector('[data-research-expanded-pane]')).toBeNull()
    expect(document.querySelector('[inert]')).toBeNull()
  })

  it('restores reading and ignores transient zero scroll events caused by native host reparenting', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const listing = publish()
    listing.sessions.find(item => item.executorId === 'a')!.contract = 'Keep this task contract through reader host moves.'
    open()
    const pane = screen.getByTestId('research-pane-a')
    const body = pane.querySelector<HTMLElement>('.research-pane-body')!
    Object.defineProperties(body, { scrollHeight: { value: 2000 }, clientHeight: { value: 300 } })
    body.scrollTop = 250
    fireEvent.scroll(body)
    const disclosure = pane.querySelector<HTMLDetailsElement>('.research-card-contract')!
    fireEvent.click(disclosure.querySelector('summary')!)
    expect(disclosure.open).toBe(true)
    // Chromium resets scroll offsets when a scroller's portal host is detached/reparented.
    // jsdom has no layout engine, so reproduce that native boundary side effect while keeping
    // the real portal, pane, event handlers and workspace reading store under test.
    const append = Element.prototype.append
    vi.spyOn(Element.prototype, 'append').mockImplementation(function (this: Element, ...nodes: (Node | string)[]) {
      const movesPane = nodes.some(node => node instanceof HTMLElement && node.parentElement && node.contains(body))
      append.apply(this, nodes)
      if (movesPane) { body.scrollTop = 0; body.dispatchEvent(new Event('scroll', { bubbles: true })) }
    })
    const entry = within(pane).getByRole('button', { name: '展开会话' })
    fireEvent.click(entry)
    expect(screen.getByRole('dialog', { name: /展开.*会话/ })).toContainElement(pane)
    expect(body.scrollTop).toBe(250)
    expect(useResearchWorkspaceStore.getState().byRun.r.reading.a).toEqual({ scrollTop: 250, following: false })
    body.scrollTop = 0
    fireEvent.scroll(body)
    expect(useResearchWorkspaceStore.getState().byRun.r.reading.a).toEqual({ scrollTop: 250, following: false })
    act(() => frames.shift()!(0))
    expect(body.scrollTop).toBe(250)
    act(() => frames.shift()!(1))
    body.scrollTop = 320
    fireEvent.scroll(body)
    expect(useResearchWorkspaceStore.getState().byRun.r.reading.a).toEqual({ scrollTop: 320, following: false })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(body.scrollTop).toBe(320)
    expect(useResearchWorkspaceStore.getState().byRun.r.reading.a).toEqual({ scrollTop: 320, following: false })
    expect(screen.getByTestId('research-pane-a')).toBe(pane)
    expect(pane.querySelector('.research-card-contract')).toBe(disclosure)
    expect(disclosure.open).toBe(true)
  })
})
