"""Every native research root gets a stable private namespace, even in one cwd."""
from pathlib import Path

import pytest

from misaka.core.session_manager import SessionManager
from misaka.desktop_research.team import DesktopResearchTeam


def test_native_same_workspace_roots_have_separate_teams(tmp_path):
    from misaka.desktop_research.storage import root_team_directory
    one = SessionManager.create(str(tmp_path), str(tmp_path / 'sessions'))
    two = SessionManager.create(str(tmp_path), str(tmp_path / 'sessions'))
    assert Path(one.sessionFile).parent == Path(two.sessionFile).parent
    first = root_team_directory(one, one.getSessionId())
    second = root_team_directory(two, two.getSessionId())
    assert first != second
    team1 = DesktopResearchTeam(first, tmp_path / 'shared', 'fixture', 'a', team_id=one.getSessionId())
    team2 = DesktopResearchTeam(second, tmp_path / 'shared', 'fixture', 'b', team_id=two.getSessionId())
    team1.recruit('critic', 'Evidence review', 'Check citations', 'Review sources')
    assert team2.snapshot()['team']['members'] == []
    assert root_team_directory(one, one.getSessionId()) == first


def test_legacy_team_migrates_only_for_its_actual_owner(tmp_path):
    from misaka.desktop_research.storage import root_team_directory
    manager = SessionManager.create(str(tmp_path), str(tmp_path / 'sessions'))
    old = DesktopResearchTeam(Path(manager.sessionFile).parent, tmp_path / 'shared', 'fixture', 'a', team_id=manager.getSessionId())
    old.recruit('critic', 'Evidence review', 'Check citations', 'Review sources')
    directory = root_team_directory(manager, manager.getSessionId())
    restored = DesktopResearchTeam(directory, tmp_path / 'shared', 'fixture', 'a', team_id=manager.getSessionId())
    assert restored.snapshot()['team']['members'][0]['name'] == 'critic'
    assert old.path.exists()
    second = SessionManager.create(str(tmp_path), str(tmp_path / 'sessions'))
    other = root_team_directory(second, second.getSessionId())
    assert not (other / 'desktop-team' / 'team.json').exists()


def test_legacy_live_team_is_not_forked_into_a_second_policy(tmp_path):
    from misaka.desktop_research.storage import root_team_directory
    manager = SessionManager.create(str(tmp_path), str(tmp_path / 'sessions'))
    old = DesktopResearchTeam(Path(manager.sessionFile).parent, tmp_path / 'shared', 'fixture', 'a', team_id=manager.getSessionId())
    old.model_policy.register_executor('root')
    with pytest.raises(ValueError, match='still has live'):
        root_team_directory(manager, manager.getSessionId())
    old.model_policy.unregister_executor('root')
    assert root_team_directory(manager, manager.getSessionId()).is_dir()


def test_namespace_rejects_path_like_session_ids(tmp_path):
    from misaka.desktop_research.storage import root_team_directory
    manager = SessionManager.create(str(tmp_path), str(tmp_path / 'sessions'))
    with pytest.raises(ValueError):
        root_team_directory(manager, '../shared')
