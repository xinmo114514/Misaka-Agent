import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import { multiFixtureInit } from './multiFixture.cjs'
import { paneDetailsFixtureInit } from './paneDetailsFixture.cjs'

test.setTimeout(90000)

async function openDetailsRun(page: Page, options: Record<string, boolean> = {}) {
  await page.addInitScript({ content: `(${multiFixtureInit.toString()})({memberCount:4});(${paneDetailsFixtureInit.toString()})(${JSON.stringify(options)});` })
  await page.goto('/e2e/conversation.html')
  await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
  await page.evaluate(() => { const f = (window as any).conversationFixture; f.reset(); f.research.stopHold(); f.research.openRun() })
  await page.getByRole('group', { name: '研究视图', exact: true }).getByRole('button', { name: '多窗', exact: true }).click()
  await expect(page.locator('.research-agent-pane')).toHaveCount(5)
  await expect(page.locator('.research-agent-pane--coordinator')).toContainText('ROOT_BEGIN')
}

test('footers show only observed context percentage and a detached complete details panel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openDetailsRun(page)
  const pane = page.locator('.research-agent-pane--coordinator')
  const body = pane.locator('.research-pane-body')
  const footer = pane.locator('.research-pane-footer')
  const before = (await body.boundingBox())!
  const visible = await footer.innerText()
  expect(visible).toContain('上下文 12.5%')
  expect(visible).not.toMatch(/research-controller|16,000|128,000|fixture-provider/)
  const button = footer.getByRole('button', { name: /详情/ })
  await button.click()
  const dialog = page.getByRole('dialog', { name: /会话详情/ })
  await expect(dialog).toBeVisible()
  expect(await dialog.evaluate(el => el.parentElement === document.body)).toBe(true)
  await expect(dialog).toContainText('research-controller-very-long-model-name-reasoning-edition-2026')
  await expect(dialog).toContainText('16,000')
  await expect(dialog).toContainText('128,000')
  expect((await body.boundingBox())!.height).toBe(before.height)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(button).toBeFocused()
})

test('expanded reading hands focus to details and closes it before collapsing or stopping', async ({ page }) => {
  await openDetailsRun(page)
  const paneId = await page.locator('.research-agent-pane--coordinator').getAttribute('data-testid')
  const pane = page.getByTestId(paneId!)
  await pane.getByRole('button', { name: '展开会话', exact: true }).click()
  const expanded = page.getByRole('dialog', { name: /展开.*会话/ })
  await expect(expanded).toBeVisible()
  const button = pane.locator('.research-pane-footer').getByRole('button', { name: /详情/ })
  await button.click()
  const details = page.getByRole('dialog', { name: /会话详情/ })
  await expect(details).toBeVisible()
  expect(await details.evaluate(el => el.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)
  await expect(expanded).toBeVisible()
  await expect(button).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(expanded).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).conversationFixture.research.state().commands.filter((item: any) => item.type === 'stop_research').length)).toBe(0)
})

test('an asynchronous approval takes precedence over existing expanded-reader metadata', async ({ page }) => {
  await openDetailsRun(page)
  const pane = page.locator('.research-agent-pane--coordinator')
  await pane.getByRole('button', { name: '展开会话', exact: true }).click()
  const expanded = page.getByRole('dialog', { name: /展开.*会话/ })
  await pane.locator('.research-telemetry-entry').click()
  const details = page.getByRole('dialog', { name: /会话详情/ })
  await expect(details).toBeVisible()
  await page.evaluate(() => (window as any).conversationFixture.permission())
  await expect(page.getByRole('heading', { name: '操作审批请求', exact: true })).toBeVisible()
  await expect(details).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: '操作审批请求', exact: true })).toBeVisible()
  await expect(expanded).toBeVisible()
  await page.getByRole('button', { name: '本次允许', exact: true }).click()
  await expect(page.getByRole('heading', { name: '操作审批请求', exact: true })).toHaveCount(0)
  await expect(details).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(expanded).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).conversationFixture.research.state().commands.filter((item: any) => item.type === 'stop_research').length)).toBe(0)
})

test('controller keeps canonical explanation and tool order and exposes every tool field', async ({ page }) => {
  await openDetailsRun(page)
  const pane = page.locator('.research-agent-pane--coordinator')
  await pane.getByRole('button', { name: /plan_research/ }).click()
  for (const marker of ['ROOT_ARGUMENTS', 'ROOT_PARTIAL', 'ROOT_RESULT', 'ROOT_DETAILS', 'ROOT_ERROR', 'ROOT_ASSISTANT_ERROR']) await expect(pane).toContainText(marker)
  const text = await pane.innerText()
  expect(text.indexOf('ROOT_BEGIN')).toBeLessThan(text.indexOf('plan_research'))
  expect(text.indexOf('plan_research')).toBeLessThan(text.indexOf('ROOT_AFTER'))
  expect(text).not.toContain('sk-fixture-123456789012345678901234567890')
  await expect(pane).toContainText(/未完成|未完整|不完整报告|部分报告|部分完成/)
})

test('long report retry retains its preview and completes Unicode pages without duplication', async ({ page }) => {
  await openDetailsRun(page, { longReport: true, failFirstPage: true })
  const pane = page.locator('.research-agent-pane--coordinator')
  const report = pane.locator('.research-message--report')
  await expect(report).toContainText('ROOT_REPORT_BEGIN')
  const read = report.getByRole('button', { name: /读取|继续|完整/ }).first()
  await read.click()
  await expect(report.getByRole('alert')).toBeVisible()
  await expect(report).toContainText('ROOT_REPORT_BEGIN')
  await report.getByRole('button', { name: /重试/ }).click()
  for (let index = 0; index < 50 && !(await report.getByText(/ROOT_REPORT_END/).isVisible()); index++) {
    const next = report.getByRole('button', { name: /继续读取|读取完整|继续加载/ }).first()
    if (!(await next.count())) break
    await next.click()
  }
  await expect(report).toContainText('ROOT_REPORT_END')
  expect((await report.innerText()).match(/ROOT_REPORT_BEGIN/g)).toHaveLength(1)
  expect((await report.innerText()).match(/ROOT_REPORT_END/g)).toHaveLength(1)
  expect(await page.evaluate(() => (window as any).paneDetailsFixture.pageRequests())).toBeGreaterThan(2)
})

for (const [option, label] of [['unknownPercent', '上下文 —'], ['zeroPercent', '上下文 0%']] as const) {
  test(`footer distinguishes ${option} without inferring a percentage from token counts`, async ({ page }) => {
    await openDetailsRun(page, { [option]: true })
    const footer = page.locator('.research-agent-pane--coordinator .research-pane-footer')
    await expect(footer.locator('.research-context-label')).toHaveText(label)
    await expect(footer).not.toContainText('16,000')
    expect((await footer.boundingBox())!.height).toBe(32)
  })
}

test('missing telemetry keeps a readable empty details state instead of invented values', async ({ page }) => {
  await openDetailsRun(page, { withoutTelemetry: true })
  await page.evaluate(() => (window as any).conversationFixture.theme('light'))
  await expect(page.locator('html')).not.toHaveClass(/theme-switching/)
  const footer = page.locator('.research-agent-pane--coordinator .research-pane-footer')
  await expect(footer.locator('.research-context-label')).toHaveText('上下文 —')
  await footer.getByRole('button', { name: /详情/ }).click()
  await expect(page.getByRole('dialog', { name: /会话详情/ })).toContainText('暂无会话遥测')
  const ratios = await renderedTextContrast(page, '.research-telemetry-heading p, .research-telemetry-content > p')
  expect(ratios).toHaveLength(2)
  for (const sample of ratios) expect(sample.ratio, sample.label).toBeGreaterThanOrEqual(4.5)
})

test('details follow real scrolling and resizing, flip at the upper edge, and wrap complete values', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 740 })
  await openDetailsRun(page, { longPath: true })
  const pane = page.locator('.research-agent-pane--coordinator')
  const footer = pane.locator('.research-pane-footer')
  const entry = footer.getByRole('button', { name: /详情/ })
  await entry.click()
  const dialog = page.getByRole('dialog', { name: /会话详情/ })
  await expect(dialog).toHaveAttribute('data-placement', 'above')
  const checkBounds = async () => {
    const rect = (await dialog.boundingBox())!
    const viewport = page.viewportSize()!
    expect(rect.x).toBeGreaterThanOrEqual(8)
    expect(rect.y).toBeGreaterThanOrEqual(8)
    expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width - 8)
    expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height - 8)
    expect(rect.height).toBeLessThanOrEqual(480)
  }
  await checkBounds()
  const layout = page.locator('[data-research-multi-layout]')
  const footerTop = (await footer.boundingBox())!.y
  await layout.evaluate((el, top) => { el.scrollTop += top - 100 }, footerTop)
  await expect(dialog).toHaveAttribute('data-placement', 'below')
  await checkBounds()
  const model = dialog.locator('dd').first()
  await expect(model).toHaveText('fixture-provider/research-controller-very-long-model-name-reasoning-edition-2026')
  expect(await model.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  const path = dialog.locator('dd').last()
  await expect(path).toContainText('ROOT_PATH_END')
  await path.scrollIntoViewIfNeeded()
  expect(await path.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.setViewportSize({ width: 960, height: 600 })
  await checkBounds()
  await page.keyboard.press('Escape')
  await expect(entry).toBeFocused()
  const separator = (await page.getByRole('separator').first().boundingBox())!
  await page.mouse.move(separator.x + separator.width / 2, separator.y + 160)
  await page.mouse.down()
  await page.mouse.move(400, separator.y + 160, { steps: 8 })
  await page.mouse.up()
  await entry.click()
  await checkBounds()
  await page.keyboard.press('Escape')
  await page.getByRole('group', { name: '研究视图', exact: true }).getByRole('button', { name: '专注', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).conversationFixture.research.state().commands.filter((item: any) => item.type === 'stop_research').length)).toBe(0)
})

test('details keep an opaque fallback and reduced motion without changing the reading font', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  await openDetailsRun(page)
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--font-size-base', '18px')
    for (const sheet of document.styleSheets) {
      for (let index = sheet.cssRules.length - 1; index >= 0; index--) {
        const rule = sheet.cssRules[index]
        if (rule instanceof CSSSupportsRule && rule.conditionText.includes('backdrop-filter')) sheet.deleteRule(index)
      }
    }
  })
  const pane = page.locator('.research-agent-pane--coordinator')
  await expect(pane.locator('.conversation-markdown').first()).toHaveCSS('font-size', '18px')
  await expect(pane.locator('.research-pane-footer')).toHaveCSS('font-size', '12px')
  const entry = pane.locator('.research-telemetry-entry')
  await entry.click()
  const details = page.getByRole('dialog', { name: /会话详情/ })
  await expect(details).toHaveCSS('backdrop-filter', 'none')
  await expect(details).toHaveCSS('transition-duration', '0s')
  expect(await details.evaluate(el => {
    const canvas = new OffscreenCanvas(1, 1).getContext('2d')!
    canvas.fillStyle = getComputedStyle(el).backgroundColor
    canvas.fillRect(0, 0, 1, 1)
    return canvas.getImageData(0, 0, 1, 1).data[3]
  })).toBe(255)
  await expect(details).not.toHaveCSS('background-image', 'none')
  await page.keyboard.press('Escape')
  await expect(entry).toBeFocused()
})

/** Sample actual composited pixels, including the real text behind a translucent popup. */
async function renderedTextContrast(page: Page, selector: string) {
  const inks = await page.locator(selector).evaluateAll(elements => elements.flatMap(element => {
    const rect = element.getBoundingClientRect()
    const panel = element.closest('.research-telemetry-popover')?.getBoundingClientRect()
    const y = rect.y + rect.height / 2
    if (!rect.width || !rect.height || y < 0 || y >= innerHeight || panel && (y <= panel.top + 2 || y >= panel.bottom - 2)) return []
    element.setAttribute('data-pane-contrast-ink', '')
    const context = new OffscreenCanvas(1, 1).getContext('2d')!
    context.fillStyle = getComputedStyle(element).color
    context.fillRect(0, 0, 1, 1)
    return [{ label: element.textContent?.slice(0, 80), color: [...context.getImageData(0, 0, 1, 1).data],
      points: [.15, .5, .85].map(t => ({ x: Math.max(0, Math.min(innerWidth - 1, Math.floor(rect.x + rect.width * t))), y: Math.floor(y) })) }]
  }))
  const hiddenInk = await page.addStyleTag({ content: '[data-pane-contrast-ink] { color: transparent !important; text-shadow: none !important; }' })
  let pixels: Buffer
  try { pixels = await page.screenshot({ animations: 'disabled' }) }
  finally {
    await hiddenInk.evaluate(el => el.remove())
    await page.locator('[data-pane-contrast-ink]').evaluateAll(elements => elements.forEach(el => el.removeAttribute('data-pane-contrast-ink')))
  }
  return page.evaluate(async ({ data, inks }) => {
    const image = new Image()
    image.src = `data:image/png;base64,${data}`
    await image.decode()
    const canvas = new OffscreenCanvas(image.width, image.height)
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0)
    const luminance = (rgb: number[]) => rgb.slice(0, 3).map(c => c / 255).reduce((sum, value, index) =>
      sum + (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index], 0)
    return inks.map(ink => ({ label: ink.label, ratio: Math.min(...ink.points.map(({ x, y }) => {
      const background = [...context.getImageData(x, y, 1, 1).data]
      const foreground = ink.color.map((channel, index) => channel * ink.color[3] / 255 + background[index] * (1 - ink.color[3] / 255))
      const a = luminance(background), b = luminance(foreground)
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
    })) }))
  }, { data: pixels.toString('base64'), inks })
}

test('eight themes keep quiet footer states and real glass details above 4.5 to 1', async ({ page }, info) => {
  test.setTimeout(180000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openDetailsRun(page)
  const pane = page.locator('.research-agent-pane--coordinator')
  const entry = pane.locator('.research-telemetry-entry')
  const evidence: unknown[] = []
  for (const theme of ['dark', 'light', 'codex-dark', 'codex-light', 'claude-dark', 'claude-light', 'forest-dark', 'forest-light']) {
    await page.evaluate(theme => (window as any).conversationFixture.theme(theme), theme)
    await expect(page.locator('html')).not.toHaveClass(/theme-switching/)
    for (const state of ['normal', 'hover', 'focus']) {
      await page.mouse.move(0, 0)
      await entry.evaluate(el => (el as HTMLElement).blur())
      if (state === 'hover') await entry.hover()
      if (state === 'focus') { await page.keyboard.press('Tab'); await entry.focus(); await expect(entry).toHaveCSS('outline-style', 'solid') }
      const ratios = await renderedTextContrast(page, '.research-agent-pane--coordinator .research-context-label, .research-agent-pane--coordinator .research-telemetry-entry')
      expect(ratios.length).toBe(2)
      for (const sample of ratios) expect.soft(sample.ratio, `${theme} ${state} ${sample.label}`).toBeGreaterThanOrEqual(4.5)
      evidence.push({ theme, state, ratios })
    }
    await entry.click()
    const details = page.getByRole('dialog', { name: /会话详情/ })
    await expect(details).toHaveCSS('backdrop-filter', 'blur(24px)')
    const ratios = await renderedTextContrast(page, '.research-telemetry-popover dt, .research-telemetry-popover dd, .research-telemetry-popover h3, .research-telemetry-heading p, .research-telemetry-heading strong')
    expect(ratios.length).toBeGreaterThan(12)
    for (const sample of ratios) expect.soft(sample.ratio, `${theme} details ${sample.label}`).toBeGreaterThanOrEqual(4.5)
    evidence.push({ theme, state: 'glass-details', ratios })
    await page.screenshot({ path: info.outputPath(`details-${theme}.png`) })
    await page.keyboard.press('Escape')
  }
  const contrastPath = info.outputPath('composited-text-contrast.json')
  fs.writeFileSync(contrastPath, JSON.stringify(evidence, null, 2))
  await info.attach('composited-text-contrast', { path: contrastPath, contentType: 'application/json' })
})
