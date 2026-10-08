# Desktop AI research team execution ledger

Authority: user's approved “桌面研究：AI 按需组队、全团队同模型、选择性保留角色” plan.

## Boundary rulings
- Current dirty worktree is the required baseline. Preserve all prior changes; no reset, commit, merge, or unrelated cleanup.
- Existing core/ui/config/ai Python sources are frozen by SHA-256 baseline. All new backend logic lives in misaka/desktop_research; only existing desktop_bridge and desktop frontend/IPC are edited.
- Native research code lacks worker factories in several local imports. Desktop-owned cloned dependency namespaces may compose original native callables with scoped adapters; original module symbols, interpreter import behavior and CFG objects remain intact. Native phase, ownership, claim and artifact validators remain original.
- Temporary roles live under each desktop root's task directory. Shared profile changes require explicit user selection after completion. Prior automatic fixed-pair seeding is not used by new desktop team roots.
- Every request uses one canonical provider/modelId and versioned team barrier. No model-specific name assumptions or hidden tier fallback.

## Shared interfaces
| Producer / consumer | Contract |
|---|---|
| Team domain / runtime | DesktopResearchTeam(session_dir, shared_root, provider, model_id); recruit, snapshot, retain_roles, model_policy |
| Runtime / bridge | DesktopResearchController(session, emit, config); attach, snapshot, send_message, set_team_model, retain_roles |
| Bridge / frontend | get_research_host adds team/modelBinding; desktop_set_team_model and desktop_retain_roles on research channel |
| Runtime / frontend | actual desktop-team and desktop-model-switch notices with team/modelBinding details |

## Tasks
- [x] Desktop team persistence, scoped profiles, model barrier and explicit shared-role retention.
- [x] Native runtime integration, request model enforcement, dynamic recruitment, subprocess handoff and scene prompts.
- [x] Desktop bridge controller and IPC transport integration.
- [x] Team UI, research-only model picker route and selective retention controls.
- [x] Targeted deterministic/native subprocess tests, browser/desktop validation and frozen-source audit (exceptions recorded below).

## Continuation decisions and verified evidence (2026-10-08)

- Ruling: each concrete root transcript owns a separate `desktop-roots/<sessionId>/desktop-team` namespace, not its cwd-wide transcript parent. Matching inactive legacy roots are copied, never removed or reassigned.
- Ruling: native task facts are read-only projections of the actual owning run. Helpers publish their real final status even on error/cancellation; no task completions are synthesized in saved role definitions.
- Ruling: optional LCM auxiliary/external inference is omitted only from independent desktop research assemblies, before opening the root or workers. Native SDK compaction remains on the selected team model; ordinary desktop/TUI LCM settings and source remain intact. The omitted path had a native operation-lock/model-selection circular wait and alternate-provider transports. Its local diagnostic is persisted in `runtime-diagnostics.json`.
- Ruling: native MoA composite transport is incompatible with exact physical-request model binding. Desktop research rejects that transport explicitly rather than admitting hidden heterogeneous fan-out or falling back to another model. Ordinary/TUI MoA remains unchanged.
- Ruling: failed/stopped research shows role retention only after the user's explicit “结束本次研究并选择保留角色” choice, followed by unchecked role choices and the ordinary explicit save command. This local disposition does not fabricate native `done`, remove evidence, or save shared roles by itself. Resuming hides the controls again.
- Shared-role export filtering covers explicit credential markers, URI credentials, PEM private keys, and recognizable task-goal variants. It is not a semantic privacy classifier for arbitrary paraphrased private prose.

Fresh root verification before runtime final handoff:

| Command / scope | Actual result |
|---|---|
| Team persistence, model policy, bridge, storage pytest | 70 passed, 2 OS-process-creation skips |
| Bridge/storage after pre-open research-only assembly regression | 13 passed; research case observed RED before bridge integration |
| Existing bridge + continuous research backend/runtime + research start + model picker pytest | 97 passed |
| Desktop TypeScript check and full Vitest (before terminal retention addition) | typecheck exit 0; 54 files / 413 tests passed |
| Research team, research mode, workflow, welcome Playwright | 10 passed (browser fixtures) |
| Production renderer/Electron build | exit 0; pre-existing large-chunk advisory remains |
| Real Electron + Python bridge smoke in empty isolated profile | 1 passed; genuine team snapshot, binding, same-transcript reopening; shared Sister directory remains empty |
| Terminal-retention Pill/component regressions | 10 passed; two new terminal cases observed RED first; test fixture typing corrected before final recheck |
| Frozen TUI/core/config/ai baseline | 702 files, 0 mismatches |
| Git whitespace check | exit 0; existing line-ending advisories only |

No shared/global profiles were changed during the smoke (isolated temporary profile only). No live external provider research/quota was used. The workspace and all prior changes remain uncommitted, with no merge or cleanup.

Latest verification:
- After terminal-retention controls: TypeScript check exit 0; complete Vitest **54 files / 415 tests passed**; production build exit 0; same 10 browser cases passed; real Electron smoke passed again.
- Additional ordinary native model/startup regression (`test_agent_model_runtime.py` + `test_subagent_native_startup.py`): **11 passed / 11 failed**. Failures reported `WinError 5` at native child creation before provider requests. Isolated first-turn rerun admitted the process but exceeded the original 20-second startup budget. A plain Python child probe succeeded. These failures must not be described as a green TUI runtime regression; the frozen baseline remains unchanged and native source is not patched to hide them. Desktop-specific actual-worker evidence is verified separately.
- Final read-only source review found no unresolved P1/P2 in the reviewed boundaries (cancellation/drain, private namespaces, browser model binding, root/worker LCM omission, explicit terminal retention). Review alone is not provider execution evidence.

Final runtime handoff and root-owned verification:
- Full new backend selection initially returned **99 passed / 2 skipped / 1 failed**; the failing desktop child case also reported the host's `WinError 5` before any provider call. Its isolated genuine subprocess rerun **passed** (32.03s), with actual loopback request bodies on the selected provider/model despite conflicting call, definition, and environment preferences.
- Remaining new backend selection (`-k 'not real_native_agent_child'`) then returned **99 passed / 2 skipped / 1 deselected**. Skips specifically name the OS-denied policy worker creation; they are not model-policy success evidence.
- Added actual native node/card bootstrap tests using original run/card creation interfaces and the desktop worker entry. The node test **passed**, issuing the selected pair and rejecting a fixture response without a native planning tool contract. The actual Sister card isolated test **passed** (19.15s), issuing the selected pair despite a different task override and preserving the borrowed shared profile byte-for-byte. A text-only fixture is intentionally not declared as a completed research plan/card. Some combined invocations again had explicit OS-create skips.
- Prepared research root with optional LCM omitted, native SDK compaction and raw/cache model calls passed the new backend selection. MoA semantic-transport rejection is tested with zero fan-out calls; physical model IDs/display names containing “moa” remain accepted.
- New backend source plus root-owned bridge/storage/worker tests: Ruff **all checks passed**.
- Ruling: first-message recruitment is a real multi-turn operation, so its correlated input and creation watchdog now use the same bounded 180-second budget instead of 20/30 seconds. Subsequent conversation inputs retain the existing timeout. A deterministic 45-second startup regression was observed RED before the change and then **7 startup tests passed**; no acceptance or role-creation event is fabricated.
- Fresh final SHA-256 audit: **702 frozen files / 0 mismatches**; Git whitespace check exit 0.

Implementation is present. Full external-provider research-to-final-report acceptance has not been performed; no complete green ordinary native startup regression is claimed. Final frontend checks after the startup-watchdog fix are recorded below when they finish.

Final frontend/desktop verification after all saved changes:
- `pnpm typecheck`: exit 0.
- Full `pnpm test --reporter=dot --maxWorkers=2`: **54 test files / 416 tests passed**.
- `pnpm build`: exit 0; the existing renderer chunk-size advisory remains.
- Browser team/model-switch/retention, continuous research, workflow/report export and welcome selection: **10 passed**.
- Real Electron with Python root bridge, empty isolated shared expert library, persisted team binding and concrete-transcript reopening: **1 passed**.
- Source Ruff and frozen-source/whitespace audits remain green as recorded above. Backend actual Agent, node and Sister-card process cases were each verified separately against loopback model requests, not inferred from UI fixtures.

Outstanding acceptance boundary: full external-provider research-to-final-report run, and consistently green ordinary native startup/process-creation regression on this Windows host. These are explicitly not claimed complete. All changes remain in the existing worktree, with no commit, merge, reset, shared-profile edits, or unrelated cleanup.
