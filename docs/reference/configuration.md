# Configuration reference

Every setting has a working default, so you can skip this page until you want to change
something. Most settings also have a command that writes them for you (`/model`, `misaka web`,
`misaka setup`); editing the files by hand is always allowed.

## Where settings live

MISAKA keeps what is yours, across projects, in one folder, the **home**: `~/.misaka/` (set
`MISAKA_HOME` to move it). A project folder holds only what belongs to that project.

| File | What it holds |
|---|---|
| `~/.misaka/settings.json` | every setting on this page |
| `~/.misaka/.env` | API keys for web services and skills, and other environment variables (owner-only) |
| `~/.misaka/credentials/auth.json` | provider sign-ins from `/login` (owner-only; don't edit by hand) |
| `~/.misaka/models.json` | providers and models the built-in catalog does not know, such as a local server |
| `~/.misaka/keybindings.json` | your changes to the chat box's keys |
| `~/.misaka/MISAKA.md` | the identity every agent shares |
| `~/.misaka/profiles/last_order/` | Last Order's own files |
| `~/.misaka/profiles/sisters/<id>/` | one folder per Sister |
| `<project>/.misaka/` | the project's own settings (`settings.json`) and its conversation-search cache |
| `<project>/.pageindex/` | the project's document index |

The rest of the home:

```text
~/.misaka/
  skills/  skill-bundles/  subagents/  themes/  prompts/  extensions/   shared by every role
  state/        the task board, messages, conversations, backups: back this up
  shared/       the one place agents may keep material of their own
  cache/  logs/ safe to delete
  run/          the panel's socket and locks
```

### Which file wins

MISAKA's own sections on this page (`research`, `network`, `subagents`, `skills`, `mcp`,
`documents`, `panel`, `tui`, `allies`, `moa`, `lcm`, `auxiliary`, `web`) are read from
`~/.misaka/settings.json`. A Sister's `web` overrides in her own `settings.json` are the one
exception.

The model and display settings (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`,
`modelThinkingLevels`, `theme`, `terminal.*` and the like) are read in layers, later ones
winning:

1. `~/.misaka/settings.json`
2. the project's `.misaka/settings.json`, once you have trusted the project (`/trust`)
3. the role's `profiles/<role>/settings.json`

MISAKA writes only what is that role's own into a role's file: `defaultProvider` /
`defaultModel`, `defaultThinkingLevel`, `mcpServers` and `web`.

A role folder may also have its own `.env`, laid over the home's. A variable already set in
your shell wins over both files.

A value of the wrong type (text where a number belongs) stops MISAKA at start and names the
setting; `misaka setup`, `update` and `uninstall` still run so you can fix it.

## Models and thinking

| Setting | Default | Meaning |
|---|---|---|
| `defaultProvider` / `defaultModel` | none | the model every role uses unless she has her own; `misaka setup model` writes these. Without them, a chat takes a signed-in provider's own default model, and Sisters' cards fall back to `anthropic` / `claude-sonnet-4-5`. |
| `defaultThinkingLevel` | `medium` | the thinking level a new session starts at, for every role without her own |
| `modelThinkingLevels` | none | a thinking level per `provider/model` |
| `vision.model` | `browser.vision_model`, if set | one vision model (`provider/model`) for the whole home, not per role: it reads every image a request carries to a model that cannot see, and a model that can see is sent the image itself |

In a role's own `settings.json`, `defaultProvider` / `defaultModel` pin that role's model and
`defaultThinkingLevel` sets her thinking level. In her window, `/model` with Ctrl+S and
`/thinking --default LEVEL` write them; so do `misaka create --model` and `--thinking` for a new
Sister. [Models](../guide/models.md) has the everyday commands.

A session's thinking level comes from the first of: a `--thinking` flag (or a `:level` suffix on
`--model`); for a conversation you resume, the level it last had; the role's own default;
`modelThinkingLevels`; the home's `defaultThinkingLevel`; `medium`. It is then limited to what
the model supports.

## Research, budget and concurrency

| Setting | Default | Meaning |
|---|---|---|
| `research.plan_approval` | `true` | every research plan waits for your go-ahead; `false` for unattended runs (a plan that changes the question still waits) |
| `research.token_cap` | `0` (no cap) | token budget of one research run, its cards and sub-agents included; a run that reaches it stops with a partial report and goes on when resumed under a higher cap |
| `research.beast_at` | `0.85` | share of the cap at which a card is told to wrap up |
| `network.max_concurrent_sisters` | free memory ÷ 256 MiB, between 4 and 12 | cards running at once on this machine |
| `network.max_concurrent_per_sister` | the machine limit | cards one Sister runs at once |
| `allies` | none | other vendors' agents that can take cards: see the [team guide](../guide/team.md#allies) |

## Sub-agents

Sisters can hand work to sub-agents. These settings rarely need changing.

| Setting | Default | Meaning |
|---|---|---|
| `subagents.max_concurrent` | `20` | sub-agents one session runs at once |
| `subagents.task_max_output` | `32000` (max `160000`) | how much of a background task's output, in characters from the end, the output tool shows; the whole output stays in its file |
| `subagents.effort_level` | `auto` | `low`, `medium`, `high`, `xhigh` or `max`, for models that take an effort setting |
| `subagents.small_fast_model` | none | the model a sub-agent type's hooks use when they name none (a model of the same provider) |
| `subagents.background_tasks` | `true` | allow sub-agents to run in the background |
| `subagents.auto_background_tasks` | `false` | move a foreground sub-agent to the background after two minutes |
| `subagents.verification_agent` | `false` | offer the built-in `verification` type |
| `subagents.agent_list_in_messages` | `false` | list the available types in messages |
| `subagents.auto_memory` | `true` | let sub-agents keep memory between tasks |
| `subagents.memory_home` | `state/agent-memory` | where that memory is kept |
| `subagents.managed_agents_dir` | none | a folder of sub-agent definitions that take precedence over all others |

## Skills and MCP

| Setting | Default | Meaning |
|---|---|---|
| `skills.external_dirs` | none | more folders of skills to read (`~/.agents/skills` is always read when it exists) |
| `skills.disabled` | none | skill names to hide from every role |
| `skills.copy_cap_mb` | `200` | total size of the skill copies one session may hold in its sandbox |
| `mcp.init_timeout` / `mcp.call_timeout` | `30` / `120` | seconds for an MCP server to start, and per call |
| `mcp.required_wait` | `30` | seconds to wait for an MCP server marked required |

MCP servers themselves are set per role, under `mcpServers` in `profiles/<role>/settings.json`;
see [the team guide](../guide/team.md#a-sisters-profile).

## Documents and the web

| Setting | Default | Meaning |
|---|---|---|
| `documents.ocr_langs` | `eng+chi_sim+jpn` | languages for reading scanned PDFs, joined with `+` (needs `ocrmypdf` and each language's data) |
| `web.*` | search works with no setup | set with `misaka web`; see [Documents and the web](../guide/sources.md#the-web) |
| `web.allow_private_urls` | `false` | let web tools reach private and loopback addresses; cloud metadata addresses stay blocked |

## Panel and terminal

| Setting | Default | Meaning |
|---|---|---|
| `panel.prefix` | `ctrl+b` | the panel's prefix key, `ctrl+` and a letter (use `ctrl+g` inside tmux, which takes `ctrl+b`); read when the panel starts |
| `tui.esc_timeout_ms` | `10`; `100` over ssh or inside a pane | how long Esc waits to see whether it starts an Alt+key |
| `showHardwareCursor` | `false` | show the terminal's own cursor |
| `terminal.clearOnShrink` | `false` | clear the screen when the window shrinks |

## Long conversations (LCM)

When a conversation grows too long for the model, LCM summarises its older part, and the agent
can still search what was said earlier: in her own conversation,
and in the other conversations running in the same project. Your conversations themselves are
kept in `~/.misaka/state/sessions/`; the search index is a cache in `<project>/.misaka/lcm/`,
filled from the conversations as they open and removed when the last MISAKA process in the
project exits. Don't commit or sync it. A project on a drive that cannot keep that folder
private, such as a Windows drive opened from WSL, keeps it in
`~/.misaka/state/plugins/misaka-lcm/projects/` instead.

| Setting | Default | Meaning |
|---|---|---|
| `lcm.context_threshold` | `0.35` | share of the context window at which a session compacts; a research run can set its own |
| `auxiliary.compression` | the session's model | which provider and model write the summaries |

`/lcm-settings` in chat turns automatic recall from earlier conversations on or off. Recall
searches by meaning, so it needs the `lcm-semantic` extra; turning it on picks a small local model
for that.

Other behaviour is switched with `LCM_*` variables in `~/.misaka/.env`, for example:

| Variable | What it turns on |
|---|---|
| `LCM_EMBEDDINGS_ENABLED` | semantic search over the history. Needs the `lcm-semantic` extra and a model (`LCM_EMBEDDING_PROVIDER`, `LCM_EMBEDDING_MODEL`); `/lcm-settings on` picks a small local one. |
| `LCM_PROACTIVE_RECALL_ENABLED` | bring relevant memories from other conversations into context; needs embeddings as well |
| `LCM_LARGE_OUTPUT_EXTERNALIZATION_ENABLED` | store very long tool outputs outside the summaries, retrievable on demand |
| `LCM_TEMPORAL_ROLLUPS_ENABLED` | summaries of the history by day, week and month |
| `LCM_CONTEXT_THRESHOLD` | the compaction threshold, over `lcm.context_threshold` |


## Environment variables

`~/.misaka/.env` is for variables that code other than MISAKA reads: provider keys such as
`ANTHROPIC_API_KEY`, web service keys (`misaka web set env.NAME` writes them), keys a skill's
script expects, an SDK's settings, and `OPENALEX_API_KEY` (a free OpenAlex key that keeps
literature scans working when OpenAlex limits anonymous use). A line that does not parse, or a
file that is a symbolic link, disables the whole file, and the warning says why. Names starting
with `MISAKA_` are ignored there: set those in your shell.

Variables for MISAKA itself:

| Variable | Default | Meaning |
|---|---|---|
| `MISAKA_HOME` | `~/.misaka` | where the home is |
| `MISAKA_TELEMETRY` | off | `1` lets MISAKA tell gateways such as OpenRouter that the requests come from MISAKA (`enableInstallTelemetry` in `settings.json` does the same) |
| `MISAKA_OAUTH_CALLBACK_HOST` | `127.0.0.1` | the address a browser sign-in returns to, for signing in on a remote machine |
| `MISAKA_SETUP_PLAIN` | off | `1` makes the setup wizard ask numbered questions instead of drawing menus |
| `MISAKA_TIMING` | `0` | `1` prints startup timings |
| `MISAKA_GHOSTTY_VT` | the bundled library | a terminal library you built yourself, for platforms without a bundled one |
| `MISAKA_ALLOW_NESTED` | off | `1` lets the panel open inside one of its own panes |
| `GITHUB_TOKEN` / `GH_TOKEN` | none | a GitHub token for `misaka update` (it also asks `gh auth token`): for a private copy of the repository, or a higher rate limit |

Other `MISAKA_*` names are set by MISAKA for its own processes; leave them alone.
