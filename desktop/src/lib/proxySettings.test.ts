import { describe, expect, it } from 'vitest'
import { validateProxyDraft } from './proxySettings'

describe('proxy settings draft validation', () => {
  const base = {
    enabled: true,
    whenDisabled: 'environment' as const,
    protocol: 'http' as const,
    host: '127.0.0.1',
    port: '49152',
  }

  it.each([
    ['1', 1],
    ['49152', 49152],
    ['65535', 65535],
  ])('accepts integer port %s in the inclusive TCP range', (port, expected) => {
    expect(validateProxyDraft({ ...base, port })).toEqual({
      settings: { ...base, port: expected },
      errors: {},
    })
  })

  it.each(['0', '65536', '-1', '1.5', '1e3', ''])('rejects enabled custom proxy port %s', (port) => {
    const result = validateProxyDraft({ ...base, port })
    expect(result.settings).toBeNull()
    expect(result.errors.port).toBeTruthy()
  })

  it('accepts IPv6 hosts without treating colons as a URL or port separator', () => {
    expect(validateProxyDraft({ ...base, protocol: 'socks5h', host: '2001:db8::7' }).settings).toEqual({
      enabled: true,
      whenDisabled: 'environment',
      protocol: 'socks5h',
      host: '2001:db8::7',
      port: 49152,
    })
  })

  it('allows an unset port while custom proxying is disabled', () => {
    expect(validateProxyDraft({ ...base, enabled: false, whenDisabled: 'direct', port: '' }).settings).toEqual({
      enabled: false,
      whenDisabled: 'direct',
      protocol: 'http',
      host: '127.0.0.1',
      port: null,
    })
  })

  it.each(['', 'proxy host', '[::1]', 'proxy.local/path'])('rejects invalid host %j even while custom proxying is disabled', (host) => {
    const result = validateProxyDraft({ ...base, enabled: false, host, port: '' })
    expect(result.settings).toBeNull()
    expect(result.errors.host).toBeTruthy()
  })
})
