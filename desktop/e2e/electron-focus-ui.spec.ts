import { _electron as electron, expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const evidence = path.resolve(process.cwd(), process.env.MISAKA_VISUAL_EVIDENCE || '../.superpowers/sdd/focus-ui-refinement-2026-10-20')

test('the shipped Electron renderer keeps the focus drawer above the composer and returns its focus', async () => {
  fs.mkdirSync(evidence, { recursive: true })
  const profile = fs.mkdtempSync(path.join(evidence, 'electron-ui-profile-'))
  const main = path.join(profile, 'main.cjs')
  fs.writeFileSync(main, `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', process.env.MISAKA_UI_PROFILE);
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, width: 1440, height: 1000,
    webPreferences: { contextIsolation: true, nodeIntegration: false } });
  window.loadURL(process.env.MISAKA_UI_URL);
});
app.on('window-all-closed', () => app.quit());
`)
  const env = { ...process.env, MISAKA_UI_PROFILE: path.join(profile, 'user-data'),
    MISAKA_UI_URL: `http://127.0.0.1:${process.env.MISAKA_E2E_PORT || '4174'}/e2e/conversation.html` }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [main], env })
  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect(page.getByRole('textbox')).toBeVisible()
    const versions = await app.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome }))
    fs.writeFileSync(path.join(evidence, 'electron-renderer-versions.json'), JSON.stringify(versions, null, 2))
    await page.evaluate(() => {
      const fixture = (window as any).conversationFixture
      fixture.reset()
      fixture.research.openRun()
      return fixture.theme('dark')
    })
    await expect(page.locator('[data-research-focus-toolbar]')).toHaveCount(1)
    const team = page.getByRole('button', { name: /研究团队/ })
    await team.click()
    await page.getByRole('button', { name: '在右侧查看 长上下文跨段整合' }).click()
    const side = page.locator('.research-side-panel')
    expect((await side.boundingBox())!.width).toBeCloseTo(360, 0)
    await page.setViewportSize({ width: 1200, height: 850 })
    const drawer = page.getByRole('dialog', { name: '长上下文跨段整合 侧栏' })
    await expect(drawer).toHaveAttribute('aria-modal', 'true')
    await page.screenshot({ path: path.join(evidence, 'screenshots/electron-focus-drawer.png') })
    const paint = await drawer.evaluate(element => {
      const side = element.getBoundingClientRect()
      const composer = document.querySelector('.conversation-composer')!.getBoundingClientRect()
      const x = Math.max(side.left, composer.left) + 8
      const y = Math.min(side.bottom, composer.bottom) - 8
      // Inert removes hit testing but not paint. Temporarily lift only that testing restriction
      // to inspect stacking at the overlap; restore it before another frame or input event.
      const inert = Array.from(document.querySelectorAll<HTMLElement>('[inert]'))
      try {
        inert.forEach(item => item.removeAttribute('inert'))
        return { overlaps: x < Math.min(side.right, composer.right) && y > Math.max(side.top, composer.top),
          readerOnTop: element.contains(document.elementFromPoint(x, y)) }
      } finally { inert.forEach(item => item.setAttribute('inert', '')) }
    })
    fs.writeFileSync(path.join(evidence, 'electron-drawer-paint.json'), JSON.stringify(paint, null, 2))
    expect(paint.overlaps).toBe(true)
    expect(paint.readerOnTop).toBe(true)
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await expect(team).toBeFocused()
    await expect(page.getByRole('textbox')).toBeVisible()
  } finally { await app.close() }
})
