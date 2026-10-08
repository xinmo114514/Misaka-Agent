"""Scene-scoped recruitment and native task-helper tools for a desktop root."""
from pydantic import BaseModel, ConfigDict, Field

from misaka.core.extensions.types import ToolDefinition
from misaka.core.subagent.agents import AgentDefinition
from misaka.core.subagent.runtime import format_sync_result


class RecruitAgent(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    name: str = Field(description='Unique task-local roster ID chosen for the expertise needed')
    responsibility: str = Field(description='Specialized responsibility and good task fits')
    goal: str = Field(description='Concrete task goal and evidence standard')
    instructions: str = Field(description='Role working instructions, evidence and peer-messaging boundaries')
    tools: list[str] | None = Field(default=None, description='Optional subset of current available tools')
    skills: list[str] | None = Field(default=None, description='Optional native skill references')
    source_id: str | None = Field(default=None, description='Optional existing shared Sister to borrow without changing it')


class RunMember(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    member_id: str = Field(description='Task-local member UUID or native roster name')
    description: str
    prompt: str = Field(description='A bounded helper task, not a replacement for native research cards')


def _data(model, raw):
    return model.model_validate(raw).model_dump()


def _text(value, details):
    return {'content': [{'type': 'text', 'text': value}], 'details': details}


def desktop_team_tools(controller):
    async def recruit(_call_id, raw, _signal, _update, _context):
        member = await controller.recruit(**_data(RecruitAgent, raw))
        return _text('Task-local member registered: ' + member['name'], {'member': member})

    async def run_member(call_id, raw, signal, update, context):
        arguments = _data(RunMember, raw)
        member = next((item for item in controller.team.snapshot()['team']['members']
                       if arguments['member_id'] in {item['id'], item['name']}), None)
        if member is None:
            raise ValueError('Recruit the role before assigning a helper task')
        definition = AgentDefinition(name=member['name'], description=member['responsibility'],
            prompt=('Scene: desktop_research. You are a task-local member reporting to the original root.\n'
                    + member['instructions'] + '\nGoal: ' + member['goal'] + '\n'
                    'Ground claims in source artifacts; identify uncertainties; message peers about evidence gaps. '
                    'Native research cards, board ownership, phase ordering and budgets remain driver-owned.'),
            tools=member['tools'] or None, skills=member['skills'], model='inherit', source='inline')
        manager = controller.manager
        task = await manager.create_task(definition=definition, description=arguments['description'],
            prompt=arguments['prompt'], model=None, background=False, name=None, isolation=None, cwd=None,
            tool_call_id=call_id, context=context, on_update=update)
        controller.team.update_member(member['id'], status='running', instances=[task.id])
        await controller._emit('desktop-team')
        try:
            await manager.run_foreground(task, arguments['prompt'], signal)
            result = task.completed_result()
            return _text(format_sync_result(result), result)
        finally:
            controller.team.update_member(member['id'], status=task.status, instances=[task.id])
            await controller._emit('desktop-team')

    return [ToolDefinition(name='desktop_recruit_agent', label='Recruit task specialist',
        description='Register a model-chosen specialized role in this desktop research team. '
                    'Borrow existing Sisters with source_id; shared definitions are untouched. '
                    'Use before first research planning or later for genuinely missing expertise.',
        parameters=RecruitAgent, execute=recruit,
        promptSnippet='Recruit specialized task-local research roles'),
        ToolDefinition(name='desktop_run_member', label='Run task helper',
        description='Run a bounded helper using the native SubagentManager. Formal research cards '
                    'are created and settled only by the native workflow; this tool does not edit the board.',
        parameters=RunMember, execute=run_member)]
