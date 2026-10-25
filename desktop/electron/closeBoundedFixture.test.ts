import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import type * as Cleanup from '../e2e/electronFixtureCleanup'

/** Transpile the real test-only helper; every process boundary is a fake, never an OS kill. */
function harness(platform = 'win32', cooperative = false) {
  vi.useFakeTimers()
  const profile = path.join(os.tmpdir(), 'misaka-electron-close-e2e-fixture')
  const executable = platform === 'win32' ? 'C:\\fixture\\electron.exe'
    : platform === 'darwin' ? '/Applications/Electron Test.app/Contents/MacOS/Electron' : '/opt/electron/electron'
  const state = { alive: true, birth: platform === 'darwin' ? 'Sun Oct 25 12:00:00 2026' : '638970000000000000', executable, inspectorGone: false,
    queryFails: false, killFails: false, closeHangs: false, exitDelay: 0, disposed: false, coldCim: false, inspectionMs: 0 }
  const parent = { pid: platform === 'win32' ? 33333 : 12345, exitCode: null as number | null, signalCode: null as string | null,
    kill: vi.fn(() => { parent.signalCode = 'SIGKILL'; return true }) }
  let completeClose = () => {}
  const terminated: number[] = []
  const terminate = (pid: number) => {
    terminated.push(pid)
    if (!state.killFails) {
      const exit = () => { state.alive = false; if (!state.closeHangs) completeClose() }
      if (state.exitDelay) setTimeout(exit, state.exitDelay)
      else exit()
    }
  }
  const spawnSync = vi.fn((command: string, args: string[], options: { timeout: number }) => {
    if (command === 'taskkill.exe') {
      expect(args).toEqual(['/PID', '12345', '/T', '/F'])
      terminate(12345)
      return { status: state.killFails ? 1 : 0, stdout: '', stderr: '' }
    }
    if (state.queryFails || state.inspectionMs > options.timeout || (state.coldCim && args.join(' ').includes('Get-CimInstance'))) {
      return { status: null, signal: 'SIGTERM', stdout: '', stderr: 'inspection timed out',
        error: Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
    }
    if (command === 'powershell.exe') {
      expect(args.at(-1)).toMatch(/ProcessId = 12345|GetProcessById\(12345\)/)
      return { status: 0, stdout: state.alive ? JSON.stringify({ executable: state.executable, birth: state.birth }) : '' }
    }
    expect(command).toBe('ps')
    expect(args).toEqual(['-ww', '-p', '12345', '-o', 'lstart=', '-o', 'comm='])
    return { status: state.alive ? 0 : 1,
      stdout: state.alive ? `${state.birth} ${platform === 'linux' ? 'electron' : state.executable}\n` : '' }
  })
  const nativeProcess = { pid: 12345, platform, execPath: executable, env: {
    MISAKA_HOME: path.join(profile, 'home'), MISAKA_E2E_USER_DATA: path.join(profile, 'user-data'),
  }, kill: vi.fn((pid: number, signal: string) => { expect(signal).toBe('SIGKILL'); terminate(pid); return true }) }
  const dialog = { showMessageBox: async (_options: { buttons: string[] }) => ({ response: 2 }) }
  const app = {
    process: () => {
      if (state.disposed) throw new TypeError("Cannot read properties of undefined (reading '_object')")
      return parent
    },
    evaluate: vi.fn(async (callback: (electron: { dialog: typeof dialog }) => unknown) => {
      if (state.inspectorGone) throw new Error('main context closed')
      return callback({ dialog })
    }),
    close: vi.fn(() => {
      if (state.disposed) return Promise.reject(new Error('application disposed'))
      if (cooperative) { state.alive = false; parent.exitCode = 0; state.disposed = true; return Promise.resolve() }
      return new Promise<void>(resolve => { completeClose = () => { state.disposed = true; resolve() } })
    }),
  }
  const source = fs.readFileSync(path.resolve('e2e/electronFixtureCleanup.ts'), 'utf8')
  const javascript = ts.transpile(source, { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true })
  const module = { exports: {} }
  const require = (id: string) => {
    if (id === 'node:child_process') return { spawnSync }
    if (id === 'node:os') return os
    if (id === 'node:path') return path
    if (id === 'node:fs') return {
      readFileSync: (file: string) => {
        expect(file).toBe('/proc/12345/stat')
        if (!state.alive) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
        return `12345 (electron) S ${Array(18).fill('0').join(' ')} ${state.birth} 0`
      },
      readlinkSync: (file: string) => { expect(file).toBe('/proc/12345/exe'); return state.executable },
    }
    throw new Error(`Unexpected process boundary: ${id}`)
  }
  new Function('process', 'require', 'module', 'exports', 'setTimeout', 'clearTimeout', javascript)(
    nativeProcess, require, module, module.exports, setTimeout, clearTimeout)
  const helper = module.exports as typeof Cleanup
  const application = app as unknown as Parameters<typeof helper.closeBounded>[0]
  return { state, parent, nativeProcess, terminated, spawnSync, dialog, app,
    register: () => helper.registerFixtureCleanup(application, profile, path.join(profile, 'home')),
    close: async () => {
      const result = helper.closeBounded(application).then(() => undefined, (error: Error) => error)
      await vi.advanceTimersByTimeAsync(20_000)
      return result
    } }
}

afterEach(() => { vi.useRealTimers() })

it('retains its launch handle even when Playwright disposed app.process before cleanup', async () => {
  const h = harness()
  await h.register()
  h.state.disposed = true
  h.state.inspectorGone = true
  expect(await h.close()).toBeUndefined()
  expect(h.terminated).toEqual([12345])
  expect(h.parent.kill).toHaveBeenCalledOnce()
})

it('captures native identity without starting a cold WMI/CIM provider', async () => {
  const h = harness()
  h.state.coldCim = true
  await expect(h.register()).resolves.toBeUndefined()
})

it('allows Windows inspector startup beyond the measured near-five-second cold envelope', async () => {
  const h = harness()
  h.state.inspectionMs = 6000
  await expect(h.register()).resolves.toBeUndefined()
  expect(h.terminated).toEqual([])
})

it('includes inspection error code, signal, status and stderr rather than hiding the cause', async () => {
  const h = harness()
  h.state.queryFails = true
  await expect(h.register()).rejects.toThrow(/ETIMEDOUT.*status=null.*SIGTERM.*inspection timed out/)
  expect(h.terminated).toEqual([])
})

it('cleans the verified native main tree even when the Windows wrapper has already exited', async () => {
  const h = harness()
  await h.register()
  h.parent.exitCode = 0
  expect(await h.close()).toBeUndefined()
  expect(h.state.alive).toBe(false)
  expect(h.terminated).toEqual([12345])
  expect(h.app.close).toHaveBeenCalledOnce()
  expect(h.parent.kill).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('uses the launch identity after the main inspector has already torn down', async () => {
  const h = harness()
  await h.register()
  h.state.inspectorGone = true
  expect(await h.close()).toBeUndefined()
  expect(h.terminated).toEqual([12345])
  expect(h.parent.kill).toHaveBeenCalledOnce()
})

it.each(['win32', 'linux', 'darwin'])('clears deadlines after a cooperative %s close without force killing', async platform => {
  const h = harness(platform, true)
  await h.register()
  expect(await h.close()).toBeUndefined()
  expect(h.terminated).toEqual([])
  expect(h.parent.kill).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['linux', 'darwin'])('terminates only the identified native PID on %s', async platform => {
  const h = harness(platform)
  await h.register()
  expect(await h.close()).toBeUndefined()
  expect(h.terminated).toEqual([12345])
  expect(h.nativeProcess.kill).toHaveBeenCalledWith(12345, 'SIGKILL')
})

it('overrides leftover cancel/background replies and chooses force exit when offered', async () => {
  const h = harness('win32', true)
  await h.register()
  expect(await h.close()).toBeUndefined()
  expect(await h.dialog.showMessageBox({ buttons: ['停止并退出', '后台继续', '取消'] })).toMatchObject({ response: 0 })
  expect(await h.dialog.showMessageBox({ buttons: ['等待', '取消', '强制退出'] })).toMatchObject({ response: 2 })
})

it.each(['win32', 'linux', 'darwin'])('does not touch a recycled PID with a changed birth on %s', async platform => {
  const h = harness(platform)
  await h.register()
  h.state.birth = platform === 'darwin' ? 'Sun Oct 25 12:01:00 2026' : '638970000000000001'
  expect(await h.close()).toMatchObject({ message: expect.stringContaining('no longer matches') })
  expect(h.terminated).toEqual([])
  expect(h.parent.kill).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not touch a PID whose executable changed', async () => {
  const h = harness()
  await h.register()
  h.state.executable = 'C:\\other\\user.exe'
  expect(await h.close()).toMatchObject({ message: expect.stringContaining('no longer matches') })
  expect(h.terminated).toEqual([])
})

it('waits boundedly for asynchronous signal delivery before checking native exit', async () => {
  const h = harness('linux')
  await h.register()
  h.state.exitDelay = 200
  expect(await h.close()).toBeUndefined()
  expect(h.terminated).toEqual([12345])
  expect(vi.getTimerCount()).toBe(0)
})

it('leaves unknown processes untouched when launch environment is outside the fixture', async () => {
  const h = harness()
  h.nativeProcess.env.MISAKA_HOME = path.join(os.tmpdir(), 'real-user-home')
  await expect(h.register()).rejects.toThrow('exact isolated fixture')
  expect(await h.close()).toMatchObject({ message: expect.stringContaining('not captured') })
  expect(h.terminated).toEqual([])
})

it('does not kill when OS inspection fails', async () => {
  const h = harness()
  await h.register()
  h.state.queryFails = true
  expect(await h.close()).toMatchObject({ message: expect.stringContaining('Inspecting fixture PID') })
  expect(h.terminated).toEqual([])
})

it('reports force-termination failure instead of claiming cleanup succeeded', async () => {
  const h = harness()
  await h.register()
  h.state.killFails = true
  expect(await h.close()).toMatchObject({ message: expect.stringContaining('termination failed') })
  expect(h.state.alive).toBe(true)
})

it('reports a pending Playwright close rather than deferring the hang to worker teardown', async () => {
  const h = harness()
  await h.register()
  h.state.closeHangs = true
  expect(await h.close()).toMatchObject({ message: expect.stringContaining('close remained pending') })
  expect(h.state.alive).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
