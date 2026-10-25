from types import SimpleNamespace

import pytest

from misaka.core.session_control import SessionControl


@pytest.mark.asyncio
async def test_read_only_stats_returns_context_usage_without_scheduling_a_turn():
    class Session:
        isIdle = True

        def __init__(self):
            self.prompt_calls = []
            self.sessionManager = SimpleNamespace(getLeafId=lambda: None, getEntryCount=lambda: 0,
                getEntries=list, getCwd=lambda: 'C:/fixture')

        def getSessionStats(self):
            return {"totalMessages": 15, "totalTokens": 4200}

        def getContextUsage(self):
            return {"tokens": 4200, "contextWindow": 128000, "percent": 0.0328}

        def prompt(self, *args, **kwargs):
            self.prompt_calls.append((args, kwargs))

    session = Session()
    control = SessionControl(session, catalog=SimpleNamespace(spec=None))

    result = await control._execute({"operation": "stats"})

    assert {key: result[key] for key in ('stats', 'contextUsage')} == {
        "stats": {"totalMessages": 15, "totalTokens": 4200},
        "contextUsage": {"tokens": 4200, "contextWindow": 128000, "percent": 0.0328},
    }
    assert result['telemetry']['contextUsage'] == result['contextUsage']
    assert result['telemetry']['cwd'] == 'C:/fixture'
    assert session.prompt_calls == []
