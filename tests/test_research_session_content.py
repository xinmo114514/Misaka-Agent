"""Full transcript bodies retain their native shape and cursor contract."""

import json
from contextlib import closing

import pytest

from misaka.core.platform import tasks
from misaka.core.research import desktop_view, runs
from misaka.utils.redact import redact


def _write_session(path, entries):
    header = {"type": "session", "version": 3, "id": "content-fixture",
              "timestamp": "2026-10-22T00:00:00+00:00", "cwd": str(path.parent)}
    path.write_text("".join(json.dumps(entry, ensure_ascii=False) + "\n"
                            for entry in [header, *entries]), encoding="utf-8")


def _body_entry(content, *, entry_type="custom_message", custom_type="research-final"):
    entry = {"type": entry_type, "id": "body-entry", "parentId": None,
             "timestamp": "2026-10-22T00:00:01+00:00"}
    if entry_type == "custom_message":
        entry.update(customType=custom_type, display=True, content=content)
    else:
        entry["message"] = {"role": "assistant", "content": content}
    return entry


@pytest.fixture
def content_session(tmp_path):
    path = tmp_path / "session.jsonl"
    _write_session(path, [])
    with closing(tasks.connect(str(tmp_path / "board.db"))) as con:
        runs.init(con)
        run = runs.create(con, workspace=str(tmp_path), question="Read complete saved bodies")
        runs.set_state(con, run["id"], root_session=str(path))
        executor = desktop_view.session_descriptors(con, run["id"])[0]["executorId"]
        yield con, run["id"], executor, path


@pytest.mark.parametrize("custom_type", ["research-final", "research-phase"])
@pytest.mark.parametrize(("content", "expected"), [
    pytest.param("完整结论🙂", "完整结论🙂", id="string"),
    pytest.param([
        {"type": "text", "text": "第一段🙂"},
        {"type": "thinking", "thinking": "not body text"},
        {"type": "image", "data": "not body text"},
        {"type": "text", "text": "第二段"},
    ], "第一段🙂\n第二段", id="text-blocks"),
    pytest.param("", "", id="empty-string"),
    pytest.param([], "", id="empty-list"),
    pytest.param(None, "", id="null"),
])
def test_custom_full_content_reads_top_level_body(content_session, custom_type, content, expected):
    con, run_id, executor, path = content_session
    _write_session(path, [_body_entry(content, custom_type=custom_type)])

    page = desktop_view.session_content(con, run_id, executor, "body-entry")

    assert page == {"content": expected, "nextOffset": None, "hasMore": False}


@pytest.mark.parametrize(("content", "expected"), [
    pytest.param("原始正文🙂", "原始正文🙂", id="string"),
    pytest.param([
        {"type": "text", "text": "before"},
        {"type": "toolCall", "id": "call-1", "name": "read", "arguments": {}},
        {"type": "text", "text": "after"},
    ], "before\nafter", id="text-blocks"),
    pytest.param("", "", id="empty-string"),
    pytest.param([], "", id="empty-list"),
    pytest.param(None, "", id="null"),
])
def test_normal_full_content_reads_nested_message_body(content_session, content, expected):
    con, run_id, executor, path = content_session
    _write_session(path, [_body_entry(content, entry_type="message")])

    assert desktop_view.session_content(con, run_id, executor, "body-entry") == {
        "content": expected, "nextOffset": None, "hasMore": False,
    }


@pytest.mark.parametrize("entry_type", ["custom_message", "message"])
def test_full_content_uses_the_authoritative_shape_not_a_decoy(content_session, entry_type):
    con, run_id, executor, path = content_session
    entry = _body_entry("authoritative", entry_type=entry_type)
    if entry_type == "custom_message":
        entry["message"] = {"role": "assistant", "content": "nested decoy"}
    else:
        entry["content"] = "top-level decoy"
    _write_session(path, [entry])

    assert desktop_view.session_content(con, run_id, executor, "body-entry")["content"] == "authoritative"


@pytest.mark.parametrize("entry", [
    pytest.param({"type": "custom_message", "id": "body-entry", "display": True}, id="custom-missing-content"),
    pytest.param({"type": "message", "id": "body-entry"}, id="missing-message"),
    pytest.param({"type": "message", "id": "body-entry", "message": None}, id="null-message"),
    pytest.param({"type": "message", "id": "body-entry", "message": {"role": "assistant"}},
                 id="missing-nested-content"),
])
def test_full_content_treats_missing_bodies_as_empty(content_session, entry):
    con, run_id, executor, path = content_session
    _write_session(path, [entry])

    assert desktop_view.session_content(con, run_id, executor, "body-entry") == {
        "content": "", "nextOffset": None, "hasMore": False,
    }


def _read_all(con, run_id, executor, expected, *, limit=desktop_view.EXECUTION_PREVIEW_BYTES):
    offset, parts = 0, []
    for _ in range(len(expected) + 1):
        page = desktop_view.session_content(con, run_id, executor, "body-entry", offset=offset, limit=limit)
        part = page["content"]
        assert part == expected[offset:offset + len(part)]
        assert len(part.encode("utf-8")) <= max(limit, len(expected[offset:offset + 1].encode("utf-8")))
        assert "\ufffd" not in part
        parts.append(part)
        end = offset + len(part)
        if end < len(expected):
            assert part
            assert page["hasMore"] is True
            assert page["nextOffset"] == end > offset
            offset = page["nextOffset"]
        else:
            assert page["hasMore"] is False
            assert page["nextOffset"] is None
            break
    else:
        pytest.fail("content cursor did not finish")
    assert "".join(parts) == expected
    return parts


@pytest.mark.parametrize("entry_type", ["custom_message", "message"])
@pytest.mark.parametrize("body_shape", ["string", "text-blocks"])
def test_cjk_and_emoji_content_pages_reconstruct_the_entire_body(content_session, entry_type, body_shape):
    con, run_id, executor, path = content_session
    first = "".join(f"{index:05d}：中文🙂·证据🧪\n" for index in range(2400))
    second = "".join(f"{index:05d}：后续🙂·结论🧪\n" for index in range(2400, 4800))
    expected = first + "\n" + second
    content = expected if body_shape == "string" else [
        {"type": "text", "text": first},
        {"type": "thinking", "thinking": "not body text"},
        {"type": "text", "text": second},
    ]
    assert len(expected.encode("utf-8")) > 4 * desktop_view.EXECUTION_PREVIEW_BYTES
    _write_session(path, [_body_entry(content, entry_type=entry_type)])

    parts = _read_all(con, run_id, executor, expected)

    assert len(parts) > 4
    assert all(len(part.encode("utf-8")) <= desktop_view.EXECUTION_PREVIEW_BYTES for part in parts)


@pytest.mark.parametrize("entry_type", ["custom_message", "message"])
def test_body_content_makes_codepoint_progress_with_a_one_byte_budget(content_session, entry_type):
    con, run_id, executor, path = content_session
    expected = "中🙂文🧪"
    _write_session(path, [_body_entry(expected, entry_type=entry_type)])

    assert _read_all(con, run_id, executor, expected, limit=1) == list(expected)


@pytest.mark.parametrize("entry_type", ["custom_message", "message"])
def test_body_content_redacts_the_whole_body_before_byte_paging(content_session, entry_type):
    con, run_id, executor, path = content_session
    secret = "sk-" + "aB3cD4" * 12
    body = f"前缀🙂\nAuthorization: Bearer {secret}\n后续结论🧪"
    expected = redact(body)
    assert secret not in expected and len(expected) < len(body)
    _write_session(path, [_body_entry(body, entry_type=entry_type)])

    _read_all(con, run_id, executor, expected, limit=7)


def test_content_read_keeps_tool_arguments_result_error_and_message_fields_independent(content_session):
    con, run_id, executor, path = content_session
    arguments = {"path": "证据🙂.md", "api_key": "sk-fixture-abcdef0123456789"}
    output = "tool failure🙂\nAuthorization: Bearer fixture-secret-token"
    _write_session(path, [
        _body_entry([
            {"type": "text", "text": "before"},
            {"type": "toolCall", "id": "call-1", "name": "read", "arguments": arguments},
            {"type": "text", "text": "after"},
        ], entry_type="message"),
        {"type": "message", "id": "result-entry", "message": {"role": "toolResult",
         "toolCallId": "call-1", "isError": True, "content": [{"type": "text", "text": output}]}},
    ])

    assert desktop_view.session_content(con, run_id, executor, "body-entry")["content"] == "before\nafter"
    assert desktop_view.session_content(con, run_id, executor, "call-1", field="arguments")["content"] == redact(
        json.dumps(arguments, ensure_ascii=False, indent=2))
    for field in ("result", "error"):
        assert desktop_view.session_content(con, run_id, executor, "call-1", field=field)["content"] == redact(output)


def test_content_reads_retain_run_executor_and_entry_scoping(content_session, tmp_path):
    con, run_id, executor, path = content_session
    _write_session(path, [_body_entry("belongs to this executor")])
    foreign = runs.create(con, workspace=str(tmp_path), question="Another run")

    assert desktop_view.session_content(con, foreign["id"], executor, "body-entry") is None
    assert desktop_view.session_content(con, "missing-run", executor, "body-entry") is None
    assert desktop_view.session_content(con, run_id, "missing-executor", "body-entry") is None
    assert desktop_view.session_content(con, run_id, str(path), "body-entry") is None
    assert desktop_view.session_content(con, run_id, executor, "missing-entry") == {
        "content": "", "nextOffset": None, "hasMore": False,
    }


@pytest.mark.parametrize("field", ["thinking", "details", "sessionFile"])
def test_content_reads_keep_the_existing_field_enum(content_session, field):
    con, run_id, executor, _ = content_session

    with pytest.raises(ValueError, match="Unknown session content field"):
        desktop_view.session_content(con, run_id, executor, "body-entry", field=field)


def test_body_content_keeps_the_response_cap_and_offset_boundaries(content_session):
    con, run_id, executor, path = content_session
    body = "界🙂" * 12000
    _write_session(path, [_body_entry(body, entry_type="message")])

    capped = desktop_view.session_content(con, run_id, executor, "body-entry", offset=-5, limit=10**9)

    assert capped["content"] == body[:capped["nextOffset"]]
    assert len(capped["content"].encode("utf-8")) <= desktop_view.EXECUTION_PREVIEW_BYTES
    assert capped["hasMore"] is True
    assert desktop_view.session_content(con, run_id, executor, "body-entry", offset=len(body) + 10) == {
        "content": "", "nextOffset": None, "hasMore": False,
    }
