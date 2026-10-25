import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ResearchRunWizard } from './ResearchRunWizard'
import type { ResearchOptionsPayload } from '../../types/research'

const options: ResearchOptionsPayload = { defaults: { max_depth: 3, parallel: 4, sister_parallel: 4, max_followups: 2,
  max_revisions: 2, max_nodes: 30, plan_approval: true }, constraints: { max_depth: { min: 0, max: 12 },
  parallel: { min: 1 }, sister_parallel: { min: 1 }, max_followups: { min: 0, max: 6 }, max_revisions: { min: 0, max: 6 },
  max_nodes: { min: 1, max: 500 }, max_output_tokens: { min: 1024 } }, sisters: [] }
describe('nine-field research run wizard', () => {
  it('passes native seven defaults and optional global/model defaults without fabricating limits', () => {
    const onConfirm = vi.fn()
    render(<ResearchRunWizard options={options} onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '确认并开始研究' }))
    expect(onConfirm).toHaveBeenCalledWith({ max_depth: 3, parallel: 4, sister_parallel: 4, max_followups: 2,
      max_revisions: 2, max_nodes: 30, plan_approval: true })
  })
  it('accepts exact context and output choices and validates numeric bounds', () => {
    const onConfirm = vi.fn()
    render(<ResearchRunWizard options={options} onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('上下文阈值'), { target: { value: '80' } })
    fireEvent.change(screen.getByLabelText('最大输出 token'), { target: { value: '2048' } })
    fireEvent.change(screen.getByLabelText('最大深度'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: '确认并开始研究' }))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ context_threshold: .8, max_output_tokens: 2048, max_depth: 5 }))
  })
})
