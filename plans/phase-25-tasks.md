# GM_Tools — Phase 25 Task Plan: Information-Cockpit Table Mode

**Status:** ready to execute. **Prerequisite reading, in order:** `CLAUDE.md` → `PLAN.md` → `plans/phase-25-review.md` in full (the finalized, adjudicated design record — §3/§3a is the concrete layout, §5 is the project owner's direct adjudication, read it before assuming any open question is still open) → this file → `.claude/skills/gm-tools-conventions/SKILL.md` → `.claude/skills/gm-tools-verification/SKILL.md` (verification commands/environment quirks, use it instead of rediscovering them).

**Scope:** frontend only, plus the one small CSS-token bugfix. No new engine/store work — every zone in §3/§3a is populated from routes and data shapes that already exist and are already tested (`brief`, `session-notes`, `saved-encounter`, `scene-linkage`, `scene-membership`). This task plan was written directly against the adjudicated design record rather than through a separate PM-persona pass — the scoping was already concretely settled by the project owner's own adjudication (§5), not left open for a fresh independent read.

**Process, same as every UI phase since 17:** task 25.0 writes Playwright e2e tests against DOM selectors that don't exist yet, confirmed red, before implementation starts.

---

## Grounding — confirmed live, current as of this task plan

- **`session-planner/brief.mjs`**: `buildSessionBrief` already returns everything the member-roster and top-strip zones need (`locations[].digest/contentFlag/structuralFlag/distance/notes`), served via the existing `GET /api/session-planner/brief?world=&sceneId=` route.
- **Entity fields NOT currently surfaced in any UI** (confirmed directly against `foundry_worldFabric/scripts/data/graph-service.mjs`'s `upsertEntity`): `description`, `summary`, `imageUrl`, `tags`, `status`, `playerKnown`. Already returned by the existing `GET /api/graph?filter=all` fetch `session-planner-view.js` already makes for its `entityInfoMapGlobal` — no new route needed, just render more of what's already fetched.
- **`session-planner/scene-linkage.mjs`**'s `linkedScenesForScene` (`GET /api/scene-planning/linkage?world=&sceneId=&maxHops=`, already live) is the data source for §3a's adjacent-scenes strip — hop-distance-1 entries are the immediate chain neighbors.
- **`GET /api/scene-planning/scenes?world=`** (Phase 24, already live) is the data source for §3a's search bar and collapsed full list — same route Phase 24's Scenes tab already uses, client-side substring filter on anchor name, matching that phase's own established precedent (`scenes-view.js`) rather than reinventing search.
- **`combat-planning/saved-encounter.mjs`**'s `listEncountersForScene` (`GET /api/scene-planning/scenes/:sceneId/encounters?world=`, already live) returns each saved encounter's full snapshotted roster — confirmed each roster entry carries the real bestiary stat block fields (`hp`, `ac`, `attacks`, `rawFields`) captured at save time, exactly what the notes/encounters zone's nested expand needs. No new route.
- **`session-planner/session-notes.mjs`**'s `listPendingNotes`/`captureNote` (already live, already scene-aware) is the notes half of the same zone.
- **CSS bug, confirmed directly in `review-ui/public/style.css`**: `.flag-badge--structural` (line 627) uses `var(--reject)`/`var(--pill-rejected-bg)` — the same tokens as genuine error/rejected states (`.status-pill--rejected`, `.graph-form-status`, `.graph-popover-delete-btn`). `.flag-badge--content` (line 626) and `.location-card-digest--empty` (line 617) both use `var(--amber)`/`var(--amber-bg)` — visually identical despite being different signals ("flagged as undeveloped" vs. "nothing established at all"). `--amber`/`--amber-bg` already carries this app's established "quiet marker, not alarming" meaning elsewhere (`.prep-stale-badge`'s own header comment says this explicitly) — `--reject` never should have been reused for a non-error flag.
- **`review-ui/public/session-planner-view.js`**: `renderLocationCard` (~line 439), `toggleNotePanel` (~line 552, the existing inline-expand pattern — reuse its shape for nested expand, but see task 25.3's note on why it can't be reused verbatim unmodified), `ensureSceneExtras`/`sceneExtrasCache` (the lazy per-scene data cache Phase 23 built — Table Mode should read from this same cache, not fetch independently), ~line 1489.
- **`review-ui/public/app.js`**: hash-router, `withWorld`/`api` helpers, `activeScanController`/`cancelActiveScan` pattern.
- Re-verify all of the above fresh — line numbers may have drifted.

---

## Task list

### 25.0 — QE e2e test-authoring pass (runs first, standalone)
**Files:** new `review-ui/test/e2e/table-mode-*.e2e.mjs`

Define and test, contract-first, against DOM selectors that don't exist yet:

1. **Table Mode toggle**: a control on the existing Session Planner view switches between the Phase 23 construction view and the new single-scene Table Mode render, both addressable via the URL (so a reload preserves which mode was active).
2. **Top strip + corrected flag coding**: prep-readiness badges render with distinct, non-`--reject` styling for `flag-badge--structural`, and distinguishable treatment between `flag-badge--content` and the empty-digest state (assert actual computed CSS custom-property values, not just class names, per this project's established measurement convention).
3. **Adjacent-scenes strip**: seed a real multi-scene chain, assert the immediate hop-1 neighbors render as single-tap targets, no picker/no intermediate step.
4. **In-place search**: typing in the nav-zone search bar filters to a real non-adjacent scene (seeded 3+ hops away or in a disconnected chain) and opening it switches Table Mode's current scene WITHOUT navigating away from Table Mode (assert the mode toggle state / URL shape stays "table mode," only the sceneId argument changes).
5. **Collapsed full list**: the full scene list renders collapsed by default beneath the adjacent-scenes strip, expandable.
6. **Member roster nested expand**: a member row's persistent (non-hover) expand reveals `description`/`summary`/`imageUrl`/`tags`; assert no cap on how many rows can be simultaneously expanded (open 3+, all stay open) per the adjudicated "start unbounded" decision — this test exists specifically to lock in that decision so a future implementer doesn't "fix" it into an accordion by assumption.
7. **`playerKnown` hard gate**: assert this field is NEVER visible via the same one-tap expand as `description`/`tags` — requires a distinct, separate confirm step, real DOM assertion that the value isn't present in the DOM at all until that separate step fires (not just visually hidden via CSS).
8. **Notes + encounters interleave**: seed both a note and a saved encounter on one scene, assert both render in one unified zone (not two separately-sized sections).
9. **Encounter nested expand**: a saved encounter's roster row expands to the real stored stat block (name/HP/AC visible unexpanded; attacks/traits behind the nested expand) — assert against the actual `saveEncounter`-persisted snapshot shape, not a UI-only mock.
10. **Bottom actions bar equal weight**: real `boundingBox()` comparison, matching this project's established measurement convention (Phase 15/23's own precedent) — Add Event and Add Encounter stay equal-weight in Table Mode too, not just in the construction view.
11. **Responsive**: a viewport-sized test confirming the top strip AND the nav zone (adjacent-scenes strip + search) both stay reachable without scrolling on a phone-sized viewport, per §3a's requirement that navigation never becomes a scroll-and-hunt fallback.

**Acceptance criteria:** every new test file fails against the current (not-yet-built) UI with clear selector-not-found/timeout errors; full existing suite (root, `wf-mcp-server`, `review-ui` deterministic + all existing e2e) still passes.

---

### 25.1 — Flag-badge color-token fix
**Files:** `review-ui/public/style.css`

Standalone, no dependency on anything else in this phase — do it first. Fix `.flag-badge--structural` to stop reusing `--reject`/`--pill-rejected-bg`; give it its own non-error treatment consistent with `--amber`'s established "quiet marker" meaning in this app, distinguishable from `.flag-badge--content` (which already correctly uses `--amber`) via icon and/or a secondary visual property (weight, border style) since both signals are legitimately "not urgent" but are still different facts. Also distinguish `.location-card-digest--empty` from `.flag-badge--content` the same way — right now they're pixel-identical in color despite meaning different things ("no relationship/hook established" vs. "flagged as needing content").

**Acceptance criteria:** 25.0's flag-coding test passes. This fix should visibly change existing Phase 17/23 cards too (not just new Table Mode UI), since `flag-badge--structural` is reused there — confirm nothing in the existing test suite asserted the old (buggy) color as expected behavior; if something did, that assertion was wrong and should be corrected, not preserved.

---

### 25.2 — Table Mode toggle + top strip + navigation zone (§3a)
**Files:** `review-ui/public/session-planner-view.js`

The mode toggle, the top strip (location name, on-the-path badge, corrected prep-readiness badges from 25.1), and the full navigation zone: adjacent-scenes strip (from `linkedScenesForScene`, hop-1 only), search bar above it (client-side substring filter over `GET /api/scene-planning/scenes`, same pattern as Phase 24's `scenes-view.js`), collapsed-by-default full list beneath. This replaces the idea of a single "Advance" button entirely — there is no separate advance control, this zone is the whole navigation surface.

**Acceptance criteria:** 25.0's toggle, top-strip, adjacent-scenes, search, and collapsed-list tests all pass.

---

### 25.3 — Member roster zone with nested expand + `playerKnown` gate
**Files:** `review-ui/public/session-planner-view.js`

Compact rows (name/roleTag/digest hook, reusing the existing digest data), each with a persistent expand revealing `description`/`summary`/`imageUrl`/`tags` inline. No cap on simultaneous expansion — do not build an accordion or a max-open limit, per the adjudicated §5 decision. `playerKnown` gets its own separate, deliberate reveal step distinct from the general expand (e.g. a second confirm tap), and must not be present in the DOM at all until that step fires.

Note on why `toggleNotePanel`'s existing pattern can't be reused completely unmodified: that pattern is a single-panel-per-note-id `Map`, fine for its own use, but this zone additionally needs the nested (row → sub-detail) structure and the `playerKnown` special case — extend the same underlying idea (persistent visible trigger, inline, collapses in place), don't force-fit the exact existing function.

**Acceptance criteria:** 25.0's nested-expand and `playerKnown`-gate tests pass.

---

### 25.4 — Notes + encounters zone
**Files:** `review-ui/public/session-planner-view.js`

One interleaved list combining `listPendingNotes` and `listEncountersForScene` results for the current scene. Each saved encounter's roster renders as compact stat-block rows (name/HP/AC visible immediately) with the same nested-expand pattern from 25.3 for full attacks/traits, reading directly from the already-fetched saved-encounter snapshot — no live re-fetch from the bestiary, matching `saved-encounter.mjs`'s own explicit "snapshot, not a live reference" contract.

**Acceptance criteria:** 25.0's interleave and encounter-nested-expand tests pass.

---

### 25.5 — Bottom actions bar
**Files:** `review-ui/public/session-planner-view.js`

Add Event / Add Encounter, reusing the exact same mechanisms Phase 23 already built for the construction view (`captureNote` with `sceneId`, the saved-encounter round-trip / return-context navigation) — this task is "wire the same actions into Table Mode's layout," not new action logic. Quick-gen "+" also reused as-is from Phase 22/23. Equal visual weight between Add Event and Add Encounter, verified by real measurement (25.0's test), matching Phase 21 §6's standing rule.

**Acceptance criteria:** 25.0's equal-weight test passes.

---

### 25.6 — Responsive scaling
**Files:** `review-ui/public/session-planner-view.js`, `review-ui/public/style.css`

Scale zone proportions down for tablet, preserve relative sizing (no reflow/reorder). On a true single-column phone width, the top strip AND the navigation zone (adjacent-scenes strip + search) stay reachable without scrolling — per §3a, navigation must never degrade into a scroll-and-hunt fallback on small screens. Roster/notes-encounters zones may stack normally beneath.

**Acceptance criteria:** 25.0's responsive test passes.

---

## How to work

- Task 25.0 must fully complete, commit, and be confirmed red before 25.1 starts. 25.1 can run in parallel with 25.0 if convenient (it's a pure CSS fix with its own narrow test), but don't skip writing its test first.
- Ground every implementation detail in the actual current code — re-locate exact lines/routes/selectors fresh, per `gm-tools-verification`'s own standing guidance.
- Commit after each completed task, clean incremental history. Stage files explicitly, never `git add -A`.
- No `foundry_worldFabric` changes anywhere in this phase. Verify `git -C /opt/dev/foundry_worldFabric status --short` unchanged before and after — see `.claude/skills/gm-tools-verification/SKILL.md` for the exact check and current baseline.
- Self-review remediation pass at the end of 25.6: run the full test suite (use the exact commands in `gm-tools-verification`, don't reconstruct them), re-confirm the equal-weight Event/Encounter property via real measurement, re-confirm `playerKnown` never leaks into the DOM before its own gate fires, re-confirm no accidental cap was added to the nested-expand mechanism. Take real desktop + tablet + phone screenshots — this phase explicitly cares about the tablet/phone case, don't skip those breakpoints in the screenshots the way earlier phases might have treated them as an afterthought.

## Definition of done for Phase 25

- [ ] 25.0's Playwright tests committed, confirmed red before any implementation exists.
- [ ] Flag-badge color-token fix, no more `--reject` reuse for a non-error state (25.1).
- [ ] Table Mode toggle + top strip + full navigation zone: adjacent-scenes strip, in-place search, collapsed full list (25.2).
- [ ] Member roster with unbounded nested expand and a real `playerKnown` gate (25.3).
- [ ] Notes + encounters interleaved zone with nested stat-block expand (25.4).
- [ ] Bottom actions bar, equal-weight, reusing Phase 22/23's real action mechanisms (25.5).
- [ ] Responsive scaling down to phone width, navigation zone never requires scrolling to reach (25.6).
- [ ] Full existing test suite (root + `wf-mcp-server` + `review-ui` deterministic + all e2e) still passes.
- [ ] `foundry_worldFabric` confirmed untouched throughout.
- [ ] Self-review remediation pass run and reported, including real desktop + tablet + phone screenshots.
