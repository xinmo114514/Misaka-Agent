import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useLayoutEffect, type ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { useSettingsStore } from './store/useSettingsStore'
import { useSessionStore } from './store/useSessionStore'
import { request } from './lib/bridge'
import { useResearchWorkspaceStore } from './store/useResearchWorkspaceStore'
import { saveResearchViewMode } from './lib/researchViewMode'

const workspaceCommits = vi.hoisted(() => [] as Array<{ runId: string; mode: string; header: boolean; composerMode: string | null }>)

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Separator: () => null,
}))

vi.mock('./theme/useTheme', () => ({ useTheme: () => {} }))
vi.mock('./components/Sidebar/Sidebar', () => ({ Sidebar: () => null }))
vi.mock('./components/Timeline/Timeline', () => ({ Timeline: () => null }))
vi.mock('./components/ResearchWorkspace/ResearchTilingWorkspace', () => ({ ResearchTilingWorkspace: ({ runId, mode, onModeChange }: { runId: string; mode: string; onModeChange: (mode: 'focus') => void }) => {
  useLayoutEffect(() => { workspaceCommits.push({ runId, mode, header: Boolean(document.querySelector('[data-workspace-header]')), composerMode: document.querySelector('[data-conversation-viewport]')?.getAttribute('data-research-view-mode') ?? null }) })
  return <div data-testid="tile-workspace">{runId}<button onClick={() => onModeChange('focus')}>进入专注测试</button></div>
} }))
vi.mock('./components/Composer/Composer', () => ({ Composer: () => <textarea data-testid="shared-composer" /> }))
vi.mock('./components/ResearchGraph/ResearchGraphCanvas', () => ({ ResearchGraphCanvas: () => null }))
vi.mock('./components/Permission/PermissionDialog', () => ({ PermissionDialog: () => null }))
vi.mock('./components/Timeline/ResearchTaskDrawer', () => ({ ResearchTaskDrawer: () => null }))
vi.mock('./components/Timeline/ResearchGraphModal', () => ({ ResearchGraphModal: () => null }))
vi.mock('./components/Timeline/ResearchHistoryDialog', () => ({ ResearchHistoryDialog: () => null }))
vi.mock('./components/SessionTree/SessionTreePanel', () => ({ SessionTreePanel: () => null }))
vi.mock('./components/SessionTree/CompactDialog', () => ({ CompactDialog: () => null }))
vi.mock('./components/SessionRenameDialog', () => ({ SessionRenameDialog: () => null }))
vi.mock('./components/SessionDeleteDialog', () => ({ SessionDeleteDialog: () => null }))
vi.mock('./components/Settings/SettingsPage', () => ({ SettingsPage: () => null }))
vi.mock('./lib/bridge', async importOriginal => ({
  ...await importOriginal<typeof import('./lib/bridge')>(),
  request: vi.fn().mockResolvedValue({ runs: [{ id:'r_close', question:'Close fixture', workspace:'/fixture',status:'active', phase:'research',tasks:0,nodes:0 }] }),
}))

let closeListener: ((request: { closeRequestId: number }) => void) | undefined
let unsubscribe: ReturnType<typeof vi.fn>

beforeEach(() => {
  workspaceCommits.length = 0
  localStorage.clear()
  useResearchWorkspaceStore.setState({ byRun: {} })
  vi.mocked(request).mockResolvedValue({ runs: [{ id:'r_close', question:'Close fixture', workspace:'/fixture',status:'active', phase:'research',tasks:0,nodes:0 }] })
  closeListener = undefined
  unsubscribe = vi.fn(() => { closeListener = undefined })
  window.bridge = { send: vi.fn(), on: () => () => {} }
  window.researchBridge = { send: vi.fn(), on: () => () => {} }
  window.app = {
    setResearchActive: vi.fn(),
    onRequestClose: vi.fn((handler: (request: { closeRequestId: number }) => void) => { closeListener = handler; return unsubscribe }),
    reportClosePresented: vi.fn(),
    reportCloseCancelled: vi.fn(),
    confirmClose: vi.fn().mockResolvedValue(undefined),
  } as any
  useSettingsStore.setState({ closeWindowAction: 'ask' })
  useSessionStore.setState({ agentMode: 'research', researchBinding: null, researchPendingCreationRequestId: null })
})

it.each([['multi', 'focus'], ['focus', 'multi']] as const)('adopts %s to %s saved run mode on the first committed frame', (previous, next) => {
  const bind = (runId: string) => useSessionStore.setState({ agentMode: 'research', researchPageView: 'conversation', researchBinding: { runId, workspace: '/research', sessionId: `root-${runId}` } as never })
  useResearchWorkspaceStore.getState().setViewMode('A', previous)
  useResearchWorkspaceStore.getState().setViewMode('B', next)
  bind('A')
  render(<App />)
  workspaceCommits.length = 0
  act(() => bind('B'))
  expect(workspaceCommits[0]).toEqual({ runId: 'B', mode: next, header: false, composerMode: next })
})

it('uses the latest preference for a new run without leaking the previous saved run mode', () => {
  useResearchWorkspaceStore.getState().setViewMode('A', 'multi')
  useSessionStore.setState({ agentMode: 'research', researchPageView: 'conversation', researchBinding: { runId: 'A', workspace: '/research', sessionId: 'root-A' } as never })
  render(<App />)
  saveResearchViewMode('focus')
  workspaceCommits.length = 0
  act(() => useSessionStore.setState({ researchBinding: { runId: 'new', workspace: '/research', sessionId: 'root-new' } as never }))
  expect(workspaceCommits[0]).toMatchObject({ runId: 'new', mode: 'focus', header: false, composerMode: 'focus' })
})

it('hides ordinary chrome for a bound research focus run even before its listing arrives', () => {
  useSessionStore.setState({ agentMode: 'research', researchPageView: 'conversation',
    researchBinding: { runId: 'r_focus', workspace: '/research', sessionId: 'research-root' } as never,
    currentSessionId: 'ordinary-A', currentSessionPath: '/ordinary/A.jsonl', currentTitle: 'Ordinary A' })
  const view = render(<App />)
  expect(screen.getByTestId('tile-workspace')).toHaveTextContent('r_focus')
  expect(screen.queryByTitle('更多会话选项')).not.toBeInTheDocument()
  expect(screen.queryByTitle('会话树')).not.toBeInTheDocument()
  expect(view.container.querySelector('[data-workspace-header]')).not.toBeInTheDocument()
  expect(useSessionStore.getState().currentSessionId).toBe('ordinary-A')
  expect(useSessionStore.getState().currentSessionPath).toBe('/ordinary/A.jsonl')
})

it('preserves the ordinary workspace header outside bound research focus', () => {
  useSessionStore.setState({ agentMode: 'agent', researchBinding: null })
  const view = render(<App />)
  expect(view.container.querySelector('[data-workspace-header]')).toBeInTheDocument()
  expect(screen.getByTitle('更多会话选项')).toBeInTheDocument()
})

it('replaces ordinary chrome once for research multi and retains the same composer through focus', () => {
  useResearchWorkspaceStore.getState().setViewMode('r_focus', 'multi')
  useSessionStore.setState({ agentMode: 'agent', researchBinding: null })
  const view = render(<App />)
  const composer = screen.getByTestId('shared-composer')
  expect(view.container.querySelector('[data-workspace-header]')).toBeInTheDocument()
  fireEvent.change(composer, { target: { value: 'keep this draft' } })
  act(() => useSessionStore.setState({ agentMode: 'research', researchPageView: 'conversation',
    researchBinding: { runId: 'r_focus', workspace: '/research', sessionId: 'research-root' } as never }))
  expect(view.container.querySelector('[data-workspace-header]')).not.toBeInTheDocument()
  expect(screen.getByTestId('shared-composer')).toBe(composer)
  expect(composer).toHaveValue('keep this draft')
  fireEvent.click(screen.getByRole('button', { name: '进入专注测试' }))
  expect(view.container.querySelector('[data-workspace-header]')).not.toBeInTheDocument()
  expect(screen.getByTestId('shared-composer')).toBe(composer)
  expect(composer).toHaveValue('keep this draft')
  expect(screen.getAllByTestId('shared-composer')).toHaveLength(1)
})

it('opens the Misaka confirmation from the native close event during active research', async () => {
  render(<App />)
  expect(window.app.onRequestClose).toHaveBeenCalledOnce()
  await waitFor(() => expect(window.app.setResearchActive).toHaveBeenCalledWith(
    { active: true, pendingCount: 0, pendingStart: false }))
  act(() => closeListener!({ closeRequestId: 7 }))
  expect(screen.getByRole('alertdialog', { name: '关闭 Misaka 窗口？' })).toBeVisible()
  // The main process only stands its native fallback down once the dialog is really on screen.
  await waitFor(() => expect(window.app.reportClosePresented).toHaveBeenCalledWith(7))
  expect(window.app.confirmClose).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  expect(window.app.reportCloseCancelled).toHaveBeenCalledWith(7)
  act(() => closeListener!({ closeRequestId: 8 }))
  fireEvent.click(screen.getByRole('button', { name: '最小化到托盘' }))
  expect(window.app.confirmClose).toHaveBeenCalledWith('tray')
})

it.each(['tray', 'quit'] as const)('uses the latest saved %s choice without showing the dialog', action => {
  render(<App />)
  act(() => useSettingsStore.getState().setCloseWindowAction(action))
  act(() => closeListener!({ closeRequestId: 3 }))
  // Answering at all is proof the page is alive, so the native box must not appear.
  expect(window.app.reportClosePresented).toHaveBeenCalledWith(3)
  expect(window.app.confirmClose).toHaveBeenCalledWith(action)
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
})

it('tells the main process when a research start is still waiting for its run id', async () => {
  useSessionStore.setState({ researchPendingCreationRequestId: 'research-question-9' })
  render(<App />)
  await waitFor(() => expect(window.app.setResearchActive).toHaveBeenCalledWith(
    expect.objectContaining({ pendingStart: true })))
  act(() => useSessionStore.setState({ researchPendingCreationRequestId: null }))
  await waitFor(() => expect(window.app.setResearchActive).toHaveBeenLastCalledWith(
    expect.objectContaining({ pendingStart: false })))
})

it('removes the close subscription when the application unmounts', () => {
  const { unmount } = render(<App />)
  unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
})
it('does not erase native activity while the first board snapshot is still unknown',()=>{
 vi.mocked(request).mockImplementation(()=>new Promise(()=>{}))
 useSessionStore.setState({researchCards:{},researchRuns:[]})
 render(<App/>)
 expect(vi.mocked(window.app.setResearchActive).mock.calls.some(([state])=>typeof state==='object' && state?.active===false)).toBe(false)
})
it('opens a bound research run in tile workspace while new research stays in the composer scene', () => {
  useSessionStore.setState({ agentMode: 'research', researchPageView: 'conversation', researchBinding: {
    runId: 'r_tiles', sessionId: 'root', sessionFile: 'root.jsonl', workspace: '/fixture',
  } })
  const { rerender } = render(<App />)
  expect(screen.getByTestId('tile-workspace')).toHaveTextContent('r_tiles')
  expect(screen.getByTestId('tile-workspace').closest('[data-research-workspace]')).toBeInTheDocument()
  act(() => useSessionStore.setState({ researchPageView: 'new' }))
  rerender(<App />)
  expect(screen.queryByTestId('tile-workspace')).not.toBeInTheDocument()
  expect(document.querySelector('[data-research-workspace]')).toBeNull()
})
