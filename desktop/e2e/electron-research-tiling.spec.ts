import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { completeModelFixture } from './researchCompleteModelFixture'
import { createFixtureProvider, makeProfile, type FixtureTurn } from './researchRecruitmentFixture'
import { launchResearchApp, closeResearchApp, selectWorkspace, requestHost, openHistory, approveCurrentPlan } from './researchLifecycleSupport'
import { showResearchMulti } from './focusUi'

test.setTimeout(600_000)
const evidence = path.resolve(process.cwd(), process.env.MISAKA_VISUAL_EVIDENCE ? path.join(process.env.MISAKA_VISUAL_EVIDENCE, 'electron') : '../.superpowers/sdd/focus-ui-refinement-2026-10-20/electron')
const visualEvidence = path.resolve(process.cwd(), process.env.MISAKA_VISUAL_EVIDENCE ? path.join(process.env.MISAKA_VISUAL_EVIDENCE, 'electron-screenshots') : '../.superpowers/sdd/focus-ui-refinement-2026-10-20/screenshots/electron')

test('native DAG tiles stop without fabrication and resume the same run after reopening', async () => {
  const cardCount = 5
  const profile = makeProfile('misaka-tiling-e2e-')
  const fixture = completeModelFixture(path.join(profile, 'home'))
  let quota = true
  const provider = await createFixtureProvider({ profile, chunkChars: 256, respond(payload) {
    if (quota && payload.tools?.some(tool => tool.name === 'misaka_card_complete')) return {
      blocks: [], httpError: { status: 429, type: 'usage_limit_reached', message: '429 usage_limit_reached: fixture allowance exhausted' },
    }
    const turn: FixtureTurn = fixture(payload)
    for (const block of turn.blocks) {
      if (block.type === 'tool_use' && block.name === 'misaka_research_assign' && block.input.status === 'ready') {
        const base = (block.input.tasks as Array<Record<string, unknown>>)[0]
        block.input.tasks = Array.from({ length: cardCount }, (_, index) => ({ ...base,
          local_id: `c${index + 1}`, title: `C${index + 1} source comparison`, deliverable: `findings-${index + 1}.md`,
          ...(index === 3 ? { dependencies: ['c3'] } : index === 4 ? { dependencies: ['c3', 'c4'] } : {}),
        }))
      }
    }
    return turn
  } })
  fs.writeFileSync(path.join(provider.workspace, 'TEST-A.md'), 'Meeting date 1 March 2020; ten attendees.')
  fs.writeFileSync(path.join(provider.workspace, 'TEST-B.md'), 'Meeting date 1 March 2020; twelve attendees including two staff.')
  const modelFile=path.join(provider.home,'models.json')
  const catalog=JSON.parse(fs.readFileSync(modelFile,'utf8'))
  const template=catalog.providers.fixture.models[0]
  catalog.providers.fixture.models.push({...template,id:'fixture-lo',name:'Fixture Last Order'},{...template,id:'fixture-sister',name:'Fixture Sister'})
  fs.writeFileSync(modelFile,JSON.stringify(catalog))
  fs.mkdirSync(evidence, { recursive: true })
  let app: Awaited<ReturnType<typeof launchResearchApp>>['app'] | undefined
  const clicks: unknown[] = []
  const tracePage = async (page: Awaited<ReturnType<typeof launchResearchApp>>['page']) => {
    await page.exposeFunction('recordFixtureClick', (value: unknown) => { clicks.push(value) })
    await page.evaluate(() => document.addEventListener('click', event => {
      const target = (event.target as Element)?.closest('button')
      if (target) void (window as any).recordFixtureClick({ text: target.textContent, title: target.getAttribute('title'), aria: target.getAttribute('aria-label') })
    }, true))
  }
  try {
    const launched = await launchResearchApp(profile, provider.home); app = launched.app
    await tracePage(launched.page)
    await launched.page.setViewportSize({ width: 1440, height: 1000 })
    await selectWorkspace(launched.page, app, provider.workspace)
    await launched.page.getByTitle('点击切换 Agent 模式').click()
    await launched.page.getByRole('button', { name: /研究模式/ }).click()
    await launched.page.getByRole('textbox', { name: '给 Misaka 发送任务' }).fill('Compare TEST-A.md and TEST-B.md with independent cards and explicit uncertainties.')
    await launched.page.getByRole('textbox', { name: '给 Misaka 发送任务' }).press('Enter')
    const wizard = launched.page.getByRole('dialog', { name: '研究参数确认' })
    await expect(wizard).toBeVisible()
    await wizard.getByLabel('最大深度', { exact: true }).fill('0')
    await wizard.getByLabel('追加轮次', { exact: true }).fill('0')
    await wizard.getByLabel('结论修订', { exact: true }).fill('0')
    await wizard.getByLabel('节点上限', { exact: true }).fill('1')
    await wizard.getByLabel('上下文阈值', { exact: true }).fill('50')
    await wizard.getByLabel('最大输出 token', { exact: true }).fill('4096')
    await wizard.getByRole('checkbox', { name: '计划审批' }).check()
    await wizard.getByRole('button', { name: '确认并开始研究' }).click()
    // Approvals are cards inside the conversation now, so the pending plan offers 同意/稍后/还需修改.
    await expect(launched.page.getByRole('button', { name: '同意', exact: true })).toBeVisible({ timeout: 90_000 })
    const pendingHost=await requestHost(launched.page)
    await requestHost(launched.page,'desktop_set_team_model',{sessionId:pendingHost.session.sessionId,provider:'fixture',modelId:'fixture-lo',role:'last_order'})
    await requestHost(launched.page,'desktop_set_team_model',{sessionId:pendingHost.session.sessionId,provider:'fixture',modelId:'fixture-sister',role:'sister'})
    await approveCurrentPlan(launched.page)
    // Focus hides idle/unavailable resume. Wait for observed rest, not a permanently disabled
    // placeholder: the run must be stopped with its driver lease released before it can resume.
    const resumeEntry = launched.page.getByRole('button', { name: '恢复研究', exact: true })
    await expect(resumeEntry).toBeVisible({ timeout: 300_000 })
    await expect(resumeEntry).toBeEnabled({ timeout: 300_000 })
    const stopped = await requestHost(launched.page)
    expect(stopped.run.status).toBe('stopped')
    const listing = await requestHost(launched.page, 'get_research_sessions', { runId: stopped.run.id, workspace: provider.workspace }, 'bridge')
    expect(listing.suspension.reason).toBe('all_cards_stopped')
    expect(listing.suspension.hasAcceptedOutput).toBe(false)
    expect(listing.suspension.confirmations).toHaveLength(cardCount)
    expect(provider.requests.some(request=>request.model==='fixture-sister')).toBe(true)
    expect(listing.run.final_artifact).toBeNull()
    expect(listing.graph.limits).toMatchObject({ max_depth: 0, parallel: 4, sister_parallel: 4,
      max_followups: 0, max_revisions: 0, max_nodes: 1, plan_approval: true,
      context_threshold: .5, max_output_tokens: 4096 })
    const workspace = launched.page.locator('[data-research-tiling-workspace]')
    // The workspace opens in the focus view; this case exercises the multi-pane tile geometry.
    await showResearchMulti(launched.page)
    // Every planned card and its actual coordinator remain visible; the coordinator is not a card.
    await expect(workspace.getByRole('region', { name: /会话$/ })).toHaveCount(cardCount + 1)
    await expect(workspace).toContainText('usage_limit_reached')
    await launched.page.screenshot({ path: path.join(evidence, 'all-stopped.png'), fullPage: true })
    const requestsAtStop = provider.requests.length
    await launched.page.waitForTimeout(1500)
    expect(provider.requests.length).toBe(requestsAtStop)
    await closeResearchApp(app); app = undefined
    quota = false
    const reopened = await launchResearchApp(profile, provider.home); app = reopened.app
    await tracePage(reopened.page)
    await reopened.page.setViewportSize({ width: 1440, height: 1000 })
    await selectWorkspace(reopened.page, app, provider.workspace)
    await openHistory(reopened.page, stopped.run.id)
    // The geometry checks below read the tile grid, so make the view explicit rather than
    // depending on the remembered preference.
    await showResearchMulti(reopened.page)
    await expect(reopened.page.getByRole('button', { name: '恢复研究', exact: true })).toBeVisible({ timeout: 30_000 })
    const resumedPage = reopened.page
    await resumedPage.getByRole('button', { name: '恢复研究', exact: true }).click()
    let done: any
    await expect.poll(async () => {
      await approveCurrentPlan(resumedPage, 2).catch(() => {})
      done = await requestHost(resumedPage)
      return done.run?.status
    }, { timeout: 300_000, intervals: [2000] }).toBe('done')
    expect(done.run.id).toBe(stopped.run.id)
    expect(done.session.sessionId).toBe(stopped.session.sessionId)
    expect(provider.requests.some(request=>request.model==='fixture-lo')).toBe(true)
    const resumed = await requestHost(reopened.page, 'get_research_sessions', { runId: stopped.run.id, workspace: provider.workspace }, 'bridge')
    expect(resumed.suspension).toBeNull()
    expect(resumed.sessions.filter((item: any) => item.role === 'sister' && item.isCurrent && item.status === 'done').length).toBeGreaterThanOrEqual(cardCount)
    const coordinator = resumed.sessions.find((item: any) => item.role === 'last_order' && item.nodeId === resumed.graph.nodes[0].id)
    // Native completion also creates the independent node red-team card. Compare actual owned
    // execution IDs, not a fixed count that would hide that additional required conversation.
    const currentNodeSessions = resumed.sessions.filter((item: any) => item.nodeId === coordinator.nodeId && item.isCurrent !== false)
    for (let index = 1; index <= cardCount; index++) {
      expect(currentNodeSessions.some((item: any) => item.cardTitle === `C${index} source comparison` && item.status === 'done')).toBe(true)
    }
    expect(currentNodeSessions.some((item: any) => item.cardTitle === 'Red team · the root question' && item.status === 'done')).toBe(true)
    const nativePaneIds = new Set(currentNodeSessions.map((item: any) => `research-pane-${item.executorId}`))
    // Multi view intentionally bounds its reading window to six members plus the coordinator;
    // additional native reviewers remain reachable through the team directory.
    const expectedPaneCount = Math.min(6, currentNodeSessions.filter((item: any) => item.role !== 'last_order').length) + 1
    const coordinatorPane = reopened.page.getByTestId(`research-pane-${coordinator.executorId}`)
    await expect(coordinatorPane).toContainText('Delivered final report', { timeout: 30_000 })
    await coordinatorPane.locator('div.space-y-2').evaluate(element => { element.scrollTop = element.scrollHeight })
    await reopened.page.screenshot({ path: path.join(evidence, 'resumed-complete.png'), fullPage: true })
    fs.mkdirSync(visualEvidence, { recursive: true })
    await reopened.page.emulateMedia({ reducedMotion: 'reduce' })
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 1200, height: 850 }, { width: 960, height: 820 }]) {
      await reopened.page.setViewportSize(viewport)
      await expect(reopened.page.locator('[data-research-workspace-toolbar]')).toBeVisible()
      await expect(reopened.page.locator('[data-research-multi-layout]')).toBeVisible()
      expect(await reopened.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      const geometry = await reopened.page.locator('.research-agent-pane').evaluateAll(panes => panes.map(pane => ({
        id: pane.getAttribute('data-testid'),
        body: pane.querySelector('.research-pane-body')!.getBoundingClientRect().height,
        bottom: pane.getBoundingClientRect().bottom,
        footer: pane.querySelector('.research-pane-footer')!.getBoundingClientRect().bottom,
      })))
      expect(geometry).toHaveLength(expectedPaneCount)
      expect(new Set(geometry.map(pane => pane.id)).size).toBe(expectedPaneCount)
      expect(geometry.map(pane => pane.id)).toContain(`research-pane-${coordinator.executorId}`)
      for (const pane of geometry) expect(nativePaneIds.has(pane.id)).toBe(true)
      for (const pane of geometry) {
        expect(pane.body).toBeGreaterThanOrEqual(80)
        expect(pane.footer).toBeLessThanOrEqual(pane.bottom + 1)
      }
      await reopened.page.screenshot({ path: path.join(visualEvidence, `workspace-dark-${viewport.width}.png`), fullPage: true })
    }
    const cardPane = reopened.page.locator('.research-agent-pane').filter({ has: reopened.page.locator('.research-card-contract') }).first()
    await cardPane.locator('.research-card-contract > summary').click()
    await cardPane.getByRole('button', { name: /^查看会话详情/ }).click()
    const details = reopened.page.getByRole('dialog', { name: /^会话详情/ })
    await expect(details).toBeVisible()
    await expect(details.getByRole('heading', { name: '用量', exact: true })).toBeVisible()
    const expandedGeometry = await cardPane.evaluate(pane => ({
      body: pane.querySelector('.research-pane-body')!.getBoundingClientRect().height,
      bottom: pane.getBoundingClientRect().bottom,
      footer: pane.querySelector('.research-pane-footer')!.getBoundingClientRect().bottom,
    }))
    expect(expandedGeometry.body).toBeGreaterThanOrEqual(80)
    expect(expandedGeometry.footer).toBeLessThanOrEqual(expandedGeometry.bottom + 1)
    await cardPane.locator('.research-card-contract').evaluate((element: HTMLDetailsElement) => { element.open = false })
    await details.getByRole('button', { name: '关闭会话详情' }).click()
    await expect(details).not.toBeVisible()
    await reopened.page.setViewportSize({ width: 1440, height: 1000 })
    await reopened.page.evaluate(() => window.theme.setTheme('light'))
    await expect(reopened.page.locator('html')).toHaveAttribute('data-theme-mode', 'light')
    await reopened.page.screenshot({ path: path.join(visualEvidence, 'workspace-light-1440.png'), fullPage: true })
    await reopened.page.evaluate(() => window.theme.setTheme('dark'))
    await reopened.page.getByRole('button', { name: '新研究', exact: true }).click()
    const draft = '下一轮研究：保留草稿并检查研究参数。'
    const composer = reopened.page.getByRole('textbox', { name: '给 Misaka 发送任务' })
    await composer.fill(draft); await composer.press('Enter')
    const nextWizard = reopened.page.getByRole('dialog', { name: '研究参数确认' })
    await expect(nextWizard).toBeVisible()
    await expect(nextWizard.getByRole('button', { name: '关闭参数向导' })).toBeFocused()
    await reopened.page.screenshot({ path: path.join(visualEvidence, 'wizard-dark.png'), fullPage: true })
    await reopened.page.evaluate(() => window.theme.setTheme('light'))
    await expect(reopened.page.locator('html')).toHaveAttribute('data-theme-mode', 'light')
    await reopened.page.screenshot({ path: path.join(visualEvidence, 'wizard-light.png'), fullPage: true })
    await nextWizard.press('Escape')
    await expect(nextWizard).not.toBeVisible()
    await expect(composer).toHaveValue(draft)
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ profile, runId: done.run.id,
      rootSessionId: done.session.sessionId, requestsAtStop, totalRequests: provider.requests.length, status: done.run.status }, null, 2))
  } catch (error) {
    const page = app?.windows()[0]
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {})
      fs.writeFileSync(path.join(evidence, 'failure-ui.txt'), await page.locator('body').innerText().catch(() => ''))
    }
    fs.writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify({ profile, error: String(error), clicks }, null, 2))
    throw error
  } finally {
    if (app) await closeResearchApp(app)
    await provider.close()
  }
})
