"""``python -m misaka.cli.research_node --run-card TASK_ID [--say TEXT] [--expected-generation N]
[--consult]``: a research card's child process. With ``--say`` it continues the settled card with
that message instead; ``--expected-generation`` pins the attempt it must still be, and
``--consult`` records that she is only answering a message (the desktop continuation's fences).

Node executors use ``misaka research --node`` in the background; a card child needs
no CLI surface beyond this entry. It runs the same entry wiring as the CLI
(``misaka.cli.bootstrap``) before
``misaka.core.research.node`` builds its session.
"""

from __future__ import annotations

import sys

from misaka.cli import bootstrap
from misaka.cli.setup import setupCli
from misaka.core.research import node


def main(argv: list[str] | None = None) -> int:
    setupCli()
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) < 2 or args[0] != "--run-card":
        sys.exit("usage: python -m misaka.cli.research_node --run-card TASK_ID [--say TEXT] "
                 "[--expected-generation N] [--consult]")
    task_id, say, expected_generation, consult = args[1], None, None, False
    rest = args[2:]
    while rest:
        flag = rest.pop(0)
        if flag == "--say" and rest:
            say = rest.pop(0)
        elif flag == "--say-file" and rest:
            from misaka.utils.prompt_file import readPromptFile
            say = readPromptFile(rest.pop(0))
        elif flag == "--expected-generation" and rest:
            expected_generation = int(rest.pop(0))
        elif flag == "--consult":
            consult = True
        else:
            sys.exit(f"unknown argument: {flag}")
    bootstrap.install()
    from misaka.utils import loop_watchdog
    loop_watchdog.configure(f"card-{task_id}", exit_on_stall=True)
    from misaka.config import env as env_file
    env_file.load()
    return node.main_card(task_id, say=say, consult=consult, expected_generation=expected_generation)


if __name__ == "__main__":
    raise SystemExit(main())
