// Phase 27 task 27.0 -- shared setup + THE FULL DOM/ROUTE CONTRACT for the
// Phase 27 e2e suite (scene-delete.e2e.mjs, plan-first-navigation.e2e.mjs,
// plan-scoped-scene-links.e2e.mjs, encounter-link-picker.e2e.mjs, plus the
// Phase-27-touched scenarios folded into scene-construction-develop.e2e.mjs/
// scene-construction-quick-gen.e2e.mjs/scene-links-roundtrip.e2e.mjs/
// add-scene-control.e2e.mjs/beyond-path-removed.e2e.mjs/scene-creation-
// place-required.e2e.mjs/scene-construction-events-encounters.e2e.mjs/
// scene-construction-loading-scope.e2e.mjs). NOT itself an *.e2e.mjs file
// (the npm run test:e2e glob is test/e2e/*.e2e.mjs), same exemption as
// fixture.mjs/scene-construction-fixture.mjs/phase26-fixture.mjs -- every
// Phase-27-touched file imports what it needs from here (plus, where
// relevant, phase26-fixture.mjs/scene-construction-fixture.mjs directly for
// their own already-established helpers) rather than re-deriving the shared
// contract independently.
//
// THIS IS THE INTERFACE SPEC tasks 27.1-27.9 implement to match. Grounded in
// plans/phase-27-tasks.md's own task 27.0 bullet list and the design record
// (.claude/plans/let-s-pull-up-the-warm-catmull.md, F1-F13). Every new
// route/DOM contract below is confirmed NOT to exist yet against the real,
// current session-planner-view.js/scenes-view.js/server.mjs (re-verified by
// reading the actual source, not trusted from either planning doc) -- every
// Phase-27 *.e2e.mjs scenario is EXPECTED TO FAIL right now with either a
// Playwright selector-not-found/timeout error or a real HTTP 404/500 from a
// route that doesn't exist yet. That failure is the deliverable of task
// 27.0, not a bug in these files.
//
// ===========================================================================
// DESIGN DECISION THIS SUITE LOCKS IN (task 27.0's own judgment call, since
// phase-27-tasks.md deliberately leaves exact route/testid shapes to the QE
// pass where it says "e.g." -- documented here so 27.4-27.9's implementers
// match ONE contract, not their own independent guess):
// ===========================================================================
//
// MINIMAL-DISRUPTION PLAN-FIRST ROUTING: rather than replacing the existing
// `#session-planner/<sceneId>` deep-link / bare `#session-planner` / bare
// `#session-planner/new` dispatch wholesale, Phase 27 ADDS one new hash
// shape (`#session-planner/plan/<planId>`) and makes the EXISTING
// `#session-planner/<sceneId>` dispatch plan-AWARE via `resolveActivePlan`
// (already shared with Table Mode, session-planner-view.js line ~179 --
// reused verbatim, no second plan-resolution path per 27.4's own
// instruction). Concretely:
//
//   - `#session-planner/plan/<planId>` (NEW): opens Plan `planId` directly.
//     - `plan.sceneIds.length === 0` -> `[data-testid="plan-empty-state"]
//       [data-plan-id]`, containing ONLY the plan-level "+Scene" control
//       (`plan-add-scene-btn`/`plan-add-scene-panel`, see below) -- NO
//       `scene-chain`, NO `scene-actions-bar`, NO develop-scene-btn anywhere
//       in the DOM. This is F3's "a new/empty plan renders a screen whose
//       only construction action is +Add scene."
//     - non-empty -> `[data-testid="scene-chain"][data-plan-id="<planId>"]`
//       (the `data-plan-id` attribute is ADDITIVE onto the pre-existing
//       `scene-chain` element -- every pre-Phase-27 test asserting on
//       `[data-testid="scene-chain"]` alone keeps matching), populated with
//       ONLY `plan.sceneIds`' own scenes (never scenes outside the plan),
//       ordered by hop-distance from the LAST-added scene in `sceneIds`
//       (`sceneIds[sceneIds.length-1]`, treated as "current"/expanded) via
//       the EXISTING `buildChainOrder`/linkage-route machinery, restricted
//       to the plan's own candidate set.
//     - Saves this plan as the world's active plan (`saveActivePlanId`,
//       already shared with Table Mode) on open.
//
//   - `#session-planner/<sceneId>` (deep link, UNCHANGED shape): resolves
//     `resolveActivePlan(world, sceneId, plans)`.
//     - Resolves to a real Plan -> renders EXACTLY as
//       `#session-planner/plan/<planId>` above, except "current" is
//       `sceneId` itself (not necessarily the last-added one), and ordering
//       is hop-distance from `sceneId` within the plan's own `sceneIds`.
//     - Resolves to null (this scene isn't a member of ANY Plan yet) ->
//       LEGACY FALLBACK, UNCHANGED from pre-Phase-27 behavior: the full,
//       whole-world hop-ordered chain across every root scene (exactly
//       today's `loadAndRenderChain`/`buildChainOrder` behavior) --
//       this is what keeps scene-construction-chain-display.e2e.mjs/
//       scene-construction-develop.e2e.mjs/scene-construction-quick-gen
//       .e2e.mjs/session-planner-resume-persistence.e2e.mjs/session-planner-
//       flush-on-navigate.e2e.mjs/session-planner-bootstrap-picker-place-
//       default.e2e.mjs/plans-crud.e2e.mjs GREEN WITHOUT ANY EDIT: every one
//       of those files' own fixtures creates scenes that are NEVER added to
//       a Plan via the real Plan routes, so they always take this fallback
//       path, unaffected by anything below.
//
//   - Bare `#session-planner` / `#session-planner/new`: UNCHANGED dispatch
//     (`loadLastSceneId`-then-fallback-to-`renderBootstrap`,
//     `clearLastSceneId`-then-`renderBootstrap` for the "new" sentinel) --
//     `renderBootstrap`'s own DOM (`scene-bootstrap-location-*` testids) is
//     untouched by this phase; a scene created through it starts out with no
//     Plan membership (same legacy-fallback path above) until something
//     explicitly adds it to a Plan via the real Plan routes.
//
// PER-SCENE "+SCENE" RETIRES; ONE PLAN-LEVEL CONTROL REPLACES IT EVERYWHERE
// (F6), regardless of plan-scoped-or-fallback: `buildAddSceneControl`'s
// former per-scene mount point inside `buildSceneBodyInto`/
// `buildConnectExistingSceneZone`'s alias button are BOTH REMOVED. A SINGLE
// `[data-testid="plan-add-scene-btn"]` (carrying `data-plan-id="<id>"` when
// an active Plan resolved, no `data-plan-id` attribute in the legacy-
// fallback case) renders ONCE, top-level -- sibling of `scene-chain` (or,
// in the empty-Plan case, the sole content of `plan-empty-state`). Opens
// `[data-testid="plan-add-scene-panel"]`, running the SAME shared
// place-required-flow (session-planner-view.js's `buildPlaceRequiredFlow`,
// UNCHANGED) under prefix `plan-add-scene` (`plan-add-scene-place-step`,
// `plan-add-scene-place-mode-existing-btn`/`-new-btn`, `plan-add-scene-
// place-input`/`-results`/`-option`, `plan-add-scene-new-place-name-input`/
// `-submit-btn`, `plan-add-scene-link-step`/`-yes-btn`/`-no-btn`/
// `-note-input`/`-confirm-btn`, `plan-add-scene-status`). On resolve: the
// EXISTING `POST /api/session-planner/scenes` route creates the scene, THEN
// -- ONLY when there's an active Plan -- the EXISTING `POST /api/scene-
// planning/plans/:planId/scenes` route attaches it (F3's "adding scenes
// attaches them to the active plan"). No new scene-creation mechanism.
//
// Per-scene `[data-testid="scene-actions-bar"][data-scene-id]` is now
// EXACTLY `add-node-toggle, develop-scene-btn, add-event-btn,
// add-encounter-btn` (F6) -- no `add-scene-btn` sibling any more, in EITHER
// the plan-scoped or legacy-fallback rendering.
//
// ===========================================================================
// 1. SCENE DELETE vs. REMOVE-FROM-PLAN (27.1/27.8, F1)
// ===========================================================================
//   - `DELETE /api/session-planner/scenes/:sceneId` (body or query `world`,
//     matching the sibling members/plan-membership DELETE convention) --
//     NEW. `session-planner/scenes.mjs` gains `deleteScene(world, sceneId)`:
//     removes the scene record; iterates `listPlansForWorld` x
//     `removeSceneFromPlan` to strip every plan membership; iterates
//     `getLinkedScenes` x `unlinkScenes` (or an equivalent helper) to strip
//     every scene-link. Does NOT touch the place entity or any graph edge
//     (Decision 2). Response: `200 { deleted: true }` (this suite does not
//     pin a richer shape than that).
//   - Scenes tab (`review-ui/public/scenes-view.js`'s `renderSceneListItem`,
//     confirmed live ~line 190): a new `[data-testid="scene-list-item-
//     delete"][data-scene-id]` button, sibling of `scene-list-item-open`/
//     `scene-list-item-linked-toggle` inside `.scene-list-item-actions`,
//     behind a real confirm step -- `[data-testid="scene-list-item-delete-
//     confirm-btn"][data-scene-id]` / `[data-testid="scene-list-item-
//     delete-cancel-btn"][data-scene-id]` (a `[data-testid="scene-list-
//     item-delete-confirm-panel"][data-scene-id]`, matching this project's
//     established confirm-panel convention, e.g. table-roster-foundry-push-
//     confirm-panel). Confirming calls the DELETE route above and removes
//     the `scene-list-item` from the DOM.
//   - Plan-first construction view (27.4's restructure), per scene: a
//     "remove from plan" action -- `[data-testid="plan-scene-remove-btn"]
//     [data-scene-id]` -- calls the EXISTING (Phase 26, zero new backend)
//     `DELETE /api/scene-planning/plans/:planId/scenes/:sceneId` route
//     (`removeSceneFromPlan`) -- UNLINKS ONLY, the scene record/its
//     memberships in OTHER plans/its scene-links are all untouched. Removing
//     the CURRENTLY-VIEWED scene from the active Plan must not dead-end:
//     falls back to another of the Plan's own remaining scenes (if any) or
//     the empty-Plan `plan-empty-state` screen (if that was the last one).
//
// ===========================================================================
// 2. SCENE-LINK RECORD GAINS graphEdgeId (27.3, F12 backend)
// ===========================================================================
//   `session-planner/scene-links.mjs`'s `linkScenes(world, sceneIdA,
//   sceneIdB, reason?, graphEdgeId?)` -- stores an optional `graphEdgeId` on
//   the record. `getLinkedScenes` returns it alongside each entry
//   (`{sceneId, reason, graphEdgeId}`). `unlinkScenes` returns the REMOVED
//   record (`{removed:boolean, link: {sceneId, linkedSceneId, reason,
//   graphEdgeId} | null}`) so a caller can target the specific edge.
//   Idempotent re-linking updates `graphEdgeId` on the existing record
//   (never duplicates). Routes: `POST /api/scene-planning/scene-links`
//   accepts an optional `graphEdgeId` in the body; `GET .../scene-links`
//   echoes it per entry; `DELETE .../scene-links` echoes the removed
//   record's `graphEdgeId` in its response body (`{removed, link}`).
//
// ===========================================================================
// 3. PLAN-SCOPED LINK/UNLINK + GRAPH PUSH/BREAK (27.5, F4/F12 UI)
// ===========================================================================
//   `buildConnectExistingSceneZone`/`connect-existing-scene-list`/
//   `connect-existing-scene-item`/`create-ad-hoc-scene-btn` are REMOVED
//   ENTIRELY (real DOM-absence, in BOTH the plan-scoped and legacy-fallback
//   render paths) -- replaced by:
//     - `[data-testid="plan-scene-links-list"][data-scene-id]` -- one
//       `[data-testid="plan-scene-link-item"][data-scene-id="<otherId>"]
//       [data-linked="true"|"false"]` per OTHER scene in the CURRENT ACTIVE
//       PLAN (never a graph-adjacency/hop candidate outside the Plan --
//       genuinely distinct from the old mechanism, per F4). Scenes start
//       with `data-linked="false"` (NO auto-surfaced green links, F4's own
//       explicit requirement). In the legacy-fallback case (no active
//       Plan), this list renders with zero items.
//     - `[data-testid="plan-scene-link-toggle-btn"][data-scene-id]
//       [data-linked="true"|"false"]` inside each item -- click opens
//       `[data-testid="plan-scene-link-confirm-panel"][data-scene-id]`:
//       - currently UNLINKED -> "push a graph link to tie the two locations
//         together?" --
//         `[data-testid="plan-scene-link-graph-yes-btn"]` (calls the real
//         `POST /api/graph/edges {world, sourceId:<this scene's own anchor
//         entity id>, targetId:<other scene's own anchor entity id>}`
//         (addEdgeOp) THEN `POST /api/scene-planning/scene-links {world,
//         sceneIdA, sceneIdB, graphEdgeId:<the returned edgeId>}`) /
//         `[data-testid="plan-scene-link-graph-no-btn"]` (calls `POST
//         .../scene-links` with no `graphEdgeId` -- links the scenes
//         without a graph edge, per §26.C/F12: "linked because they're tied
//         together in a plan, regardless of graph adjacency").
//       - currently LINKED -> "break the graph link?" --
//         `[data-testid="plan-scene-link-break-yes-btn"]` (when the stored
//         record carries a `graphEdgeId`: calls the real `DELETE /api/graph/
//         edges/:edgeId` (deleteEdgeOp) THEN `DELETE .../scene-links`; when
//         no `graphEdgeId` was ever stored, this button is simply absent --
//         nothing to break) / `[data-testid="plan-scene-link-break-no-
//         btn"]` (calls `DELETE .../scene-links` only, leaves any graph edge
//         untouched).
//     - `[data-testid="plan-scene-link-status"][data-scene-id]` -- feedback.
//
// ===========================================================================
// 4. ENCOUNTERS BECOME SHARED, MULTI-SCENE DEFINITIONS (27.2/27.6, F11)
// ===========================================================================
//   `combat-planning/saved-encounter.mjs`: encounter records gain
//   `sceneIds: []` (legacy `sceneId` normalizes to `sceneIds:[sceneId]` on
//   read, per schema-versioning discipline). `saveEncounter(world, sceneId,
//   fields)` keeps its signature, creates with `sceneIds:[sceneId]`.
//   `listEncountersForScene` filters by membership. NEW:
//   `attachEncounterToScene(world, encounterId, sceneId)` (idempotent add),
//   `detachEncounterFromScene(world, encounterId, sceneId)` (idempotent
//   remove, does NOT delete the record even if it empties `sceneIds` --
//   orphan semantics, per phase-27-tasks.md 27.2), `listEncountersForWorld
//   (world)` (every definition once).
//   Routes:
//     - `GET /api/scene-planning/encounters?world=` -- NEW, world picker
//       feed, `200 { encounters: [...] }`.
//     - `POST /api/scene-planning/scenes/:sceneId/encounters/:encounterId/
//       attach` -- NEW, `{world}` body, attaches the existing definition.
//     - `DELETE /api/scene-planning/scenes/:sceneId/encounters/:encounterId`
//       -- REDEFINED as detach-from-this-scene (removes ONLY this scene's
//       membership), NOT delete-the-definition -- existing route path,
//       existing test coverage (scene-construction-events-encounters
//       .e2e.mjs) still exercises it, just now proven to be non-destructive
//       to a shared definition (see that file's own updated test).
//   UI (`mountAddEncounterControl`, session-planner-view.js line ~1174,
//   shared by BOTH the construction view's plain `add-encounter-btn` call
//   site and Table Mode's `table-add-encounter-btn` call site -- reworked
//   for both, though this suite only exercises the construction view's own
//   call site, matching phase-27-tasks.md's own F11 scope): clicking
//   `add-encounter-btn` no longer navigates instantly. It opens
//   `[data-testid="add-encounter-panel"][data-scene-id]`:
//     - `[data-testid="add-encounter-picker-list"][data-scene-id]` -- one
//       `[data-testid="add-encounter-picker-item"][data-encounter-id]` per
//       `GET /api/scene-planning/encounters?world=` entry, each with
//       `[data-testid="add-encounter-picker-select-btn"][data-encounter-
//       id]` -- calls the real attach route above, then this scene's own
//       `[data-testid="saved-encounters-list"][data-scene-id]` (task 23.6's
//       EXISTING, unchanged rendering) shows the newly-attached
//       `saved-encounter-item` alongside whatever it already had.
//     - `[data-testid="add-encounter-open-builder-btn"][data-scene-id]` --
//       preserves the OLD instant-navigate behavior exactly
//       (`location.hash = "combat-planning/" + sceneId`), just moved one
//       click deeper (open-the-panel, then this button), per F11's "OR
//       offer a button to open the Encounter Builder."
//     - `[data-testid="add-encounter-picker-status"][data-scene-id]` --
//       feedback.
//   `saved-encounter-remove-btn` (task 23.6's EXISTING control, UNCHANGED
//   testid/DOM position) now calls the REDEFINED DELETE route above, i.e.
//   DETACHES this scene's own membership without deleting a definition
//   still referenced by another scene.
//
// ===========================================================================
// 5. DEVELOP-ONLY-UNDEVELOPED (27.7, F9)
// ===========================================================================
//   `[data-testid="develop-scene-undeveloped-only-toggle"][data-scene-id]`
//   -- a checkbox, sibling of `develop-scene-btn` inside `scene-actions-bar`
//   (or immediately adjacent to it -- this suite only asserts it exists and
//   is checkable, not an exact DOM position beyond "reachable before
//   clicking develop-scene-btn"). Default UNCHECKED (unchanged default
//   behavior: full member set). When CHECKED before `develop-scene-btn` is
//   clicked, `onDevelopScene`'s existing `memberIds` computation (brief
//   locations + added-membership) is filtered client-side to members whose
//   brief `location.contentFlag?.flagged` is true (undeveloped) BEFORE the
//   existing `POST .../develop {world, memberEntityIds}` call -- no
//   engine/route change, `developScene` already accepts any
//   `memberEntityIds` subset.
//
// ===========================================================================
// 6. NAMING FIX (27.9, F2) -- both quick-gen objectiveNote sites
// ===========================================================================
//   Neither surviving scene-creation path may set `objectiveNote` (or
//   `name`) to LLM-generated text. The CONSTRUCTION VIEW's own top-level
//   "+ Quick add scene" (`buildQuickAddScenePanel`, `quick-add-scene-btn`
//   /-panel/-name-input/-submit-btn/-status, the site at the ~1512
//   objectiveNote bug) is RETIRED ENTIRELY by F5/F6 (folded into the single
//   plan-level "+Scene" above) -- so this bug site is moot BY REMOVAL, not
//   by a targeted fix; this suite asserts the removal (§7 below) rather
//   than re-testing a naming fix against a control that no longer exists.
//   Table Mode's OWN, SEPARATE quick-gen (`buildTableQuickGenControl`,
//   `table-quick-gen-btn`/-panel/-name-input/-submit-btn/-status, the site
//   at the ~2980 objectiveNote bug) is UNTOUCHED by F5/F6 (Table Mode's own
//   actions bar isn't in either F5's or F6's scope) and is where this bug
//   must actually be FIXED: the resulting scene's `objectiveNote` must stay
//   null so `resolveSceneDisplayName` falls back to the real place name,
//   never `${name} — ${genRes.text}`.
//
// ===========================================================================
// 7. "+ QUICK ADD SCENE" REMOVED FROM THE CONSTRUCTION VIEW (27.4, F5)
// ===========================================================================
//   `quick-add-scene-btn`/`quick-add-scene-panel`/`quick-add-scene-name-
//   input`/`quick-add-scene-submit-btn`/`quick-add-scene-status` are
//   REMOVED ENTIRELY from the construction view (real DOM-absence, not
//   merely "not tested") -- Table Mode's OWN, unrelated `table-quick-gen-*`
//   control (a different control, always was) is UNTOUCHED.
//
// ---------------------------------------------------------------------------
// Fixture/isolation conventions -- mirrors phase26-fixture.mjs/scene-
// construction-fixture.mjs exactly: real in-process createReviewServer
// ({port:0}), real fixture seeding via the actual store/API functions
// (bootstrapSnapshot + applyHeadless for graph entities/edges, the real
// POST /api/session-planner/scenes route for scenes, the real Plan/scene-
// link/saved-encounter routes for THEIR OWN stores -- never hand-
// constructed fixture JSON). setupPhase27Env is setupPhase26Env verbatim --
// no NEW store directory is needed: deleteScene/graphEdgeId/shared-
// encounters are all additive shape changes to EXISTING stores
// (session-scenes/, session-plans/, scene-links/, saved-encounters/), not
// new ones.
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import {
  setupPhase26Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  linkScenesViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
} from "./phase26-fixture.mjs";

export const setupPhase27Env = setupPhase26Env;

/** Real DELETE /api/session-planner/scenes/:sceneId round trip. */
export async function deleteSceneViaRoute(base, world, sceneId) {
  const res = await fetch(`${base}/api/session-planner/scenes/${encodeURIComponent(sceneId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** Real POST /api/scene-planning/scenes/:sceneId/encounters round trip (saves a snapshot attached to the ORIGIN scene). */
export async function saveEncounterViaRoute(base, world, sceneId, fields) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/encounters`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, ...fields })
  });
  const body = await res.json();
  assert.equal(res.status, 200, `saved-encounter setup itself must succeed -- broken test setup, not the thing under test (got ${res.status}: ${JSON.stringify(body)})`);
  return body.encounter;
}

/** Real GET /api/scene-planning/scenes/:sceneId/encounters round trip. */
export async function listEncountersForSceneViaRoute(base, world, sceneId) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/encounters?world=${encodeURIComponent(world)}`);
  const body = await res.json();
  return body.encounters ?? [];
}

export {
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  linkScenesViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
};
