import argparse

import pytest

from misaka.cli.args import add_desktop_bridge_subparser
from misaka.cli.desktop_bridge import research_start_prompt
from misaka.core.research.wiring.research import parse_command


def test_desktop_bridge_accepts_an_explicit_research_context_flag():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    add_desktop_bridge_subparser(commands)

    args = parser.parse_args(["desktop-bridge", "--cwd", ".", "--research-context"])

    assert args.research_context is True


def test_research_start_prompt_preserves_question_and_every_run_limit():
    prompt = research_start_prompt(
        "Compare RAG and long-context methods: strengths, trade-offs, and failure cases",
        {"max_depth": 1, "parallel": 1, "sister_parallel": 2, "max_followups": 0,
         "max_revisions": 0, "max_nodes": 3, "plan_approval": True},
    )

    assert prompt == (
        "/research --depth 1 --parallel 1 --sister-parallel 2 --followups 0 --revisions 0 "
        "--max-nodes 3 --plan-approval required -- Compare RAG and long-context methods: "
        "strengths, trade-offs, and failure cases"
    )


def test_research_start_prompt_validates_limits_before_opening_a_run():
    with pytest.raises(ValueError, match="max_nodes"):
        research_start_prompt("A research question", {"max_depth": 1, "max_nodes": 0})


def test_research_start_prompt_rejects_an_unrecognized_approval_policy():
    with pytest.raises(ValueError, match="plan_approval"):
        research_start_prompt("A research question", {"plan_approval": "maybe"})


def test_research_slash_parser_preserves_question_and_plan_approval_after_options():
    parsed = parse_command(
        "--depth 1 --parallel 1 --sister-parallel 2 --followups 0 --revisions 0 "
        "--max-nodes 3 --plan-approval required -- Compare RAG and long-context methods"
    )

    assert parsed["question"] == "Compare RAG and long-context methods"
    assert parsed["limits"]["max_depth"] == 1
    assert parsed["limits"]["parallel"] == 1
    assert parsed["limits"]["sister_parallel"] == 2
    assert parsed["limits"]["max_followups"] == 0
    assert parsed["limits"]["max_revisions"] == 0
    assert parsed["limits"]["max_nodes"] == 3
    assert parsed["limits"]["plan_approval"] is True


def test_research_slash_parser_can_start_with_a_flag_like_research_question():
    parsed = parse_command("--depth 1 -- --depth is also part of this question")
    assert parsed["question"] == "--depth is also part of this question"
