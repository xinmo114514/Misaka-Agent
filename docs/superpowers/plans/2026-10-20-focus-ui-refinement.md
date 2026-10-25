# 专注视图精修：顶部减法，阅读优先

## Approved goal
Merge the focus view's workspace header and research control bar into one approximately 52px toolbar, retaining the native title bar. Keep ordinary chat and multi-pane layout unchanged. Use existing themes, system fonts, Lucide, stores, IPC and research lifecycle logic. Preserve all prior uncommitted changes; no new dependencies or settings.

## Task 1: Focus lifecycle presentation
- Add opt-in focus presentation to ResearchStopButton and ResearchResumeButton; existing callers retain defaults.
- Hide only idle/unavailable resume in focus, retaining hook-driven driving resolution, submitting/confirming/unconfirmed/failed phases and refresh.
- Anchor stop confirmation in a portalled popover in focus, preserve captured run target, retries and Escape-before-Composer behavior. No inline toolbar growth.
- Write and observe failing tests first, implement, run targeted tests and record results.

## Task 2: Unified focus toolbar
- Hide App's old workspace header only for timeline + bound research run + focus. Extract one focus toolbar, including loading/error/empty states.
- Order: question, team, run status, applicable stop/resume, More. Title ellipsis, full question accessible. Team defaults to 团队 · count and names the selected member while browsing. Run state never follows member state.
- More order: research process, multi view, node, graph, workspace, model/settings; details contain run id, elapsed time and phase. No ordinary-session actions in the research menu.
- Keep process and graph callbacks, shared mode source, root controller writer and visible approvals/error messages. Make return-to-controller explicitly select the root.
- Calm 52px toolbar, 14px title, 32px controls, 8px gaps; semantic colors, restrained surfaces. Narrow widths shorten controls rather than add permanent rows.
- Test-first; update affected focus tests and verify ordinary/multi behavior.

## Task 3: Reading, disclosure and keyboard behavior
- Process folded by default; task progress before collapsed role details. Preserve every role/retention action, one internal scroll area and bounded height.
- Team keyboard opening focuses a member, hover does not move focus; preserve pinned/hover behavior and return focus when closed.
- Wide workspace (>=1000px): 360px side reader, shared composer aligned to main column without duplicating/remounting the composer. Smaller workspace: modal overlay drawer with focus containment, close/restore and Escape consumption. Side reader has no composer spacer.
- Keep drafts, selection and reading position; close topmost overlays before interpreting Escape as stop.
- Test-first; scope styles and behavior to focus.

## Task 4: Acceptance and review
- Record baseline tests before production edits. Check typecheck, lint, all frontend unit tests and build.
- Exercise focus, ordinary conversation, multi, lifecycle and eight themes in fixture Playwright tests. Inspect dark/light screenshots at 1440, 1280, 960 and 900, sidebars on/off and side-reader open. Cover long titles, stop confirmation, drawer focus, no overflow, action uniqueness and readable contrast.
- Independently review the delta against the captured working-tree baseline, not HEAD. Resolve important issues and rerun checks.
- Keep evidence and a concise delivery report. No automatic staging, commits, merge, push or publication.
