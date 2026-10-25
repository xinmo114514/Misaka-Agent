import { _electron as electron, expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  createFixtureProvider, defaultTurns, makeProfile, recruitmentEnvelopes, removeProfile,
  RECRUIT_ARG_BYTES, RECORDED_PACE_MS_PER_CHUNK, INVALID_CALLS,
} from './researchRecruitmentFixture'

test.setTimeout(540_000)

const ARTIFACTS = path.join(process.cwd(), 'preview-artifacts', 'research-freeze')

/**
 * Everything a blocked main thread shows up in: a `setTimeout` that fires late, and animation frames
 * that arrive late. Installed from the test rather than from product code, so what runs is the app.
 */
async function attachProbe(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const state = { macro: [] as number[], raf: [] as number[] }
    ;(window as unknown as { __freezeProbe: typeof state }).__freezeProbe = state
    let rafLast = performance.now()
    const tick = () => {
      const now = performance.now()
      state.raf.push(now - rafLast)
      rafLast = now
      if (state.raf.length > 20000) state.raf.splice(0, state.raf.length - 20000)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    const beat = () => {
      const due = performance.now() + 50
      setTimeout(() => { state.macro.push(performance.now() - due); if (state.macro.length > 20000) state.macro.splice(0, 20000) }, 50)
      setTimeout(beat, 50)
    }
    beat()
  })
}

async function readProbe(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const holder = window as unknown as { __freezeProbe?: { macro: number[]; raf: number[] } }
    const state = holder.__freezeProbe
    if (!state) return { macro: [] as number[], raf: [] as number[] }
    return { macro: state.macro.splice(0, state.macro.length), raf: state.raf.splice(0, state.raf.length) }
  })
}

function percentile(values: number[], q: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
}

function summarize(sample: { macro: number[]; raf: number[] }) {
  const all = [...sample.macro, ...sample.raf]
  return {
    macroCount: sample.macro.length,
    macroP50: Math.round(percentile(sample.macro, 0.5)),
    macroP95: Math.round(percentile(sample.macro, 0.95)),
    macroMax: Math.round(sample.macro.length ? Math.max(...sample.macro) : 0),
    rafP95: Math.round(percentile(sample.raf, 0.95)),
    rafMax: Math.round(sample.raf.length ? Math.max(...sample.raf) : 0),
    stallsOver2s: all.filter(value => value > 2000).length,
  }
}

/** Flatten a CDP CPU profile into self-time per function: the evidence for what actually blocked. */
function topSelfTimes(profile: any) {
  const nodes: any[] = profile?.nodes ?? []
  // V8 records `hitCount` as the samples where the node was the leaf; `samples`/`timeDeltas` on the
  // root give the real interval when they are present.
  const deltas: number[] = profile?.timeDeltas ?? []
  const intervalMs = deltas.length ? deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length / 1000 : 0.5
  const byFrame = new Map<string, { selfMs: number; at: string }>()
  for (const node of nodes) {
    const samples = node.hitCount ?? 0
    if (!samples) continue
    const frame = node.callFrame ?? {}
    const name = frame.functionName || '(anonymous)'
    const key = `${name}@${frame.url ?? ''}`
    const entry = byFrame.get(key) ?? { selfMs: 0, at: `${frame.url ?? ''}:${frame.lineNumber ?? 0}` }
    entry.selfMs += samples * intervalMs
    byFrame.set(key, entry)
  }
  return [...byFrame].sort((a, b) => b[1].selfMs - a[1].selfMs).slice(0, 14)
    .map(([name, info]) => ({ name, selfMs: Math.round(info.selfMs), at: info.at }))
}

async function writeArtifact(name: string, payload: unknown): Promise<string> {
  await fs.promises.mkdir(ARTIFACTS, { recursive: true })
  const file = path.join(ARTIFACTS, name)
  await fs.promises.writeFile(file, JSON.stringify(payload), 'utf8')
  return file
}

async function researchRequest(page: import('@playwright/test').Page, command: Record<string, unknown>): Promise<any> {
  const requestId = String(command.requestId)
  const ack = page.evaluate(async value => await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`no ack for ${value.requestId}`)) }, 60000)
    const unsubscribe = window.researchBridge.on(message => {
      if (!('type' in message) || message.type !== 'ack' || message.requestId !== value.requestId) return
      clearTimeout(timer)
      unsubscribe()
      resolve(message)
    })
    window.researchBridge.send(value)
  }), command)
  let timer: NodeJS.Timeout | undefined
  return Promise.race([ack, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${command.type}: no ack for ${requestId} within 60s`)), 60000)
  })]).finally(() => clearTimeout(timer))
}

async function launchFixtureApp(profile: string, home: string) {
  const app = await electron.launch({ args: [process.cwd()], env: {
    ...process.env,
    MISAKA_OFFLINE: '1',
    MISAKA_HOME: home,
    MISAKA_E2E_USER_DATA: path.join(profile, 'user-data'),
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
  } })
  app.process().stderr?.on('data', chunk => process.stderr.write(String(chunk)))
  const page = await app.firstWindow()
  await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
  return { app, page }
}

async function closeFixtureApp(app: Awaited<ReturnType<typeof electron.launch>>) {
  const page = app.windows()[0]
  if (page && !page.isClosed()) {
    await page.evaluate(() => window.app.confirmClose('quit')).catch(error => {
      if (!page.isClosed() && app.process().exitCode === null) throw error
    })
  }
  if (app.process().exitCode === null) await app.close()
}

/** Put the app into research mode against the fixture workspace, as a reader would. */
async function startFixtureResearch(page: import('@playwright/test').Page, app: Awaited<ReturnType<typeof electron.launch>>, workspace: string) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, workspace)
  await page.getByTitle('选择本地文件夹作为新项目').click()
  await expect.poll(async () => page.evaluate(name => document.querySelector('[data-testid="workspace"]')?.textContent?.includes(name) ?? false, path.basename(workspace))).toBe(true)
  await page.getByTitle('点击切换 Agent 模式').click()
  await page.getByRole('button', { name: /研究模式/ }).click()
  const input = page.getByRole('textbox', { name: '给 Misaka 发送任务' })
  await input.fill('比较这些档案材料对同一事件的分歧记录')
  await input.press('Enter')
}

/** The four things a frozen window cannot do: type, scroll, expand, switch surface. */
async function probeInteractions(page: import('@playwright/test').Page, app: Awaited<ReturnType<typeof electron.launch>>) {
  const timings: Record<string, number> = {}
  const input = page.getByRole('textbox', { name: '给 Misaka 发送任务' })
  let mark = Date.now()
  await input.click()
  await page.keyboard.type('滚动', { delay: 20 })
  await expect(input, 'keystrokes never reached the composer').toHaveValue(/滚动/)
  timings.typeMs = Date.now() - mark
  await input.fill('')

  mark = Date.now()
  await page.mouse.move(420, 420)
  await page.mouse.wheel(0, 420)
  timings.wheelMs = Date.now() - mark
  // Leave the reader back at the tail, where a live run keeps its own row mounted.
  const jump = page.getByRole('button', { name: /回到底部/ })
  if (await jump.count()) await jump.click()

  mark = Date.now()
  const row = page.locator('li[data-tool-status]').first()
  await row.locator('button').click()
  await expect(row.locator('button'), 'a tool row would not open').toHaveAttribute('aria-expanded', 'true', { timeout: 30_000 })
  timings.expandMs = Date.now() - mark

  mark = Date.now()
  await page.keyboard.press('Control+,')
  await expect(page.locator('.conversation-scroll')).toHaveCount(0, { timeout: 30_000 })
  await page.keyboard.press('Control+,')
  await expect(input).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.conversation-scroll')).toHaveCount(1, { timeout: 30_000 })
  timings.viewSwitchMs = Date.now() - mark
  return timings
}

test.describe('research recruitment stream keeps the reader in control', () => {
  test('six parallel recruitments arrive through the real bridge and the surface stays usable', async () => {
    const profile = makeProfile('misaka-research-freeze-e2e-')
    const provider = await createFixtureProvider({
      profile, turns: defaultTurns(), chunkChars: 64, paceMs: RECORDED_PACE_MS_PER_CHUNK,
    })
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined
    const report: Record<string, unknown> = { provider: { home: provider.home, workspace: provider.workspace } }
    try {
      const launched = await launchFixtureApp(profile, provider.home)
      app = launched.app
      const { page } = launched
      await attachProbe(page)
      await startFixtureResearch(page, app, provider.workspace)

      const lane = page.locator('[data-execution-group]').first()
      await expect(lane, 'the recruitment lane never appeared').toBeVisible({ timeout: 180_000 })

      const interactions = await probeInteractions(page, app)
      const during = summarize(await readProbe(page))
      report.realStream = { during, interactions, providerResponses: provider.responses }

      // The recorded first message: six calls, of which the 2nd and 4th failed on their own field.
      await expect(lane.locator('li[data-tool-status="success"]'), 'four of six recorded calls succeeded').toHaveCount(4, { timeout: 120_000 })
      await expect(lane.locator('li[data-tool-status="error"]'), 'the two mis-labelled calls failed alone').toHaveCount(INVALID_CALLS.length, { timeout: 60_000 })
      await expect(lane.locator('li[data-tool-status="pending"], li[data-tool-status="running"]')).toHaveCount(0, { timeout: 60_000 })
      report.realStream.laneStatus = await lane.getAttribute('data-execution-status')

      const host = await researchRequest(page, { type: 'get_research_host', requestId: `freeze-host-${Date.now()}` })
      expect(host.ok, JSON.stringify(host)).toBe(true)
      const sessionId = String(host.data.session.sessionId)
      const streamId = String(host.data.streamId)
      let seq = Number(host.data.lastEventSeq ?? 0) + 1

      // Twenty replays of that message, delivered at the seam the Python bridge uses, with a CPU
      // profile around one of them so the blocking function is named rather than guessed.
      const replaySamples: { macro: number[]; raf: number[] } = { macro: [], raf: [] }
      const rounds: Array<{ envelopes: number; bytes: number; summary: ReturnType<typeof summarize> }> = []
      let profiled = false
      for (let round = 0; round < 20; round += 1) {
        const envelopes = recruitmentEnvelopes({ sessionId, streamId, startSeq: seq, chunkChars: 16,
          timestampBase: 1_760_000_000_000 + round * 1000 })
        seq += envelopes.length
        const bytes = envelopes.reduce((sum, item) => sum + item.mainBytes, 0)
        const cdp = round === 3 ? await page.context().newCDPSession(page) : null
        if (cdp) {
          await cdp.send('Profiler.enable')
          await cdp.send('Profiler.setSamplingInterval', { interval: 500 })
          await cdp.send('Profiler.start')
        }
        const startedAt = Date.now()
        await app.evaluate(({ BrowserWindow }, payloads) => {
          const win = BrowserWindow.getAllWindows()[0]
          for (const payload of payloads) win.webContents.send('research:event', payload)
        }, envelopes)
        const burstMs = Date.now() - startedAt
        // Wait for this round's lane to reach terminal states before measuring the next one.
        const settledLane = page.locator('[data-execution-group]').last()
        await expect.poll(async () => settledLane.locator('li[data-tool-status="success"], li[data-tool-status="error"]').count(),
          { timeout: 90_000, message: `replay ${round} never settled` }).toBe(6)
        const sample = await readProbe(page)
        replaySamples.macro.push(...sample.macro)
        replaySamples.raf.push(...sample.raf)
        const summary = summarize(sample)
        rounds.push({ envelopes: envelopes.length, bytes, summary: { ...summary, burstMs } })
        if (cdp) {
          const { profile: cpu } = await cdp.send('Profiler.stop')
          await writeArtifact('burst-cpu-profile.json', cpu)
          report.profiledRound = { round, hot: topSelfTimes(cpu), burstMs }
          profiled = true
          await cdp.send('Profiler.disable')
        }
      }
      const replaySummary = summarize(replaySamples)
      report.replays = {
        configured: 20, replaySummary, lastRounds: rounds.slice(-6),
        totalBytes: rounds.reduce((sum, round) => sum + round.bytes, 0), profiled,
      }

      // Reading state survives what follows it.
      const keptRow = page.locator('li[data-tool-status]').first()
      await expect(keptRow.locator('button')).toHaveAttribute('aria-expanded', 'true')

      // Diagnostics closed loop: the shell must have written what it saw.
      const diagnosticsDir = path.join(provider.home, 'logs', 'desktop-diagnostics')
      await expect.poll(() => fs.existsSync(diagnosticsDir)
        ? fs.readdirSync(diagnosticsDir).filter(name => name.endsWith('.jsonl')).length : 0, { timeout: 20_000 })
        .toBeGreaterThan(0)
      const lines = fs.readdirSync(diagnosticsDir)
        .flatMap(name => fs.readFileSync(path.join(diagnosticsDir, name), 'utf8').split('\n').filter(Boolean))
      const records = lines.map(line => JSON.parse(line))
      const windows = records.filter(record => record.kind === 'bridge:window')
      report.diagnostics = {
        records: records.length,
        kinds: [...new Set(records.map(record => record.kind))],
        lastBridgeWindow: windows.at(-1) ?? null,
        totals: windows.reduce((sum, record) => sum + Number(record.received ?? 0), 0),
        bytes: windows.reduce((sum, record) => sum + Number(record.bytes ?? 0), 0),
        streamWindows: records.filter(record => record.kind === 'renderer:stream').slice(-4),
      }
      await writeArtifact('freeze-report.json', report)

      expect(replaySummary.macroP95, `replayed p95 macro delay ${replaySummary.macroP95}ms`).toBeLessThan(500)
      expect(replaySummary.macroMax, `replayed max macro delay ${replaySummary.macroMax}ms`).toBeLessThan(2000)
      expect(during.macroP95, `real stream p95 macro delay ${during.macroP95}ms`).toBeLessThan(500)
      expect(during.macroMax, `real stream max macro delay ${during.macroMax}ms`).toBeLessThan(2000)
      expect(interactions.expandMs, `tool expand took ${interactions.expandMs}ms`).toBeLessThan(2000)
      expect(interactions.viewSwitchMs, `surface switch took ${interactions.viewSwitchMs}ms`).toBeLessThan(2000)
    } finally {
      if (app) await closeFixtureApp(app)
      await provider.close()
      await removeProfile(profile)
    }
  })
})
