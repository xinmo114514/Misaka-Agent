"""Revision-based summary reuse without retaining live runtime objects."""

from __future__ import annotations

import json
from pathlib import Path

from misaka.cli.desktop_bridge import _serialize_session_info
from misaka.core import session_manager as sm


def test_session_summary_reuses_unchanged_file_and_invalidates_after_write(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "session.jsonl"
    path.write_text("\n".join(json.dumps(item) for item in [
        {"type": "session", "version": sm.CURRENT_SESSION_VERSION, "id": "sample", "cwd": str(tmp_path), "timestamp": "2026-10-05T00:00:00Z"},
        {"type": "message", "id": "a", "message": {"role": "user", "content": "first", "timestamp": 1000}},
    ]) + "\n", encoding="utf-8")
    reads = 0
    real_read_text = Path.read_text

    def counted_read_text(self: Path, *args, **kwargs):
        nonlocal reads
        reads += 1
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", counted_read_text)
    assert sm._build_session_info_sync(str(path)).firstMessage == "first"
    assert sm._build_session_info_sync(str(path)).firstMessage == "first"
    assert reads == 1
    path.write_text(path.read_text(encoding="utf-8") + json.dumps({
        "type": "message", "id": "b", "message": {"role": "user", "content": "second", "timestamp": 2000},
    }) + "\n", encoding="utf-8")
    assert sm._build_session_info_sync(str(path)).messageCount == 2
    assert reads == 3


def test_session_list_file_revision_changes_even_if_activity_timestamp_does_not(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    header = {"type": "session", "version": sm.CURRENT_SESSION_VERSION, "id": "sample", "cwd": str(tmp_path), "timestamp": "2026-10-05T00:00:00Z"}
    message = {"type": "message", "id": "a", "message": {"role": "user", "content": "first", "timestamp": 1000}}
    path.write_text(json.dumps(header) + "\n" + json.dumps(message) + "\n", encoding="utf-8")
    first = _serialize_session_info(sm._build_session_info_sync(str(path)))
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"type": "session_info", "name": "renamed"}) + "\n")
    second = _serialize_session_info(sm._build_session_info_sync(str(path)))
    assert first["modified"] == second["modified"]
    assert first["fileRevision"] != second["fileRevision"]


def test_large_session_summary_is_not_retained_beyond_cache_budget(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "large.jsonl"
    path.write_text(json.dumps({"type": "session", "version": sm.CURRENT_SESSION_VERSION,
                                "id": "large", "cwd": str(tmp_path), "timestamp": "2026-10-05T00:00:00Z"}) + "\n"
                    + json.dumps({"type": "message", "id": "a", "message": {
                        "role": "user", "content": "some large summary", "timestamp": 1000,
                    }}) + "\n", encoding="utf-8")
    monkeypatch.setattr(sm, "_SUMMARY_CACHE_BYTE_LIMIT", 1)
    calls = 0
    real_uncached = sm._build_session_info_uncached

    def counted(file_path: str):
        nonlocal calls
        calls += 1
        return real_uncached(file_path)

    monkeypatch.setattr(sm, "_build_session_info_uncached", counted)
    assert sm._build_session_info_sync(str(path)).messageCount == 1
    assert sm._build_session_info_sync(str(path)).messageCount == 1
    assert calls == 2
