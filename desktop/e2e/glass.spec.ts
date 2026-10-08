import { expect, test } from '@playwright/test'

const themes = [
  { id: 'light', mode: 'light', family: '经典默认' },
  { id: 'codex-light', mode: 'light', family: '天空' },
  { id: 'claude-light', mode: 'light', family: '羊皮纸' },
  { id: 'forest-light', mode: 'light', family: '森林绿' },
  { id: 'dark', mode: 'dark', family: '经典默认' },
  { id: 'codex-dark', mode: 'dark', family: '天空' },
  { id: 'claude-dark', mode: 'dark', family: '羊皮纸' },
  { id: 'forest-dark', mode: 'dark', family: '森林绿' },
]

for (const theme of themes) {
  test(`${theme.id} paints three glass tiers while keeping reading and graph surfaces clear`, async ({ page }, info) => {
    await page.goto('/e2e/conversation.html')
    const input = page.getByRole('textbox', { name: '给 Misaka 发送任务' })
    await expect(input).toBeVisible()
    await page.evaluate(id => (window as any).conversationFixture.theme(id), theme.id)
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', theme.mode)
    if (theme.mode === 'light') {
      await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
      await expect(page.locator('#root > div')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
      await expect(page.locator('.misaka-atmosphere')).toHaveCSS('display', 'none')
    }
    await expect(page.locator('header')).toHaveCSS('backdrop-filter', 'blur(16px)')
    await expect(page.locator('aside').first()).toHaveCSS('backdrop-filter', 'blur(16px)')
    const composer = page.locator('.conversation-composer')
    await expect(composer).toHaveCSS('backdrop-filter', 'blur(20px)')
    expect(await composer.evaluate(el => getComputedStyle(el).getPropertyValue('--glass-opacity').trim()))
      .toBe(theme.mode === 'light' ? '88%' : '82%')
    expect(await composer.evaluate(el => getComputedStyle(el, '::before').pointerEvents)).toBe('none')
    await input.fill('玻璃材质与主题柔光验收')
    await page.getByTitle('模型与思考深度').click()
    const picker = page.getByRole('dialog', { name: '模型与思考深度', exact: true })
    await expect(picker).toHaveCSS('backdrop-filter', 'blur(24px)')
    expect(await picker.evaluate(el => el.parentElement === document.body)).toBe(true)
    const bounds = (await picker.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    await page.screenshot({ path: info.outputPath('glass-composer-and-picker.png') })
    await page.keyboard.press('Escape')
    await expect(picker).not.toBeVisible()
    await expect(page.getByTitle('模型与思考深度')).toBeFocused()

    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '外观与主题' }).click()
    const family = page.getByRole('button', { name: theme.family, exact: true })
    await family.click()
    await expect(family).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('aside').nth(1)).toHaveCSS('backdrop-filter', 'blur(16px)')
    const settingsCard = page.getByRole('heading', { name: '界面主题与视觉个性化' }).locator('..')
    await expect(settingsCard).toHaveCSS('backdrop-filter', 'blur(20px)')
    await page.screenshot({ path: info.outputPath('glass-settings.png') })
    await page.getByRole('button', { name: '返回时间线', exact: true }).click()

    await page.evaluate(() => (window as any).conversationFixture.graph())
    await page.getByText('视图', { exact: true }).click()
    await expect(page.locator('.react-flow__node')).toHaveCount(2)
    await expect(page.locator('.react-flow')).toHaveCSS('backdrop-filter', 'none')
    await expect(page.locator('.react-flow__node').first()).toHaveCSS('backdrop-filter', 'none')
    if (theme.mode === 'light') {
      await expect(page.locator('.react-flow')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    }
    await page.locator('.react-flow__node').first().click()
    const drawer = page.locator('.misaka-glass-panel').filter({ has: page.getByRole('heading', { name: '根节点配色', level: 3 }) })
    await expect(drawer).toHaveCSS('backdrop-filter', 'blur(20px)')
    await page.screenshot({ path: info.outputPath('glass-graph-and-drawer.png') })
  })
}

test('glass fallback stays opaque when backdrop enhancements are not applied', async ({ page }) => {
  await page.goto('/e2e/conversation.html')
  await expect(page.getByRole('textbox')).toBeVisible()
  // Remove only the support-gated enhancement, simulating a browser without blur.
  await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      for (let index = sheet.cssRules.length - 1; index >= 0; index--) {
        const rule = sheet.cssRules[index]
        if (rule instanceof CSSSupportsRule && rule.conditionText.includes('backdrop-filter')) sheet.deleteRule(index)
      }
    }
  })
  await expect(page.locator('header')).toHaveCSS('backdrop-filter', 'none')
  await expect(page.locator('.conversation-composer')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(page.locator('.conversation-composer')).not.toHaveCSS('background-image', 'none')
})

test('glass interactions respect reduced motion and preserve scrolling and keyboard controls', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/e2e/conversation.html')
  const input = page.getByRole('textbox')
  await expect(input).toBeVisible()
  await input.fill('柔光交互验收')
  const send = page.getByRole('button', { name: '发送指令 (Enter)', exact: true })
  await expect(send).toHaveCSS('transition-duration', /^0\.18s(?:,\s*0\.18s)*$/)
  const restingShadow = await send.evaluate(el => getComputedStyle(el).boxShadow)
  await send.hover()
  await expect.poll(() => send.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe(restingShadow)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(send).toHaveCSS('transition-duration', '0s')
  await page.getByTitle('点击切换 Agent 模式').click()
  await expect(page.locator('.conversation-permission-popover')).toHaveCSS('backdrop-filter', 'blur(24px)')
  const inputBounds = (await input.boundingBox())!
  await input.click({ position: { x: inputBounds.width - 12, y: 10 } })
  await expect(page.locator('.conversation-permission-popover')).not.toBeVisible()
  await page.evaluate(() => (window as any).conversationFixture.permission())
  const modal = page.locator('.misaka-glass-popover').filter({ has: page.getByRole('heading', { name: '操作审批请求' }) })
  await expect(modal).toHaveCSS('backdrop-filter', 'blur(24px)')
  await expect(modal.getByRole('button', { name: /拒绝/ })).toBeVisible()
  await modal.getByRole('button', { name: /拒绝/ }).click()
  await expect(modal).not.toBeVisible()
  await page.evaluate(() => (window as any).conversationFixture.seedHistory(80))
  const scroll = page.locator('.conversation-scroll')
  await scroll.evaluate(el => { el.scrollTop = 0 })
  await scroll.hover()
  await page.mouse.wheel(0, 600)
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(100)
})

test('sidebar rename remains a viewport modal outside the glass containing block', async ({ page }) => {
  await page.goto('/e2e/conversation.html')
  await expect(page.getByRole('textbox')).toBeVisible()
  await page.evaluate(() => (window as any).conversationFixture.navigation.register('glass-rename.jsonl', 1))
  const row = page.locator('[data-session-path="glass-rename.jsonl"]').first()
  await row.hover()
  await row.getByRole('button', { name: /^重命名会话/ }).click()
  const dialog = page.getByRole('dialog', { name: '重命名会话', exact: true })
  await expect(dialog).toBeVisible()
  expect(await dialog.locator('..').boundingBox()).toEqual({ x: 0, y: 0, width: 1280, height: 900 })
  expect(await dialog.evaluate(el => el.parentElement?.parentElement === document.body)).toBe(true)
  await dialog.getByRole('textbox').press('Escape')
  await expect(dialog).not.toBeVisible()
})

test('workspace session menu stays above the scrolling conversation', async ({ page }) => {
  await page.goto('/e2e/conversation.html')
  await expect(page.getByRole('textbox')).toBeVisible()
  await page.evaluate(() => (window as any).conversationFixture.loadHistory([
    { id: 'glass-layer-message', role: 'assistant', timestamp: 1000, content: '正文与菜单层级验证。'.repeat(400) },
  ]))
  await page.getByTitle('更多会话选项').click()
  const rename = page.getByRole('button', { name: '重命名会话', exact: true })
  await expect.poll(() => rename.evaluate(el => {
    const rect = el.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return hit === el || (hit !== null && el.contains(hit))
  })).toBe(true)
  await rename.click()
  const dialog = page.getByRole('dialog', { name: '重命名会话', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox').press('Escape')
  await page.evaluate(() => (window as any).conversationFixture.graph())
  await page.getByText('视图', { exact: true }).click()
  await page.locator('.react-flow__node').first().click()
  await expect(page.getByRole('heading', { name: '根节点配色', level: 3 })).toBeVisible()
  await page.getByTitle('更多会话选项').click()
  await expect.poll(() => rename.evaluate(el => {
    const rect = el.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return hit === el || (hit !== null && el.contains(hit))
  })).toBe(true)
  await rename.click()
  await expect(dialog).toBeVisible()
})

test('selected theme card keeps a visible keyboard focus indicator alongside its glow', async ({ page }) => {
  await page.goto('/e2e/conversation.html')
  await expect(page.getByRole('textbox')).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '外观与主题' }).click()
  const card = page.getByRole('button', { name: '经典默认', exact: true })
  await card.click()
  await card.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(card).toBeFocused()
  await expect(card).toHaveCSS('outline-style', 'solid')
  await expect(card).toHaveCSS('outline-width', '2px')
  await expect(card).toHaveCSS('outline-color', 'rgb(177, 42, 85)')
})
