# GM_Tools — Phase 24 Task Plan: Scenes Tab

**Status:** QE pass (24.0) already complete — committed as `5bed4ba`, written directly against the design record and the shipped Phase 22 engine rather than from a separate task-plan draft; this file captures the plan retroactively for the same paper-trail consistency every other phase gets, before implementation starts. **Prerequisite reading, in order:** `CLAUDE.md` → `PLAN.md` → `plans/phase-21-review.md` §2/§12 → `plans/phase-22-tasks.md` → this file → `.claude/skills/gm-tools-conventions/SKILL.md`.

**Scope:** frontend, plus one small additive route. Depends only on Phase 22 (the already-shipped scene engine) — explicitly NOT on Phase 23, per the PM phasing analysis that called this out as a sibling consumer of the engine, not a downstream consumer of the construction UI. Runs in parallel with Phase 23.

---

## Grounding — confirmed live, including a real gap the QE pass found

- **`session-planner/scene-linkage.mjs`**: `linkedScenesForScene(world, sceneId, snapshot, opts={maxHops})` → `[{sceneId, anchorEntityId, anchorEntityName, hopDistance}]`, sorted ascending by hop distance. Already live at `GET /api/scene-planning/linkage?world=&sceneId=&maxHops=`.
- **`session-planner/scenes.mjs`**: `listScenesForWorld(world)` exists as a module function — **confirmed via direct route-table inspection: no server route exposes it over HTTP today.** Phase 22 shipped linkage/transit/membership/undo/develop/quick-gen routes only. This phase must add a thin `GET /api/scene-planning/scenes?world=` (or match whatever prefix reads most consistently against the rest of the `/api/scene-planning/*` table) wrapping the existing function directly — no new store logic, this is a one-route addition, not new engine work.
- **DOM contract, already pinned by the 24.0 QE pass** (full detail in `review-ui/test/e2e/scenes-tab-browse-and-navigate.e2e.mjs` and `scenes-tab-linkage.e2e.mjs`'s header comments — read those files directly, this is a summary):
  - Nav: `.topnav [data-nav="scenes"][data-testid="scenes-nav"]` → hash `#scenes` → `<section id="view-scenes" class="view">`.
  - Browse list: `[data-testid="scenes-list"]`, items `[data-testid="scene-list-item"][data-scene-id]` with `scene-list-item-anchor-name`, `scene-list-item-objective` (always rendered, even when null), `scene-list-item-open` (navigates to `#session-planner/<sceneId>`).
  - Search: `[data-testid="scenes-search-input"]`, client-side substring filter on anchor name — deliberately NOT `buildEntityPicker` (documented reasoning in the test file: that component is one-row-per-entity, and two scenes can share an anchor entity, which breaks its assumptions).
  - Empty state: `[data-testid="scenes-empty-state"]`.
  - Linkage is a separate, explicit action from opening a scene: `scene-list-item-linked-toggle` → `[data-testid="linked-scenes-panel"][data-scene-id]` → `linked-scene-item[data-scene-id]` (ascending hop order) with `linked-scene-anchor-name`, `linked-scene-hop-distance`, `linked-scene-open` (navigates to `#session-planner/<linkedSceneId>`); `linked-scenes-empty` for the no-links case.
- **`review-ui/public/app.js`**: hash-router, `data-nav` registration pattern — add the new nav entry following the exact existing convention.
- **`review-ui/public/session-planner-view.js`**: `buildEntityPicker` (why it doesn't fit here, per above), and the existing hash-route-argument pattern (`renderSessionPlanner(sceneIdArg)`) this phase's "open" actions navigate into.

---

## Task list

### 24.1 — List-scenes route
**Files:** `review-ui/server.mjs`

- `GET /api/scene-planning/scenes?world=` wrapping `listScenesForWorld(world)` directly. Parameterless `resolveDir()`/`resolveWorld()`, no client-supplied `dataDir` — matching every route in this file without exception.

**Acceptance criteria:** the relevant 24.0 route-adjacent assertions (browse-list population) pass once this exists — confirm by re-running `scenes-tab-browse-and-navigate.e2e.mjs`.

---

### 24.2 — Scenes tab view
**Files:** new `review-ui/public/scenes-tab-view.js` (or fold into `session-planner-view.js` if that turns out cleaner once you're in the code — your call, but keep it a clearly separated concern either way), `review-ui/public/index.html`, `review-ui/public/app.js`

- Nav entry, list rendering, search/filter, empty state — per the DOM contract above.
- Selecting "linked scenes" for an item calls the real `GET .../linkage` route and renders the panel, sorted by hop distance (trust the route's own sort, don't re-sort client-side unless you have a reason to distrust it — if so, say why in a comment).
- Every "open" action (main list or linked panel) navigates to the existing Session Planner view via the real hash-route shape.

**Acceptance criteria:** all of `scenes-tab-browse-and-navigate.e2e.mjs` and `scenes-tab-linkage.e2e.mjs` pass.

---

## How to work

- 24.1 is a five-minute route addition; do it first so 24.2's development isn't blocked on a missing endpoint.
- Ground every implementation detail in the actual current code — re-locate exact lines fresh.
- Commit after each task, clean incremental history. Stage files explicitly, never `git add -A`.
- No `foundry_worldFabric` changes anywhere in this phase. Verify `git -C /opt/dev/foundry_worldFabric status --short` is unchanged before and after.
- Self-review remediation pass at the end: run the full test suite, take real desktop + mobile screenshots of the new tab (browse list, search narrowing results, linked-scenes panel open).

## Definition of done for Phase 24

- [ ] List-scenes route (24.1).
- [ ] Scenes tab view — browse, search, empty state, linkage panel, navigate-to-scene (24.2).
- [ ] All of `scenes-tab-browse-and-navigate.e2e.mjs` and `scenes-tab-linkage.e2e.mjs` pass.
- [ ] Full existing test suite (root + `wf-mcp-server` + `review-ui` deterministic + all e2e) still passes.
- [ ] `foundry_worldFabric` confirmed untouched.
- [ ] Self-review remediation pass run and reported, including real screenshots.
