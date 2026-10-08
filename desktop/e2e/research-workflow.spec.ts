import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

test.setTimeout(90000)

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/conversation.html')
  await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
  await page.evaluate(() => (window as any).conversationFixture.reset())
})

test('completes a mocked desktop research cycle from plan review to exported report', async ({ page }) => {
  await page.getByTitle('点击切换 Agent 模式').click()
  await page.getByRole('button', { name: /研究模式/ }).click()
  const input = page.getByRole('textbox', { name: '给 Misaka 发送任务' })
  await input.fill('RAG 与长上下文方法在文献问答中的优势与局限')
  await input.press('Enter')

  const pill = page.getByTestId('research-run-pill')
  await expect(pill).toBeVisible()
  await expect(page.getByText(/正在进行研究/)).toBeVisible()

  const simulatedRun = await page.evaluate(() => (window as any).conversationFixture.research.state())
  expect(simulatedRun.question).toBe('RAG 与长上下文方法在文献问答中的优势与局限')
  expect(simulatedRun.start).toMatchObject({ workspace: 'C:/research', limits: { plan_approval: false } })

  // Expand research pill to view multi-agent tasks
  await page.getByRole('button', { name: /展开研究过程/ }).click()
  await expect(page.getByText('协同任务与专家分工')).toBeVisible()
  await expect(page.getByText('文献基准比较结果')).toBeVisible()

  // Click task to open right-side drawer
  await page.getByRole('button', { name: /查看任务 文献基准比较结果/ }).click()
  const drawer = page.getByTestId('research-task-drawer')
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText(/比较检索召回、长上下文跨段整合和引用可核验性/)).toBeVisible()
  await expect(drawer.getByText('产出文件 (1)')).toBeVisible()
  await expect(drawer.getByText('证据与核心发现 (1)')).toBeVisible()
  await expect(drawer.getByText(/10 篇样本中，长上下文在跨段整合上更稳/)).toBeVisible()
  await expect(drawer.getByText(/检索结果可逐项定位到证据片段/)).toBeVisible()

  // Close task drawer
  await page.getByRole('button', { name: '关闭任务抽屉' }).click()
  await expect(drawer).toHaveCount(0)

  // Open DAG modal
  await page.getByRole('button', { name: '查看研究拓扑图' }).click()
  const modal = page.getByRole('dialog', { name: '研究拓扑图' })
  await expect(modal).toBeVisible()
  await expect(modal.locator('.react-flow__node[data-id="b_root"]')).toBeVisible()
  await page.getByRole('button', { name: '关闭研究图' }).click()
  await expect(modal).toHaveCount(0)

  // Open research history dialog
  await page.locator('header').getByText('研究', { exact: true }).click()
  const historyDialog = page.getByRole('dialog', { name: '研究历史记录' })
  await expect(historyDialog).toBeVisible()
  await expect(historyDialog.getByText('RAG 与长上下文方法在文献问答中的优势与局限').first()).toBeVisible()
  await page.getByRole('button', { name: '关闭研究历史' }).click()
  await expect(historyDialog).toHaveCount(0)

  // Deliver final report
  await page.evaluate(() => (window as any).conversationFixture.research.deliverFinalReport())
  const reportCard = page.getByTestId('research-final-report')
  await expect(reportCard).toBeVisible()
  await expect(reportCard.getByText('研究最终报告')).toBeVisible()
  await expect(reportCard.getByText('结论：两种路线互补，不存在脱离语料与任务设定的普遍最优方案。')).toBeVisible()
  await expect(reportCard.getByText('参考文献')).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await reportCard.getByRole('button', { name: '导出 Markdown' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('rag-literature-review.md')
  const output = await download.path()
  expect(output).not.toBeNull()
  expect(await readFile(output!, 'utf8')).toContain('[1] Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks')
})
