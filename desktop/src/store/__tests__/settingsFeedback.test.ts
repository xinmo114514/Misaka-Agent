import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../useSettingsStore'
import { useSessionStore } from '../useSessionStore'

function lastCommand() {
  const send = window.bridge.send as ReturnType<typeof vi.fn>
  return send.mock.calls.at(-1)?.[0] as Record<string, any>
}

function ack(command: Record<string, any>, result: { ok: boolean; data?: any; error?: string }) {
  useSettingsStore.getState().handleBridgeMessage({
    type: 'ack', requestId: command.requestId, ...result,
  } as any)
}

describe('settings operation feedback contracts', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    window.bridge = { send: vi.fn(), on: () => () => {} }
    window.app = { pickDirectory: vi.fn(), getVersion: vi.fn(), openPath: vi.fn(), openExternal: vi.fn(), showItemInFolder: vi.fn() } as any
    useSettingsStore.setState({
      productSettings: { research: { plan_approval: false, token_cap: 120 }, subagents: { coordinator_mode: false }, network: { max_concurrent_sisters: 2 }, unrelated: { keep: true } },
      configPaths: { cwd: 'C:/old', agentDir: 'C:/agent', authPath: 'C:/auth', sessionsDir: 'C:/sessions' } as any,
      lastExportedPath: 'C:/exports/previous.jsonl',
    })
    useSessionStore.setState({ currentWorkspace: 'C:/old', recentWorkspaces: [] } as any)
  })

  it('commits a research setting only after a successful bridge acknowledgement', async () => {
    const save = useSettingsStore.getState().saveProductSetting('research', 'plan_approval', true)
    const command = lastCommand()
    expect(useSettingsStore.getState().productSettings.research.plan_approval).toBe(false)
    ack(command, { ok: true })
    await expect(save).resolves.toBeUndefined()
    expect(useSettingsStore.getState().productSettings.research.plan_approval).toBe(true)
  })

  it('retains the last confirmed research value on a rejected save', async () => {
    const save = useSettingsStore.getState().saveProductSetting('research', 'plan_approval', true)
    ack(lastCommand(), { ok: false, error: 'disk full' })
    await expect(save).rejects.toThrow('disk full')
    expect(useSettingsStore.getState().productSettings.research.plan_approval).toBe(false)
  })

  it('stops reset after its first failed write and reloads the backend-confirmed settings', async () => {
    const reset = useSettingsStore.getState().resetResearchSettings()
    const first = lastCommand()
    expect(first.section).toBe('research')
    expect(first.key).toBe('plan_approval')
    ack(first, { ok: true })
    await vi.waitFor(() => expect(lastCommand().key).toBe('token_cap'))
    const second = lastCommand()
    expect(second.key).toBe('token_cap')
    ack(second, { ok: false, error: 'read-only settings file' })
    await vi.waitFor(() => expect(lastCommand().type).toBe('get_config'))
    const reload = lastCommand()
    expect(reload.type).toBe('get_config')
    ack(reload, { ok: true, data: { product: { research: { plan_approval: true, token_cap: 900 }, unrelated: { keep: true } } } })
    await expect(reset).rejects.toThrow('1/6')
    expect((window.bridge.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3)
    expect(useSettingsStore.getState().productSettings).toEqual({ research: { plan_approval: true, token_cap: 900 }, unrelated: { keep: true } })
  })

  it('reports reset complete only after all six acknowledgements and preserves unrelated settings', async () => {
    const entries = [
      ['research', 'plan_approval', true],
      ['research', 'token_cap', 0],
      ['subagents', 'coordinator_mode', true],
      ['subagents', 'verification_agent', true],
      ['subagents', 'auto_memory', true],
      ['network', 'max_concurrent_sisters', 4],
    ] as const
    const reset = useSettingsStore.getState().resetResearchSettings()
    for (const [section, key, value] of entries) {
      await vi.waitFor(() => expect(lastCommand()).toMatchObject({ section, key, value }))
      ack(lastCommand(), { ok: true })
    }
    await expect(reset).resolves.toBeUndefined()
    expect(useSettingsStore.getState().productSettings).toEqual({
      research: { plan_approval: true, token_cap: 0 },
      subagents: { coordinator_mode: true, verification_agent: true, auto_memory: true },
      network: { max_concurrent_sisters: 4 },
      unrelated: { keep: true },
    })
  })

  it('fails clearly when the bridge is unavailable and clears an unconfirmed export path', async () => {
    window.bridge = undefined as any
    await expect(useSettingsStore.getState().saveProductSetting('research', 'token_cap', 10)).rejects.toThrow(/桥接/)
    const result = await useSettingsStore.getState().exportCurrentSession('C:/session.jsonl')
    expect(result.ok).toBe(false)
    expect(useSettingsStore.getState().lastExportedPath).toBeNull()
  })

  it('uses the canonical directory acknowledged by the backend and syncs the workspace display', async () => {
    const switching = useSettingsStore.getState().setWorkspaceCwd('C:/chosen')
    const command = lastCommand()
    ack(command, { ok: true, data: { cwd: 'C:/resolved/chosen' } })
    await expect(switching).resolves.toBe('C:/resolved/chosen')
    expect(useSettingsStore.getState().configPaths?.cwd).toBe('C:/resolved/chosen')
    expect(useSessionStore.getState().currentWorkspace).toBe('C:/resolved/chosen')
  })

  it('returns null on picker cancel and rejects a failed directory switch', async () => {
    vi.mocked(window.app.pickDirectory).mockResolvedValueOnce(null).mockResolvedValueOnce('C:/invalid')
    await expect(useSettingsStore.getState().pickDirectory()).resolves.toBeNull()
    const switching = useSettingsStore.getState().pickDirectory()
    await vi.waitFor(() => expect(lastCommand().type).toBe('set_cwd'))
    ack(lastCommand(), { ok: false, error: 'invalid directory' })
    await expect(switching).rejects.toThrow('invalid directory')
    expect(useSettingsStore.getState().configPaths?.cwd).toBe('C:/old')
  })

  it('reports export acknowledgement path and never retains a previous path after failure', async () => {
    const exported = useSettingsStore.getState().exportCurrentSession('C:/session.jsonl')
    const command = lastCommand()
    expect(useSettingsStore.getState().lastExportedPath).toBeNull()
    ack(command, { ok: true, data: { path: 'C:/exports/session.jsonl' } })
    await expect(exported).resolves.toEqual({ ok: true, path: 'C:/exports/session.jsonl' })

    const failed = useSettingsStore.getState().exportCurrentSession('C:/session.jsonl')
    ack(lastCommand(), { ok: false, error: 'write failed' })
    await expect(failed).resolves.toMatchObject({ ok: false, error: 'write failed' })
    expect(useSettingsStore.getState().lastExportedPath).toBeNull()
  })

  it('cleans up and rejects when sending a setting synchronously throws', async () => {
    vi.mocked(window.bridge.send).mockImplementation(() => { throw new Error('pipe closed') })
    await expect(useSettingsStore.getState().saveProductSetting('research', 'token_cap', 50)).rejects.toThrow('pipe closed')
  })

  it('reports an unconfirmed timeout and ignores a late settings acknowledgement', async () => {
    vi.useFakeTimers()
    const save = useSettingsStore.getState().saveProductSetting('research', 'token_cap', 50)
    const command = lastCommand()
    const rejected = expect(save).rejects.toThrow('结果未确认')
    await vi.advanceTimersByTimeAsync(20_000)
    await rejected
    ack(command, { ok: true })
    expect(useSettingsStore.getState().productSettings.research.token_cap).toBe(120)
  })
})
