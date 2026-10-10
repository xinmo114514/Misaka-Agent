import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/conversation.html')
  await expect(page.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBeVisible()
})

function historyProjection() {
  const root = path.resolve('..')
  return JSON.parse(execFileSync(path.join(root, '.venv/Scripts/python.exe'), ['-c',
    'import json,sys; from misaka.cli.desktop_bridge import _serialize_session_entries; print(json.dumps(_serialize_session_entries(json.load(open(sys.argv[1],encoding="utf-8"))["entries"]),ensure_ascii=False))',
    path.join(root, 'tests/fixtures/desktop_conversation.json')], { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1' } }))
}

test('live event replay agrees with reopened history and preserves intermediate replies', async ({ page }) => {
  await page.evaluate(() => (window as any).conversationFixture.replay())
  await expect(page.getByRole('table')).toBeVisible()
  await expect(page.getByText('先读取文件。')).toBeVisible()
  await expect(page.getByText('读取请求已发出。')).toBeVisible()
  await expect(page.getByText('读取完成，继续检索。')).toBeVisible()
  const snapshot = await page.evaluate(() => (window as any).conversationFixture.snapshot())
  expect(snapshot.busy).toBe(false)
  expect(snapshot.messages.filter((m: any) => m.role === 'assistant').map((m: any) => m.content)).toEqual([
    '先读取文件。读取请求已发出。', '读取完成，继续检索。', '总结：\n\n| 文件 | 状态 |\n| --- | --- |\n| fixture.md | 已读取 |',
  ])
  await page.evaluate(messages => (window as any).conversationFixture.loadHistory(messages), historyProjection())
  const reopened = await page.evaluate(() => (window as any).conversationFixture.snapshot())
  // Elapsed clocks are observed live and a transcript cannot carry them; everything else must agree.
  const transcript = (list: any[]) => list.map((m: any) => [m.role, m.content, m.thinking, (m.toolCalls ?? []).map(({ startedAt, endedAt, ...rest }: any) => rest)])
  expect(transcript(reopened.messages)).toEqual(transcript(snapshot.messages))
  await expect(page.getByRole('table')).toBeVisible()
  await page.screenshot({ path: 'test-results/conversation-light.png', animations: 'disabled' })
  await page.evaluate(() => (window as any).conversationFixture.theme('dark'))
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.screenshot({ path: 'test-results/conversation-dark.png', animations: 'disabled' })
})

test('thinking folds at completion and manual choice survives the stream', async ({ page }) => {
  await page.evaluate(() => (window as any).conversationFixture.replay(5))
  const thought = page.getByRole('button', { name: /深度思考/ })
  await expect(thought).toHaveAttribute('aria-expanded','true')
  await thought.click()
  await expect(thought).toHaveAttribute('aria-expanded','false')
  await page.evaluate(() => (window as any).conversationFixture.emit({ type:'message_update', message:{role:'assistant',timestamp:1001,content:[{type:'thinking',thinking:'继续检查资料。'}]}, assistantMessageEvent:{type:'thinking_delta',contentIndex:0,delta:'继续检查资料。'} }))
  await expect(thought).toHaveAttribute('aria-expanded','false')
  await page.evaluate(() => {
    (window as any).conversationFixture.reset()
    ;(window as any).conversationFixture.replay(5)
  })
  await expect(thought).toHaveAttribute('aria-expanded','true')
  await page.evaluate(() => (window as any).conversationFixture.emit({type:'message_update',message:{role:'assistant',timestamp:1001,content:[{type:'thinking',thinking:'先检查文件。'}]},assistantMessageEvent:{type:'thinking_end',contentIndex:0,content:'先检查文件。'}}))
  await expect(thought).toHaveAttribute('aria-expanded','false')
})

test('scrolled-up reading is stable while new tokens arrive and historical tools expand', async ({ page }) => {
  await page.evaluate(() => (window as any).conversationFixture.seedHistory(24))
  const scroll = page.locator('.conversation-scroll')
  await expect.poll(() => scroll.evaluate(e => e.scrollHeight-e.scrollTop-e.clientHeight)).toBeLessThan(3)
  await scroll.evaluate(e => { e.scrollTop = Math.floor(e.scrollHeight/3); e.dispatchEvent(new Event('scroll')) })
  await expect(page.getByRole('button', {name:'回到底部'})).toBeVisible()
  const before = await scroll.evaluate(e => e.scrollTop)
  await page.evaluate(() => {
    const f = (window as any).conversationFixture
    f.emit({type:'agent_start'})
    f.emit({type:'message_start',message:{role:'assistant',content:[],timestamp:2000}})
    f.emit({type:'message_update',message:{role:'assistant',content:[{type:'text',text:'正在生成新内容。'}],timestamp:2000},assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'正在生成新内容。'}})
  })
  await expect(page.getByText('正在生成新内容。')).toBeAttached()
  expect(Math.abs(await scroll.evaluate(e => e.scrollTop)-before)).toBeLessThan(3)
  const toggle = page.getByRole('button',{name:/读取文件.*完成/}).nth(7)
  await toggle.scrollIntoViewIfNeeded()
  const anchor = toggle.locator('xpath=ancestor::*[@data-message-anchor]')
  const offset = await anchor.evaluate(e => e.getBoundingClientRect().top)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded','true')
  expect(Math.abs(await anchor.evaluate(e => e.getBoundingClientRect().top)-offset)).toBeLessThan(3)
})

test('multiline composer reserves actual space and narrow window has no horizontal overflow', async ({ page }) => {
  await page.evaluate(() => (window as any).conversationFixture.replay())
  const form = page.locator('.conversation-composer')
  const input = page.getByRole('textbox',{name:'给 Misaka 发送任务'})
  const before = await form.evaluate(e => e.getBoundingClientRect().height)
  await input.fill('任务第一行\n第二行\n第三行\n第四行\n第五行\n第六行')
  await expect.poll(() => form.evaluate(e => e.getBoundingClientRect().height)).toBeGreaterThan(before+30)
  const height = await form.evaluate(e => e.getBoundingClientRect().height)
  expect(await page.locator('.conversation-composer-spacer').evaluate(e => e.getBoundingClientRect().height)).toBeGreaterThan(height+40)
  const final = page.getByRole('table')
  expect((await final.boundingBox())!.y + (await final.boundingBox())!.height).toBeLessThan((await form.boundingBox())!.y)
  await page.setViewportSize({width:620,height:900})
  await expect(input).toBeVisible()
  expect(await scrollWidth(page)).toBeLessThanOrEqual(1)
  await page.screenshot({ path:'test-results/conversation-narrow.png', animations:'disabled' })
})

async function scrollWidth(page: import('@playwright/test').Page) {
  return page.locator('.conversation-scroll').evaluate(e=>e.scrollWidth-e.clientWidth)
}

test('IME composition and Shift+Enter do not submit, normal Enter submits once', async ({ page }) => {
  const input=page.getByRole('textbox',{name:'给 Misaka 发送任务'})
  await input.fill('中文任务')
  await input.dispatchEvent('compositionstart')
  await input.dispatchEvent('keydown',{key:'Enter',keyCode:229,isComposing:true,bubbles:true})
  await input.dispatchEvent('compositionend')
  await input.press('Shift+Enter')
  expect(await page.evaluate(() => (window as any).conversationFixture.sent.filter((c:any)=>c.type==='prompt').length)).toBe(0)
  await input.press('Enter')
  expect(await page.evaluate(() => (window as any).conversationFixture.sent.filter((c:any)=>c.type==='prompt').length)).toBe(1)
})
