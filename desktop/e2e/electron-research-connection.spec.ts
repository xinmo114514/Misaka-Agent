import { _electron as electron, expect, test } from '@playwright/test'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createFixtureProvider, makeProfile, type FixtureTurn } from './researchRecruitmentFixture'
import { closeResearchApp, enterResearch, requestHost, waitStatus } from './researchLifecycleSupport'

test.setTimeout(240_000)

for (const mode of ['direct', 'proxy'] as const) {
  test(`startup connection error preserves the question and retries once through ${mode}`, async () => {
    const profile = makeProfile(`misaka-connection-${mode}-`)
    const provider = await createFixtureProvider({ profile, chunkChars: 2048, respond(payload): FixtureTurn {
      const tools = new Set(payload.tools?.map(tool => tool.name))
      const messages = JSON.stringify(payload.messages)
      if (messages.includes('Accepted misaka_research_assign.')) return {
        blocks: [{ type: 'text', text: 'Which fixture source should be checked first?' }],
      }
      if (tools.has('desktop_recruit_agent') && !messages.includes('fixture-connection-reader')) {
        return { blocks: [{ type: 'tool_use', name: 'desktop_recruit_agent', input: {
          name: 'fixture-connection-reader', responsibility: 'Read local fixture sources', goal: 'Compare the fixture materials',
          instructions: 'Use only the local test files and report concrete uncertainty.',
        } }] }
      }
      if (tools.has('misaka_research_assign')) return { blocks: [{ type: 'tool_use', name: 'misaka_research_assign', input: {
        status: 'clarify', plan_markdown: 'Compare the local fixture sources with explicitly bounded evidence.', tasks: [],
        clarifying_questions: ['Which fixture source should be checked first?'],
      } }] }
      return { blocks: [{ type: 'text', text: 'The fixture team is ready; native research planning owns the next step.' }] }
    } })
    let broken = true
    let forwarded = 0
    const gateway = http.createServer((request, response) => {
      if (broken) { request.socket.destroy(); return }
      const parsed = new URL(request.url || '/', `http://127.0.0.1:${provider.port}`)
      // The fixture has exactly one destination; nothing can reach a real provider.
      forwarded += 1
      const upstream = http.request({ hostname: '127.0.0.1', port: provider.port,
        path: parsed.pathname + parsed.search, method: request.method,
        headers: { ...request.headers, host: `127.0.0.1:${provider.port}` } }, result => {
        response.writeHead(result.statusCode || 502, result.headers)
        result.pipe(response)
      })
      upstream.on('error', () => { response.writeHead(502); response.end('fixture upstream error') })
      request.pipe(upstream)
    })
    gateway.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => gateway.once('listening', resolve))
    const address = gateway.address()
    if (!address || typeof address === 'string') throw new Error('fixture gateway did not bind')
    if (mode === 'direct') {
      const file = path.join(provider.home, 'models.json')
      const models = JSON.parse(fs.readFileSync(file, 'utf8'))
      models.providers.fixture.baseUrl = `http://127.0.0.1:${address.port}/fixture`
      fs.writeFileSync(file, JSON.stringify(models))
    }
    const proxy = mode === 'proxy' ? `http://127.0.0.1:${address.port}` : ''
    const launch = () => electron.launch({ args: [process.cwd(), `--user-data-dir=${path.join(profile, 'user-data')}`], env: { ...process.env,
      MISAKA_HOME: provider.home, MISAKA_OFFLINE: '1', APPDATA: path.join(profile, 'appdata'),
      MISAKA_E2E_USER_DATA: path.join(profile, 'user-data'),
      HTTP_PROXY: proxy, http_proxy: proxy, HTTPS_PROXY: proxy, https_proxy: proxy,
      ALL_PROXY: '', all_proxy: '', NO_PROXY: '', no_proxy: '',
    } })
    let app = await launch()
    let page = await app.firstWindow()
    let primaryError: unknown
    const question = `Compare the ${mode} local fixture materials, retaining this exact question after a connection error.`
    try {
      await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
      await enterResearch(page, app, provider.workspace, question)
      const retry = page.getByRole('button', { name: '重试启动', exact: true })
      await expect(retry).toBeVisible({ timeout: 90_000 })
      await expect(page.getByRole('button', { name: '恢复研究', exact: true })).toHaveCount(0)
      const failed = await requestHost(page)
      expect(failed.run).toBeNull()
      const original = failed.messages.find((message: any) => message.role === 'user' && message.content === question)
      expect(original?.errorStage).toBe('recruitment')
      expect(original?.researchSubmission?.text).toBe(question)
      expect(original?.errorDetails?.route?.mode).toBe(mode)
      expect(failed.submissionReceipts).toHaveLength(0)
      await page.getByRole('button', { name: '查看详情', exact: true }).click()
      await expect(page.getByText('fixture / fixture-model', { exact: false }).first()).toBeVisible()
      await page.getByRole('button', { name: '检查连接', exact: true }).click()
      await expect(page.getByText(/TCP.*(可达|连通)|端口可达/).first()).toBeVisible()
      expect(forwarded).toBe(0)
      const evidence = path.resolve(process.cwd(), '../.superpowers/sdd/research-connection-repair/electron')
      fs.mkdirSync(evidence, { recursive: true })
      await page.screenshot({ path: path.join(evidence, `${mode}-startup-error.png`), fullPage: true })
      if (mode === 'proxy') {
        const listed = await requestHost(page, 'list_sessions', {}, 'bridge')
        const root = listed.sessions.find((session: any) => session.id === failed.session.sessionId)
        expect(root?.desktopResearch).toBe(true)
        expect(root?.firstMessage).toBe(question)
        await closeResearchApp(app)
        app = await launch()
        page = await app.firstWindow()
        await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
        await page.getByRole('button', { name: `${question.slice(0, 60)}…`, exact: true }).first().click()
        try {
          await expect(page.getByRole('button', { name: '重试启动', exact: true })).toBeVisible({ timeout: 30_000 })
        } catch (error) {
          await page.screenshot({ path: path.join(evidence, `${mode}-cold-open-error.png`), fullPage: true })
          fs.writeFileSync(path.join(evidence, `${mode}-cold-open-dom.txt`), await page.locator('body').innerText())
          throw error
        }
        const reopened = await requestHost(page)
        expect(reopened.session.sessionId).toBe(failed.session.sessionId)
        expect(reopened.streamId).not.toBe(failed.streamId)
        const restored = reopened.messages.find((message: any) => message.role === 'user' && message.content === question)
        expect(restored.researchSubmission).toEqual(original.researchSubmission)
        expect(forwarded).toBe(0)
        await page.screenshot({ path: path.join(evidence, `${mode}-cold-reopened.png`), fullPage: true })
      }
      broken = false
      await page.getByRole('button', { name: '重试启动', exact: true }).click()
      const ready = await waitStatus(page, 'waiting_input', 90_000)
      expect(ready.session.sessionId).toBe(failed.session.sessionId)
      expect(ready.run.id).toBeTruthy()
      const users = ready.messages.filter((message: any) => (message.role === 'user' && message.content === question) ||
        (message.customType === 'research-question' && message.details?.question === question))
      expect(users).toHaveLength(1)
      expect(users[0].requestId || users[0].details?.requestId).toBe(original.requestId)
      const active = await requestHost(page, 'get_active_research_runs', {}, 'bridge')
      expect(active.runs.filter((run: any) => run.workspace === provider.workspace)).toHaveLength(1)
      expect(forwarded).toBeGreaterThan(0)
      await page.screenshot({ path: path.join(evidence, `${mode}-retry-success.png`), fullPage: true })
      fs.writeFileSync(path.join(evidence, `${mode}-result.json`), JSON.stringify({
        mode, requestId: original.requestId, sessionId: failed.session.sessionId, runId: ready.run.id,
        route: original.errorDetails.route, questionRows: users.length, forwarded,
      }, null, 2))
    } catch (error) {
      primaryError = error
      const evidence = path.resolve(process.cwd(), '../.superpowers/sdd/research-connection-repair/electron')
      fs.mkdirSync(evidence, { recursive: true })
      if (!page.isClosed()) {
        await page.screenshot({ path: path.join(evidence, `${mode}-failure.png`), fullPage: true }).catch(() => {})
        fs.writeFileSync(path.join(evidence, `${mode}-failure-dom.txt`), await page.locator('body').innerText().catch(() => 'page closed'))
      }
      throw error
    } finally {
      broken = false
      try { await closeResearchApp(app) }
      catch (cleanupError) {
        // This PID belongs to this test's isolated Electron instance only. Preserve
        // the original assertion and never leave fixture descendants behind.
        if (app.process().pid && app.process().exitCode === null) {
          if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(app.process().pid), '/T', '/F'], { windowsHide: true })
          else app.process().kill('SIGKILL')
        }
        if (!primaryError) throw cleanupError
      }
      gateway.closeAllConnections()
      await new Promise<void>(resolve => gateway.close(() => resolve()))
      await provider.close()
    }
  })
}
