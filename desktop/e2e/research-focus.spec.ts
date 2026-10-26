import { expect, test } from '@playwright/test'
import { openFocusMore, switchFocusToMulti, toggleFocusProcess } from './focusUi'

test.setTimeout(90000)
const evidence = process.env.MISAKA_VISUAL_EVIDENCE || '../.superpowers/sdd/focus-ui-refinement-2026-10-20/screenshots'

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto('/e2e/conversation.html')
  await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
  await page.evaluate(() => {
    const fixture = window as any
    fixture.conversationFixture.reset()
    fixture.conversationFixture.research.openRun()
  })
  await expect(page.locator('[data-research-focus-view]')).toBeVisible()
})

test('reads a run as an ordinary chat, with the team behind a header pill', async ({ page }) => {
  const pill = page.getByRole('button', { name: /研究团队/ })
  // Six current members; the retried card's earlier attempt is folded, not counted.
  await expect(pill).toContainText('6')
  // The controller's own conversation, in the ordinary chat layout: no run banner, no tile grid.
  await expect(page.locator('.research-run-header')).toHaveCount(0)
  await expect(page.locator('.research-tile-grid')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '研究运行概览' })).toHaveCount(0)
  await expect(page.locator('[data-research-focus-toolbar]')).toHaveCount(1)
  await expect(pill).toContainText('团队')
  await expect(page.locator('.research-focus-main')).toContainText('先把两条路线拆成可核验的比较维度')
  await page.screenshot({ path: `${evidence}/focus-main-1280.png` })

  // Hover previews, click pins, Escape closes and hands focus back to the pill.
  await pill.hover()
  const directory = page.getByRole('dialog', { name: '研究团队目录' })
  await expect(directory).toBeVisible()
  await expect(directory).toContainText('检索路线的优势与局限')
  await expect(directory).toContainText('历史代次 1')
  await page.screenshot({ path: `${evidence}/focus-directory-1280.png` })
  await pill.click()
  await expect(pill).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Escape')
  await expect(directory).toHaveCount(0)
  await expect(pill).toBeFocused()

  // Browsing replaces the transcript; the team entry names it and the note returns to the writer.
  await pill.click()
  await directory.getByTestId('research-team-member-s-context').click()
  await expect(pill).toContainText('长上下文跨段整合')
  await expect(page.locator('.research-focus-main')).toContainText('十篇样本里')
  await expect(page.getByRole('note')).toContainText('子代理会话只读')
  await expect(page.getByRole('button', { name: '返回主控' })).toBeVisible()
  await expect(pill).toContainText('长上下文跨段整合')
  await page.screenshot({ path: `${evidence}/focus-member-1280.png` })

  // The side viewer reads a second member without moving the main area.
  await pill.click()
  await directory.getByRole('button', { name: '在右侧查看 检索召回与引用可追溯性' }).click()
  const side = page.getByRole('complementary', { name: '检索召回与引用可追溯性 侧栏' })
  await expect(side).toBeVisible()
  await expect(side).toContainText('十篇样本里')
  await expect(page.locator('.research-focus-main')).toContainText('十篇样本里')
  const viewer = await side.boundingBox()
  expect(viewer!.width).toBeLessThanOrEqual(420 + 1)
  await page.screenshot({ path: `${evidence}/focus-side-1280.png` })
  await side.getByRole('button', { name: '在主区域打开' }).click()
  await expect(pill).toContainText('检索召回与引用可追溯性')
  await expect(side).toHaveCount(0)
  await page.getByRole('button', { name: '返回主控', exact: true }).click()
  await expect(page.locator('.research-focus-main')).toContainText('先把两条路线拆成可核验的比较维度')
})

test('folds the run process into a panel without disturbing the chat', async ({ page }) => {
  // Reading a run is reading a conversation: its tasks and team stay folded until asked for.
  await expect(page.getByRole('region', { name: '研究运行过程' })).toHaveCount(0)
  await toggleFocusProcess(page)
  const panel = page.getByRole('region', { name: '研究运行过程' })
  await expect(panel).toBeVisible()
  // The directory's own cards are enough to open with; a live snapshot supersedes them later.
  await expect(panel.getByRole('button', { name: '查看任务 检索召回与引用可追溯性' })).toBeVisible()
  await expect(panel.getByRole('button', { name: '查看任务 长上下文跨段整合' })).toBeVisible()
  await expect(page.locator('.research-focus-main')).toContainText('先把两条路线拆成可核验的比较维度')
  await page.screenshot({ path: `${evidence}/focus-process-1280.png` })
  // Browsing does not fold it away again; the panel is the run's, not the transcript's.
  await page.getByRole('button', { name: /研究团队/ }).click()
  await page.getByRole('dialog', { name: '研究团队目录' }).getByTestId('research-team-member-s-context').click()
  await expect(panel).toBeVisible()
  const menu = await openFocusMore(page)
  await expect(menu.getByRole('button', { name: /研究过程/ })).toHaveAttribute('aria-expanded', 'true')
  await menu.getByRole('button', { name: /研究过程/ }).click()
  await expect(page.getByRole('region', { name: '研究运行过程' })).toHaveCount(0)
  // The run's notices reach the reader in 专注模式 as rows, not as a second run entry. They belong
  // to the controller's conversation, so reading a member shows the member, not the notice.
  await page.evaluate(() => (window as any).conversationFixture.research.clarify())
  await page.getByRole('button', { name: '返回主控', exact: true }).click()
  await expect(page.locator('.research-focus-main')).toContainText('是否只使用公开文献')
  await expect(page.locator('.research-focus-main').getByText('待你澄清')).toBeVisible()
})

test('keeps the research graph and node choice in the contextual More menu', async ({ page }) => {
  let menu = await openFocusMore(page)
  await expect(menu.getByRole('button', { name: /当前节点/ })).toBeVisible()
  await expect(menu.getByRole('button', { name: '研究图谱', exact: true })).toBeVisible()
  await page.screenshot({ path: `${evidence}/focus-run-menu-1280.png` })
  await menu.getByRole('button', { name: /当前节点/ }).click()
  await menu.getByRole('button', { name: '汇总两条证据路径', exact: true }).click()
  await expect(page.getByRole('button', { name: /研究团队/ })).toContainText('汇总节点主控')
  await expect(page.locator('.research-focus-main')).toBeVisible()
  menu = await openFocusMore(page)
  await menu.getByRole('button', { name: '研究图谱', exact: true }).click()
  await expect(menu).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: '研究拓扑图' })).toBeVisible()
})

test('node navigation replaces an explicitly selected member and keeps the side comparison', async ({ page }) => {
  const pill = page.getByRole('button', { name: /研究团队/ })
  await pill.click()
  await page.getByRole('dialog', { name: '研究团队目录' }).getByTestId('research-team-member-s-context').click()
  await expect(pill).toContainText('长上下文跨段整合')
  await pill.click()
  await page.getByRole('dialog', { name: '研究团队目录' }).getByRole('button', { name: '在右侧查看 检索召回与引用可追溯性' }).click()
  const side = page.getByRole('complementary', { name: '检索召回与引用可追溯性 侧栏' })
  await expect(side).toBeVisible()
  const menu = await openFocusMore(page)
  await menu.getByRole('button', { name: /当前节点/ }).click()
  await menu.getByRole('button', { name: '汇总两条证据路径', exact: true }).click()
  await expect(pill).toContainText('汇总节点主控')
  await expect(page.locator('.research-focus-main').locator('[data-message-anchor="lo-join-u"]')).toBeVisible()
  await expect(side).toBeVisible()
  await expect(side).toContainText('十篇样本里')
  const input = page.getByRole('textbox', { name: '给 Misaka 发送任务' })
  await input.fill('node-navigation draft retained')
  await switchFocusToMulti(page)
  await page.getByRole('button', { name: '专注', exact: true }).click()
  await expect(input).toHaveValue('node-navigation draft retained')
  await expect(pill).toContainText('汇总节点主控')
})

test('sidebar members and nodes navigate the focus reader without replacing its writer draft', async ({ page }) => {
  const tree = page.getByRole('navigation', { name: '研究会话目录' })
  const pill = page.getByRole('button', { name: /研究团队/ })
  const input = page.getByRole('textbox', { name: '给 Misaka 发送任务' })
  await input.fill('sidebar navigation keeps the root writer draft')
  await tree.getByTitle('长上下文证据卡 · running').click()
  await expect(pill).toContainText('长上下文跨段整合')
  await expect(page.locator('.research-focus-main')).toContainText('十篇样本里')
  await tree.getByRole('button', { name: '汇总两条证据路径', exact: true }).click()
  await expect(pill).toContainText('汇总节点主控')
  await expect(page.locator('.research-focus-main').locator('[data-message-anchor="lo-join-u"]')).toBeVisible()
  await expect(input).toHaveValue('sidebar navigation keeps the root writer draft')
})

test('switches to the multi-pane grid and back without losing the run', async ({ page }) => {
  await switchFocusToMulti(page)
  await expect(page.locator('.research-tiling-container[data-research-view-mode="multi"]')).toHaveCount(1)
  await expect(page.getByRole('region', { name: '研究运行概览' })).toHaveCount(0)
  await expect(page.locator('[data-research-workspace-toolbar]')).toHaveCount(1)
  await expect(page.locator('[data-research-multi-layout]')).toBeVisible()
  await expect(page.locator('.research-agent-pane').first()).toBeVisible()
  await page.screenshot({ path: `${evidence}/multi-1280.png` })
  await page.getByRole('button', { name: '专注' }).click()
  await expect(page.locator('[data-research-focus-toolbar]')).toBeVisible()
  await expect(page.locator('.research-tile-grid')).toHaveCount(0)
})

test('narrows into a drawer when the window cannot hold two columns', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 860 })
  await page.getByRole('button', { name: /研究团队/ }).click()
  await page.getByRole('dialog', { name: '研究团队目录' })
    .getByRole('button', { name: '在右侧查看 长上下文跨段整合' }).click()
  const side = page.getByRole('dialog', { name: '长上下文跨段整合 侧栏' })
  await expect(side).toBeVisible()
  await expect(side.getByRole('button', { name: '关闭侧栏会话' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: `${evidence}/focus-narrow-900.png` })
})
