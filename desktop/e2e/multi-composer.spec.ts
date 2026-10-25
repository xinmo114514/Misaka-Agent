import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { multiFixtureInit } from './multiFixture.cjs'
import { adaptiveMosaicFixtureInit } from './adaptiveMosaicFixture.cjs'
import { compositedTextContrast } from './compositedTextContrast'

test.setTimeout(90000)
const input = (page: Page) => page.getByRole('textbox', { name: '给 Misaka 发送任务', exact: true })
const card = (page: Page) => page.locator('.conversation-composer')
const model = (page: Page) => page.getByRole('button', { name: '模型与思考深度', exact: true })
const evidence = process.env.MISAKA_VISUAL_EVIDENCE
const phase = process.env.MISAKA_COMPOSER_PHASE || 'after'

async function app(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript({ content: `(${multiFixtureInit.toString()})({memberCount:5});(${adaptiveMosaicFixtureInit.toString()})({memberCount:5});` })
  await page.goto('/e2e/conversation.html')
  await expect(input(page)).toBeVisible()
}

async function multi(page: Page) {
  await app(page)
  await page.evaluate(() => { const f = (window as any).conversationFixture; f.reset(); f.research.stopHold(); f.research.openRun() })
  await page.getByRole('group', { name: '研究视图', exact: true }).getByRole('button', { name: '多窗', exact: true }).click()
  await expect(page.locator('[data-research-multi-layout]')).toBeVisible()
}

async function sidebar(page: Page, visible: boolean) {
  const toggle = page.getByRole('button', { name: visible ? '展开侧边栏' : '隐藏侧边栏', exact: true })
  if (await toggle.isVisible()) await toggle.click()
}

async function theme(page: Page, name: string) {
  await page.evaluate(name => (window as any).conversationFixture.theme(name), name)
  await expect(page.locator('html')).toHaveAttribute('data-theme', name)
  await expect(page.locator('html')).not.toHaveClass(/theme-switching/)
}

async function screenshot(page: Page, name: string) {
  if (!evidence) return
  fs.mkdirSync(path.join(evidence, phase), { recursive: true })
  await page.screenshot({ path: path.join(evidence, phase, `${name}.png`), animations: 'disabled' })
}

async function appearance(page: Page) {
  return card(page).evaluate(el => {
    const targets = [el, el.querySelector('textarea')!, el.querySelector('.conversation-composer-toolbar')!, ...el.querySelectorAll('.conversation-composer-toolbar button')]
    return targets.map(target => {
      const style = getComputedStyle(target), rect = target.getBoundingClientRect()
      return { text: target instanceof HTMLTextAreaElement ? target.value : target instanceof HTMLButtonElement ? target.title || target.textContent : target.className,
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        color: style.color, background: style.backgroundColor, backgroundImage: style.backgroundImage, border: style.border, shadow: style.boxShadow,
        padding: style.padding, gap: style.gap, font: style.font, radius: style.borderRadius, blur: style.backdropFilter }
    })
  })
}

async function expectSeparatedControls(page: Page, state: string, width: number) {
  const controls = await page.locator('.conversation-composer-toolbar button').evaluateAll(elements => elements.map(el => {
    const r = el.getBoundingClientRect(); return { title: el.getAttribute('aria-label') || el.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom }
  }).filter(r => r.right > r.left))
  for (let i = 1; i < controls.length; i++) {
    const before = controls[i - 1], next = controls[i]
    if (Math.min(before.bottom, next.bottom) - Math.max(before.top, next.top) > 5)
      expect(before.right, `${state} ${width}: ${before.title} must not overlap ${next.title}`).toBeLessThanOrEqual(next.left + 1)
  }
}

test('visual matrix records multi geometry and unchanged ordinary focus welcome boundaries', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await multi(page)
  const measurements: Record<string, unknown> = {}
  for (const width of [1440, 1280, 960, 900]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const visible of [true, false]) {
      await sidebar(page, visible)
      for (const color of ['dark', 'light']) {
        await theme(page, color)
        await page.mouse.move(0, 0)
        await input(page).evaluate(el => el.blur())
        const name = `multi-${color}-${width}-sidebar-${visible ? 'open' : 'closed'}`
        measurements[name] = await appearance(page)
        await screenshot(page, name)
        const dock = (await page.locator('.conversation-composer-dock').boundingBox())!
        const layout = (await page.locator('[data-research-multi-layout]').boundingBox())!
        expect(layout.y + layout.height).toBeLessThanOrEqual(dock.y + 1)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await sidebar(page, true)
  await page.getByRole('button', { name: '专注', exact: true }).click()
  for (const scene of ['focus', 'ordinary', 'welcome']) {
    if (scene !== 'focus') await page.evaluate(scene => {
      const f = (window as any).conversationFixture; f.reset(); if (scene === 'ordinary') f.replay()
    }, scene)
    for (const color of ['dark', 'light']) {
      await theme(page, color)
      await input(page).evaluate(el => el.blur())
      const name = `${scene}-${color}-1440`
      measurements[name] = await appearance(page)
      await screenshot(page, name)
    }
  }
  if (evidence) fs.writeFileSync(path.join(evidence, phase, 'appearance.json'), JSON.stringify(measurements, null, 2))
})

test('multi card is centered and limited to 1120px in a transparent in-flow dock without a second border', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await multi(page); await sidebar(page, false)
  const bounds = (await card(page).boundingBox())!
  const dock = page.locator('.conversation-composer-dock')
  const outer = (await dock.boundingBox())!
  expect(bounds.width).toBeLessThanOrEqual(1120)
  expect(bounds.width).toBeGreaterThan(1118)
  expect(Math.abs(bounds.x + bounds.width / 2 - outer.x - outer.width / 2)).toBeLessThanOrEqual(1)
  await expect(dock).toHaveCSS('position', 'relative')
  await expect(dock).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(dock).toHaveCSS('border-top-width', '0px')
})

test('multi has a light double-layer editor with grouped quiet controls and an 84–88px empty card', async ({ page }) => {
  await multi(page); await sidebar(page, false)
  const toolbar = page.locator('.conversation-composer-toolbar')
  await expect(toolbar).toHaveCSS('border-top-width', '0px')
  await expect(card(page)).toHaveCSS('border-radius', '16px')
  const bounds = (await card(page).boundingBox())!
  expect(bounds.height).toBeGreaterThanOrEqual(84)
  expect(bounds.height).toBeLessThanOrEqual(88)
  const area = (await input(page).boundingBox())!, lower = (await toolbar.boundingBox())!
  expect(lower.y - area.y - area.height).toBeGreaterThanOrEqual(5)
  expect(lower.y - area.y - area.height).toBeLessThanOrEqual(7)
  const mode = page.getByTitle('点击切换 Agent 模式'), start = page.getByRole('button', { name: '新研究', exact: true })
  const modeBox = (await mode.boundingBox())!, startBox = (await start.boundingBox())!
  expect(startBox.x - modeBox.x - modeBox.width).toBeLessThanOrEqual(9)
  for (const button of [mode, model(page), start]) {
    await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    const border = await button.evaluate(el => { const css = getComputedStyle(el); return css.borderTopWidth === '0px' || css.borderTopColor === 'rgba(0, 0, 0, 0)' })
    expect(border, 'ghost controls have no painted resting border').toBe(true)
    expect((await button.boundingBox())!.height).toBe(32)
    await expect(button).toHaveCSS('font-size', '12px')
  }
})

test('card width rather than window width compacts model and places narrow toolbars in two ordered rows', async ({ page }) => {
  await multi(page); await sidebar(page, false)
  // Constrain the actual workspace, leaving a wide viewport: this catches viewport media queries.
  const viewport = page.locator('[data-conversation-viewport]')
  for (const width of [580, 400, 340]) {
    await viewport.evaluate((el, width) => { el.style.flex = 'none'; el.style.width = `${width}px` }, width)
    const actual = (await card(page).boundingBox())!.width
    expect(actual).toBeLessThan(width)
    if (width === 580) await expect(model(page).locator('span').first()).toHaveCSS('max-width', '100px')
    if (width === 400) {
      await expect(model(page).locator('span').first()).toBeHidden()
      expect((await model(page).boundingBox())!.width).toBeLessThanOrEqual(36)
      await expect(model(page)).toHaveAttribute('aria-description', /.+/)
    }
    if (width === 340) {
      const context = (await page.getByTitle('点击切换 Agent 模式').boundingBox())!
      const send = (await page.locator('.conversation-send-button').boundingBox())!
      expect(send.y).toBeGreaterThanOrEqual(context.y + context.height)
    }
    expect(await card(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  }
})

test('same textarea recomputes wrapped drafts on width and view changes while preserving selection', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await multi(page); await sidebar(page, false)
  const draft = '研究输入内容需要在宽度改变后保持完整可读。'.repeat(7)
  await input(page).fill(draft)
  await input(page).evaluate(el => { (window as any).multiComposerInput = el; el.setSelectionRange(4, 11, 'forward') })
  const wide = (await input(page).boundingBox())!.height
  await page.locator('[data-conversation-viewport]').evaluate(el => { el.style.flex = 'none'; el.style.width = '360px' })
  await expect.poll(async () => (await input(page).boundingBox())!.height).toBeGreaterThan(wide + 15)
  expect((await input(page).boundingBox())!.height).toBeLessThanOrEqual(88)
  expect(await input(page).evaluate(el => ({ same: el === (window as any).multiComposerInput, start: el.selectionStart, end: el.selectionEnd }))).toEqual({ same: true, start: 4, end: 11 })
  await page.getByRole('button', { name: '专注', exact: true }).click()
  await expect.poll(async () => (await input(page).boundingBox())!.height).toBeGreaterThan(88)
  await page.getByRole('button', { name: '多窗', exact: true }).click()
  await expect(input(page)).toHaveValue(draft)
  expect(await input(page).evaluate(el => el === (window as any).multiComposerInput)).toBe(true)
})

test('the 600 420 and 360 breakpoints use exact card bounds without early compaction', async ({ page }) => {
  await multi(page); await sidebar(page, false)
  await page.evaluate(() => (window as any).conversationFixture.composer.longModel())
  const viewport = page.locator('[data-conversation-viewport]')
  for (const width of [600, 599.5, 599, 420, 419.5, 419, 360, 359.5, 359]) {
    await viewport.evaluate((el, width) => { el.style.flex = 'none'; el.style.width = `${width + 24}px` }, width)
    await expect.poll(async () => (await card(page).boundingBox())!.width).toBe(width)
    const label = model(page).locator('span').first()
    if (width >= 420) {
      await expect(label).toBeVisible()
      await expect(label).toHaveCSS('max-width', width < 600 ? '100px' : '140px')
    } else {
      await expect(label).toBeHidden()
      await expect(model(page)).toHaveAccessibleDescription(/Misaka Academic Research Reasoning/)
      expect(await model(page).evaluate(el => [el.title, ...[...el.querySelectorAll('[title]')].map(node => node.getAttribute('title'))].join(' '))).toContain('跨供应商上下文验证')
    }
    const context = (await page.getByTitle('点击切换 Agent 模式').boundingBox())!
    const operations = (await page.locator('.conversation-send-button').boundingBox())!
    if (width < 360) expect(operations.y).toBeGreaterThanOrEqual(context.y + context.height)
    else expect(Math.abs(operations.y - context.y)).toBeLessThanOrEqual(1)
    expect(await card(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  }
})

test('restored drafts and sidebar dragging resize content without stealing focus or changing editor identity', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 1000 })
  await multi(page)
  await input(page).evaluate(el => { (window as any).restoredComposerInput = el })
  await page.evaluate(() => (window as any).conversationFixture.composer.restoreDraft('第一行\n第二行\n第三行\n第四行\n第五行'))
  await expect.poll(async () => (await input(page).boundingBox())!.height).toBe(88)
  await input(page).fill('按工作区实际宽度重算，不跟随整窗宽度。'.repeat(5))
  await input(page).evaluate(el => { el.focus(); el.setSelectionRange(3, 9, 'forward') })
  const separator = page.getByRole('separator')
  const beforeWidth = (await card(page).boundingBox())!.width
  const handle = (await separator.boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100)
  await page.mouse.down(); await page.mouse.move(handle.x + 130, handle.y + 100, { steps: 6 }); await page.mouse.up()
  await expect.poll(async () => (await card(page).boundingBox())!.width).toBeLessThan(beforeWidth - 50)
  expect((await input(page).boundingBox())!.height).toBeLessThanOrEqual(88)
  expect(await input(page).evaluate(el => ({ same: el === (window as any).restoredComposerInput, start: el.selectionStart, end: el.selectionEnd }))).toEqual({ same: true, start: 3, end: 9 })
  const body = (await page.locator('[data-research-multi-layout]').boundingBox())!
  expect(body.y + body.height).toBeLessThanOrEqual((await page.locator('.conversation-composer-dock').boundingBox())!.y)
  await screenshot(page, 'multi-sidebar-dragged-multiline')
})

test('running menus consume Escape before stop and keep separate send and stop operations at narrow widths', async ({ page }) => {
  await multi(page); await sidebar(page, false)
  await page.evaluate(() => { const f = (window as any).conversationFixture; f.composer.stream(true); f.composer.longModel() })
  const stop = page.locator('.conversation-stop-button')
  await expect(stop).toBeEnabled()
  await expect(page.locator('.conversation-send-button')).toBeDisabled()
  await input(page).fill('保留运行中的补充要求')
  const options = page.getByRole('button', { name: '发送选项', exact: true })
  await options.click()
  await expect(page.getByRole('menu', { name: '发送选项', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(options).toBeFocused()
  await page.getByTitle('点击切换 Agent 模式').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTitle('点击切换 Agent 模式')).toBeFocused()
  await model(page).click()
  await expect(page.getByRole('dialog', { name: '模型与思考深度', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(model(page)).toBeFocused()
  expect(await page.evaluate(() => (window as any).conversationFixture.research.state().commands.filter((command: any) => command.type === 'stop_research').length)).toBe(0)
  for (const width of [600, 500, 420, 419, 400, 360, 359]) {
    await page.locator('[data-conversation-viewport]').evaluate((el, width) => { el.style.flex = 'none'; el.style.width = `${width + 24}px` }, width)
    expect(await card(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1), `running card ${width}`).toBe(true)
    await expectSeparatedControls(page, 'running', width)
  }
  await page.locator('[data-conversation-viewport]').evaluate(el => { el.style.flex = 'none'; el.style.width = '360px' })
  await screenshot(page, 'multi-narrow-running')
  await expect(stop).toBeEnabled()
  expect(await card(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await stop.click()
  await expect(stop).toContainText('停止中')
  await expect(stop).toBeDisabled()
  await expect(page.locator('.conversation-send-button')).toBeDisabled()
  await expect(input(page)).toHaveValue('保留运行中的补充要求')
  for (const width of [600, 500, 420, 419, 400, 360, 359]) {
    await page.locator('[data-conversation-viewport]').evaluate((el, width) => { el.style.flex = 'none'; el.style.width = `${width + 24}px` }, width)
    expect(await card(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1), `stopping card ${width}`).toBe(true)
    const label = (await stop.locator('span').boundingBox())!
    expect(label.height, `stopping label remains one readable line at ${width}`).toBeLessThanOrEqual(20)
    await expectSeparatedControls(page, 'stopping', width)
  }
  expect(await card(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await screenshot(page, 'multi-narrow-stopping')
  expect(await page.evaluate(() => (window as any).conversationFixture.research.state().commands.filter((command: any) => command.type === 'stop_research').length)).toBe(1)
})

test('attachments errors retry in place, survive mode changes, and reserve height above the in-flow dock', async ({ page }) => {
  await multi(page)
  const emptyHeight = (await card(page).boundingBox())!.height
  await page.evaluate(() => {
    (window as any).conversationFixture.composer.attachmentFailure()
    window.app.pickFiles = async () => ['C:/research/composer-evidence.txt']
  })
  await page.getByRole('button', { name: '添加附件', exact: true }).click()
  await expect(page.getByLabel('待发送附件')).toContainText('附件读取失败，请重试')
  await expect(page.locator('.conversation-send-button')).toBeDisabled()
  await screenshot(page, 'multi-attachment-error')
  await page.getByRole('button', { name: '重试附件 composer-evidence.txt', exact: true }).click()
  await expect(page.getByLabel('待发送附件')).toContainText('128 B')
  await expect(page.locator('.conversation-send-button')).toBeEnabled()
  await input(page).fill('携带附件的草稿\n保持第二行')
  await input(page).evaluate(el => { (window as any).attachmentComposerInput = el })
  for (const modeName of ['专注', '多窗']) await page.getByRole('button', { name: modeName, exact: true }).click()
  await expect(page.getByLabel('待发送附件')).toContainText('composer-evidence.txt')
  await expect(input(page)).toHaveValue('携带附件的草稿\n保持第二行')
  expect(await input(page).evaluate(el => el === (window as any).attachmentComposerInput)).toBe(true)
  expect((await card(page).boundingBox())!.height).toBeGreaterThan(emptyHeight + 20)
  await expect.poll(async () => page.locator('[data-conversation-viewport]').evaluate(el => parseInt(el.style.getPropertyValue('--composer-height')))).toBe(Math.ceil((await card(page).boundingBox())!.height))
  const layout = (await page.locator('[data-research-multi-layout]').boundingBox())!
  expect(layout.y + layout.height).toBeLessThanOrEqual((await card(page).boundingBox())!.y - 8)
  await screenshot(page, 'multi-attachment-draft')
})

test('IME Shift+Enter submit failure and pending delivery retain draft and root coordinator routing', async ({ page }) => {
  await multi(page)
  await input(page).fill('中文研究要求')
  await input(page).dispatchEvent('compositionstart')
  await input(page).dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true })
  await input(page).dispatchEvent('compositionend')
  await input(page).press('Shift+Enter')
  const sends = () => page.evaluate(() => (window as any).conversationFixture.research.state().commands.filter((command: any) => command.type === 'send_research_message'))
  expect(await sends()).toHaveLength(0)
  await page.evaluate(() => (window as any).conversationFixture.composer.failSubmission('提交连接失败，请重试'))
  await input(page).press('Enter')
  await expect(card(page).getByRole('alert')).toContainText('提交连接失败，请重试')
  await expect(input(page)).toHaveValue(/中文研究要求/)
  await screenshot(page, 'multi-submit-error')
  await page.evaluate(() => (window as any).conversationFixture.composer.holdSubmission())
  await input(page).press('Enter')
  await expect(card(page).getByRole('status').filter({ hasText: '研究启动中' })).toBeVisible()
  await expect(page.locator('.conversation-send-button')).toBeDisabled()
  await expect(input(page)).toHaveValue(/中文研究要求/)
  for (const width of [600, 500, 420, 419, 400, 360, 359]) {
    await page.locator('[data-conversation-viewport]').evaluate((el, width) => { el.style.flex = 'none'; el.style.width = `${width + 24}px` }, width)
    expect(await card(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1), `submitting card ${width}`).toBe(true)
    await expectSeparatedControls(page, 'submitting', width)
    expect((await card(page).getByRole('status').filter({ hasText: '研究启动中' }).boundingBox())!.height).toBeLessThanOrEqual(20)
  }
  await screenshot(page, 'multi-submitting')
  await page.evaluate(() => (window as any).conversationFixture.composer.releaseSubmission())
  await expect(input(page)).toHaveValue('')
  const commands = await sends()
  expect(commands).toHaveLength(2)
  for (const command of commands) {
    expect(command.sessionId).toBe('research-root')
    expect(command.text).toContain('中文研究要求')
  }
  expect(await page.evaluate(() => (window as any).conversationFixture.sent.filter((command: any) => command.type === 'prompt').length)).toBe(0)
})

test('eight themes preserve readable multi text and quiet normal hover focus and disabled states', async ({ page }, info) => {
  test.setTimeout(180000)
  await page.setViewportSize({ width: 1280, height: 1000 })
  await multi(page)
  await page.evaluate(() => (window as any).conversationFixture.composer.longModel())
  const samples: Array<Record<string, unknown>> = []
  for (const name of ['dark', 'light', 'codex-dark', 'codex-light', 'claude-dark', 'claude-light', 'forest-dark', 'forest-light']) {
    await theme(page, name)
    for (const state of ['normal', 'hover', 'focus']) {
      await input(page).fill('补充研究要求，保留清晰的正文编辑体验。')
      await input(page).evaluate(el => el.blur()); await model(page).evaluate(el => el.blur()); await page.mouse.move(0, 0)
      if (state === 'hover') await model(page).hover()
      if (state === 'focus') {
        await page.keyboard.press('Tab'); await model(page).focus()
        await expect(model(page)).toHaveCSS('outline-style', 'solid')
      }
      const ratios = await compositedTextContrast(page, '.conversation-composer textarea, .conversation-permission-trigger span, .conversation-new-research-trigger, .conversation-model-trigger span')
      expect(ratios.length).toBe(4)
      for (const sample of ratios) expect.soft(sample.ratio, `${name} ${state} ${sample.label}`).toBeGreaterThanOrEqual(4.5)
      samples.push({ theme: name, state, ratios })
    }
    await input(page).fill(''); await input(page).evaluate(el => el.blur()); await page.mouse.move(0, 0)
    const ratios = await compositedTextContrast(page, '.conversation-composer textarea', true)
    for (const sample of ratios) expect.soft(sample.ratio, `${name} placeholder`).toBeGreaterThanOrEqual(4.5)
    samples.push({ theme: name, state: 'empty-disabled-send', ratios })
    await expect(page.locator('.conversation-send-button')).toBeDisabled()
    await screenshot(page, `theme-${name}-empty`)
  }
  const file = info.outputPath('multi-composer-text-contrast.json')
  fs.writeFileSync(file, JSON.stringify(samples, null, 2))
  if (evidence) fs.copyFileSync(file, path.join(evidence, 'multi-composer-text-contrast.json'))
  await info.attach('multi-composer-text-contrast', { path: file, contentType: 'application/json' })
})

test('multi glass retains its opaque no-blur fallback and reduced-motion treatment', async ({ page }) => {
  await multi(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(card(page)).toHaveCSS('transition-duration', '0s')
  await expect(card(page)).toHaveCSS('backdrop-filter', 'blur(20px)')
  for (const color of ['dark', 'light']) {
    await theme(page, color)
    await page.evaluate(() => {
      for (const sheet of document.styleSheets) for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
        const rule = sheet.cssRules[i]
        if (rule instanceof CSSSupportsRule && rule.conditionText.includes('backdrop-filter')) sheet.deleteRule(i)
      }
    })
    await expect(card(page)).toHaveCSS('backdrop-filter', 'none')
    expect(await card(page).evaluate(el => {
      const ctx = new OffscreenCanvas(1, 1).getContext('2d')!; ctx.fillStyle = getComputedStyle(el).backgroundColor; ctx.fillRect(0, 0, 1, 1)
      return ctx.getImageData(0, 0, 1, 1).data[3]
    })).toBe(255)
    await expect(page.locator('.conversation-composer-dock')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await screenshot(page, `multi-${color}-opaque-fallback`)
  }
})
