import { expect, test } from '@playwright/test'

const themes = ['light', 'codex-light', 'claude-light', 'forest-light', 'dark', 'codex-dark', 'claude-dark', 'forest-dark']
const prose = '## 研究工作流\n\n让资料、判断和任务保持清晰的层次。\n\n' + Array.from({ length: 12 }, (_, index) =>
  `### ${index + 1}. 阶段性检查\n\n记录证据来源，比较不同解释，再整理下一步需要验证的问题。\n\n- 保持正文易读\n- 将视觉反馈用于当前操作\n- 完成后复核结论与依据\n`,
).join('\n')

for (const id of themes) {
  test(`${id} blends light into chrome and the populated conversation without losing glass`, async ({ page }, info) => {
    await page.goto('/e2e/conversation.html')
    const input = page.getByRole('textbox', { name: '给 Misaka 发送任务' })
    await expect(input).toBeVisible()
    await page.evaluate(({ id, prose }) => {
      const fixture = (window as any).conversationFixture
      fixture.theme(id)
      fixture.loadHistory([{ id: 'light-blend-message', role: 'assistant', timestamp: 1000, content: prose }])
    }, { id, prose })
    await expect(page.locator('.conversation-scroll')).toBeVisible()
    await expect(page.locator('html')).not.toHaveClass(/theme-switching/)
    await input.evaluate(el => (el as HTMLElement).blur())
    const header = page.locator('header')
    await expect(header).toHaveCSS('backdrop-filter', 'blur(16px)')
    await expect(header).toHaveCSS('box-shadow', 'none')
    await expect(header).toHaveCSS('background-attachment', 'fixed')
    expect(await header.evaluate(el => getComputedStyle(el, '::before').content)).toBe('none')
    const chrome = page.locator('.misaka-glass-chrome')
    const lightPositions = await chrome.evaluateAll(elements => elements.map(el => getComputedStyle(el).backgroundAttachment))
    expect(lightPositions.every(position => position === 'fixed')).toBe(true)

    const composer = page.locator('.conversation-composer')
    await expect(composer).toHaveCSS('backdrop-filter', 'blur(20px)')
    await expect(composer).not.toHaveCSS('background-image', 'none')
    expect(await composer.evaluate(el => getComputedStyle(el).backgroundImage)).not.toContain('linear-gradient')
    const dock = page.locator('.conversation-composer-dock')
    const underlay = await dock.evaluate(el => {
      const style = getComputedStyle(el, '::before')
      return { light: style.backgroundImage, events: style.pointerEvents }
    })
    expect(underlay.light).toContain('linear-gradient')
    expect(underlay.events).toBe('none')
    if (id.includes('light')) {
      await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
      await expect(page.locator('#root > div')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    }
    await page.screenshot({ path: info.outputPath('conversation-light-idle.png') })
    await input.fill('保留光感，让边缘自然融合。')
    await expect(input).toBeFocused()
    await expect(page.getByRole('button', { name: '发送指令 (Enter)', exact: true })).toBeEnabled()
    await page.getByTitle('模型与思考深度').click()
    const picker = page.getByRole('dialog', { name: '模型与思考深度', exact: true })
    await expect(picker).toHaveCSS('backdrop-filter', 'blur(24px)')
    await page.screenshot({ path: info.outputPath('conversation-light-focused.png') })
    await page.keyboard.press('Escape')
    await expect(picker).not.toBeVisible()
    await expect(page.getByTitle('模型与思考深度')).toBeFocused()
  })
}
