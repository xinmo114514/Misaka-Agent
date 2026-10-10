import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { useSettingsStore } from './store/useSettingsStore'
import { useSessionStore } from './store/useSessionStore'
import { request } from './lib/bridge'

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Separator: () => null,
}))

vi.mock('./theme/useTheme', () => ({ useTheme: () => {} }))
vi.mock('./components/Sidebar/Sidebar', () => ({ Sidebar: () => null }))
vi.mock('./components/Timeline/Timeline', () => ({ Timeline: () => null }))
vi.mock('./components/Composer/Composer', () => ({ Composer: () => null }))
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
  request: vi.fn().mockResolvedValue({ runs: [{ status: 'running' }] }),
}))

let closeListener: (() => void) | undefined
let unsubscribe: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.mocked(request).mockResolvedValue({ runs: [{ status: 'running' }] })
  closeListener = undefined
  unsubscribe = vi.fn(() => { closeListener = undefined })
  window.bridge = { send: vi.fn(), on: () => () => {} }
  window.researchBridge = { send: vi.fn(), on: () => () => {} }
  window.app = {
    setResearchActive: vi.fn(),
    onRequestClose: vi.fn((handler: () => void) => { closeListener = handler; return unsubscribe }),
    confirmClose: vi.fn().mockResolvedValue(undefined),
  } as any
  useSettingsStore.setState({ closeWindowAction: 'ask' })
  useSessionStore.setState({ agentMode: 'research', researchBinding: null })
})

it('opens the Misaka confirmation from the native close event during active research', async () => {
  render(<App />)
  expect(window.app.onRequestClose).toHaveBeenCalledOnce()
  await waitFor(() => expect(window.app.setResearchActive).toHaveBeenCalledWith({ active: true, pendingCount: 0 }))
  act(() => closeListener!())
  expect(screen.getByRole('alertdialog', { name: '关闭 Misaka 窗口？' })).toBeVisible()
  expect(window.app.confirmClose).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  act(() => closeListener!())
  fireEvent.click(screen.getByRole('button', { name: '最小化到托盘' }))
  expect(window.app.confirmClose).toHaveBeenCalledWith('tray')
})

it.each(['tray', 'quit'] as const)('uses the latest saved %s choice without showing the dialog', action => {
  render(<App />)
  act(() => useSettingsStore.getState().setCloseWindowAction(action))
  act(() => closeListener!())
  expect(window.app.confirmClose).toHaveBeenCalledWith(action)
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
})

it('removes the close subscription when the application unmounts', () => {
  const { unmount } = render(<App />)
  unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
})
