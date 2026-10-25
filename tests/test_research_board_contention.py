"""Task 3: a held card file lock must not block the board writer.

2026-10-11 audit: mark_stopped mirrored the card file INSIDE its SQLite write transaction and
the card FileLock had no timeout. A second connection waited its full 5 s busy timeout and
failed every dependent write with "database is locked". These tests hold the real per-card
FileLock from another thread and prove the transition refuses within two seconds, before taking a SQL writer,
and other board writes complete while the file lock remains held. The old behavior is reproduced by asserting the new path does NOT raise
sqlite3.OperationalError while the lock is held.
"""
from __future__ import annotations

import os
import time
from contextlib import closing

import pytest
from filelock import FileLock, Timeout

from misaka.core.platform import cards as card_files
from misaka.core.platform import tasks


@pytest.fixture
def board(tmp_path, monkeypatch):
    from misaka.core.platform import repo
    monkeypatch.setattr(repo, "enabled", lambda *a: False)
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        from misaka.core.research import runs
        runs.init(con)
        yield con


def _card(board, tmp_path, **kwargs):
    workspace = tmp_path / "project"
    workspace.mkdir(exist_ok=True)
    return card_files.create(board, str(workspace), kwargs.get("title", "T"), "body", "10032"), str(workspace)


def test_mark_stopped_does_not_wait_on_a_held_card_lock(board, tmp_path):
    tid, _workspace = _card(board, tmp_path)
    lock_path = os.path.join(tasks.task_state_dir(tid), "card.lock")
    holder = FileLock(lock_path)
    holder.acquire()
    try:
        started = time.monotonic()
        # File is authoritative: a held lock admits no false SQL-only success.
        with pytest.raises(Timeout):
            tasks.mark_stopped(board, tid)
        elapsed = time.monotonic() - started
        assert elapsed < 2.0, f"transition waited {elapsed:.2f}s on the held card lock"
        assert tasks.get(board, tid)["status"] == "ready"
    finally:
        holder.release()


def test_a_second_connection_can_write_while_a_card_lock_is_held(board, tmp_path):
    tid, _workspace = _card(board, tmp_path)
    lock_path = os.path.join(tasks.task_state_dir(tid), "card.lock")
    holder = FileLock(lock_path)
    holder.acquire()
    other = tasks.connect(str(tmp_path / "board.db"))
    try:
        with pytest.raises(Timeout):
            tasks.mark_stopped(board, tid)
        # The regression was this write raising OperationalError('database is locked').
        assert tasks.add_event(other, tid, "contention-probe", {"ok": True}) is True
    finally:
        other.close()
        holder.release()


def test_submit_does_not_wait_on_a_held_card_lock(board, tmp_path):
    tid, _workspace = _card(board, tmp_path)
    assert tasks.claim(board, tid, "lock-1", generation=1, pid=os.getpid())
    lock_path = os.path.join(tasks.task_state_dir(tid), "card.lock")
    holder = FileLock(lock_path)
    holder.acquire()
    started = time.monotonic()
    try:
        with pytest.raises(Timeout):
            tasks.submit_task(board, tid, generation=1, claim_lock="lock-1")
        assert time.monotonic() - started < 2.0
        assert tasks.get(board, tid)["status"] == "running"
    finally:
        holder.release()


_HOLDER = """
import sys, time
from filelock import FileLock, Timeout
lock = FileLock(sys.argv[1])
lock.acquire()
open(sys.argv[2], "w").close()
time.sleep(float(sys.argv[3]))
lock.release()
"""


def test_cross_process_card_lock_holder_does_not_stall_the_writer(board, tmp_path):
    """The real incident: another process held the card lock; the board writer must not wait.

    Old behavior (reproduced red on the pre-fix baseline): mark_stopped entered its write
    transaction and blocked on the card's FileLock until the 8 s holder exited; a second
    connection's write then failed with sqlite3.OperationalError('database is locked').
    """
    import subprocess
    import sys
    import threading

    tid, _workspace = _card(board, tmp_path)
    lock_path = os.path.join(tasks.task_state_dir(tid), "card.lock")
    ready = tmp_path / "holder.ready"
    script = tmp_path / "holder.py"
    script.write_text(_HOLDER, encoding="utf-8")
    holder = None
    for _attempt in range(6):
        try:
            holder = subprocess.Popen([sys.executable, str(script), lock_path, str(ready), "6"],
                                      stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL)
            break
        except PermissionError:
            # This host intermittently refuses a child start under load (WinError 5); it is an
            # environment failure, not the contract under test.
            time.sleep(0.5)
    if holder is None:
        pytest.skip("this host cannot spawn the lock-holding helper (WinError 5)")
    deadline = time.monotonic() + 10
    while not ready.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert ready.exists(), "holder did not take the card lock"
    other = tasks.connect(str(tmp_path / "board.db"))
    elapsed = {}
    try:
        def transition():
            started = time.monotonic()
            try:
                tasks.mark_stopped(board, tid)
            except Timeout:
                elapsed["bounded_refusal"] = True
            elapsed["seconds"] = time.monotonic() - started

        worker = threading.Thread(target=transition)
        worker.start()
        time.sleep(0.3)
        # While the transition is in flight, another connection must still be able to write.
        try:
            other_write = tasks.add_event(other, tid, "contention-probe", {"ok": True})
            elapsed["other"] = other_write
        except Exception as error:  # noqa: BLE001 - the regression is exactly this failure
            elapsed["other_error"] = f"{type(error).__name__}: {error}"
        worker.join(12)
        assert not worker.is_alive(), "transition never returned while the card lock was held"
        assert elapsed.get("bounded_refusal") is True
        assert tasks.get(board, tid)["status"] == "ready"
        assert elapsed["seconds"] < 2.0, f"transition waited {elapsed['seconds']:.2f}s on the lock"
        assert elapsed.get("other") is True, elapsed.get("other_error")
    finally:
        other.close()
        holder.terminate()
        holder.wait(5)
