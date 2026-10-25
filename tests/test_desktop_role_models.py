import asyncio
import json
import sys
from types import SimpleNamespace

import pytest

from misaka.desktop_research.model_policy import (
    DesktopRoleModelPolicy,
    DesktopTeamModelPolicy,
    ModelPolicyPaused,
)
from misaka.desktop_research.runtime import DesktopExecutionScope, desktop_child_argv
from misaka.desktop_research.worker_entry import (
    parse_worker_args,
    validate_worker_binding,
)


async def test_role_switch_does_not_pause_other_live_role(tmp_path):
    p = DesktopRoleModelPolicy(tmp_path / 'policy.json', 'sister', 'old', lo_provider='lo', lo_model='small')
    assert p.guard_model(role='last_order')['modelId'] == 'small'
    assert p.guard_model(role='sister')['modelId'] == 'old'
    p.register_executor('root', role='last_order')
    p.register_executor('card', role='sister')
    root_ticket = p.begin_request('root', role='last_order')
    result = await p.switch('sister', 'new', role='sister', timeout=.3)
    assert result['state'] == 'ready'
    assert p.begin_request('root', role='last_order')['modelId'] == 'small'
    assert p.begin_request('card', role='sister')['modelId'] == 'new'
    p.end_request(root_ticket)


def test_old_policy_migrates_both_roles_from_saved_pair(tmp_path):
    path = tmp_path / 'policy.json'
    DesktopTeamModelPolicy(path, 'saved', 'pair')
    again = DesktopRoleModelPolicy(path, 'new', 'selection', lo_provider='lo', lo_model='small')
    assert again.guard_model(role='last_order')['modelId'] == 'pair'
    assert again.guard_model(role='sister')['provider'] == 'saved'


async def test_role_switch_restarts_independently_and_legacy_all_switches(tmp_path):
    path = tmp_path / 'policy.json'
    p = DesktopRoleModelPolicy(path, 'sister', 'old', lo_provider='lo', lo_model='small')
    await p.switch('sister', 'new', role='sister')
    again = DesktopRoleModelPolicy(path, 'ignored', 'ignored', lo_provider='ignored', lo_model='ignored')
    assert again.guard_model(role='sister')['modelId'] == 'new'
    assert again.guard_model(role='last_order')['modelId'] == 'small'
    result = await again.switch('both', 'shared')
    assert result['state'] == 'ready'
    assert again.guard_model(role='last_order')['provider'] == 'both'
    assert again.guard_model(role='sister')['provider'] == 'both'


def test_worker_launch_role_and_recorded_pair_are_fenced(tmp_path):
    path = tmp_path / 'policy.json'
    p = DesktopRoleModelPolicy(path, 'sister', 'big', lo_provider='lo', lo_model='small')
    binding = {**p.guard_model(role='last_order'), 'role': 'last_order'}
    launch_id = 'a' * 32
    (tmp_path / 'launches').mkdir()
    (tmp_path / 'launches' / f'{launch_id}.json').write_text(json.dumps(binding))
    argv = desktop_child_argv([sys.executable, '-m', 'misaka', 'research', '--node', 'r', 'n', '--runner-key', 'k'],
                              path, binding, launch_id=launch_id)
    args = parse_worker_args(argv[3:])
    assert args.role == 'last_order'
    assert validate_worker_binding(args, p)['modelId'] == 'small'
    args.role = 'sister'
    with pytest.raises(ValueError, match='role'):
        validate_worker_binding(args, p)
    with pytest.raises(ValueError, match='Stale'):
        p.guard_model(expected_epoch=99, role='last_order')


def test_nested_helper_preserves_parent_role_and_card_uses_sister(tmp_path):
    p = DesktopRoleModelPolicy(tmp_path / 'policy.json', 'sister', 'big', lo_provider='lo', lo_model='small')
    root = {**p.guard_model(role='last_order'), 'role': 'last_order'}
    sister = {**p.guard_model(role='sister'), 'role': 'sister'}
    agent = [sys.executable, '-m', 'misaka.cli.subagent_child', '--model', 'global']
    root_child = desktop_child_argv(agent, p.path, root)
    sister_child = desktop_child_argv(agent, p.path, sister)
    card = desktop_child_argv([sys.executable, '-m', 'misaka.cli.research_node', '--run-card', 't'], p.path, sister)
    assert parse_worker_args(root_child[3:]).role == 'last_order'
    assert parse_worker_args(sister_child[3:]).role == 'sister'
    assert parse_worker_args(card[3:]).role == 'sister'
    assert root_child[-2:] == ['--model', 'small']
    assert sister_child[-2:] == ['--model', 'big']


def test_scope_configs_and_admissions_follow_own_role(tmp_path):
    p = DesktopRoleModelPolicy(tmp_path / 'policy.json', 'sister', 'big', lo_provider='lo', lo_model='small')
    scope = DesktopExecutionScope.__new__(DesktopExecutionScope)
    scope.policy = p
    scope.role = 'last_order'
    scope.base_config = {'profiles_root': 'GLOBAL', 'lo_model': 'lo/small'}
    scope.team = SimpleNamespace(profile_root=tmp_path, directory=tmp_path)
    assert scope.current_config()['default_model'] == 'small'
    binding = scope.launch_binding()
    assert binding['role'] == 'last_order'
    launch_id = scope.record_launch(binding)
    assert json.loads((tmp_path / 'launches' / f'{launch_id}.json').read_text())['role'] == 'last_order'
    scope.role = 'sister'
    assert scope.launch_binding()['modelId'] == 'big'
    assert scope.current_config()['default_model'] == 'big'


async def test_sister_switch_does_not_wait_for_last_order_callback(tmp_path):
    p = DesktopRoleModelPolicy(tmp_path / 'policy.json', 'sister', 'big', lo_provider='lo', lo_model='small')
    called = []
    p.register_executor('root', lambda *_: called.append('root'), role='last_order')
    p.register_executor('card', lambda *_: called.append('card'), role='sister')
    await p.switch('sister', 'new', role='sister')
    assert called == ['card']
    assert p.guard_model(role='last_order')['epoch'] == 0


async def test_sister_thinking_is_persistent_and_leaves_root_level_unchanged(tmp_path):
    from misaka.desktop_research.runtime import DesktopResearchController
    from misaka.desktop_research.team import DesktopResearchTeam
    team = DesktopResearchTeam(tmp_path / 'session', tmp_path / 'shared', 'sister', 'big')
    root = SimpleNamespace(thinkingLevel='off')
    root.setThinkingLevel = lambda level: setattr(root, 'thinkingLevel', level)
    controller = DesktopResearchController.__new__(DesktopResearchController)
    controller.team, controller.session = team, root
    controller.scope = SimpleNamespace(sessions={})
    result = await controller.set_team_thinking('medium', role='sister')
    assert result['thinkingLevel'] == 'medium'
    assert root.thinkingLevel == 'off'
    again = DesktopResearchTeam(tmp_path / 'session', tmp_path / 'shared', 'ignored', 'ignored')
    assert again.role_thinking('sister') == 'medium'


async def test_legacy_all_switch_keeps_both_paused_if_second_prepare_fails(tmp_path):
    p = DesktopRoleModelPolicy(tmp_path / 'policy.json', 'sister', 'old', lo_provider='lo', lo_model='small')
    p.register_executor('card', role='sister')
    def fail_lo(provider, *_):
        if provider == 'both':
            raise ValueError('bad Last Order credentials')
    p.register_executor('root', fail_lo, role='last_order')
    result = await p.switch('both', 'new', timeout=.5)
    assert result['state'] == 'failed'
    assert p.bindings()['sister']['effective']['modelId'] == 'old'
    assert p.bindings()['last_order']['effective']['modelId'] == 'small'
    with pytest.raises(ModelPolicyPaused):
        p.begin_request('card', role='sister')
    await p.cancel_switch()
    assert p.begin_request('card', role='sister')['modelId'] == 'old'


async def test_legacy_all_failed_boundary_can_retry_after_credentials_recover(tmp_path):
    p = DesktopRoleModelPolicy(tmp_path / 'policy.json', 'sister', 'old', lo_provider='lo', lo_model='small')
    fail = True
    def prepare(provider, *_):
        if provider == 'both' and fail:
            raise ValueError('credentials unavailable')
    p.register_executor('root', prepare, role='last_order')
    assert (await p.switch('both', 'new'))['state'] == 'failed'
    fail = False
    assert (await p.switch('both', 'new'))['state'] == 'ready'
    assert p.guard_model(role='sister')['modelId'] == 'new'
    assert p.guard_model(role='last_order')['modelId'] == 'new'


async def test_cancelling_pending_all_switch_does_not_commit_other_role(tmp_path):
    p = DesktopRoleModelPolicy(tmp_path / 'policy.json', 'sister', 'old', lo_provider='lo', lo_model='small')
    p.register_executor('card', role='sister')
    ticket = p.begin_request('card', role='sister')
    switch = asyncio.create_task(p.switch('both', 'new', timeout=1))
    await asyncio.sleep(.03)
    assert p.snapshot(role='sister')['state'] == 'switching'
    await p.cancel_switch()
    p.end_request(ticket)
    await switch
    assert p.guard_model(role='sister')['modelId'] == 'old'
    assert p.guard_model(role='last_order')['modelId'] == 'small'


async def test_failed_second_role_is_failed_in_legacy_controller_binding_and_both_snapshots(tmp_path):
    from misaka.desktop_research.runtime import DesktopResearchController
    from misaka.desktop_research.team import DesktopResearchTeam
    team = DesktopResearchTeam(tmp_path / 'session', tmp_path / 'shared', 'sister', 'old',
                               lo_provider='lo', lo_model='small')
    def fail(provider, *_):
        if provider == 'new':
            raise ValueError('LO unavailable')
    team.model_policy.register_executor('root', fail, role='last_order')
    controller = DesktopResearchController.__new__(DesktopResearchController)
    controller.team = team
    controller.config = {}
    controller._event_jobs = set()
    controller.emit = lambda payload: None
    controller._subscribe_model_events()
    try:
        snapshot = await controller.set_team_model('new', 'pair', role='all')
        assert snapshot['modelBinding']['state'] == 'failed'
        assert snapshot['modelBindings']['last_order']['state'] == 'failed'
        assert snapshot['modelBindings']['sister']['state'] == 'failed'
        assert snapshot['modelBindings']['sister']['effective']['modelId'] == 'old'
        assert snapshot['modelBindings']['last_order']['effective']['modelId'] == 'small'
    finally:
        controller._unsubscribe_model_events()


async def test_scoped_switch_validates_model_even_before_any_role_executor_exists(tmp_path):
    from types import SimpleNamespace

    from misaka.desktop_research.runtime import DesktopResearchController
    from misaka.desktop_research.team import DesktopResearchTeam
    team = DesktopResearchTeam(tmp_path / 'session', tmp_path / 'shared', 'fixture', 'old')
    controller = DesktopResearchController.__new__(DesktopResearchController)
    controller.team = team
    controller.config = {}
    controller._event_jobs = set()
    controller.session = SimpleNamespace(modelRegistry=SimpleNamespace(find=lambda *_: None))
    with pytest.raises(ValueError, match='missing'):
        await controller.set_team_model('fixture', 'missing', role='sister')
    assert team.snapshot()['modelBindings']['sister']['effective']['modelId'] == 'old'
