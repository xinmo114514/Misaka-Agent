import { expect, test, type Page } from '@playwright/test'
import { multiFixtureInit } from './multiFixture.cjs'
import { adaptiveMosaicFixtureInit } from './adaptiveMosaicFixture.cjs'

test.setTimeout(60000)

async function openMosaic(page: Page, memberCount = 4, options: Record<string, boolean> = {}) {
  await page.addInitScript({ content: `(${multiFixtureInit.toString()})(${JSON.stringify({ memberCount: Math.min(memberCount, 6), noController: options.noController })});(${adaptiveMosaicFixtureInit.toString()})(${JSON.stringify({ memberCount, ...options })});` })
  await page.goto('/e2e/conversation.html')
  await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
  await page.evaluate(() => { const f = (window as any).conversationFixture; f.reset(); f.research.stopHold(); f.research.openRun() })
  await page.getByRole('group', { name: '研究视图', exact: true }).getByRole('button', { name: '多窗', exact: true }).click()
  await expect(page.locator('[data-research-multi-layout]')).toBeVisible()
}

test('four-member mosaic gives the coordinator only one row rather than the full-height left column', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openMosaic(page, 4)
  await page.getByRole('button', { name: '隐藏侧边栏', exact: true }).click()
  await expect(page.locator('.research-agent-pane--coordinator')).toContainText('结论按任务设定')
  const layout = (await page.locator('[data-research-multi-layout]').boundingBox())!
  const controller = (await page.locator('.research-agent-pane--coordinator').boundingBox())!
  expect(controller.height / layout.height).toBeLessThanOrEqual(.55)
  const panes = await page.locator('.research-agent-pane:not(.research-agent-pane--coordinator)').all()
  const top = (await panes[0].boundingBox())!
  expect(Math.abs(top.y - controller.y)).toBeLessThanOrEqual(1)
  expect(controller.width / top.width).toBeGreaterThan(1.9)
})

for (const count of [5, 6]) {
  test(`all ${count} actual members remain visible with one coordinator and no filler windows`, async ({ page }) => {
    await openMosaic(page, count)
    await expect(page.locator('.research-agent-pane')).toHaveCount(count + 1)
    await expect(page.locator('.research-empty-pane')).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).adaptiveMosaicFixture.members().length)).toBe(count)
  })
}

const wideSpans = [[6], [3, 3], [2, 2, 2], [3, 3, 3, 3], [4, 2, 2, 2, 2], [2, 2, 2, 2, 2, 2], [6, 2, 2, 2, 2, 2, 2]]
const mediumSpans = [[6], [3, 3], [6, 3, 3], [3, 3, 3, 3], [6, 3, 3, 3, 3], [3, 3, 3, 3, 3, 3], [6, 3, 3, 3, 3, 3, 3]]

async function verifyGeometry(page: Page, spans: number[], solo = false) {
  const layout = page.locator('[data-research-multi-layout]')
  const geometry = await layout.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }))
  const expectedRows = spans.reduce((total, span) => total + span, 0) / 6
  const cap = solo ? Math.max(264, Math.min(720, geometry.height)) : Math.max(264, Math.min(420, Math.floor((geometry.height - 12 * (expectedRows - 1)) / expectedRows)))
  const cards = await page.locator('.research-agent-pane').evaluateAll(elements => elements.map(el => {
    const rect = el.getBoundingClientRect(), body = el.querySelector('.research-pane-body')!
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bodyHeight: body.getBoundingClientRect().height,
      footerBottom: el.querySelector('.research-pane-footer')!.getBoundingClientRect().bottom }
  }))
  expect(cards).toHaveLength(spans.length)
  let rowTop = cards[0]?.y ?? 0, rowBottom = 0, used = 0
  for (const [index, card] of cards.entries()) {
    if (used === 6) { expect(card.y).toBeGreaterThanOrEqual(rowBottom + 11); rowTop = card.y; used = 0 }
    expect(Math.abs(card.y - rowTop)).toBeLessThanOrEqual(1)
    expect(card.height).toBeLessThanOrEqual(cap + 1)
    expect(card.bodyHeight).toBeGreaterThanOrEqual(120)
    expect(card.footerBottom).toBeLessThanOrEqual(card.y + card.height + 1)
    if (solo) {
      expect(card.width).toBeLessThanOrEqual(841)
      expect(card.width).toBeLessThanOrEqual(geometry.width)
    } else {
      const expected = (geometry.width - 60) / 6 * spans[index] + 12 * (spans[index] - 1)
      expect(Math.abs(card.width - expected)).toBeLessThanOrEqual(1.5)
    }
    if (used) expect(card.x).toBeGreaterThan(cards[index - 1].x)
    rowBottom = card.y + card.height
    used += spans[index]
    if (used < 6) {
      const next = cards[index + 1]
      expect(Math.abs(next.height - card.height)).toBeLessThanOrEqual(1)
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const composer = (await page.locator('.conversation-composer').boundingBox())!
  const bounds = (await layout.boundingBox())!
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(composer.y - 8)
}

for (const count of [0, 1, 2, 3, 4, 5, 6]) {
  test(`member count ${count} selects the approved puzzle at all three workspace widths without remounting`, async ({ page }) => {
    await openMosaic(page, count)
    await page.getByRole('button', { name: '隐藏侧边栏', exact: true }).click()
    await expect(page.locator('.research-agent-pane')).toHaveCount(count + 1)
    await page.locator('.research-agent-pane').evaluateAll(elements => { (window as any).mosaicPaneIdentities = elements })
    for (const width of [1440, 1000, 780]) {
      await page.setViewportSize({ width, height: 1000 })
      const expected = width >= 1100 ? wideSpans[count] : width >= 820 ? mediumSpans[count] : Array(count + 1).fill(6)
      if (count === 0) await expect.poll(() => page.locator('.research-agent-pane').evaluate(el => el.getBoundingClientRect().width)).toBeLessThanOrEqual(841)
      else await expect.poll(async () => {
          const elements = await page.locator('.research-agent-pane').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().width))
          const w = await page.locator('[data-research-multi-layout]').evaluate(el => el.clientWidth)
          return elements.map(value => Math.round((value + 12) / (w + 12) * 6))
        }).toEqual(expected)
      await verifyGeometry(page, expected, count === 0)
      expect(await page.locator('.research-agent-pane').evaluateAll(elements => elements.every((el, index) => el === (window as any).mosaicPaneIdentities[index]))).toBe(true)
    }
  })
}

for (const count of [0, 1, 2, 3, 4, 5, 6]) {
  test(`missing controller keeps ${count} real members and evenly fills each final row`, async ({ page }) => {
    await openMosaic(page, count, { noController: true })
    await expect(page.locator('.research-agent-pane')).toHaveCount(count)
    await expect(page.locator('.research-agent-pane--coordinator')).toHaveCount(0)
    if (count) {
      await page.getByRole('button', { name: '隐藏侧边栏', exact: true }).click()
      for (const width of [1440, 1000, 780]) {
        await page.setViewportSize({ width, height: 1000 })
        const spans = width >= 1100 ? [[], [6], [3, 3], [2, 2, 2], [3, 3, 3, 3], [2, 2, 2, 3, 3], [2, 2, 2, 2, 2, 2]][count]
          : width >= 820 ? Array.from({ length: count }, (_, index) => count % 2 && index === count - 1 ? 6 : 3) : Array(count).fill(6)
        await expect.poll(async () => {
          const widths = await page.locator('.research-agent-pane').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().width))
          const w = await page.locator('[data-research-multi-layout]').evaluate(el => el.clientWidth)
          return widths.map(value => Math.round((value + 12) / (w + 12) * 6))
        }).toEqual(spans)
        await verifyGeometry(page, spans)
      }
    } else await expect(page.getByText('当前节点还没有可查看的会话。', { exact: true })).toBeVisible()
  })
}

test('the original four-member short-controller fixture halves its true unused body space without hiding its end', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openMosaic(page, 4)
  await page.getByRole('button', { name: '隐藏侧边栏', exact: true }).click()
  const root = page.locator('.research-agent-pane--coordinator')
  await expect(root).toContainText('结论按任务设定')
  const blank = () => root.evaluate(el => {
    const body = el.querySelector('.research-pane-body')!, last = body.lastElementChild!, footer = el.querySelector('.research-pane-footer')!
    return { gap: Math.max(0, footer.getBoundingClientRect().top - last.getBoundingClientRect().bottom), end: last.getBoundingClientRect().bottom,
      footer: footer.getBoundingClientRect().top, bodyHeight: body.clientHeight, scrollHeight: body.scrollHeight }
  })
  const old = await page.addStyleTag({ content: `
    .research-multi-layout { grid-template-columns:360px minmax(0,1fr)!important; grid-template-rows:minmax(0,1fr)!important; overflow:hidden!important; }
    .research-multi-task-grid { display:grid!important; grid-template-columns:repeat(2,minmax(0,1fr))!important; grid-auto-rows:minmax(280px,1fr)!important; gap:12px!important; min-height:0!important; overflow:auto!important; grid-column:auto!important; }
    .research-multi-layout .research-multi-pane-slot { grid-column:auto!important; height:100%!important; max-height:none!important; min-height:0!important; }
    .research-multi-layout .research-multi-pane-host, .research-multi-layout .research-agent-pane { height:100%!important; max-height:none!important; }
    .research-multi-layout .research-pane-body { flex:1 1 0%!important; }
  ` })
  const baseline = await blank()
  await old.evaluate(el => el.remove())
  await expect.poll(async () => (await blank()).gap).toBeLessThanOrEqual(baseline.gap * .5)
  const current = await blank()
  expect(current.end).toBeLessThanOrEqual(current.footer)
  expect(current.scrollHeight).toBeLessThanOrEqual(current.bodyHeight + 1)
})

test('a seventh member replaces an existing member without increasing watch capacity or losing the coordinator', async ({ page }) => {
  await openMosaic(page, 7)
  await expect(page.locator('.research-agent-pane')).toHaveCount(7)
  const visible = await page.locator('.research-agent-pane').evaluateAll(elements => elements.map(el => el.getAttribute('data-testid')!.replace('research-pane-', '')))
  const hidden = await page.evaluate(visible => (window as any).adaptiveMosaicFixture.members().find((id: string) => !visible.includes(id)), visible)
  expect(hidden).toBeTruthy()
  const watches = () => page.evaluate(() => (window as any).adaptiveMosaicFixture.commands().filter((command: any) => command.type === 'watch_research_sessions'))
  const before = (await watches()).length
  await page.getByRole('button', { name: /研究团队/ }).click()
  await expect(page.getByRole('dialog', { name: '研究团队目录', exact: true })).toBeVisible()
  expect((await watches()).length).toBe(before)
  await page.getByTestId(`research-team-member-${hidden}`).click()
  await expect(page.getByTestId(`research-pane-${hidden}`)).toBeVisible()
  await expect(page.locator('.research-agent-pane')).toHaveCount(7)
  await expect(page.locator('.research-agent-pane--coordinator')).toHaveCount(1)
  await expect.poll(async () => (await watches()).at(-1).visibleExecutorIds.includes(hidden)).toBe(true)
  for (const watch of await watches()) expect(watch.visibleExecutorIds.length).toBeLessThanOrEqual(7)
})

test('seven long readers retain their hosts, outer and inner reading, draft and two-stage Escape', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openMosaic(page, 6, { longMembers: true })
  const input = page.getByRole('textbox', { name: '给 Misaka 发送任务' })
  await input.fill('七窗拼版仍保留这份草稿')
  const layout = page.locator('[data-research-multi-layout]')
  const pane = page.locator('.research-agent-pane:not(.research-agent-pane--coordinator)').last()
  const id = (await pane.getAttribute('data-testid'))!
  await expect(pane).toContainText('MOSAIC_MEMBER_END')
  const body = pane.locator('.research-pane-body')
  await expect.poll(() => body.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(500)
  await body.evaluate(el => { el.scrollTop = 175; el.dispatchEvent(new Event('scroll', { bubbles: true })) })
  await pane.scrollIntoViewIfNeeded()
  const outerReading = await layout.evaluate(el => el.scrollTop)
  await pane.evaluate(el => { (window as any).mosaicReadPane = el })
  await pane.getByRole('button', { name: '展开会话', exact: true }).click()
  const expanded = page.getByRole('dialog', { name: /展开.*会话/ })
  await expect(expanded).toBeVisible()
  expect((await pane.boundingBox())!.height).toBeGreaterThan(800)
  await pane.locator('.research-telemetry-entry').click()
  const details = page.getByRole('dialog', { name: /会话详情/ })
  await expect(details).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)
  await expect(expanded).toBeVisible()
  await expect(pane.locator('.research-telemetry-entry')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(expanded).toHaveCount(0)
  expect(await pane.evaluate(el => el === (window as any).mosaicReadPane)).toBe(true)
  expect(await body.evaluate(el => el.scrollTop)).toBe(175)
  expect(await layout.evaluate(el => el.scrollTop)).toBeCloseTo(outerReading, 0)
  const group = page.getByRole('group', { name: '研究视图', exact: true })
  await group.getByRole('button', { name: '专注', exact: true }).click()
  await group.getByRole('button', { name: '多窗', exact: true }).click()
  await expect(page.getByTestId(id)).toBeVisible()
  await expect.poll(() => page.getByTestId(id).locator('.research-pane-body').evaluate(el => el.scrollTop)).toBe(175)
  await expect.poll(() => layout.evaluate(el => el.scrollTop)).toBeCloseTo(outerReading, 0)
  await expect(input).toHaveValue('七窗拼版仍保留这份草稿')
  await expect(page.getByRole('textbox')).toHaveCount(1)
  expect(await page.evaluate(() => (window as any).conversationFixture.research.state().commands.filter((command: any) => command.type === 'stop_research').length)).toBe(0)
})

test('streaming seven sessions updates content without remounting panes, changing spans or resubscribing', async ({ page }) => {
  await openMosaic(page, 6)
  await expect(page.locator('.research-agent-pane')).toHaveCount(7)
  await page.locator('.research-agent-pane').evaluateAll(elements => { (window as any).mosaicStreamingPanes = elements })
  const spans = () => page.locator('[data-research-pane-frame]').evaluateAll(elements => elements.map(el => getComputedStyle(el).gridColumn))
  const before = await spans()
  const watches = await page.evaluate(() => (window as any).adaptiveMosaicFixture.commands().filter((command: any) => command.type === 'watch_research_sessions').length)
  await page.evaluate(() => (window as any).adaptiveMosaicFixture.stream(20))
  for (const pane of await page.locator('.research-agent-pane').all()) await expect(pane).toContainText('STREAM_20_19')
  expect(await page.locator('.research-agent-pane').evaluateAll(elements => elements.every((el, index) => el === (window as any).mosaicStreamingPanes[index]))).toBe(true)
  expect(await spans()).toEqual(before)
  expect(await page.evaluate(() => (window as any).adaptiveMosaicFixture.commands().filter((command: any) => command.type === 'watch_research_sessions').length)).toBe(watches)
})

test('outer reading restores after the measured narrow mosaic commits following a focus-mode resize', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 600 })
  await openMosaic(page, 6, { longMembers: true })
  await page.getByRole('button', { name: '隐藏侧边栏', exact: true }).click()
  await expect(page.locator('.research-agent-pane')).toHaveCount(7)
  const layout = page.locator('[data-research-multi-layout]')
  await expect.poll(() => layout.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100)
  await layout.evaluate(el => { el.scrollTop = 100; el.dispatchEvent(new Event('scroll')) })
  const group = page.getByRole('group', { name: '研究视图', exact: true })
  await group.getByRole('button', { name: '专注', exact: true }).click()
  await page.setViewportSize({ width: 780, height: 1000 })
  await group.getByRole('button', { name: '多窗', exact: true }).click()
  await expect.poll(() => layout.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100)
  await expect.poll(() => layout.evaluate(el => el.scrollTop)).toBe(100)
  await group.getByRole('button', { name: '专注', exact: true }).click()
  await group.getByRole('button', { name: '多窗', exact: true }).click()
  await expect.poll(() => layout.evaluate(el => el.scrollTop)).toBe(100)
})

test('a physically short workspace scrolls whole cards instead of clipping their bodies and controls', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 420 })
  await openMosaic(page, 6, { longMembers: true })
  await expect(page.locator('.research-agent-pane')).toHaveCount(7)
  await expect(page.locator('[data-research-multi-layout]')).toHaveAttribute('data-tiny-height', 'true')
  await verifyGeometry(page, Array(7).fill(6))
  await expect.poll(() => page.locator('[data-research-multi-layout]').evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(1000)
})
