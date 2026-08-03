// Phase 26 task 26.0 -- shared setup + THE FULL DOM/ROUTE CONTRACT for the
// Phase 26 e2e suite (plans-*.e2e.mjs, scene-links-*.e2e.mjs,
// scene-creation-*.e2e.mjs, quick-gen-tethered.e2e.mjs, add-scene-control
// .e2e.mjs, beyond-path-removed.e2e.mjs, table-mode-plan-scoped.e2e.mjs,
// post-session-graph-update.e2e.mjs, drop-into-foundry.e2e.mjs,
// table-roster-tags-absent.e2e.mjs, table-mode-bug-repro.e2e.mjs). NOT
// itself an *.e2e.mjs file (the npm run test:e2e glob is
// test/e2e/*.e2e.mjs), same exemption as fixture.mjs/scene-construction-
// fixture.mjs/table-mode-fixture.mjs -- every Phase 26 test file imports
// what it needs from here (plus, where relevant, from scene-construction-
// fixture.mjs / table-mode-fixture.mjs directly for their own already-
// established helpers) rather than each re-deriving the shared contract
// independently.
//
// THIS IS THE INTERFACE SPEC tasks 26.1-26.12 implement to match. NONE of
// the DOM/routes described below exist yet -- every Phase 26 *.e2e.mjs file
// is EXPECTED TO FAIL right now with a Playwright selector-not-found/
// timeout error, OR a real HTTP non-200 from a route that doesn't exist yet
// (asserted directly, since these routes are real and this suite drives a
// real in-process server -- a 404 is just as valid a "red for the right
// reason" signal as a DOM timeout, and this suite's route-level tests
// assert on it directly rather than only ever going through the UI). Read
// this header FIRST; each sibling file's own header only adds
// scenario-specific detail, matching this project's established
// "read the shared header once" precedent (scene-construction-fixture.mjs /
// table-mode-fixture.mjs).
//
// Grounded directly in `plans/phase-26-tasks.md`'s Grounding section
// (§26.A-§26.H) plus fresh reads of the real current code (re-verified,
// not trusted from the task plan's own line-number pointers, which are
// explicitly flagged there as possibly stale):
//   - wf-mcp-server/lib/manual-edit-ops.mjs's addNodeOp/addEdgeOp, already
//     live as POST /api/graph/nodes / POST /api/graph/edges
//     (review-ui/server.mjs ~line 1087/1096, re-verified fresh -- NOT
//     ~1091/1100 as the task plan's own grounding pass guessed).
//     addEdgeOp's EDGE_EDITABLE_FIELDS allowlist already includes
//     `label`/`notes` -- a rough-distance/relationship note on a created
//     link goes into ONE of these two fields (this suite pins `notes`,
//     since `label` reads more like a short relationship-type tag and
//     `notes` reads more like free text -- either is defensible, `notes` is
//     what this suite asserts against).
//   - session-planner/scenes.mjs's createScene (POST /api/session-planner/
//     scenes, unmodified route, confirmed live) is still the ONLY thing
//     that actually creates a Scene record -- 26.4/26.5/26.6's new flows all
//     still end by calling this exact existing route with a resolved
//     `locationEntityId`, never a new scene-creation mechanism.
//   - session-planner/session-notes.mjs's captureNote (POST
//     /api/session-planner/notes, confirmed live, already sceneId-aware) is
//     reused unmodified by 26.9's note-assembly step -- this suite seeds
//     notes via this real route, exactly mirroring how Add Event itself
//     already captures them.
//   - graph-import/writeup-import.mjs's importWriteup / the existing
//     POST /api/writeup-propose route (confirmed live, ~line 1256) is what
//     26.9's new thin composition route delegates to -- this suite mocks
//     the NEW route directly (not the underlying LLM call), per this
//     project's established "mock at the route boundary for slow/external
//     actions" convention (matches scene-construction-quick-gen.e2e.mjs's
//     own page.route() precedent for quick-gen, and combat-planning's own
//     ingestion-flagging precedent for LLM-backed routes generally).
//   - foundry_worldFabric/gm/gm-say.mjs (read ONLY, never modified) is the
//     reference for what 26.10's route wraps: headless Chromium login +
//     ChatMessage.create -- this suite mocks the NEW route boundary
//     (POST /api/entities/:entityId/foundry-push) directly, never spins up
//     a second real headless Chromium instance inside an already-running
//     Playwright-driven test (this project's own explicit instruction).
//
// ===========================================================================
// 1. PLAN STORE (26.1) -- routes under /api/scene-planning/plans/*
// ===========================================================================
//   `session-planner/plans.mjs`: {id, name, sceneIds:[]}, many-to-many (a
//   sceneId can appear in any number of Plans, no back-reference on Scene).
//     - POST /api/scene-planning/plans   { world, name }
//       -> 200 { plan: {id, name, sceneIds:[]} }
//     - GET  /api/scene-planning/plans?world=
//       -> 200 { plans: [...] }
//     - GET  /api/scene-planning/plans/:planId?world=
//       -> 200 { plan }
//     - POST /api/scene-planning/plans/:planId/scenes   { world, sceneId }
//       -> 200 { plan }  (sceneId appended to plan.sceneIds, idempotent --
//          adding the same sceneId twice must not duplicate the entry)
//     - DELETE /api/scene-planning/plans/:planId/scenes/:sceneId   { world }
//       (body or query, matching the sibling scene-membership DELETE route's
//       own established convention) -> 200 { plan }
//
// ===========================================================================
// 2. SCENE-LINK STORE (26.3) -- routes under /api/scene-planning/scene-links
// ===========================================================================
//   `session-planner/scene-links.mjs`: {sceneId, linkedSceneId, reason?},
//   ONE record per link (not two), bidirectional for QUERY purposes only.
//     - POST /api/scene-planning/scene-links
//       { world, sceneIdA, sceneIdB, reason? }
//       -> 200 { link: {sceneId, linkedSceneId, reason} }
//     - GET  /api/scene-planning/scene-links?world=&sceneId=
//       -> 200 { linked: [{sceneId, reason}] }  -- one entry per OTHER scene
//       linked to `sceneId`, regardless of which side of the original
//       sceneIdA/sceneIdB pair `sceneId` was stored as (the bidirectional
//       query property task 26.0 scenario 5 exists specifically to lock in).
//     - DELETE /api/scene-planning/scene-links
//       { world, sceneIdA, sceneIdB }  -> 200 { removed: true }
//
// ===========================================================================
// 3. PLACE-REQUIRED SCENE CREATION + LINK-OR-NOT (26.4), consumed by
//    "+Scene" (26.6) and quick-gen (26.5) in BOTH views
// ===========================================================================
//   A single shared sub-flow, mounted wherever a scene needs a place. Every
//   instance of it (construction-view "+Scene", Table Mode "+Scene",
//   quick-gen in both views) uses the SAME inner shape, under its own
//   caller-specific testid PREFIX (see each scenario file for its own exact
//   prefix) -- this header documents the shape generically as `<prefix>`.
//
//   `[data-testid="<prefix>-place-step"]`:
//     - `[data-testid="<prefix>-place-mode-existing-btn"]` (default active)
//       / `[data-testid="<prefix>-place-mode-new-btn"]` -- toggles which of
//       the two sub-panels below is shown. Both a place picker AND the
//       ability to create a new place must be reachable from this step for
//       EVERY scene-creation path in this phase (§26.A: "picking an
//       existing... OR creating a new one inline").
//     - EXISTING: a buildEntityPicker-shaped instance --
//       `[data-testid="<prefix>-place-input"]`,
//       `[data-testid="<prefix>-place-results"]`,
//       `[data-testid="<prefix>-place-option"][data-entity-id]`. Picking one
//       resolves the place to that entity id directly (no write).
//     - NEW: `[data-testid="<prefix>-new-place-name-input"]` +
//       `[data-testid="<prefix>-new-place-submit-btn"]` -- calls the REAL
//       `POST /api/graph/nodes { world, name, type:"place" }` route
//       (addNodeOp, confirmed live) and resolves the place to the returned
//       `entityId`. Zero new engine work (§26.A).
//   Once a place is resolved (either path), `[data-testid="<prefix>-link-
//   step"][data-place-entity-id]` renders:
//     - `[data-testid="<prefix>-link-yes-btn"]` -- reveals
//       `[data-testid="<prefix>-link-note-input"]` (optional free-text --
//       "rough distance"/relationship note) +
//       `[data-testid="<prefix>-link-confirm-btn"]`, which calls the REAL
//       `POST /api/graph/edges { world, sourceId:<the triggering scene's
//       own anchor entity id>, targetId:<place entity id>, notes:<note or
//       omitted> }` route (addEdgeOp, confirmed live) BEFORE creating the
//       scene.
//     - `[data-testid="<prefix>-link-no-btn"]` -- skips edge creation
//       entirely, goes straight to scene creation. Per §26.A, this offer
//       applies IDENTICALLY whether the place was picked-existing or
//       created-new -- this suite tests both combinations against the SAME
//       link-step contract, never a place-source-conditional variant of it.
//   Either link choice, once resolved, calls the EXISTING (Phase 16)
//   `POST /api/session-planner/scenes { world, locationEntityId:<place
//   entity id> }` route -- no new scene-creation mechanism anywhere in this
//   phase. `[data-testid="<prefix>-status"]` hosts feedback throughout.
//
// ===========================================================================
// 4. QUICK-GEN NOW TETHERED (26.5) -- prefix `quick-add-scene`
//    (construction view, unchanged top-level control) / `table-quick-gen`
//    (Table Mode, unchanged top-level control)
// ===========================================================================
//   The ONE-FIELD-ONE-BUTTON name input + submit button stay EXACTLY as
//   Phase 23 built them (`[data-testid="quick-add-scene-name-input"]` /
//   `[data-testid="quick-add-scene-submit-btn"]`, construction view) --
//   submitting still fires EXACTLY ONE `POST /api/scene-planning/quick-gen`
//   call, per Phase 21 §7's still-standing "genuinely fast, one field, one
//   button" bar for the TEXT-GENERATION step specifically. What changes:
//   quick-gen's OWN success callback no longer calls `POST /api/session-
//   planner/scenes` immediately with `locationEntityId` omitted -- instead
//   it renders §3's shared place-step/link-step sub-flow (testid prefix
//   `quick-add-scene`, i.e. `quick-add-scene-place-step`, `quick-add-scene-
//   place-mode-existing-btn`, etc., exactly mirroring §3's generic shape)
//   BEFORE the real `POST /api/session-planner/scenes` call fires, and that
//   call now ALWAYS carries a real, non-null `locationEntityId`. The
//   resulting scene must never carry `data-untethered="true"` -- that
//   attribute/state is retired by this task for every quick-gen-created
//   scene (task 26.0 scenario 2's whole point).
//
// ===========================================================================
// 5. "+SCENE" REPLACES "+ INSERT SCENE HERE" (26.6) -- prefix `add-scene`
// ===========================================================================
//   `[data-testid="add-scene-btn"][data-scene-id]` -- ONE per scene, living
//   at the BOTTOM of that scene's own box/card, in BOTH views (construction:
//   inside/after `scene-actions-bar`, a sibling of `develop-scene-btn` etc.;
//   Table Mode: inside `table-actions-bar`, a sibling of `table-add-event-
//   btn` etc.) -- NOT a between-scenes control, NOT scoped to any
//   `data-after-scene-id`. Click opens `[data-testid="add-scene-panel"]
//   [data-scene-id]`, running §3's shared flow under the `add-scene` prefix.
//   On success: construction view appends a new `[data-testid="scene-chain-
//   item"][data-scene-id="<newId>"]` to the chain (position: immediately
//   after the triggering scene, matching the old insert-between
//   mechanism's own append-after-source behavior, now driven by an
//   unambiguous "from THIS scene" trigger rather than an arbitrary
//   between-any-two-scenes picker); Table Mode shows a success message in
//   `[data-testid="add-scene-status"]` (Table Mode is single-scene-focused,
//   so it does not itself grow a list -- the new scene becomes reachable via
//   the nav zone, per §7 below).
//
//   `buildInsertSceneControl`/`[data-testid="insert-scene-control"]`/
//   `[data-testid="insert-scene-picker"]` are REMOVED ENTIRELY (both views)
//   -- a real DOM-absence assertion (`document.querySelectorAll(...).length
//   === 0`), not merely "not tested" (§26.B).
//
// ===========================================================================
// 6. "BEYOND THIS PATH" REMOVED; SPACE REPURPOSED (26.7)
// ===========================================================================
//   `renderBeyondCorridorSummary`/`[data-testid="beyond-corridor-summary"]`
//   (and its two children, `beyond-corridor-content-count`/`beyond-corridor-
//   structural-count`) are REMOVED ENTIRELY from the construction view's
//   scene-chain-item body -- a real DOM-absence assertion. Its former
//   position in DOM source order (immediately after the members grid, per
//   the current `buildSceneBodyInto`) now hosts:
//     - `[data-testid="connect-existing-scene-list"][data-scene-id]` --
//       surfaces BOTH `scene-linkage.mjs`'s hop-based candidates (the real
//       `GET /api/scene-planning/linkage?world=&sceneId=` route) AND §2's
//       explicitly-linked scenes (the real `GET /api/scene-planning/
//       scene-links?world=&sceneId=` route) together, each item
//       `[data-testid="connect-existing-scene-item"][data-scene-id]
//       [data-connect-source="linkage"|"scene-link"]` -- clicking one calls
//       the real scene-links POST route to record an explicit link from the
//       CURRENT scene to that one (a graph-adjacency hop candidate is not
//       automatically an explicit scene-link until this click records it --
//       the two mechanisms stay genuinely distinct per §26.C).
//     - `[data-testid="create-ad-hoc-scene-btn"][data-scene-id]` -- an ALIAS
//       for THIS scene's own `add-scene-btn` (§5) -- this suite asserts it
//       triggers the exact same `add-scene-panel`, never a second/duplicate
//       creation mechanism.
//   Both are QUICK, VISIBLE options -- not buried behind a `<details>` (the
//   whole point of removing the old collapsed summary).
//
// ===========================================================================
// 7. PLAN-SCOPED TABLE MODE (26.8) -- supersedes the flat `table-full-list`
// ===========================================================================
//   `[data-testid="table-full-list"]`/`table-full-list-toggle`/`table-full-
//   list-item` are REMOVED ENTIRELY from `table-nav-zone` -- a real
//   DOM-absence assertion. Table Mode's browse structure (adjacent-scenes
//   strip stays UNCHANGED, per table-mode-navigation.e2e.mjs's own
//   still-valid scenarios 1-2) now additionally includes:
//     - `[data-testid="table-start-new-plan-btn"]` -- ALWAYS visible
//       (deliberately distinct from the pre-existing, UNRELATED Phase 20
//       `[data-testid="session-planner-start-new"]` "start a fresh scene
//       chain" control -- different testid, different concept, no
//       collision). Opens `[data-testid="table-start-new-plan-panel"]`:
//       `[data-testid="table-start-new-plan-name-input"]` +
//       `[data-testid="table-start-new-plan-submit-btn"]` -- calls the real
//       `POST /api/scene-planning/plans` route, then the real `POST
//       .../plans/:planId/scenes` route (adding the CURRENTLY-displayed
//       scene), then persists the new plan as this world's active plan
//       (localStorage, mirroring `saveLastSceneId`'s own established
//       per-world-key convention -- this suite does not pin the exact key
//       name, only the OBSERVABLE effect: the newly-created plan is what
//       `table-active-plan-list` reflects on the very next render, including
//       after a full page reload).
//     - `[data-testid="table-active-plan-list"][data-plan-id]` -- present
//       ONLY once an active plan exists for this world. A real `<details>`,
//       OPEN by default (matching this project's established free/JS-free-
//       collapse precedent), `<summary data-testid="table-active-plan-
//       toggle">` showing the plan's name, containing one `[data-testid=
//       "table-active-plan-scene-item"][data-scene-id]` per scene in
//       `plan.sceneIds`, with `data-current="true"` on the entry matching
//       the currently-displayed scene. Clicking a non-current entry
//       navigates to `#session-planner/<id>?mode=table`, staying in Table
//       Mode (same convention as every other Table Mode nav control).
//     - `[data-testid="table-other-plans-list"]` -- one `[data-testid=
//       "table-other-plan-item"][data-plan-id]` per OTHER plan in this
//       world (excludes the active one). Each is its OWN real `<details>`,
//       COLLAPSED by default, `<summary data-testid="table-other-plan-
//       toggle">` = that plan's name, revealing `[data-testid="table-other-
//       plan-scene-item"][data-scene-id]` per scene in ITS `sceneIds` on
//       expand. Clicking one of these navigates AND makes that plan the new
//       active plan (so a subsequent render shows it under
//       `table-active-plan-list` instead).
//   This suite's fixture convention for every Plan-scoped Table Mode test:
//   seed Plans/scene-memberships via the REAL routes above (never
//   hand-constructed plan JSON), matching `createSceneViaRoute`'s own
//   established real-route-round-trip precedent.
//
// ===========================================================================
// 8. POST-SESSION GRAPH UPDATE (26.9) -- thin composition over the existing
//    writeup-import pipeline, NOT new LLM plumbing
// ===========================================================================
//   `POST /api/scene-planning/plans/:planId/propose-updates   { world }` --
//   resolves the Plan's scenes' pending notes (`session-notes.mjs`'s
//   `listPendingNotes`, filtered to notes whose `sceneId` is one of the
//   Plan's `sceneIds`), assembles writeup-shaped text (grouped by scene,
//   each group prefixed with that scene's own display name + anchor
//   location name), and delegates to the EXACT SAME logic the existing
//   `POST /api/writeup-propose` route already uses (this suite's route-level
//   test asserts this indirectly by mocking `importWriteup`'s own
//   observable network-adjacent seam is unnecessary -- instead this suite
//   MOCKS THIS NEW ROUTE ITSELF via page.route() for the UI-level test, per
//   this project's established "mock at the route boundary" convention, AND
//   separately proves the route-level contract with a REAL (unmocked)
//   in-process call using a real, tiny `opts.llmOpts.client` stub -- the
//   SAME dependency-injection seam `writeup-propose-routes`-style tests in
//   this project already use for `proposeWfiFromWriteup`, so the real
//   assembly/delegation code path is genuinely exercised, not just its UI
//   wrapper). Response shape matches `importWriteup`'s own real return
//   shape: `{ batchId, mutationCount, importSummary, suggestions, headline
//   }`. The resulting `batchId` MUST be reachable through the EXISTING,
//   completely unmodified `GET /api/batches/:batchId` route AND rendered by
//   Batch Review at `#review/<batchId>` -- this suite's UI-level test
//   navigates there directly and asserts real batch content renders, never
//   a second/parallel review surface.
//   UI trigger: `[data-testid="propose-graph-updates-btn"][data-plan-id]` --
//   lives wherever a Plan's own view/summary renders (this suite finds it
//   via `table-active-plan-list`'s own plan-scoped nav zone, the one place
//   in this phase's UI a "current Plan" is already a first-class concept)
//   -- opens `[data-testid="propose-graph-updates-status"]` for feedback,
//   and on success navigates to `#review/<batchId>`.
//
// ===========================================================================
// 9. "DROP THIS INTO FOUNDRY" (26.10) -- replaces the playerKnown gate
// ===========================================================================
//   `buildPlayerKnownGate`/`[data-testid="table-roster-playerknown-gate-
//   btn"]`/`[data-testid="table-roster-playerknown-confirm-panel"]`/
//   `[data-testid="table-roster-playerknown-confirm-btn"]`/`[data-testid=
//   "table-roster-playerknown-cancel-btn"]`/`[data-testid="table-roster-
//   playerknown-value"]` and the button's own former "Reveal player-known
//   status…" text are REMOVED ENTIRELY -- a real DOM-absence assertion
//   (`document.querySelectorAll(...).length === 0` for every one of those
//   selectors, and `document.body.textContent` does not contain "player-known
//   status"), not merely "not tested".
//   In `table-roster-detail`'s same position, a genuine action instead:
//     - `[data-testid="table-roster-foundry-push-btn"][data-entity-id]` --
//       opens `[data-testid="table-roster-foundry-push-confirm-panel"]` with
//       `[data-testid="table-roster-foundry-push-confirm-btn"]` and
//       `[data-testid="table-roster-foundry-push-cancel-btn"]` (a real
//       confirm step, per §26.F -- gated exactly as deliberately as the old
//       playerKnown reveal was, but for a real action this time). Confirming
//       calls the REAL `POST /api/entities/:entityId/foundry-push { world }`
//       route (MOCKED via page.route() in this suite -- the real route
//       wraps headless-Chromium login + ChatMessage.create per gm-say.mjs,
//       genuinely slow/external, never re-invoked for real inside an
//       already-running Playwright session) and shows
//       `[data-testid="still-working-indicator"]` (this file's own
//       established `withSlowNoticeIndicator` pattern, extended to this
//       phase's one new genuinely-slow non-LLM call site) while the mocked
//       call is in flight, then `[data-testid="table-roster-foundry-push-
//       status"]` reflects success/failure. Cancelling leaves zero
//       `table-roster-foundry-push-confirm-panel` elements and never calls
//       the route at all.
//
// ===========================================================================
// 10. TAGS DROPPED FROM ROSTER DETAIL (26.11)
// ===========================================================================
//   `[data-testid="table-roster-detail-tag"]` no longer renders AT ALL --
//   real DOM-absence (`document.querySelectorAll(...).length === 0`) even
//   when the underlying entity genuinely has a non-empty `tags` array (the
//   data fetch is untouched, per §26.G -- only the render is removed).
//   `description`/`summary`/`imageUrl` are UNCHANGED, still rendering
//   exactly as Phase 25 built them.
//
// ---------------------------------------------------------------------------
// Fixture/isolation conventions -- mirrors scene-construction-fixture.mjs /
// table-mode-fixture.mjs exactly: real in-process createReviewServer
// ({port:0}), real fixture seeding via the actual store/API functions
// (bootstrapSnapshot + applyHeadless for graph entities/edges, the real
// POST /api/session-planner/scenes route for scenes, the real Plan/
// scene-link routes documented above for THEIR OWN stores -- never
// hand-constructed plan/scene-link JSON).
// ---------------------------------------------------------------------------
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  setupSceneConstructionEnv,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
} from "./scene-construction-fixture.mjs";

/**
 * setupSceneConstructionEnv() plus the TWO additional store directories
 * Phase 26 introduces (session-planner/plans.mjs, session-planner/
 * scene-links.mjs) that predate this suite -- same "added when first
 * actually exercised" gap fixture.mjs/scene-construction-fixture.mjs's own
 * headers document for every prior new store.
 */
export function setupPhase26Env(prefix) {
  const { scratchDir, dataDir } = setupSceneConstructionEnv(prefix);
  process.env.GM_TOOLS_PLANS_DIR = join(scratchDir, "session-plans");
  process.env.GM_TOOLS_SCENE_LINKS_DIR = join(scratchDir, "scene-links");
  return { scratchDir, dataDir };
}

/** Real POST /api/scene-planning/plans round trip. */
export async function createPlanViaRoute(base, world, name) {
  const res = await fetch(`${base}/api/scene-planning/plans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, name })
  });
  const body = await res.json();
  assert.equal(res.status, 200, `plan setup itself must succeed -- broken test setup, not the thing under test (got ${res.status}: ${JSON.stringify(body)})`);
  return body.plan;
}

/** Real POST /api/scene-planning/plans/:planId/scenes round trip. */
export async function addSceneToPlanViaRoute(base, world, planId, sceneId) {
  const res = await fetch(`${base}/api/scene-planning/plans/${encodeURIComponent(planId)}/scenes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, sceneId })
  });
  const body = await res.json();
  assert.equal(res.status, 200, `add-scene-to-plan setup itself must succeed -- broken test setup, not the thing under test (got ${res.status}: ${JSON.stringify(body)})`);
  return body.plan;
}

/** Real POST /api/scene-planning/scene-links round trip. */
export async function linkScenesViaRoute(base, world, sceneIdA, sceneIdB, reason) {
  const res = await fetch(`${base}/api/scene-planning/scene-links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, sceneIdA, sceneIdB, reason })
  });
  const body = await res.json();
  assert.equal(res.status, 200, `scene-link setup itself must succeed -- broken test setup, not the thing under test (got ${res.status}: ${JSON.stringify(body)})`);
  return body.link;
}

export {
  setupSceneConstructionEnv,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
};
