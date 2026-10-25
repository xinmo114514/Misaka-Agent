import type { ElectronApplication } from '@playwright/test'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type NativeIdentity = { pid: number; executable: string; birth: string }
type FixtureIdentity = NativeIdentity & { launcher: ReturnType<ElectronApplication['process']> }
const identities = new WeakMap<ElectronApplication, FixtureIdentity>()
// Actual isolated Electron probes measured PowerShell inspection up to 4759ms. Allow twice
// that cold-start envelope for fixture bookkeeping; this is not a product close deadline.
const WINDOWS_INSPECTION_STARTUP_MS = 10_000

async function bounded<T>(operation: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation.catch(() => undefined),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms) }),
    ])
  } finally { clearTimeout(timer) }
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => process.platform === 'win32'
    ? path.resolve(value).toLowerCase() : path.resolve(value)
  return normalize(a) === normalize(b)
}

function processFailure(result: SpawnSyncReturns<string>): string {
  return [result.error && `${(result.error as NodeJS.ErrnoException).code ?? result.error.name}: ${result.error.message}`,
    `status=${result.status}`, `signal=${result.signal}`, `stderr=${result.stderr?.trim() || '(empty)'}`]
    .filter(Boolean).join('; ')
}

/** Exact PID only. Birth identity prevents a recycled PID from inheriting fixture ownership. */
function inspectNative(pid: number): NativeIdentity | undefined {
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      // Fields after the final ')' begin at field 3; starttime is field 22 (boot ticks).
      const birth = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
      if (!birth || !/^\d+$/.test(birth)) throw new Error(`Incomplete identity for fixture PID ${pid}`)
      return { pid, birth, executable: fs.readlinkSync(`/proc/${pid}/exe`) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  if (process.platform === 'win32') {
    // Direct local process access avoids starting WMI/CIM providers during loaded E2E runs.
    const query = `$ErrorActionPreference='Stop'; try{$p=[System.Diagnostics.Process]::GetProcessById(${pid})}catch [System.ArgumentException]{exit 0}; try{@{executable=$p.MainModule.FileName;birth=$p.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json -Compress}catch{if($p.HasExited){exit 0};throw}finally{$p.Dispose()}`
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query],
      { encoding: 'utf8', windowsHide: true, timeout: WINDOWS_INSPECTION_STARTUP_MS })
    if (result.error || result.status !== 0) throw new Error(`Inspecting fixture PID ${pid} failed: ${processFailure(result)}`)
    if (!result.stdout.trim()) return undefined
    const value = JSON.parse(result.stdout) as { executable?: string; birth?: string }
    if (!value.executable || !value.birth) throw new Error(`Incomplete identity for fixture PID ${pid}`)
    return { pid, executable: value.executable, birth: value.birth }
  }
  // macOS ps comm includes the executable path; -ww preserves paths containing spaces.
  const result = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'comm='],
    { encoding: 'utf8', timeout: 5000 })
  if (!result.error && result.status === 1 && !result.stdout.trim()) return undefined
  if (result.error || result.status !== 0) throw new Error(`Inspecting fixture PID ${pid} failed: ${processFailure(result)}`)
  const match = result.stdout.trim().match(/^(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/)
  if (!match) throw new Error(`Incomplete identity for fixture PID ${pid}`)
  return { pid, birth: match[1], executable: match[2] }
}

/** Capture while the inspector is live, before a test can quit/crash its main context. */
export async function registerFixtureCleanup(app: ElectronApplication, profile: string, home: string): Promise<void> {
  // Playwright disposes app.process() with its channel when close completes; keep the owned handle.
  const launcher = app.process()
  const identity = await bounded(app.evaluate(() => ({ pid: process.pid, executable: process.execPath,
    profile: process.env.MISAKA_E2E_USER_DATA, home: process.env.MISAKA_HOME })), 2500)
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0
    || !samePath(path.dirname(profile), os.tmpdir())
    || !path.basename(profile).startsWith('misaka-electron-close-e2e-')
    || !samePath(home, path.join(profile, 'home'))
    || !samePath(identity.home ?? '', home)
    || !samePath(identity.profile ?? '', path.join(profile, 'user-data'))) {
    throw new Error('Electron cleanup requires the exact isolated fixture profile and home')
  }
  const observed = inspectNative(identity.pid)
  if (!observed || !samePath(observed.executable, identity.executable)) {
    throw new Error('Electron fixture main identity did not match its OS process')
  }
  identities.set(app, { ...observed, launcher })
}

/** The Playwright process may be a dead cmd wrapper while its native Electron is still alive. */
export async function closeBounded(app: ElectronApplication): Promise<void> {
  await bounded(app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { buttons?: string[] }
      const force = options.buttons?.indexOf('强制退出') ?? -1
      return { response: force >= 0 ? force : 0, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  }), 2500)
  const close = app.close().then(() => true, () => true)
  let settled = await bounded(close, 8000)
  const identity = identities.get(app)
  if (!identity) throw new Error('Electron fixture main identity was not captured at launch')
  const observed = inspectNative(identity.pid)
  if (observed) {
    if (observed.birth !== identity.birth || !samePath(observed.executable, identity.executable)) {
      throw new Error(`Fixture native PID ${identity.pid} no longer matches its launch identity`)
    }
    if (process.platform === 'win32') {
      const killed = spawnSync('taskkill.exe', ['/PID', String(identity.pid), '/T', '/F'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      if (killed.error || killed.status !== 0) throw new Error(`Fixture native PID ${identity.pid} termination failed: ${processFailure(killed)}`)
    } else {
      // Target only the verified main; Electron's children observe its closed IPC channels.
      try { process.kill(identity.pid, 'SIGKILL') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
    const deadline = Date.now() + 3000
    while (true) {
      const remaining = inspectNative(identity.pid)
      if (!remaining || remaining.birth !== identity.birth) break
      if (Date.now() >= deadline) throw new Error(`Fixture native PID ${identity.pid} remained after termination`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  // The child handle belongs to this launch, not an independently discovered user process.
  const launcher = identity.launcher
  if (launcher.pid !== identity.pid && launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL')
  settled ||= await bounded(close, 3000)
  if (!settled) throw new Error('Playwright fixture close remained pending after native cleanup')
  identities.delete(app)
}
