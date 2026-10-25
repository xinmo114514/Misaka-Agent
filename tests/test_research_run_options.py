from misaka.cli.desktop_bridge import research_options_payload, research_start_prompt
from misaka.core.research.wiring.research import parse_command


def test_desktop_options_have_all_nine_native_questions_and_session_bounds():
    payload = research_options_payload({"profiles_root": "", "research_plan_approval": True})
    keys = [question["key"] for question in payload["questions"]]
    assert keys == ["max_depth", "parallel", "sister_parallel", "max_followups", "max_revisions",
                    "max_nodes", "plan_approval", "context_threshold", "max_output_tokens"]
    assert payload["defaults"]["max_depth"] == 3 and payload["defaults"]["plan_approval"] is True
    assert payload["defaults"]["context_threshold"] is None
    assert payload["constraints"]["context_threshold"] == {"min": .1, "max": .95}


def test_typed_start_round_trips_all_nine_limits_without_losing_session_overrides():
    chosen = {"max_depth": 5, "parallel": 4, "sister_parallel": 8, "max_followups": 2,
              "max_revisions": 3, "max_nodes": 80, "plan_approval": True,
              "context_threshold": .5, "max_output_tokens": 32000}
    prompt = research_start_prompt("1968 student's notes", chosen)
    parsed = parse_command(prompt.removeprefix("/research "))
    assert parsed["limits"] == chosen
    assert parsed["question"] == "1968 student's notes"


def test_native_cli_accepts_threshold_percentage_and_output_k_tokens():
    parsed = parse_command("--context-threshold 85% --max-output-tokens 64k -- QUESTION")
    assert parsed["limits"]["context_threshold"] == .85
    assert parsed["limits"]["max_output_tokens"] == 64000
    assert parsed["question"] == "QUESTION"


def test_unconfigured_start_applies_global_plan_approval_instead_of_forcing_required(monkeypatch):
    from misaka.cli import desktop_bridge
    monkeypatch.setattr(desktop_bridge, "current_config", lambda: {"research_plan_approval": False})
    assert "--plan-approval automatic --" in research_start_prompt("QUESTION")
    assert "--plan-approval required --" in research_start_prompt("QUESTION", {"plan_approval": True})
