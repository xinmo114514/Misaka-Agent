import { expect, test } from '@playwright/test'

test.setTimeout(60000)

const tree = (page: any) => ({
  open: () => page.evaluate(() => (window as any).conversationFixture.tree.open()),
  state: () => page.evaluate(() => (window as any).conversationFixture.tree.state()),
})

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/conversation.html')
  await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
  await page.evaluate(() => (window as any).conversationFixture.reset())
})

test('the more menu opens the session tree and it renders the branch structure', async ({ page }) => {
  await page.getByTitle('更多会话选项').click()
  await page.locator('button').filter({ hasText: '会话树' }).click()

  const panel = page.getByRole('tree', { name: '会话树节点' })
  await expect(panel).toBeVisible()
  await expect(page.getByText('会话树', { exact: true })).toBeVisible()
  const ids = await page.locator('[role="treeitem"]').evaluateAll(rows => rows.map(row => row.getAttribute('data-row-id')))
  expect(ids).toEqual(['u1', 'a1', 'tool', 'u2'])
  await expect(page.locator('[data-row-id="u2"]')).toContainText('第二问')
  await page.screenshot({ path: 'test-results/session-tree.png' })
})

test('the tree panel filters, searches and edits a label', async ({ page }) => {
  await tree(page).open()
  const panel = page.getByTestId('session-tree-panel')
  const ids = () => panel.locator('[role="treeitem"]').evaluateAll(rows => rows.map(row => row.getAttribute('data-row-id')))

  await panel.getByRole('button', { name: '仅用户' }).click()
  expect(await ids()).toEqual(['u1', 'u2'])
  await panel.getByRole('button', { name: '隐藏工具' }).click()
  expect(await ids()).toEqual(['u1', 'a1', 'u2'])
  await panel.getByRole('button', { name: '全部' }).click()
  expect(await ids()).toEqual(['u1', 'a1', 'tool', 'u2'])

  await panel.getByLabel('搜索会话树').fill('第二问')
  expect(await ids()).toEqual(['u2'])
  await panel.getByLabel('搜索会话树').fill('')

  await panel.locator('[data-row-id="u1"]').click()
  await page.keyboard.press('l')
  await panel.getByLabel('节点标签').fill('起点')
  await panel.getByLabel('节点标签').press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).conversationFixture.tree.labelWrites()))
    .toContainEqual({ targetId: 'u1', label: '起点' })
})

test('navigating offers the three summary choices and keeps the returned message', async ({ page }) => {
  await page.evaluate(() => (window as any).conversationFixture.tree.navigationResult(
    (window as any).conversationFixture.tree.navigateResult('u2', { editorText: '第一问' })))
  await tree(page).open()
  const panel = page.getByTestId('session-tree-panel')
  await panel.locator('[data-row-id="u2"]').click()
  await panel.getByRole('button', { name: '摘要', exact: true }).click()

  await expect.poll(() => tree(page).state()).toMatchObject({
    operation: null,
    draft: '第一问',
    messages: ['第一问', '第一答', '折返后的问题'],
  })
  await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toHaveValue('第一问')
})

test('a navigation can be cancelled while it runs', async ({ page }) => {
  await page.evaluate(() => (window as any).conversationFixture.tree.deferNavigation(true))
  await tree(page).open()
  const panel = page.getByTestId('session-tree-panel')
  await panel.locator('[data-row-id="u2"]').click()
  await panel.getByRole('button', { name: '不摘要' }).click()

  const panelRoot = page.getByTestId('session-tree-panel')
  await expect(panelRoot).toBeVisible()
  await panelRoot.getByRole('button', { name: '取消' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).conversationFixture.tree.cancelCalls()))
    .toHaveLength(1)
  await expect.poll(() => tree(page).state()).toMatchObject({ operation: null })
})

test('the compact dialog reports status and cancels a running compaction', async ({ page }) => {
  await page.evaluate(() => (window as any).conversationFixture.seedHistory(6))
  await page.getByTitle('更多会话选项').click()
  await page.locator('button').filter({ hasText: '手动压缩' }).click()
  const dialog = page.getByRole('dialog', { name: '手动压缩会话' })
  await expect(dialog).toBeVisible()

  await page.getByLabel('自定义压缩指令').fill('保留未完成的实验')
  await page.getByRole('button', { name: '立即压缩' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).conversationFixture.sent
    .filter((command: any) => command.type === 'compact_session').at(-1)?.customInstructions))
    .toBe('保留未完成的实验')
  await expect(page.getByText('压缩完成')).toBeVisible()
  await page.screenshot({ path: 'test-results/compact-dialog.png' })
})

test('the compact dialog explains a refusal from the engine', async ({ page }) => {
  await page.evaluate(() => (window as any).conversationFixture.seedHistory(6))
  await page.evaluate(() => (window as any).conversationFixture.tree.compactFailure('暂无可压缩的消息'))
  await page.getByTitle('更多会话选项').click()
  await page.locator('button').filter({ hasText: '手动压缩' }).click()
  await page.getByRole('button', { name: '立即压缩' }).click()
  await expect(page.getByText('暂无可压缩的消息')).toBeVisible()
})

test('the slash commands open both surfaces without sending a prompt', async ({ page }) => {
  const input = page.getByRole('textbox', { name: '给 Misaka 发送任务' })
  await input.fill('/tree')
  await input.press('Enter')
  await expect(page.getByRole('tree', { name: '会话树节点' })).toBeVisible()
  expect(await page.evaluate(() => (window as any).conversationFixture.sent
    .some((command: any) => command.type === 'prompt'))).toBe(false)

  await page.getByTitle('关闭会话树').click()
  await input.fill('/compact 只留结论')
  await input.press('Enter')
  await expect(page.getByRole('dialog', { name: '手动压缩会话' })).toBeVisible()
  await expect(page.getByLabel('自定义压缩指令')).toHaveValue('只留结论')
  expect(await page.evaluate(() => (window as any).conversationFixture.sent
    .some((command: any) => command.type === 'prompt'))).toBe(false)
})

test('the session tree column stays usable in a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 })
  await tree(page).open()
  const viewport = await page.locator('[data-conversation-viewport]').boundingBox()
  const treePanel = await page.getByRole('tree', { name: '会话树节点' }).boundingBox()
  const composer = await page.locator('[data-conversation-viewport] textarea').boundingBox()
  // The tree is a sibling column: it starts at the conversation's right edge and fits on screen.
  expect(viewport!.width).toBeGreaterThan(200)
  expect(treePanel!.x).toBeGreaterThanOrEqual(viewport!.x + viewport!.width - 1)
  expect(treePanel!.x + treePanel!.width).toBeLessThanOrEqual(900)
  expect(composer!.width).toBeGreaterThan(200)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await page.screenshot({ path: 'test-results/session-tree-narrow.png' })
})
