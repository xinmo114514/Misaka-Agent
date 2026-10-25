import { expect, test, type Locator, type Page } from '@playwright/test'

const themes = [
  { id: 'light', mode: 'light', chrome: '90%', composer: '88%', popover: '94%' },
  { id: 'codex-light', mode: 'light', chrome: '90%', composer: '88%', popover: '94%' },
  { id: 'claude-light', mode: 'light', chrome: '90%', composer: '88%', popover: '94%' },
  { id: 'forest-light', mode: 'light', chrome: '90%', composer: '88%', popover: '94%' },
  { id: 'dark', mode: 'dark', chrome: '80%', composer: '78%', popover: '88%' },
  { id: 'codex-dark', mode: 'dark', chrome: '80%', composer: '78%', popover: '88%' },
  { id: 'claude-dark', mode: 'dark', chrome: '80%', composer: '78%', popover: '88%' },
  { id: 'forest-dark', mode: 'dark', chrome: '80%', composer: '78%', popover: '88%' },
] as const

test.setTimeout(60000)

async function openApp(page: Page, theme = 'dark') {
  await page.goto('/e2e/conversation.html')
  await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
  await page.evaluate(theme => (window as any).conversationFixture.theme(theme), theme)
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await expect(page.locator('html')).not.toHaveClass(/theme-switching/)
}

async function openResearch(page: Page) {
  await page.evaluate(() => {
    const fixture = (window as any).conversationFixture
    fixture.research.stopHold()
    fixture.research.openRun()
  })
  await expect(page.locator('[data-research-focus-view]')).toBeVisible()
}

async function backgroundAlpha(locator: Locator) {
  return locator.evaluate(element => {
    const context = new OffscreenCanvas(1, 1).getContext('2d')!
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = getComputedStyle(element).backgroundColor
    context.fillRect(0, 0, 1, 1)
    return context.getImageData(0, 0, 1, 1).data[3] / 255
  })
}

async function expectMaterial(locator: Locator, opacity: string, blur: number) {
  await expect(locator).toHaveCSS('backdrop-filter', `blur(${blur}px)`)
  expect(await locator.evaluate(element => getComputedStyle(element).getPropertyValue('--glass-opacity').trim())).toBe(opacity)
  // A late background shorthand may leave tokens and blur intact while making the paint opaque.
  expect(await backgroundAlpha(locator)).toBeCloseTo(Number.parseInt(opacity) / 100, 2)
  await expect(locator).not.toHaveCSS('background-image', 'none')
}

async function materialPaint(locator: Locator) {
  return locator.evaluate(element => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, reflection: style.backgroundImage, shadow: style.boxShadow, blur: style.backdropFilter }
  })
}

async function opaqueTextContrast(locator: Locator) {
  return locator.evaluate(element => {
    const context = new OffscreenCanvas(1, 1).getContext('2d')!
    const channels = (color: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
    }
    const luminance = (rgb: number[]) => rgb.map(channel => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
    const style = getComputedStyle(element)
    const foreground = luminance(channels(style.color))
    const background = luminance(channels(style.backgroundColor))
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
  })
}

async function openMore(page: Page) {
  await page.getByRole('button', { name: '更多研究选项', exact: true }).click()
  const menu = page.getByRole('dialog', { name: '研究更多选项', exact: true })
  await expect(menu).toBeVisible()
  return menu
}

test('focus outer canvas lets the root atmosphere paint through instead of covering it', async ({ page }, info) => {
  await openApp(page)
  await openResearch(page)
  const canvas = page.locator('.research-tiling-container')
  await expect(canvas).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(canvas).toHaveCSS('backdrop-filter', 'none')
  const bounds = (await canvas.boundingBox())!
  // This blank left reading gutter lies beneath the shared upper-left source, not beneath text.
  const clip = { x: Math.ceil(bounds.x) + 2, y: Math.ceil(bounds.y) + 58, width: 10, height: 60 }
  const illuminated = await page.screenshot({ clip, animations: 'disabled', path: info.outputPath('focus-atmosphere-visible.png') })
  const hidden = await page.addStyleTag({ content: '.misaka-atmosphere { visibility: hidden !important; }' })
  const unlit = await page.screenshot({ clip, animations: 'disabled', path: info.outputPath('focus-atmosphere-hidden.png') })
  await hidden.evaluate(element => element.remove())
  expect(illuminated.equals(unlit), 'hiding the real root light changes pixels in the focus canvas').toBe(false)

  await page.getByRole('group', { name: '研究视图', exact: true }).getByRole('button', { name: '多窗', exact: true }).click()
  await expect(canvas).toHaveAttribute('data-research-view-mode', 'multi')
  expect(await backgroundAlpha(canvas)).toBe(0)
  await expect(canvas).toHaveCSS('backdrop-filter', 'none')
})

test('focus toolbar reuses the same viewport-anchored chrome as the titlebar and sidebar', async ({ page }) => {
  await openApp(page)
  await openResearch(page)
  const toolbar = page.locator('[data-research-focus-toolbar]')
  await expect(toolbar).toHaveCSS('backdrop-filter', 'blur(16px)')
  await expect(toolbar).toHaveCSS('background-attachment', 'fixed')
  await expect(toolbar).toHaveCSS('box-shadow', 'none')
  const paints = await page.locator('.misaka-glass-chrome').evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element)
    return { image: style.backgroundImage, position: style.backgroundPosition, size: style.backgroundSize, attachment: style.backgroundAttachment }
  }))
  expect(paints).toHaveLength(3)
  expect(paints.every(paint => JSON.stringify(paint) === JSON.stringify(paints[0]))).toBe(true)
  expect(paints[0].attachment).toBe('fixed')
  expect(await toolbar.evaluate(element => getComputedStyle(element, '::before').content)).toBe('none')
  expect((await toolbar.boundingBox())!.height).toBe(52)
})

test('research More team and stop paint the shared popover material without research overrides', async ({ page }) => {
  await openApp(page)
  await page.getByTitle('模型与思考深度').click()
  const reference = await materialPaint(page.getByRole('dialog', { name: '模型与思考深度', exact: true }))
  await page.keyboard.press('Escape')
  await openResearch(page)

  const more = await openMore(page)
  expect.soft(await materialPaint(more), 'More uses the real popover paint').toEqual(reference)
  expect(await more.evaluate(element => element.parentElement === document.body)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '更多研究选项', exact: true })).toBeFocused()

  const teamTrigger = page.getByRole('button', { name: /研究团队/ })
  await teamTrigger.click()
  const team = page.getByRole('dialog', { name: '研究团队目录', exact: true })
  expect.soft(await materialPaint(team), 'team keeps the material shadow').toEqual(reference)
  expect(await team.evaluate(element => element.parentElement === document.body)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(teamTrigger).toBeFocused()

  const stop = page.getByRole('button', { name: '停止研究', exact: true })
  await stop.click()
  const confirmation = page.locator('.research-stop-confirm-popover')
  expect.soft(await materialPaint(confirmation), 'stop keeps the translucent material and shadow').toEqual(reference)
  expect(await confirmation.evaluate(element => element.parentElement === document.body)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(stop).toBeFocused()
  expect(await page.evaluate(() => (window as any).conversationFixture.research.state().commands.filter((command: any) => command.type === 'stop_research'))).toHaveLength(0)
})

test('stop confirmation keeps its normal-size danger label readable at rest hover and keyboard focus in every theme', async ({ page }) => {
  await openApp(page, 'light')
  await openResearch(page)
  for (const theme of themes) {
    await page.evaluate(id => (window as any).conversationFixture.theme(id), theme.id)
    await expect(page.locator('html')).not.toHaveClass(/theme-switching/)
    await page.getByRole('button', { name: '停止研究', exact: true }).click()
    const confirm = page.getByRole('button', { name: '确认停止', exact: true })
    await expect(confirm).toBeVisible()
    await confirm.evaluate(element => (element as HTMLElement).blur())
    await page.mouse.move(0, 0)
    // The danger button is solid, so its actual painter-resolved background is also the
    // composited background beneath the label, independently of the translucent popover.
    expect(await backgroundAlpha(confirm)).toBe(1)
    expect.soft(await opaqueTextContrast(confirm), `${theme.id}: resting confirmation label`).toBeGreaterThanOrEqual(4.5)
    const restingBorder = await confirm.evaluate(element => getComputedStyle(element).borderColor)
    await confirm.hover()
    await confirm.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)))
    expect.soft(await opaqueTextContrast(confirm), `${theme.id}: hovered confirmation label`).toBeGreaterThanOrEqual(4.5)
    expect.soft(await confirm.evaluate(element => getComputedStyle(element).borderColor), `${theme.id}: visible hover feedback`).not.toBe(restingBorder)
    await page.mouse.move(0, 0)
    await confirm.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(confirm).toBeFocused()
    await confirm.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)))
    expect.soft(await opaqueTextContrast(confirm), `${theme.id}: keyboard-focused confirmation label`).toBeGreaterThanOrEqual(4.5)
    await expect(confirm).toHaveCSS('outline-style', 'solid')
    await expect(confirm).toHaveCSS('outline-width', '2px')
    await page.keyboard.press('Escape')
  }
})

for (const theme of themes) {
  test(`${theme.id} keeps chat and focus at the approved three material tiers`, async ({ page }, info) => {
    await openApp(page, theme.id)
    await expectMaterial(page.locator('header').first(), theme.chrome, 16)
    await expectMaterial(page.locator('aside').first(), theme.chrome, 16)
    await expectMaterial(page.locator('.conversation-composer'), theme.composer, 20)
    if (theme.mode === 'light') {
      await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
      await expect(page.locator('#root > div')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
      await expect(page.locator('.misaka-atmosphere')).toHaveCSS('display', 'none')
    }
    const input = page.getByRole('textbox', { name: '给 Misaka 发送任务' })
    const reflection = await page.locator('.conversation-composer').evaluate(element => getComputedStyle(element).backgroundImage)
    // Neutral shell reflections do not pick up a different hue from each theme's accent.
    expect(reflection.match(/radial-gradient/g)).toHaveLength(1)
    const reflectedColors = [...reflection.matchAll(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ [\d.]+)?\)/g)]
    expect(reflectedColors.length).toBeGreaterThan(0)
    for (const color of reflectedColors) {
      expect(Number(color[1])).toBeCloseTo(Number(color[2]), 4)
      expect(Number(color[2])).toBeCloseTo(Number(color[3]), 4)
    }
    await input.fill('玻璃边缘、正文与焦点保持独立。')
    const accentBorder = await input.evaluate(element => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--border-accent)'
      element.parentElement!.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    })
    await expect(page.locator('.conversation-composer')).toHaveCSS('border-color', accentBorder)
    await openResearch(page)
    await expectMaterial(page.locator('[data-research-focus-toolbar]'), theme.chrome, 16)
    await expectMaterial(page.locator('.conversation-composer'), theme.composer, 20)
    const more = await openMore(page)
    await expectMaterial(more, theme.popover, 24)
    await page.screenshot({ path: info.outputPath('focus-more-material.png') })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /研究团队/ }).click()
    await expectMaterial(page.getByRole('dialog', { name: '研究团队目录', exact: true }), theme.popover, 24)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '停止研究', exact: true }).click()
    await expectMaterial(page.locator('.research-stop-confirm-popover'), theme.popover, 24)
    await page.keyboard.press('Escape')
  })
}

test('the atmosphere is one fixed noninteractive upper-left source instead of a second lower-right lamp', async ({ page }) => {
  await openApp(page)
  const atmosphere = page.locator('.misaka-atmosphere')
  await expect(atmosphere).toHaveCSS('position', 'fixed')
  await expect(atmosphere).toHaveCSS('pointer-events', 'none')
  const mask = await atmosphere.evaluate(element => getComputedStyle(element).maskImage)
  expect(mask.match(/radial-gradient/g)).toHaveLength(1)
})

test('sidebar sticky search reflects the same fixed light while covering scrolled rows without nested blur', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const fixture = (window as any).conversationFixture
    for (let index = 0; index < 30; index++) fixture.navigation.register(`lighting-session-${index}.jsonl`, 1)
  })
  await page.getByRole('button', { name: '最近列表更多选项', exact: true }).click()
  await page.getByRole('menuitem', { name: '搜索会话', exact: true }).click()
  // The default list caps project/recent rows; filtering expands every matching row so it scrolls.
  await page.getByRole('textbox', { name: '搜索会话', exact: true }).fill('lighting-session')
  const sidebar = page.locator('aside').first()
  const sticky = sidebar.locator('.sticky')
  await expect(sticky).toBeVisible()
  await expect(sticky).toHaveCSS('backdrop-filter', 'none')
  await expect(sticky).toHaveCSS('background-attachment', 'fixed')
  const reflection = await sidebar.evaluate(element => getComputedStyle(element).backgroundImage)
  await expect(sticky).toHaveCSS('background-image', reflection)
  expect(await backgroundAlpha(sticky)).toBe(1)
  const scroll = page.getByLabel('项目与最近会话', { exact: true })
  await scroll.evaluate(element => { element.scrollTop = 150 })
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
  const bounds = (await sticky.boundingBox())!
  expect(await sticky.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), { x: bounds.x + 8, y: bounds.y + 8 })).toBe(true)
})

for (const state of ['loading', 'empty', 'error'] as const) {
  test(`focus ${state} canvas shares transparency and chrome before any transcript is readable`, async ({ page }) => {
    // Exercise the actual loading/empty/error UI through its existing bridge boundary, including
    // production-preview builds where source-store imports are deliberately unavailable.
    await page.addInitScript(state => {
      let bridge: any
      Object.defineProperty(window, 'bridge', {
        configurable: true,
        get: () => bridge,
        set: value => {
          bridge = {
            send: (command: any) => { if (state !== 'loading' || command.type !== 'get_research_sessions') value.send(command) },
            on: (callback: (message: any) => void) => value.on((message: any) => {
              if (message.type === 'ack' && message.data?.runId && Array.isArray(message.data?.sessions)) {
                if (state === 'empty') message = { ...message, data: { ...message.data, sessions: [] } }
                if (state === 'error') message = { ...message, ok: false, error: 'lighting fixture read failure' }
              }
              callback(message)
            }),
          }
        },
      })
    }, state)
    await openApp(page)
    await page.evaluate(() => (window as any).conversationFixture.research.openRun())
    const canvas = page.locator('.research-tiling-container')
    if (state === 'loading') await expect(canvas.getByRole('status')).toContainText('读取研究会话…')
    if (state === 'empty') await expect(canvas.getByRole('status')).toContainText('当前节点还没有可查看的会话')
    if (state === 'error') await expect(canvas.getByRole('alert')).toContainText('lighting fixture read failure')
    await expect(canvas).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expectMaterial(page.locator('[data-research-focus-toolbar]'), '80%', 16)
  })
}

test('opaque fallback and ordinary panels survive the focused material changes', async ({ page }) => {
  await openApp(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '外观与主题', exact: true }).click()
  const ordinaryPanel = page.getByRole('heading', { name: '界面主题与视觉个性化', exact: true }).locator('..')
  await expectMaterial(ordinaryPanel, '82%', 20)
  await page.getByRole('button', { name: '返回时间线', exact: true }).click()
  await openResearch(page)
  await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      for (let index = sheet.cssRules.length - 1; index >= 0; index--) {
        const rule = sheet.cssRules[index]
        if (rule instanceof CSSSupportsRule && rule.conditionText.includes('backdrop-filter')) sheet.deleteRule(index)
      }
    }
  })
  for (const selector of ['header.misaka-glass-chrome', 'aside.misaka-glass-chrome', '.conversation-composer']) {
    const shell = page.locator(selector).first()
    await expect(shell).toHaveCSS('backdrop-filter', 'none')
    await expect.poll(() => backgroundAlpha(shell)).toBe(1)
  }
  const more = await openMore(page)
  await expect(more).toHaveCSS('backdrop-filter', 'none')
  expect(await backgroundAlpha(more)).toBe(1)
  await expect(more).not.toHaveCSS('background-image', 'none')
})

test('reading bubbles code side reader graph and scrim gain neither blur nor reflection', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openApp(page)
  await page.evaluate(() => (window as any).conversationFixture.loadHistory([
    { id: 'lighting-user', role: 'user', timestamp: 1000, content: '保留原来的气泡。' },
    { id: 'lighting-prose', role: 'assistant', timestamp: 1001, content: '## 阅读面\n\n正文与 `行内代码` 保持原样。\n\n```ts\nconst clear = true\n```' },
  ]))
  for (const selector of ['.conversation-user-message', '.conversation-markdown', '.conversation-inline-code', '.conversation-markdown pre']) {
    const surface = page.locator(selector).first()
    await expect(surface).toBeVisible()
    await expect(surface).toHaveCSS('backdrop-filter', 'none')
    await expect(surface).toHaveCSS('background-image', 'none')
  }
  await openResearch(page)
  await page.getByRole('button', { name: /研究团队/ }).click()
  await page.getByRole('button', { name: '在右侧查看 长上下文跨段整合', exact: true }).click()
  for (const selector of ['.research-side-panel', '.research-side-panel-header', '.research-side-panel-body', '.research-focus-main']) {
    await expect(page.locator(selector)).toHaveCSS('backdrop-filter', 'none')
    await expect(page.locator(selector)).toHaveCSS('background-image', 'none')
  }
  await page.setViewportSize({ width: 1200, height: 850 })
  const scrim = page.locator('[data-research-side-scrim]')
  await expect(scrim).toBeVisible()
  await expect(scrim).toHaveCSS('backdrop-filter', 'none')
  await expect(scrim).toHaveCSS('background-image', 'none')
  await page.keyboard.press('Escape')
  const more = await openMore(page)
  await more.getByRole('button', { name: '研究图谱', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '研究拓扑图', exact: true })).toBeVisible()
  for (const selector of ['.react-flow', '.react-flow__node']) {
    await expect(page.locator(selector).first()).toHaveCSS('backdrop-filter', 'none')
  }
})
