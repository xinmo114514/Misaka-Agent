"""Desktop role instructions and later extension sections reach the same model turn."""
import json
from types import SimpleNamespace

import pytest

from misaka.desktop_research.runtime import DesktopScenePart
from tests.test_prompt_assembly_integration import assembled, final_prompt
from tests.test_prompt_assembly_integration import (
    prompt_home as prompt_home,  # noqa: PLC0414 - pytest fixture re-export
)


@pytest.mark.parametrize("role,kind,root", [
    ("last_order", "foreground", True),
    ("sisters/10032", "card", False),
])
async def test_desktop_scene_keeps_the_native_mcp_catalog(prompt_home, role, kind, root):
    config = prompt_home / "profiles" / role / "mcp.json"
    config.write_text(json.dumps({"mcpServers": {
        "vault": {"command": "misaka-fixture-absent-server", "description": "A vault of research evidence."}
    }}), encoding="utf-8")
    async def release_session(_session):
        pass
    scope = SimpleNamespace(team=SimpleNamespace(shared_root=prompt_home / "shared",
        snapshot=lambda: {"team": {"members": []}}), release_session=release_session)
    async with assembled(prompt_home, role, kind) as session:
        scene = DesktopScenePart(scope, member_name=None if root else "archivist", root=root)
        scene.session = session
        session.moments.parts.append(scene)
        await session.bindExtensions({})
        prompt = await final_prompt(session)
        assert "Scene: desktop_research" in prompt
        assert ("ORIGINAL root coordinator" if root else "task-local member archivist") in prompt
        assert "- mcp__vault (codemode): A vault of research evidence." in prompt
        assert session._runSystemPromptOptions.get("forceSystemPrompt") is None
        assert await final_prompt(session) == prompt
        scene.intake = True
        intake_prompt = await final_prompt(session)
        assert intake_prompt.count("## Desktop research scene") == 1
        assert "## Desktop research team intake" in intake_prompt
        assert "- mcp__vault (codemode): A vault of research evidence." in intake_prompt
