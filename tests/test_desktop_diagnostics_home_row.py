"""The Electron shell writes into the home, so its directory is a row of the table.

The shell has no Python on its startup path -- it is the thing that has to keep working when the
bridge is the thing that is stuck -- so it resolves the path itself. That makes the row here the one
agreement between the two halves, and this test is what keeps them from drifting.
"""
from __future__ import annotations

import re
from pathlib import Path

from misaka.config import home

PACKAGE = Path(__file__).resolve().parents[1]
DIAGNOSTICS_TS = PACKAGE / "desktop" / "electron" / "diagnostics.ts"


def test_the_shell_diagnostics_directory_is_a_declared_logs_row():
    entry = home.LAYOUT["desktop_diagnostics"]
    assert entry.kind == "logs"
    assert entry.rel == "logs/desktop-diagnostics"
    assert home.path("desktop_diagnostics").as_posix().endswith("logs/desktop-diagnostics")


def test_the_shell_names_the_same_relative_path_as_the_table():
    # One string on each side of the boundary: a typo is a stray directory in a user's home.
    source = DIAGNOSTICS_TS.read_text(encoding="utf-8")
    declared = re.search(r"DIAGNOSTICS_REL_PATH = '([^']+)'", source)
    assert declared, "electron/diagnostics.ts must name the home row it writes under"
    assert declared.group(1) == home.LAYOUT["desktop_diagnostics"].rel


def test_the_shell_retains_diagnostics_for_a_bounded_window(tmp_path, monkeypatch):
    """Retention is stated in one place on each side; the shell's own cap is the smaller one."""
    assert home.LAYOUT["desktop_diagnostics"].mode is None
    source = DIAGNOSTICS_TS.read_text(encoding="utf-8")
    rotate = int(re.search(r"ROTATE_BYTES = (\d+) \* 1024", source).group(1))
    total = int(re.search(r"TOTAL_BYTES = (\d+) \* 1024", source).group(1))
    days = int(re.search(r"RETAIN_DAYS = (\d+)", source).group(1))
    assert rotate == 2 and total == 10 and days == 14
