"""Ordinary root prompts use the same durable research ingress as the research channel."""
import io
import json
import sqlite3
import sys
from unittest.mock import AsyncMock

import pytest

from tests.test_desktop_bridge import MockRuntimeHost, MockSession
from tests.test_desktop_research_message_entry import waiting_root  # noqa: F401


@pytest.mark.asyncio
async def test_waiting_root_prompt_replay_is_durable_after_resume_and_bridge_recreation(waiting_root, tmp_path, monkeypatch):  # noqa: F811
    from misaka.cli import desktop_bridge as bridge
    from misaka.core import session_control
    from misaka.core.research import runs

    case = waiting_root
    session = MockSession(case.session.sessionId)
    session.sessionManager = case.session.sessionManager
    session.moments = case.session.moments
    session.sendCustomMessage = case.session.sendCustomMessage
    session.prompt = AsyncMock()
    monkeypatch.setattr(session_control, 'for_session', lambda owner: case.control if owner is session else None)
    original_execute = case.control._execute

    async def execute(command):
        await original_execute(command)
        runs.set_state(case.con, case.run['id'], status='active')

    case.control._execute = execute

    def readonly():
        con = sqlite3.connect((tmp_path / 'board.db').as_uri() + '?mode=ro', uri=True)
        con.row_factory = sqlite3.Row
        con.execute('PRAGMA query_only=ON')
        return con

    monkeypatch.setattr(bridge, '_open_research_readonly', readonly)
    command = {'type': 'prompt', 'requestId': 'ordinary-answer', 'text': '掌权30年吧'}
    replies = []
    for count in (2, 1):
        output = io.StringIO()
        monkeypatch.setattr(bridge, 'writeRawStdout', output.write)
        monkeypatch.setattr(sys, 'stdin', io.StringIO(''.join(json.dumps(item) + '\n'
            for item in [*[command] * count, {'type': 'shutdown'}])))
        assert await bridge.run_desktop_bridge(MockRuntimeHost(session)) == 0
        replies.extend(json.loads(line) for line in output.getvalue().splitlines()
                       if json.loads(line).get('requestId') == command['requestId'])
    assert len(case.control.commands) == 1
    assert case.control.commands[0]['text'] == f"/research resume {case.run['id']} 掌权30年吧"
    assert len(replies) == 3 and all(reply['ok'] for reply in replies)
    assert len(case.session.custom_messages) == 1
    session.prompt.assert_not_awaited()
