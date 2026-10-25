import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createFixtureProvider, makeProfile } from './researchRecruitmentFixture'
import { completeModelFixture } from './researchCompleteModelFixture'
import { closeResearchApp, enterResearch, requestHost, waitStatus } from './researchLifecycleSupport'

test.setTimeout(360_000)

const evidence = path.resolve(process.cwd(), '../.superpowers/sdd/desktop-proxy-settings/electron')

async function openNetworkSettings(page: Page) {
  await page.getByTitle('打开客户端设置').click()
  await page.getByRole('button', { name: '网络与代理', exact: true }).click()
  await expect(page.getByRole('switch', { name: '使用代理', exact: true })).toBeEnabled()
}

async function saveSettings(page: Page) {
  await page.getByRole('button', { name: '保存代理设置', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '代理设置已保存' })).toBeVisible()
  await expect(page.getByRole('button', { name: '保存代理设置', exact: true })).toBeEnabled()
  // Read the durable state through the production JSONL channel, not renderer internals.
  return requestHost(page, 'get_proxy_settings', {}, 'bridge')
}

async function closeOwnedApp(app: ElectronApplication) {
  try { await closeResearchApp(app) }
  catch (error) {
    if (app.process().pid && app.process().exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(app.process().pid), '/T', '/F'], { windowsHide: true })
      else app.process().kill('SIGKILL')
    }
    throw error
  }
}

test('settings choose direct or environment when off, persist a dynamic proxy, and route research workers', async () => {
  const profile = makeProfile('misaka-proxy-settings-')
  const provider = await createFixtureProvider({ profile, chunkChars: 2048,
    respond: completeModelFixture(path.join(profile, 'home')) })
  fs.writeFileSync(path.join(provider.workspace, 'TEST-A.md'), 'TEST A: meeting date 1 March 2020; ten attendees.')
  fs.writeFileSync(path.join(provider.workspace, 'TEST-B.md'), 'TEST B: meeting date 1 March 2020; twelve attendees including two staff.')
  const settingsPath = path.join(provider.home, 'settings.json')
  const initial = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  fs.writeFileSync(settingsPath, JSON.stringify({ ...initial, network: { max_concurrent_sisters: 4 }, fixtureUnrelated: 'retained' }))
  const closedPort = net.createServer()
  closedPort.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => closedPort.once('listening', resolve))
  const closedAddress = closedPort.address()
  if (!closedAddress || typeof closedAddress === 'string') throw new Error('No isolated closed port')

  let forwarded = 0
  const gateway = http.createServer((request, response) => {
    const target = new URL(request.url || '/', `http://127.0.0.1:${provider.port}`)
    // Restrict the fixture proxy to its one local destination.
    if (target.hostname !== '127.0.0.1' || target.port !== String(provider.port)) {
      response.writeHead(403); response.end('fixture destination mismatch'); return
    }
    forwarded += 1
    const upstream = http.request({ hostname: '127.0.0.1', port: provider.port,
      path: target.pathname + target.search, method: request.method,
      headers: { ...request.headers, host: `127.0.0.1:${provider.port}` } }, result => {
      response.writeHead(result.statusCode || 502, result.headers)
      result.pipe(response)
    })
    upstream.on('error', () => { response.writeHead(502); response.end('fixture upstream error') })
    request.pipe(upstream)
  })
  gateway.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => gateway.once('listening', resolve))
  const proxyAddress = gateway.address()
  if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('No isolated proxy port')
  // Keep the refusal-port reservation until the working proxy has bound, so the
  // operating system cannot allocate the same port to these two different paths.
  await new Promise<void>(resolve => closedPort.close(() => resolve()))
  const brokenProxy = `http://127.0.0.1:${closedAddress.port}`
  let launchCount = 0
  const launch = async () => {
    const started = await electron.launch({ args: [process.cwd(), `--user-data-dir=${path.join(profile, 'user-data')}`],
    env: { ...process.env, MISAKA_HOME: provider.home, MISAKA_OFFLINE: '1',
      APPDATA: path.join(profile, 'appdata'), MISAKA_E2E_USER_DATA: path.join(profile, 'user-data'),
      HTTP_PROXY: brokenProxy, http_proxy: brokenProxy, HTTPS_PROXY: brokenProxy, https_proxy: brokenProxy,
      ALL_PROXY: '', all_proxy: '', NO_PROXY: '', no_proxy: '',
    } })
    const logPath = path.join(evidence, `app-${++launchCount}-stderr.log`)
    started.process().stderr?.on('data', (chunk: Buffer) => fs.appendFileSync(logPath, chunk))
    return started
  }
  let app: ElectronApplication | undefined
  let page: Page | undefined
  let failure: unknown
  fs.mkdirSync(evidence, { recursive: true })
  try {
    app = await launch(); page = await app.firstWindow()
    await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
    // The renderer can paint before Python/uv's cold start finishes. Wait for a
    // real read-only JSONL reply, not a guessed sleep or a higher production timeout.
    await requestHost(page, 'get_proxy_settings', {}, 'bridge')
    await openNetworkSettings(page)
    await expect(page.getByRole('switch', { name: '使用代理', exact: true })).not.toBeChecked()
    await expect(page.getByRole('combobox', { name: '关闭代理时' })).toHaveValue('environment')
    await expect(page.getByRole('textbox', { name: '代理端口', exact: true })).toHaveValue('')
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).network.proxy).toBeUndefined()
    await page.getByRole('button', { name: '检查连接', exact: true }).click()
    await expect(page.getByText(/TCP 未连通/)).toBeVisible()
    expect(provider.requests).toHaveLength(0)

    await page.getByRole('combobox', { name: '关闭代理时' }).selectOption('direct')
    const direct = await saveSettings(page)
    expect(direct.settings.whenDisabled).toBe('direct')
    expect(direct.route.mode).toBe('direct')
    const tcp = await requestHost(page, 'check_proxy_connection', {}, 'bridge')
    expect(tcp.reachable).toBe(true)
    expect(provider.requests).toHaveLength(0)
    const response = await requestHost(page, 'test_provider_connectivity', { providerId: 'fixture', modelId: 'fixture-model' }, 'bridge')
    expect(response.ok).toBe(true)
    expect(provider.requests.length).toBeGreaterThan(0)
    expect(forwarded).toBe(0)

    await page.getByRole('switch', { name: '使用代理', exact: true }).check()
    await page.getByRole('textbox', { name: '代理端口', exact: true }).fill(String(proxyAddress.port))
    const custom = await saveSettings(page)
    expect(custom.route.proxy).toBe(`http://127.0.0.1:${proxyAddress.port}`)
    const sentBeforeProbe = provider.requests.length
    await page.getByRole('button', { name: '检查连接', exact: true }).click()
    await expect(page.getByText(/TCP 端口可达/)).toBeVisible()
    expect(provider.requests).toHaveLength(sentBeforeProbe)
    expect(forwarded).toBe(0)
    await requestHost(page, 'test_provider_connectivity', { providerId: 'fixture', modelId: 'fixture-model' }, 'bridge')
    expect(forwarded).toBeGreaterThan(0)

    await page.getByRole('switch', { name: '使用代理', exact: true }).uncheck()
    await page.getByRole('combobox', { name: '关闭代理时' }).selectOption('environment')
    await saveSettings(page)
    const inherited = await requestHost(page, 'check_proxy_connection', {}, 'bridge')
    expect(inherited.route.proxy).toBe(brokenProxy)
    expect(inherited.reachable).toBe(false)
    await page.getByRole('switch', { name: '使用代理', exact: true }).check()
    await saveSettings(page)
    const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(persisted.fixtureUnrelated).toBe('retained')
    expect(persisted.network.max_concurrent_sisters).toBe(4)
    expect(persisted.network.proxy.port).toBe(proxyAddress.port)
    await page.screenshot({ path: path.join(evidence, 'proxy-settings-saved.png'), fullPage: true })
    await closeOwnedApp(app); app = undefined

    app = await launch(); page = await app.firstWindow()
    await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
    await requestHost(page, 'get_proxy_settings', {}, 'bridge')
    await openNetworkSettings(page)
    await expect(page.getByRole('switch', { name: '使用代理', exact: true })).toBeChecked()
    await expect(page.getByRole('textbox', { name: '代理端口', exact: true })).toHaveValue(String(proxyAddress.port))
    await page.getByRole('button', { name: '返回时间线', exact: true }).click()
    const researchStart = forwarded
    await enterResearch(page, app, provider.workspace, 'Compare only TEST-A.md and TEST-B.md in this local proxy fixture.')
    const done = await waitStatus(page, 'done', 180_000)
    expect(forwarded).toBeGreaterThan(researchStart)
    expect(provider.requests.some(request => request.toolNames?.includes('misaka_card_complete'))).toBe(true)
    // Every actual provider request has traversed this selected application proxy.
    expect(provider.requests.length).toBe(forwarded + sentBeforeProbe)
    await page.screenshot({ path: path.join(evidence, 'proxy-research-done.png'), fullPage: true })
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({
      profile, runId: done.run.id, proxyPort: proxyAddress.port, inheritedProxyPort: closedAddress.port,
      providerRequests: provider.requests.length, forwarded, directRequests: sentBeforeProbe, status: done.run.status,
    }, null, 2))
  } catch (error) {
    failure = error
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {})
      fs.writeFileSync(path.join(evidence, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => 'page closed'))
    }
    throw error
  } finally {
    if (app) {
      try { await closeOwnedApp(app) }
      catch (cleanupError) { if (!failure) throw cleanupError }
    }
    gateway.closeAllConnections()
    await new Promise<void>(resolve => gateway.close(() => resolve()))
    await provider.close()
  }
})
