import { expect, test } from '@playwright/test'
import { switchFocusToMulti } from './focusUi'

/**
 * 停止研究 acceptance: every click answers, and the wait ends on the engine's truth.
 *
 * The plan's two complaints: (1) the first click showed nothing, and (2) an ACK flipped the
 * entry back while the run kept going. Here a real click must reveal the confirmation, the
 * confirmation must dispatch exactly once, 正在停止 must survive the 专注/多窗 switch, and the
 * wait may only end when the engine's final notice settles the run.
 */
test.setTimeout(90000)
const evidence = process.env.MISAKA_VISUAL_EVIDENCE || '../.superpowers/sdd/focus-ui-refinement-2026-10-20/screenshots/stop-feedback'

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto('/e2e/conversation.html')
  await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
  await page.evaluate(() => {
    const fixture = window as any
    fixture.conversationFixture.reset()
    fixture.conversationFixture.research.stopHold()
    fixture.conversationFixture.research.openRun()
  })
  await expect(page.locator('[data-research-focus-view]')).toBeVisible()
})

test('a click answers at once, dispatches once, keeps 正在停止 across views, and settles on the notice', async ({ page }) => {
  // 1. First click: the entry itself changes -- a held terminal makes the wait observable.
  const stop = page.getByRole('button', { name: '停止研究', exact: true })
  await expect(stop).toBeVisible()
  await stop.click()
  const confirm = page.getByRole('button', { name: '确认停止', exact: true })
  await expect(confirm).toBeVisible()
  await page.screenshot({ path: `${evidence}/confirm.png` })

  // 2. Confirming dispatches exactly one stop_research and the wait becomes 正在停止.
  await confirm.click()
  await expect(page.getByText('正在停止')).toBeVisible()
  await page.screenshot({ path: `${evidence}/pending.png` })
  expect(await page.evaluate(() => (window as any).conversationFixture.research.state()
    .commands.filter((c: any) => c.type === 'stop_research').length)).toBe(1)

  // 3. 专注 -> 多窗 -> 专注: the same wait is still up; no second stop entry appeared.
  await switchFocusToMulti(page)
  await expect(page.getByText('正在停止')).toBeVisible()
  await expect(page.getByRole('button', { name: '停止研究', exact: true })).toHaveCount(0)
  await page.screenshot({ path: `${evidence}/pending-multi.png` })
  await page.getByRole('button', { name: '专注' }).click()
  await expect(page.getByText('正在停止')).toBeVisible()

  // 4. Still one dispatch after the switch, and nothing while the wait holds.
  expect(await page.evaluate(() => (window as any).conversationFixture.research.state()
    .commands.filter((c: any) => c.type === 'stop_research').length)).toBe(1)

  // 5. The engine's final notice settles the run: the wait ends on observed rest, not the ACK.
  await page.evaluate(() => (window as any).conversationFixture.research.releaseStop())
  await expect(page.getByText('正在停止')).toBeHidden()
  await page.screenshot({ path: `${evidence}/settled.png` })
})

test('cancelling the confirmation sends nothing', async ({ page }) => {
  await page.getByRole('button', { name: '停止研究', exact: true }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByRole('button', { name: '停止研究', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).conversationFixture.research.state()
    .commands.filter((c: any) => c.type === 'stop_research').length)).toBe(0)
})
