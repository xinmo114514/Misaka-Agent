import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { completeModelFixture } from './researchCompleteModelFixture'
import { createFixtureProvider, clarificationTurn, makeProfile, type FixtureTurn } from './researchRecruitmentFixture'
import { launchResearchApp, closeResearchApp, enterResearch, selectWorkspace, waitStatus, capture, openHistory, requestHost, evidence } from './researchLifecycleSupport'

test.setTimeout(240_000)
test('normal research entry persists waiting input, stops, and reopens the original history', async () => {
  const profile = makeProfile('misaka-research-lifecycle-e2e-')
  const turns: FixtureTurn[] = [
    {blocks:[{type:'tool_use',name:'desktop_recruit_agent',input:{name:'test-reader',responsibility:'Compare two test sources',goal:'Find common facts and limitations',instructions:'Use only local test materials.'}}]},
    {blocks:[{type:'text',text:'The test reader is ready.'}]}, clarificationTurn(),
    {blocks:[{type:'text',text:'Awaiting the test collection.'}]},
    clarificationTurn(), {blocks:[{type:'text',text:'The resumed research is awaiting the specified collection.'}]},
  ]
  const provider = await createFixtureProvider({profile,turns,chunkChars:512})
  fs.writeFileSync(path.join(provider.workspace,'TEST-MATERIALS.md'),'TEST CORPUS: A records ten attendees. B records twelve; both record the same date.')
  let app: Awaited<ReturnType<typeof launchResearchApp>>['app'] | undefined
  const checkpoint = (stage: string) => console.log(JSON.stringify({stage, profile}))
  try {
    checkpoint('launch')
    const launched = await launchResearchApp(profile,provider.home); app = launched.app
    checkpoint('enter')
    await enterResearch(launched.page,app,provider.workspace,'比较所提供的两份本地测试材料的共同事实、分歧与证据局限')
    checkpoint('wait-input')
    const waiting = await waitStatus(launched.page,'waiting_input')
    expect(waiting.session.file).toBeTruthy()
    expect(fs.existsSync(waiting.session.file)).toBe(true)
    await capture(launched.page,'fixture-waiting-input',waiting)
    checkpoint('stop-click')
    // A bound run renders the research workbench in place of the conversation, so its own stop
    // entry is the one on screen; it confirms once before it ends the cards' attempts.
    await launched.page.getByRole('button',{name:'停止研究',exact:true}).click()
    await launched.page.getByRole('button',{name:'确认停止',exact:true}).click()
    const stopped = await waitStatus(launched.page,'stopped')
    expect(stopped.run.id).toBe(waiting.run.id)
    await capture(launched.page,'fixture-stopped',stopped)
    checkpoint('close')
    await closeResearchApp(app); app = undefined
    const reopened = await launchResearchApp(profile,provider.home); app = reopened.app
    await selectWorkspace(reopened.page,app,provider.workspace)
    checkpoint('reopen-history')
    await openHistory(reopened.page,waiting.run.id)
    const restored = await waitStatus(reopened.page,'stopped')
    expect(restored.session.sessionId).toBe(waiting.session.sessionId)
    expect(restored.run.id).toBe(waiting.run.id)
    await capture(reopened.page,'fixture-history-reopened',restored)
    checkpoint('resume-click')
    const resumeEntry = reopened.page.getByRole('button',{name:'恢复研究',exact:true})
    await expect(resumeEntry).toBeEnabled({ timeout: 30_000 })
    await resumeEntry.click()
    const resumed = await waitStatus(reopened.page,'waiting_input')
    expect(resumed.run.id).toBe(waiting.run.id)
    expect(resumed.session.sessionId).toBe(waiting.session.sessionId)
    await capture(reopened.page,'fixture-resumed',resumed)
    fs.writeFileSync(path.join(evidence,'fixture-result.json'),JSON.stringify({result:'passed',profile,runId:waiting.run.id,sessionId:waiting.session.sessionId,resumedStatus:resumed.run.status,modelRequests:provider.requests.length},null,2))
  } finally {
    if (app) await closeResearchApp(app)
    await provider.close()
    fs.mkdirSync(evidence,{recursive:true})
    fs.writeFileSync(path.join(evidence,'fixture-profile.json'),JSON.stringify({profile,home:provider.home,workspace:provider.workspace},null,2))
  }
})

test('two complete UI research rounds persist verified reports under different roots', async () => {
  test.setTimeout(600000)
  const profile=makeProfile('misaka-research-complete-e2e-')
  const provider=await createFixtureProvider({profile,respond:completeModelFixture(path.join(profile,'home')),chunkChars:512})
  fs.writeFileSync(path.join(provider.workspace,'TEST-A.md'),'TEST CORPUS A: meeting date 1 March 2020; ten attendees, unspecified counting method.')
  fs.writeFileSync(path.join(provider.workspace,'TEST-B.md'),'TEST CORPUS B: meeting date 1 March 2020; twelve attendees including two staff; no independent witness.')
  let app: Awaited<ReturnType<typeof launchResearchApp>>['app'] | undefined
  const step=(stage:string)=>console.log(JSON.stringify({stage,profile}))
  try {
    step('complete-launch')
    const launched=await launchResearchApp(profile,provider.home);app=launched.app
    await enterResearch(launched.page,app,provider.workspace,'比较 TEST-A.md 与 TEST-B.md 这两份测试材料的共同事实、分歧与证据局限')
    const first=await waitStatus(launched.page,'done',240000)
    step('first-business-done')
    await capture(launched.page,'complete-1-done',first)
    await openHistory(launched.page,first.run.id)
    step('first-history-open')
    const delivered=await requestHost(launched.page)
    expect(delivered.reportDelivery?.state).toBe('delivered')
    const artifact=await requestHost(launched.page,'get_research_artifact',{runId:first.run.id,workspace:provider.workspace,artifactId:delivered.reportDelivery.artifactId},'bridge')
    expect(artifact.detail?.state).toBe('available')
    const body=fs.readFileSync(path.resolve(provider.workspace,artifact.detail.path),'utf8')
    const rows=fs.readFileSync(delivered.session.file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line))
    const finals=rows.filter(row=>row.customType==='research-final' && row.details?.run_id===first.run.id && !row.details?.incomplete)
    expect(finals).toHaveLength(1)
    // The native delivery prepends its authoritative header; the registered artifact
    // body must remain exact after that header, not be replaced by a working draft.
    expect(finals[0].content.split('\n---\n\n').slice(1).join('\n---\n\n')).toBe(body)
    step('first-report-verified')
    await launched.page.getByRole('button',{name:'新聊天',exact:true}).click()
    step('new-chat-selected')
    await launched.page.getByTitle('点击切换 Agent 模式').click()
    await launched.page.getByRole('button',{name:/研究模式/}).click()
    step('second-research-mode')
    const input=launched.page.getByRole('textbox',{name:'给 Misaka 发送任务'})
    await input.fill('再次比较 TEST-A.md 与 TEST-B.md 测试材料的共同事实、分歧与证据局限');await input.press('Enter')
    // A new research asks for its engine parameters first, and the composer drops a second send
    // while that dialog is open. The second round must confirm it exactly like the first one.
    const wizard=launched.page.getByRole('dialog',{name:'研究参数确认'})
    await expect(wizard).toBeVisible({timeout:30000})
    await wizard.getByRole('checkbox',{name:'计划审批'}).uncheck()
    await wizard.getByRole('button',{name:'确认并开始研究'}).click()
    // The previous run is `done`, so its host keeps answering until the second one binds. The
    // board is the authority on the new run: read it from the history listing rather than from a
    // host that still describes the finished one.
    let secondId=''
    await expect.poll(async()=>{
      const listing=await requestHost(launched.page,'list_research_runs',{},'bridge').catch(()=>null)
      const runs=(listing?.runs||[]).filter((run:any)=>run.workspace===provider.workspace)
      secondId=runs.map((run:any)=>run.id).find((id:string)=>id!==first.run.id)||''
      return secondId
    },{timeout:180_000,intervals:[2000]}).toBeTruthy()
    const second=await waitStatus(launched.page,'done',240000)
    expect(second.run.id).not.toBe(first.run.id);expect(second.session.sessionId).not.toBe(first.session.sessionId)
    await openHistory(launched.page,second.run.id)
    const secondDelivered=await requestHost(launched.page)
    expect(secondDelivered.reportDelivery?.state).toBe('delivered')
    const secondArtifact=await requestHost(launched.page,'get_research_artifact',{runId:second.run.id,workspace:provider.workspace,artifactId:secondDelivered.reportDelivery.artifactId},'bridge')
    expect(secondArtifact.detail?.state).toBe('available')
    const secondBody=fs.readFileSync(path.resolve(provider.workspace,secondArtifact.detail.path),'utf8')
    const secondRows=fs.readFileSync(secondDelivered.session.file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line))
    const secondFinals=secondRows.filter(row=>row.customType==='research-final' && row.details?.run_id===second.run.id && !row.details?.incomplete)
    expect(secondFinals).toHaveLength(1)
    expect(secondFinals[0].content.split('\n---\n\n').slice(1).join('\n---\n\n')).toBe(secondBody)
    await capture(launched.page,'complete-2-done',second)
    fs.writeFileSync(path.join(evidence,'complete-result.json'),JSON.stringify({result:'passed',profile,firstRun:first.run.id,secondRun:second.run.id,firstRoot:first.session.sessionId,secondRoot:second.session.sessionId,reportSha256:crypto.createHash('sha256').update(body).digest('hex'),modelRequests:provider.requests.length},null,2))
  } catch(error) {
    fs.mkdirSync(evidence,{recursive:true})
    fs.writeFileSync(path.join(evidence,'complete-original-failure.json'),JSON.stringify({profile,error:String(error)},null,2))
    if(app && !app.windows()[0]?.isClosed()) {
      const page=app.windows()[0]
      const host=await requestHost(page).catch(()=>null)
      await capture(page,'complete-failure',host).catch(()=>{})
    }
    throw error
  } finally {
    fs.mkdirSync(evidence,{recursive:true})
    fs.writeFileSync(path.join(evidence,'complete-provider-identities.json'),JSON.stringify({profile,
      requests:provider.requests.map((request,index)=>({index,model:request.model,path:request.path,toolNames:request.toolNames})),
      responses:provider.responses},null,2))
    if(app) await closeResearchApp(app);await provider.close()
  }
})
