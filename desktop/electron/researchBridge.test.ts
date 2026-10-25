import { describe, expect, it } from 'vitest'
import { bridgeEnvironment, researchBridgeArgs, resolvedResearchBridgeLaunch, sameResearchBridge } from './researchBridge'

it('keeps direct or arbitrary explicit proxy settings unchanged for both bridge launches', () => {
  const configured = { HTTP_PROXY: 'http://proxy.internal:31827', https_proxy: 'http://[::1]:42019',
    ALL_PROXY: 'socks5://127.0.0.1:51983', NO_PROXY: 'localhost,service.internal', PATH: 'fixture' }
  expect(bridgeEnvironment(configured)).toEqual({ ...configured, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' })
  expect(bridgeEnvironment({ PATH: 'fixture' })).toEqual({ PATH: 'fixture', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' })
  expect(configured).not.toHaveProperty('PYTHONUNBUFFERED')
})

describe('independent research host arguments', () => {
  it('opens Last Order in the requested project and resumes its saved research session', () => {
    expect(researchBridgeArgs({ cwd: 'C:\\project', sessionFile: 'C:\\sessions\\root.jsonl' })).toEqual([
      'run', 'misaka', 'desktop-bridge', '--cwd', 'C:\\project', '--research-context',
      '--session', 'C:\\sessions\\root.jsonl',
    ])
  })

  it('creates a fresh independent session when there is no saved owner yet', () => {
    expect(researchBridgeArgs({ cwd: 'C:\\project' })).toEqual([
      'run', 'misaka', 'desktop-bridge', '--cwd', 'C:\\project', '--research-context',
    ])
  })

  it('reuses the new research root session path for subsequent controls', () => {
    const initial = { cwd: 'C:\\project' }
    const resolved = resolvedResearchBridgeLaunch(initial, 'C:\\sessions\\root.jsonl')
    expect(sameResearchBridge(resolved, { cwd: 'C:\\project', sessionFile: 'C:\\sessions\\root.jsonl' })).toBe(true)
  })
})
