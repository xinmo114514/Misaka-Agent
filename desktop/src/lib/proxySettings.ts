import type { ProxyDisabledBehavior, ProxyProtocol, ProxySettings } from '../types/settings'

export interface ProxySettingsDraft {
  enabled: boolean
  whenDisabled: ProxyDisabledBehavior
  protocol: ProxyProtocol
  host: string
  port: string
}

export interface ProxyDraftErrors {
  host?: string
  port?: string
}

function isValidHost(host: string) {
  const hasControl = [...host].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
  if (!host || hasControl || /[\s\\@?#]/.test(host) || host.includes('/') || host.startsWith('[') || host.endsWith(']')) return false
  if (host.includes(':')) {
    try {
      // URL's bracketed host parser gives us browser-native IPv6 validation while the
      // editable value itself remains bracket-free, matching the backend contract.
      new URL(`http://[${host}]/`)
      return true
    } catch {
      return false
    }
  }
  try {
    // Wrapping with non-numeric labels prevents URL from interpreting an all-numeric
    // hostname as IPv4; the backend likewise permits valid DNS labels after IP parsing.
    const unqualified = host.replace(/\.$/, '')
    const normalized = new URL(`http://x.${unqualified}.test/`).hostname.split('.')
    const ascii = normalized.slice(1, -1).join('.')
    if (!ascii || ascii.length > 253) return false
    return ascii.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  } catch {
    return false
  }
}

export function validateProxyDraft(draft: ProxySettingsDraft): {
  settings: ProxySettings | null
  errors: ProxyDraftErrors
} {
  const errors: ProxyDraftErrors = {}
  const host = draft.host.trim()
  const portText = draft.port.trim()

  if (!isValidHost(host)) {
    errors.host = '请填写 IPv4、IPv6 或 DNS 主机名，不要包含 URL、方括号、路径或凭据。'
  }

  let port: number | null = null
  if (portText) {
    if (!/^\d+$/.test(portText)) errors.port = '代理端口必须是 1–65535 的整数。'
    else {
      const parsed = Number(portText)
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
        errors.port = '代理端口必须是 1–65535 的整数。'
      } else {
        port = parsed
      }
    }
  } else if (draft.enabled) {
    errors.port = '启用代理时需要填写 1–65535 的整数端口。'
  }

  if (Object.keys(errors).length) return { settings: null, errors }
  return {
    settings: {
      enabled: draft.enabled,
      whenDisabled: draft.whenDisabled,
      protocol: draft.protocol,
      host,
      port,
    },
    errors: {},
  }
}
