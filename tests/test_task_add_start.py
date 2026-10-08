"""A card added and started by hand (GitHub issue #9: `misaka task` could only delete one).

`misaka task add` goes through Last Order's own front door for cards -- the same contract check,
the same roster -- and `misaka task start` runs a ready card in the terminal the way a pane or
Last Order's dispatch would."""
from contextlib import closing

import pytest

from misaka.cli import app
from misaka.core.network import dispatch, roster
from misaka.core.platform import repo, tasks

CONTRACT = "## goal\nList the salt yards.\n## boundaries\nQing only.\n## acceptance criteria\n- a table of yards\n"


@pytest.fixture
def board(tmp_path, monkeypatch):
    monkeypatch.setattr(repo, "enabled", lambda *a: False)
    monkeypatch.setattr(tasks, "task_state_dir", lambda tid: str(tmp_path / "state" / tid))
    monkeypatch.setattr(roster, "executors", lambda root=None: {"10032", "10077"})
    monkeypatch.setattr(roster, "roster_names", lambda root=None: ["10032", "10077"])
    monkeypatch.chdir(tmp_path)
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        monkeypatch.setattr(app.db, "connect", lambda path: con)
        yield con


def _task(*argv):
    return app._cmd_task(app._parser().parse_args(["task", *argv]))


def test_a_card_is_added_and_started_by_hand(board, monkeypatch, capsys, tmp_path):
    (tmp_path / "contract.md").write_text(CONTRACT, encoding="utf-8")
    with pytest.raises(SystemExit) as done:
        _task("add", "Salt", "yards", "--to", "10032", "--body-file", "contract.md", "--reviewer", "10077")
    assert done.value.code == 0
    [row] = tasks.by_status(board, "ready")
    assert (row["title"], row["assignee"], row["reviewer"]) == ("Salt yards", "10032", "10077")
    assert f"misaka task start {row['id']}" in capsys.readouterr().out
    ran = []
    monkeypatch.setattr(dispatch, "run_task", lambda con, card, cfg, say=None: ran.append(card["id"]) or True)
    with pytest.raises(SystemExit) as done:
        _task("start", row["id"])
    assert done.value.code == 0 and ran == [row["id"]]
    with pytest.raises(SystemExit) as done:
        _task(row["id"], "--delete")
    assert done.value.code == 0 and tasks.get(board, row["id"]) is None, "the old form still deletes"


@pytest.mark.parametrize("argv, said", [
    (["add", "Salt", "--to", "10032", "--body", "## goal\nyards"], "acceptance criteria"),
    (["add", "Salt", "--to", "10099", "--body", CONTRACT], "not in the roster"),
    (["add", "Salt", "--to", "10032", "--body", CONTRACT, "--reviewer", "10032"], "different from the assignee"),
    (["start", "t_nothere"], "Card not found"),
    (["t_nothere"], "usage: misaka task add"),
])
def test_what_is_wrong_is_said(board, argv, said):
    with pytest.raises(SystemExit) as refused:
        _task(*argv)
    assert said in str(refused.value.code)
    assert tasks.by_status(board, "ready") == []


def test_a_body_file_from_notepad_is_read_or_refused_in_a_sentence(board, tmp_path):
    """Notepad saves "UTF-8 with BOM", or "ANSI" (GBK on a Chinese Windows): the BOM is not the body,
    and a GBK file is refused in a sentence rather than a traceback."""
    (tmp_path / "bom.md").write_bytes(b"\xef\xbb\xbf" + CONTRACT.encode("utf-8"))
    with pytest.raises(SystemExit) as done:
        _task("add", "Salt", "--to", "10032", "--body-file", "bom.md")
    assert done.value.code == 0
    [row] = tasks.by_status(board, "ready")
    assert row["body"].startswith("## goal")
    (tmp_path / "gbk.md").write_bytes("## goal\n列出盐场。\n".encode("gbk"))
    with pytest.raises(SystemExit) as refused:
        _task("add", "Salt", "--to", "10032", "--body-file", "gbk.md")
    assert "not UTF-8" in str(refused.value.code)
