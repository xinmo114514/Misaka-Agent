import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NetworkSection } from './NetworkSection'
import { useSettingsStore } from '../../../store/useSettingsStore'
import type { ProxySettingsSnapshot } from '../../../types/settings'

const saved: ProxySettingsSnapshot = {
  settings: { enabled: false, whenDisabled: 'environment', protocol: 'http', host: '127.0.0.1', port: null },
  route: { mode: 'proxy', endpoint: 'https://api.example.test', proxy: 'http://env-proxy:8080' },
}

function lastCommand() {
  return (window.bridge.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as Record<string, any>
}

function ack(command: Record<string, any>, result: { ok: boolean; data?: any; error?: string }) {
  useSettingsStore.getState().handleBridgeMessage({ type: 'ack', requestId: command.requestId, ...result } as any)
}

async function renderRefreshed() {
  render(<NetworkSection />)
  await waitFor(() => expect(lastCommand().type).toBe('get_proxy_settings'))
  ack(lastCommand(), { ok: true, data: saved })
  await waitFor(() => expect(screen.getByRole('button', { name: '保存代理设置' })).toBeEnabled())
  vi.mocked(window.bridge.send).mockClear()
}

describe('NetworkSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.bridge = { send: vi.fn(), on: () => () => {} }
    useSettingsStore.setState({
      proxySettingsSnapshot: saved,
      proxySettingsStatus: 'ready',
      proxySettingsError: null,
      proxySavePending: false,
      proxyCheckPending: false,
      proxyConnectionCheck: null,
    } as any)
  })

  it('provides labeled controls for the switch, both off behaviors, protocols, host and editable port', async () => {
    await renderRefreshed()
    expect(screen.getByRole('switch', { name: '使用代理' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('combobox', { name: '关闭代理时' })).toHaveValue('environment')
    expect(screen.getByRole('combobox', { name: '代理协议' })).toHaveValue('http')
    expect(screen.getByRole('textbox', { name: '代理服务器' })).toHaveValue('127.0.0.1')
    expect(screen.getByRole('textbox', { name: '代理端口' })).toHaveValue('')
    expect(screen.getByText(/原生模型请求与原生 OAuth/)).toBeInTheDocument()
    expect(screen.getByText(/工具、系统代理及其他流量/)).toBeInTheDocument()
  })

  it('saves arbitrary ports and IPv6 as one object, disabling duplicate actions until ACK', async () => {
    await renderRefreshed()
    fireEvent.click(screen.getByRole('switch', { name: '使用代理' }))
    fireEvent.change(screen.getByRole('combobox', { name: '关闭代理时' }), { target: { value: 'direct' } })
    fireEvent.change(screen.getByRole('combobox', { name: '代理协议' }), { target: { value: 'socks5h' } })
    fireEvent.change(screen.getByRole('textbox', { name: '代理服务器' }), { target: { value: '2001:db8::7' } })
    fireEvent.change(screen.getByRole('textbox', { name: '代理端口' }), { target: { value: '49152' } })
    fireEvent.click(screen.getByRole('button', { name: '保存代理设置' }))

    expect(lastCommand()).toMatchObject({ type: 'set_proxy_settings', settings: {
      enabled: true, whenDisabled: 'direct', protocol: 'socks5h', host: '2001:db8::7', port: 49152,
    } })
    expect(screen.getByRole('button', { name: '保存代理设置' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '检查连接' })).toBeDisabled()

    const confirmed = { settings: lastCommand().settings, route: { mode: 'proxy', endpoint: 'https://api.example.test', proxy: 'socks5h://[2001:db8::7]:49152' } }
    ack(lastCommand(), { ok: true, data: confirmed })
    expect(await screen.findByRole('status')).toHaveTextContent('已保存')
    expect(screen.getByText(/socks5h:\/\/\[2001:db8::7\]:49152/)).toBeInTheDocument()
  })

  it.each(['0', '65536', '1.5', '1e3'])('rejects invalid integer port %s before sending', async (port) => {
    await renderRefreshed()
    fireEvent.click(screen.getByRole('switch', { name: '使用代理' }))
    fireEvent.change(screen.getByRole('textbox', { name: '代理端口' }), { target: { value: port } })
    fireEvent.click(screen.getByRole('button', { name: '保存代理设置' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/1.*65535|整数/)
    expect(window.bridge.send).not.toHaveBeenCalled()
  })

  it('retains the draft and confirmed saved route after a failed save ACK', async () => {
    await renderRefreshed()
    fireEvent.change(screen.getByRole('combobox', { name: '关闭代理时' }), { target: { value: 'direct' } })
    fireEvent.click(screen.getByRole('button', { name: '保存代理设置' }))
    ack(lastCommand(), { ok: false, error: 'disk full' })

    expect(await screen.findByRole('alert')).toHaveTextContent('disk full')
    expect(screen.getByRole('combobox', { name: '关闭代理时' })).toHaveValue('direct')
    expect(screen.getByText(/http:\/\/env-proxy:8080/)).toBeInTheDocument()
  })

  it('checks the valid draft without saving and labels TCP reachability accurately', async () => {
    await renderRefreshed()
    fireEvent.click(screen.getByRole('switch', { name: '使用代理' }))
    fireEvent.change(screen.getByRole('textbox', { name: '代理端口' }), { target: { value: '8123' } })
    fireEvent.click(screen.getByRole('button', { name: '检查连接' }))
    const command = lastCommand()
    expect(command).toMatchObject({ type: 'check_proxy_connection', settings: expect.objectContaining({ port: 8123 }) })
    expect((window.bridge.send as ReturnType<typeof vi.fn>).mock.calls.some(([value]) => value.type === 'set_proxy_settings')).toBe(false)

    ack(command, { ok: true, data: { route: { mode: 'proxy', endpoint: 'https://api.example.test', proxy: 'http://127.0.0.1:8123' }, reachable: true, check: 'tcp' } })
    expect(await screen.findByText(/TCP 端口可达/)).toBeInTheDocument()
    expect(screen.getByText(/不验证模型凭据、鉴权或模型服务可用性/)).toBeInTheDocument()
  })

  it('keeps controls disabled and performs only a read before saved settings load', async () => {
    useSettingsStore.setState({ proxySettingsSnapshot: null, proxySettingsStatus: 'idle' } as any)
    render(<NetworkSection />)
    expect(screen.getByRole('button', { name: '保存代理设置' })).toBeDisabled()
    await waitFor(() => expect(lastCommand().type).toBe('get_proxy_settings'))
    expect((window.bridge.send as ReturnType<typeof vi.fn>).mock.calls.some(([value]) => value.type === 'set_proxy_settings')).toBe(false)
  })

  it('refreshes the saved route on every section mount without writing', async () => {
    render(<NetworkSection />)
    await waitFor(() => expect(lastCommand().type).toBe('get_proxy_settings'))
    expect((window.bridge.send as ReturnType<typeof vi.fn>).mock.calls.some(([value]) => value.type === 'set_proxy_settings')).toBe(false)
    ack(lastCommand(), { ok: true, data: saved })
  })

  it('marks draft edits as unsaved and clears a TCP result tied to the previous draft', async () => {
    await renderRefreshed()
    act(() => useSettingsStore.setState({
      proxyConnectionCheck: {
        route: { mode: 'proxy', endpoint: 'https://api.example.test', proxy: 'http://127.0.0.1:8123' },
        reachable: true,
        check: 'tcp',
      },
    }))
    expect(screen.getByText('TCP 端口可达')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: '关闭代理时' }), { target: { value: 'direct' } })

    expect(screen.getByText('未保存的更改')).toBeInTheDocument()
    expect(screen.queryByText('TCP 端口可达')).not.toBeInTheDocument()
    expect(useSettingsStore.getState().proxyConnectionCheck).toBeNull()
  })

  it('hides stale routes during a refresh failure and permits a read-only retry', async () => {
    render(<NetworkSection />)
    await waitFor(() => expect(lastCommand().type).toBe('get_proxy_settings'))
    expect(screen.queryByText(/http:\/\/env-proxy:8080/)).not.toBeInTheDocument()
    expect(screen.getByText('正在读取…')).toBeInTheDocument()
    ack(lastCommand(), { ok: false, error: 'global configuration is invalid' })
    expect(await screen.findByRole('alert')).toHaveTextContent('global configuration is invalid')
    expect(screen.queryByText(/http:\/\/env-proxy:8080/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存代理设置' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '重新读取代理设置' }))
    expect(lastCommand().type).toBe('get_proxy_settings')
    const refreshed: ProxySettingsSnapshot = {
      settings: { ...saved.settings, whenDisabled: 'direct' },
      route: { mode: 'direct', endpoint: 'https://new-model.example.test' },
    }
    ack(lastCommand(), { ok: true, data: refreshed })
    expect(await screen.findByText('直连 · https://new-model.example.test')).toBeInTheDocument()
    expect((window.bridge.send as ReturnType<typeof vi.fn>).mock.calls.every(([value]) => value.type === 'get_proxy_settings')).toBe(true)
  })
})
