"""Test helper names must not shadow modules in real child-process startup."""
import subprocess
import sys
from pathlib import Path


def test_child_from_tests_directory_can_import_tempfile_and_mcp():
    result = subprocess.run(
        [sys.executable, "-c", "import tempfile; import mcp; print(tempfile.TemporaryDirectory.__module__)"],
        cwd=Path(__file__).resolve().parent, capture_output=True, text=True, timeout=15, check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "tempfile"
