import { _electron as electron, expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { multiFixtureInit } from './multiFixture.cjs'
import { paneDetailsFixtureInit } from './paneDetailsFixture.cjs'
import { adaptiveMosaicFixtureInit } from './adaptiveMosaicFixture.cjs'

test('installed Electron keeps seven mosaic readers clear and expands the same pane across the full window', async () => {
  const evidence = path.resolve(process.cwd(), process.env.MISAKA_VISUAL_EVIDENCE || 'test-results/multi-native')
  fs.mkdirSync(evidence, { recursive: true })
  const profile = fs.mkdtempSync(path.join(evidence, 'electron-multi-profile-'))
  const main = path.join(profile, 'main.cjs')
  fs.writeFileSync(main, `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', process.env.MISAKA_MULTI_PROFILE);
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, width: 1440, height: 1000,
    webPreferences: { contextIsolation: true, nodeIntegration: false } });
  window.loadURL(process.env.MISAKA_MULTI_URL);
});
app.on('window-all-closed', () => app.quit());
`)
  const env = { ...process.env, MISAKA_MULTI_PROFILE: path.join(profile, 'user-data'),
    MISAKA_MULTI_URL: `http://127.0.0.1:${process.env.MISAKA_E2E_PORT || '4174'}/e2e/conversation.html` }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [main], env })
  try {
    const page = await app.firstWindow()
    await page.addInitScript({ content: `(${multiFixtureInit.toString()})({memberCount:6});(${adaptiveMosaicFixtureInit.toString()})({memberCount:6});(${paneDetailsFixtureInit.toString()})({retainMessages:true});` })
    await page.reload()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
    await page.evaluate(() => {
      const f = (window as any).conversationFixture
      f.reset(); f.theme('dark'); f.research.stopHold(); f.research.openRun()
    })
    await page.getByRole('group', { name: '研究视图', exact: true }).getByRole('button', { name: '多窗', exact: true }).click()
    await expect(page.locator('.research-agent-pane')).toHaveCount(7)
    expect(await page.evaluate(() => (window as any).adaptiveMosaicFixture.commands().filter((command: any) => command.type === 'watch_research_sessions').every((command: any) => command.visibleExecutorIds.length <= 7))).toBe(true)
    const toolbar = page.locator('[data-research-workspace-toolbar]')
    expect((await toolbar.boundingBox())!.height).toBe(52)
    const input = page.getByRole('textbox')
    await input.fill('保留 Electron 多窗草稿')
    const layout = (await page.locator('[data-research-multi-layout]').boundingBox())!
    const composer = (await page.locator('.conversation-composer').boundingBox())!
    expect(layout.y + layout.height).toBeLessThanOrEqual(composer.y - 8)
    const paneId = await page.locator('.research-agent-pane').first().getAttribute('data-testid')
    const pane = page.getByTestId(paneId!)
    await pane.evaluate(el => { (window as any).multiNativePane = el })
    const entry = pane.getByRole('button', { name: '展开会话', exact: true })
    await entry.click()
    const dialog = page.getByRole('dialog', { name: /展开.*会话/ })
    await expect(dialog).toBeVisible()
    expect(await pane.evaluate(el => el === (window as any).multiNativePane)).toBe(true)
    const bounds = (await dialog.boundingBox())!
    expect(bounds.x).toBe(0); expect(bounds.y).toBe(0)
    expect(bounds.width).toBe(1440); expect(bounds.height).toBe(1000)
    expect((await pane.boundingBox())!.height).toBeGreaterThan(800)
    await expect(dialog).toContainText('比较检索增强生成与长上下文两条证据路线')
    const detailsEntry = pane.locator('.research-pane-footer').getByRole('button', { name: /详情/ })
    await expect(pane.locator('.research-pane-footer')).toHaveText(/上下文 12\.5%详情/)
    await detailsEntry.click()
    const details = page.getByRole('dialog', { name: /会话详情/ })
    await expect(details).toContainText('research-controller-very-long-model-name-reasoning-edition-2026')
    expect(await details.evaluate(el => el.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(details).toHaveCount(0)
    await expect(detailsEntry).toBeFocused()
    await expect(dialog).toBeVisible()
    const message = pane.locator('.research-message').filter({ hasText: 'ROOT_BEGIN' })
    await message.getByRole('button', { name: /plan_research/ }).click()
    for (const marker of ['ROOT_ARGUMENTS', 'ROOT_PARTIAL', 'ROOT_RESULT', 'ROOT_DETAILS', 'ROOT_ERROR', 'ROOT_ASSISTANT_ERROR']) await expect(message).toContainText(marker)
    const ordered = await message.innerText()
    expect(ordered.indexOf('ROOT_BEGIN')).toBeLessThan(ordered.indexOf('plan_research'))
    expect(ordered.indexOf('plan_research')).toBeLessThan(ordered.indexOf('ROOT_AFTER'))
    expect(ordered).not.toContain('sk-fixture-123456789012345678901234567890')
    await page.screenshot({ path: path.join(evidence, 'electron-multi-expanded.png') })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(entry).toBeFocused()
    await expect(input).toHaveValue('保留 Electron 多窗草稿')
    expect(await page.evaluate(() => (window as any).conversationFixture.research.state().commands.filter((item: any) => item.type === 'stop_research').length)).toBe(0)
    await page.screenshot({ path: path.join(evidence, 'electron-multi-seven-panes.png') })
    // The shared input stays one native DOM node while its multi-only presentation adapts.
    await expect(page.locator('.conversation-composer')).toHaveAttribute('data-composer-presentation', 'multi')
    const composerBounds = (await page.locator('.conversation-composer').boundingBox())!
    expect(composerBounds.width).toBeLessThanOrEqual(1120)
    await expect(page.locator('.conversation-composer-dock')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await input.fill('保留原生多窗编辑节点、草稿和选择区域。'.repeat(10))
    await input.evaluate(el => { (window as any).nativeComposerInput = el; (el as HTMLTextAreaElement).setSelectionRange(3, 9) })
    for (const width of [1440, 1280, 960, 900]) {
      await page.setViewportSize({ width, height: 1000 })
      expect((await input.boundingBox())!.height).toBeLessThanOrEqual(88)
      expect(await input.evaluate(el => el === (window as any).nativeComposerInput)).toBe(true)
      expect(await page.locator('.conversation-composer').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      const dockBounds = (await page.locator('.conversation-composer-dock').boundingBox())!
      const tilesBounds = (await page.locator('[data-research-multi-layout]').boundingBox())!
      expect(tilesBounds.y + tilesBounds.height).toBeLessThanOrEqual(dockBounds.y + 1)
    }
    await page.getByRole('button', { name: '专注', exact: true }).click()
    await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThan(88)
    await page.getByRole('button', { name: '多窗', exact: true }).click()
    await expect.poll(async () => (await input.boundingBox())!.height).toBe(88)
    expect(await input.evaluate(el => el === (window as any).nativeComposerInput)).toBe(true)
    await expect(input).toHaveValue('保留原生多窗编辑节点、草稿和选择区域。'.repeat(10))
    await page.screenshot({ path: path.join(evidence, 'electron-multi-composer-narrow.png') })
    const versions = await app.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome }))
    fs.writeFileSync(path.join(evidence, 'electron-multi-versions.json'), JSON.stringify(versions, null, 2))
  } finally { await app.close() }
})
