"""Desktop-only process entry for native node, card and nested Agent executors."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path

from .model_policy import DesktopRoleModelPolicy, ModelPolicyPaused
from .runtime import DesktopExecutionScope, pinned_flags
from .team import DesktopResearchTeam

# Historical injection seam retained for existing worker/bootstrap fixtures.
DesktopTeamModelPolicy = DesktopRoleModelPolicy


def parse_worker_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--policy', required=True)
    parser.add_argument('--epoch', required=True, type=int)
    parser.add_argument('--provider', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--launch-id')
    parser.add_argument('--role', choices=('last_order', 'sister'))
    parser.add_argument('--lane', choices=('node', 'card', 'agent'), required=True)
    parser.add_argument('flags', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if args.flags[:1] == ['--']:
        args.flags = args.flags[1:]
    return args


def validate_worker_binding(args, policy):
    role = getattr(args, 'role', None) or ('last_order' if args.lane == 'node' else 'sister')
    def guard(**kwargs):
        if isinstance(policy, DesktopRoleModelPolicy):
            return policy.guard_model(role=role, **kwargs)
        return policy.guard_model(**kwargs)
    launch_id = getattr(args, 'launch_id', None)
    if launch_id:
        if not re.fullmatch(r'[a-f0-9]{32}', launch_id):
            raise ValueError('Invalid desktop launch ID')
        manifest = Path(args.policy).resolve().parent / 'launches' / (launch_id + '.json')
        recorded = json.loads(manifest.read_text(encoding='utf-8'))
        if recorded.get('role', role) != role:
            raise ValueError('Desktop worker role differs from its recorded admission')
        if args.epoch != recorded['epoch']:
            raise ValueError('Desktop worker launch epoch differs from its recorded admission')
        if (args.provider, args.model) != (recorded['provider'], recorded['modelId']):
            raise ValueError('Desktop worker model pair differs from its recorded admission')
        # Native startup is synchronous, before a loop exists. A switch may have
        # completed between Popen and this entry; join the latest ready binding,
        # whose real sessions/requests remain protected by their own barriers.
        while True:
            try:
                return guard()
            except ModelPolicyPaused:
                time.sleep(.01)
    binding = guard(expected_epoch=args.epoch)
    if (args.provider, args.model) != (binding['provider'], binding['modelId']):
        raise ValueError('Desktop worker model pair differs from the team policy')
    return binding


def parse_card_flags(flags):
    """``--run-card TASK [--say TEXT] [--expected-generation N] [--consult]`` -> (task, say, gen, consult).

    The desktop continuation's fences travel with the child process so they reach the real
    ``claim_resume`` CAS (Task 1): the generation pins the attempt the sender resolved, and
    ``--consult`` marks a message wake that must not send dependants back to todo.
    """
    if len(flags) < 2 or flags[0] != '--run-card':
        raise ValueError('Expected --run-card TASK_ID [--say TEXT] [--expected-generation N] [--consult]')
    task_id, say, expected_generation, consult = flags[1], None, None, False
    rest = list(flags[2:])
    while rest:
        flag = rest.pop(0)
        if flag == '--say' and rest:
            say = rest.pop(0)
        elif flag == '--expected-generation' and rest:
            expected_generation = int(rest.pop(0))
        elif flag == '--consult':
            consult = True
        else:
            raise ValueError(f'Unknown card flag: {flag}')
    return task_id, say, expected_generation, consult


def main(argv=None):
    args = parse_worker_args(argv)
    from misaka.cli import bootstrap
    from misaka.utils import loop_watchdog
    from misaka.windows_bootstrap import apply_windows_utf8_bootstrap
    apply_windows_utf8_bootstrap()
    bootstrap.install()
    policy = DesktopTeamModelPolicy(args.policy, args.provider, args.model)
    binding = validate_worker_binding(args, policy)
    directory = Path(args.policy).resolve().parent
    config = json.loads((directory / 'runtime-config.json').read_text(encoding='utf-8'))
    team = DesktopResearchTeam(directory.parent, config['profiles_root'], args.provider, args.model)
    scope = DesktopExecutionScope(team, config, getattr(args, 'role', None) or
                                  ('last_order' if args.lane == 'node' else 'sister'))
    if args.lane == 'agent':
        sys.argv = [sys.argv[0], *pinned_flags(args.flags, binding)]
        owner = os.environ.get('MISAKA_SISTER_OWNER_TASK_ID')
        loop_watchdog.configure(f'card-{owner}' if owner else 'subagent', exit_on_stall=True)
        return asyncio.run(loop_watchdog.watched(scope.native.module('misaka.core.subagent.child').amain()))
    node = scope.native.module('misaka.core.research.node')
    if args.lane == 'card':
        task_id, say, expected_generation, consult = parse_card_flags(args.flags)
        loop_watchdog.configure(f'card-{task_id}', exit_on_stall=True)
        from misaka.config import env as env_file
        env_file.load()
        return node.main_card(task_id, say=say, consult=consult, expected_generation=expected_generation)
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True, nargs=2)
    parser.add_argument('--runner-key', required=True)
    flags = parser.parse_args(args.flags)
    loop_watchdog.configure(f'node-{flags.node[1]}', exit_on_stall=True)
    return node.run_headless(*flags.node, runner_key=flags.runner_key)


if __name__ == '__main__':
    raise SystemExit(main())
