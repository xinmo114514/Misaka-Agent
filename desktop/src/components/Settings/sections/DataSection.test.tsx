import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DataSection } from './DataSection'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { useSessionStore } from '../../../store/useSessionStore'

describe('DataSection export feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.bridge = { send: vi.fn(), on: () => () => {} }
    window.app = {
      pickDirectory: vi.fn(), getVersion: vi.fn(), openExternal: vi.fn(),
      openPath: vi.fn().mockResolvedValue({ ok: true }), showItemInFolder: vi.fn().mockResolvedValue({ ok: true }),
    } as any
    useSettingsStore.setState({
      configPaths: { cwd: 'C:/workspace', agentDir: 'C:/agent', authPath: 'C:/auth', sessionsDir: 'C:/sessions' } as any,
      lastExportedPath: 'C:/exports/previous.jsonl',
    })
    useSessionStore.setState({ currentSessionPath: 'C:/sessions/current.jsonl', sessions: [] } as any)
  })

  it('clears an old path and shows an export failure without a stale folder button', async () => {
    render(<DataSection />)
    fireEvent.click(screen.getByRole('button', { name: '一键导出当前会话' }))
    const command = (window.bridge.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
    expect(screen.getByRole('status')).toHaveTextContent('正在导出 JSONL')
    useSettingsStore.getState().handleBridgeMessage({ type: 'ack', requestId: command.requestId, ok: false, error: 'write failed' } as any)
    expect(await screen.findByRole('alert')).toHaveTextContent('write failed')
    expect(useSettingsStore.getState().lastExportedPath).toBeNull()
    expect(screen.queryByRole('button', { name: '在文件夹中查看' })).not.toBeInTheDocument()
  })

  it('shows the exact acknowledged export path and offers to locate that file', async () => {
    render(<DataSection />)
    fireEvent.click(screen.getByRole('button', { name: '一键导出当前会话' }))
    const command = (window.bridge.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
    useSettingsStore.getState().handleBridgeMessage({ type: 'ack', requestId: command.requestId, ok: true, data: { path: 'C:/exports/current.jsonl' } } as any)
    expect(await screen.findByRole('status')).toHaveTextContent('C:/exports/current.jsonl')
    expect(screen.getByRole('button', { name: '在文件夹中查看' })).toBeInTheDocument()
    await waitFor(() => expect(useSettingsStore.getState().lastExportedPath).toBe('C:/exports/current.jsonl'))
  })
})
