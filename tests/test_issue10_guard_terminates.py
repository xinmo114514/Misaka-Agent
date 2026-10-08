"""The live-skill guard ends on every command (GitHub issue #10).

`str.isspace` knows 29 whitespace characters and `shlex.split` four. A word holding only the other
25 -- a full-width space in a CJK grep pattern, a no-break space -- went back on the queue unchanged
and the guard looped forever on the session's event loop: the card spun at 100 % CPU, the chat froze."""
import threading

import pytest

from misaka.core.skills.wiring.skills import _command_touches

UNSPLIT = [c for c in map(chr, range(0x110000)) if c.isspace() and c not in " \t\r\n"]


def _touches(command, workspace="/tmp/workspace", roots=frozenset({"/tmp/live-skills"}), **kw):
    box = {}
    worker = threading.Thread(target=lambda: box.setdefault("v", _command_touches(command, workspace, set(roots), **kw)),
                              daemon=True)
    worker.start()
    worker.join(2)
    assert not worker.is_alive(), f"_command_touches did not return for {command!r}"
    return box["v"]


@pytest.mark.parametrize("shell", ["bash", "powershell"])
@pytest.mark.parametrize("char", UNSPLIT, ids=[f"U+{ord(c):04X}" for c in UNSPLIT])
def test_every_whitespace_shlex_does_not_split_on_ends(char, shell):
    assert _touches(f'grep -n "a{char}b" f.txt', shell=shell) is None


def test_the_reported_command():
    assert _touches('cd /tmp/p && grep -n "^[司定冀]州$\\|^[司定冀]州　" ws.txt | head -30') is None
    assert _touches('cat "　x"') is None


def test_an_unsplit_word_is_still_checked_as_a_path(tmp_path):
    live = str(tmp_path / "live　skills")
    assert _touches('cat "live　skills/S.md"', workspace=str(tmp_path), roots={live}) == "path"
    nested = str(tmp_path / "live-skills")
    assert _touches(f"bash -c 'grep \"a　b\" {nested}/S.md'", roots={nested}) == "path"
