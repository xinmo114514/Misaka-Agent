import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { makeProfile } from './researchRecruitmentFixture'
import { launchResearchApp, closeResearchApp, selectWorkspace, requestHost, openHistory, capture, evidence } from './researchLifecycleSupport'

const LIMITS = {max_depth:0,max_nodes:1,parallel:1,sister_parallel:2,max_followups:1,max_revisions:1,plan_approval:false}
const QUESTION = '比较所提供的两份本地研究材料的共同事实、分歧与证据局限。材料是明确标记的测试语料：TEST-A.md 与 TEST-B.md；只研究这两个文件，保留原生审查与最终报告。'

test('real model: two independent reports, then stop, reopen and resume', async () => {
  const source = path.resolve(process.env.MISAKA_RESEARCH_REAL_HOME || path.join(os.homedir(),'.misaka'))
  test.skip(!fs.existsSync(path.join(source,'models.json')) || !fs.existsSync(path.join(source,'settings.json')), 'Existing model configuration is not available; no model calls issued.')
  const profile = makeProfile('misaka-research-real-e2e-')
  const home = path.join(profile,'home'), workspace = path.join(profile,'workspace')
  fs.mkdirSync(home,{recursive:true}); fs.mkdirSync(workspace,{recursive:true}); fs.mkdirSync(evidence,{recursive:true})
  // Only configuration/auth files are copied. Research boards, sessions and user workspace are never adopted.
  fs.copyFileSync(path.join(source,'models.json'),path.join(home,'models.json'))
  const settings = JSON.parse(fs.readFileSync(path.join(source,'settings.json'),'utf8'))
  settings.research = {...settings.research,token_cap:100_000}
  settings.permissionMode = 'bypassPermissions'
  settings.retry = {...settings.retry,enabled:false}
  fs.writeFileSync(path.join(home,'settings.json'),JSON.stringify(settings))
  const credentials = path.join(source,'credentials')
  if (fs.existsSync(credentials)) fs.cpSync(credentials,path.join(home,'credentials'),{recursive:true})
  const profileSettings = path.join(source,'profiles','last_order','settings.json')
  if (fs.existsSync(profileSettings)) {
    const lo = JSON.parse(fs.readFileSync(profileSettings,'utf8'))
    lo.research = {...lo.research,token_cap:100_000}; lo.retry = {...lo.retry,enabled:false}
    fs.mkdirSync(path.join(home,'profiles','last_order'),{recursive:true})
    fs.writeFileSync(path.join(home,'profiles','last_order','settings.json'),JSON.stringify(lo))
  }
  fs.writeFileSync(path.join(workspace,'TEST-A.md'),'# TEST CORPUS A\nFictional test record: the archive meeting happened on 1 March 2020. The recorder counted ten attendees. Counting method is unspecified.\n')
  fs.writeFileSync(path.join(workspace,'TEST-B.md'),'# TEST CORPUS B\nFictional test record: the archive meeting happened on 1 March 2020. The recorder counted twelve attendees, including two staff. No independent witness is recorded.\n')
  fs.writeFileSync(path.join(evidence,'real-profile-identities.json'),JSON.stringify({profile,workspace,limits:LIMITS,tokenCap:100000,wallMinutes:60},null,2))
  let app: Awaited<ReturnType<typeof launchResearchApp>>['app'] | undefined
  const results: Array<Record<string,unknown>> = []
  const save = () => fs.writeFileSync(path.join(evidence,'real-results.json'),JSON.stringify(results,null,2))
  try {
    let launched = await launchResearchApp(profile,home,false); app = launched.app
    await selectWorkspace(launched.page,app,workspace)
    await launched.page.getByTitle('点击切换 Agent 模式').click()
    await launched.page.getByRole('button',{name:/研究模式/}).click()
    await expect(launched.page.getByRole('textbox',{name:'给 Misaka 发送任务'})).toBeVisible()
    // This gate deliberately issues no model request when the production UI has no parameter entry.
    // The archived first invocation was a runtime smoke, not approval of the desktop UX.
    const missingParameterEntry=await launched.page.getByRole('textbox',{name:'研究课题',exact:true}).count() === 0
    if(missingParameterEntry) {
      await capture(launched.page,'real-ui-fixed-parameter-gap')
      fs.writeFileSync(path.join(evidence,'real-ui-gap.json'),JSON.stringify({result:'not-accepted',reason:'fixed-limit-production-UI-entry-missing',modelCalls:0,limits:LIMITS},null,2))
    }
    test.skip(missingParameterEntry,
      'Production desktop has no reachable research parameter form; fixed-limit UI acceptance remains open.')
    let intakeStartedAt = 0
    const start = async (round: number) => {
      await launched.page.getByRole('textbox',{name:'研究课题',exact:true}).fill(QUESTION)
      for (const [label,value] of [['最大深度','0'],['节点并发','1'],['专家并发','2'],['节点上限','1']]) {
        await launched.page.getByRole('spinbutton',{name:label,exact:true}).fill(value)
      }
      const advanced=launched.page.getByRole('button',{name:/高级参数/})
      if(await advanced.getAttribute('aria-expanded')==='false') await advanced.click()
      await launched.page.getByRole('spinbutton',{name:'追加轮次',exact:true}).fill('1')
      await launched.page.getByRole('spinbutton',{name:'结论修订',exact:true}).fill('1')
      await launched.page.getByRole('checkbox',{name:'每份计划与分支汇总均需审批'}).uncheck()
      // The 60-minute cap starts before user intake, including recruitment/startup.
      intakeStartedAt=Date.now()
      await launched.page.getByRole('button',{name:'开始研究',exact:true}).click()
      let host: any
      await expect.poll(async()=>{host=await requestHost(launched.page); return host.run?.id},{timeout:650000}).toBeTruthy()
      await capture(launched.page,`real-${round}-started`,host)
      return host
    }
    const complete = async (round: number, initial: any) => {
      const deadline = intakeStartedAt+3_600_000
      let stage = '', host = initial
      while (Date.now()<deadline) {
        host = await requestHost(launched.page)
        const next = `${host.run?.status}:${host.run?.phase}`
        if (next !== stage) {stage=next; await capture(launched.page,`real-${round}-${stage.replace(/[^a-z0-9_-]/gi,'-')}`,host)}
        if (host.run?.status==='done') {
          await openHistory(launched.page,host.run.id)
          host = await requestHost(launched.page)
          expect(host.reportDelivery?.state).toBe('delivered')
          const rows = fs.readFileSync(host.session.file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line))
          const finals = rows.filter(row=>row.customType==='research-final' && row.details?.run_id===host.run.id && !row.details?.incomplete)
          expect(finals,'The owning persisted root must contain one complete final report for this run').toHaveLength(1)
          const artifact=await requestHost(launched.page,'get_research_artifact',{runId:host.run.id,workspace,artifactId:host.reportDelivery.artifactId},'bridge')
          expect(artifact.detail?.state).toBe('available')
          const body=fs.readFileSync(path.resolve(workspace,artifact.detail.path),'utf8')
          expect(finals[0].content).toBe(body)
          const digest = crypto.createHash('sha256').update(body).digest('hex')
          results.push({round,result:'passed',runId:host.run.id,sessionId:host.session.sessionId,persistedFinalRows:finals.length,reportDigest:digest});save()
          return host
        }
        if (['failed','stopped','partial','waiting_input'].includes(host.run?.status)) {
          await requestHost(launched.page,'stop_research',{runId:host.run.id,workspace})
          results.push({round,result:'not-passed',runId:host.run.id,sessionId:host.session.sessionId,status:host.run.status});save()
          throw new Error(`Real round ${round} reached ${host.run.status}; no automatic rerun`)
        }
        await launched.page.waitForTimeout(2000)
      }
      await requestHost(launched.page,'stop_research',{runId:host.run.id,workspace})
      results.push({round,result:'wall-limit-stopped',runId:host.run.id});save()
      throw new Error(`Real round ${round} reached its 60-minute wall limit; no automatic rerun`)
    }
    const first = await complete(1,await start(1))
    const second = await complete(2,await start(2))
    expect(second.run.id).not.toBe(first.run.id); expect(second.session.sessionId).not.toBe(first.session.sessionId)
    const third = await start(3)
    await requestHost(launched.page,'stop_research',{runId:third.run.id,workspace})
    await expect.poll(async()=>(await requestHost(launched.page)).run?.status).toBe('stopped')
    await capture(launched.page,'real-3-stopped',await requestHost(launched.page))
    await closeResearchApp(app); app=undefined
    launched=await launchResearchApp(profile,home,false);app=launched.app
    await selectWorkspace(launched.page,app,workspace);await openHistory(launched.page,third.run.id)
    const reopened=await requestHost(launched.page)
    expect(reopened.session.sessionId).toBe(third.session.sessionId)
    await requestHost(launched.page,'resume_research',{runId:third.run.id,workspace})
    await complete(3,third)
  } finally {save();if(app) await closeResearchApp(app)}
})
