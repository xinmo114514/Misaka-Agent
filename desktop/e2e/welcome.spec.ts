import { expect, test, type Locator } from '@playwright/test'

test.setTimeout(60000)

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/conversation.html')
  await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
  await page.evaluate(() => (window as any).conversationFixture.reset())
})

async function expectForegroundOverlap(foreground: Locator, background: Locator) {
  const front = (await foreground.boundingBox())!
  const back = (await background.boundingBox())!
  const left = Math.max(front.x, back.x)
  const top = Math.max(front.y, back.y)
  const right = Math.min(front.x + front.width, back.x + back.width)
  const bottom = Math.min(front.y + front.height, back.y + back.height)
  expect(right - left, 'the controls actually overlap horizontally').toBeGreaterThan(0)
  expect(bottom - top, 'the controls actually overlap vertically').toBeGreaterThan(0)
  const point = { x: (left + right) / 2, y: (top + bottom) / 2 }
  await expect.poll(() => foreground.evaluate((element, point) =>
    element.contains(document.elementFromPoint(point.x, point.y)), point),
  { message: 'the open menu receives pointer input in the overlapping area' }).toBe(true)
}

for (const theme of ['light', 'dark']) {
  test(`${theme} welcome menus stay above the controls they overlap`, async ({ page }, info) => {
    await page.evaluate(id => (window as any).conversationFixture.theme(id), theme)
    await expect(page.locator('html')).not.toHaveClass(/theme-switching/)
    const workspace = page.getByTitle('点击快速切换工作区或打开新目录')
    const modeTrigger = page.getByTitle('点击切换 Agent 模式')
    const modeMenu = page.locator('.conversation-permission-popover')

    await modeTrigger.click()
    await expect(modeMenu).toBeVisible()
    await expectForegroundOverlap(modeMenu, workspace)
    await page.screenshot({ path: info.outputPath('welcome-mode-menu.png') })
    await page.keyboard.press('Escape')
    await expect(modeMenu).not.toBeVisible()
    await expect(modeTrigger).toBeFocused()

    await workspace.click()
    const workspaceMenu = page.locator('.conversation-welcome-workspace .misaka-glass-popover')
    await expect(workspaceMenu).toBeVisible()
    await expectForegroundOverlap(workspaceMenu, page.getByRole('textbox', { name: '给 Misaka 发送任务' }))
    await workspace.click()
    await expect(workspaceMenu).not.toBeVisible()
  })
}

test('welcome card becomes the bottom composer after the first message without replacing the input', async ({ page }) => {
  const heading = page.getByRole('heading', { name: '欢迎使用 Misaka-Agent' })
  const input = page.getByRole('textbox', { name: '给 Misaka 发送任务' })
  await expect(heading).toBeVisible()
  await expect(page.locator('.conversation-welcome-card').getByRole('button', { name: /research/ })).toBeVisible()
  const titleBox = await heading.boundingBox()
  const cardBox = await page.locator('.conversation-welcome-card').boundingBox()
  expect(cardBox!.width).toBeCloseTo(672, 0)
  expect(cardBox!.y - (titleBox!.y + titleBox!.height)).toBeGreaterThan(24)
  await input.fill('你好，Misaka')
  await input.evaluate(element => { (window as any).originalWelcomeInput = element })
  await input.press('Enter')
  await expect(heading).toHaveCount(0)
  await expect(page.getByText('你好，Misaka', { exact: true })).toBeVisible()
  expect(await input.evaluate(element => element === (window as any).originalWelcomeInput)).toBe(true)
  await expect(input).toBeFocused()
  const dock = await page.locator('.conversation-composer-dock').boundingBox()
  expect(dock!.y).toBeGreaterThan(650)
  await page.evaluate(() => (window as any).conversationFixture.reset())
  await expect(heading).toBeVisible()
})

test('welcome supports themes, workspace menu, controls, and narrow windows', async ({ page }) => {
  await expect(page.getByRole('heading', { name: '欢迎使用 Misaka-Agent' })).toBeVisible()
  await page.locator('.conversation-welcome-card').getByRole('button', { name: /research/ }).click()
  await expect(page.getByText('当前工作区', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('textbox').click()
  await page.getByTitle('点击切换 Agent 模式').click()
  await expect(page.getByText('选择 Agent 模式')).toBeVisible()
  await page.getByRole('textbox').click({ position: { x: 500, y: 10 } })
  await page.getByTitle('模型与思考深度').click()
  await expect(page.getByRole('slider', { name: '思考深度' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  await page.screenshot({ path: 'test-results/welcome-light.png' })
  await page.evaluate(() => (window as any).conversationFixture.theme('dark'))
  await page.screenshot({ path: 'test-results/welcome-dark.png' })
  await page.setViewportSize({ width: 760, height: 600 })
  const input = page.getByRole('textbox')
  await input.fill('多行任务\n'.repeat(12))
  await expect(page.getByRole('button', { name: '发送指令 (Enter)' })).toBeVisible()
  const card = page.locator('.conversation-welcome-card')
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: 'test-results/welcome-narrow.png' })
})

test('empty loading sessions hide the greeting and keep submission disabled', async ({ page }) => {
  await page.evaluate(() => (window as any).conversationFixture.setLoading(true))
  await expect(page.getByRole('heading', { name: '欢迎使用 Misaka-Agent' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '会话加载中' })).toBeDisabled()
  await page.evaluate(() => (window as any).conversationFixture.setLoading(false))
  await expect(page.getByRole('heading', { name: '欢迎使用 Misaka-Agent' })).toBeVisible()
})

test('permission menu stays inside a low-height welcome viewport', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 600 })
  await page.getByTitle('点击切换 Agent 模式').click()
  const menu = page.getByText('选择 Agent 模式').locator('..')
  const box = await menu.boundingBox()
  const viewport = await page.locator('[data-conversation-viewport]').boundingBox()
  expect(box!.y).toBeGreaterThanOrEqual(viewport!.y)
  await page.getByRole('button', { name: /^完全放行/ }).click()
  await expect(page.getByTitle('点击切换 Agent 模式')).toContainText('完全放行')
})
