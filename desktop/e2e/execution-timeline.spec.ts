import { expect, test } from '@playwright/test'

const T = 4_000

/** Drive the reducer with the same envelope shape the Electron bridge sends. */
async function runTurn(page: import('@playwright/test').Page, calls: Array<{ name: string; args?: Record<string, any>; error?: boolean }>, answer = '结论已经写好。') {
  await page.evaluate(({ calls, answer, T }) => {
    const emit = (event: Record<string, any>) => (window as any).conversationFixture.emit(event)
    emit({ type: 'agent_start' })
    emit({ type: 'message_start', message: { role: 'assistant', timestamp: T } })
    calls.forEach((call, index) => {
      emit({ type: 'message_update', message: { role: 'assistant', timestamp: T },
        assistantMessageEvent: { type: 'toolcall_start', contentIndex: index, id: `call-${index}`, toolName: call.name } })
      emit({ type: 'tool_execution_start', toolCallId: `call-${index}`, args: call.args ?? {} })
    })
    calls.forEach((call, index) => {
      emit({ type: 'tool_execution_end', toolCallId: `call-${index}`, isError: Boolean(call.error),
        result: [{ type: 'text', text: call.error ? '命令失败' : '输出正常' }] })
      emit({ type: 'message_end', message: { role: 'toolResult', toolCallId: `call-${index}`, isError: Boolean(call.error),
        content: [{ type: 'text', text: call.error ? '命令失败' : '输出正常' }], timestamp: T + index } })
    })
    emit({ type: 'message_update', message: { role: 'assistant', timestamp: T },
      assistantMessageEvent: { type: 'text_delta', contentIndex: calls.length, delta: answer } })
    emit({ type: 'message_end', message: { role: 'assistant', timestamp: T, stopReason: 'stop', content: [
      ...calls.map((call, index) => ({ type: 'toolCall', id: `call-${index}`, name: call.name, arguments: call.args ?? {} })),
      { type: 'text', text: answer },
    ] } })
    emit({ type: 'agent_settled' })
  }, { calls, answer, T })
}

const lane = (page: import('@playwright/test').Page) => page.locator('.conversation-execution-list:not(.is-standalone)')
const header = (page: import('@playwright/test').Page) => page.getByRole('button', { name: /^执行记录/ })

/** The harness numbers its own boot events, so a spec must start from a reset transcript. */
async function openConversation(page: import('@playwright/test').Page) {
  await page.goto('/e2e/conversation.html')
  await page.evaluate(() => (window as any).conversationFixture.reset())
  await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
}

test('folds a hundred-call run into one bounded, internally scrolled lane', async ({ page }) => {
  await openConversation(page)
  await runTurn(page, Array.from({ length: 100 }, (_, i) => ({ name: 'bash', args: { command: `pytest tests -q -k case_${i}` } })))

  await expect(header(page)).toHaveAccessibleName(/已完成 · 100 次工具调用/)
  await expect(header(page)).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByText('结论已经写好。')).toBeVisible()

  await header(page).click()
  const box = await lane(page).boundingBox()
  const metrics = await lane(page).evaluate((el: HTMLElement) => ({ scrollable: el.scrollHeight > el.clientHeight, rows: el.querySelectorAll('.conversation-execution-row').length }))
  expect(box!.height).toBeLessThanOrEqual(260)
  expect(metrics.rows).toBe(100)
  expect(metrics.scrollable).toBe(true)

  // The lane scrolls on its own and the page keeps following afterwards.
  await lane(page).evaluate((el: HTMLElement) => { el.scrollTop = 400 })
  await expect(lane(page).evaluate((el: HTMLElement) => el.scrollTop)).resolves.toBe(400)
  const pageScroll = await page.locator('.conversation-scroll').evaluate((el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight)
  expect(pageScroll).toBeLessThan(400)
  await page.screenshot({ path: 'test-results/execution-lane-expanded.png', animations: 'disabled' })
})

test('keeps a collapsed live lane collapsed while calls keep arriving', async ({ page }) => {
  await openConversation(page)
  await page.evaluate(T => {
    const emit = (event: Record<string, any>) => (window as any).conversationFixture.emit(event)
    emit({ type: 'agent_start' })
    emit({ type: 'message_start', message: { role: 'assistant', timestamp: T } })
    emit({ type: 'message_update', message: { role: 'assistant', timestamp: T }, assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'live-0', toolName: 'read' } })
    emit({ type: 'message_update', message: { role: 'assistant', timestamp: T }, assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 'live-1', toolName: 'grep' } })
    emit({ type: 'tool_execution_start', toolCallId: 'live-0', args: { path: 'desktop/src/App.tsx' } })
    emit({ type: 'tool_execution_start', toolCallId: 'live-1', args: { pattern: 'ExecutionGroup' } })
  }, T)
  await expect(header(page)).toHaveAccessibleName(/执行中/)
  await expect(lane(page)).toBeVisible()
  await header(page).click()
  await expect(header(page)).toHaveAttribute('aria-expanded', 'false')

  await page.evaluate(T => {
    const emit = (event: Record<string, any>) => (window as any).conversationFixture.emit(event)
    emit({ type: 'tool_execution_end', toolCallId: 'live-0', isError: false, result: [{ type: 'text', text: 'ok' }] })
    emit({ type: 'message_update', message: { role: 'assistant', timestamp: T }, assistantMessageEvent: { type: 'toolcall_start', contentIndex: 2, id: 'live-2', toolName: 'bash' } })
    emit({ type: 'tool_execution_start', toolCallId: 'live-2', args: { command: 'pytest tests -q' } })
  }, T)
  await expect(header(page)).toHaveAccessibleName(/已完成 1\/3/)
  await expect(header(page)).toHaveAttribute('aria-expanded', 'false')
})

test('reports a recovered failure without painting the lane green', async ({ page }) => {
  await openConversation(page)
  await runTurn(page, [{ name: 'bash', args: { command: 'pytest tests -q' }, error: true }, { name: 'read', args: { path: 'docs/spec.md' } }])
  await expect(header(page)).toHaveAccessibleName(/部分失败 · 2 次工具调用 · 1 项失败/)
  await header(page).click()
  await expect(page.getByRole('button', { name: /终端命令.*失败/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /读取文件.*完成/ })).toBeVisible()
})

test('never lets a single long command widen the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 })
  await openConversation(page)
  await runTurn(page, [{ name: 'bash', args: { command: `curl -s https://example.com/api?token=supersecretvalue123&x=${'y'.repeat(400)}` } }, { name: 'bash', args: { command: 'echo second' } }])
  await header(page).click()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  const visible = await page.locator('.conversation-tool-summary').first().evaluate((el: HTMLElement) => ({ clipped: el.scrollWidth > el.clientWidth, text: el.textContent ?? '' }))
  expect(visible.clipped).toBe(true)
  expect(visible.text).not.toMatch(/supersecretvalue123/)
})

test('drives the lane from the keyboard in the dark theme', async ({ page }) => {
  await openConversation(page)
  await runTurn(page, [{ name: 'read', args: { path: 'a.ts' } }, { name: 'edit', args: { path: 'b.ts' } }])
  await page.evaluate(() => (window as any).conversationFixture.theme('dark'))
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await header(page).focus()
  await page.keyboard.press('Enter')
  await expect(header(page)).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Enter')
  await expect(header(page)).toHaveAttribute('aria-expanded', 'false')
  await page.screenshot({ path: 'test-results/execution-lane-dark.png', animations: 'disabled' })
})
