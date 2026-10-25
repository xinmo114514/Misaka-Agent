import { expect, type Page } from '@playwright/test'

export async function openFocusMore(page: Page) {
  await page.getByRole('button', { name: '更多研究选项', exact: true }).click()
  const menu = page.getByRole('dialog', { name: '研究更多选项' })
  await expect(menu).toBeVisible()
  return menu
}

export async function toggleFocusProcess(page: Page) {
  const menu = await openFocusMore(page)
  await menu.getByRole('button', { name: /研究过程/ }).click()
}

export async function expandFocusRoles(page: Page) {
  const roles = page.locator('[data-research-role-details]')
  await expect(roles).toBeVisible()
  if (await roles.getAttribute('open') === null) await roles.locator(':scope > summary').click()
  await expect(roles).toHaveJSProperty('open', true)
}

export async function switchFocusToMulti(page: Page) {
  await page.getByRole('group', { name: '研究视图', exact: true }).getByRole('button', { name: '多窗', exact: true }).click()
}

export async function showResearchMulti(page: Page) {
  const workspace = page.locator('[data-research-tiling-workspace]')
  await expect(workspace).toBeVisible()
  if (await workspace.getAttribute('data-research-view-mode') === 'focus') await switchFocusToMulti(page)
  await expect(workspace).toHaveAttribute('data-research-view-mode', 'multi')
}

export async function openFocusGraph(page: Page) {
  const menu = await openFocusMore(page)
  await menu.getByRole('button', { name: '研究图谱', exact: true }).click()
}
