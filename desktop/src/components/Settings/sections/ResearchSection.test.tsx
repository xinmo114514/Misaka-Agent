import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ResearchSection } from './ResearchSection'
import { useSettingsStore } from '../../../store/useSettingsStore'

function latestCommand() {
  return (window.bridge.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as Record<string, any>
}

function ack(command: Record<string, any>, ok: boolean, error?: string) {
  useSettingsStore.getState().handleBridgeMessage({ type: 'ack', requestId: command.requestId, ok, error } as any)
}

describe('ResearchSection save feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.bridge = { send: vi.fn(), on: () => () => {} }
    useSettingsStore.setState({ productSettings: { research: { plan_approval: false, token_cap: 120 }, subagents: { coordinator_mode: true, verification_agent: true, auto_memory: true }, network: { max_concurrent_sisters: 4 } } })
  })

  it('keeps the previous toggle value while saving, then confirms only on ack', async () => {
    render(<ResearchSection />)
    const toggle = screen.getByRole('button', { name: '切换研究规划审批' })
    fireEvent.click(toggle)

    expect(screen.getByRole('status').textContent).toContain('保存中')
    expect(useSettingsStore.getState().productSettings.research.plan_approval).toBe(false)
    ack(latestCommand(), true)
    await waitFor(() => expect(useSettingsStore.getState().productSettings.research.plan_approval).toBe(true))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已保存'))
  })

  it('shows the bridge error and retains the confirmed toggle on save failure', async () => {
    render(<ResearchSection />)
    fireEvent.click(screen.getByRole('button', { name: '切换研究规划审批' }))
    ack(latestCommand(), false, 'settings file is read-only')
    expect(await screen.findByRole('alert')).toHaveTextContent('settings file is read-only')
    expect(useSettingsStore.getState().productSettings.research.plan_approval).toBe(false)
  })

  it('keeps a numeric edit as a draft until blur and then commits the acknowledged value', async () => {
    render(<ResearchSection />)
    const input = screen.getByRole('spinbutton')
    fireEvent.change(input, { target: { value: '900' } })
    fireEvent.blur(input)
    expect(latestCommand()).toMatchObject({ type: 'set_setting', key: 'token_cap', value: 900 })
    ack(latestCommand(), true)
    await waitFor(() => expect(useSettingsStore.getState().productSettings.research.token_cap).toBe(900))
  })
})
