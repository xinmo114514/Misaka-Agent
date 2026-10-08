import { afterEach, beforeEach, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { DesktopResearchTeam } from '../DesktopResearchTeam'
import { useSessionStore } from '../../../store/useSessionStore'
import { installResearchBridge } from '../../../lib/researchBridge'
import type { BridgeMessage } from '../../../types/global'

let sent: any[], deliver: (message: BridgeMessage) => void, release: () => void
const expert = { id: 'expert', name: 'Evidence expert', kind: 'task_agent' as const, responsibility: 'Review sources', goal: 'Verify claims', instructions: 'Cite every claim', tools: ['read'], skills: ['analysis'], status: 'done', taskIds: ['task-1'], effectiveModel: { provider: 'pinned', modelId: 'old' } }
const borrowed = { ...expert, id: 'shared', name: 'Shared analyst', kind: 'borrowed_sister' as const, sourceId: 'existing-role' }
const team = { teamId: 'team', scene: 'desktop_research' as const, members: [expert, borrowed] }
beforeEach(() => {
  sent = []
  window.researchBridge = { send: command => sent.push(command), on: callback => { deliver = callback; return () => {} } }
  release = installResearchBridge()
  useSessionStore.setState({ researchBinding: { sessionId: 'root', sessionFile: '/root.jsonl', workspace: '/work', runId: 'run' }, researchTeam: team, researchModelBinding: { effective: { provider: 'team-provider', modelId: 'team-model' }, target: null, epoch: 1, state: 'ready' }, researchTeamEventSeq: 0 })
})
afterEach(() => release())
it('shows real member work and effective team model rather than borrowed model pins', () => {
  render(<DesktopResearchTeam runId="run" done={false} />)
  expect(screen.getByText('Evidence expert')).toBeVisible()
  expect(screen.getAllByText('team-provider/team-model')).toHaveLength(2)
  expect(screen.queryByText('pinned/old')).not.toBeInTheDocument()
  expect(screen.getByText('existing-role')).toBeVisible()
  expect(screen.getAllByText('task-1')).toHaveLength(2)
  fireEvent.click(screen.getAllByText('角色指令与能力')[0])
  expect(screen.getAllByText('Cite every claim')[0]).toBeVisible()
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
})
it('starts retention empty and saves only chosen new name after confirmation', async () => {
  render(<DesktopResearchTeam runId="run" done />)
  const selected = screen.getByRole('checkbox', { name: '保留 Evidence expert' })
  expect(selected).not.toBeChecked()
  expect(screen.getByRole('checkbox', { name: '保留 Shared analyst' })).toBeDisabled()
  expect(screen.getByText('已存在于共享角色')).toBeVisible()
  expect(screen.getByRole('button', { name: '确认保留所选角色' })).toBeDisabled()
  expect(sent).toEqual([])
  fireEvent.click(selected)
  fireEvent.change(screen.getByRole('textbox', { name: 'Evidence expert 的保留名称' }), { target: { value: 'Saved reviewer' } })
  fireEvent.click(screen.getByRole('button', { name: '确认保留所选角色' }))
  expect(sent[0]).toMatchObject({ type: 'desktop_retain_roles', sessionId: 'root', runId: 'run', selections: [{ id: 'expert', name: 'Saved reviewer' }] })
  await act(async () => deliver({ type: 'ack', requestId: sent[0].requestId, ok: true, data: { team: { ...team, members: [{ ...expert, retainedAs: 'Saved reviewer' }, borrowed] }, receipts: [{ id: 'expert', name: 'Saved reviewer' }] } }))
  expect(screen.getByText('已保留为 Saved reviewer')).toBeVisible()
  expect(screen.getByRole('checkbox', { name: '保留 Evidence expert' })).toBeDisabled()
})
it('displays name conflicts without auto-save or overwriting existing roles', async () => {
  render(<DesktopResearchTeam runId="run" done />)
  fireEvent.click(screen.getByRole('checkbox', { name: '保留 Evidence expert' }))
  fireEvent.click(screen.getByRole('button', { name: '确认保留所选角色' }))
  await act(async () => deliver({ type: 'ack', requestId: sent[0].requestId, ok: false, error: '角色名称已存在' }))
  expect(screen.getByRole('alert')).toHaveTextContent('角色名称已存在')
  expect(sent).toHaveLength(1)
  expect(useSessionStore.getState().researchTeam?.members[0].retainedAs).toBeUndefined()
})
it('does not display the currently bound team under a different historical run', () => {
  render(<DesktopResearchTeam runId="historical" done />)
  expect(screen.queryByTestId('desktop-research-team')).not.toBeInTheDocument()
})
