import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { completeModelFixture } from './researchCompleteModelFixture'
import { clarificationTurn, createFixtureProvider, makeProfile } from './researchRecruitmentFixture'
import { launchResearchApp, requestHost, selectWorkspace, waitStatus } from './researchLifecycleSupport'
import { closeBounded, registerFixtureCleanup } from './electronFixtureCleanup'

test.setTimeout(480_000)
const evidence = path.resolve(process.env.MISAKA_VISUAL_EVIDENCE || '../.superpowers/sdd/2026-10-25-focus-workflow-audit/e2e', 'focus-native')

test('focus UI routes clarification and active follow-up to the root and delivers one complete report', async () => {
  const profile = makeProfile('misaka-electron-close-e2e-focus-')
  const fixture = completeModelFixture(path.join(profile, 'home'))
  const answer = 'FOCUS_CLARIFICATION_20261025: use only TEST-A.md and TEST-B.md.'
  const followup = 'FOCUS_RUNTIME_NOTE_20261025: keep the conflicting attendance counts explicit.'
  let clarified = false
  let workerEntered = false
  let pacedWorker = false
  const provider = await createFixtureProvider({ profile, chunkChars: 16, paceMs: 5, respond(payload) {
    const tools = new Set((payload.tools ?? []).map(tool => tool.name))
    if (!clarified && tools.has('misaka_research_assign') && /Read the live workspace view before planning|Plan this research|plan its own research/.test(JSON.stringify(payload.messages))) {
      clarified = true
      return clarificationTurn()
    }
    if (tools.has('misaka_card_complete')) workerEntered = true
    const turn = fixture(payload)
    const write = tools.has('misaka_card_complete') && turn.blocks.find(block => block.type === 'tool_use' && block.name === 'write')
    if (write && write.type === 'tool_use' && !pacedWorker) {
      pacedWorker = true
      write.input.content = String(write.input.content) + '\n' + 'Timing fixture evidence.\n'.repeat(300)
    }
    return turn
  } })
  fs.mkdirSync(evidence, { recursive: true })
  fs.writeFileSync(path.join(provider.workspace, 'TEST-A.md'), 'TEST CORPUS A: meeting date 1 March 2020; ten attendees, counting method unspecified.')
  fs.writeFileSync(path.join(provider.workspace, 'TEST-B.md'), 'TEST CORPUS B: same date; twelve attendees including two staff; no independent witness.')
  let app: Awaited<ReturnType<typeof launchResearchApp>>['app'] | undefined
  try {
    const launched = await launchResearchApp(profile, provider.home)
    app = launched.app
    await registerFixtureCleanup(app, profile, provider.home)
    const { page } = launched
    await page.setViewportSize({ width: 1280, height: 900 })
    await selectWorkspace(page, app, provider.workspace)
    await page.getByTitle('点击切换 Agent 模式').click()
    await page.getByRole('button', { name: /研究模式/ }).click()
    const input = page.getByRole('textbox', { name: '给 Misaka 发送任务' })
    await input.fill('Compare the common facts, conflicting counts and evidence limits in TEST-A.md and TEST-B.md.')
    await input.press('Enter')
    const wizard = page.getByRole('dialog', { name: '研究参数确认' })
    await expect(wizard).toBeVisible()
    for (const [name, value] of [['最大深度', '0'], ['追加轮次', '0'], ['结论修订', '0'], ['节点上限', '1']]) {
      await wizard.getByLabel(name, { exact: true }).fill(value)
    }
    await wizard.getByRole('checkbox', { name: '计划审批' }).check()
    await wizard.getByRole('button', { name: '确认并开始研究' }).click()
    const waiting = await waitStatus(page, 'waiting_input')
    await expect(page.locator('[data-research-focus-view]')).toBeVisible()
    await input.fill(answer)
    await input.press('Enter')
    await expect.poll(() => provider.requests.some(request => JSON.stringify(request.messages).includes(answer)), { timeout: 90_000 }).toBe(true)
    const approval = page.getByRole('button', { name: '同意', exact: true }).first()
    await expect(approval).toBeVisible({ timeout: 90_000 })
    await approval.click()
    await expect.poll(() => workerEntered, { timeout: 90_000, intervals: [100, 250, 500] }).toBe(true)
    await input.fill(followup)
    await input.press('Enter')
    const done = await waitStatus(page, 'done', 240_000)
    expect(done.run.id).toBe(waiting.run.id)
    expect(done.session.sessionId).toBe(waiting.session.sessionId)
    await expect.poll(() => provider.requests.some(request => JSON.stringify(request.messages).includes(followup)), { timeout: 30_000 }).toBe(true)
    const delivered = await requestHost(page)
    expect(delivered.reportDelivery?.state).toBe('delivered')
    const artifact = await requestHost(page, 'get_research_artifact', {
      runId: done.run.id, workspace: provider.workspace, artifactId: delivered.reportDelivery.artifactId,
    }, 'bridge')
    expect(artifact.detail?.state).toBe('available')
    const body = fs.readFileSync(path.resolve(provider.workspace, artifact.detail.path), 'utf8')
    const rows = fs.readFileSync(delivered.session.file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    const finals = rows.filter(row => row.customType === 'research-final' && row.details?.run_id === done.run.id && !row.details?.incomplete)
    expect(finals).toHaveLength(1)
    expect(finals[0].content.split('\n---\n\n').slice(1).join('\n---\n\n')).toBe(body)
    const followupRows = rows.filter(row => (row.message ?? row).role === 'user' && JSON.stringify((row.message ?? row).content).includes(followup))
    expect(followupRows).toHaveLength(1)
    await expect(page.locator('.research-focus-main')).toContainText('Test-material comparison', { timeout: 30_000 })
    for (const width of [900, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await expect(page.locator('[data-research-focus-toolbar]')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: path.join(evidence, `complete-${width}.png`), fullPage: true })
    }
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({
      result: 'passed', profile, runId: done.run.id, sessionId: done.session.sessionId,
      clarificationObservedByModel: true, activeFollowupObservedByModel: true,
      persistedFollowupRows: followupRows.length, persistedFinalRows: finals.length,
      reportSha256: crypto.createHash('sha256').update(body).digest('hex'), modelRequests: provider.requests.length,
    }, null, 2))
  } catch (error) {
    fs.writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify({ profile, error: String(error), clarified, workerEntered, modelRequests: provider.requests.length }, null, 2))
    if (app) await app.windows()[0]?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {})
    throw error
  } finally {
    try {
      if (app) {
        const page = app.windows()[0]
        if (page && !page.isClosed()) await page.evaluate(() => window.app.confirmClose?.('quit')).catch(() => {})
        await closeBounded(app)
      }
    } finally { await provider.close() }
  }
})
