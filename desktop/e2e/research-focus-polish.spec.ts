import { expect, test, type Locator, type Page } from '@playwright/test'

const evidence = process.env.MISAKA_VISUAL_EVIDENCE || '../.superpowers/sdd/focus-ui-refinement-2026-10-20/screenshots'
test.setTimeout(90000)

async function openResearch(page: Page, question?: string) {
  await page.goto('/e2e/conversation.html')
  await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
  await page.evaluate(question => {
    const fixture = (window as any).conversationFixture
    fixture.reset()
    fixture.research.stopHold()
    fixture.research.openRun('r_desktop_fixture', question)
  }, question)
  await expect(page.locator('[data-research-focus-view]')).toBeVisible()
}

async function openMore(page: Page) {
  await page.getByRole('button', { name: '更多研究选项', exact: true }).click()
  return page.getByRole('dialog', { name: '研究更多选项' })
}

async function textContrast(locator: Locator) {
  return locator.evaluate(element => {
    // Resolve real themed CSS colors (including color-mix) through the browser's painter.
    const context = new OffscreenCanvas(1, 1).getContext('2d')!
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, 1, 1)
    const ancestors: Element[] = []
    for (let current: Element | null = element; current; current = current.parentElement) ancestors.unshift(current)
    for (const ancestor of ancestors) {
      context.fillStyle = getComputedStyle(ancestor).backgroundColor
      context.fillRect(0, 0, 1, 1)
    }
    const background = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
    context.fillStyle = getComputedStyle(element).color
    context.fillRect(0, 0, 1, 1)
    const foreground = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
    const luminance = (rgb: number[]) => rgb.map(channel => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
    const a = luminance(foreground)
    const b = luminance(background)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  })
}

test('focus has one quiet toolbar and keeps secondary controls behind More', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 })
  await openResearch(page)
  const toolbar = page.locator('[data-research-focus-toolbar]')
  await expect(toolbar).toHaveCount(1)
  await expect(toolbar).toBeVisible()
  await expect(page.locator('[data-workspace-header]')).toHaveCount(0)
  await expect(page.locator('.research-focus-bar')).toHaveCount(0)
  await expect(toolbar.getByRole('button', { name: /研究团队/ })).toHaveCount(1)
  await expect(toolbar.getByRole('button', { name: '停止研究', exact: true })).toHaveCount(1)
  await expect(toolbar.getByRole('button', { name: '恢复研究', exact: true })).toHaveCount(0)
  await expect(toolbar.getByRole('button', { name: '研究过程', exact: true })).toHaveCount(0)
  await expect(toolbar.getByRole('button', { name: '多窗', exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: '更多会话选项', exact: true })).toHaveCount(0)
  const bounds = await toolbar.boundingBox()
  expect(bounds!.y).toBeCloseTo(38, 0)
  expect(bounds!.height).toBeGreaterThanOrEqual(50)
  expect(bounds!.height).toBeLessThanOrEqual(54)

  const menu = await openMore(page)
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('button', { name: /研究过程/ })).toBeVisible()
  await expect(menu.getByRole('button', { name: /切换多窗|切换专注/ })).toHaveCount(0)
  await expect(menu.getByRole('button', { name: /当前节点/ })).toBeVisible()
  await expect(menu.getByRole('button', { name: /研究图谱/ })).toBeVisible()
  await expect(menu.getByRole('button', { name: /切换工作区/ })).toBeVisible()
  await expect(menu.getByRole('button', { name: /模型与设置/ })).toBeVisible()
  await expect(menu.getByRole('button', { name: /重命名会话|分叉会话|导出为 JSONL|会话树|压缩会话/ })).toHaveCount(0)
  await menu.getByRole('button', { name: /研究过程/ }).click()
  const process = page.getByRole('region', { name: '研究运行过程' })
  await expect(process).toBeVisible()
  await expect(process.getByRole('button', { name: '查看任务 检索召回与引用可追溯性' })).toBeVisible()
  await expect(menu).toHaveCount(0)
})

test('stop confirmation does not grow the toolbar and Escape preserves the draft and run', async ({ page }) => {
  await openResearch(page)
  const input = page.getByRole('textbox')
  await input.fill('保留这段尚未发送的研究补充')
  const toolbar = page.locator('[data-research-focus-toolbar]')
  const before = await toolbar.boundingBox()
  const stop = toolbar.getByRole('button', { name: '停止研究', exact: true })
  await stop.click()
  const confirm = page.getByRole('button', { name: '确认停止', exact: true })
  await expect(confirm).toBeVisible()
  await expect(toolbar.getByRole('button', { name: '确认停止', exact: true })).toHaveCount(0)
  const after = await toolbar.boundingBox()
  expect(after!.height).toBe(before!.height)
  await page.screenshot({ path: `${evidence}/stop-confirmation.png` })
  await confirm.press('Escape')
  await expect(confirm).toHaveCount(0)
  await expect(stop).toBeFocused()
  await expect(input).toHaveValue('保留这段尚未发送的研究补充')
  expect(await page.evaluate(() => (window as any).conversationFixture.research.state().commands
    .filter((command: any) => command.type === 'stop_research').length)).toBe(0)
})

test('reading a finished member does not change the run status or the writer', async ({ page }) => {
  await openResearch(page)
  const toolbar = page.locator('[data-research-focus-toolbar]')
  await toolbar.getByRole('button', { name: /研究团队/ }).click()
  await page.getByRole('dialog', { name: '研究团队目录' }).getByTestId('research-team-member-s-retrieval').click()
  await expect(toolbar.getByRole('button', { name: /研究团队/ })).toContainText('检索召回与引用可追溯性')
  await expect(toolbar.locator('.research-status')).toHaveAttribute('title', 'active')
  await expect(page.locator('.research-focus-main').getByRole('note')).toContainText('子代理会话只读')
  const state = await page.evaluate(() => (window as any).conversationFixture.research.state())
  expect(state.binding).toMatchObject({ sessionId: 'research-root', runId: 'r_desktop_fixture', workspace: 'C:/research' })
  await page.getByRole('button', { name: '返回主控', exact: true }).click()
  await expect(page.locator('.research-focus-main')).toContainText('先把两条路线拆成可核验的比较维度')
})

test('focus and More remain legible in all eight shipped themes', async ({ page }) => {
  await openResearch(page)
  for (const theme of ['light', 'dark', 'codex-light', 'codex-dark', 'claude-light', 'claude-dark', 'forest-light', 'forest-dark']) {
    await page.evaluate(theme => (window as any).conversationFixture.theme(theme), theme)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    const toolbar = page.locator('[data-research-focus-toolbar]')
    await expect(toolbar).toBeVisible()
    expect(await textContrast(toolbar.getByRole('heading'))).toBeGreaterThanOrEqual(4.5)
    expect(await textContrast(toolbar.getByRole('button', { name: /研究团队/ }))).toBeGreaterThanOrEqual(4.5)
    const menu = await openMore(page)
    await expect(menu).toBeVisible()
    expect(await textContrast(menu.getByRole('button', { name: /研究过程/ }))).toBeGreaterThanOrEqual(4.5)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `${evidence}/theme-${theme}-more.png` })
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  }
})

test('the toolbar fits long titles at supported sizes without squeezing away actions', async ({ page }) => {
  const title = '在跨学科研究中比较检索增强生成与超长上下文的证据组织、引用可追溯性、跨段整合与长期可靠性'.repeat(3)
  await openResearch(page, title)
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => (window as any).conversationFixture.theme(theme), theme)
    for (const width of [1440, 1280, 960, 900]) {
      await page.setViewportSize({ width, height: width >= 1440 ? 1000 : 860 })
      const toolbar = page.locator('[data-research-focus-toolbar]')
      await expect(toolbar).toBeVisible()
      await expect(toolbar.getByRole('button', { name: '更多研究选项', exact: true })).toBeInViewport()
      await expect(toolbar.getByRole('button', { name: '停止研究', exact: true })).toBeInViewport()
      expect(await toolbar.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: `${evidence}/focus-${theme}-${width}-long.png` })
      await page.getByRole('button', { name: '隐藏侧边栏', exact: true }).click()
      await expect(page.getByRole('button', { name: '展开侧边栏', exact: true })).toBeVisible()
      await expect(toolbar.getByRole('button', { name: '停止研究', exact: true })).toBeInViewport()
      expect(await toolbar.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: `${evidence}/focus-${theme}-${width}-sidebar-hidden.png` })
      await page.getByRole('button', { name: '展开侧边栏', exact: true }).click()
      await expect(page.getByRole('button', { name: '隐藏侧边栏', exact: true })).toBeVisible()
    }
  }
})

test('side reading shares the main composer alignment and becomes a keyboard-contained drawer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openResearch(page)
  await page.evaluate(() => (window as any).conversationFixture.theme('dark'))
  await page.screenshot({ path: `${evidence}/focus-dark-1440.png` })
  const input = page.getByRole('textbox')
  await input.fill('侧读时保留的主控草稿')
  const team = page.getByRole('button', { name: /研究团队/ })
  await team.click()
  await page.getByRole('dialog', { name: '研究团队目录' })
    .getByRole('button', { name: '在右侧查看 长上下文跨段整合' }).click()
  const side = page.locator('.research-side-panel')
  await expect(side).toBeVisible()
  const sideBounds = await side.boundingBox()
  expect(sideBounds!.width).toBeCloseTo(360, 0)
  const main = await page.locator('.research-focus-main').boundingBox()
  const composer = await page.locator('.conversation-composer').boundingBox()
  expect(Math.abs(composer!.x + composer!.width / 2 - main!.x - main!.width / 2)).toBeLessThan(2)
  expect(composer!.x + composer!.width).toBeLessThanOrEqual(main!.x + main!.width)
  expect(await side.locator('.conversation-composer-spacer').evaluateAll(elements => elements
    .reduce((sum, element) => sum + element.getBoundingClientRect().height, 0))).toBe(0)
  await page.screenshot({ path: `${evidence}/focus-dark-side-1440.png` })

  const menu = await openMore(page)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(side).toBeVisible()
  expect(await page.evaluate(() => (window as any).conversationFixture.research.state().commands
    .filter((command: any) => command.type === 'stop_research').length)).toBe(0)

  // Outer window is still >=1000px; the sidebar makes the actual research host narrower.
  await page.setViewportSize({ width: 1200, height: 850 })
  const drawer = page.getByRole('dialog', { name: '长上下文跨段整合 侧栏' })
  await expect(drawer).toBeVisible()
  await expect(drawer).toHaveAttribute('aria-modal', 'true')
  expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true)
  for (let index = 0; index < 7; index++) {
    await page.keyboard.press('Tab')
    expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true)
  }
  await page.screenshot({ path: `${evidence}/focus-dark-drawer-1200.png` })
  await page.setViewportSize({ width: 960, height: 820 })
  await expect(drawer).toBeVisible()
  expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true)
  await page.screenshot({ path: `${evidence}/focus-dark-drawer-960.png` })
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(team).toBeFocused()
  await expect(input).toHaveValue('侧读时保留的主控草稿')
  expect(await page.evaluate(() => (window as any).conversationFixture.research.state().commands
    .filter((command: any) => command.type === 'stop_research').length)).toBe(0)
})

test('keyboard navigation enters the team and returns to the actual root after a node change', async ({ page }) => {
  await openResearch(page)
  const team = page.getByRole('button', { name: /研究团队/ })
  await team.focus()
  await team.press('Enter')
  const directory = page.getByRole('dialog', { name: '研究团队目录' })
  await expect(directory).toBeVisible()
  expect(await directory.evaluate(element => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(team).toBeFocused()

  const menu = await openMore(page)
  await menu.getByRole('button', { name: /当前节点/ }).click()
  const nodeSelect = menu.getByLabel('当前研究节点')
  if (await nodeSelect.count()) await nodeSelect.selectOption('b_join')
  else await menu.getByRole('button', { name: /汇总两条证据路径/ }).click()
  if (await menu.isVisible()) await page.keyboard.press('Escape')
  await expect(page.locator('.research-focus-main').getByRole('note')).toContainText('子代理会话只读')
  await page.getByRole('button', { name: '返回主控', exact: true }).click()
  await expect(page.locator('.research-focus-main').getByRole('note')).toHaveCount(0)
  await expect(page.locator('.research-focus-main')).toContainText('先把两条路线拆成可核验的比较维度')
})

test('narrow chrome keeps unconfirmed resume refresh and its failure visible without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 860 })
  await openResearch(page)
  const separator = await page.getByRole('separator').first().boundingBox()
  await page.mouse.move(separator!.x + separator!.width / 2, separator!.y + 160)
  await page.mouse.down()
  await page.mouse.move(400, separator!.y + 160)
  await page.mouse.up()
  const toolbar = page.locator('[data-research-focus-toolbar]')
  await expect.poll(() => toolbar.evaluate(element => element.clientWidth)).toBeLessThan(600)
  await page.evaluate(() => {
    const research = (window as any).conversationFixture.research
    research.readError('模拟目录读取失败：保留现有研究并重试')
    research.unconfirmedResume()
  })
  const refresh = toolbar.getByRole('button', { name: '刷新', exact: true })
  await expect(refresh).toBeVisible()
  await refresh.click()
  const feedback = toolbar.getByRole('alert')
  await expect(feedback).toContainText('刷新失败')
  await expect(feedback).toHaveAttribute('title', /模拟目录读取失败/)
  await expect(toolbar.getByRole('button', { name: '更多研究选项', exact: true })).toBeInViewport()
  await expect(refresh).toBeInViewport()
  expect(await toolbar.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: `${evidence}/focus-narrow-refresh-failed.png` })
})

for (const layer of ['graph', 'model'] as const) {
  test(`resize keeps the current ${layer} above a background side reader until it closes`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openResearch(page)
    await page.getByRole('button', { name: /研究团队/ }).click()
    await page.getByRole('button', { name: '在右侧查看 长上下文跨段整合' }).click()
    if (layer === 'graph') {
      const menu = await openMore(page)
      await menu.getByRole('button', { name: '研究图谱', exact: true }).click()
    } else await page.getByRole('button', { name: '模型与思考深度' }).click()
    const foreground = page.getByRole('dialog', { name: layer === 'graph' ? '研究拓扑图' : '模型与思考深度' })
    await expect(foreground).toBeVisible()
    await page.setViewportSize({ width: 1200, height: 850 })
    await expect(foreground).toBeVisible()
    expect(await foreground.evaluate(element => !element.closest('[inert]'))).toBe(true)
    await expect(page.getByRole('dialog', { name: '长上下文跨段整合 侧栏' })).toHaveCount(0)
    await page.screenshot({ path: `${evidence}/foreground-${layer}-resize.png` })
    await page.keyboard.press('Escape')
    await expect(foreground).toHaveCount(0)
    const drawer = page.getByRole('dialog', { name: '长上下文跨段整合 侧栏' })
    await expect(drawer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).conversationFixture.research.state().commands
      .filter((command: any) => command.type === 'stop_research').length)).toBe(0)
  })
}
