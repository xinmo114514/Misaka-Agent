import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AboutSection } from './AboutSection'
import { useSettingsStore } from '../../../store/useSettingsStore'

describe('AboutSection diagnostic copy feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.bridge = { send: vi.fn(), on: () => () => {} }
    window.app = { pickDirectory: vi.fn(), getVersion: vi.fn().mockResolvedValue('0.18.5'), openPath: vi.fn(), openExternal: vi.fn(), showItemInFolder: vi.fn() } as any
    useSettingsStore.setState({
      diagnostics: { ok: true, bridge: 'connected' } as any,
      runDiagnostics: vi.fn().mockResolvedValue(null),
    })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('permission denied')) } })
  })

  it('shows a copy error and does not mark diagnostics copied when clipboard write fails', async () => {
    render(<AboutSection />)
    fireEvent.click(screen.getByRole('button', { name: '复制诊断' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('permission denied')
    expect(screen.queryByText('已复制')).not.toBeInTheDocument()
  })
})
