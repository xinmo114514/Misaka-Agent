import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GeneralSection } from './GeneralSection'
import { useSettingsStore } from '../../../store/useSettingsStore'

describe('GeneralSection system path feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.bridge = { send: vi.fn(), on: () => () => {} }
    window.app = {
      pickDirectory: vi.fn(), getVersion: vi.fn(), openExternal: vi.fn(),
      openPath: vi.fn().mockResolvedValue({ ok: false, error: 'permission denied' }),
      showItemInFolder: vi.fn().mockResolvedValue({ ok: true }),
    } as any
    useSettingsStore.setState({
      configPaths: { cwd: 'C:/workspace', agentDir: 'C:/agent' } as any,
      closeWindowAction: 'ask',
    })
  })

  it('reports a system open failure', async () => {
    render(<GeneralSection />)
    fireEvent.click(screen.getByRole('button', { name: '打开' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('permission denied')
  })

  it('reports a failed backend directory switch and retains the active directory', async () => {
    vi.mocked(window.app.pickDirectory).mockResolvedValue('C:/chosen')
    render(<GeneralSection />)
    fireEvent.click(screen.getByRole('button', { name: '选择目录' }))
    await waitFor(() => expect(window.bridge.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'set_cwd', path: 'C:/chosen' })))
    const command = (window.bridge.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
    useSettingsStore.getState().handleBridgeMessage({ type: 'ack', requestId: command.requestId, ok: false, error: 'directory denied' } as any)
    expect(await screen.findByRole('alert')).toHaveTextContent('directory denied')
    expect(useSettingsStore.getState().configPaths?.cwd).toBe('C:/workspace')
  })

  it('toggles close window action between ask, tray, and quit', () => {
    render(<GeneralSection />)
    expect(screen.getByText('关闭窗口行为 (Close Window Action)')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '最小化到托盘' }))
    expect(useSettingsStore.getState().closeWindowAction).toBe('tray')

    fireEvent.click(screen.getByRole('button', { name: '退出应用' }))
    expect(useSettingsStore.getState().closeWindowAction).toBe('quit')

    fireEvent.click(screen.getByRole('button', { name: '每次询问' }))
    expect(useSettingsStore.getState().closeWindowAction).toBe('ask')
  })
})
