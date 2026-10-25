import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../useSettingsStore'
import type { ProxySettings, ProxySettingsSnapshot } from '../../types/settings'

const saved: ProxySettingsSnapshot = {
  settings: { enabled: false, whenDisabled: 'environment', protocol: 'http', host: '127.0.0.1', port: null },
  route: { mode: 'proxy', endpoint: 'https://api.example.test', proxy: 'http://env-proxy:8080' },
}

const custom: ProxySettings = {
  enabled: true,
  whenDisabled: 'direct',
  protocol: 'socks5h',
  host: '2001:db8::7',
  port: 49152,
}

function lastCommand() {
  return (window.bridge.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as Record<string, any>
}

function ack(command: Record<string, any>, result: { ok: boolean; data?: any; error?: string }) {
  useSettingsStore.getState().handleBridgeMessage({ type: 'ack', requestId: command.requestId, ...result } as any)
}

describe('proxy settings bridge state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.bridge = { send: vi.fn(), on: () => () => {} }
    useSettingsStore.setState({
      proxySettingsSnapshot: null,
      proxySettingsStatus: 'idle',
      proxySettingsError: null,
      proxySavePending: false,
      proxyCheckPending: false,
      proxyConnectionCheck: null,
    } as any)
  })

  it('loads persisted settings without issuing a write while settings are unknown', async () => {
    const loading = useSettingsStore.getState().loadProxySettings()
    const command = lastCommand()
    expect(command.type).toBe('get_proxy_settings')
    expect((window.bridge.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    expect(useSettingsStore.getState().proxySettingsSnapshot).toBeNull()

    ack(command, { ok: true, data: saved })
    await expect(loading).resolves.toEqual(saved)
    expect(useSettingsStore.getState().proxySettingsSnapshot).toEqual(saved)
  })

  it('does not write when saved settings have not loaded', async () => {
    await expect(useSettingsStore.getState().saveProxySettings(custom)).rejects.toThrow(/尚未载入/)
    expect(window.bridge.send).not.toHaveBeenCalled()
  })

  it('commits the whole proxy object only after a successful acknowledgement', async () => {
    useSettingsStore.setState({ proxySettingsSnapshot: saved, proxySettingsStatus: 'ready' } as any)
    const saving = useSettingsStore.getState().saveProxySettings(custom)
    const command = lastCommand()
    expect(command).toMatchObject({ type: 'set_proxy_settings', settings: custom })
    expect(useSettingsStore.getState().proxySettingsSnapshot).toEqual(saved)

    const confirmed = { settings: custom, route: { mode: 'proxy', endpoint: 'https://api.example.test', proxy: 'socks5h://[2001:db8::7]:49152' } } as const
    ack(command, { ok: true, data: confirmed })
    await expect(saving).resolves.toEqual(confirmed)
    expect(useSettingsStore.getState().proxySettingsSnapshot).toEqual(confirmed)
  })

  it('keeps the last confirmed settings when save acknowledgement fails', async () => {
    useSettingsStore.setState({ proxySettingsSnapshot: saved, proxySettingsStatus: 'ready' } as any)
    const saving = useSettingsStore.getState().saveProxySettings(custom)
    ack(lastCommand(), { ok: false, error: 'settings file is read-only' })
    await expect(saving).rejects.toThrow('read-only')
    expect(useSettingsStore.getState().proxySettingsSnapshot).toEqual(saved)
    expect(useSettingsStore.getState().proxySettingsError).toContain('read-only')
  })

  it('checks the unsaved draft without persisting it', async () => {
    useSettingsStore.setState({ proxySettingsSnapshot: saved, proxySettingsStatus: 'ready' } as any)
    const checking = useSettingsStore.getState().checkProxyConnection(custom)
    const command = lastCommand()
    expect(command).toMatchObject({ type: 'check_proxy_connection', settings: custom })
    const result = { route: { mode: 'proxy', endpoint: 'https://api.example.test', proxy: 'socks5h://[2001:db8::7]:49152' }, reachable: true, check: 'tcp' as const }
    ack(command, { ok: true, data: result })
    await expect(checking).resolves.toEqual(result)
    expect(useSettingsStore.getState().proxyConnectionCheck).toEqual(result)
    expect(useSettingsStore.getState().proxySettingsSnapshot).toEqual(saved)
    expect((window.bridge.send as ReturnType<typeof vi.fn>).mock.calls.some(([value]) => value.type === 'set_proxy_settings')).toBe(false)
  })
})
