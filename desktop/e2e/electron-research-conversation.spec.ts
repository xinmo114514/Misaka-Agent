import { _electron as electron, expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('real Electron exposes an authoritative root research host in an empty isolated profile', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'misaka-research-host-e2e-'))
  const tempRoot = path.resolve(os.tmpdir())
  if (path.dirname(path.resolve(profile)) !== tempRoot || !path.basename(profile).startsWith('misaka-research-host-e2e-')) throw new Error('Unexpected temporary profile')
  const home = path.join(profile, 'home')
  const workspace = path.join(profile, 'workspace')
  fs.mkdirSync(home)
  fs.mkdirSync(workspace)
  console.log('Research Electron smoke: launch')
  const app = await electron.launch({ args: [process.cwd()], env: {
    ...process.env, MISAKA_HOME: home, MISAKA_E2E_USER_DATA: path.join(profile, 'user-data'),
  } })
  try {
    app.process().stderr?.on('data', data => console.log(String(data)))
    const page = await app.firstWindow()
    console.log('Research Electron smoke: renderer')
    await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
    const host = await page.evaluate(async cwd => window.app.startResearchBridge({ cwd }), workspace)
    console.log('Research Electron smoke: host snapshot')
    expect(host.enabled).toBe(true)
    expect(host.session.sessionId).toBeTruthy()
    expect(host.session.file).toBeTruthy()
    expect(host.messages).toEqual([])
    expect(host.lastEventSeq).toEqual(expect.any(Number))
    expect(host.streamId).toEqual(expect.any(String))
    expect(host.run).toBeNull()
    expect(host.team?.teamId).toBe(host.session.sessionId)
    expect(host.team?.scene).toBe('desktop_research')
    expect(host.team?.members).toEqual([])
    expect(host.modelBinding?.state).toBe('ready')
    expect(host.modelBinding?.effective.provider).toEqual(expect.any(String))
    expect(host.modelBinding?.effective.modelId).toEqual(expect.any(String))
    const snapshot = await page.evaluate(async () => {
      const requestId = 'real-root-snapshot'
      return await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { stop(); reject(new Error('Snapshot timeout')) }, 15000)
        const stop = window.researchBridge.on(message => {
          if ('type' in message && message.type === 'ack' && message.requestId === requestId) {
            clearTimeout(timer); stop()
            if (message.ok) resolve(message.data)
            else reject(new Error(message.error))
          }
        })
        window.researchBridge.send({ type: 'get_research_host', requestId })
      })
    })
    expect(snapshot.session.sessionId).toBe(host.session.sessionId)
    expect(snapshot.streamId).toBe(host.streamId)
    expect(Array.isArray(snapshot.messages)).toBe(true)
    expect(snapshot.team).toEqual(host.team)
    expect(snapshot.modelBinding.effective).toEqual(host.modelBinding?.effective)
    // Reopen the concrete transcript, not a new research root in the same cwd.
    const reopened = await page.evaluate(async input => window.app.startResearchBridge(input), {
      cwd: workspace, sessionFile: host.session.file,
    })
    expect(reopened.session.sessionId).toBe(host.session.sessionId)
    expect(reopened.team?.teamId).toBe(host.team?.teamId)
    expect(reopened.modelBinding?.effective).toEqual(host.modelBinding?.effective)
    const sharedSisters = path.join(home, 'profiles', 'sisters')
    expect(fs.existsSync(sharedSisters) ? fs.readdirSync(sharedSisters) : []).toEqual([])
  } finally {
    console.log('Research Electron smoke: close')
    await app.close()
    // Only this test's checked, dedicated temp directory is removed.
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 500 })
  }
})
