// Phase 23 task 23.0 -- shared setup + THE FULL DOM/ROUTE CONTRACT for the
// scene-construction e2e suite (review-ui/test/e2e/scene-construction-*
// .e2e.mjs). NOT itself an *.e2e.mjs file (the npm run test:e2e glob is
// test/e2e/*.e2e.mjs), same exemption as fixture.mjs/combat-planning-fixture
// .mjs -- every scene-construction-*.e2e.mjs file imports what it needs from
// here rather than each re-deriving the shared contract independently.
//
// THIS IS THE INTERFACE SPEC tasks 23.1-23.7 implement to match. None of the
// DOM described below exists yet -- every *.e2e.mjs file in this suite is
// EXPECTED TO FAIL with a Playwright selector-not-found/timeout error right
// now. That failure is the deliverable of this task, not a bug in these
// files. Read this header FIRST; each sibling file's own header only adds
// scenario-specific detail, per this project's established
// scenes-tab-browse-and-navigate.e2e.mjs / scenes-tab-linkage.e2e.mjs
// "read the shared header once" precedent.
//
// ===========================================================================
// SCOPE: reworks review-ui/public/session-planner-view.js's existing
// #session-planner/<sceneId> view from Phase 17's single-scene brief display
// into a persisted, ordered CHAIN display (plans/phase-21-review.md §1/§2),
// plus a lightweight, additive extension to review-ui/public/
// combat-planning-view.js (an optional sceneId return-context arg). NO new
// nav entry -- Phase 24 already owns the new `data-nav="scenes"` browse tab
// (a SIBLING, confirmed live in review-ui/public/index.html /
// review-ui/public/scenes-view.js); this phase reworks the body of the
// EXISTING `data-nav="session-planner"` / `#view-session-planner` /
// `#session-planner-body` surface, unchanged container ids throughout.
// ===========================================================================
//
// ---------------------------------------------------------------------------
// 1. SCENE CHAIN DISPLAY (task 23.1)
// ---------------------------------------------------------------------------
//   - `[data-testid="scene-chain"]` -- wraps the whole ordered chain, direct
//     child of `#session-planner-body`.
//   - `[data-testid="scene-chain-item"][data-scene-id="<id>"]` -- ONE per
//     scene in the chain. This is a real `<details>` element (matching
//     session-planner-view.js's own established renderBeyondCorridorSummary
//     `<details>`/`<summary>` "free, JS-free collapse" precedent, cited in
//     plans/phase-23-tasks.md's own grounding pass) -- collapsed by default,
//     EXCEPT the currently-loaded/focused scene's own item, which starts
//     expanded (`open` attribute present). Carries `data-current="true"`
//     on exactly the currently-loaded scene's item.
//   - Order: ascending by hop-distance from whichever scene the view was
//     entered on (session-planner/scene-linkage.mjs's own
//     linkedScenesForScene sort, already tested/shipped in Phase 22 --
//     scenes-tab-linkage.e2e.mjs's own sanity check against the real
//     linkage route proves this sort direction), with the current scene
//     itself included at hop-distance 0. Every fixture in this suite that
//     asserts chain ORDER (only scene-construction-chain-display.e2e.mjs)
//     always loads the view from one END of a straight-line chain
//     specifically so this gives one unambiguous total order -- see that
//     file's own header for why.
//   - `<summary data-testid="scene-chain-toggle">` -- the native
//     expand/collapse control, inside each `scene-chain-item`. Contains at
//     minimum the anchor entity's resolved NAME (never a raw entityId).
//   - Inside each item's body (after `<summary>`):
//       - `[data-testid="location-card"][data-card-role="anchor"|
//         "satellite"|"added"][data-entity-id]` -- REUSES Phase 17's exact
//         existing testid/attribute convention (renderLocationCard,
//         confirmed live) for anchor/satellite members from the corridor
//         brief, PLUS a new third role value `"added"` for entities in this
//         scene's explicit session-planner/scene-membership.mjs list (task
//         23.2's arbitrary-add mechanism) that aren't already part of the
//         corridor brief.
//       - `[data-testid="scene-actions-bar"][data-scene-id]` -- see §6/§7
//         below for its children; ALL of a scene's construction actions
//         (add-node, develop-scene, add-event, add-encounter) are siblings
//         inside this one bar, in DOM source order:
//         add-node-toggle, develop-scene-btn, add-event-btn,
//         add-encounter-btn.
//       - `[data-testid="scene-rollback-panel"][data-scene-id]` -- see §4.
//       - `[data-testid="saved-encounters-list"][data-scene-id]` -- see §7.
//   - `[data-testid="insert-scene-control"][data-after-scene-id="<id>"]` --
//     rendered as a sibling BETWEEN each pair of adjacent `scene-chain-item`
//     elements, AND once more after the last item (append-to-end case). See
//     §3.
//   - `[data-testid="quick-add-scene-btn"]` -- ONE, top-level, direct child
//     of `#session-planner-body` (a sibling of `scene-chain`, not scoped to
//     any one scene or insertion point) -- see §8.
//
// ---------------------------------------------------------------------------
// 2. ADD ARBITRARY NODE (task 23.2) -- `POST/DELETE .../members`,
//    `GET .../intervening-offer`
// ---------------------------------------------------------------------------
//   - `[data-testid="add-node-toggle"]` (inside a scene's `scene-actions-bar`)
//     -- opens `[data-testid="add-node-panel"][data-scene-id]`, a
//     buildEntityPicker-shaped component (session-planner-view.js's already-
//     shipped, reused-not-reinvented component per plans/phase-23-tasks.md's
//     own grounding pass):
//       - `[data-testid="add-node-input"]`
//       - `[data-testid="add-node-results"]`
//       - `[data-testid="add-node-option"][data-entity-id="<id>"]`
//     - `[data-testid="add-node-status"]` -- feedback text area.
//   - UNREACHABLE branch: picking an option with no path from the scene's
//     anchor calls `POST /api/scene-planning/scenes/:sceneId/members
//     {world, entityId}` DIRECTLY, no further prompting -- a new
//     `[data-testid="location-card"][data-card-role="added"][data-entity-id]`
//     appears in that scene's body.
//   - REACHABLE branch: picking a reachable-but-not-yet-shown option first
//     calls `GET /api/scene-planning/scenes/:sceneId/intervening-offer
//     ?world=&targetEntityId=<id>` and renders, as an EXPLICIT separate
//     confirmation step (never auto-added):
//       - `[data-testid="intervening-offer-panel"][data-scene-id]
//         [data-target-entity-id]`
//       - `[data-testid="intervening-offer-node"][data-entity-id]` -- one
//         per `offer.interveningEntityIds` entry, containing
//         `[data-testid="intervening-offer-node-name"]` (resolved name).
//       - `[data-testid="intervening-offer-accept-btn"]` -- adds the target
//         AND every intervening node (one `POST .../members` call per id,
//         since scene-membership.mjs's addNodeToScene has no batch form).
//       - `[data-testid="intervening-offer-skip-btn"]` -- adds ONLY the
//         target, none of the intervening ids.
//     Neither the target nor any intervening node may appear as a
//     `location-card` until one of these two buttons is clicked.
//
// ---------------------------------------------------------------------------
// 3. "+" BETWEEN SCENES (task 23.3) -- real place vs. `POST .../transit-entity`
// ---------------------------------------------------------------------------
//   `[data-testid="insert-scene-control"][data-after-scene-id]` (see §1) opens
//   `[data-testid="insert-scene-picker"][data-after-scene-id]`, offering BOTH
//   paths side by side (never one hidden behind the other):
//     - EXISTING PLACE: another buildEntityPicker-shaped instance --
//       `[data-testid="insert-scene-place-input"]`,
//       `[data-testid="insert-scene-place-results"]`,
//       `[data-testid="insert-scene-place-option"][data-entity-id]`. Picking
//       one calls the EXISTING (Phase 16) `POST /api/session-planner/scenes
//       {world, locationEntityId}` route -- no new scene-creation mechanism.
//     - TRANSIT/PATH: `[data-testid="insert-scene-transit-name-input"]`
//       (optional -- blank is valid, matches transit-entity.mjs's own
//       default-naming allowance) + `[data-testid="insert-scene-transit-
//       submit-btn"]`. Calls `POST /api/scene-planning/transit-entity
//       {world, fromEntityId, toEntityId, name?}` (fromEntityId/toEntityId:
//       the anchors of the two scenes this control sits between; the LAST
//       insert-scene-control's toEntityId is the same as fromEntityId, i.e.
//       there is no "next" scene to point to at the end of the chain), THEN
//       `POST /api/session-planner/scenes {world,
//       locationEntityId: <returned entity.entityId>}` with the returned
//       entity id.
//   Either path's success appends a new `[data-testid="scene-chain-item"]
//   [data-scene-id="<newId>"]` to the chain, positioned immediately after
//   `data-after-scene-id`'s own item.
//
// ---------------------------------------------------------------------------
// 4. DEVELOP-NODE / DEVELOP-SCENE (task 23.4) -- genuine peers, per-node review
// ---------------------------------------------------------------------------
//   - `[data-testid="develop-node-btn"][data-entity-id]` -- ONE per
//     `location-card` (every role, including "anchor"). Click calls
//     `POST /api/entities/:entityId/prep/propose-framings {world}` (the
//     EXISTING Phase 11 single-node route -- review-ui/server.mjs's already-
//     shipped `/api/entities/:entityId/prep/*` surface, confirmed live,
//     reused verbatim) and opens
//     `[data-testid="develop-node-panel"][data-entity-id]`:
//       - `[data-testid="develop-node-framing-option"][data-framing-id]` --
//         one radio-shaped control per returned framing.
//       - `[data-testid="develop-node-generate-btn"]` -- calls
//         `POST /api/entities/:entityId/prep/generate {world, selection}`.
//       - once generated: `[data-testid="develop-node-content"]` (the
//         returned prep content) + `[data-testid="develop-node-accept-btn"]`
//         (calls `POST .../prep/accept {world}`) +
//         `[data-testid="develop-node-discard-btn"]` (calls
//         `POST .../prep/discard {world}`) -- the SAME existing accept/
//         discard gate every other prep-content surface in this project
//         already uses (review-ui/public/app.js's renderPrepContentCard,
//         confirmed live) -- this suite is the first to give it real
//         data-testids, since app.js's own existing entity-detail
//         instance of this flow currently has none.
//   - `[data-testid="develop-scene-btn"][data-scene-id]` (inside
//     `scene-actions-bar`) -- ONE per scene. Click:
//       1. `POST /api/scene-planning/scenes/:sceneId/undo/start {world}`
//          (starts a fresh scene-undo session -- see §5).
//       2. `POST /api/scene-planning/scenes/:sceneId/develop
//          {world, memberEntityIds}` with NO `selections` -- per
//          mutation-engine/scene-develop.mjs's own documented behavior, a
//          member with no `selections` entry runs propose-framings ONLY
//          (`stage:"framed"`), deferring generate/accept/discard to the
//          SAME single-node routes §4's develop-node flow already uses --
//          this is what makes "per-node review," not a bypass. This whole
//          call is wrapped in `[data-testid="develop-scene-status"]
//          [data-scene-id]`'s `withSlowNotice`-style indicator (see §9 --
//          one of exactly two LLM call sites in this phase).
//       3. Renders `[data-testid="develop-scene-review-panel"]
//          [data-scene-id]`, containing one `[data-testid="develop-scene-
//          review-node"][data-entity-id]` per `results[]` entry, each with
//          the SAME shape as `develop-node-panel` above under a distinct
//          testid prefix (so both can coexist in the DOM without collision):
//          `develop-scene-review-framing-option`,
//          `develop-scene-review-generate-btn`,
//          `develop-scene-review-content`,
//          `develop-scene-review-accept-btn`,
//          `develop-scene-review-discard-btn` -- calling the EXACT SAME
//          `/api/entities/:entityId/prep/{generate,accept,discard}` routes,
//          per entityId, independently. Accepting/discarding one review
//          node must never affect any other review node's own state.
//   `develop-node-btn` and `develop-scene-btn` are both ALWAYS visible
//   together (neither conditionally hides the other), and neither ever
//   fires its own network call without an explicit click (no auto-develop
//   on scene load).
//
// ---------------------------------------------------------------------------
// 5. SCENE-LOCAL ROLLBACK (task 23.5) -- `.../undo/{start,record,last,all,clear}`
// ---------------------------------------------------------------------------
//   `[data-testid="scene-rollback-panel"][data-scene-id]` -- lives DIRECTLY
//   in each scene's own body (see §1), never behind `data-nav="settings"` /
//   the gear menu.
//     - `[data-testid="scene-rollback-action-list"]` with
//       `[data-testid="scene-rollback-action-item"][data-action-id]` --
//       rendered from `GET /api/scene-planning/scenes/:sceneId/undo?world=`
//       (peek), one per action currently in the session, in the SAME order
//       that route returns them (append/chronological order).
//     - `[data-testid="scene-rollback-undo-last-btn"]` -- calls
//       `POST .../undo/last {world}`; removes exactly the most-recently-
//       recorded action from the list.
//     - `[data-testid="scene-rollback-undo-all-btn"]` -- calls
//       `POST .../undo/all {world}`; empties the list in one call.
//     - `[data-testid="scene-rollback-status"]` -- feedback text,
//       distinguishing which of the two actions just ran (this file's own
//       test asserts the two produce different, distinguishable outcomes,
//       not just that both exist).
//
// ---------------------------------------------------------------------------
// 6. ADD EVENT / ADD ENCOUNTER, EQUAL WEIGHT (task 23.6)
// ---------------------------------------------------------------------------
//   Both live as direct siblings inside the SAME `scene-actions-bar` (see
//   §1) as `develop-scene-btn`/`add-node-toggle` -- same parent, same button
//   element type/class, no wrapping accordion/disclosure around either one
//   that isn't ALSO around the other.
//     - `[data-testid="add-event-btn"][data-scene-id]` -- opens
//       `[data-testid="scene-event-panel"][data-scene-id]` with
//       `[data-testid="scene-event-textarea"]` (autosave-on-input, mirroring
//       session-planner-view.js's existing `toggleNotePanel`/
//       `location-note-textarea` debounce pattern verbatim) -- calls the
//       EXISTING `POST /api/session-planner/notes {world, text,
//       anchorEntityId, sceneId}` route (session-planner/session-notes.mjs's
//       captureNote, confirmed live and already scene-aware -- no new engine
//       code), with `anchorEntityId` set to the scene's own
//       `locationEntityId` (or omitted for an untethered scene, see §8) and
//       `sceneId` set to this scene's id.
//     - `[data-testid="add-encounter-btn"][data-scene-id]` -- a real
//       NAVIGATION (via the hash router, `location.hash =
//       "combat-planning/" + sceneId`), landing in a lightly-extended
//       Encounter Builder view -- see §7.
//
// ---------------------------------------------------------------------------
// 7. ADD ENCOUNTER ROUND-TRIP (task 23.6) -- addendum routes
// ---------------------------------------------------------------------------
//   `review-ui/public/combat-planning-view.js`'s exported `renderCombatPlanning`
//   gains an OPTIONAL `sceneIdArg` parameter (mirroring
//   `renderCombatPlanningIngest(kindArg)`'s own existing single-arg
//   convention, confirmed live) -- `review-ui/public/app.js`'s
//   `renderCurrentView()` dispatch passes `arg` through:
//   `else if (view === "combat-planning") renderCombatPlanning(arg);`
//   (currently called with zero args). When `sceneIdArg` is present:
//     - `[data-testid="save-encounter-to-scene-btn"]` -- visible ONLY in
//       this return-context. Click calls
//       `POST /api/scene-planning/scenes/:sceneId/encounters
//       {world, name?, combination, knobs, scoreSnapshot}` (the Phase 22
//       ADDENDUM route, `combat-planning/saved-encounter.mjs`'s
//       `saveEncounter`, confirmed live) using the builder's own live
//       `session.workingRoster`/`session.knobs`/`session.latestSuggestion`
//       state (this file's grounding note: combat-planning-view.js's
//       existing `toManualCombination(workingRoster)` helper, confirmed
//       live, already produces exactly the `combination` shape this route
//       expects). On success, navigates back to
//       `#session-planner/<sceneId>`.
//     - `[data-testid="return-to-scene-link"]` -- a plain "back without
//       saving" escape hatch, same destination.
//   Back in Session Planner, that scene's
//   `[data-testid="saved-encounters-list"][data-scene-id]` (see §1) shows
//   `[data-testid="saved-encounter-item"][data-encounter-id]`, each with
//   `[data-testid="saved-encounter-name"]` and
//   `[data-testid="saved-encounter-remove-btn"]` (calls
//   `DELETE .../encounters/:encounterId {world}`, removing the item).
//   Rendered from `GET /api/scene-planning/scenes/:sceneId/encounters
//   ?world=`.
//
// ---------------------------------------------------------------------------
// 8. MID-SESSION AD-HOC "+" / QUICK-GEN (task 23.7) -- `POST .../quick-gen`
// ---------------------------------------------------------------------------
//   `[data-testid="quick-add-scene-btn"]` (see §1, top-level, not scoped to
//   any one insertion point -- deliberately distinct from §3's structured
//   "+ between scenes" control, matching design record §7's framing of this
//   as the DM's own fast, silent, always-reachable escape hatch, not a
//   position-specific insert) opens
//   `[data-testid="quick-add-scene-panel"]`:
//     - `[data-testid="quick-add-scene-name-input"]` -- the ONE field.
//     - `[data-testid="quick-add-scene-submit-btn"]` -- the ONE button.
//     - `[data-testid="quick-add-scene-status"]` -- hosts the
//       `still-working-indicator` (see §9) while in flight.
//   Submit:
//     1. Exactly ONE `POST /api/scene-planning/quick-gen {world, prompt}`
//        call (`mutation-engine/quick-gen.mjs`'s `quickGenerate`, confirmed
//        live as a single-call, no-round-trip primitive) -- `prompt` is
//        client-composed from the typed name; this suite does not pin its
//        exact wording, only that the call happens exactly once, with no
//        `reframe`-shaped follow-up call of any kind.
//     2. `POST /api/session-planner/scenes {world,
//        objectiveNote: <derived from the typed name + quick-gen's
//        returned text>}` -- `locationEntityId` OMITTED (an untethered
//        scene, `locationEntityId: null` per session-planner/scenes.mjs's
//        own schema -- a quick-gen scene has no real-world anchor to chain-
//        order against, by design; "one field, one button" rules out also
//        making the DM pick a location here).
//   A new `[data-testid="scene-chain-item"][data-scene-id="<newId>"]
//   [data-untethered="true"]` is APPENDED at the end of the visible chain
//   (untethered scenes have no adjacency to sort by).
//
// ---------------------------------------------------------------------------
// 9. LOADING-AFFORDANCE SCOPE (task 23.0 scenario 10)
// ---------------------------------------------------------------------------
//   `[data-testid="still-working-indicator"]` (combat-planning-view.js's
//   already-shipped `withSlowNoticeIndicator` pattern, confirmed live --
//   fires ~1500ms into an in-flight request, same timing constant) may
//   appear ONLY inside `[data-testid="develop-scene-status"]` (§4) and
//   `[data-testid="quick-add-scene-status"]` (§8) -- this phase's only two
//   genuine LLM call sites. It must NEVER appear during: scene-chain-toggle
//   expand/collapse, add/remove-node (§2), the intervening-offer accept/skip
//   (§2), insert-scene (§3, both real-place and transit-entity paths --
//   transit-entity creation is a real graph write, not an LLM call), or
//   either rollback action (§5) -- all genuinely fast/local/deterministic,
//   matching this project's established withSlowNotice-scoping discipline
//   (graph-view.js / combat-planning-view.js's own precedent, and
//   plans/phase-23-tasks.md's own explicit instruction).
//
// ---------------------------------------------------------------------------
// Fixture/isolation conventions -- mirrors combat-planning-fixture.mjs /
// fixture.mjs exactly: real in-process createReviewServer({port:0}), real
// fixture seeding via the actual store/API functions (bootstrapSnapshot +
// applyHeadless for graph entities/edges, the real
// POST /api/session-planner/scenes route for scenes -- never hand-
// constructed scene/entity JSON).
// ---------------------------------------------------------------------------
import { setupScratchEnv, cleanupScratchEnv, DESKTOP_VIEWPORT, IPHONE_13_VIEWPORT } from "./fixture.mjs";
import { join } from "node:path";
import assert from "node:assert/strict";

/**
 * setupScratchEnv() plus the THREE additional store directories Phase 22
 * introduced that predate this suite (same "added when first actually
 * exercised" gap fixture.mjs's own header documents for session-scenes/
 * session-notes/bestiary/party-roster) -- matches
 * review-ui/test/scene-planning-routes.test.mjs's / scene-planning-
 * encounters-routes.test.mjs's own established env-var set exactly.
 */
export function setupSceneConstructionEnv(prefix) {
  const { scratchDir, dataDir } = setupScratchEnv(prefix);
  process.env.GM_TOOLS_SCENE_UNDO_DIR = join(scratchDir, "scene-undo");
  process.env.GM_TOOLS_SAVED_ENCOUNTERS_DIR = join(scratchDir, "saved-encounters");
  return { scratchDir, dataDir };
}

/** Real POST /api/session-planner/scenes round trip -- the same real path a browser session uses, matching scenes-tab-*.e2e.mjs's own established convention over calling session-planner/scenes.mjs's createScene() directly. */
export async function createSceneViaRoute(base, world, { locationEntityId, objectiveNote } = {}) {
  const res = await fetch(`${base}/api/session-planner/scenes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, locationEntityId, objectiveNote })
  });
  const body = await res.json();
  assert.equal(res.status, 200, `scene setup itself must succeed -- broken test setup, not the thing under test (got ${res.status}: ${JSON.stringify(body)})`);
  return body.scene;
}

/** Sets localStorage["gmReview.world"] via a real page load first, matching scenes-tab-*.e2e.mjs's own established convention (page.evaluate cannot touch localStorage on about:blank). */
export async function primeWorldSelection(page, base, world) {
  // Phase 37 task 37.3: #queue retired (now redirects into the shell); use a
  // surviving legacy hash to load the app + set localStorage before the real
  // navigation. Any hash works -- this only primes localStorage.
  await page.goto(`${base}/#graph`);
  await page.evaluate((w) => localStorage.setItem("gmReview.world", w), world);
}

export { cleanupScratchEnv, DESKTOP_VIEWPORT, IPHONE_13_VIEWPORT };
