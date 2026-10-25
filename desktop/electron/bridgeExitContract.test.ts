import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import ts from 'typescript'
import { expect, it } from 'vitest'

const source = fs.readFileSync(path.resolve('electron/main.ts'), 'utf8')

it('waits for owned stdio closure, not only the shell or launcher exit', async () => {
  const start = source.indexOf('function waitForChildExit(')
  const end = source.indexOf('async function terminateProcessTree(', start)
  const javascript = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 })
  const wait = new Function('setTimeout', 'clearTimeout', `${javascript}; return waitForChildExit;`)(setTimeout, clearTimeout)
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null,
    signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() })
  let settled = false
  const result = wait(child, 1000).then((value: boolean) => { settled = true; return value })
  child.exitCode = 0
  child.emit('exit', 0)
  await Promise.resolve()
  expect(settled).toBe(false)
  child.stdout.destroy(); child.stderr.destroy()
  child.emit('close', 0)
  expect(await result).toBe(true)
})

it('launches executable bridges directly on Windows without a command-shell parent', () => {
  expect(source.includes('shell: isWin')).toBe(false)
})

it('does not report an intentional research-bridge replacement as a lost connection', async () => {
  // Replacing the research host (a new run in the same project, or another project) stops the old
  // process cooperatively. Its close handler broadcasts `research_connection_error` whenever an
  // identity is still set, which made the run being started look disconnected (2026-10-18 e2e:
  // the second round started under "研究连接已断开 (0)" and never reached the board).
  const start = source.indexOf('async function stopResearchBridge(')
  const end = source.indexOf('async function forceTerminateOwnedProcesses(', start)
  expect(start).toBeGreaterThan(-1)
  const body = source.slice(start, end)
  expect(body).toContain('researchHostIdentity = null')
  // The identity must be dropped before the child can exit, not after the wait resolves.
  expect(body.indexOf('researchHostIdentity = null')).toBeLessThan(body.indexOf('waitForChildExit'))
})
