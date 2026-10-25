import { expect, it } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { ResearchPaneFooter } from './ResearchPaneFooter'
import type { ResearchSessionTelemetry } from '../../types/research'

const telemetry: ResearchSessionTelemetry = { cwd: 'C:/fixture', tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0 },
  cost: null, cacheHitRate: .5, contextUsage: { tokens: 5, contextWindow: 1000, percent: .5 },
  model: { provider: 'fixture', modelId: 'fixture-model' }, thinkingLevel: 'off', permissionMode: 'default',
  autoCompact: true, compactionCount: 0, subscription: false }

function valueFor(label: string, scope: HTMLElement = document.body) {
  return within(scope).getByText(label, { selector: 'dt' }).nextElementSibling
}

function openDetails() {
  fireEvent.click(screen.getByRole('button', { name: /查看会话详情/ }))
  return screen.getByRole('dialog', { name: /会话详情/ })
}

it('keeps only the observed percentage and details entry in the bar, with metadata in a body portal', () => {
  const { container } = render(<ResearchPaneFooter telemetry={telemetry} />)
  const footer = screen.getByLabelText('会话遥测')
  expect(within(footer).getByText('上下文 0.5%')).toBeVisible()
  expect(within(footer).getByRole('button', { name: '查看会话详情' })).toHaveTextContent('详情')
  expect(footer).not.toHaveTextContent(/fixture|1,000|输入|输出|Token/)
  expect(container.querySelector('details')).toBeNull()
  expect(screen.queryByText('输入 Token')).not.toBeInTheDocument()
  const dialog = openDetails()
  expect(dialog.parentElement).toBe(document.body)
  expect(footer.contains(dialog)).toBe(false)
  for (const name of ['模型', '上下文', '用量', '运行信息']) expect(within(dialog).getByRole('heading', { name })).toBeVisible()
  expect(valueFor('输入 Token', dialog)).toHaveTextContent('10')
  expect(valueFor('缓存命中', dialog)).toHaveTextContent('0.5%')
  expect(valueFor('上下文占用', dialog)).toHaveTextContent('0.5%')
  expect(valueFor('上下文 Token', dialog)).toHaveTextContent('5')
  expect(valueFor('上下文窗口', dialog)).toHaveTextContent('1,000')
  expect(valueFor('自动压缩', dialog)).toHaveTextContent('开启')
  expect(valueFor('工作目录', dialog)).toHaveTextContent('C:/fixture')
  expect(valueFor('模型', dialog)).toHaveTextContent('fixture/fixture-model')
  expect(footer).not.toHaveTextContent(/fixture|1,000|Token/)
})

it('keeps full long model and directory values available in the detached details', () => {
  const model = 'controller-very-long-model-name-reasoning-edition-2026-with-a-complete-identity'
  const cwd = 'C:/workspace/很长的研究目录/with/a/long/path/that/remains/selectable/and/complete'
  render(<ResearchPaneFooter telemetry={{ ...telemetry, model: { provider: 'fixture-provider', modelId: model }, cwd }} sessionLabel="主控" />)
  expect(screen.getByRole('button', { name: '查看会话详情：主控' })).toBeVisible()
  const dialog = openDetails()
  expect(dialog).toHaveAccessibleName('会话详情：主控')
  expect(valueFor('模型', dialog)).toHaveTextContent(`fixture-provider/${model}`)
  expect(valueFor('工作目录', dialog)).toHaveTextContent(cwd)
})

it('shows observed zeroes as zero and unobserved settings as unknown without a question-mark ribbon', () => {
  render(<ResearchPaneFooter telemetry={{ ...telemetry,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 0, cacheHitRate: 0,
    contextUsage: { tokens: 0, contextWindow: 1000, percent: 0 }, model: null, thinkingLevel: null,
    permissionMode: null, autoCompact: false, compactionCount: 0, subscription: false }} />)
  expect(screen.getByLabelText('会话遥测')).toHaveTextContent('上下文 0%')
  expect(screen.getByLabelText('会话遥测')).not.toHaveTextContent('?')
  openDetails()
  for (const label of ['输入 Token', '输出 Token', '缓存读取', '缓存写入', '推理 Token', '压缩次数']) expect(valueFor(label)).toHaveTextContent(/^0$/)
  expect(valueFor('费用')).toHaveTextContent('$0.0000')
  expect(valueFor('缓存命中')).toHaveTextContent('0%')
  expect(valueFor('思考级别')).toHaveTextContent('未知')
  expect(valueFor('权限模式')).toHaveTextContent('未知')
  expect(valueFor('自动压缩')).toHaveTextContent('关闭')
})

it('does not infer unknown context percentage from known token counts, or billing from cost', () => {
  render(<ResearchPaneFooter telemetry={{ ...telemetry, cost: .25,
    contextUsage: { tokens: 5, contextWindow: 1000, percent: null }, model: null,
    thinkingLevel: null, permissionMode: null, autoCompact: null, subscription: null }} />)
  expect(screen.getByLabelText('会话遥测')).toHaveTextContent('上下文 —')
  expect(screen.getByLabelText('会话遥测')).not.toHaveTextContent(/0.5%|1,000|\?/)
  openDetails()
  expect(valueFor('计费')).toHaveTextContent('未知')
  expect(valueFor('费用')).toHaveTextContent('未知')
  expect(valueFor('自动压缩')).toHaveTextContent('未知')
  expect(valueFor('上下文占用')).toHaveTextContent('未知')
  expect(screen.queryByText('$0.2500')).not.toBeInTheDocument()
  expect(screen.queryByText('(sub)')).not.toBeInTheDocument()
})

it('retains subscription billing semantics in details', () => {
  render(<ResearchPaneFooter telemetry={{ ...telemetry, subscription: true, cost: 42 }} />)
  openDetails()
  expect(valueFor('计费')).toHaveTextContent('订阅')
  expect(valueFor('费用')).toHaveTextContent('(sub)')
  expect(screen.queryByText('$42.0000')).not.toBeInTheDocument()
})

it('keeps each pane entry local and its open details current through telemetry updates', () => {
  const view = render(<><ResearchPaneFooter telemetry={telemetry} sessionLabel="主控" /><ResearchPaneFooter telemetry={null} sessionLabel="成员" /></>)
  const first = screen.getByRole('button', { name: '查看会话详情：主控' })
  const second = screen.getByRole('button', { name: '查看会话详情：成员' })
  expect(first).toHaveAttribute('aria-expanded', 'false')
  expect(second).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(first)
  expect(first).toHaveAttribute('aria-expanded', 'true')
  expect(second).toHaveAttribute('aria-expanded', 'false')
  view.rerender(<><ResearchPaneFooter telemetry={{ ...telemetry, tokens: { ...telemetry.tokens, input: 20 } }} sessionLabel="主控" /><ResearchPaneFooter telemetry={null} sessionLabel="成员" /></>)
  expect(first).toHaveAttribute('aria-expanded', 'true')
  expect(valueFor('输入 Token')).toHaveTextContent('20')
  expect(second).toHaveAttribute('aria-expanded', 'false')
})

it('offers a quiet details entry when no telemetry has been observed', () => {
  render(<ResearchPaneFooter telemetry={null} />)
  expect(screen.getByLabelText('会话遥测')).toHaveTextContent('上下文 —')
  expect(screen.getByLabelText('会话遥测')).not.toHaveTextContent('?')
  openDetails()
  expect(screen.getByText('暂无会话遥测')).toBeVisible()
})

it.each(['Escape', 'close button'])('returns focus to the details trigger on %s', action => {
  render(<ResearchPaneFooter telemetry={telemetry} />)
  const trigger = screen.getByRole('button', { name: '查看会话详情' })
  const dialog = openDetails()
  expect(dialog.contains(document.activeElement)).toBe(true)
  if (action === 'Escape') fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  else fireEvent.click(within(dialog).getByRole('button', { name: '关闭会话详情' }))
  expect(screen.queryByRole('dialog', { name: /会话详情/ })).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
})

it.each(['pointer', 'focus'])('dismisses on outside %s without retaining a detached layer', action => {
  render(<><ResearchPaneFooter telemetry={telemetry} /><button>外部目标</button></>)
  openDetails()
  const outside = screen.getByRole('button', { name: '外部目标' })
  if (action === 'pointer') fireEvent.pointerDown(outside)
  else act(() => outside.focus())
  expect(screen.queryByRole('dialog', { name: /会话详情/ })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '查看会话详情' })).toHaveAttribute('aria-expanded', 'false')
  if (action === 'focus') expect(outside).toHaveFocus()
})

it('removes the old session portal when its pane unmounts and starts a new session closed', () => {
  const view = render(<ResearchPaneFooter key="a" telemetry={telemetry} sessionLabel="主控" />)
  openDetails()
  view.rerender(<ResearchPaneFooter key="b" telemetry={null} sessionLabel="成员" />)
  expect(screen.queryByRole('dialog', { name: /会话详情/ })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '查看会话详情：成员' })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText('fixture/fixture-model')).not.toBeInTheDocument()
})
