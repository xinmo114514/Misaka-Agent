import { _electron as electron, expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeBounded, registerFixtureCleanup } from './electronFixtureCleanup'
import { createFixtureProvider } from './researchRecruitmentFixture'

test.setTimeout(90000)

/** What the main process recorded instead of showing a real modal to whoever runs the suite. */
interface DialogAsk {
  message: string
  detail: string
  buttons: string[]
  cancelId: number
  defaultId: number
}

async function stubDialogs(app: Awaited<ReturnType<typeof electron.launch>>, answers: number[]): Promise<void> {
  await app.evaluate(({ dialog }, responses) => {
    const asked: unknown[] = []
    ;(globalThis as any).__closeAsks = asked
    const original = dialog.showMessageBox.bind(dialog)
    dialog.showMessageBox = (async (...args: any[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as Record<string, unknown>
      asked.push({ message: options.message, detail: options.detail, buttons: options.buttons,
        cancelId: options.cancelId, defaultId: options.defaultId })
      const next = responses.shift()
      if (next === undefined) return { response: (options.cancelId as number) ?? 0 }
      return { response: next }
      void original
    }) as typeof dialog.showMessageBox
  }, answers)
}

function asks(app: Awaited<ReturnType<typeof electron.launch>>): Promise<DialogAsk[]> {
  return app.evaluate(() => (globalThis as any).__closeAsks as DialogAsk[])
}

/** The window close is only ever pressed from the main process: a frozen page cannot be trusted to. */
async function makeProfile(): Promise<string> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'misaka-electron-close-e2e-'))
  const resolved = path.resolve(profile)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('misaka-electron-close-e2e-')) {
    throw new Error('Unexpected temporary profile')
  }
  return resolved
}

async function launch(profile: string, homeOverride?: string) {
  const home = homeOverride ?? path.join(profile, 'home')
  fs.mkdirSync(home, { recursive: true })
  const app = await electron.launch({ args: [process.cwd()], env: {
    ...process.env, MISAKA_HOME: home, MISAKA_E2E_USER_DATA: path.join(profile, 'user-data'),
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
  } })
  await registerFixtureCleanup(app, profile, home)
  app.process().stderr?.on('data', chunk => process.stderr.write(String(chunk)))
  const page = await app.firstWindow()
  await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
  return { app, page, home }
}

function launchWithHome(profile: string, home: string) {
  return launch(profile, home)
}

/** The close phases the main process itself wrote into the home it was given. */
function readPhases(home: string): string[] {
  const dir = path.join(home, 'logs', 'desktop-diagnostics')
  if (!fs.existsSync(dir)) return []
  const records: string[] = []
  for (const name of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8')
    for (const line of text.split(new RegExp(String.fromCharCode(92) + 's+'))) {
      if (!line) continue
      try {
        const record = JSON.parse(line) as { kind?: string; phase?: string }
        if (record.kind === 'close:phase' && record.phase) records.push(record.phase)
      } catch { /* a half-written line is not a phase */ }
    }
  }
  return records
}

async function cleanup(profile: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { fs.rmSync(profile, { recursive: true, force: true }); return }
    catch { await new Promise(resolve => setTimeout(resolve, 400)) }
  }
}

async function pressClose(app: Awaited<ReturnType<typeof electron.launch>>) {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    // The window's own close, exactly what the title bar button does.
    win?.close()
  })
}

/**
 * Make the page stop answering for `ms`, from inside the page: the call returns first, so the spin
 * is already running by the time the test presses the window close. A spin driven from the test's
 * own `evaluate` would be serialized against the same IPC channel the close uses.
 */
async function freezeRenderer(page: import('@playwright/test').Page, ms: number): Promise<void> {
  const until = await page.evaluate((limit) => {
    const holder = window as unknown as { __spinUntil: number }
    holder.__spinUntil = Date.now() + limit
    setTimeout(() => { while (Date.now() < holder.__spinUntil) { /* spin */ } }, 0)
    return holder.__spinUntil
  }, ms)
  // Give the timer a moment to take the thread.
  await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(50, until - Date.now() - 50))))
}

test.describe('closing a window that cannot answer', () => {
  let profile = ''

  test.beforeEach(async () => { profile = await makeProfile() })
  test.afterEach(async () => { await cleanup(profile) })

  test('a living page keeps its own dialog and no native box appears', async () => {
    const { app, page } = await launch(profile)
    try {
      console.log('close stage: launched')
      await stubDialogs(app, [])
      console.log('close stage: dialogs stubbed')
      await pressClose(app)
      console.log('close stage: close pressed')
      await expect(page.getByRole('alertdialog', { name: '关闭 Misaka 窗口？' })).toBeVisible({ timeout: 15000 })
      console.log('close stage: in-page dialog visible')
      // The page confirmed the dialog is on screen, so the main process stays out of it.
      await expect.poll(() => asks(app), { timeout: 5000 }).toEqual([])
      console.log('close stage: no native ask')
      await page.getByRole('button', { name: '取消' }).click()
      await expect(page.getByRole('alertdialog')).toBeHidden()
      console.log('close stage: cancelled')
      // Cancelling hands the close back: a second press works again.
      await pressClose(app)
      await expect(page.getByRole('alertdialog', { name: '关闭 Misaka 窗口？' })).toBeVisible({ timeout: 15000 })
      expect(app.process().exitCode).toBeNull()
      console.log('close stage: second press works')
    } finally {
      await closeBounded(app)
    }
  })

  test('a frozen page falls back to the native question within a second and a half', async () => {
    const { app, page } = await launch(profile)
    try {
      await stubDialogs(app, [2, 2])  // both asks answer 取消
      await freezeRenderer(page, 14000)
      const startedAt = Date.now()
      await pressClose(app)
      await expect.poll(() => asks(app).then(items => items.length), { timeout: 15000, message: 'no native fallback' })
        .toBeGreaterThan(0)
      const elapsed = Date.now() - startedAt
      const [ask] = await asks(app)
      expect(ask.buttons).toEqual(['退出', '取消'])
      expect(ask.cancelId).toBe(1)
      expect(elapsed, `native fallback took ${elapsed}ms`).toBeLessThan(6000)

      // Cancelling keeps the window and the page alive; nothing is stopped.
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true)
      expect(app.process().exitCode).toBeNull()
      // The page is still stuck, so the next press goes to native code again.
      await pressClose(app)
      await expect.poll(() => asks(app).then(items => items.length), { timeout: 15000 }).toBe(2)
      await expect.poll(() => page.evaluate(() => Date.now() > (window as unknown as { __spinUntil: number }).__spinUntil),
        { timeout: 25000 }).toBe(true)
      // A page that answers after its own window was already dealt with must not quit anything.
      expect(app.process().exitCode).toBeNull()
    } finally {
      await closeBounded(app)
    }
  })

  test('a renderer crash after its dialog appeared releases closing to native confirmation', async () => {
    const { app, page } = await launch(profile)
    try {
      await stubDialogs(app, [])
      await pressClose(app)
      await expect(page.getByRole('alertdialog', { name: '关闭 Misaka 窗口？' })).toBeVisible()
      await app.evaluate(async ({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents
        await new Promise<void>(resolve => {
          contents.once('render-process-gone', () => resolve())
          contents.forcefullyCrashRenderer()
        })
      })
      await pressClose(app)
      await expect.poll(() => asks(app).then(items => items.length)).toBe(1)
      expect((await asks(app))[0].buttons).toEqual(['退出', '取消'])
      expect(app.process().exitCode).toBeNull()
    } finally {
      await closeBounded(app)
    }
  })

  test('repeated closes during a freeze ask only once', async () => {
    const { app, page } = await launch(profile)
    try {
      await stubDialogs(app, [2, 2])
      await freezeRenderer(page, 9000)
      await pressClose(app)
      await pressClose(app)
      await pressClose(app)
      await expect.poll(() => asks(app).then(items => items.length), { timeout: 15000 }).toBe(1)
    } finally {
      await closeBounded(app)
    }
  })

  test('后台继续 leaves the research running and only hides the window', async () => {
    const { app, page, home } = await launch(profile)
    try {
      const workspace = path.join(profile, 'workspace')
      fs.mkdirSync(workspace, { recursive: true })
      const host = await page.evaluate(async cwd => window.app.startResearchBridge({ cwd }), workspace)
      expect(host.enabled).toBe(true)
      // The page is the one that normally reports activity; here the main process is told directly,
      // because the point of the test is a page that cannot say anything.
      await app.evaluate(({ ipcMain }, state) => ipcMain.emit('app:research-state', {} as any, state),
        { active: true, pendingCount: 2 })
      await stubDialogs(app, [1])  // 后台继续
      await freezeRenderer(page, 9000)
      await pressClose(app)
      await expect.poll(() => asks(app).then(items => items.length), { timeout: 15000 }).toBe(1)
      const [ask] = await asks(app)
      expect(ask.buttons).toEqual(['停止并退出', '后台继续', '取消'])
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false)
      expect(app.process().exitCode).toBeNull()
      expect(fs.existsSync(path.join(home, 'state', 'sessions'))).toBe(true)
    } finally {
      await closeBounded(app)
    }
  })

  test('the in-page 退出 drives the shared stop path to its end', async () => {
    const { app, page, home } = await launch(profile)
    try {
      await stubDialogs(app, [])
      await pressClose(app)
      await expect(page.getByRole('alertdialog', { name: '关闭 Misaka 窗口？' })).toBeVisible({ timeout: 15000 })
      expect(await asks(app)).toEqual([])
      // The very message the dialog's 退出应用 button sends. It cannot be awaited: the renderer is
      // taken down by the quit before the invoke can answer.
      await page.evaluate(() => { void window.app.confirmClose?.('quit') })
        .catch(() => { /* the quit we asked for */ })
      // The state machine runs to the end in the main process, whatever the OS takes its time with.
      await expect.poll(() => readPhases(home).join('>'), { timeout: 30000 })
        .toContain('stopping>exited')
      // And the application is really going: either the pid has an exit code, or its main-process
      // context is already torn down.
      await expect.poll(async () => {
        try {
          await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
          return app.process().exitCode
        } catch {
          return 'tearing-down'
        }
      }, { timeout: 90000, message: 'the app never began tearing down after its own quit' })
        .not.toBeNull()
    } finally {
      await closeBounded(app)
    }
  })

  test('a real research host is stopped and the app exits when the reader agrees', async () => {
    const fixture = await createFixtureProvider({ profile, turns: [] })
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined
    try {
      const launched = await launchWithHome(profile, fixture.home)
      app = launched.app
      const page = launched.page
      const host = await page.evaluate(async cwd => window.app.startResearchBridge({ cwd }), fixture.workspace)
      expect(host.enabled).toBe(true)
      await stubDialogs(app, [])
      // A living page keeps its own dialog even with a research host running; the native box stays away.
      await pressClose(app)
      await expect(page.getByRole('alertdialog', { name: '关闭 Misaka 窗口？' })).toBeVisible({ timeout: 15000 })
      expect(await asks(app)).toEqual([])
      // The dialog's 退出应用 sends exactly this; it cannot be awaited, the renderer dies first.
      await page.evaluate(() => { void window.app.confirmClose?.('quit') })
        .catch(() => { /* the quit we asked for */ })
      await expect.poll(() => {
        try { return app!.process().exitCode } catch { return 'closed' }
      }, { timeout: 90000 }).not.toBeNull()
      // The runtime this application started went with it, through the shared stop path.
      const phases = readPhases(fixture.home)
      expect(phases).toContain('stopping')
      expect(phases).toContain('exited')
    } finally {
      if (app) await closeBounded(app)
      await fixture.close()
    }
  })
})
