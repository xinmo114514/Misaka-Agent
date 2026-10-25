"""One pre-run configuration contract for native TUI and desktop."""
from __future__ import annotations

import re

from misaka.core.research import runs

GLOBAL_THRESHOLD = "Global setting"
MODEL_OUTPUT = "Model default"

QUESTIONS = (
    ("max_depth", "Research depth", "How deep should this research run go?", [(2, "Quick pass: branches go at most 2 levels deep."), (5, "Standard deep research: branches go at most 5 levels deep."), (10, "Exhaustive: branches go at most 10 levels deep. Slow and costly.")]),
    ("parallel", "LO parallelism", "How many Last Order nodes may run at once?", [(4, "Default: up to 4 LO nodes at once; independent of Sister cards per LO."), (1, "One LO node at a time; lowest concurrent resource use."), (8, "Up to 8 LO nodes at once; more simultaneous sessions and requests.")]),
    ("sister_parallel", "Sister cards per LO", "How many Sister cards may be active per Last Order node?", [(4, "Default: up to 4 active Sister cards per LO; global admission limits still apply."), (1, "One active Sister card per LO at a time."), (8, "Up to 8 active Sister cards per LO, including multiple sessions of the same Sister.")]),
    ("max_followups", "Follow-ups", "After its first cards are back, how many more times may a node send its Sisters out before it concludes?", [(2, "Default: up to two more rounds of cards after the first, per node."), (0, "None: every node concludes from its first cards."), (4, "Up to four more rounds per node; thorough and slow.")]),
    ("max_revisions", "Revisions", "How many times may a node revise its conclusion after the red team's review?", [(2, "Default: up to two revisions after red-team review."), (0, "No revisions: answer objections on record."), (4, "Up to four revisions, each reviewed again.")]),
    ("max_nodes", "Nodes", "How many nodes may the research graph hold in all?", [(30, "Default: up to 30 nodes, the root included."), (12, "A small graph: a few alternatives explored in depth."), (80, "A large graph for questions with many genuine alternatives; slow and costly.")]),
    ("plan_approval", "Plan approval", "Should each research plan wait for your approval?", [(True, "Each plan and each reconciliation of the graph waits for your go-ahead before execution."), (False, "Accepted plans proceed without an extra approval wait; genuine clarification and a reframed question still need your input.")]),
    ("context_threshold", "Compaction", "At what share of the context window should this run's sessions compact their context?", [(None, "Default: the global setting every other session uses."), (.5, "Compact at half the window: smaller requests, earlier summaries."), (.85, "Compact late: more of the conversation stays verbatim; larger, costlier requests.")]),
    ("max_output_tokens", "Output limit", "How long may each reply in this run be, at most?", [(None, "Default: each model's own maximum."), (64000, "At most 64,000 tokens per reply, or the model's maximum if lower."), (32000, "At most 32,000 tokens per reply, or the model's maximum if lower.")]),
)
QUESTION_TEXT = {key: question for key, _header, question, _choices in QUESTIONS}


def parse_threshold(answer):
    text = str(answer or "").strip()
    if not text or text.startswith(GLOBAL_THRESHOLD):
        return None
    try:
        value = float(text.rstrip("%").strip())
    except ValueError:
        raise ValueError(f"Compaction threshold must be a fraction or percentage, not {text!r}.") from None
    if text.endswith("%") or value >= 1:
        value /= 100
    if not runs.MIN_CONTEXT_THRESHOLD <= value <= runs.MAX_CONTEXT_THRESHOLD:
        raise ValueError("Compaction threshold must be between 10% and 95%.")
    return round(value, 4)


def parse_output(answer):
    text = str(answer or "").strip()
    if not text or text.startswith(MODEL_OUTPUT):
        return None
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([kK])?", text.replace(",", ""))
    if match is None:
        raise ValueError("Output limit must be a number of tokens such as 64000 or 64k.")
    value = int(float(match.group(1)) * (1000 if match.group(2) else 1))
    if value < 1024:
        raise ValueError("Output limit must be at least 1024 tokens.")
    return value


def questions(config=None):
    from misaka.core.research import planner
    approval = planner.plan_waits_for_user(config or {})
    result = []
    for key, header, question, choices in QUESTIONS:
        options = []
        for value, description in choices:
            label = ("Require approval" if value else "Automatic") if key == "plan_approval" else (
                GLOBAL_THRESHOLD if key == "context_threshold" and value is None else
                MODEL_OUTPUT if key == "max_output_tokens" and value is None else
                f"{value // 1000}k" if key == "max_output_tokens" else str(value))
            options.append({"label": label, "description": description, "value": value})
        if key == "plan_approval" and not approval:
            options.reverse()
        result.append({"key": key, "header": header, "question": question, "options": options})
    return result


def wizard_questions(config=None):
    return [{"header": item["header"], "question": item["question"], "multiSelect": False,
             "options": [{"label": opt["label"], "description": opt["description"]} for opt in item["options"]]}
            for item in questions(config)]
