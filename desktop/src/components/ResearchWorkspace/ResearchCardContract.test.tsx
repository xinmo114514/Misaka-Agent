import { expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { ResearchCardContract } from './ResearchCardContract'

it('labels the closed task disclosure without echoing its title and expands every native instruction', () => {
  const contract = '成员任务 3 · 长上下文跨段整合\nTASK_NATIVE_003 depends on TASK_NATIVE_001.\n' + 'Return evidence and citations. '.repeat(12)
  const { container } = render(<ResearchCardContract contract={contract} />)
  const summary = container.querySelector('summary')!
  expect(summary).toHaveAccessibleName('任务说明')
  expect(summary).not.toHaveTextContent(/成员任务|长上下文/)
  const body = container.querySelector('p')!
  expect(body.textContent).toBe(contract)
  expect(body).not.toBeVisible()
  fireEvent.click(summary)
  expect(body).toBeVisible()
  expect(body).toHaveTextContent('TASK_NATIVE_003 depends on TASK_NATIVE_001.')
})
