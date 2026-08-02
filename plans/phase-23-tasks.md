# GM_Tools — Phase 23 Task Plan: Scene Construction UI

**Status:** ready to execute. **Prerequisite reading, in order:** `CLAUDE.md` → `PLAN.md` → `plans/phase-21-review.md` in full (the design record) → `plans/phase-22-tasks.md` (the engine this phase consumes) → this file → `.claude/skills/gm-tools-conventions/SKILL.md`.

**Scope:** frontend only. No new engine work — Phase 22 plus its addendum (`combat-planning/saved-encounter.mjs`, commit `b8bd1e1`) already shipped everything this phase needs: linkage derivation, transit-entity creation, node add/remove + intervening-offer, scene-scoped undo, the batch develop orchestrator, quick-gen, and saved-encounter persistence. If this phase finds itself wanting new engine logic, stop — re-read the shipped contracts first, the answer is very likely already there.

**Process, same as every UI phase since 17:** tests before implementation. Task 23.0 writes Playwright e2e tests against DOM selectors that don't exist yet, confirmed red, before implementation starts.

**Runs in parallel with Phase 24** (Scenes tab) — both depend only on Phase 22, not on each other. Don't block on Phase 24's status.

---

## Grounding — what already exists, confirmed live

- **Phase 22 routes** (`review-ui/server.mjs`, prefix `/api/scene-planning/*`): `GET .../linkage`, `POST .../transit-entity`, `POST`/`DELETE .../scenes/:sceneId/members`, `GET .../scenes/:sceneId/intervening-offer`, `POST .../scenes/:sceneId/undo/{start,record,last,all,clear}`, `GET .../scenes/:sceneId/undo`, `POST .../scenes/:sceneId/develop`, `POST .../quick-gen`. **Addendum**: `POST`/`GET .../scenes/:sceneId/encounters`, `DELETE .../scenes/:sceneId/encounters/:encounterId`.
- **`session-planner/session-notes.mjs`**: `captureNote(world, {text, anchorEntityId, sceneId})` — already scene-aware, this IS the "Add Event" mechanism, no new engine needed for that half of task 23.6.
- **`review-ui/public/session-planner-view.js`**: the existing view this phase reworks, not replaces from scratch. Current structure (re-verify fresh, this is from a recent grounding pass): `renderBootstrap` (empty-state scene creation), `renderBriefBody`/`renderLocationCard` (the current single-scene anchor+satellite card display, Phase 17's work), `buildRecenterControl`/`doRecenter`, `buildEntityPicker` (shared type-ahead component — reuse for any new location/entity search UI in this phase, don't build a second one), `toggleNotePanel` (existing inline note-capture UI — the pattern task 23.6's "Add Event" should follow), `renderStartNewPlanBar`, `lastSceneKey`/`loadLastSceneId`/`saveLastSceneId` (Phase 20.2's persistence — this phase extends the concept to a full chain, not just one scene, so this may need real rework, not just addition).
- **`review-ui/public/combat-planning-view.js`**: the Encounter Builder view — task 23.6's "Add Encounter" needs to either link out to this view with some pre-fill/return-to-scene mechanism, or embed a lightweight version inline. Read this file's structure before deciding; don't assume which approach fits without checking what's actually reusable.
- **`review-ui/public/app.js`**: hash-router, `withWorld`/`api` helpers, `activeScanController`/`cancelActiveScan` pattern (every new LLM-touching action in this phase — develop-scene, quick-gen — should follow this exact request-cancellation-on-navigate convention).
- **`review-ui/public/graph-view.js`**'s `withSlowNotice` — use for the develop-scene and quick-gen call sites specifically; nothing else in this phase should show a loading state, matching every prior phase's discipline about scoping latency affordances to actual LLM call sites only.
- Re-verify all of the above fresh — line numbers and exact current behavior may have drifted since this grounding pass.

---

## Task list

### 23.0 — QE e2e test-authoring pass (runs first, standalone)
**Files:** new `review-ui/test/e2e/scene-construction-*.e2e.mjs`

Define and test, contract-first, against DOM selectors that don't exist yet:

1. **Scene chain display**: a persisted, ordered sequence of scenes renders (not just the single current-scene view Phase 17 built) — seed a real multi-scene chain via the actual store functions, assert the chain renders in order, each scene collapsible.
2. **Add arbitrary node, both reachability branches**: adding an unreachable entity succeeds directly; adding a reachable entity surfaces the real intervening-node offer (via the live `intervening-offer` route) as an explicit, separate confirmation step — never auto-added.
3. **"+" between scenes — real place**: inserting an existing place entity as a new scene between two others.
4. **"+" between scenes — transit/path**: inserting a transit scene calls the real `transit-entity` route, committing a real entity (assert via the actual store, not just a UI state check) — confirm the created entity's `type` is `"place"` with `attributes.isTransit === true`, matching Phase 22's real contract.
5. **Develop-node vs. Develop-scene as genuine peer buttons**: both visible, neither default/automatic; Develop-scene triggers the real batch orchestrator and surfaces PER-NODE review (accept/discard), never a silent whole-batch auto-apply — assert the existing accept/discard gate is what actually commits each node's result, not a bypass.
6. **Scene-local rollback**: visible directly in the scene UI (not behind Settings/gear), wired to the real undo-session routes; undo-last and undo-all both reachable and functionally distinct.
7. **Add Event / Add Encounter, equal visual weight**: a real bounding-box/prominence comparison (matching this project's established measurement convention, e.g. Phase 15's touch-target work) proving neither is visually de-emphasized relative to the other.
8. **Add Encounter round-trips through the real addendum routes**: saving an encounter to a scene, confirming it's listed via `GET .../encounters`, removing it via `DELETE`.
9. **Mid-session "+" quick-gen path**: types a name, submits, asserts exactly one LLM call fires (mocked, matching this project's `page.route()` convention) — no multi-round Q&A UI involved, genuinely fast (one field, one button, per the design record's explicit bar).
10. **Loading-affordance scope**: `withSlowNotice`-style loading UI appears ONLY for develop-scene and quick-gen submissions — never for chain navigation, add/remove-node, or rollback actions.

**Acceptance criteria:** every new test file fails against the current (not-yet-reworked) UI with clear selector-not-found/timeout errors; full existing suite (root, `wf-mcp-server`, `review-ui` deterministic + all existing e2e) still passes.

---

### 23.1 — Scene chain display
**Files:** `review-ui/public/session-planner-view.js`

Rework the current single-scene brief view into a persisted, ordered chain display. Each scene renders its anchor + members (reuse/extend `renderLocationCard`'s existing digest/flag rendering where it still fits) inside a collapsible container. Chain order follows real location/anchor adjacency — no arbitrary reordering UI, per the design record's explicit call that this isn't a requirement.

**Acceptance criteria:** 23.0's chain-display test passes.

---

### 23.2 — Add/remove node UI
**Files:** `review-ui/public/session-planner-view.js`

Wire to the real `scenes/:sceneId/members` (add/remove) and `intervening-offer` routes. Reachable-target flow surfaces the offer as a distinct, explicit confirmation, never auto-adds.

**Acceptance criteria:** 23.0's both-branch test passes.

---

### 23.3 — "+" between scenes
**Files:** `review-ui/public/session-planner-view.js`

A control between adjacent scenes offering: pick an existing place (reuse `buildEntityPicker`), or create a transit/path scene (calls the real `transit-entity` route, default naming from the engine, not invented client-side).

**Acceptance criteria:** 23.0's real-place and transit-entity tests both pass.

---

### 23.4 — Develop-node / Develop-scene
**Files:** `review-ui/public/session-planner-view.js`

Two explicit, peer buttons. Develop-scene calls the real batch orchestrator (`scenes/:sceneId/develop`) and renders a per-node review UI over its results — each node's proposal individually accept/discard-able via the existing `prep-content-ops.mjs` gate, never a single whole-scene auto-apply action.

**Acceptance criteria:** 23.0's peer-buttons-and-per-node-review test passes.

---

### 23.5 — Scene-local rollback
**Files:** `review-ui/public/session-planner-view.js`

A rollback control visible directly in the scene UI, wired to the real `undo/{start,record,last,all,clear}` routes. Record a session start when scene development begins; expose both "undo last" and "undo everything in this scene" as distinct actions.

**Acceptance criteria:** 23.0's rollback test passes.

---

### 23.6 — Add Event / Add Encounter, equal weight
**Files:** `review-ui/public/session-planner-view.js`, possibly `review-ui/public/combat-planning-view.js` if a link-out/return-to-scene mechanism is needed

- "Add Event": reuses `session-notes.mjs`'s existing `captureNote` with `sceneId` set — follow `toggleNotePanel`'s existing UI pattern.
- "Add Encounter": wired to the real addendum routes (save/list/remove). Decide and document how this connects to Encounter Builder (embed vs. link-out-and-return) based on what's actually reusable in `combat-planning-view.js` — don't assume without checking.
- Both actions get identical visual treatment — same size, same prominence, same discoverability. Explicit product principle from the design record: never make one harder to find because a given DM style uses it less.

**Acceptance criteria:** 23.0's equal-weight and encounter-round-trip tests pass.

---

### 23.7 — Mid-session ad-hoc "+"
**Files:** `review-ui/public/session-planner-view.js`

The fastest path in this whole phase: one field (a name), one button, calling the real `quick-gen` route — no multi-round Q&A. Per the design record, this is meant to be usable silently and quickly by the DM mid-session; treat speed and minimal-interaction as hard requirements, not nice-to-haves.

**Acceptance criteria:** 23.0's quick-gen and loading-scope tests pass.

---

## How to work

- Task 23.0 must fully complete, commit, and be confirmed red before 23.1 starts.
- Ground every implementation task in the actual current code — re-locate exact lines/routes/selectors fresh.
- Commit after each completed task, clean incremental history. Stage files explicitly, never `git add -A`.
- No `foundry_worldFabric` changes anywhere in this phase. Verify `git -C /opt/dev/foundry_worldFabric status --short` is unchanged before and after.
- Self-review remediation pass at the end of 23.7: run the full test suite, re-confirm the equal-weight Event/Encounter property holds via real measurement (not just visual impression), re-confirm develop-scene never bypasses per-node review, re-confirm loading affordances are scoped to exactly the two real LLM call sites in this phase. Take real desktop + mobile screenshots.

## Definition of done for Phase 23

- [ ] 23.0's Playwright tests committed, confirmed red before any implementation exists.
- [ ] Scene chain display (23.1).
- [ ] Add/remove node with reachability-aware intervening offer (23.2).
- [ ] "+" between scenes — real place and transit/path both working (23.3).
- [ ] Develop-node/Develop-scene as genuine peers with per-node review (23.4).
- [ ] Scene-local rollback, visible and functional (23.5).
- [ ] Add Event/Add Encounter, equal weight, both round-tripping through real routes (23.6).
- [ ] Mid-session ad-hoc "+", genuinely fast, single-call (23.7).
- [ ] Full existing test suite (root + `wf-mcp-server` + `review-ui` deterministic + all e2e) still passes.
- [ ] `foundry_worldFabric` confirmed untouched throughout.
- [ ] Self-review remediation pass run and reported, including real screenshots.
