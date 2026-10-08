"""A node whose recorded conversation was never written opens a new one: --continue picked
whatever else was newest in its directory, for a root started from a chat that chat's other
conversations (0.18.10 sweep)."""
import os
from contextlib import closing

import pytest

from misaka.config import current_config
from misaka.core.platform import session as platform_session
from misaka.core.platform import tasks
from misaka.core.research import runs, window


@pytest.mark.parametrize("recorded, written, expected", [
    (True, True, "--session"), (True, False, None), (False, False, "--continue")])
async def test_a_node_reopens_only_its_own_conversation(tmp_path, monkeypatch, recorded, written, expected):
    cfg = dict(current_config())
    cfg["db"] = str(tmp_path / "board.db")
    chat = tmp_path / "sessions"
    chat.mkdir()
    (chat / "another-chat.jsonl").write_text("{}\n", encoding="utf-8")
    seen = []

    async def open_session(flags, cwd, assembly):
        seen.append(flags)
        return None, None, "stop here"

    monkeypatch.setattr(platform_session, "open_session", open_session)
    with closing(tasks.connect(cfg["db"])) as con:
        runs.init(con)
        run = runs.create(con, workspace=str(tmp_path), question="Fixture question")
        own = chat / "root.jsonl"
        if written:
            own.write_text("{}\n", encoding="utf-8")
        if recorded:
            runs.set_state(con, run["id"], root_session=str(own))
        run = runs.get(con, run["id"])
        root = next(n for n in runs.nodes(con, run["id"]) if runs.is_root(n))
        with pytest.raises(RuntimeError, match="stop here"):
            async with window.node_session(con, cfg, run, root):
                pass
    flags = seen[0]
    assert ("--session" in flags) == (expected == "--session")
    assert ("--continue" in flags) == (expected == "--continue")
    if expected == "--session":
        assert flags[flags.index("--session") + 1] == str(own)
    assert os.path.exists(chat / "another-chat.jsonl")
