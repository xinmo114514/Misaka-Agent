import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { createCloseFlow } from './closeFlow'

interface Child { closed: boolean; stdin: { writable: boolean } }
const child = (closed = false): Child => ({ closed, stdin: { writable: false } })

function cleanupHarness(research: Child | null, ordinary: Child | null) {
  const source = fs.readFileSync(path.resolve('electron/main.ts'), 'utf8')
  const start = source.indexOf('async function stopResearchBridge(')
  const end = source.indexOf('function releaseResearchWaiters(', start)
  const javascript = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 })
  const flowStart = source.indexOf('function installCloseFlow(')
  const flowEnd = source.indexOf('function createWindow(', flowStart)
  const flowJavascript = ts.transpile(source.slice(flowStart, flowEnd), { target: ts.ScriptTarget.ES2022 })
  const quitStart = source.indexOf("app.on('before-quit'")
  const quitJavascript = ts.transpile(source.slice(quitStart, source.indexOf("app.on('quit'", quitStart)), { target: ts.ScriptTarget.ES2022 })
  const wait = vi.fn(async (target: Child) => target.closed)
  const terminate = vi.fn(async (_target: Child) => {})
  const quit = vi.fn()
  const methods = new Function('research', 'ordinary', 'waitForChildExit', 'terminateProcessTree', 'createCloseFlow', 'quit', `
    let researchBridgeProcess = research, bridgeProcess = ordinary;
    let researchBridgeLaunch = { owner: 'original' }, researchHostIdentity = { sessionId: 'original' };
    const TERMINATE_WAIT_MS = 3000, diagnostics = null;
    let closeFlow = null, mainWindow = null, allowClose = false, allowQuit = false;
    let researchActive = true, researchStarting = false;
    const researchWaiters = new Map(), eventHandlers = new Map();
    const app = { on: (event, handler) => eventHandlers.set(event, handler), quit };
    const dialog = { showMessageBox: async options => ({ response: options.message === '研究仍在停止' ? 2 : 0 }) };
    const pathActionError = error => String(error), ensureResearchTray = () => {};
    ${javascript}
    ${flowJavascript}
    ${quitJavascript}
    installCloseFlow();
    return { force: forceTerminateOwnedProcesses, stop: stopResearchBridge,
      replaceResearch: child => { researchBridgeProcess = child; researchBridgeLaunch = {owner:'replacement'}; },
      retry: () => closeFlow.requestClose({skipRenderer:true}), phase: () => closeFlow.phase(),
      idleQuit: event => { researchActive = false; eventHandlers.get('before-quit')(event); },
      state: () => ({ researchBridgeProcess, bridgeProcess, researchBridgeLaunch }) };
  `)(research, ordinary, wait, terminate, createCloseFlow, quit)
  return { ...methods, wait, terminate, quit }
}

it('retains a surviving process after failed force cleanup so another stop still waits for it', async () => {
  const research = child()
  const h = cleanupHarness(research, null)
  expect(await h.force()).toBe(false)
  expect(h.state().researchBridgeProcess).toBe(research)
  h.wait.mockClear()
  expect(await h.stop(50)).toBe(false)
  expect(h.wait).toHaveBeenCalledWith(research, 50)
})

it('clears only the targets whose exit was verified', async () => {
  const research = child(), ordinary = child(true)
  const h = cleanupHarness(research, ordinary)
  expect(await h.force()).toBe(false)
  expect(h.state()).toMatchObject({ researchBridgeProcess: research, bridgeProcess: null })
  research.closed = true
  expect(await h.force()).toBe(true)
  expect(h.state()).toMatchObject({ researchBridgeProcess: null, bridgeProcess: null, researchBridgeLaunch: null })
})

it('does not clear a replacement that appeared while an old child was being verified', async () => {
  const old = child(true), replacement = child()
  const h = cleanupHarness(old, null)
  h.wait.mockImplementationOnce(async () => { h.replaceResearch(replacement); return true })
  expect(await h.force()).toBe(false)
  expect(h.state()).toMatchObject({ researchBridgeProcess: replacement, researchBridgeLaunch: { owner: 'replacement' } })
})

it('continues verifying the other child when termination of one target throws', async () => {
  const research = child(), ordinary = child(true)
  const h = cleanupHarness(research, ordinary)
  h.terminate.mockRejectedValueOnce(new Error('kill failed'))
  expect(await h.force()).toBe(false)
  expect(h.state()).toMatchObject({ researchBridgeProcess: research, bridgeProcess: null })
  expect(h.wait).toHaveBeenCalledWith(ordinary, 3000)
})

it('a second close waits for an ordinary bridge that survived the prior force cleanup', async () => {
  const ordinary = child()
  const h = cleanupHarness(child(true), ordinary)
  expect(await h.force()).toBe(false)
  h.wait.mockClear()
  await h.retry()
  expect(h.quit).not.toHaveBeenCalled()
  expect(h.phase()).toBe('idle')
  expect(h.wait).toHaveBeenCalledWith(ordinary, 1000)
  expect(h.wait).toHaveBeenCalledWith(ordinary, 3000)
  expect(h.state().bridgeProcess).toBe(ordinary)
  ordinary.closed = true
  await h.retry()
  expect(h.quit).toHaveBeenCalledTimes(1)
  expect(h.state().bridgeProcess).toBeNull()
})

it('an idle native quit also verifies a retained ordinary bridge before allowing exit', async () => {
  const ordinary = child()
  const h = cleanupHarness(child(true), ordinary)
  expect(await h.force()).toBe(false)
  const preventDefault = vi.fn()
  h.wait.mockClear()
  h.idleQuit({ preventDefault })
  expect(preventDefault).toHaveBeenCalledTimes(1)
  await vi.waitFor(() => expect(h.phase()).toBe('idle'))
  expect(h.quit).not.toHaveBeenCalled()
  expect(h.wait).toHaveBeenCalledWith(ordinary, 1000)
  expect(h.wait).toHaveBeenCalledWith(ordinary, 3000)
  expect(h.state().bridgeProcess).toBe(ordinary)
})

it('verifies the ordinary bridge tree after its existing bounded cooperative grace expires', async () => {
  const ordinary = child()
  const h = cleanupHarness(null, ordinary)
  h.terminate.mockImplementation(async (target: Child) => { target.closed = true })
  await h.retry()
  expect(h.terminate).toHaveBeenCalledWith(ordinary)
  expect(h.quit).toHaveBeenCalledTimes(1)
  expect(h.state().bridgeProcess).toBeNull()
})
