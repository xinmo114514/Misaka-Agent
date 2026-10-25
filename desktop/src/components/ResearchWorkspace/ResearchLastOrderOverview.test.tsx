import { expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ResearchLastOrderOverview } from './ResearchLastOrderOverview'
import { request } from '../../lib/bridge'
import type { ResearchGraphNode } from '../../types/research'
vi.mock('../../lib/bridge', () => ({ request: vi.fn() }))

it('uses native task IDs and local IDs for duplicate-titled cards instead of joining plan titles', () => {
  vi.mocked(request).mockResolvedValue({ detail: { plan: { tasks: [
    { local_id: 'wrong', title: 'Same title', dependencies: ['wrong-parent'] },
  ] } } })
  const node: ResearchGraphNode = { id: 'n', question: 'Q', depth: 0, status: 'executing', kind: 'root', parents: [], children: [], cards: [
    { id: 'native-parent', local_id: 'C1', dependencies: [], title: 'Same title', status: 'running' },
    { id: 'native-child', local_id: 'C2', dependencies: ['native-parent'], title: 'Same title', status: 'ready' },
  ] }
  render(<ResearchLastOrderOverview runId="r" workspace="C:/fixture" node={node} />)
  expect(screen.getByText('C2 · Same title')).not.toBeVisible()
  fireEvent.click(screen.getByText('研究设计'))
  expect(screen.getByText('C2 · Same title')).toBeInTheDocument()
  expect(screen.getByText('C2 · Same title')).toBeVisible()
  expect(screen.getByText('依赖 C1')).toBeInTheDocument()
  expect(screen.queryByText(/wrong-parent/)).not.toBeInTheDocument()
  expect(request).not.toHaveBeenCalled()
})

it('keeps completed progress readable after the final card finishes', () => {
  const node: ResearchGraphNode = { id: 'finished', question: 'Q', depth: 0, status: 'closed', kind: 'root', parents: [], children: [], cards: [
    { id: 'one', local_id: 'C1', dependencies: [], title: 'Evidence', status: 'done' },
    { id: 'two', local_id: 'C2', dependencies: [], title: 'Synthesis', status: 'done' },
  ] }
  const view = render(<ResearchLastOrderOverview runId="r" workspace="C:/fixture" node={node} />)
  expect(screen.getByText(/已完成 2\/2/)).toBeVisible()
  expect(screen.getByText(/运行中 0/)).toBeVisible()
  view.rerender(<ResearchLastOrderOverview runId="r" workspace="C:/fixture" node={{ ...node, cards: [...node.cards!,
    { id: 'three', local_id: 'C3', dependencies: [], title: 'Follow-up', status: 'running' }] }} />)
  expect(screen.getByText(/已完成 2\/3/)).toBeVisible()
  expect(screen.getByText(/运行中 1/)).toBeVisible()
})
