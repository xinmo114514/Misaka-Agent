import builtins
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from misaka.desktop_research.team import DesktopResearchTeam


def make_team(tmp_path, **kw):
    return DesktopResearchTeam(tmp_path / 'run-a', tmp_path / 'shared', 'vendor-a', 'org/shared', **kw)


def test_recruit_persists_isolated_profile_and_idempotently_reloads(tmp_path):
    team = make_team(tmp_path, allowed_tools={'search'})
    member = team.recruit('sources', 'Compare sources', 'Current private goal', 'General instructions',
                          tools=['search'], skills=['citation-check'])
    assert member['kind'] == 'task_agent'
    assert (team.profile_root / 'sources' / 'SOUL.md').is_file()
    assert not (tmp_path / 'shared').exists()
    settings = json.loads((team.profile_root / 'sources' / 'settings.json').read_text())
    assert (settings['defaultProvider'], settings['defaultModel']) == ('vendor-a', 'org/shared')
    restarted = make_team(tmp_path)
    assert restarted.recruit('sources', 'Compare sources', 'Current private goal', 'General instructions',
                             tools=['search'], skills=['citation-check'])['id'] == member['id']
    assert len(restarted.snapshot()['team']['members']) == 1
    other = DesktopResearchTeam(tmp_path / 'run-b', tmp_path / 'shared', 'vendor-b', 'shared')
    assert other.snapshot()['team']['members'] == []
    assert other.profile_root != team.profile_root


def test_borrow_preserves_original_and_drops_credentials_and_chat(tmp_path):
    shared = tmp_path / 'shared' / 'existing'
    shared.mkdir(parents=True)
    (shared / 'SOUL.md').write_text('Original voice')
    (shared / 'DESCRIBE.md').write_text('Original responsibilities')
    (shared / 'settings.json').write_text(json.dumps({'defaultProvider': 'old', 'defaultModel': 'pin',
                                                    'apiKey': 'SECRET', 'mcpServers': {'secret': 'TOKEN'}}))
    (shared / 'chat.json').write_text('PRIVATE_CHAT')
    (shared / 'skills').mkdir()
    (shared / 'skills' / 'reference.md').write_text('Skill reference')
    before = {p.name: p.read_bytes() for p in shared.iterdir() if p.is_file()}
    team = make_team(tmp_path)
    member = team.recruit('review', 'Review evidence', 'Current goal', 'Check citations', source_id='existing')
    assert member['kind'] == 'borrowed_sister' and member['sourceId'] == 'existing'
    assert {p.name: p.read_bytes() for p in shared.iterdir() if p.is_file()} == before
    local = team.profile_root / 'review'
    assert 'SECRET' not in (local / 'settings.json').read_text()
    assert not (local / 'chat.json').exists()
    assert (local / 'skills' / 'reference.md').read_text() == 'Skill reference'


@pytest.mark.parametrize('name', ['../escape', 'last-order', '', ' spaced ', 'CON'])
def test_invalid_role_names_write_no_profiles(tmp_path, name):
    team = make_team(tmp_path)
    with pytest.raises(ValueError):
        team.recruit(name, 'Role', 'Goal', 'Instructions')
    assert list(team.profile_root.iterdir()) == []


def test_recruit_rejects_conflicting_content_and_excess_tools(tmp_path):
    team = make_team(tmp_path, allowed_tools={'search'})
    with pytest.raises(ValueError):
        team.recruit('role', 'Role', 'Goal', 'Instructions', tools=['shell'])
    team.recruit('role', 'Role', 'Goal', 'Instructions')
    with pytest.raises(ValueError):
        team.recruit('role', 'Changed role', 'Goal', 'Instructions')


def test_retention_is_selected_terminal_sanitized_and_idempotent(tmp_path):
    team = make_team(tmp_path)
    one = team.recruit('sources', 'Compare evidence', 'PRIVATE GOAL', 'General guidance', skills=['cite'])
    team.recruit('review', 'Review', 'Other goal', 'Other guidance')
    with pytest.raises(ValueError):
        team.retain_roles([{'id': one['id'], 'name': 'saved'}], terminal=False, request_id='r1')
    assert team.retain_roles([], terminal=True, request_id='empty')['retained'] == []
    assert not (tmp_path / 'shared').exists()
    receipt = team.retain_roles([{'id': one['id'], 'name': 'saved'}], terminal=True, request_id='r1')
    assert receipt['retained'] == [{'id': one['id'], 'name': 'saved'}]
    assert team.retain_roles([{'id': one['id'], 'name': 'saved'}], terminal=True, request_id='r1') == receipt
    saved = tmp_path / 'shared' / 'saved'
    all_text = '\n'.join(p.read_text() for p in saved.rglob('*') if p.is_file())
    assert 'General guidance' in all_text and 'Compare evidence' in all_text and 'cite' in all_text
    assert 'PRIVATE GOAL' not in all_text
    assert not (saved / 'settings.json').exists()
    assert not (tmp_path / 'shared' / 'review').exists()
    assert make_team(tmp_path).snapshot()['team']['members'][0]['retainedAs'] == 'saved'


def test_retention_conflicts_preserve_profiles_and_do_not_partially_create(tmp_path):
    team = make_team(tmp_path)
    one = team.recruit('a', 'A', 'Goal', 'A instructions')
    two = team.recruit('b', 'B', 'Goal', 'B instructions')
    existing = tmp_path / 'shared' / 'existing'
    existing.mkdir(parents=True)
    (existing / 'SOUL.md').write_text('Keep this')
    with pytest.raises(ValueError):
        team.retain_roles([{'id': one['id'], 'name': 'new'}, {'id': two['id'], 'name': 'existing'}],
                          terminal=True, request_id='r1')
    assert not (tmp_path / 'shared' / 'new').exists()
    assert (existing / 'SOUL.md').read_text() == 'Keep this'


def test_retention_rejects_borrowed_and_unvalidated_skill_metadata(tmp_path):
    team = make_team(tmp_path)
    with pytest.raises(ValueError):
        team.recruit('bad', 'Role', 'Goal', 'Instructions', skills=[{'name': 'cite', 'apiKey': 'SECRET'}])
    team.recruit('ok', 'Role', 'Goal', 'Instructions')
    shared = tmp_path / 'shared' / 'old'
    shared.mkdir(parents=True)
    borrowed = team.recruit('copy', 'Role', 'Goal', 'Instructions', source_id='old')
    with pytest.raises(ValueError):
        team.retain_roles([{'id': borrowed['id'], 'name': 'new'}], terminal=True, request_id='r1')


def test_concurrent_recruitment_persists_one_member_per_validated_role(tmp_path):
    teams = [make_team(tmp_path) for _ in range(4)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        members = list(pool.map(lambda t: t.recruit('role', 'Role', 'Goal', 'Instructions'), teams))
    assert len({m['id'] for m in members}) == 1
    assert len(make_team(tmp_path).snapshot()['team']['members']) == 1
    assert len(list(teams[0].profile_root.iterdir())) == 1


def test_status_task_instances_persist_and_retained_receipt_survives_restart(tmp_path):
    team = make_team(tmp_path)
    member = team.recruit('role', 'Role', 'Private goal', 'Instructions\napiKey=SECRET\nKeep guidance')
    team.update_member(member['id'], status='running', taskIds=[17], instances=[{'pid': 123, 'epoch': 0}])
    restarted = make_team(tmp_path)
    visible = restarted.snapshot()['team']['members'][0]
    assert visible['status'] == 'running' and visible['taskIds'] == [17]
    assert visible['instances'] == [{'pid': 123, 'epoch': 0}]
    receipt = restarted.retain_roles([{'id': member['id'], 'name': 'saved'}], terminal=True, request_id='save')
    assert make_team(tmp_path).retain_roles([{'id': member['id'], 'name': 'saved'}],
                                          terminal=True, request_id='save') == receipt
    saved = (tmp_path / 'shared' / 'saved' / 'SOUL.md').read_text()
    assert 'SECRET' not in saved and 'Keep guidance' in saved
    with pytest.raises(ValueError):
        restarted.retain_roles([{'id': member['id'], 'name': 'other'}], terminal=True, request_id='save')


async def test_pin_profiles_follows_only_committed_exact_team_pair(tmp_path):
    team = make_team(tmp_path)
    team.recruit('role', 'Role', 'Goal', 'Instructions')
    await team.model_policy.switch('vendor-b', 'same')
    team.pin_profiles('vendor-b', 'same')
    settings = json.loads((team.profile_root / 'role' / 'settings.json').read_text())
    assert settings == {'defaultProvider': 'vendor-b', 'defaultModel': 'same'}
    assert make_team(tmp_path).snapshot()['team']['members'][0]['effectiveModel'] == {
        'provider': 'vendor-b', 'modelId': 'same', 'epoch': 1}
    with pytest.raises(ValueError):
        team.pin_profiles('vendor-a', 'same')


def fail_native_soul_write(monkeypatch, expected_directory):
    original = builtins.open
    failed = False

    def open_with_fault(path, *args, **kwargs):
        nonlocal failed
        if not failed and str(path) == str(expected_directory / 'SOUL.md'):
            failed = True
            raise OSError('Injected native profile IO failure')
        return original(path, *args, **kwargs)

    monkeypatch.setattr(builtins, 'open', open_with_fault)


def test_local_native_create_io_failure_removes_only_partial_new_profile_and_retries(tmp_path, monkeypatch):
    team = make_team(tmp_path)
    existing = team.profile_root / 'existing'
    existing.mkdir()
    (existing / 'SOUL.md').write_text('Preserve existing')
    fail_native_soul_write(monkeypatch, team.profile_root / 'new')
    with pytest.raises(OSError):
        team.recruit('new', 'Role', 'Goal', 'Instructions')
    assert not (team.profile_root / 'new').exists()
    assert team.snapshot()['team']['members'] == []
    assert (existing / 'SOUL.md').read_text() == 'Preserve existing'
    assert team.recruit('new', 'Role', 'Goal', 'Instructions')['name'] == 'new'
    with pytest.raises(ValueError):
        team.recruit('existing', 'Role', 'Goal', 'Instructions')
    assert (existing / 'SOUL.md').read_text() == 'Preserve existing'


def test_shared_native_create_io_failure_rolls_back_partial_profile_and_receipt_then_retries(tmp_path, monkeypatch):
    team = make_team(tmp_path)
    member = team.recruit('new', 'Role', 'Goal', 'Instructions')
    existing = tmp_path / 'shared' / 'existing'
    existing.mkdir(parents=True)
    (existing / 'SOUL.md').write_text('Preserve shared')
    fail_native_soul_write(monkeypatch, tmp_path / 'shared' / 'saved')
    selections = [{'id': member['id'], 'name': 'saved'}]
    with pytest.raises(OSError):
        team.retain_roles(selections, terminal=True, request_id='save')
    assert not (tmp_path / 'shared' / 'saved').exists()
    assert 'retainedAs' not in team.snapshot()['team']['members'][0]
    assert (existing / 'SOUL.md').read_text() == 'Preserve shared'
    assert team.retain_roles(selections, terminal=True, request_id='save')['retained'] == selections


@pytest.mark.parametrize('skill', ['apiKey=SECRET', 'Bearer SECRET', 'PRIVATE-GOAL', '../private', 'skill\rchat'])
def test_unsafe_skill_strings_are_rejected_before_any_profile_or_shared_write(tmp_path, skill):
    team = make_team(tmp_path)
    with pytest.raises(ValueError):
        team.recruit('new', 'Role', 'PRIVATE-GOAL', 'Instructions', skills=[skill])
    assert list(team.profile_root.iterdir()) == []
    assert not (tmp_path / 'shared').exists()


def test_retention_revalidates_skill_identifiers_in_persisted_roles_before_shared_write(tmp_path):
    team = make_team(tmp_path)
    member = team.recruit('new', 'Role', 'Goal', 'Instructions', skills=['pdf:pdf'])
    state = json.loads(team.path.read_text())
    state['members'][0]['skills'] = ['apiKey=SECRET']
    team.path.write_text(json.dumps(state))
    with pytest.raises(ValueError):
        team.retain_roles([{'id': member['id'], 'name': 'saved'}], terminal=True, request_id='save')
    assert not (tmp_path / 'shared').exists()


def test_empty_retention_receipt_survives_restart_and_rejects_changed_payload(tmp_path):
    team = make_team(tmp_path)
    member = team.recruit('role', 'Compare sources', 'Private task', 'General guidance')
    receipt = team.retain_roles([], terminal=True, request_id='empty')
    persisted = json.loads(team.path.read_text())
    assert persisted['retentionReceipts']['empty']['receipt'] == receipt
    restarted = make_team(tmp_path)
    before = restarted.path.read_bytes()
    assert restarted.retain_roles([], terminal=True, request_id='empty') == receipt
    assert restarted.path.read_bytes() == before
    with pytest.raises(ValueError):
        restarted.retain_roles([{'id': member['id'], 'name': 'saved'}], terminal=True, request_id='empty')
    assert not (tmp_path / 'shared').exists()
    assert 'retainedAs' not in restarted.snapshot()['team']['members'][0]


@pytest.mark.parametrize('assignment', [
    'refresh_token=SECRET_VALUE',
    'refreshToken : SECRET_VALUE',
    '"refresh-token": "SECRET_VALUE"',
    "'client_secret' = 'SECRET_VALUE'",
    'clientSecret=SECRET_VALUE',
    'Client Secret: SECRET_VALUE',
    'AWS_SECRET_ACCESS_KEY=SECRET_VALUE',
    'aws-secret-access-key = SECRET_VALUE',
    'AWS_ACCESS_KEY_ID=SECRET_VALUE',
    'access_key=SECRET_VALUE',
    'private_key: SECRET_VALUE',
    'Private-Key = SECRET_VALUE',
    'secret_key=SECRET_VALUE',
    'Authorization: Basic SECRET_VALUE',
    'Connect using https://alice:SECRET_VALUE@example.test/path',
    'postgresql://alice:SECRET_VALUE@database.test/research',
    'redis://:SECRET_VALUE@cache.test/0',
    'https://alice%3ASECRET_VALUE@example.test/path',
])
def test_retention_omits_credential_assignments_and_uri_credentials(tmp_path, assignment):
    team = make_team(tmp_path)
    member = team.recruit('role', 'Compare archives', 'Private current task',
                          f'Keep general guidance.\n{assignment}\nContinue comparing citations.', skills=['pdf:pdf'])
    team.retain_roles([{'id': member['id'], 'name': 'saved'}], terminal=True, request_id='save')
    shared_text = '\n'.join(p.read_text() for p in (tmp_path / 'shared' / 'saved').rglob('*') if p.is_file())
    assert 'SECRET_VALUE' not in shared_text
    assert 'Keep general guidance.' in shared_text and 'Continue comparing citations.' in shared_text
    assert 'pdf:pdf' in shared_text


def test_retention_omits_explicit_goal_variants_and_private_key_blocks(tmp_path):
    team = make_team(tmp_path)
    goal = 'Private project task'
    member = team.recruit('role', 'General responsibility.\nPRIVATE PROJECT TASK', goal,
                          'General guidance.\nPrivate\nproject task\n'
                          '-----BEGIN RSA PRIVATE KEY-----\nSECRET_KEY_BODY\n-----END RSA PRIVATE KEY-----\n'
                          'Continue reviewing citations.', skills=['citation-check'])
    team.retain_roles([{'id': member['id'], 'name': 'saved'}], terminal=True, request_id='save')
    shared_text = '\n'.join(p.read_text() for p in (tmp_path / 'shared' / 'saved').rglob('*') if p.is_file())
    assert 'private project task' not in ' '.join(shared_text.casefold().split())
    assert 'SECRET_KEY_BODY' not in shared_text and 'PRIVATE KEY' not in shared_text
    assert 'General responsibility.' in shared_text and 'Continue reviewing citations.' in shared_text


@pytest.mark.parametrize('skill', [
    'refresh-token-SECRET', 'client-secret-SECRET', 'clientSecret-SECRET',
    'AWS_SECRET_ACCESS_KEY', 'access-key-SECRET', 'private-key-SECRET',
])
def test_sensitive_skill_identifiers_are_rejected_before_profile_or_shared_writes(tmp_path, skill):
    team = make_team(tmp_path)
    with pytest.raises(ValueError):
        team.recruit('role', 'General responsibility', 'Private task', 'General guidance', skills=[skill])
    assert list(team.profile_root.iterdir()) == []
    assert not (tmp_path / 'shared').exists()


def test_sensitive_persisted_skill_identifier_rejected_before_shared_writes(tmp_path):
    team = make_team(tmp_path)
    member = team.recruit('role', 'General responsibility', 'Private task', 'General guidance', skills=['pdf:pdf'])
    state = json.loads(team.path.read_text())
    state['members'][0]['skills'] = ['aws:client-secret-SECRET']
    team.path.write_text(json.dumps(state))
    with pytest.raises(ValueError):
        team.retain_roles([{'id': member['id'], 'name': 'saved'}], terminal=True, request_id='save')
    assert not (tmp_path / 'shared').exists()
