import { _electron as electron, expect, test } from '@playwright/test'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

test.setTimeout(300000)

type ModelTurn = { kind: 'text'; text: string } | { kind: 'tool'; name: string; input: Record<string, unknown> }

function sse(turn: ModelTurn, model: string, id: number) {
  const content = turn.kind === 'text'
    ? [{ type: 'text', text: turn.text }]
    : [{ type: 'tool_use', id: `fixture-call-${id}`, name: turn.name, input: turn.input }]
  const stopReason = turn.kind === 'text' ? 'end_turn' : 'tool_use'
  const events = [
    { type: 'message_start', message: { id: `fixture-message-${id}`, type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    ...content.flatMap((block, index) => block.type === 'text'
      ? [
          { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } },
          { type: 'content_block_stop', index },
        ]
      : [
          { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } },
          { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } },
          { type: 'content_block_stop', index },
        ]),
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function fixtureEnvironment(profile: string, options: { failFirstRequest?: boolean; drainAsText?: boolean } = {}) {
  const home = path.join(profile, 'home')
  const workspace = path.join(profile, 'workspace')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })

  const turns: ModelTurn[] = [
    { kind: 'tool', name: 'desktop_recruit_agent', input: {
      name: 'archive-specialist', responsibility: 'Archive provenance', goal: 'Establish reliable sources',
      instructions: 'Cite page evidence, report uncertainties, message peers',
    } },
    { kind: 'text', text: 'Team recruited; native planner owns the handoff.' },
    { kind: 'tool', name: 'misaka_research_assign', input: {
      status: 'clarify', plan_markdown: 'Original question: compare archives. Goal: provenance.', tasks: [],
      clarifying_questions: ['Which century?'],
    } },
    { kind: 'text', text: 'Which century should the archive comparison cover?' },
    { kind: 'tool', name: 'misaka_research_assign', input: {
      status: 'clarify', plan_markdown: 'Refine the archive comparison from the supplied period.', tasks: [],
      clarifying_questions: ['Which collection should be examined first?'],
    } },
  ]
  const requests: Array<{ model: string; path: string; messages: unknown }> = []
  let failCount = options.failFirstRequest ? 1 : 0
  const server = http.createServer((request, response) => {
    const pieces: Buffer[] = []
    request.on('data', chunk => pieces.push(Buffer.from(chunk)))
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(pieces).toString('utf8')) as { model: string; messages: unknown }
      requests.push({ model: payload.model, path: request.url || '', messages: payload.messages })
      if (failCount > 0) {
        failCount -= 1
        response.writeHead(400, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fixture transient failure' } }))
        return
      }
      const turn = turns.shift()
      if (!turn) {
        if (!options.drainAsText) {
          response.writeHead(500)
          response.end('Unexpected model request after the bounded clarification fixture.')
          return
        }
        // Settling a stop re-enters the persisted workflow; its tail turns are not the point.
        response.end(sse({ kind: 'text', text: 'Stop recorded; the research run is winding down.' },
          payload.model, requests.length))
        return
      }
      const body = sse(turn, payload.model, requests.length)
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      response.end(body)
    })
  })
  return new Promise<{ home: string; workspace: string; server: http.Server; requests: typeof requests }>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('Fixture server did not bind a TCP port'))
      const providerBase = `http://127.0.0.1:${address.port}/fixture`
      fs.writeFileSync(path.join(home, 'models.json'), JSON.stringify({ providers: { fixture: {
        baseUrl: providerBase, api: 'anthropic-messages', apiKey: 'fixture-not-a-real-key',
        models: [{ id: 'fixture-model', name: 'Fixture Model', reasoning: false, input: ['text'],
          contextWindow: 200000, maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      } } }), 'utf8')
      const settings = { defaultProvider: 'fixture', defaultModel: 'fixture-model', retry: { enabled: false } }
      fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings), 'utf8')
      const profileSettings = path.join(home, 'profiles', 'last_order')
      fs.mkdirSync(profileSettings, { recursive: true })
      fs.writeFileSync(path.join(profileSettings, 'settings.json'), JSON.stringify(settings), 'utf8')
      resolve({ home, workspace, server, requests })
    })
  })
}

/** Windows keeps file handles alive briefly after the process tree exits. */
async function removeProfile(profile: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(profile, { recursive: true, force: true })
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  process.stderr.write(`research e2e: could not remove ${profile}\n`)
}

async function launchIsolatedResearchHost(profile: string, home: string, workspace: string) {
  const app = await electron.launch({ args: [process.cwd()], env: {
    ...process.env,
    MISAKA_OFFLINE: '1',
    MISAKA_HOME: home,
    MISAKA_E2E_USER_DATA: path.join(profile, 'user-data'),
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
    const host = await page.evaluate(async cwd => window.app.startResearchBridge({ cwd }), workspace)
    return { app, page, host }
  } catch (error) {
    await closeIsolatedResearchHost(app).catch(() => {})
    throw error
  }
}

async function closeIsolatedResearchHost(app: Awaited<ReturnType<typeof electron.launch>>) {
  // Active research intentionally intercepts native app.quit for user confirmation.
  // Exercise the same explicit Quit choice on this test's isolated app, not an
  // unfenced app.close that can wait forever on the confirmation dialog.
  const page = app.windows()[0]
  if (page && !page.isClosed()) {
    await page.evaluate(() => window.app.confirmClose('quit')).catch(error => {
      if (!page.isClosed() && app.process().exitCode === null) throw error
    })
  }
  if (app.process().exitCode === null) await app.close()
}

async function researchRequest(page: import('@playwright/test').Page, command: Record<string, unknown>, label?: string) {
  const requestId = String(command.requestId)
  const name = label ?? String(command.type ?? requestId)
  // The deadline runs in the test process: a throttled renderer would never fire a window timer.
  const ack = page.evaluate(async value => await new Promise<any>((resolve, reject) => {
    const unsubscribe = window.researchBridge.on(message => {
      if (!('type' in message) || message.type !== 'ack' || message.requestId !== value.requestId) return
      unsubscribe()
      resolve(message)
    })
    window.researchBridge.send(value)
  }), command)
  let timer: NodeJS.Timeout | undefined
  return Promise.race([ack, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${name}: no ack for ${requestId} within 60s`)), 60000)
  })]).finally(() => clearTimeout(timer))
}

async function waitForRunStatus(page: import('@playwright/test').Page, status: string, deadlineMs = 150000) {
  const seen: string[] = []
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const snapshot = await researchRequest(page, { type: 'get_research_host', requestId: `status-${Date.now()}-${seen.length}` })
    if (!snapshot.ok) throw new Error(`get_research_host failed: ${JSON.stringify(snapshot)}`)
    const current = String(snapshot.data?.run?.status)
    if (seen.at(-1) !== current) seen.push(current)
    if (current === status) return
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  throw new Error(`run never reached ${status}; observed ${JSON.stringify(seen)} while waiting ${deadlineMs}ms`)
}

test('real Electron/Python research host retries a transient local model error', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'misaka-research-retry-e2e-'))
  const resolved = path.resolve(profile)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('misaka-research-retry-e2e-')) {
    throw new Error('Unexpected temporary profile')
  }
  const fixture = await fixtureEnvironment(profile, { failFirstRequest: true })
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    const launched = await launchIsolatedResearchHost(profile, fixture.home, fixture.workspace)
    app = launched.app
    const host = launched.host
    await researchRequest(launched.page, { type: 'set_permission_mode', requestId: 'retry-permission', mode: 'bypassPermissions' })
    const input = { type: 'send_research_message', sessionId: host.session.sessionId,
      requestId: 'same-research-input', text: '请研究历史档案中的证据分歧。\n\n1. 保留多段中文原文\n2. 核对史料与编号要求',
      limits: { max_depth: 0, max_nodes: 1 } }
    const first = await researchRequest(launched.page, input)
    expect(first.ok, JSON.stringify(first)).toBe(false)

    const retried = await researchRequest(launched.page, input)
    expect(retried.ok, JSON.stringify(retried)).toBe(true)
    expect(retried.data).toMatchObject({ accepted: true, requestId: input.requestId, mode: 'start' })
    await expect.poll(() => fixture.requests.length, { timeout: 30000 }).toBeGreaterThanOrEqual(4)
    expect(fixture.requests.every(request => request.model === 'fixture-model')).toBe(true)
    expect(fixture.requests.every(request => request.path === '/fixture/v1/messages')).toBe(true)
    const originalMessages = fixture.requests[0].messages as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
    expect(originalMessages.some(message => message.role === 'user' &&
      (typeof message.content === 'string' ? message.content === input.text :
        message.content.some(block => block.type === 'text' && block.text === input.text)))).toBe(true)
    await waitForRunStatus(launched.page, 'waiting_input')
    const persisted = await researchRequest(launched.page, { type: 'get_research_host', requestId: 'verified-original-input' })
    const questions = persisted.data.messages.filter((message: any) => message.customType === 'research-question')
    expect(questions).toHaveLength(1)
    expect(questions[0].researchSubmission).toMatchObject({ text: input.text, requestId: input.requestId, limits: input.limits })
  } finally {
    if (app) await closeIsolatedResearchHost(app)
    await new Promise<void>(resolve => fixture.server.close(() => resolve()))
    await removeProfile(profile)
  }
})

test('real research host preserves the first token of a resume answer', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'misaka-research-resume-e2e-'))
  const resolved = path.resolve(profile)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith('misaka-research-resume-e2e-')) {
    throw new Error('Unexpected temporary profile')
  }
  const fixture = await fixtureEnvironment(profile)
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    const launched = await launchIsolatedResearchHost(profile, fixture.home, fixture.workspace)
    app = launched.app
    const host = launched.host
    await researchRequest(launched.page, { type: 'set_permission_mode', requestId: 'clarification-cycle-start-permission', mode: 'bypassPermissions' })
    const start = await researchRequest(launched.page, { type: 'send_research_message', sessionId: host.session.sessionId,
      requestId: 'clarification-cycle-start', text: 'Compare the archival evidence', limits: { max_depth: 0, max_nodes: 1 } })
    expect(start.ok, JSON.stringify(start)).toBe(true)
    await waitForRunStatus(launched.page, 'waiting_input')

    const answer = '1805 年以后，从地方档案开始'
    const resumed = await researchRequest(launched.page, { type: 'send_research_message', sessionId: host.session.sessionId,
      requestId: 'clarification-answer', text: `/research resume ${answer}` })
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true)
    expect(resumed.data).toMatchObject({ accepted: true, mode: 'resume' })
    const snapshot = await researchRequest(launched.page, { type: 'get_research_host', requestId: 'after-resume' })
    expect(snapshot.data.messages.some((message: any) => message.requestId === 'clarification-answer' &&
      message.content === answer)).toBe(true)
    await expect.poll(() => fixture.requests.length, { timeout: 30000 }).toBeGreaterThanOrEqual(5)
    expect(JSON.stringify(fixture.requests[4].messages)).toContain(answer)

  } finally {
    if (app) await closeIsolatedResearchHost(app)
    await new Promise<void>(resolve => fixture.server.close(() => resolve()))
    await removeProfile(profile)
  }
})

test('real research host wakes and settles a stop from waiting_input', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'misaka-research-stop-e2e-'))
  const resolved = path.resolve(profile)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith('misaka-research-stop-e2e-')) {
    throw new Error('Unexpected temporary profile')
  }
  const fixture = await fixtureEnvironment(profile, { drainAsText: true })
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    const launched = await test.step('launch an isolated research host', async () =>
      launchIsolatedResearchHost(profile, fixture.home, fixture.workspace))
    app = launched.app
    const host = launched.host
    await test.step('grant the host its research permission mode', async () =>
      researchRequest(launched.page, { type: 'set_permission_mode', requestId: 'stop-cycle-permission', mode: 'bypassPermissions' }))
    const start = await test.step('accept the first research input', async () =>
      researchRequest(launched.page, { type: 'send_research_message', sessionId: host.session.sessionId,
        requestId: 'stop-cycle-start', text: 'Compare the archival evidence', limits: { max_depth: 0, max_nodes: 1 } }))
    expect(start.ok, JSON.stringify(start)).toBe(true)
    await test.step('wait for the clarification', async () => waitForRunStatus(launched.page, 'waiting_input'))

    const snapshot = await test.step('read the waiting run', async () =>
      researchRequest(launched.page, { type: 'get_research_host', requestId: 'before-stop' }))
    const foreign = await researchRequest(launched.page, { type: 'send_research_message',
      sessionId: host.session.sessionId, requestId: 'foreign-stop-target', text: '/stop r_other' })
    expect(foreign.ok, JSON.stringify(foreign)).toBe(false)
    await waitForRunStatus(launched.page, 'waiting_input')
    const stopped = await test.step('request the stop', async () =>
      researchRequest(launched.page, { type: 'send_research_message', sessionId: host.session.sessionId,
        text: '/StOp', requestId: 'stop-waiting-run', runId: snapshot.data?.run?.id }))
    expect(stopped.ok, JSON.stringify(stopped)).toBe(true)
    expect(stopped.data?.mode).toBe('stop')
    await test.step('wait for the stopped settlement', async () => waitForRunStatus(launched.page, 'stopped'))
    const reopened = await launched.page.evaluate(async input => window.app.startResearchBridge(input), {
      cwd: fixture.workspace, sessionFile: host.session.file,
    })
    expect(reopened.session.sessionId).toBe(host.session.sessionId)
    expect(reopened.run).toMatchObject({ id: snapshot.data.run.id, status: 'stopped' })
    expect(reopened.messages?.some(message => message.customType === 'research-final')).toBe(true)
  } finally {
    if (app) await closeIsolatedResearchHost(app)
    await new Promise<void>(resolve => fixture.server.close(() => resolve()))
    await removeProfile(profile)
  }
})
