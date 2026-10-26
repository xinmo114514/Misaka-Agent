import { _electron as electron, expect, type Page, type ElectronApplication } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

export const evidence = process.env.MISAKA_VISUAL_EVIDENCE
  ? path.resolve(process.env.MISAKA_VISUAL_EVIDENCE, 'lifecycle')
  : path.resolve(process.cwd(), '../docs/superpowers/evidence/2026-10-13-desktop-research/task7-electron')
export async function requestHost(page: Page, type = 'get_research_host', fields: Record<string, unknown> = {}, channel: 'researchBridge' | 'bridge' = 'researchBridge', timeout = 60_000): Promise<any> {
  return page.evaluate(async ({type, fields, channel, timeout}) => {
    const transport = window[channel]
    const requestId = `acceptance-${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { release(); reject(new Error(`ACK timeout: ${type}`)) }, timeout)
      const release = transport.on(message => {
        if (!('type' in message) || message.type !== 'ack' || message.requestId !== requestId) return
        clearTimeout(timer); release()
        if (message.ok) resolve(message.data)
        else reject(new Error(`${type}: ${message.error}`))
      })
      transport.send({type, ...fields, requestId})
    })
  }, {type, fields, channel, timeout})
}
export async function launchResearchApp(profile: string, home: string, offline = true) {
  const app = await electron.launch({args:[process.cwd()], env:{...process.env,
    MISAKA_HOME:home, APPDATA:path.join(profile,'appdata'), MISAKA_E2E_USER_DATA:path.join(profile,'user-data'),
    ...(offline ? {MISAKA_OFFLINE:'1', NO_PROXY:'127.0.0.1,localhost', no_proxy:'127.0.0.1,localhost', HTTP_PROXY:'', HTTPS_PROXY:'', ALL_PROXY:'', http_proxy:'', https_proxy:'', all_proxy:''} : {})}})
  const page = await app.firstWindow()
  await expect(page.getByRole('textbox',{name:'给 Misaka 发送任务'})).toBeVisible()
  return {app,page}
}
export async function closeResearchApp(app: ElectronApplication) {
  // These windows own isolated fixture profiles only. A cleanup failure must use
  // the product's native escalation path, not leave a modal masking the test error.
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async(...args:any[])=>{
    const options=args.at(-1)
    const forced=options.buttons?.indexOf('强制退出') ?? -1
    if(forced>=0) console.log(JSON.stringify({stage:'fixture-cleanup-native-force'}))
    return {response:forced>=0?forced:0,checkboxChecked:false}
  }}).catch(()=>{})
  const page = app.windows()[0]
  const bounded = async (operation:Promise<unknown>,label:string) => {
    let timer:ReturnType<typeof setTimeout> | undefined
    try {await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label}: fixture cleanup exceeded 60s`)),60000)})])}
    finally {clearTimeout(timer)}
  }
  if (page && !page.isClosed()) await bounded(page.evaluate(() => window.app.confirmClose?.('quit')).catch(() => {}),'quit')
  if (app.process().exitCode === null) await bounded(app.close(),'Electron exit')
}
export async function enterResearch(page: Page, app: ElectronApplication, workspace: string, question: string) {
  await selectWorkspace(page, app, workspace)
  await page.getByTitle('点击切换 Agent 模式').click()
  await page.getByRole('button',{name:/研究模式/}).click()
  await page.getByRole('textbox',{name:'给 Misaka 发送任务'}).fill(question)
  await page.getByRole('textbox',{name:'给 Misaka 发送任务'}).press('Enter')
  const wizard = page.getByRole('dialog', {name:'研究参数确认'})
  await expect(wizard).toBeVisible()
  await wizard.getByRole('checkbox', {name:'计划审批'}).uncheck()
  await wizard.getByRole('button', {name:'确认并开始研究'}).click()
}
export async function selectWorkspace(page: Page, app: ElectronApplication, workspace: string) {
  await app.evaluate(({dialog}, selected) => {dialog.showOpenDialog = async () => ({canceled:false,filePaths:[selected]})}, workspace)
  await page.getByTitle('选择本地文件夹作为新项目').click()
  await expect(page.locator('[data-testid="workspace"]')).toContainText(path.basename(workspace))
}
export async function waitStatus(page: Page, status: string, timeout = 120_000) {
  const deadline=Date.now()+timeout
  while(Date.now()<deadline) {
    let host: any
    try { host=await requestHost(page) }
    catch (error) {
      // Composer starts its native host asynchronously after Enter. No-host-yet is
      // an expected startup interval, not evidence that the queued input failed.
      if (!String(error).includes('研究桥接进程尚未就绪')) throw error
      await page.waitForTimeout(500)
      continue
    }
    if(host.run?.status===status) return host
    if(['failed','partial'].includes(host.run?.status)) throw new Error(`run ${host.run.id} reached ${host.run.status} while waiting for ${status}`)
    await page.waitForTimeout(1000)
  }
  throw new Error(`Status ${status} was not reached within ${timeout}ms`)
}
export async function capture(page: Page, name: string, host?: any) {
  fs.mkdirSync(evidence,{recursive:true})
  await page.screenshot({path:path.join(evidence,`${name}.png`),fullPage:true})
  if (host) fs.writeFileSync(path.join(evidence,`${name}-identities.json`),JSON.stringify({
    runId:host.run?.id, sessionId:host.session?.sessionId, streamId:host.streamId,
    status:host.run?.status,phase:host.run?.phase, lifecycle:host.lifecycle, reportDelivery:host.reportDelivery,
    receipts:host.submissionReceipts?.map((r:any)=>({requestId:r.requestId,runId:r.runId,state:r.state})),
  },null,2))
}
export async function openHistory(page: Page, runId: string) {
  await page.getByRole('button',{name:'研究历史',exact:true}).click()
  const dialog = page.getByRole('dialog',{name:'研究历史记录'})
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button').filter({hasText:runId}).click()
  await expect(dialog).not.toBeVisible({ timeout: 60_000 })
}

/**
 * Approve the plan the conversation currently shows.
 *
 * The Last Order may still be revising her plan while the card is on screen, and the card fences
 * its approval on the version it displayed. A stale click is refused on purpose ("This plan changed
 * since it was displayed"), so an approval attempt follows the offered 查看最新版本 and retries
 * instead of failing the case for a rule that is working.
 */
export async function approveCurrentPlan(page: Page, attempts = 12) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const approve = page.getByRole('button', { name: '同意', exact: true }).first()
    if (!await approve.count()) {
      await page.waitForTimeout(1500)
      continue
    }
    await approve.click().catch(() => {})
    const stale = page.getByRole('button', { name: /查看最新版本/ }).first()
    try {
      await expect(stale.or(page.getByText('开始执行').first())).toBeVisible({ timeout: 20_000 })
    } catch { return }
    if (!await stale.count()) return
    await stale.click().catch(() => {})
    await page.waitForTimeout(1000)
  }
}
