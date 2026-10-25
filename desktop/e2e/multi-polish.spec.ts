import { expect, test, type Page } from '@playwright/test'
import { multiFixtureInit } from './multiFixture.cjs'

test.setTimeout(60000)

async function openMulti(page: Page, memberCount = 4, extra: Record<string, boolean> = {}) {
  await page.addInitScript(multiFixtureInit, { memberCount, ...extra })
  await page.goto('/e2e/conversation.html')
  await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
  await page.evaluate(() => {
    const fixture = (window as any).conversationFixture
    fixture.reset(); fixture.research.stopHold(); fixture.research.openRun()
  })
  const group = page.getByRole('group', { name: '研究视图', exact: true })
  if (await group.isVisible()) await group.getByRole('button', { name: '多窗', exact: true }).click()
  else {
    await page.getByRole('button', { name: '更多研究选项', exact: true }).click()
    await page.getByRole('button', { name: '切换多窗', exact: true }).click()
  }
  await expect(page.locator('.research-tiling-container')).toHaveAttribute('data-research-view-mode', 'multi')
}

test('both modes have one shared toolbar with a direct switch and no duplicate menu action', async ({ page }) => {
  await openMulti(page)
  const toolbar = page.locator('[data-research-workspace-toolbar]')
  await expect(toolbar).toHaveCount(1)
  await expect(page.locator('[data-workspace-header]')).toHaveCount(0)
  await expect(page.locator('.research-workspace-toolbar')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '研究运行概览' })).toHaveCount(0)
  expect((await toolbar.boundingBox())!.height).toBe(52)
  await toolbar.getByRole('button', { name: '更多研究选项', exact: true }).click()
  const menu = page.getByRole('dialog', { name: '研究更多选项', exact: true })
  await expect(menu.getByRole('button', { name: /切换多窗|切换专注/ })).toHaveCount(0)
  await menu.getByRole('button', { name: /研究过程/ }).click()
  await expect(page.getByRole('region', { name: '研究运行过程' })).toBeVisible()
  await page.keyboard.press('Escape')
  await toolbar.getByRole('button', { name: '专注', exact: true }).click()
  await expect(toolbar).toBeVisible()
  await expect(toolbar.getByRole('button', { name: '专注', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('textbox')).toHaveCount(1)
})

for (const memberCount of [0, 1, 2, 3, 4]) {
  test(`multi displays the controller and ${memberCount} actual members without filler cards`, async ({ page }) => {
    await openMulti(page, memberCount)
    await expect(page.locator('[data-research-multi-layout]')).toBeVisible()
    await expect(page.locator('.research-agent-pane')).toHaveCount(memberCount + 1)
    await expect(page.locator('.research-empty-pane')).toHaveCount(0)
    if (!memberCount) await expect(page.getByText('当前节点暂无成员会话', { exact: true })).toBeVisible()
    await expect(page.locator('.research-tiling-container')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    for (const pane of await page.locator('.research-agent-pane').all()) {
      await expect(pane).toHaveCSS('backdrop-filter', 'none')
      await expect(pane).toHaveCSS('background-image', 'none')
    }
  })
}

test('a missing coordinator leaves the actual task grid usable without a fabricated pane', async ({ page }) => {
  await openMulti(page, 3, { noController: true })
  await expect(page.locator('[data-research-multi-layout]')).toBeVisible()
  await expect(page.locator('.research-agent-pane')).toHaveCount(3)
  await expect(page.locator('.research-agent-pane--coordinator')).toHaveCount(0)
  await expect(page.locator('.research-empty-pane')).toHaveCount(0)
})

test('workspace breakpoints reserve the measured composer instead of obscuring pane footers', async ({ page }) => {
  await openMulti(page)
  for (const width of [1440, 1280, 960, 900]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const sidebar of [true, false]) {
      if (!sidebar) await page.getByRole('button', { name: '隐藏侧边栏', exact: true }).click()
      const host = (await page.locator('.research-tiling-container').boundingBox())!
      const layout = page.locator('[data-research-multi-layout]')
      await expect(layout).toBeVisible()
      const controller = page.locator('.research-agent-pane--coordinator')
      const firstMember = page.locator('.research-agent-pane:not(.research-agent-pane--coordinator)').first()
      await expect.poll(async () => {
        const root = (await controller.boundingBox())!, member = (await firstMember.boundingBox())!
        if (host.width >= 1100) return member.y === root.y && root.width / member.width > 1.9
        if (host.width >= 820) return member.y >= root.y + root.height + 11 && member.width / root.width < .51
        return member.y >= root.y + root.height + 11 && Math.abs(member.width - root.width) <= 1
      }).toBe(true)
      const bounds = (await layout.boundingBox())!
      const composer = (await page.locator('.conversation-composer').boundingBox())!
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(composer.y - 8)
      expect(composer.y - bounds.y - bounds.height, 'the in-flow composer must not reserve its height twice').toBeLessThanOrEqual(32)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      if (!sidebar) await page.getByRole('button', { name: '展开侧边栏', exact: true }).click()
    }
  }
})

test('full-window expanded reading closes before a research stop and returns focus', async ({ page }) => {
  await openMulti(page, 2)
  const input = page.getByRole('textbox')
  await input.fill('多窗切换和展开过程中保留这份草稿')
  const entry = page.getByRole('button', { name: '展开会话', exact: true }).first()
  await entry.click()
  const dialog = page.getByRole('dialog', { name: /展开.*会话/ })
  await expect(dialog).toBeVisible()
  expect((await dialog.boundingBox())!.width).toBeGreaterThan(1200)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(entry).toBeFocused()
  await expect(input).toHaveValue('多窗切换和展开过程中保留这份草稿')
  expect(await page.evaluate(() => (window as any).conversationFixture.research.state().commands.filter((item: any) => item.type === 'stop_research').length)).toBe(0)
})

test('opened disclosures leave 120px of reading space and keep each pane independent', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 740 })
  await openMulti(page)
  const task = page.locator('.research-agent-pane:not(.research-agent-pane--coordinator)').first()
  await task.locator('.research-card-contract > summary').click()
  await expect(task.locator('.research-card-contract')).toHaveAttribute('open', '')
  const readingHeight = (await task.locator('.research-pane-body').boundingBox())!.height
  const detailsEntry = task.locator('.research-pane-footer').getByRole('button', { name: /详情/ })
  await detailsEntry.click()
  const details = page.getByRole('dialog', { name: /会话详情/ })
  await expect(details).toBeVisible()
  await expect(detailsEntry).toHaveAttribute('aria-expanded', 'true')
  await expect(details).toContainText('上下文窗口')
  expect(readingHeight).toBeGreaterThanOrEqual(120)
  expect((await task.locator('.research-pane-body').boundingBox())!.height).toBe(readingHeight)
  const pane = (await task.boundingBox())!
  const footer = (await task.locator('.research-pane-footer').boundingBox())!
  expect(footer.y + footer.height).toBeLessThanOrEqual(pane.y + pane.height + 1)
  await expect(page.locator('.research-agent-pane').last().locator('.research-telemetry-entry')).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)
  await expect(detailsEntry).toBeFocused()
  await page.evaluate(() => document.documentElement.style.setProperty('--font-size-base', '14px'))
  await expect(task.locator('.conversation-markdown').first()).toHaveCSS('font-size', '14px')
})

test('multi pane errors and ordinary captions retain readable contrast in all eight themes', async ({ page }) => {
  await openMulti(page)
  const contrast = async (selector: string) => page.locator(selector).first().evaluate(element => {
    const context = new OffscreenCanvas(1, 1).getContext('2d')!
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, 1, 1)
    const ancestors: Element[] = []
    for (let current: Element | null = element; current; current = current.parentElement) ancestors.unshift(current)
    for (const ancestor of ancestors) { context.fillStyle = getComputedStyle(ancestor).backgroundColor; context.fillRect(0, 0, 1, 1) }
    const bg = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
    context.fillStyle = getComputedStyle(element).color; context.fillRect(0, 0, 1, 1)
    const fg = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
    const lum = (rgb: number[]) => rgb.map(c => c / 255).reduce((sum, v, i) => sum + (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i], 0)
    return (Math.max(lum(bg), lum(fg)) + .05) / (Math.min(lum(bg), lum(fg)) + .05)
  })
  const failures: string[] = []
  for (const theme of ['dark', 'light', 'codex-dark', 'codex-light', 'claude-dark', 'claude-light', 'forest-dark', 'forest-light']) {
    await page.evaluate(theme => (window as any).conversationFixture.theme(theme), theme)
    await expect(page.locator('html')).not.toHaveClass(/theme-switching/)
    for (const selector of ['.research-session-error pre', '.research-session-error button', '.research-card-contract summary', '.research-tool-heading', '.research-pane-title strong', '.research-context-label', '.research-telemetry-entry']) {
      await expect(page.locator(selector).first()).toBeVisible()
      const ratio = await contrast(selector)
      if (ratio < 4.5) failures.push(`${theme} ${selector}: ${ratio}`)
    }
  }
  expect(failures).toEqual([])
})

test('switching and portal expansion preserve the unique composer draft and independent multi reading state', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openMulti(page, 4, { longHistory: true })
  const input = page.getByRole('textbox')
  await input.fill('原有主控草稿，往返模式仍保留')
  await input.evaluate(el => { (window as any).multiReadingComposer = el })
  const paneId = await page.locator('.research-agent-pane--coordinator').getAttribute('data-testid')
  const pane = page.getByTestId(paneId!)
  const body = pane.locator('.research-pane-body')
  await expect.poll(() => body.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(500)
  const tool = pane.locator('.research-tool-heading').first()
  await tool.click()
  await expect(tool).toHaveAttribute('aria-expanded', 'true')
  await body.evaluate(el => { el.scrollTop = 250; el.dispatchEvent(new Event('scroll', { bubbles: true })) })
  const reading = await body.evaluate(el => el.scrollTop)
  await pane.getByRole('button', { name: '展开会话', exact: true }).click()
  await expect(page.getByRole('dialog', { name: /展开.*会话/ })).toBeVisible()
  expect(await body.evaluate(el => el.scrollTop)).toBeCloseTo(reading, 0)
  await page.keyboard.press('Escape')
  expect(await body.evaluate(el => el.scrollTop)).toBeCloseTo(reading, 0)
  const group = page.getByRole('group', { name: '研究视图', exact: true })
  await group.getByRole('button', { name: '专注', exact: true }).click()
  await expect(page.locator('[data-research-focus-view]')).toBeVisible()
  await group.getByRole('button', { name: '多窗', exact: true }).click()
  await expect(pane).toBeVisible()
  await expect(tool).toHaveAttribute('aria-expanded', 'true')
  expect(await body.evaluate(el => el.scrollTop)).toBeCloseTo(reading, 0)
  await expect(input).toHaveValue('原有主控草稿，往返模式仍保留')
  expect(await input.evaluate(el => el === (window as any).multiReadingComposer)).toBe(true)
  await expect(page.getByRole('textbox')).toHaveCount(1)
})
