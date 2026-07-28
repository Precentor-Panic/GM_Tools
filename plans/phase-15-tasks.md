# GM_Tools — Phase 15 Task Plan: Frontend Regression Suite + Mobile Responsive Fixes

**Status:** ready to execute. **Prerequisite reading:** `CLAUDE.md` → `PLAN.md` → this file → `.claude/skills/gm-tools-conventions/SKILL.md`.

**What this is:** the two concrete, non-speculative recommendations from a real frontend-architecture tradeoff study (see `CLAUDE.md`'s note on the web-dev review). The study's conclusion was explicit: don't change the tech stack — but two real gaps are worth fixing regardless of that decision. (1) Every "verified in a real browser" claim across 14 build phases has been a one-off manual/agent-driven Playwright session, never a committed, replayable test — meaning an already-fixed interaction bug has no guard against silently coming back. (2) A real mobile-viewport pass (iPhone 13 emulation) found the world-select dropdown and Settings gear pushed completely off-screen on every view, the Batch Review action bar overflowing horizontally and clipping "Reject Selected," and 13×13px checkboxes well under the ~44px touch-target guideline — this codebase has never once been tested against or designed for a touch/mobile viewport before that pass.

**Explicitly out of scope for this phase** (per the review's own recommendation and the project owner's own framing — don't build these here): adopting a component framework, TypeScript, a build step, a real job queue, or a database. Also out of scope: the fire-and-forget/streaming latency work discussed separately — that's real but was deliberately deferred as "genuinely optional, not now."

---

## Task list

### 15.1 — Playwright as a real, committed dev dependency
**Files:** `review-ui/package.json`, possibly a new `review-ui/test/e2e/` directory (your call on exact layout, but keep it clearly separate from the existing `*.test.mjs` deterministic/route-level tests per this project's established `.test.mjs`/`.smoke.mjs` naming convention — these are a third category, real-browser interaction tests, name them accordingly, e.g. `*.e2e.mjs`)

- **This is a real, flaggable new dependency** — `review-ui/package.json` currently declares zero dependencies of any kind, a deliberate convention stated in its own top-of-file doc comment. Every prior UI phase in this project has instead *borrowed* Playwright read-only from the sibling `foundry_worldFabric` project's `node_modules` for one-off verification sessions. Formalize it as this project's own `devDependency` now that it's becoming a permanent fixture rather than ad hoc tooling — add a clear comment in `package.json`'s own description (matching the existing convention of documenting *why* a dependency choice was made) explaining this is a **dev-only** dependency (never imported by `server.mjs` or any runtime code path), specifically for the regression suite this phase adds.
- Add an `npm run test:e2e` (or similar) script, kept separate from the existing `npm test` (deterministic route tests) — this suite is slower and needs a real running server instance, don't fold it into the default fast test loop.

**Acceptance criteria:** `npm install` in `review-ui/` succeeds and pulls in Playwright as a devDependency only; confirm via `npm ls --omit=dev` (or equivalent) that it does not appear in a production-only dependency listing.

---

### 15.2 — Committed regression tests for the already-found interaction bugs
**Files:** new `review-ui/test/e2e/*.e2e.mjs` files

Each of these bugs was found once, fixed once, and — per the frontend review's own explicit finding — has zero automated guard against silently regressing. Write a real, permanent Playwright test for each, driving an actual running `review-ui/server.mjs` instance (spin one up in a `before()`/isolated scratch dir, matching every existing test file's established isolation pattern) against real fixture data:

- **Popover dismiss-race**: a popover button that mutates its own subtree mid-click (e.g. the delete confirm) must not have the popover close itself out from under that same click via a stale `.contains()` check — confirm the fix (`evt.composedPath()`) by reproducing the original scenario end-to-end (click delete, confirm the popover's confirm UI is still present and functional, not silently gone).
- **Mousedown bubbling into rubber-band drag**: a mousedown on a popover's own Accept/Reject button (in batch-mode Graph view) must not be swallowed by the container-level rubber-band-select drag-start listener — confirm Accept/Reject from the graph popover actually completes (real API call fires, real status change persists), not just that the popover visually stays open.
- **Placement click landing on an existing node**: clicking "+ Add Node" then clicking on top of an existing node must open the create-node form for the clicked point, not the existing node's own popover.
- **Rubber-band listener leak on re-render**: trigger several re-renders of the batch Graph view (accept/reject a few mutations in sequence) and confirm the rubber-band drag-select still works correctly afterward and that repeated re-renders don't visibly degrade (a real, if indirect, proxy for "listeners aren't silently accumulating" — if you can find a more direct way to assert listener count via Playwright's own APIs, use it instead).

**Acceptance criteria:** all four tests pass against the current (already-fixed) code; as a sanity check on the tests' own validity, temporarily revert one fix locally, confirm its corresponding test actually fails, then re-apply the fix — this proves the test would have caught the original bug, not just that it passes trivially. Don't leave the revert in place; this is a one-time validation step during development, not a permanent part of the suite.

---

### 15.3 — Responsive nav: keep world-select and Settings reachable
**Files:** `review-ui/public/style.css`, possibly `review-ui/public/app.js` for a hamburger toggle if that's the chosen approach

- **Confirmed root cause**: `.topbar` is a plain flex row with `.topbar-right` (world `<select>` + gear icon) pushed via `margin-left: auto` — nothing collapses, hides, or wraps it at any viewport width; the project's CSS has exactly one media query in the entire file (a `max-width: 560px` rule touching only `main` padding). On a real mobile viewport, `.topbar-right` is pushed off-screen entirely with no way to reach it.
- Add a real breakpoint (or a few) that keeps `.topbar-right`'s contents reachable at narrow widths — a hamburger menu collapsing `.topnav` + `.topbar-right` into a dropdown/drawer is the most robust fix, but a simpler stacked-rows approach (nav wraps to its own row below the brand) is acceptable if it keeps everything reachable and doesn't eat excessive vertical space. Your call on exact mechanism; the hard requirement is that the world-select and Settings gear must be tappable at a real mobile width (test against ~390px, the iPhone 13's logical width, not just "some mobile-ish size").

**Acceptance criteria:** real visual verification (Playwright device emulation, matching the original bug-finding session's iPhone 13 profile) showing the world-select and Settings gear are visible and tappable, not off-screen.

---

### 15.4 — Responsive action bar: no horizontal overflow
**Files:** `review-ui/public/style.css`

- **Confirmed root cause**: `.action-bar` is `display:flex` with five buttons plus a spacer, no `flex-wrap`, no min-width management — on a narrow viewport it overflows past the visible edge rather than wrapping, clipping "Reject Selected" entirely off-screen with no way to reach it.
- Add `flex-wrap: wrap` (or an equivalent fix) so the action bar's buttons wrap onto additional rows rather than overflowing. Consider whether primary/destructive actions (Accept/Reject Selected) should be visually prioritized to stay on the first row if wrapping pushes something below the fold — your call, but don't let anything become unreachable.

**Acceptance criteria:** real visual verification at the same mobile viewport that every action-bar button (including "Reject Selected") is visible and tappable, none clipped or requiring horizontal scroll.

---

### 15.5 — Touch-target sizing
**Files:** `review-ui/public/style.css`

- **Confirmed root cause**: `.mutation-row`'s checkbox is an unstyled native `<input type="checkbox">`, rendering at browser-default ~13×13px — well under the ~44×44px touch-target guideline, hard to tap reliably. Check for other similarly-undersized interactive elements while in this code (small icon buttons, etc.) rather than fixing only the one already-found instance.
- Fix via a padded wrapping `<label>` (expanding the effective hit area without changing the checkbox's visual size) or `min-width`/`min-height` plus padding directly on the input — your call on the cleanest CSS approach that doesn't disturb the existing List view's visual density on desktop.

**Acceptance criteria:** a Playwright test measuring the real rendered bounding box of the checkbox (and any other fixed undersized elements found) confirming it meets or exceeds 44×44px at the mobile viewport, matching how this issue was originally discovered (real bounding-box measurement, not visual guessing).

---

## How to work

- Actually look at what you build — this entire phase is about visual/interaction correctness. Use the `run` skill and either `claude-in-chrome` or (if unavailable, as in every prior UI phase) real headless Chromium via Playwright — but note task 15.1 makes this project's **own** Playwright install available for the first time, so prefer that over continuing to borrow the sibling repo's copy for anything this phase adds.
- Ground every fix in the actual current code — re-locate the relevant lines fresh rather than trusting exact line numbers from prior reports, which may have drifted.
- Commit after each completed task, clean incremental history. Stage files explicitly, never `git add -A`.
- Self-review remediation pass at the end: specifically re-run the task 15.2 revert-and-confirm-failure check for at least one test as a sanity check that the suite is genuinely meaningful, and re-verify tasks 15.3/15.4/15.5's fixes don't regress the existing desktop-viewport appearance (screenshot at a normal desktop width too, not just mobile).

## Definition of done for Phase 15

- [ ] Playwright is a real, committed devDependency with its own test script, clearly separated from the fast deterministic test suite.
- [ ] Four real regression tests exist for the four previously-found-and-fixed interaction bugs, and at least one was verified to actually fail when its corresponding fix is temporarily reverted.
- [ ] World-select and Settings are reachable at a real mobile viewport width.
- [ ] The Batch Review action bar never overflows/clips a button off-screen at mobile width.
- [ ] Checkboxes (and any other found undersized targets) meet the ~44px touch-target guideline, verified by real bounding-box measurement.
- [ ] Desktop-viewport appearance is confirmed unregressed by the responsive fixes.
- [ ] Full existing test suite (root + wf-mcp-server + review-ui's deterministic tests) still passes, plus the new e2e suite.
- [ ] Self-review remediation pass run and reported.
