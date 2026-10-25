"""Task 3: a deferred card projection settles against the database fence.

The crash window is between the staged write and the SQL commit. These tests drive the real
card_publication helpers: a committed transition keeps the new bytes, a refused transition
restores the old bytes, and a file changed by someone else is reported (never overwritten).
"""
from __future__ import annotations

from contextlib import closing
from pathlib import Path

import pytest

from misaka.core.platform import card_publication, tasks
from misaka.core.platform import cards as card_files


@pytest.fixture
def board(tmp_path, monkeypatch):
    from misaka.core.platform import repo
    monkeypatch.setattr(repo, "enabled", lambda *a: False)
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        from misaka.core.research import runs
        runs.init(con)
        yield con


def _card(board, tmp_path):
    workspace = tmp_path / "project"
    workspace.mkdir(exist_ok=True)
    return card_files.create(board, str(workspace), "T", "body", "10032"), str(workspace)


def test_stage_and_deferred_settle_rolls_back_when_the_row_never_moved(board, tmp_path):
    tid, workspace = _card(board, tmp_path)
    path = Path(card_files.card_path(workspace, tid))
    before = path.read_text(encoding="utf-8")

    def mutate(fields, body):
        fields["status"] = "stopped"
        return fields, body

    card_publication.stage(workspace, tid, mutate, generation=1, new_status="stopped")
    # Simulate a crash before commit: no committed marker, row still 'ready'.
    assert card_publication.settle(board, workspace, tid) == "rolled-back"
    assert path.read_text(encoding="utf-8") == before
    assert not card_publication.journal_path(path).exists()


def test_stage_and_commit_keeps_the_new_bytes(board, tmp_path):
    tid, workspace = _card(board, tmp_path)

    def mutate(fields, body):
        fields["status"] = "stopped"
        return fields, body

    prepared = card_publication.stage(workspace, tid, mutate, generation=1, new_status="stopped")
    with tasks.write_txn(board):
        board.execute("UPDATE tasks SET status='stopped' WHERE id=?", (tid,))
        tasks.add_event(board, tid, "card_projection_committed",
                        {"operationId": prepared.operation}, generation=1)
    assert card_publication.settle(board, workspace, tid) == "recovered"
    card = card_files.read(card_files.card_path(workspace, tid))
    assert card["fields"]["status"] == "stopped"


def test_externally_changed_file_is_reported_not_overwritten(board, tmp_path):
    tid, workspace = _card(board, tmp_path)
    path = Path(card_files.card_path(workspace, tid))

    def mutate(fields, body):
        fields["status"] = "stopped"
        return fields, body

    card_publication.stage(workspace, tid, mutate, generation=1, new_status="stopped")
    path.write_text("---\nid: " + tid + "\nstatus: someone-else\n---\n\nbody\n", encoding="utf-8")
    assert card_publication.settle(board, workspace, tid) == "conflict"
    assert "someone-else" in path.read_text(encoding="utf-8")


def test_recover_pending_sweeps_a_workspace(board, tmp_path):
    tid, workspace = _card(board, tmp_path)

    def mutate(fields, body):
        fields["status"] = "stopped"
        return fields, body

    card_publication.stage(workspace, tid, mutate, generation=1, new_status="stopped")
    outcomes = card_publication.recover_pending(board, workspace)
    assert outcomes and outcomes[0][0] == tid
