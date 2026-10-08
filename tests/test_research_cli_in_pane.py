"""`misaka research` typed into a pane's shell (issue #10 plan, O7)."""
import subprocess
from types import SimpleNamespace


def test_a_cli_run_in_a_panes_shell_still_shows_its_nodes(monkeypatch, tmp_path):
    """issue #10 plan, O7: `misaka research` typed into a pane's shell inherits MISAKA_NET_PANE,
    and every node's output went to DEVNULL. The pane identity still never reaches a child."""
    from misaka.core.research.node import ProcessSpawner
    monkeypatch.setenv("MISAKA_NET_PANE", "pane-1")
    seen = {}
    monkeypatch.setattr(subprocess, "Popen", lambda argv, **kw: seen.update(kw) or SimpleNamespace())
    ProcessSpawner(show_output=True).spawn(["x"], cwd=str(tmp_path))
    assert seen["stdout"] is None and "MISAKA_NET_PANE" not in seen["env"]
    ProcessSpawner().spawn(["x"], cwd=str(tmp_path))
    assert seen["stdout"] is subprocess.DEVNULL, "a pane's TUI still gets no child output on its screen"
