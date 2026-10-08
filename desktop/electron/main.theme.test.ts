import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  stateDirectory: '',
  handlers: new Map<string, (...args: any[]) => any>(),
  ipcEvents: new Map<string, (...args: any[]) => any>(),
  windows: [] as any[],
  routesAtCreation: [] as string[],
  dialogResult: { canceled: false, filePaths: [] as string[] },
  dialogCalls: [] as Array<{ window: unknown; options: Record<string, any> }>,
  setPath: vi.fn(),
  messageBoxCalls: [] as Array<{ window: unknown; options: Record<string, any> }>,
  messageBoxResponse: 2,
  trayMenus: [] as Array<any>,
  openPath: vi.fn(async (_targetPath: string) => ''),
  showItemInFolder: vi.fn((_targetPath: string) => undefined),
}))
vi.mock('electron', () => ({
  app: { whenReady: () => Promise.resolve(), getPath: () => fixture.stateDirectory, setPath: (...args: any[]) => fixture.setPath(...args), on: vi.fn(), getVersion: () => 'test', quit: vi.fn() },
  ipcMain: {
    on: (name: string, callback: (...args: any[]) => any) => fixture.ipcEvents.set(name, callback),
    handle: (name: string, callback: (...args: any[]) => any) => fixture.handlers.set(name, callback),
  },
  Tray: class { setToolTip() {} setContextMenu(menu: any) { fixture.trayMenus.push(menu) } on() {} },
  Menu: { buildFromTemplate: vi.fn((template: any[]) => template) },
  nativeImage: { createFromPath: vi.fn(() => ({})) },
  BrowserWindow: class {
    static getAllWindows() { return fixture.windows }
    options: any
    url?: string
    file?: { path: string; query: Record<string, string> }
    pushes: any[] = []
    backgrounds: string[] = []
    overlays: any[] = []
    events = new Map<string, (...args: any[]) => void>()
    webContents = {
      on: (name: string, callback: (...args: any[]) => void) => this.events.set(name, callback),
      setWindowOpenHandler: vi.fn(),
      send: (channel: string, data: any) => this.pushes.push({ channel, data }),
    }
    constructor(options: any) { this.options = options; fixture.windows.push(this); fixture.routesAtCreation = [...fixture.handlers.keys()] }
    on(name: string, callback: (...args: any[]) => void) { this.events.set(name, callback) }
    loadURL(url: string) { this.url = url }
    loadFile(file: string, options: any) { this.file = { path: file, query: options.query } }
    isDestroyed() { return false }
    setBackgroundColor(value: string) { this.backgrounds.push(value) }
    setTitleBarOverlay(value: any) { this.overlays.push(value) }
    hide = vi.fn()
    show = vi.fn()
    focus = vi.fn()
    close = vi.fn()
  },
  dialog: {
    showOpenDialog: async (window: unknown, options: Record<string, any>) => {
      fixture.dialogCalls.push({ window, options })
      return fixture.dialogResult
    },
    showMessageBox: async (window: unknown, options: Record<string, any>) => {
      fixture.messageBoxCalls.push({ window, options })
      return { response: fixture.messageBoxResponse }
    },
  }, shell: {
    openPath: (targetPath: string) => fixture.openPath(targetPath),
    showItemInFolder: (targetPath: string) => fixture.showItemInFolder(targetPath),
  },
}))
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const spawn = () => ({ stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn(), stdin: { writable: true, write: vi.fn() } })
  return { ...original, spawn, default: { ...original, spawn } }
})

beforeEach(() => {
  vi.resetModules()
  fixture.stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'misaka-theme-main-'))
  fixture.handlers.clear()
  fixture.ipcEvents.clear()
  fixture.windows = []
  fixture.routesAtCreation = []
  fixture.dialogResult = { canceled: false, filePaths: [] }
  fixture.dialogCalls = []
  fixture.setPath.mockReset()
  fixture.messageBoxCalls = []
  fixture.trayMenus = []
  fixture.messageBoxResponse = 2
  fixture.openPath.mockReset().mockResolvedValue('')
  fixture.showItemInFolder.mockReset()
  vi.stubEnv('VITE_DEV_SERVER_URL', '')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(fixture.stateDirectory, { recursive: true, force: true })
})

async function launch() {
  await import('./main')
  await vi.dynamicImportSettled()
  return fixture.windows[0]
}

it.each([
  { type: 'set_permission_mode', mode: 'bypassPermissions' },
  { type: 'set_model', provider: 'fixture', modelId: 'fixture-model' },
  { type: 'set_thinking', level: 'high' },
  { type: 'send_research_message', sessionId: 'owner', text: '补充研究要求' },
  { type: 'desktop_set_team_model', sessionId: 'owner', provider: 'fixture', modelId: 'b' },
  { type: 'desktop_retain_roles', sessionId: 'owner', selections: [] },
])('forwards research host configuration through the real IPC route: $type', async command => {
  const win = await launch()
  fixture.ipcEvents.get('research:send')!({}, { ...command, requestId: 'configure-research' })
  // No child is launched here. A transport error ack proves the command reached
  // sendResearchCommand instead of being silently discarded by the allowlist.
  expect(win.pushes).toContainEqual({ channel: 'research:event', data: expect.objectContaining({
    type: 'ack', requestId: 'configure-research', ok: false,
  }) })
}, 15000)

it('registers the registry IPC routes before the first window and sends the same active data after load', async () => {
  const win = await launch()
  expect(fixture.routesAtCreation).toEqual(expect.arrayContaining(['theme:get', 'theme:set', 'theme:list']))
  const summaries = fixture.handlers.get('theme:list')!({})
  expect(summaries).toEqual(expect.arrayContaining([{ id: 'dark', label: expect.any(String), mode: 'dark' }, { id: 'light', label: expect.any(String), mode: 'light' }]))
  const active = fixture.handlers.get('theme:get')!({})
  expect(win.file.query.theme).toBe('dark')
  expect(JSON.parse(win.file.query.themePalette)).toMatchObject({ name: 'dark', mode: 'dark', vars: { '--surface-0': '#18181e' } })
  win.events.get('did-finish-load')!()
  expect(win.pushes).toEqual([{ channel: 'theme:change', data: active }])
})

it('opens a filtered native multi-file picker and returns selected paths or an empty cancellation result', async () => {
  const win = await launch()
  const pickFiles = fixture.handlers.get('app:pick-files')!
  fixture.dialogResult = { canceled: false, filePaths: ['C:/fixture/chart.png', 'C:/fixture/readme.md'] }
  await expect(pickFiles({})).resolves.toEqual(fixture.dialogResult.filePaths)
  expect(fixture.dialogCalls[0].window).toBe(win)
  expect(fixture.dialogCalls[0].options.properties).toEqual(['openFile', 'multiSelections'])
  expect(fixture.dialogCalls[0].options.filters[0].extensions).toContain('png')
  expect(fixture.dialogCalls[0].options.filters[0].extensions).toContain('md')
  fixture.dialogResult = { canceled: true, filePaths: [] }
  await expect(pickFiles({})).resolves.toEqual([])
})

it('uses the isolated user-data path override before loading persisted desktop preferences', async () => {
  const isolatedPath = path.join(fixture.stateDirectory, 'electron-user-data')
  fs.mkdirSync(isolatedPath)
  vi.stubEnv('MISAKA_E2E_USER_DATA', isolatedPath)
  await launch()
  expect(fixture.setPath).toHaveBeenCalledWith('userData', isolatedPath)
})

it('builds development URLs with encoded complete palettes while preserving existing query/hash', async () => {
  vi.stubEnv('VITE_DEV_SERVER_URL', 'http://localhost:5173/?fixture=yes#section')
  const win = await launch()
  const url = new URL(win.url)
  expect(url.searchParams.get('fixture')).toBe('yes')
  expect(url.hash).toBe('#section')
  expect(JSON.parse(url.searchParams.get('themePalette')!)).toMatchObject({ name: 'dark', mode: 'dark', vars: { '--window-symbol': '#ffffff' } })
})

it('failed persistence and unknown IDs leave native chrome, active data and theme-change pushes untouched', async () => {
  const win = await launch()
  const set = fixture.handlers.get('theme:set')!
  expect(set({}, 'missing')).toMatchObject({ ok: false, name: 'dark' })
  vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk full') })
  expect(set({}, 'light')).toEqual({ ok: false, name: 'dark', error: 'disk full' })
  expect(fixture.handlers.get('theme:get')!({}).name).toBe('dark')
  expect(win.backgrounds).toEqual([])
  expect(win.overlays).toEqual([])
  expect(win.pushes).toEqual([])
})

it('successful IPC changes persist the ID, apply chrome, and push the complete palette', async () => {
  const win = await launch()
  expect(fixture.handlers.get('theme:set')!({}, 'light')).toEqual({ ok: true, name: 'light' })
  expect(JSON.parse(fs.readFileSync(path.join(fixture.stateDirectory, 'desktop-theme.json'), 'utf8'))).toEqual({ name: 'light' })
  expect(win.backgrounds).toEqual(['#ffffff'])
  expect(win.overlays).toEqual([{ color: '#ffffff', symbolColor: '#332028', height: 38 }])
  expect(win.pushes[0]).toMatchObject({ channel: 'theme:change', data: { name: 'light', mode: 'light', colors: { 'window-symbol': '#332028' } } })
})

it.each(['light', 'codex-light', 'claude-light', 'forest-light'])(
  'launches persisted %s with white native chrome and a matching first-paint palette',
  async (name) => {
    fs.writeFileSync(path.join(fixture.stateDirectory, 'desktop-theme.json'), JSON.stringify({ name }))
    const win = await launch()
    expect(win.options.backgroundColor).toBe('#ffffff')
    expect(win.options.titleBarOverlay.color).toBe('#ffffff')
    expect(JSON.parse(win.file.query.themePalette)).toMatchObject({
      name, mode: 'light', vars: {
        '--surface-0': '#ffffff', '--surface-1': '#ffffff',
        '--graph-background': '#ffffff', '--window-background': '#ffffff',
      },
    })
  },
)

it('returns a structured success only after an existing path is accepted by the system opener', async () => {
  await launch()
  const openPath = fixture.handlers.get('app:open-path')!

  await expect(openPath({}, fixture.stateDirectory)).resolves.toEqual({ ok: true })
  expect(fixture.openPath).toHaveBeenCalledWith(fixture.stateDirectory)
})

it('returns the system opener error and rejects missing targets with structured results', async () => {
  await launch()
  const openPath = fixture.handlers.get('app:open-path')!
  fixture.openPath.mockResolvedValueOnce('permission denied')

  await expect(openPath({}, fixture.stateDirectory)).resolves.toEqual({ ok: false, error: 'permission denied' })
  await expect(openPath({}, path.join(fixture.stateDirectory, 'missing'))).resolves.toMatchObject({ ok: false, error: expect.any(String) })
  expect(fixture.openPath).toHaveBeenCalledTimes(1)
})

it('turns synchronous open and reveal exceptions into structured errors', async () => {
  await launch()
  const openPath = fixture.handlers.get('app:open-path')!
  const showItemInFolder = fixture.handlers.get('app:show-item-in-folder')!
  fixture.openPath.mockRejectedValueOnce(new Error('system opener crashed'))
  fixture.showItemInFolder.mockImplementationOnce(() => { throw new Error('reveal failed') })

  await expect(openPath({}, fixture.stateDirectory)).resolves.toEqual({ ok: false, error: 'system opener crashed' })
  expect(showItemInFolder({}, fixture.stateDirectory)).toEqual({ ok: false, error: 'reveal failed' })
})

it('reports reveal success when the system accepted an existing target', async () => {
  await launch()
  const showItemInFolder = fixture.handlers.get('app:show-item-in-folder')!

  expect(showItemInFolder({}, fixture.stateDirectory)).toEqual({ ok: true })
  expect(fixture.showItemInFolder).toHaveBeenCalledWith(fixture.stateDirectory)
  expect(showItemInFolder({}, path.join(fixture.stateDirectory, 'missing'))).toMatchObject({ ok: false, error: expect.any(String) })
})

it('hands close confirmation to the current renderer without stopping active research', async () => {
  const win = await launch()
  fixture.ipcEvents.get('app:research-state')!({}, true)
  let prevented = false

  win.events.get('close')!({ preventDefault: () => { prevented = true } })
  await vi.waitFor(() => expect(win.pushes).toContainEqual({ channel: 'app:request-close', data: undefined }))

  expect(prevented).toBe(true)
  expect(fixture.messageBoxCalls).toHaveLength(0)
  expect(win.hide).not.toHaveBeenCalled()
})

it('hides the window in the tray when the user keeps a research run running', async () => {
  const win = await launch()
  fixture.messageBoxResponse = 1
  fixture.ipcEvents.get('app:research-state')!({}, true)
  win.events.get('close')!({ preventDefault: vi.fn() })

  await fixture.handlers.get('app:confirm-close')!({}, 'tray')

  await vi.waitFor(() => expect(win.hide).toHaveBeenCalledOnce())
  expect(win.close).not.toHaveBeenCalled()
})

it('shows the outstanding review count in the system tray while the window stays hidden', async () => {
  const win = await launch()
  fixture.messageBoxResponse = 1
  fixture.ipcEvents.get('app:research-state')!({}, { active: true, pendingCount: 3 })
  win.events.get('close')!({ preventDefault: vi.fn() })

  await fixture.handlers.get('app:confirm-close')!({}, 'tray')

  await vi.waitFor(() => expect(win.hide).toHaveBeenCalledOnce())
  expect(fixture.trayMenus.flat().some(item => typeof item.label === 'string' && item.label.includes('3'))).toBe(true)
})
