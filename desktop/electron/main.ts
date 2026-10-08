import { app, BrowserWindow, dialog, ipcMain, shell, Tray, Menu, nativeImage } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { validatedExternalHttpUrl } from './externalUrl'
import { themeRegistry } from '../src/theme/registry'
import { createThemeRuntime, themeStartupQuery, windowThemeOptions } from './themeRuntime'
import { researchBridgeArgs, researchCloseOutcome, resolvedResearchBridgeLaunch, sameResearchBridge, type ResearchBridgeLaunch } from './researchBridge'
const projectRoot = path.resolve(__dirname, '..', '..')
let mainWindow: BrowserWindow | null = null
let bridgeProcess: ChildProcessWithoutNullStreams | null = null
let researchBridgeProcess: ChildProcessWithoutNullStreams | null = null
let researchBridgeLaunch: ResearchBridgeLaunch | null = null
let researchHostIdentity: { sessionId: string; streamId?: string } | null = null
let researchActive = false
let researchPendingCount = 0
let researchTray: Tray | null = null
let closeChoiceOpen = false
let allowClose = false
let allowQuit = false
const researchWaiters = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
const recentResearchMessages: unknown[] = []
let themeRuntime: ReturnType<typeof createThemeRuntime>

function dispatchResearchMessage(message: any): void {
  if (message?.type === 'ack' && typeof message.requestId === 'string') {
    const waiter = researchWaiters.get(message.requestId)
    if (waiter) {
      researchWaiters.delete(message.requestId)
      clearTimeout(waiter.timer)
      if (message.ok === false) waiter.reject(new Error(message.error || '研究桥接请求失败'))
      else waiter.resolve(message.data ?? message)
    }
  }
  recentResearchMessages.push(message)
  if (recentResearchMessages.length > 300) recentResearchMessages.splice(0, recentResearchMessages.length - 300)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('research:event', message)
}

function sendResearchCommand(command: Record<string, unknown>): void {
  if (!researchBridgeProcess?.stdin.writable) throw new Error('研究桥接进程尚未就绪')
  researchBridgeProcess.stdin.write(JSON.stringify(command) + '\n')
}

function requestResearchCommand<T = any>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 20000): Promise<T> {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : `req_research_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  return new Promise<T>((resolve, reject) => {
    if (!researchBridgeProcess?.stdin.writable) {
      reject(new Error('研究桥接进程尚未就绪'))
      return
    }
    const timer = setTimeout(() => {
      researchWaiters.delete(requestId)
      reject(new Error(`${type} 没有回应`))
    }, timeoutMs)
    researchWaiters.set(requestId, { resolve, reject, timer })
    try {
      sendResearchCommand({ ...payload, type, requestId })
    } catch (error) {
      clearTimeout(timer)
      researchWaiters.delete(requestId)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

async function startResearchBridge(input: ResearchBridgeLaunch): Promise<any> {
  if (researchBridgeProcess) {
    const sameHost = sameResearchBridge(researchBridgeLaunch, input)
    if (sameHost) return requestResearchCommand('get_research_host')
    if (researchActive) throw new Error('已有研究运行时正在另一项目工作；先完成或停止当前研究。')
    if (!(await stopResearchBridgeForQuit())) throw new Error('切换研究项目已取消。')
  }

  const isWin = process.platform === 'win32'
  const child = spawn(isWin ? 'uv.exe' : 'uv', researchBridgeArgs(input), {
    cwd: projectRoot,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    shell: isWin,
    windowsHide: true,
  })
  researchBridgeProcess = child
  researchBridgeLaunch = input
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8')
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try { dispatchResearchMessage(JSON.parse(trimmed)) }
      catch (error) { console.error('Failed to parse research bridge JSON:', trimmed, error) }
    }
  })
  child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
  child.on('exit', (code) => {
    if (researchBridgeProcess === child) {
      if (researchHostIdentity) dispatchResearchMessage({ seq: 0, ...researchHostIdentity,
        event: { type: 'research_connection_error', error: `研究连接已断开 (${code})，再次发送将恢复原会话。` } })
      researchBridgeProcess = null
      researchBridgeLaunch = null
      researchHostIdentity = null
    }
    for (const [id, waiter] of researchWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(`研究桥接进程已退出 (${code})`))
      researchWaiters.delete(id)
    }
  })

  const host = await requestResearchCommand('get_research_host', {}, 30000)
  if (!host?.enabled || !host?.session?.file) {
    child.kill()
    throw new Error('独立研究会话未能启动。')
  }
  researchBridgeLaunch = resolvedResearchBridgeLaunch(input, host.session.file)
  researchHostIdentity = { sessionId: host.session.sessionId, streamId: host.streamId }
  return host
}

function syncResearchTray(): void {
  if (!researchTray) return
  researchTray.setToolTip(researchActive
    ? `Misaka Agent — 研究进行中，${researchPendingCount} 项待处理`
    : 'Misaka Agent')
  researchTray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Misaka Agent', click: () => { mainWindow?.show(); mainWindow?.focus() } },
    { label: researchActive ? `研究进行中 · ${researchPendingCount} 项待处理` : '研究已空闲', enabled: false },
    { type: 'separator' },
    { label: '退出 Misaka Agent', click: () => { void quitApplication() } },
  ]))
}

function ensureResearchTray(): void {
  if (researchTray) return
  const icon = nativeImage.createFromPath(path.join(projectRoot, 'assets', 'logo.svg'))
  researchTray = new Tray(icon)
  syncResearchTray()
  researchTray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus() })
}

function pushActiveThemeToWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const options = windowThemeOptions(themeRuntime.currentTheme())
    mainWindow.setBackgroundColor(options.backgroundColor)
    try {
      mainWindow.setTitleBarOverlay(options.titleBarOverlay)
    } catch {
      // Linux / unsupported window chrome: the CSS variables still carry the theme.
    }
    mainWindow.webContents.send('theme:change', themeRuntime.current())
  }
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
        if (parsed?.type === 'ack' && parsed?.requestId === 'electron-active-research' && parsed?.ok) {
          researchActive = Boolean(parsed?.data?.runs?.length)
          if (researchTray) researchTray.setToolTip(researchActive ? 'Misaka Agent — 研究进行中' : 'Misaka Agent')
        }
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
  bridgeProcess.stdin.write(JSON.stringify({ type: 'get_active_research_runs', requestId: 'electron-active-research' }) + '\n')
}

async function openExternalHttpUrl(value: unknown): Promise<boolean> {
  const targetUrl = validatedExternalHttpUrl(value)
  if (!targetUrl) return false
  try {
    await shell.openExternal(targetUrl)
    return true
  } catch {
    return false
  }
}

function pathActionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'System path operation failed')
}

function existingTargetPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const targetPath = path.resolve(value.trim())
  return fs.existsSync(targetPath) ? targetPath : null
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    let settled = false
    const finish = (exited: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
}

async function terminateResearchProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.platform !== 'win32' || child.pid === undefined) {
    child.kill('SIGKILL')
    return
  }
  await new Promise<void>(resolve => {
    const terminator = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    terminator.once('error', resolve)
    terminator.once('exit', () => resolve())
  })
  child.kill()
}

async function stopResearchBridgeForQuit(): Promise<boolean> {
  const child = researchBridgeProcess
  if (!child) return true
  try {
    if (child.stdin.writable) {
      child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n')
      // Python's stdio reader may already be waiting for the next line in its
      // executor. EOF releases that reader so an idle host can actually exit.
      child.stdin.end()
    }
  } catch { /* the exit event below is the authoritative signal */ }
  while (true) {
    if (await waitForChildExit(child, 30000)) return true
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: '研究仍在停止',
      message: '研究运行时已等待 30 秒仍未退出。',
      detail: '可继续等待、确认退出应用，或取消关闭并保留当前窗口。',
      buttons: ['继续等待', '仍然退出', '取消'],
      cancelId: 2,
      defaultId: 0,
      noLink: true,
    })
    if (result.response === 0) continue
    if (result.response === 2) return false
    await terminateResearchProcessTree(child)
    await waitForChildExit(child, 3000)
    return true
  }
}

async function requestWindowClose(win: BrowserWindow | null): Promise<void> {
  if (closeChoiceOpen) return
  closeChoiceOpen = true
  try {
    if (researchActive) {
      const options = {
        type: 'question' as const,
        title: '研究仍在运行',
        message: '如何处理当前研究？',
        detail: '后台继续会把 Misaka Agent 留在系统托盘。',
        buttons: ['停止研究并退出', '后台继续', '取消'],
        cancelId: 2,
        defaultId: 1,
        noLink: true,
      }
      const result = win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options)
      const outcome = researchCloseOutcome(
        result.response === 0 ? 'stop' : result.response === 1 ? 'background' : 'cancel',
      )
      if (outcome === 'stay-open') return
      if (outcome === 'hide') {
        ensureResearchTray()
        win?.hide()
        return
      }
    }

    if (!(await stopResearchBridgeForQuit())) return
    researchActive = false
    allowClose = true
    if (win && !win.isDestroyed()) win.close()
    else {
      allowQuit = true
      app.quit()
    }
  } finally {
    closeChoiceOpen = false
  }
}

/** Renderer confirmation and tray exit share the existing child shutdown path. */
async function quitApplication(): Promise<void> {
  if (closeChoiceOpen) return
  closeChoiceOpen = true
  try {
    if (!(await stopResearchBridgeForQuit())) return
    researchActive = false
    allowClose = true
    allowQuit = true
    stopBridgeProcess()
    app.quit()
  } finally { closeChoiceOpen = false }
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    ...windowThemeOptions(themeRuntime.currentTheme()),
    title: 'Misaka Agent',
    titleBarStyle: 'hidden',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: ['preload.cjs', 'preload.mjs', 'preload.js']
        .map((name) => path.join(__dirname, name))
        .find((candidate) => fs.existsSync(candidate)),
    },
  })

  mainWindow.on('close', event => {
    if (allowClose) return
    event.preventDefault()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
      mainWindow.webContents.send('app:request-close')
    }
  })

  // Never let content replace the managed application document or create an unmanaged window.
  // Web links are handed to the OS only after the same protocol validation as the IPC endpoint.
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    event.preventDefault()
    void openExternalHttpUrl(targetUrl)
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalHttpUrl(url)
    return { action: 'deny' }
  })

  startBridgeProcess(mainWindow)

  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('theme:change', themeRuntime.current())
      for (const message of recentResearchMessages) mainWindow.webContents.send('research:event', message)
    }
  })

  // Carry every concrete color into the load URL; the synchronous head script paints the
  // complete palette before React, including custom IDs and each theme's independent mode.
  const query = themeStartupQuery(themeRuntime.currentTheme())
  if (process.env.VITE_DEV_SERVER_URL) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL)
    const params = new URLSearchParams(url.search)
    for (const [key, value] of Object.entries(query)) params.set(key, value)
    url.search = params.toString()
    mainWindow.loadURL(url.toString())
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query })
  }
}

app.whenReady().then(() => {
  const isolatedUserData = process.env.MISAKA_E2E_USER_DATA
  if (isolatedUserData) app.setPath('userData', path.resolve(isolatedUserData))
  themeRuntime = createThemeRuntime(themeRegistry, path.join(app.getPath('userData'), 'desktop-theme.json'))
  ipcMain.on('bridge:send', (_event, cmd: any) => {
    // Pure pipe to the Python bridge. The theme used to be applied from here as well, which
    // made one settings click repaint three times; theme:set is the only entry point now.
    if (bridgeProcess && bridgeProcess.stdin.writable) {
      bridgeProcess.stdin.write(JSON.stringify(cmd) + '\n')
    }
  })

  ipcMain.handle('theme:get', (_event, name?: unknown) => themeRuntime.get(name))
  ipcMain.handle('theme:list', () => themeRuntime.list())
  ipcMain.handle('theme:set', (_event, name: unknown) => {
    const result = themeRuntime.set(name)
    // Same-ID requests intentionally re-push native chrome and theme:change; renderer dedupes.
    // Unknown IDs or persistence errors produce no native/renderer mutation.
    if (result.ok) pushActiveThemeToWindow()
    return result
  })

  ipcMain.handle('app:start-research-bridge', async (_event, input: ResearchBridgeLaunch) => {
    if (!input || typeof input.cwd !== 'string' || !input.cwd.trim()) {
      throw new Error('研究项目目录不能为空。')
    }
    return startResearchBridge(input)
  })
  ipcMain.on('research:send', (_event, command: unknown) => {
    if (!command || typeof command !== 'object' || Array.isArray(command)) return
    const value = command as Record<string, unknown>
    const allowed = new Set([
      'start_research', 'resume_research', 'stop_research', 'prompt', 'get_research_host',
      'get_stats', 'compact_session', 'cancel_session_operation',
      'set_permission_mode', 'set_model', 'set_thinking',
      'send_research_message',
      'desktop_set_team_model', 'desktop_retain_roles',
    ])
    if (typeof value.type !== 'string' || !allowed.has(value.type)) return
    if (value.type === 'prompt' && (typeof value.text !== 'string' || !value.text.startsWith('/research '))) return
    try { sendResearchCommand(value) }
    catch (error) { dispatchResearchMessage({ type: 'ack', requestId: value.requestId ?? null, ok: false, error: String(error) }) }
  })
  ipcMain.on('app:research-state', (_event, state: unknown) => {
    if (typeof state === 'boolean') {
      researchActive = state
      researchPendingCount = 0
    } else if (state && typeof state === 'object') {
      const snapshot = state as { active?: unknown; pendingCount?: unknown }
      researchActive = snapshot.active === true
      researchPendingCount = Number.isSafeInteger(snapshot.pendingCount) ? Math.max(0, Number(snapshot.pendingCount)) : 0
    }
    syncResearchTray()
  })

  ipcMain.handle('app:get-version', () => app.getVersion())
  ipcMain.handle('app:open-external', (_event, targetUrl: unknown) => openExternalHttpUrl(targetUrl))
  ipcMain.handle('app:open-path', async (_event, value: unknown) => {
    const targetPath = existingTargetPath(value)
    if (!targetPath) return { ok: false, error: 'The target path is missing or does not exist.' }
    try {
      const err = await shell.openPath(targetPath)
      return err ? { ok: false, error: err } : { ok: true }
    } catch (error) {
      return { ok: false, error: pathActionError(error) }
    }
  })
  ipcMain.handle('app:show-item-in-folder', (_event, value: unknown) => {
    const targetPath = existingTargetPath(value)
    if (!targetPath) return { ok: false, error: 'The target path is missing or does not exist.' }
    try {
      shell.showItemInFolder(targetPath)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: pathActionError(error) }
    }
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
  ipcMain.handle('app:pick-files', async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择附件',
      properties: ['openFile', 'multiSelections'],
      filters: [{
        name: 'Images, text and code',
        extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'txt', 'md', 'csv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'py', 'ts', 'tsx', 'js', 'jsx', 'html', 'css', 'scss', 'sh', 'bat', 'ps1', 'sql', 'xml'],
      }, { name: 'All files', extensions: ['*'] }],
    })
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle('app:confirm-close', async (_event, action: 'tray' | 'quit') => {
    if (action === 'tray') {
      ensureResearchTray()
      mainWindow?.hide()
      return
    }
    if (action === 'quit') {
      await quitApplication()
    }
  })

  createWindow()

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    } else {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (researchActive && researchTray) return
  stopBridgeProcess()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', event => {
  if (!allowQuit && researchBridgeProcess) {
    event.preventDefault()
    void requestWindowClose(mainWindow)
    return
  }
  stopBridgeProcess()
})
