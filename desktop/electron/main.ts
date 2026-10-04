import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..', '..')
const themeDir = path.resolve(projectRoot, 'misaka/ui/tui/interactive/theme')

let mainWindow: BrowserWindow | null = null
let bridgeProcess: ChildProcessWithoutNullStreams | null = null

function resolveThemeJson(themeName = 'dark') {
  const themeFile = path.join(themeDir, `${themeName}.json`)
  if (!fs.existsSync(themeFile)) {
    return { name: themeName, colors: {}, desktop: {} }
  }
  try {
    const content = fs.readFileSync(themeFile, 'utf-8')
    const raw = JSON.parse(content)
    const vars: Record<string, string> = raw.vars || {}
    const colors: Record<string, string> = raw.colors || {}
    const resolvedColors: Record<string, string> = {}
    for (const [key, value] of Object.entries(colors)) {
      if (typeof value === 'string' && vars[value]) {
        resolvedColors[key] = vars[value]
      } else {
        resolvedColors[key] = String(value)
      }
    }
    return {
      name: raw.name || themeName,
      colors: resolvedColors,
      desktop: raw.desktop || {},
    }
  } catch (error) {
    console.error('Error resolving theme:', error)
    return { name: themeName, colors: {}, desktop: {} }
  }
}

function startBridgeProcess(win: BrowserWindow) {
  const isWin = process.platform === 'win32'
  const uvExecutable = isWin ? 'uv.exe' : 'uv'
  const bridgeArgs = ['run', 'misaka', 'desktop-bridge', '--no-session']

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

function watchThemeDir(win: BrowserWindow) {
  if (!fs.existsSync(themeDir)) return
  fs.watch(themeDir, (_eventType, filename) => {
    if (filename && filename.endsWith('.json')) {
      const themeData = resolveThemeJson('dark')
      if (!win.isDestroyed()) {
        win.webContents.send('theme:change', themeData)
      }
    }
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#18181e',
    title: 'Misaka Agent',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#18181e',
      symbolColor: '#ffffff',
      height: 38,
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: fs.existsSync(path.join(__dirname, 'preload.mjs'))
        ? path.join(__dirname, 'preload.mjs')
        : path.join(__dirname, 'preload.js'),
    },
  })

  startBridgeProcess(mainWindow)
  watchThemeDir(mainWindow)

  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const themeData = resolveThemeJson('dark')
      mainWindow.webContents.send('theme:change', themeData)
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.on('bridge:send', (_event, cmd: unknown) => {
    if (bridgeProcess && bridgeProcess.stdin.writable) {
      bridgeProcess.stdin.write(JSON.stringify(cmd) + '\n')
    }
  })

  ipcMain.handle('theme:get', () => resolveThemeJson('dark'))
  ipcMain.handle('app:get-version', () => app.getVersion())

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
