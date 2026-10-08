# Desktop model / thinking picker

User-approved implementation, continuing the existing uncommitted desktop work in-place.

**Goal:** A 256px, two-layer picker with authoritative capabilities, race-safe session updates and a rose/plum/indigo rail.
**Architecture:** `thinkingLevels.ts` resolves known, missing and explicitly empty capabilities; the settings store owns confirmed state and request epochs; the shared slider owns cancellable preview gestures; depth/model views own presentation only.
**Constraints:** Existing bridge commands and defaults stay compatible; no capability probes, model-name heuristics, global default changes, or unrelated working-tree edits.

- [x] Capability + synchronization regression tests: missing vs empty, disabled map entries, fixed non-off stop, newest model/depth acknowledgements, stale session reads, failure rollback. Run `pnpm test` from desktop before and after implementation.
- [x] Slider + picker regression tests: two-stop maximum, zero/fixed states, focus on open/back, keyboard endpoints, preview-only drag, cancellation, model counts/search/default marker/configuration.
- [x] Implement capabilities and store epochs/confirmed rollback in `desktop/src/lib/thinkingLevels.ts` and `desktop/src/store/useSettingsStore.ts`.
- [x] Split depth/model views in `desktop/src/components/Composer`, refine compact `ThinkingSlider.tsx`, and token-derived rail CSS. Keep settings geometry unchanged.
- [x] Extend browser acceptance harness/script with fixture models and delayed/failed acknowledgements. Verify light/dark, reduced motion, small-window clamp and settings layout. Save screenshots in `desktop/preview-artifacts/model-picker`.
- [x] Run TypeScript, desktop build, lint, full frontend tests, Playwright and Python bridge tests. Review diff and report evidence, leaving all work uncommitted.


## Verification

- Picker browser acceptance: 9 passed using Edge, with isolated port 4176 and HMR disabled.
- Python picker / desktop bridge: 35 passed.
- Reviewer findings fixed and regressions verified.
- Legacy `.preview/shot-thinking.py` and `.preview/verify-switch.py` delegate to the maintained `pnpm test:picker` suite.
- TypeScript, lint and desktop build run; production bundle-size warning is retained.
- All edits remain uncommitted; other in-progress session/history changes preserved.

### Final status

- Selector unit tests: 27 passed.
- Full frontend suite: 90 passed, 1 failed in the independently changing Timeline persistence/disclosure regression (`conversation.test.tsx`). Timeline files were not edited for this task.
- TypeScript, lint, renderer + Electron build: passed. Existing large-chunk warning remains.
- Updated legacy screenshot entry point executed successfully: 9 browser checks passed.
- Screenshots visually inspected for both layers in light/dark, near/top rails, small reduced-motion viewport, and unchanged 6px settings rail.

## 2026-10-06 slider follow-up

- Compact dark handle and speed streaks are white; passed stop markers are white too.
- Continuous fill uses the rendered handle center, including at top-tier preview; no rounded-stop fill jumps.
- Handle/fill snap with the same 180ms ease-out, while actual dragging follows the pointer immediately; track clicks retain easing.
- Grab offset preserved at the handle edge and during interrupted animations. Final pointerup coordinate is authoritative; cancellation remains submission-free.
- Initial rail measurement occurs before paint; capability/value/busy/size changes invalidate the active gesture.
- 10 slider unit tests and 10 browser acceptance tests pass, including reduced motion and new geometry/color regressions. Independent reviewer found no important issues.
- Initial full checks caught independently changing composer/submission/retry tests and types. Those files were not modified for this follow-up. Final fresh recheck: all 107 frontend tests passed; TypeScript, lint and renderer/Electron builds passed, with only the existing bundle-size warning.
- Screenshot: desktop/preview-artifacts/model-picker/picker-slider-refined.png. Changes remain uncommitted.
