import { expect, test } from '@playwright/test'

test('sidebar hides fully, reopens from the title bar, and remembers its state', async ({ page }) => {
  await page.goto('/e2e/conversation.html')
  await page.evaluate(() => localStorage.removeItem('misaka_sidebar_visible'))
  await page.reload()

  const sidebar = page.getByRole('complementary')
  const toggle = page.getByRole('button', { name: '隐藏侧边栏' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(sidebar).toBeVisible()

  await toggle.click()
  await expect(page.getByRole('button', { name: '展开侧边栏' })).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => sidebar.evaluate(element => element.getBoundingClientRect().width)).toBe(0)
  expect(await page.evaluate(() => localStorage.getItem('misaka_sidebar_visible'))).toBe('0')

  await page.reload()
  await expect(page.getByRole('button', { name: '展开侧边栏' })).toHaveAttribute('aria-expanded', 'false')
  await page.getByRole('button', { name: '展开侧边栏' }).click()
  await expect(page.getByRole('button', { name: '隐藏侧边栏' })).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(() => sidebar.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(0)

  await page.getByRole('button', { name: '最近列表更多选项' }).click()
  await page.getByRole('menuitem', { name: '搜索会话' }).click()
  const search = page.getByRole('textbox', { name: '搜索会话' })
  await search.fill('保留侧栏状态')
  await page.getByRole('button', { name: '隐藏侧边栏' }).click()
  await page.getByRole('button', { name: '展开侧边栏' }).click()
  await expect(search).toHaveValue('保留侧栏状态')

  await page.keyboard.press('Control+b')
  await expect(page.getByRole('button', { name: '展开侧边栏' })).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Control+b')
  await expect(page.getByRole('button', { name: '隐藏侧边栏' })).toHaveAttribute('aria-expanded', 'true')
})
