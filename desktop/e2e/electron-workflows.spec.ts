import { _electron as electron, expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

function electronProcessIds(rootPid: number, verifyIds?: number[]): number[] {
  const args = [
    '-NoProfile', '-NonInteractive', '-File', path.join(process.cwd(), 'e2e', 'electron-process-tree.ps1'),
    '-RootProcessId', String(rootPid),
  ]
  if (verifyIds?.length) args.push('-VerifyProcessIds', verifyIds.join(','))
  const result = spawnSync('powershell.exe', args, { timeout: 10000, encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Electron process query exited ${String(result.status)}: ${result.stderr || result.stdout}`)
  return result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean).map(Number).filter(Number.isInteger)
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

test('real Electron keeps user data isolated, picks and prepares a file, and renames a session', async () => {
  console.log('Electron smoke stage: seed JSONL fixture')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'misaka-electron-e2e-'))
  const resolvedProfile = path.resolve(profile)
  const resolvedTempRoot = path.resolve(os.tmpdir())
  if (path.dirname(resolvedProfile) !== resolvedTempRoot || !path.basename(resolvedProfile).startsWith('misaka-electron-e2e-')) {
    throw new Error('Electron smoke profile escaped its dedicated temporary directory')
  }
  const cleanupProfile = () => {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-File', path.join(process.cwd(), 'e2e', 'cleanup-electron-profile.ps1'),
      '-TempRoot', resolvedTempRoot, '-Profile', resolvedProfile,
    ], { timeout: 20000, encoding: 'utf8', windowsHide: true })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Electron smoke profile cleanup exited ${String(result.status)}: ${result.stderr || result.stdout}`)
    if (fs.existsSync(resolvedProfile)) throw new Error('Electron smoke profile remains after cleanup.')
  }
  process.once('beforeExit', cleanupProfile)
  const home = path.join(profile, 'misaka-home')
  const appData = path.join(profile, 'app-data')
  const userData = path.join(profile, 'electron-user-data')
  const fixturePath = path.join(profile, 'electron-fixture.md')
  const workspace = path.join(profile, 'workspace')
  fs.mkdirSync(home)
  fs.mkdirSync(appData)
  fs.mkdirSync(userData)
  fs.mkdirSync(workspace)
  fs.writeFileSync(fixturePath, 'ELECTRON_FIXTURE_CONTENT', 'utf8')
  const projectRoot = path.resolve(process.cwd(), '..')
  const bridgeEnv = { ...process.env, APPDATA: appData, LOCALAPPDATA: appData, MISAKA_HOME: home }
  const sessionPath = execFileSync(path.join(projectRoot, '.venv', 'Scripts', 'python.exe'), ['-c', [
    'import json,sys',
    'from datetime import datetime,timezone',
    'from pathlib import Path',
    'from misaka.config import get_sessions_dir',
    'from misaka.core.session_manager import CURRENT_SESSION_VERSION,encode_cwd',
    'cwd=sys.argv[1]',
    'bucket=Path(get_sessions_dir())/encode_cwd(cwd)',
    'bucket.mkdir(parents=True,exist_ok=True)',
    'path=bucket/"electron-fixture.jsonl"',
    'timestamp=datetime.now(timezone.utc).isoformat()',
    'entries=[{"type":"session","version":CURRENT_SESSION_VERSION,"id":"electron-fixture-session","cwd":cwd,"timestamp":timestamp},{"type":"message","id":"electron-fixture-user","parentId":None,"timestamp":timestamp,"message":{"role":"user","content":[{"type":"text","text":"Electron fixture session"}],"timestamp":1}}]',
    'path.write_text("".join(json.dumps(entry,ensure_ascii=False)+"\\n" for entry in entries),encoding="utf-8")',
    'print(path)',
  ].join(';') , workspace], {
    cwd: projectRoot,
    env: bridgeEnv,
    encoding: 'utf8',
  }).trim()
  const listOutput = execFileSync(path.join(projectRoot, '.venv', 'Scripts', 'python.exe'), ['-m', 'misaka', 'desktop-bridge'], {
    cwd: projectRoot,
    env: bridgeEnv,
    input: `${JSON.stringify({ type: 'list_sessions', requestId: 'electron-fixture-list' })}\n${JSON.stringify({ type: 'shutdown' })}\n`,
    encoding: 'utf8',
    timeout: 45000,
  })
  const listAck = listOutput.split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return null }
  }).find(message => message?.requestId === 'electron-fixture-list' && message?.ok)
  expect(listAck?.data?.sessions?.some((session: { path: string }) => session.path === sessionPath)).toBe(true)
  console.log('Electron smoke stage: direct bridge lists fixture')

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    app = await electron.launch({
      args: [process.cwd()],
      env: {
        ...process.env,
        APPDATA: appData,
        LOCALAPPDATA: appData,
        MISAKA_HOME: home,
        MISAKA_E2E_USER_DATA: userData,
      },
    })
    console.log('Electron smoke stage: Electron launched')
    const page = await app.firstWindow()
    await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
    console.log('Electron smoke stage: renderer ready')
    await page.evaluate(() => {
      Object.assign(window, { __electronSmokeMessages: [] as unknown[] })
      window.bridge.on(message => { (window as any).__electronSmokeMessages.push(message) })
    })
    const rendererListRequestId = 'electron-smoke-list'
    await page.evaluate((requestId: string) => window.bridge.send({ type: 'list_sessions', requestId }), rendererListRequestId)
    await expect.poll(() => page.evaluate((requestId: string) => (window as any).__electronSmokeMessages.some((message: any) =>
      message.type === 'ack' && message.requestId === requestId && message.data?.sessions), rendererListRequestId)).toBe(true)
    const rendererSessionListed = await page.evaluate(({ requestId, targetPath }: { requestId: string; targetPath: string }) =>
      (window as any).__electronSmokeMessages.find((message: any) => message.type === 'ack' && message.requestId === requestId)
        ?.data?.sessions?.some((session: { path: string }) => session.path === targetPath),
    { requestId: rendererListRequestId, targetPath: sessionPath })
    expect(rendererSessionListed).toBe(true)
    console.log('Electron smoke stage: renderer list ACK includes fixture')

    await app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
    }, fixturePath)
    await expect.poll(async () => {
      for (const row of await page.locator('[data-session-path]').all()) {
        if (await row.getAttribute('data-session-path') === sessionPath) return true
      }
      return false
    }).toBe(true)
    const sessionRows = await page.locator('[data-session-path]').all()
    let selectedSessionRow = sessionRows[0]
    for (const row of sessionRows) {
      if (await row.getAttribute('data-session-path') === sessionPath) { selectedSessionRow = row; break }
    }
    await selectedSessionRow.getByRole('button', { name: 'Electron fixture session', exact: true }).click()
    await expect.poll(() => page.evaluate((targetPath: string) =>
      (window as any).__electronSmokeMessages.some((message: any) =>
        (message.type === 'ack' && message.data?.session?.file === targetPath)
        || (message.event?.type === 'session_started' && message.event.file === targetPath)), sessionPath,
    )).toBe(true)
    console.log('Electron smoke stage: session load ACK observed')
    const visibleAfterLoad = await page.locator('body').innerText()
    expect(visibleAfterLoad).toContain('Electron fixture session')
    await expect(page.getByText('Electron fixture session', { exact: true }).first()).toBeVisible()
    const sessionOptions = page.locator('button[title="更多会话选项"]')
    await expect(sessionOptions).toHaveCount(1)
    await sessionOptions.click()
    const renameAction = page.getByRole('button', { name: '重命名会话', exact: true })
    await expect(renameAction).toBeEnabled()
    await page.evaluate(() => { window.prompt = () => { throw new Error('window.prompt invoked') } })
    await renameAction.click()
    await page.getByRole('textbox', { name: '会话名称' }).fill('Electron 回归会话')
    await page.getByRole('button', { name: '保存名称' }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.getByTestId('workspace').getByText('Electron 回归会话', { exact: true })).toBeVisible()
    console.log('Electron smoke stage: rename ACK settled in UI')

    await page.getByRole('button', { name: '添加附件' }).click()
    await expect(page.getByText('electron-fixture.md', { exact: true })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: '处理中' })).toHaveCount(0)
    console.log('Electron smoke stage: attachment preparation ACK settled')
    await app.evaluate(({ ipcMain }) => {
      const prompts: any[] = []
      ;(globalThis as any).__electronSmokePrompts = prompts
      ipcMain.removeAllListeners('bridge:send')
      ipcMain.on('bridge:send', (event, command: any) => {
        if (command?.type !== 'prompt') return
        prompts.push(command)
        event.sender.send('bridge:event', { type: 'ack', requestId: command.requestId, ok: true })
      })
    })
    await page.getByRole('button', { name: '发送指令 (Enter)' }).click()
    await expect(page.locator('.conversation-user-message').last()).toContainText('ELECTRON_FIXTURE_CONTENT')
    const capturedPrompt = await app.evaluate(() => (globalThis as any).__electronSmokePrompts[0])
    expect(capturedPrompt.text).toContain('ELECTRON_FIXTURE_CONTENT')
    console.log('Electron smoke stage: attachment payload sent')

    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(userData)

    await app.evaluate(({ Menu, dialog, ipcMain }) => {
      const buildFromTemplate = Menu.buildFromTemplate.bind(Menu)
      ;(Menu as any).buildFromTemplate = (template: any[]) => {
        ;(globalThis as any).__electronSmokeResearchMenu = template
        return buildFromTemplate(template)
      }
      dialog.showMessageBox = async () => ({ response: 2 })
      ipcMain.emit('app:research-state', {} as any, { active: true, pendingCount: 2 })
    })
    // A page that can answer keeps the decision: the in-page dialog chooses 最小化到托盘, which is
    // the same outcome the native box's 后台继续 gives. The frozen-page path is covered by
    // electron-close-fallback.spec.ts.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await page.getByRole('button', { name: '最小化到托盘' }).click()
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)).toBe(false)
    expect(app.process().exitCode).toBeNull()
    const trayLabels = await app.evaluate(() => ((globalThis as any).__electronSmokeResearchMenu || []).map((item: any) => item.label))
    expect(trayLabels).toContain('研究进行中 · 2 项待处理')
    await app.evaluate(() => (globalThis as any).__electronSmokeResearchMenu
      ?.find((item: any) => item.label === '打开 Misaka Agent')?.click?.())
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)).toBe(true)
    await app.evaluate(({ ipcMain }) => ipcMain.emit('app:research-state', {} as any, { active: true, pendingCount: 1 }))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await page.getByRole('button', { name: '取消' }).click()
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)).toBe(true)
    await app.evaluate(({ ipcMain }) => ipcMain.emit('app:research-state', {} as any, false))
    console.log('Electron smoke stage: tray background, reopen and cancel-close lifecycle verified')
  } finally {
    console.log('Electron smoke stage: cleanup started')
    let teardownError: unknown
    try {
      if (app) {
        const electronProcess = app.process()
      console.log('Electron smoke cleanup: capture owned process IDs')
        const ownedProcessIds = process.platform === 'win32' ? electronProcessIds(electronProcess.pid!) : [electronProcess.pid!]
      console.log(`Electron smoke cleanup: ${ownedProcessIds.length} owned process IDs captured`)
        const contextClosed = await Promise.race([
          app.close().then(() => true, () => false),
          wait(5000).then(() => false),
        ])
      console.log(`Electron smoke cleanup: BrowserContext closed=${contextClosed}`)
        if (!contextClosed) {
          await Promise.race([
            app.evaluate(({ app }) => app.quit()).then(() => true, () => false),
            wait(3000).then(() => false),
          ])
        }

        const processExitDeadline = Date.now() + 5000
        let remaining = process.platform === 'win32'
          ? electronProcessIds(electronProcess.pid!, ownedProcessIds)
          : electronProcess.exitCode === null ? [electronProcess.pid!] : []
        while (remaining.length && Date.now() < processExitDeadline) {
          await wait(250)
          remaining = process.platform === 'win32'
            ? electronProcessIds(electronProcess.pid!, ownedProcessIds)
            : electronProcess.exitCode === null ? [electronProcess.pid!] : []
        }
        if (remaining.length) {
          for (const pid of remaining) {
            try {
              if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
              else process.kill(pid, 'SIGKILL')
            } catch { /* verify exit below; already-exited descendants are expected here */ }
          }
          const forcedExitDeadline = Date.now() + 10000
          while (remaining.length && Date.now() < forcedExitDeadline) {
            await wait(250)
            remaining = process.platform === 'win32'
              ? electronProcessIds(electronProcess.pid!, ownedProcessIds)
              : electronProcess.exitCode === null ? [electronProcess.pid!] : []
          }
        }
        if (remaining.length) throw new Error(`Electron-owned child processes remained after cleanup: ${remaining.join(', ')}`)
        if (!contextClosed) {
          const contextClosedAfterExit = await Promise.race([
            app.close().then(() => true, () => false),
            wait(5000).then(() => false),
          ])
          if (!contextClosedAfterExit) throw new Error('Playwright Electron context did not close after its process tree exited')
        }
      }
    } catch (error) {
      teardownError = error
    }

    try { cleanupProfile() }
    catch (error) { teardownError ??= error }
    if (teardownError) throw teardownError
  }
})
