// Runs production renderer services against a real JSONL Python process. Only the model is a fixture.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { JSDOM } from 'jsdom'
import { createFixtureProvider, clarificationTurn, type FixtureTurn } from './researchRecruitmentFixture'

async function main() {
  const profile = process.argv[2]
  const python = process.argv[3]
  assert(profile && python)
  const turns: FixtureTurn[] = [
    { blocks: [{ type: 'tool_use', name: 'desktop_recruit_agent', input: {
      name: 'contract-reader', responsibility: 'Compare the supplied test materials',
      goal: 'Identify shared facts and limitations', instructions: 'Use only the fixture materials.',
    } }] },
    { blocks: [{ type: 'text', text: 'The test reader has been recruited.' }] },
    clarificationTurn(),
    { blocks: [{ type: 'text', text: 'Awaiting the specified test collection.' }] },
    clarificationTurn(),
    { blocks: [{ type: 'text', text: 'Awaiting the specified test collection.' }] },
  ]
  const provider = await createFixtureProvider({ profile, turns, chunkChars: 512 })
  const listeners = new Set<(value: any) => void>()
  const commands: Record<string, any>[] = []
  const acknowledgements: any[] = []
  let stderr = ''
  const child = spawn(python, ['-m', 'misaka', 'desktop-bridge', '--cwd', provider.workspace, '--research-context'], {
    cwd: path.resolve(process.cwd(), '..'),
    env: { ...process.env, MISAKA_HOME: provider.home, MISAKA_OFFLINE: '1',
      APPDATA: path.join(profile, 'appdata'), PYTHONIOENCODING: 'utf-8',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.on('data', value => { stderr += value.toString() })
  const lines = readline.createInterface({ input: child.stdout })
  lines.on('line', line => {
    let value: any
    try { value = JSON.parse(line) } catch { return }
    if (value.type === 'ack') acknowledgements.push(value)
    for (const listener of [...listeners]) listener(value)
  })
  const transport = {
    send(value: Record<string, any>) { commands.push(value); child.stdin.write(`${JSON.stringify(value)}\n`) },
    on(listener: (value: any) => void) { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage, getComputedStyle: dom.window.getComputedStyle })
  Object.assign(dom.window, { bridge: transport, researchBridge: transport,
    app: { async startResearchBridge() { return requestResearch('get_research_host', {}, 60000) } } })
  // Activity/control services now share the real stores. Initialize the browser environment
  // before importing their graph, exactly as the desktop renderer does.
  const { installBridge, request } = await import('../src/lib/bridge')
  const { installResearchBridge, requestResearch } = await import('../src/lib/researchBridge')
  const { startComposerResearch } = await import('../src/lib/startComposerResearch')
  const releaseOrdinary = installBridge()
  const releaseResearch = installResearchBridge()
  const report: Record<string, any> = { profile, workspace: provider.workspace }
  const untilWaiting = async () => {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const host: any = await requestResearch('get_research_host')
      if (host.run?.status === 'waiting_input') return host
      if (host.run?.status === 'failed') throw new Error(`run failed: ${JSON.stringify(host.run)}`)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error('run did not reach waiting_input')
  }
  try {
    // The renderer normally waits for host readiness before allowing Send. This
    // headless harness must do the same instead of spending a normal command's
    // 20s budget importing a fresh Python runtime/profile on a loaded Windows host.
    const initial: any = await requestResearch('get_research_host', {}, 60_000)
    assert.equal(initial.enabled, true)
    assert.equal(initial.run, null)
    assert.equal(provider.requests.length, 0)
    const first = await startComposerResearch({ question: 'Compare the local fixture materials',
      workspace: provider.workspace, startNew: true, requestId: 'contract-first' })
    assert(first.runId)
    const waiting = await untilWaiting()
    assert.equal(waiting.run.id, first.runId)
    const binding = { sessionId: waiting.session.sessionId, sessionFile: waiting.session.file,
      workspace: provider.workspace, runId: first.runId, streamId: waiting.streamId }
    const beforeNew = commands.length
    await assert.rejects(startComposerResearch({ question: 'Different fixture question', workspace: provider.workspace,
      startNew: true, requestId: 'contract-new-blocked' }), /已有研究|研究运行/)
    assert.equal(commands.slice(beforeNew).some(row => row.type === 'send_research_message'), false)
    await assert.rejects(requestResearch('set_model', { provider: 'fixture', modelId: 'fixture-model' }))
    await assert.rejects(requestResearch('set_thinking', { level: 'low' }), /Stop the owning research/)
    const failedSwitch: any = await requestResearch('desktop_set_team_model', { sessionId: binding.sessionId,
      provider: 'fixture', modelId: 'missing-fixture-model', action: 'switch' })
    assert.equal(failedSwitch.modelBinding.state, 'failed')
    const afterFailedSwitch: any = await requestResearch('get_research_host')
    assert.equal(afterFailedSwitch.modelBinding.effective.modelId, 'fixture-model')
    await requestResearch('desktop_set_team_model', { sessionId: binding.sessionId,
      provider: 'fixture', modelId: 'fixture-model', action: 'switch' })
    const beforeFailedSend = commands.length
    await assert.rejects(startComposerResearch({ question: 'Do not admit under a failed model boundary',
      workspace: provider.workspace, binding, requestId: 'contract-model-failed-send',
      model: { provider: 'fixture', modelId: 'missing-fixture-model' } }), /模型|model/i)
    assert.equal(commands.slice(beforeFailedSend).some(row => row.type === 'send_research_message'), false)
    await requestResearch('desktop_set_team_model', { sessionId: binding.sessionId,
      provider: 'fixture', modelId: 'fixture-model', action: 'retry' })
    const beforeFollowup = commands.length
    const followup = await startComposerResearch({ question: 'Use the first fixture collection', workspace: provider.workspace,
      binding, requestId: 'contract-supplement' })
    assert.equal(followup.runId, first.runId)
    assert.equal(commands.slice(beforeFollowup).some(row => ['set_model', 'set_thinking', 'desktop_set_team_model'].includes(row.type)), false)
    await untilWaiting()
    // Replaying the same identity traverses the persisted bridge receipt, not a mock ACK.
    await requestResearch('send_research_message', { text: 'Use the first fixture collection',
      sessionId: binding.sessionId, streamId: binding.streamId, runId: first.runId, requestId: 'contract-supplement' })
    const final: any = await requestResearch('get_research_host')
    // The production snapshot projects native research-input as a normal user row.
    const supplemental = final.messages.filter((row: any) => row.role === 'user'
      && row.requestId === 'contract-supplement')
    assert.equal(supplemental.length, 1)
    const persisted = fs.readFileSync(binding.sessionFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.equal(persisted.filter(row => row.customType === 'research-input'
      && row.details?.requestId === 'contract-supplement').length, 1)
    const receipt = final.submissionReceipts.find((row: any) => row.requestId === 'contract-supplement')
    assert(['accepted', 'applied'].includes(receipt.state))
    const runs: any = await request('get_active_research_runs')
    assert.equal(runs.runs.length, 1)
    report.result = 'passed'
    report.runId = first.runId
    report.sessionId = binding.sessionId
    report.receipt = receipt
    report.modelRequests = provider.requests.length
    report.commands = commands.map(row => ({ type: row.type, requestId: row.requestId }))
    report.acks = acknowledgements.map(row => ({ requestId: row.requestId, ok: row.ok, errorCode: row.errorCode }))
  } catch (error) {
    report.result = 'failed'
    report.error = String(error)
    report.stderr = stderr
    report.commands = commands.map(row => ({ type: row.type, requestId: row.requestId }))
    report.acks = acknowledgements.map(row => ({ requestId: row.requestId, ok: row.ok, error: row.error }))
    throw error
  } finally {
    fs.writeFileSync(path.join(profile, 'contract-report.json'), JSON.stringify(report, null, 2))
    await requestResearch('shutdown', {}, 5000).catch(() => {})
    releaseResearch(); releaseOrdinary()
    child.stdin.end()
    if (child.exitCode === null) {
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))])
      if (child.exitCode === null) child.kill()
    }
    lines.close()
    await provider.close()
    dom.window.close()
  }
}
main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
