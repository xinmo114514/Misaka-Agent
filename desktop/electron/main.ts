import { app, BrowserWindow, dialog, ipcMain, shell, Tray, Menu, nativeImage } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validatedExternalHttpUrl } from './externalUrl'
import { themeRegistry } from '../src/theme/registry'
import { createThemeRuntime, themeStartupQuery, windowThemeOptions } from './themeRuntime'
import { bridgeEnvironment, researchBridgeArgs, resolvedResearchBridgeLaunch, sameResearchBridge, type ResearchBridgeLaunch } from './researchBridge'
import { createCloseFlow, TERMINATE_WAIT_MS, type CloseFlow } from './closeFlow'
import { createDiagnostics, collectBuildIdentity, eventIdentity, type DiagnosticFields, type Diagnostics } from './diagnostics'
const projectRoot = path.resolve(__dirname, '..', '..')
let mainWindow: BrowserWindow | null = null
let bridgeProcess: ChildProcessWithoutNullStreams | null = null
let researchBridgeProcess: ChildProcessWithoutNullStreams | null = null
let researchBridgeLaunch: ResearchBridgeLaunch | null = null
let researchHostIdentity: { sessionId: string; streamId?: string } | null = null
let researchActive = false
let researchPendingCount = 0
let researchTray: Tray | null = null
let researchStarting = false
let allowClose = false
let allowQuit = false
let closeFlow: CloseFlow | null = null
const researchWaiters = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
const recentResearchMessages: unknown[] = []
let themeRuntime: ReturnType<typeof createThemeRuntime>
let diagnostics: Diagnostics | null = null
/** What the main thread saw between two flushes; a flood must not become a record per event. */
let streamWindow = { received: 0, sent: 0, dropped: 0, bytes: 0, maxBytes: 0, lastSeq: 0, since: Date.now() }

function noteStreamLine(bytes: number, message: any): void {
  streamWindow.received += 1
  streamWindow.bytes += bytes
  streamWindow.maxBytes = Math.max(streamWindow.maxBytes, bytes)
  if (typeof message?.seq === 'number') streamWindow.lastSeq = message.seq
}

function flushStreamWindow(): void {
  if (!diagnostics) return
  const now = Date.now()
  if (streamWindow.received > 0) {
    diagnostics.record('bridge:window', {
      ...streamWindow, windowMs: now - streamWindow.since, pending: researchWaiters.size, buffered: recentResearchMessages.length,
    })
  }
  streamWindow = { received: 0, sent: 0, dropped: 0, bytes: 0, maxBytes: 0, lastSeq: 0, since: now }
}

function dispatchResearchMessage(message: any, bytes = 0): void {
  if (message?.type === 'ack' && typeof message.requestId === 'string') {
    const waiter = researchWaiters.get(message.requestId)
    if (waiter) {
      researchWaiters.delete(message.requestId)
      clearTimeout(waiter.timer)
      if (message.ok === false) {
        diagnostics?.record('bridge:ack-failed', { ...eventIdentity(message), type: 'ack' })
        waiter.reject(new Error(message.error || '研究桥接请求失败'))
      } else waiter.resolve(message.data ?? message)
    }
  }
  recentResearchMessages.push(message)
  if (recentResearchMessages.length > 300) {
    streamWindow.dropped += recentResearchMessages.length - 300
    recentResearchMessages.splice(0, recentResearchMessages.length - 300)
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    streamWindow.dropped += 1
    return
  }
  // The renderer turns this into "how long was this message waiting before it reached me".
  const stamped = { ...message, mainSentAt: Date.now(), mainBytes: bytes }
  try {
    mainWindow.webContents.send('research:event', stamped)
    streamWindow.sent += 1
    if (diagnostics && message?.event?.type && message.event.type !== 'message_update') {
      diagnostics.record('bridge:event', { ...eventIdentity(message), windowMs: Date.now() - streamWindow.since })
    }
  } catch (error) {
    diagnostics?.record('bridge:send-failed', { ...eventIdentity(message), error: error instanceof Error ? error.message : String(error) })
  }
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
    if (!(await stopResearchBridge(30000))) {
      throw new Error('上一个研究运行时仍在停止中；请在窗口关闭时选择停止或退出，再切换研究项目。')
    }
  }

  const isWin = process.platform === 'win32'
  researchStarting = true
  const child = spawn(isWin ? 'uv.exe' : 'uv', researchBridgeArgs(input), {
    cwd: projectRoot,
    env: bridgeEnvironment(),
    shell: false,
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
      let parsed: any = null
      try { parsed = JSON.parse(trimmed) }
      catch (error) { console.error('Failed to parse research bridge JSON:', trimmed, error); continue }
      noteStreamLine(trimmed.length, parsed)
      dispatchResearchMessage(parsed, trimmed.length)
    }
  })
  child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
  child.on('close', (code) => {
    diagnostics?.record('bridge:exit', { code, pending: researchWaiters.size })
    if (researchBridgeProcess === child) {
      researchStarting = false
      if (researchHostIdentity) dispatchResearchMessage({ seq: 0, ...researchHostIdentity,
        event: { type: 'research_connection_error', error: `研究连接已断开 (${code})，再次发送将恢复原会话。` } })
      researchBridgeProcess = null
      researchBridgeLaunch = null
      researchHostIdentity = null
    }
    releaseResearchWaiters(`研究桥接进程已退出 (${code})`)
  })

  try {
    const host = await requestResearchCommand('get_research_host', {}, 30000)
    if (!host?.enabled || !host?.session?.file) {
      child.kill()
      throw new Error('独立研究会话未能启动。')
    }
    researchBridgeLaunch = resolvedResearchBridgeLaunch(input, host.session.file)
    researchHostIdentity = { sessionId: host.session.sessionId, streamId: host.streamId }
    researchStarting = false
    return host
  } catch (error) {
    // A start that failed still counts as work in progress while its process is ours.
    researchStarting = researchBridgeProcess !== null
    throw error
  }
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
    { label: '退出 Misaka Agent', click: () => { void closeFlow?.quitDirectly() } },
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

  const env = bridgeEnvironment()

  bridgeProcess = spawn(uvExecutable, bridgeArgs, {
    cwd: projectRoot,
    env: env as NodeJS.ProcessEnv,
    shell: false,
    windowsHide: true,
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

  const child = bridgeProcess
  child.on('close', (code) => {
    console.log(`Bridge process exited with code ${code}`)
    if (bridgeProcess === child) bridgeProcess = null
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
  const pipesClosed = [child.stdout, child.stderr].every(stream => stream.readableEnded || stream.destroyed)
  if ((child.exitCode !== null || child.signalCode !== null) && pipesClosed) return Promise.resolve(true)
  return new Promise(resolve => {
    let settled = false
    const finish = (exited: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('close', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('close', onExit)
  })
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.platform !== 'win32' || child.pid === undefined) {
    child.kill('SIGKILL')
    return
  }
  // Ours to clean: this child's own tree by PID, never a name match across other applications.
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

/** Cooperative: ask the runtime to shut down, close stdin so its reader sees EOF, then wait. */
async function stopResearchBridge(timeoutMs: number): Promise<boolean> {
  const child = researchBridgeProcess
  if (!child) return true
  // This stop is ours, on purpose: the host is about to be replaced, so its exit is not a
  // connection loss the renderer should report. Dropping the identity before the exit event
  // keeps it from broadcasting `research_connection_error` over the run being started next
  // (2026-10-18 e2e: a new round began under "研究连接已断开 (0)").
  researchHostIdentity = null
  try {
    if (child.stdin.writable) {
      child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n')
      // Python's stdio reader may already be waiting for the next line in its
      // executor. EOF releases that reader so an idle host can actually exit.
      child.stdin.end()
    }
  } catch { /* the exit event below is the authoritative signal */ }
  const exited = await waitForChildExit(child, timeoutMs)
  if (exited && researchBridgeProcess === child) {
    researchBridgeProcess = null
    researchBridgeLaunch = null
    researchHostIdentity = null
  }
  diagnostics?.record('close:stopped-research', { exited })
  return exited
}

async function stopOrdinaryBridge(timeoutMs: number): Promise<boolean> {
  const child = bridgeProcess
  if (!child) return true
  try {
    if (child.stdin.writable && !child.stdin.writableEnded) {
      child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n')
      child.stdin.end()
    }
  } catch { /* retain ownership until the process close is verified */ }
  let exited = await waitForChildExit(child, timeoutMs)
  if (!exited) {
    try { await terminateProcessTree(child) }
    catch (error) { diagnostics?.record('close:terminate-failed', { error: pathActionError(error) }) }
    exited = await waitForChildExit(child, TERMINATE_WAIT_MS)
  }
  if (exited && bridgeProcess === child) bridgeProcess = null
  return exited
}

/** Exiting owns both runtimes, including a survivor of an earlier failed force cleanup. */
async function stopOwnedBridges(timeoutMs: number): Promise<boolean> {
  const exited = await Promise.all([stopResearchBridge(timeoutMs), stopOrdinaryBridge(Math.min(timeoutMs, 1000))])
  return exited.every(Boolean) && researchBridgeProcess === null && bridgeProcess === null
}

/**
 * Force: clean up the two children this application started and their descendants, then verify they
 * really went away. An unverified cleanup is reported as a failure, never as a successful exit.
 */
async function forceTerminateOwnedProcesses(): Promise<boolean> {
  const targets = [researchBridgeProcess, bridgeProcess].filter(Boolean) as ChildProcessWithoutNullStreams[]
  researchHostIdentity = null
  for (const child of targets) {
    try { await terminateProcessTree(child) }
    catch (error) { diagnostics?.record('close:terminate-failed', { error: pathActionError(error) }) }
  }
  const gone = await Promise.all(targets.map(child => waitForChildExit(child, TERMINATE_WAIT_MS)))
  for (const [index, child] of targets.entries()) {
    if (!gone[index]) continue
    if (researchBridgeProcess === child) {
      researchBridgeProcess = null
      researchBridgeLaunch = null
    }
    if (bridgeProcess === child) bridgeProcess = null
  }
  const verified = gone.every(Boolean) && researchBridgeProcess === null && bridgeProcess === null
  diagnostics?.record('close:forced', { targets: targets.length, verified })
  return verified
}

/** One lifecycle for the research waiters: no timer or pending request outlives a stop. */
function releaseResearchWaiters(reason: string): void {
  for (const [id, waiter] of Array.from(researchWaiters)) {
    clearTimeout(waiter.timer)
    researchWaiters.delete(id)
    waiter.reject(new Error(reason))
  }
}

function installCloseFlow(): void {
  closeFlow = createCloseFlow({
    sendToRenderer: closeRequestId => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:request-close', { closeRequestId })
    },
    showNativeDialog: async request => {
      const options = {
        type: 'question' as const,
        title: 'Misaka Agent',
        message: request.message,
        detail: request.detail,
        buttons: request.buttons,
        cancelId: request.cancelId,
        defaultId: request.defaultId,
        noLink: true,
      }
      const result = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options)
      return result.response
    },
    // A start with no run id yet, or a command still waiting for its ack, is work in progress:
    // the reader must be asked before anything is dropped.
    researchActive: () => researchActive || researchStarting || researchWaiters.size > 0,
    stopResearch: timeoutMs => stopOwnedBridges(timeoutMs),
    forceTerminate: () => forceTerminateOwnedProcesses(),
    showError: (message, detail) => {
      void dialog.showMessageBox({ type: 'error', title: 'Misaka Agent', message, detail, buttons: ['好'], noLink: true })
    },
    hideWindow: () => { ensureResearchTray(); mainWindow?.hide() },
    allowWindowClose: () => { allowClose = true },
    quit: () => {
      researchActive = false
      allowQuit = true
      stopBridgeProcess()
      app.quit()
    },
    log: (kind, fields) => diagnostics?.record(kind, fields),
  })
}

/** The ordinary bridge stops the same way the research host does: ask, give it a second, then clean our own tree. */
function stopBridgeProcess(): void {
  void stopOrdinaryBridge(1000)
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
    }
    // The page gets the first chance; the flow falls back to native code if it cannot answer.
    void closeFlow?.requestClose()
  })

  // The three signals that say "the page stopped answering" from outside the page.
  mainWindow.on('unresponsive', () => {
    diagnostics?.record('window:unresponsive', { gone: false })
    closeFlow?.noteUnresponsive()
  })
  mainWindow.on('responsive', () => {
    diagnostics?.record('window:responsive', {})
    closeFlow?.noteResponsive()
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    diagnostics?.record('window:render-gone', { reason: details.reason, exitCode: details.exitCode })
    closeFlow?.noteUnresponsive()
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    diagnostics?.record('window:load-failed', { errorCode, description: errorDescription })
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
      diagnostics?.record('window:loaded', { url: mainWindow.webContents.getURL(), replayed: recentResearchMessages.length })
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
  diagnostics = createDiagnostics({ env: process.env, homedir: os.homedir() })
  diagnostics.record('shell:start', collectBuildIdentity({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform}/${process.arch}`,
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
    files: {
      main: path.join(__dirname, 'main.js'),
      preload: ['preload.cjs', 'preload.mjs', 'preload.js']
        .map(name => path.join(__dirname, name)).find(candidate => fs.existsSync(candidate)) ?? '',
      renderer: path.join(__dirname, '..', 'dist', 'index.html'),
    },
  }))
  setInterval(flushStreamWindow, 2000).unref?.()
  ipcMain.on('diag:renderer', (_event, records: unknown) => {
    if (!Array.isArray(records)) return
    diagnostics?.recordBatch(records as DiagnosticFields[])
  })
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
      'send_research_message', 'abort',
      'desktop_set_team_model', 'desktop_retain_roles',
      'get_research_sessions', 'get_research_session_history', 'get_research_session_content',
      'watch_research_sessions', 'unwatch_research_sessions',
      'check_research_connection',
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
      const snapshot = state as { active?: unknown; pendingCount?: unknown; pendingStart?: unknown }
      if (typeof snapshot.active === 'boolean') researchActive = snapshot.active
      if (Number.isSafeInteger(snapshot.pendingCount)) researchPendingCount = Math.max(0, Number(snapshot.pendingCount))
      // A submission that has no run id yet is in progress too; the page is the only place that
      // knows it exists. Once a process is ours, its own lifecycle is the authority.
      if (typeof snapshot.pendingStart === 'boolean') {
        if (snapshot.pendingStart) researchStarting = true
        else if (!researchBridgeProcess) researchStarting = false
      }
    }
    syncResearchTray()
  })
  ipcMain.on('app:close-presented', (_event, closeRequestId: unknown) => {
    const id = Number(closeRequestId)
    if (Number.isSafeInteger(id) && id > 0) closeFlow?.rendererTookOver(id)
  })
  ipcMain.on('app:close-cancelled', (_event, closeRequestId: unknown) => {
    const id = Number(closeRequestId)
    if (Number.isSafeInteger(id) && id > 0) closeFlow?.rendererCancelled(id)
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
    // Anything that reaches here came from the page, so the page is alive: stand the native
    // fallback down before acting on the choice.
    if (closeFlow) closeFlow.rendererTookOver(closeFlow.closeRequestId())
    if (action === 'tray') { closeFlow?.rendererHide(); return }
    if (action === 'quit') await closeFlow?.rendererQuit()
  })

  installCloseFlow()
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
  if (allowQuit) {
    allowClose = true
    stopBridgeProcess()
    return
  }
  // A run in progress, or a start that has no run id yet, belongs to the reader: the close flow
  // asks (in native code, because a stuck page cannot be trusted to).
  if (researchActive || researchStarting || researchWaiters.size > 0) {
    event.preventDefault()
    void closeFlow?.requestClose({ skipRenderer: true })
    return
  }
  // Idle runtimes need no initial question, but every owned child still has to exit before we do.
  if (researchBridgeProcess || bridgeProcess) {
    event.preventDefault()
    void closeFlow?.quitDirectly()
    return
  }
  allowClose = true
  stopBridgeProcess()
})

app.on('quit', () => {
  diagnostics?.record('app:quit', { allowQuit, researchActive, pending: researchWaiters.size })
  closeFlow?.dispose()
  releaseResearchWaiters('应用正在退出')
  diagnostics?.dispose()
})
