import { expect, test } from '@playwright/test'

const evidence = '../.superpowers/sdd/focus-ui-refinement-2026-10-20/screenshots/stop-recovery'
test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/conversation.html')
  await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
  await page.evaluate(() => (window as any).conversationFixture.reset())
})

test('a reopened orphan stop offers refresh and confirmed normal settlement instead of a dead button', async ({ page }) => {
  await page.evaluate(() => (window as any).conversationFixture.research.inheritStop(false))
  const entry = page.getByRole('region', { name: '后台研究活动' })
  await entry.getByRole('button').first().click()
  await expect(entry.getByRole('button', { name: '重试停止', exact: true })).toBeEnabled()
  await expect(entry.getByRole('button', { name: '刷新', exact: true })).toBeEnabled()
  await expect(entry.getByText('运行中', { exact: true })).toHaveCount(0)
  await expect(entry.getByText('stopping', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: `${evidence}/inherited-stop-recovery.png` })

  await entry.getByRole('button', { name: '刷新', exact: true }).click()
  expect(await page.evaluate(() => (window as any).conversationFixture.research.state().commands
    .filter((command: any) => command.type === 'stop_research').length)).toBe(0)
  page.once('dialog', dialog => dialog.accept())
  await entry.getByRole('button', { name: '重试停止', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).conversationFixture.research.state().phase)).toBe('stopped')
  await expect(entry.getByText('后台研究已结束', { exact: false })).toBeVisible()
  await expect(entry.getByRole('button', { name: '重试停止', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).conversationFixture.research.state().commands
    .filter((command: any) => command.type === 'stop_research').length)).toBe(1)
  await page.screenshot({ path: `${evidence}/inherited-stop-settled.png` })
})

test('a reopened live-driver stop has a bounded wait and never automatically resends stop', async ({ page }) => {
  await page.clock.install()
  await page.evaluate(() => (window as any).conversationFixture.research.inheritStop(true))
  const entry = page.getByRole('region', { name: '后台研究活动' })
  await entry.getByRole('button').first().click()
  await expect(entry.getByRole('button', { name: '重试停止', exact: true })).toHaveCount(0)
  await expect(entry.getByRole('button', { name: '刷新', exact: true })).toBeEnabled()
  await page.clock.fastForward(31_000)
  await expect(entry.getByRole('button', { name: '重试停止', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => (window as any).conversationFixture.research.state().commands
    .filter((command: any) => command.type === 'stop_research').length)).toBe(0)
  await page.screenshot({ path: `${evidence}/inherited-stop-timeout.png` })
})

test('the final report does not end observation before the driver releases its lease', async ({ page }) => {
  await page.clock.install()
  await page.evaluate(() => {
    const research = (window as any).conversationFixture.research
    research.openRun()
    research.holdStopLease()
  })
  await expect(page.locator('[data-research-focus-view]')).toBeVisible()
  await page.getByRole('button', { name: '停止研究', exact: true }).click()
  await page.getByRole('button', { name: '确认停止', exact: true }).click()
  await page.clock.fastForward(4000)
  await expect(page.getByRole('status').filter({ hasText: '正在停止' })).toBeVisible()
  expect(await page.evaluate(() => (window as any).conversationFixture.research.state().phase)).toBe('stopped')
  // There is no second final notice: ordinary polling must observe the lease release.
  await page.evaluate(() => (window as any).conversationFixture.research.releaseStopLease())
  await page.clock.fastForward(4000)
  await expect(page.getByRole('status').filter({ hasText: '正在停止' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '重试停止', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).conversationFixture.research.state().commands
    .filter((command: any) => command.type === 'stop_research').length)).toBe(1)
  await page.screenshot({ path: `${evidence}/delayed-lease-settled.png` })
})
