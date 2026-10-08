"""Real native node/card processes; only their HTTP model endpoint is a fixture."""
import json
import os
import subprocess
import sys

import pytest

from tests.test_agent_model_runtime import local_models  # noqa: F401
from tests.test_subagent_native_startup import isolated  # noqa: F401


@pytest.mark.parametrize('lane', ['node', 'card'])
def test_native_worker_requests_selected_team_pair_and_keeps_native_validators(local_models, lane):  # noqa: F811
    from misaka.config.product import current_config
    from misaka.core.platform import cards, tasks
    from misaka.core.research import runs
    from misaka.desktop_research.runtime import (
        DesktopExecutionScope,
        desktop_child_argv,
    )
    from misaka.desktop_research.team import DesktopResearchTeam

    root, requests = local_models
    source = root / 'profiles/sisters/10032/settings.json'
    original = source.read_bytes()
    team = DesktopResearchTeam(root / 'worker-team', root / 'profiles/sisters', 'fixture-lo', 'shared')
    member = team.recruit('borrowed-archive', 'Check provenance', 'Compare archival evidence',
                          'Cite artifacts and distinguish uncertainty', source_id='10032')
    scope = DesktopExecutionScope(team, current_config())
    con = tasks.connect(scope.current_config()['db'])
    runs.init(con)
    if lane == 'card':
        identifier = cards.create(con, str(root / 'workspace'), 'Actual desktop Sister model request',
                                  'CARD_MODEL_MARKER', member['name'], model='fixture-b/different')
        native = [sys.executable, '-m', 'misaka.cli.research_node', '--run-card', identifier]
    else:
        run = runs.create(con, workspace=str(root / 'workspace'), question='NODE_MODEL_MARKER',
                          limits={'max_depth': 0, 'max_nodes': 1})
        branch = runs.root(con, run['id'])
        con.execute('UPDATE research_branches SET runner_key=? WHERE id=?', ('fixture-key', branch['id']))
        native = [sys.executable, '-m', 'misaka', 'research', '--node', run['id'], branch['id'],
                  '--runner-key', 'fixture-key']
    binding = team.model_policy.guard_model()
    argv = desktop_child_argv(native, team.model_policy.path, binding,
                             launch_id=scope.record_launch(binding))
    process = None
    try:
        try:
            process = subprocess.Popen(argv, cwd=str(root / 'workspace'), env=os.environ.copy(),
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        except PermissionError as error:
            pytest.skip(f'Host denied creating the actual {lane} worker: {error}')
        output, errors = process.communicate(timeout=90)
        assert requests, (process.returncode, output, errors)
        assert all((provider, body['model']) == ('fixture-lo', 'shared') for provider, body in requests)
        assert source.read_bytes() == original
        if lane == 'node':
            # The fixture gives text, not a native plan tool contract. The node
            # must reject that answer rather than invent an accepted research plan.
            assert process.returncode != 0, (output, errors)
            assert runs.current_plan(con, run['id'], branch['id'])[1] is None
        else:
            assert any('CARD_MODEL_MARKER' in json.dumps(body) for _provider, body in requests)
            # Plain provider text is not a completion declaration or evidence
            # artifact. Preserve the native unsettled state, not a synthetic done.
            assert tasks.get(con, identifier)['status'] != 'done', (output, errors)
    finally:
        if process is not None:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
            process.stdout.close()
            process.stderr.close()
        con.close()
