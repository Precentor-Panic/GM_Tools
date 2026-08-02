# GM_Tools — Phase 20 Task Plan: Real-usage bug remediation

**Status:** ready to execute. Five real bugs found by the project owner actually using Session Planner, Graph, and Encounter Builder in a browser — same category as Phase 14's QA-pass remediation: findings already have a confirmed or well-grounded root cause, no fresh design round needed. No QE-first process for this phase — these are bug fixes against existing, already-tested behavior, not new features; each task adds a regression test for its own fix, matching Phase 14's own convention.

**Explicitly out of scope for this phase** (per direct instruction): the substantial scene-planning redesign, the Foundry-native bestiary/roster scan feature, monster reskinning, and any GM_MapGen work. All tabled until this phase is done.

---

## 20.1 — Session Planner: default the scene-bootstrap location picker to `Place`

**File:** `review-ui/public/session-planner-view.js`

**Root cause, confirmed by direct read:** `buildEntityPicker` (~line 92) fetches `GET /api/graph?filter=all` and never applies any type filter — it matches only on the search text against name/type. The scene-bootstrap flow (`renderBootstrap`, ~line 473) and the re-center control (task 17.5) both share this one component with no default bias toward locations at all, even though both contexts are specifically asking "which place."

**Fix:** add a default type filter to `buildEntityPicker` (a new option, e.g. `defaultTypeFilter: "place"`), applied to `allNodes` before the initial `renderResults()` call and re-applied on every keystroke unless the picker exposes a way to clear/broaden it. Apply this default in both the scene-bootstrap and re-center call sites (the picker is intentionally shared — don't fork it into two implementations). Keep it a *default*, not a hard restriction — a DM should still be able to search past it if they genuinely want a non-Place entity as an anchor.

**Regression test:** extend the existing scene-bootstrap e2e coverage (or add a new case) asserting the picker's initial result set is Place-only before any text is typed, and that typing still searches the full set (confirm broadening past the default works, not just the default itself).

---

## 20.2 — Session Planner: persist the in-progress scene across navigation

**File:** `review-ui/public/session-planner-view.js`, `review-ui/public/index.html`, `review-ui/public/app.js`

**Root cause, confirmed by direct read:** `renderSessionPlanner(sceneIdArg)` receives its scene id ONLY as a hash-route argument (`app.js` line ~140: `renderSessionPlanner(arg)`), and the nav bar's "Plan Session" button (`index.html` line 25) has a bare `data-nav="session-planner"` with no scene id encoded anywhere. There is no persistence mechanism at all — clicking the nav button, or any navigation that doesn't preserve the exact hash, always lands on the bare route and falls through to `renderBootstrap`, discarding whatever scene was in progress.

**Fix:** persist the last-active scene id per world (localStorage, matching this file's own existing per-world caching convention — e.g. a `gmReview.sessionPlanner.<world>.lastSceneId` key, written whenever a scene successfully loads or is created/forked). When the bare `#session-planner` route is hit with no scene id AND a persisted id exists for the current world, redirect/load that scene instead of falling to `renderBootstrap` — but `renderBootstrap` must still be reachable (a DM must be able to deliberately start a NEW scene without being trapped on the old one; consider a small "start a new plan" affordance alongside the resumed scene, not just silent auto-resume with no escape hatch).

**Regression test:** a Playwright case — create/load a scene, navigate to a different view (e.g., Graph), navigate back to Session Planner via the nav button (not the browser back button), assert the same scene loads rather than the bootstrap screen.

---

## 20.3 — Graph view: zoom controls scroll away with content instead of staying pinned

**File:** `review-ui/public/graph-view.js`, `review-ui/public/style.css`, and wherever `renderGraph`'s container is set up in its callers (`app.js`/`session-planner-view.js` as relevant — re-locate fresh)

**Root cause, confirmed by direct read:** `.graph-zoom-controls` (`style.css` ~line 362) is `position: absolute; top: 0.5rem; right: 0.5rem`, and `wireZoomControls` appends that bar as a DIRECT CHILD of the SAME element that is both `.graph-view-container`'s positioning context (`position: relative`) AND its own scroll container (`overflow: auto`, `style.css` ~line 348 — the container IS the pan mechanism, confirmed by that section's own comment: "scrolling IS the pan mechanism"). An absolutely-positioned child of a scrollable positioned ancestor scrolls WITH that ancestor's content — it does not stay pinned to the visible viewport corner. This is a different, more structural bug than the earlier `position: sticky; float: right` issue fixed once before (Phase 7-era) — that fix moved to `position: absolute`, which is correct in a NON-scrolling container, but this container scrolls by design (Phase 12's "old fixed-size overflow:hidden box" fix), and nobody revisited the zoom-controls positioning against that later change. This is very likely also the direct cause of "I need to be at 50% zoom to see the whole graph" — at low zoom nothing needs to scroll, so the widget's misbehavior is invisible; at real working zoom levels, scrolling to see other parts of the graph carries the widget away with it.

**Fix:** the zoom-controls bar must live OUTSIDE the scrollable element, in a non-scrolling wrapper that shares its positioning context. Concretely: introduce an outer wrapping element (`position: relative`, no `overflow` restriction) that contains two children — the existing scrollable `.graph-view-container` (unchanged, still `overflow: auto`) and `.graph-zoom-controls` as a sibling, not a descendant, of the scrollable element. `wireZoomControls` needs to append the bar to that new outer wrapper instead of the scrollable `container` argument it receives today — trace every call site of `renderGraph`/`wireZoomControls` to confirm the wrapper exists consistently in both standalone-Graph and any embedded usage, don't assume there's only one caller.

**Also investigate while in this code, same file:** the reported "graph doesn't fan out on load, needs a node click + exit to trigger layout" — look at `computeLayout`'s caching (`opts.cacheKey`) and whatever happens on `renderGraph`'s very first call for a given cache key vs. subsequent calls; this may be a separate, related initial-layout bug rather than the same root cause as the zoom-widget issue — don't assume one fix resolves both, verify each independently with real before/after screenshots at a real zoom/pan state, not just "no console errors."

**Regression test:** a Playwright case — render a graph dense enough to require scrolling at 100% zoom, scroll/pan the container, assert the zoom-controls bar's bounding box is unchanged (still pinned top-right of the viewport, not the scrolled content). Also a case for the fan-out/layout issue once its root cause is confirmed.

---

## 20.4 — Encounter Builder: real removal + correct control placement

**File:** `review-ui/public/combat-planning-view.js`

**Root cause, confirmed by direct read:** `renderWorkingRoster` (~line 643) renders name + count for `origin:"group"` rows with ZERO interactive controls — it's read-only. All mutation controls (`+Add`, and a `−`/`+` stepper for existing `group` rows) live inline in `renderCatalogRow` (~line 924) instead. Two real gaps: (1) the stepper's `−` only decrements count (`onCatalogStepperChange(entry.id, -1)`) — nothing removes a row entirely when it hits zero or via an explicit action, and (2) `individual`-origin rows (created by repeated `+Add` clicks, confirmed by `onCatalogAdd`'s push at ~line 339) have NO controls anywhere — not in the catalog, not in the working roster — so once created they cannot be removed or adjusted at all.

**Fix, per the project owner's explicit spec:**
- **Catalog rows** (`renderCatalogRow`): reduce to a simple binary toggle — "Add" if not in the working roster, "Remove" (removes ALL of that entry from the working roster, both group and any individual instances) if it is. No stepper here at all.
- **Working roster** (`renderWorkingRoster`): this is where count/removal controls actually belong. Each row shows `<name>` (add reskinned-name display later, out of scope this task — see Phase 20's exclusions) with a `−`/`+` stepper for `group`-origin rows (adjusting count, `−` at count 1 removes the row) and, for every row regardless of origin, an explicit `[x]` remove-entirely control. `individual`-origin rows get their own `[x]` (no stepper — each individual click created a separate row on purpose, per Phase 19's own design; removing one instance removes just that row, identified via its existing `data-instance-id`).
- Recompute must still fire on every mutation from either surface, per Phase 19's existing live-recompute discipline — don't special-case the new removal paths out of that.

**Regression test:** Playwright cases covering: adding via catalog then removing via the working roster's `[x]` actually clears it from both the roster AND flips the catalog row back to "Add"; an individual-origin row's `[x]` removes only that one instance, not sibling individual rows of the same entry; a group row's stepper reaching zero removes the row (not leaving a zero-count ghost row).

---

## 20.5 — Encounter Builder: "narrow by theme" doesn't work

**File:** `review-ui/public/combat-planning-view.js`, and `review-ui/server.mjs`'s `encounter-suggest` route if the bug is server-side

**Investigate first — root cause not yet confirmed.** `onThemeSubmit` (~line 282) and the theme input wiring (~line 1035+) look structurally present on a first read; this needs real hands-on reproduction (type a theme, submit, observe network request and response) before assuming where the break is. Check, in order: does the click handler actually fire and call `onThemeSubmit`; does the request body's `themeText` field actually carry the typed text (compare against the Phase 18 addendum's documented route contract); does the server-side `proposeThematicTags` call succeed and actually narrow `candidatePool`, or does it run but the UI fails to apply/render the narrowed result. Do not guess-fix — reproduce first, confirm the actual break point, then fix it.

**Regression test:** a Playwright case (matching the existing loading-scope e2e test's LLM-call-mocking convention) that types a theme, submits, and asserts the rendered catalog/suggestion actually reflects a narrowed pool — not just that a request was sent.

---

## How to work

- These five bugs are independent (different files/areas) — dispatch and work them in parallel, not sequentially.
- Ground every fix in the actual current code — re-locate exact lines fresh, this document's cited line numbers are from a single grounding pass and may drift slightly.
- Commit each task separately, clean incremental history. Stage files explicitly, never `git add -A`.
- Run the FULL existing test suite (root, `wf-mcp-server`, `review-ui` deterministic + all e2e) after each task and confirm nothing regressed, in addition to each task's own new regression test passing.
- `foundry_worldFabric` is not touched by any of these — confirm `git -C /home/russell/foundry_worldFabric status --short` is unchanged before and after regardless.
- Take real screenshots/before-after verification for the two visual bugs (20.3's zoom-controls pinning, 20.4's control relocation) — don't claim a UI fix works without actually looking at it.

## Definition of done

- [ ] 20.1 — scene-bootstrap and re-center pickers default to Place, broadening still works.
- [ ] 20.2 — Session Planner survives navigation away and back via the nav button, with an explicit way to still start fresh.
- [ ] 20.3 — zoom controls stay pinned to the viewport during pan/scroll at real zoom levels; fan-out-on-load issue investigated and fixed or clearly diagnosed as a separate ticket if it turns out unrelated.
- [ ] 20.4 — working roster has real, correctly-placed removal controls; catalog rows are a simple add/remove toggle.
- [ ] 20.5 — theme filtering actually narrows results, root cause identified and fixed, not guessed at.
- [ ] Full existing test suite passes throughout; each fix has its own regression test.
- [ ] `foundry_worldFabric` confirmed untouched.
