import type { BridgeMessage } from '../src/types/global'
import type { DesktopResearchTeam, ResearchModelBinding, ResearchTeamSnapshot } from '../src/types/research'
import { useSettingsStore } from '../src/store/useSettingsStore'

let enabled = false
let binding: ResearchModelBinding | null = null
let team: DesktopResearchTeam | null = null
let publish: (snapshot: ResearchTeamSnapshot) => void = () => {}

export const desktopResearchTeamFixture = {
  seed: () => {
    enabled = true
    const model = useSettingsStore.getState().currentModel!
    binding = { effective: { provider: model.provider, modelId: model.modelId }, target: null, epoch: 1, state: 'ready' }
    team = { teamId: 'fixture-team', scene: 'desktop_research', members: [
      { id: 'evidence-expert', name: '证据核验员', kind: 'task_agent', responsibility: '核验公开资料与引用', goal: '整理可复核证据', instructions: '为每项结论附上出处', tools: ['read', 'web_search'], skills: ['evidence-review'], status: 'done', taskIds: ['task-literature'] },
      { id: 'borrowed-reviewer', name: '共享复核员', kind: 'borrowed_sister', sourceId: 'existing-reviewer', responsibility: '复核研究结论', goal: '检查覆盖范围', instructions: '指出遗漏', tools: ['read'], skills: [], status: 'done', taskIds: ['task-literature'], effectiveModel: { provider: 'old-pin', modelId: 'old-model' } },
    ] }
  },
  reset: () => { enabled = false; binding = null; team = null },
  snapshot: (): ResearchTeamSnapshot => enabled ? { team, modelBinding: binding } : {},
  completeSwitch: () => {
    if (!binding?.target) return
    binding = { effective: binding.target, target: null, epoch: binding.epoch, state: 'ready' }
    publish({ team, modelBinding: binding })
  },
  failSwitch: () => {
    if (!binding?.target) return
    binding = { ...binding, state: 'failed', error: '团队成员启动失败' }
    publish({ team, modelBinding: binding })
  },
}

export function handleDesktopResearchTeamCommand(command: any, emit: (message: BridgeMessage) => void, onSnapshot: (snapshot: ResearchTeamSnapshot) => void): boolean {
  publish = onSnapshot
  if (!enabled || !binding || !team) return false
  const ack = (data: unknown) => emit({ type: 'ack', requestId: command.requestId, ok: true, data })
  if (command.type === 'desktop_set_team_model') {
    if (command.action === 'cancel') binding = { effective: binding.effective, target: null, epoch: binding.epoch + 1, state: 'ready' }
    else if (command.provider !== binding.effective.provider || command.modelId !== binding.effective.modelId) {
      binding = { effective: binding.effective, target: { provider: command.provider, modelId: command.modelId }, epoch: binding.epoch + 1, state: 'switching' }
    }
    ack({ team, modelBinding: binding }); publish({ team, modelBinding: binding })
    return true
  }
  if (command.type === 'desktop_retain_roles') {
    const selections = command.selections as Array<{ id: string; name: string }>
    if (selections.some(selection => selection.name === '共享复核员')) {
      emit({ type: 'ack', requestId: command.requestId, ok: false, error: '角色名称已存在' }); return true
    }
    team = { ...team, members: team.members.map(member => {
      const chosen = selections.find(selection => selection.id === member.id)
      return chosen && member.kind === 'task_agent' ? { ...member, retainedAs: chosen.name } : member
    }) }
    ack({ team, modelBinding: binding, receipts: selections }); publish({ team, modelBinding: binding })
    return true
  }
  return false
}
