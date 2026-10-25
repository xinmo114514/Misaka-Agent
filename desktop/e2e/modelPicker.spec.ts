import { expect, test, type Page } from '@playwright/test'

const trigger = (page: Page) => page.getByRole('button', { name: '模型与思考深度', exact: true })
const dialog = (page: Page) => page.getByRole('dialog', { name: '模型与思考深度' })
async function seed(page: Page) {
  await page.goto('/e2e/conversation.html')
  await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
  await page.evaluate(() => (window as any).modelPickerFixture.seed())
  await expect.poll(() => page.evaluate(() => (window as any).modelPickerFixture.state().pending)).toBe(false)
}
async function models(page: Page) { await dialog(page).getByRole('button', { name: /Misaka|模型/ }).first().click() }
async function select(page: Page, name: string) {
  await models(page)
  await dialog(page).getByRole('button', { name: new RegExp(name) }).click()
  await expect(dialog(page).getByRole('slider')).toBeVisible()
}
test.beforeEach(async ({ page }) => { await seed(page) })

test('reference layout shows the real high level and model name in sky light and dark themes', async ({ page }) => {
  for (const theme of ['codex-light', 'codex-dark']) {
    await page.evaluate(name => (window as any).conversationFixture.theme(name), theme)
    await trigger(page).click()
    const card = dialog(page)
    const slider = card.getByRole('slider')
    await slider.press('Home')
    for (let step = 0; step < 4; step++) await slider.press('ArrowRight')
    await expect(card.locator('.misaka-thinking-heading')).toHaveText('高')
    await expect(card.getByRole('button', { name: 'Misaka · 研究推理', exact: true })).toBeVisible()
    await expect(trigger(page)).toHaveText('Misaka · 研究推理')
    const reset = card.getByRole('button', { name: /重置到默认档位/ })
    await expect(reset.locator('svg')).toHaveCSS('width', '16px')
    // Capture the pointer appearance from the reference, not the keyboard focus ring.
    await card.locator('.misaka-thinking-heading').click()
    await page.mouse.move(0, 0)
    await card.screenshot({ path: `preview-artifacts/model-picker/reference-${theme}.png` })
    await page.screenshot({ path: `preview-artifacts/model-picker/reference-context-${theme}.png` })
    await page.keyboard.press('Escape')
  }
})

for (const theme of ['light', 'dark']) {
  test(`${theme}: both layers, theme ink, highest/near/static geometry and screenshots`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(name => (window as any).conversationFixture.theme(name), theme)
    await trigger(page).click()
    const card = dialog(page)
    const slider = card.getByRole('slider')
    await expect(slider).toBeFocused()
    await expect(card.locator('.misaka-thinking-slider')).toHaveAttribute('data-tier', 'max')
    const geometry = await card.evaluate(el => {
      const css = (selector: string) => getComputedStyle(el.querySelector(selector)!)
      return { width: el.getBoundingClientRect().width, padding: getComputedStyle(el).padding, track: css('.misaka-thinking-track').height, thumb: css('.misaka-thinking-thumb').width, rail: css('.misaka-thinking-rail').height, duration: css('.misaka-thinking-band').animationDuration }
    })
    expect(geometry).toEqual({ width: 288, padding: '12px', track: '26px', thumb: '30px', rail: '36px', duration: '0s' })
    await expect(trigger(page)).toContainText('Misaka · 研究推理')
    await expect(card.locator('.misaka-thinking-heading')).toHaveCSS('text-align', 'center')
    await expect(card.locator('.misaka-thinking-heading')).toHaveCSS('font-size', '16px')
    await expect(card.locator('.misaka-thinking-band').first()).toHaveCSS('display', 'none')
    expect(await card.locator('.misaka-thinking-thumb').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)')
    expect(await card.locator('.misaka-thinking-streak').first().evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)')
    await card.screenshot({ path: `preview-artifacts/model-picker/picker-depth-${theme}.png` })
    await page.screenshot({ path: `preview-artifacts/model-picker/picker-context-${theme}.png` })
    await slider.press('ArrowLeft')
    await expect(card.locator('.misaka-thinking-slider')).toHaveAttribute('data-tier', 'near')
    expect(await card.locator('.misaka-thinking-band').first().evaluate(el => getComputedStyle(el).animationName)).toBe('none')
    await card.screenshot({ path: `preview-artifacts/model-picker/picker-near-${theme}.png` })
    await models(page)
    await expect(card.getByRole('textbox', { name: '搜索模型' })).toBeFocused()
    await expect(card.getByText('8 个可用')).toBeVisible()
    await card.screenshot({ path: `preview-artifacts/model-picker/picker-models-${theme}.png` })
    await card.getByRole('textbox', { name: '搜索模型' }).fill('固定深度')
    await card.getByRole('button', { name: /固定深度模型.*1 档/ }).click()
    await expect(slider).toHaveAttribute('aria-valuetext', '深度 (high)')
    await expect(slider).toHaveAttribute('aria-disabled', 'true')
    await expect(card.locator('.misaka-thinking-slider')).toHaveAttribute('data-tier', 'quiet')
    expect(await page.evaluate(() => (window as any).modelPickerFixture.state().defaultModel)).toBe('full')
  })
}

test('navigation, reset, search, long tooltip and outside close return focus', async ({ page }) => {
  await trigger(page).click()
  await dialog(page).getByRole('button', { name: /重置到默认档位/ }).click()
  await expect(dialog(page).getByRole('slider')).toHaveAttribute('aria-valuetext', '均衡 (medium)')
  await models(page)
  await page.keyboard.press('Escape')
  await expect(dialog(page).getByRole('slider')).toBeFocused()
  await models(page)
  await dialog(page).getByRole('textbox', { name: '搜索模型' }).fill('超长')
  await dialog(page).getByRole('button', { name: /超长模型名称/ }).click()
  await expect(dialog(page).getByRole('button', { name: /超长模型名称/ })).toHaveAttribute('title', /Misaka Academic Research Reasoning/)
  await page.keyboard.press('Escape')
  await expect(trigger(page)).toBeFocused()
  await trigger(page).click()
  await page.getByRole('textbox', { name: '给 Misaka 发送任务' }).click({ position: { x: 10, y: 10 } })
  await expect(dialog(page)).not.toBeVisible()
})

test('fill follows a partial drag without snapping ahead and release animates it with the handle', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await trigger(page).click()
  const card = dialog(page)
  const slider = card.getByRole('slider')
  const fill = card.locator('.misaka-thinking-fill')
  const thumb = card.locator('.misaka-thinking-thumb')
  await slider.press('Home')
  await expect.poll(() => thumb.evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41)).toBeLessThan(0.1)
  const box = (await slider.boundingBox())!
  const travel = box.width - 30
  await page.mouse.move(box.x + 15, box.y + 18)
  await page.mouse.down()
  // Nearest preview becomes the middle stop at 2.5/6, while the thumb still follows pixels.
  const x = travel * 2.8 / 6
  await page.mouse.move(box.x + 15 + x, box.y + 18, { steps: 12 })
  await expect(slider).toHaveAttribute('aria-valuenow', '3')
  // Pointer/layout coordinates are subpixel-quantized; half a CSS pixel still catches snapping
  // to the nearest stop (several pixels away) without depending on a <0.05px rounding accident.
  expect(Math.abs(await thumb.evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41) - x)).toBeLessThan(0.5)
  const right = await fill.evaluate(el => {
    const clip = getComputedStyle(el).clipPath
    const pixels = clip.match(/inset\(0px ([\d.]+)px/)
    if (pixels) return Number(pixels[1])
    const calc = clip.match(/calc\(100% - ([\d.]+)px\)/)
    return calc ? el.getBoundingClientRect().width - Number(calc[1]) : NaN
  })
  expect(Math.abs(right - (box.width - x - 15))).toBeLessThan(0.5)
  await page.mouse.up()
  await expect.poll(async () => Math.abs(await thumb.evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41) - travel / 2)).toBeLessThan(0.5)
  const transitions = await card.evaluate(el => ({
    thumb: getComputedStyle(el.querySelector('.misaka-thinking-thumb')!).transitionDuration,
    fill: getComputedStyle(el.querySelector('.misaka-thinking-fill')!).transitionDuration,
  }))
  expect(transitions.thumb).toBe(transitions.fill)
  expect(transitions.thumb).not.toBe('0s')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await fill.evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s')
})

test('two-stop max, unsupported, model-default preview, empty and mapped capabilities', async ({ page }) => {
  await trigger(page).click()
  await select(page, '两档推理模型')
  await expect(dialog(page).locator('.misaka-thinking-slider')).toHaveAttribute('data-tier', 'max')
  await select(page, '即时响应模型')
  await expect(dialog(page).getByText('不支持思考深度', { exact: true })).toBeVisible()
  await expect(dialog(page).getByRole('slider')).toHaveAttribute('aria-disabled', 'true')
  await models(page)
  await expect(dialog(page).getByRole('button', { name: /能力待描述模型.*模型默认/ })).toBeVisible()
  await page.evaluate(() => (window as any).modelPickerFixture.hold(true))
  await dialog(page).getByRole('button', { name: /能力待描述模型/ }).click()
  await expect(dialog(page).locator('.misaka-thinking-slider')).toHaveAttribute('data-default', '')
  await expect(dialog(page).getByRole('slider')).toHaveAttribute('aria-disabled', 'true')
  await page.evaluate(() => { const f = (window as any).modelPickerFixture; f.hold(false); f.pending().forEach((id: string) => f.release(id)) })
  await select(page, '空能力模型')
  await expect(dialog(page).getByText('没有可选深度')).toBeVisible()
  await expect(dialog(page).getByRole('slider')).toHaveAttribute('aria-disabled', 'true')
  await select(page, '自定义预算模型')
  await expect(dialog(page).getByRole('slider')).toHaveAttribute('aria-valuemax', '1')
})

test('drag only submits on release and cancelled gestures restore confirmed value', async ({ page }) => {
  await trigger(page).click()
  const slider = dialog(page).getByRole('slider')
  await slider.press('Home')
  await page.evaluate(() => { (window as any).conversationFixture.sent.length = 0 })
  const box = (await slider.boundingBox())!
  await page.mouse.move(box.x + 12, box.y + 16)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 12, box.y + 16, { steps: 12 })
  expect(await page.evaluate(() => (window as any).conversationFixture.sent.filter((c: any) => c.type === 'set_thinking').length)).toBe(0)
  await page.mouse.up()
  expect(await page.evaluate(() => (window as any).conversationFixture.sent.filter((c: any) => c.type === 'set_thinking').length)).toBe(1)
  await page.mouse.down()
  await page.mouse.move(box.x + 12, box.y + 16)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(slider).toHaveAttribute('aria-valuenow', '6')
  expect(await page.evaluate(() => (window as any).conversationFixture.sent.filter((c: any) => c.type === 'set_thinking').length)).toBe(1)
  await page.keyboard.press('Escape')
  await expect(dialog(page)).not.toBeVisible()
})

test('latest delayed reply wins, model pending blocks depth, failure restores confirmed state', async ({ page }) => {
  await trigger(page).click()
  await page.evaluate(() => (window as any).modelPickerFixture.hold(true))
  await select(page, '两档推理模型')
  await expect(dialog(page).getByRole('slider')).toHaveAttribute('aria-disabled', 'true')
  await select(page, '固定深度模型')
  const ids = await page.evaluate(() => (window as any).modelPickerFixture.pending())
  await page.evaluate(id => (window as any).modelPickerFixture.release(id), ids[1])
  await page.evaluate(id => (window as any).modelPickerFixture.release(id), ids[0])
  await expect(dialog(page).getByRole('button', { name: '固定深度模型', exact: true })).toBeVisible()
  await page.evaluate(() => { const f = (window as any).modelPickerFixture; f.hold(false); f.failNext() })
  await select(page, '两档推理模型')
  await expect(dialog(page).getByRole('status')).toContainText('已恢复')
  await expect(dialog(page).getByRole('button', { name: '固定深度模型', exact: true })).toBeVisible()
})

test('session changes supersede queued model acknowledgements and return to backend truth', async ({ page }) => {
  await trigger(page).click()
  await page.evaluate(() => (window as any).modelPickerFixture.hold(true))
  await select(page, '两档推理模型')
  const oldSwitch = await page.evaluate(() => (window as any).modelPickerFixture.pending()[0])
  await page.evaluate(() => (window as any).modelPickerFixture.session())
  await expect(dialog(page).getByRole('button', { name: '选择模型', exact: true })).toBeVisible()
  await page.evaluate(old => {
    const f = (window as any).modelPickerFixture
    f.hold(false)
    f.pending().filter((id: string) => id !== old).forEach((id: string) => f.release(id))
  }, oldSwitch)
  await expect(dialog(page).getByRole('button', { name: 'Misaka · 研究推理', exact: true })).toBeVisible()
  await page.evaluate(id => (window as any).modelPickerFixture.release(id), oldSwitch)
  await expect(dialog(page).getByRole('slider')).toHaveAttribute('aria-valuenow', '6')
  await expect(dialog(page).getByRole('slider')).not.toHaveAttribute('aria-disabled')
  expect(await page.evaluate(() => (window as any).modelPickerFixture.state().model.modelId)).toBe('full')
})

test('small window clamps both layers and reduced motion keeps a static capsule', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 620, height: 330 })
  await trigger(page).click()
  const card = dialog(page)
  const within = async () => {
    const box = (await card.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(8)
    expect(box.y).toBeGreaterThanOrEqual(8)
    expect(box.x + box.width).toBeLessThanOrEqual(612)
    expect(box.y + box.height).toBeLessThanOrEqual(322)
  }
  await within()
  expect(await card.locator('.misaka-thinking-band').first().evaluate(el => getComputedStyle(el).animationName)).toBe('none')
  await page.screenshot({ path: 'preview-artifacts/model-picker/picker-reduced-small.png' })
  await models(page)
  await within()
  const list = card.locator('.misaka-picker-model-list')
  expect(await list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
  await page.setViewportSize({ width: 760, height: 420 })
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: '返回思考深度' }).click()
  await page.evaluate(() => (window as any).conversationFixture.theme('dark'))
  await expect(card.getByRole('slider')).toBeVisible()
})

test('empty list configuration entry opens settings without replacing its slim slider layout', async ({ page }) => {
  await page.evaluate(() => (window as any).modelPickerFixture.empty())
  await trigger(page).click()
  await models(page)
  await expect(dialog(page).getByText('0 个可用')).toBeVisible()
  await dialog(page).getByRole('button', { name: '前往配置模型' }).click()
  await expect(dialog(page)).not.toBeVisible()
  await expect(page.getByText('模型与供应商', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '模型思考行为', exact: true }).click()
  await expect(page.locator('.misaka-thinking-slider[data-size="default"]').first()).toBeVisible()
  expect(await page.locator('.misaka-thinking-track').first().evaluate(el => getComputedStyle(el).height)).toBe('6px')
  await page.screenshot({ path: 'preview-artifacts/model-picker/picker-settings-layout.png' })
})
