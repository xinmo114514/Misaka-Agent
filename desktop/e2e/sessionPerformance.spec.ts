import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/conversation.html')
  await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
})

test('history is readable and draft input stays responsive while activation is delayed', async ({ page }) => {
  await page.evaluate(() => {
    const n = (window as any).conversationFixture.navigation
    n.register('delayed.jsonl', 500, 'C:/research', 4096)
    n.setReadyDelay(3000)
    n.open('delayed.jsonl')
  })
  await expect(page.locator('[data-message-anchor="delayed.jsonl:499"]')).toBeVisible()
  await expect(page.getByRole('button', { name: '会话加载中' })).toBeDisabled()
  expect(await page.locator('[data-message-anchor]').count()).toBeLessThan(40)
  const inputMs = await page.evaluate(async () => {
    const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="给 Misaka 发送任务"]')!
    const start = performance.now()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '等待期间的草稿')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(resolve => requestAnimationFrame(resolve))
    return performance.now() - start
  })
  expect(inputMs).toBeLessThanOrEqual(100)
  await expect(page.getByRole('textbox')).toHaveValue('等待期间的草稿')
  await expect.poll(() => page.evaluate(() => (window as any).conversationFixture.navigation.state().loading)).toBe(false)
  await expect(page.getByRole('button', { name: '发送指令 (Enter)' })).toBeEnabled()
})

test('virtual history retains tool disclosure and scroll-up reading during live events', async ({ page }) => {
  await page.evaluate(() => {
    const n = (window as any).conversationFixture.navigation
    n.register('long.jsonl', 500)
    n.open('long.jsonl')
  })
  const scroll = page.locator('.conversation-scroll')
  await expect.poll(() => scroll.evaluate(e => e.scrollHeight - e.scrollTop - e.clientHeight)).toBeLessThan(3)
  await scroll.evaluate(e => { e.scrollTop = 0; e.dispatchEvent(new Event('scroll')) })
  const first = page.locator('[data-message-anchor="long.jsonl:0"]')
  const toggle = first.getByRole('button', { name: /read.*完成/ })
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await scroll.evaluate(e => { e.scrollTop = e.scrollHeight; e.dispatchEvent(new Event('scroll')) })
  await expect(first).not.toBeAttached()
  await scroll.evaluate(e => { e.scrollTop = 0; e.dispatchEvent(new Event('scroll')) })
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const before = await scroll.evaluate(e => e.scrollTop)
  await page.evaluate(() => {
    const n = (window as any).conversationFixture.navigation
    n.emit({ type: 'agent_start' })
    n.emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 2000 } })
    n.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '新的流式内容' } })
  })
  await expect.poll(() => page.evaluate(() => (window as any).conversationFixture.navigation.state().messages)).toBe(501)
  expect(Math.abs(await scroll.evaluate(e => e.scrollTop) - before)).toBeLessThan(3)
})

for (const cached of [true, false]) test(`${cached ? 'cached' : 'cold'} return restores the same reading landmark`, async ({ page }) => {
  await page.evaluate(() => {
    const n = (window as any).conversationFixture.navigation
    n.register('reading.jsonl', 500); n.register('other.jsonl', 10)
    n.open('reading.jsonl')
  })
  await expect.poll(() => page.evaluate(() => (window as any).conversationFixture.navigation.state().loading)).toBe(false)
  const scroll = page.locator('.conversation-scroll')
  await scroll.evaluate(e => { e.scrollTop = 12000; e.dispatchEvent(new Event('scroll')) })
  await expect(page.getByRole('button', { name: '回到底部' })).toBeVisible()
  const bookmark = await scroll.evaluate(e => {
    const top = e.getBoundingClientRect().top
    const paragraph = [...e.querySelectorAll<HTMLElement>('.conversation-markdown > p')].find(p => p.getBoundingClientRect().bottom > top)!
    const row = paragraph.closest<HTMLElement>('[data-message-anchor]')!
    return { id: row.dataset.messageAnchor, paragraphIndex: [...row.querySelectorAll('.conversation-markdown > p')].indexOf(paragraph), offset: paragraph.getBoundingClientRect().top - top }
  })
  await page.evaluate(() => (window as any).conversationFixture.navigation.open('other.jsonl'))
  await expect(page.locator('[data-message-anchor="other.jsonl:9"]')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).conversationFixture.navigation.state().loading)).toBe(false)
  if (!cached) await page.evaluate(() => (window as any).conversationFixture.navigation.clearCache())
  await page.evaluate(() => (window as any).conversationFixture.navigation.open('reading.jsonl'))
  const paragraph = page.locator(`[data-message-anchor="${bookmark.id}"] .conversation-markdown > p`).nth(bookmark.paragraphIndex)
  await expect(paragraph).toBeAttached()
  await expect.poll(async () => paragraph.evaluate(e => e.getBoundingClientRect().top - e.closest('.conversation-scroll')!.getBoundingClientRect().top)).toBeCloseTo(bookmark.offset, 0)
})

test('latest target wins across rapid workspace switches and load failures preserve drafts', async ({ page }) => {
  await page.evaluate(() => {
    const n = (window as any).conversationFixture.navigation
    n.register('a.jsonl', 10, 'C:/A'); n.register('b.jsonl', 10, 'C:/B')
    n.setReadyDelay(200)
    n.open('a.jsonl'); n.workspace('C:/B')
  })
  await expect(page.locator('[data-message-anchor="b.jsonl:9"]')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).conversationFixture.navigation.state().active)).toBe('b.jsonl')
  await page.getByRole('textbox').fill('保留草稿')
  await page.evaluate(() => (window as any).conversationFixture.navigation.open('missing.jsonl'))
  await expect(page.getByRole('button', { name: '重试' })).toBeVisible()
  await expect(page.getByRole('textbox')).toHaveValue('保留草稿')
  await expect(page.getByRole('button', { name: '会话尚未就绪' })).toBeDisabled()
})

test('external history changes refresh a previously cached conversation', async ({ page }) => {
  await page.evaluate(() => {
    const n = (window as any).conversationFixture.navigation
    n.register('edited.jsonl', 10); n.register('away.jsonl', 10)
    n.open('edited.jsonl')
  })
  await expect.poll(() => page.evaluate(() => (window as any).conversationFixture.navigation.state().loading)).toBe(false)
  await page.evaluate(() => (window as any).conversationFixture.navigation.open('away.jsonl'))
  await expect.poll(() => page.evaluate(() => (window as any).conversationFixture.navigation.state().active)).toBe('away.jsonl')
  await page.evaluate(() => {
    const n = (window as any).conversationFixture.navigation
    n.register('edited.jsonl', 11)
    n.open('edited.jsonl')
  })
  await expect(page.locator('[data-message-anchor="edited.jsonl:10"]')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).conversationFixture.navigation.state().version)).toBe('2')
})

test('production first-visible and cached-switch P95 stay inside performance budgets', async ({ page }, testInfo) => {
  test.skip(process.env.MISAKA_E2E_PRODUCTION !== '1', 'Performance budgets are measured on the production build only')
  const bytes = await page.evaluate(() => {
    const n = (window as any).conversationFixture.navigation
    const bytes = n.register('bench.jsonl', 500, 'C:/research', 4096)
    n.register('bench-away.jsonl', 10)
    return bytes
  })
  expect(bytes).toBeLessThanOrEqual(5 * 1024 * 1024)
  const samples = await page.evaluate(async () => {
    const n = (window as any).conversationFixture.navigation
    const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const cold: number[] = [], cached: number[] = []
    for (let i = 0; i < 20; i++) {
      n.open('bench-away.jsonl'); await paint()
      n.clearCache()
      let start = performance.now(); n.open('bench.jsonl'); await paint()
      if (!document.querySelector('[data-message-anchor="bench.jsonl:499"]')) throw new Error('Cold target has not rendered')
      cold.push(performance.now() - start)
      n.open('bench-away.jsonl'); await paint()
      start = performance.now(); n.open('bench.jsonl'); await paint()
      if (!document.querySelector('[data-message-anchor="bench.jsonl:499"]')) throw new Error('Cached target has not rendered')
      cached.push(performance.now() - start)
    }
    const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]
    return { cold, cached, coldP95: p95(cold), cachedP95: p95(cached), mountedMessages: document.querySelectorAll('[data-message-anchor]').length }
  })
  await testInfo.attach('session-performance.json', { body: JSON.stringify({ bytes, ...samples }, null, 2), contentType: 'application/json' })
  console.log('SESSION_PERFORMANCE', JSON.stringify({ bytes, coldP95: samples.coldP95, cachedP95: samples.cachedP95, mountedMessages: samples.mountedMessages }))
  expect(samples.mountedMessages).toBeLessThan(40)
  expect(samples.coldP95).toBeLessThanOrEqual(500)
  expect(samples.cachedP95).toBeLessThanOrEqual(150)
})
