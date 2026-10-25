from pathlib import Path

import httpx
import pytest
from test_research_plan_change import executing as _executing_fixture

from misaka.core.network import worker
from misaka.core.platform import tasks
from misaka.core.research import runs

# Expose the imported fixture object under its pytest lookup name without shadowing the import.
executing = _executing_fixture

def test_research_completion_requires_this_generations_evidence_note(executing):
    con, run, _root, _, _ = executing
    card = next(dict(row) for row in runs.tasks(con, run["id"]) if row["local_id"] == "a")
    worker.record_output_baseline(con, card)
    (Path(card["output_dir"]) / "a.md").write_text("The source is missing; this remains uncertain.", encoding="utf-8")
    with pytest.raises(worker.IncompleteSubmission, match="misaka_card_note"):
        worker.build_submission(con, card, "deliverable written")
    tasks.add_event(con, card["id"], "research_evidence",
        {"findings": [], "uncertain": ["The source is unavailable."]}, generation=card["generation"])
    submission = worker.build_submission(con, card, "uncertainty documented")
    assert submission["findings"] == []
    assert submission["uncertain"] == ["The source is unavailable."]
    assert any(path.endswith("a.md") for path in submission["artifacts"])


@pytest.mark.parametrize("eventual_success", [True, False])
async def test_download_retries_one_transport_failure_and_then_returns_a_result(tmp_path, monkeypatch, eventual_success):
    from misaka.core.tools import download_file
    attempts = 0
    async def transport(*args):
        nonlocal attempts
        attempts += 1
        if attempts == 2 and eventual_success:
            return download_file._result("downloaded evidence", is_error=False)
        raise httpx.ConnectError("transient network failure")
    monkeypatch.setattr(download_file, "_download", transport)
    tool = download_file.create_download_file_tool_definition(str(tmp_path))
    result = await tool.execute("download", {"url": "https://example.org/evidence.pdf"}, None, None, None)
    assert attempts == 2
    assert result.details["isError"] is not eventual_success
    if eventual_success:
        assert result.content[0].text == "downloaded evidence"
    else:
        assert result.details["skipped"] and result.details["retryAttempts"] == 2


def test_429_usage_limit_is_terminal_quota_not_endless_rate_limit_cooldown():
    from misaka.ai.utils.retry import NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN
    assert tasks.classify_failure('429 {"error":{"code":"usage_limit_reached"}}') == "auth_or_quota"
    assert NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.search("429 usage_limit_reached")


def test_resumed_research_card_opens_its_saved_independent_context(tmp_path, monkeypatch):
    from misaka.config import sessions
    saved = tmp_path / "card-sessions"
    saved.mkdir()
    transcript = saved / "previous.jsonl"
    transcript.write_text('{"type":"session","version":3,"id":"saved-context","cwd":"C:/fixture"}\n', encoding="utf-8")
    monkeypatch.setattr(sessions, "card_session_dir", lambda task: str(saved))
    monkeypatch.setattr(worker, "card_session_setup", lambda *args: ([], None, "resume contract", str(tmp_path / "unused-sandbox"), "reader"))
    calls = []
    async def execute(flags, prompt, cwd, **kwargs):
        calls.append((flags, prompt))
        return {"text": None, "timed_out": False, "error": None}
    monkeypatch.setattr(worker, "run_session", execute)
    worker.run_card({"id": "t_resume", "generation": 2}, str(tmp_path), str(tmp_path), "fixture", "fixture", lambda event: None)
    assert calls[0][0] == ["--session", str(transcript)]
    assert calls[0][1] == "resume contract"
