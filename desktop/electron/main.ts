import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
const projectRoot = path.resolve(__dirname, '..', '..')
const themeDir = path.resolve(projectRoot, 'misaka/ui/tui/interactive/theme')

const LIGHT_WINDOW_BG = '#faf4f6'
const DARK_WINDOW_BG = '#18181e'

let mainWindow: BrowserWindow | null = null
let bridgeProcess: ChildProcessWithoutNullStreams | null = null
let currentThemeName = 'dark'

// The desktop client ships exactly two palettes, and index.css only has [data-theme] blocks for
// those two. Anything else is rejected rather than painted from fallbacks, so a bad name can
// never half-apply (dark status colors under a light palette) and then get persisted.
const BUILT_IN_THEME_NAMES = ['dark', 'light'] as const

function isBuiltInThemeName(name: unknown): name is 'dark' | 'light' {
  return typeof name === 'string' && (BUILT_IN_THEME_NAMES as readonly string[]).includes(name.trim())
}

function themeStatePath(): string {
  return path.join(app.getPath('userData'), 'desktop-theme.json')
}

function loadPersistedThemeName(): string {
  try {
    const raw = JSON.parse(fs.readFileSync(themeStatePath(), 'utf-8'))
    if (isBuiltInThemeName(raw?.name)) {
      return raw.name.trim()
    }
    if (raw?.name) {
      console.warn(`Ignoring unsupported persisted theme: ${raw.name}`)
    }
  } catch {
    // no persisted choice yet
  }
  return 'dark'
}

function persistThemeName(name: string): void {
  try {
    fs.mkdirSync(path.dirname(themeStatePath()), { recursive: true })
    fs.writeFileSync(themeStatePath(), JSON.stringify({ name }), 'utf-8')
  } catch (error) {
    console.error('Failed to persist theme name:', error)
  }
}

/** Resolve a theme JSON into concrete hex tokens for the renderer.
 *
 * Both the `colors` and `desktop` blocks may hold variable references (e.g. "accent"
 * pointing at vars.accent), so both are resolved here. What the renderer receives is
 * always final color values — it never needs to know about the vars layer.
 *
 * `null` means the name is not a built-in theme or its JSON could not be read: callers must
 * treat that as "keep the current theme", never as an empty palette. */
interface ResolvedTheme {
  name: string
  colors: Record<string, any>
  desktop: Record<string, any>
}

/** Outcome of a theme request: `name` is always the theme now in effect. */
interface ThemeSetResult {
  ok: boolean
  name: string
  error?: string
}

function resolveThemeJson(themeName: string = currentThemeName): ResolvedTheme | null {
  if (!isBuiltInThemeName(themeName)) return null
  const name = themeName.trim()
  const themeFile = path.join(themeDir, `${name}.json`)
  if (!fs.existsSync(themeFile)) {
    return null
  }
  try {
    const raw = JSON.parse(fs.readFileSync(themeFile, 'utf-8'))
    const vars: Record<string, unknown> = raw.vars || {}

    const resolveMap = (map: unknown): Record<string, any> => {
      const out: Record<string, any> = {}
      if (!map || typeof map !== 'object') return out
      for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
        if (typeof value === 'string' && typeof vars[value] === 'string') {
          out[key] = vars[value]
        } else {
          out[key] = value
        }
      }
      return out
    }

    const colors = resolveMap(raw.colors)
    const desktopRaw = resolveMap(raw.desktop)
    const chart = Array.isArray(desktopRaw.chart)
      ? desktopRaw.chart.map((c: unknown) =>
          typeof c === 'string' && typeof vars[c] === 'string' ? vars[c] : c,
        )
      : undefined

    return {
      // Canonical name, not raw.name: a mistyped "name" field inside a built-in JSON would
      // otherwise reach the renderer as a data-theme with no matching CSS block.
      name,
      colors,
      desktop: { ...desktopRaw, ...(chart ? { chart } : {}) },
    }
  } catch (error) {
    console.error(`Failed to resolve theme "${name}":`, error)
    return null
  }
}

function windowBackgroundFor(themeName: string): string {
  const theme = resolveThemeJson(themeName)
  const surface0 = theme?.desktop?.surface0
  if (typeof surface0 === 'string' && surface0.startsWith('#')) return surface0
  return themeName === 'light' ? LIGHT_WINDOW_BG : DARK_WINDOW_BG
}

function titlebarOverlayFor(themeName: string) {
  const isLight = themeName === 'light'
  return {
    color: windowBackgroundFor(themeName),
    symbolColor: isLight ? '#332028' : '#ffffff',
    height: 38,
  }
}

/** Make `themeName` the window's theme. Returns the applied theme, or null when the name is
 *  not supported — in that case the previous theme and the previous persisted choice are kept. */
function applyThemeToWindow(themeName: string): ResolvedTheme | null {
  const themeData = resolveThemeJson(themeName)
  if (!themeData) return null
  if (themeData.name !== currentThemeName) {
    currentThemeName = themeData.name
    persistThemeName(themeData.name)
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(windowBackgroundFor(themeData.name))
    try {
      mainWindow.setTitleBarOverlay(titlebarOverlayFor(themeData.name))
    } catch {
      // Linux / unsupported window chrome: the CSS variables still carry the theme
    }
    mainWindow.webContents.send('theme:change', themeData)
  }
  return themeData
}

function startBridgeProcess(win: BrowserWindow) {
  const isWin = process.platform === 'win32'
  const uvExecutable = isWin ? 'uv.exe' : 'uv'
  // Persist sessions by default so the sidebar can enumerate and reopen them; set
  // MISAKA_DESKTOP_EPHEMERAL=1 to fall back to an in-memory session.
  const bridgeArgs = ['run', 'misaka', 'desktop-bridge']
  if (process.env.MISAKA_DESKTOP_EPHEMERAL === '1') {
    bridgeArgs.push('--no-session')
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
  }
  delete env.ALL_PROXY
  delete env.all_proxy
  delete env.HTTP_PROXY
  delete env.http_proxy
  delete env.HTTPS_PROXY
  delete env.https_proxy

  bridgeProcess = spawn(uvExecutable, bridgeArgs, {
    cwd: projectRoot,
    env: env as NodeJS.ProcessEnv,
    shell: isWin,
  })

  let buffer = ''
  bridgeProcess.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8')
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (!win.isDestroyed()) {
          win.webContents.send('bridge:event', parsed)
        }
      } catch (e) {
        console.error('Failed to parse bridge JSON:', trimmed, e)
      }
    }
  })

  bridgeProcess.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk)
  })

  bridgeProcess.on('exit', (code) => {
    console.log(`Bridge process exited with code ${code}`)
    bridgeProcess = null
  })
}

function stopBridgeProcess() {
  if (bridgeProcess) {
    try {
      bridgeProcess.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n')
      setTimeout(() => {
        if (bridgeProcess) {
          bridgeProcess.kill()
          bridgeProcess = null
        }
      }, 1000)
    } catch {
      bridgeProcess.kill()
      bridgeProcess = null
    }
  }
}

function watchThemeDir() {
  if (!fs.existsSync(themeDir)) return
  fs.watch(themeDir, (_eventType, filename) => {
    // Only the active theme's own file can change what is on screen; Windows also fires this
    // twice per save, which applyThemeToDom's signature check absorbs.
    if (filename === `${currentThemeName}.json`) {
      applyThemeToWindow(currentThemeName)
    }
  })
}

function createWindow() {
  currentThemeName = loadPersistedThemeName()

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: windowBackgroundFor(currentThemeName),
    title: 'Misaka Agent',
    titleBarStyle: 'hidden',
    titleBarOverlay: titlebarOverlayFor(currentThemeName),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: ['preload.cjs', 'preload.mjs', 'preload.js']
        .map((name) => path.join(__dirname, name))
        .find((candidate) => fs.existsSync(candidate)),
    },
  })

  startBridgeProcess(mainWindow)
  watchThemeDir()

  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const theme = resolveThemeJson(currentThemeName)
      if (theme) mainWindow.webContents.send('theme:change', theme)
    }
  })

  // Carry the active theme into the load URL so index.html's inline stamp can pick the right
  // [data-theme] palette before the first paint; the theme:change push then fills in the rest.
  if (process.env.VITE_DEV_SERVER_URL) {
    const sep = process.env.VITE_DEV_SERVER_URL.includes('?') ? '&' : '?'
    mainWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}${sep}theme=${currentThemeName}`)
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: { theme: currentThemeName } })
  }
}

app.whenReady().then(() => {
  ipcMain.on('bridge:send', (_event, cmd: any) => {
    // Pure pipe to the Python bridge. The theme used to be applied from here as well, which
    // made one settings click repaint three times; theme:set is the only entry point now.
    if (bridgeProcess && bridgeProcess.stdin.writable) {
      bridgeProcess.stdin.write(JSON.stringify(cmd) + '\n')
    }
  })

  ipcMain.handle('theme:get', (_event, name?: string) => resolveThemeJson(name ?? currentThemeName))
  ipcMain.handle('theme:set', (_event, name: string): ThemeSetResult => {
    if (!isBuiltInThemeName(name)) {
      return { ok: false, name: currentThemeName, error: `不支持的主题：${String(name)}` }
    }
    // Re-applying the active theme is intentional: it re-pushes theme:change so native window
    // chrome recovers from drift. The renderer dedupes, so this repaints the DOM zero times.
    const applied = applyThemeToWindow(name)
    return applied
      ? { ok: true, name: applied.name }
      : { ok: false, name: currentThemeName, error: `主题文件缺失或无法解析：${name}` }
  })

  ipcMain.handle('app:get-version', () => app.getVersion())
  ipcMain.handle('app:open-path', async (_event, targetPath: string) => {
    if (!targetPath) return false
    try {
      const err = await shell.openPath(targetPath)
      return !err
    } catch {
      return false
    }
  })
  ipcMain.handle('app:show-item-in-folder', (_event, targetPath: string) => {
    if (!targetPath) return
    shell.showItemInFolder(targetPath)
  })
  ipcMain.handle('app:pick-directory', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  stopBridgeProcess()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopBridgeProcess()
})
