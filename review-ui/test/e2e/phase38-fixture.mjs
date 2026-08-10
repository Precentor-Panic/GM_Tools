// Phase 38 task 38.0 -- shared setup + THE FULL CONTRACT for the Phase 38
// "content pipeline II + navigation" e2e suite (phase38-pull-extension.e2e.mjs,
// phase38-import-on-accept.e2e.mjs, phase38-plan-delete.e2e.mjs,
// phase38-loyalty.e2e.mjs). NOT itself an *.e2e.mjs file (the `npm run
// test:e2e` glob is test/e2e/*.e2e.mjs), same exemption as fixture.mjs/
// phase3N-fixture.mjs -- every phase38 *.e2e.mjs file imports what it needs
// from here rather than each re-deriving the shared contract independently.
//
// THIS IS THE WRITTEN CONTRACT tasks 38.1 (foundry_worldFabric module wave),
// 38.2 (GM_Tools content plumbing) and 38.3 (plan-delete + Loyalty tree)
// implement TO. Grounded in, in order: plans/phase-38-tasks.md (the "Settled
// decisions" + "Grounding facts" sections, binding), .claude/plans/
// ok-i-m-back-with-dazzling-newt.md's Phase 38 section, plans/
// phase-32-bridge-contract.md (v3, amended alongside this file -- the WIRE
// FORMAT this file's pull-mapper/import-op contract targets), the real
// installed Foundry v14 client source (`/opt/dev/foundryvtt/client`,
// read directly for the compendium-import idiom -- see the contract's own
// §2 "import_compendium_scene" section), wf-mcp-server/lib/
// foundry-pull-ops.mjs (upsertStagecraftMap/upsertItem -- the three-way
// dedup branch every new upsert below mirrors), wf-mcp-server/lib/
// foundry-push-ops.mjs + foundry-ops.mjs (the ops-channel writer/poll +
// scenes.mjs's pendingPush/reconcilePendingResults -- the "pending/reconcile
// machinery" this file's import-on-accept flow reuses the SHAPE of, not the
// code, since the target store is stagecraft-store.mjs, not scenes.mjs),
// wf-mcp-server/lib/manual-edit-ops.mjs's reparentNode (the shape
// anchorMembership mirrors -- reparentNode itself is NEVER modified),
// review-ui/public/world-view.js (buildDerived, wv-tree-head, the drag/
// reparent wiring), review-ui/public/app-shell.js (fillRailScenes /
// toggleSceneDeleteConfirm -- the pattern fillRailPlans' new ✕ mirrors),
// review-ui/public/session-planner-view.js's buildSegmentedControl (the
// Prep|Run segmented-toggle idiom the Spatial|Loyalty toggle mirrors), and
// review-ui/test/e2e/scene-delete.e2e.mjs + phase30-world-surface.e2e.mjs +
// phase31-interactions.e2e.mjs (the precedents this suite's own tests mirror
// / must not disturb).
//
// Every route/DOM contract below is confirmed NOT to exist yet against the
// real, current foundry-pull-ops.mjs/stagecraft-store.mjs/item-store.mjs/
// world-view.js/app-shell.js/manual-edit-ops.mjs/server.mjs trees
// (re-verified by direct read AND grep before writing this file):
// `worldItems`/`compendia` appear nowhere in foundry-index.mjs's schema or
// foundry-pull-ops.mjs's composition; `compendiumRef`/`pendingImport` appear
// nowhere in stagecraft-store.mjs; `import_compendium_scene` appears nowhere
// in foundry-ops.mjs/foundry-push-ops.mjs; `shell-plan-item-delete-btn`
// appears nowhere in app-shell.js (fillRailPlans has no delete affordance at
// all today); `anchor-membership`/`anchorMembership` appear nowhere in
// manual-edit-ops.mjs or server.mjs's route table; `wv-tree-mode-toggle`
// appears nowhere in world-view.js, and `buildDerived` hardcodes
// `relationshipType === "containment"` in exactly one place (confirmed at
// world-view.js:160, per the task plan's own citation). Every phase38
// *.e2e.mjs UI-level scenario below is therefore EXPECTED TO FAIL right now
// with a Playwright selector-not-found/timeout error, and every route-level
// scenario is EXPECTED TO FAIL with a real HTTP 404 (or a clean assertion
// failure against the REAL, already-shipped route's current pre-38.2/38.3
// behavior). That failure is the deliverable of task 38.0, not a bug in
// these files. Two scenarios are DELIBERATE GREEN PINS, called out by name
// in each test file: the plan-delete route-level test (the DELETE route
// already exists, per the task plan's own grounding) and the Spatial-tree/
// containment-reparent guard test (protecting phase30/31 behavior).
//
// ===========================================================================
// §1. Index additions (plans/phase-32-bridge-contract.md v3 §1.6/§1.7)
// ===========================================================================
// `worldItems: Item[]` (§1.6, SAME per-item shape as an embedded
// `actors[].items[]` entry -- `{uuid, name, type, img, system}`) and
// `compendia: CompendiumPackInfo[]` (§1.7, `{packId, label, documentType,
// count, entries?}`, `entries:[{id,name,thumb}]` present ONLY for
// `documentType === "Scene"` packs) join the top-level index, both
// additive-optional. See the bridge contract itself for the full field
// docs -- not duplicated here, per that file's own "wire format lives
// there" scoping rule. This file's `writeFoundryIndexV3Fixture` below
// builds a minimal, hand-authored index carrying both new keys.
//
// ===========================================================================
// §2. Pull-mapper pin: worldItems[] -> Reliquary (combat-planning/item-store.mjs)
// ===========================================================================
// New composition in wf-mcp-server/lib/foundry-pull-ops.mjs's
// pullFoundryActorsToStores: after the existing actors[]/scenes[] loops, a
// THIRD loop over `index.worldItems[]`, one ItemRecord candidate per entry:
//
//   { name, type, quantity, description, foundryItemRef: worldItem.uuid,
//     ownerFoundryActorUuid: null, ownerPartyMemberId: null,
//     sourceText: "Pulled from Foundry world items.", status:"proposed" }
//
// name/type/quantity/description derive via the SAME per-item field
// extraction `combat-planning/foundry-actor-mapper.mjs`'s
// `mapActorItemsToInventory` already uses internally for an actor's embedded
// items -- **RESOLVED AMBIGUITY, flagged explicitly**: `mapActorItemsToInventory`
// also EXCLUDES `NON_INVENTORY_ITEM_TYPES` ("class"/"weapon"/"feat"/"spell"/
// "race"/"background") because those types already feed a PC's own
// combat-relevant stat block via a SIBLING mapper (`mapActorToPartyMember`),
// so re-surfacing them as Reliquary rows would duplicate that data. A LOOSE
// world item has no such sibling mapper and no such duplication risk (a
// standalone Plutonium-imported spell/weapon/feat sitting in `game.items`
// is exactly the kind of row Russell's "expand the Reliquary dramatically"
// ask wants to see) -- so 38.2 must extract the per-item FIELD DERIVATION
// (name/type/quantity/description/foundryItemRef) out of
// `mapActorItemsToInventory` into a small shared single-item pure function
// (e.g. `mapItemToInventoryFields(item)`), have `mapActorItemsToInventory`
// call it (byte-identical behavior, non-breaking refactor -- the existing
// type filter stays where it is, on the actor-items caller), and have the
// NEW worldItems mapper call the SAME shared function UNFILTERED (every
// worldItems[] entry becomes a candidate, no type exclusion). This is a
// deliberate resolution of an ambiguity the task's own prose left open
// ("reuse extractItem shape" only pins the INDEX shape, not the
// Reliquary-mapper's filtering rule) -- flagged here and in 38.0's own
// completion report, not silently guessed.
//
// Dedup/upsert: SAME three-way branch as `upsertItem`/`upsertBestiary`
// (foundry-pull-ops.mjs), keyed on `foundryItemRef` -- a world item and an
// actor-embedded item can never collide on this key (Foundry's own uuids are
// globally unique per document), so ONE `listItems(world)` scan covers both
// sources with no special-casing needed in the dedup logic itself, only in
// which loop produces the candidate.
//
// ===========================================================================
// §3. Pull-mapper pin: compendia[] Scene entries -> Stagecraft browse rows
// ===========================================================================
// New composition, ALSO in foundry-pull-ops.mjs: for every `pack` in
// `index.compendia` where `pack.documentType === "Scene"`, for every `entry`
// in `pack.entries`, one StagecraftAsset candidate:
//
//   { kind: "map", name: entry.name, source: "foundry",
//     meta: "in compendium — import to stage", desc: null, tags: [],
//     compendiumRef: { packId: pack.packId, entryId: entry.id },
//     foundryRef: null, status: "proposed" }
//
// `compendiumRef` is a NEW, ADDITIVE-ONLY field on StagecraftAsset (default
// `null`) -- present ONLY on a not-yet-imported compendium browse row (a
// hand-added or Foundry-`scenes[]`-pulled map asset has `compendiumRef:
// null`, unchanged). `kind:"map"` deliberately reuses the EXISTING map shelf
// (not a new `kind`) so a browse row renders through the SAME Stagecraft
// component as every other map asset, per the README's "implement once"
// discipline -- the meta string ("in compendium — import to stage") is what
// tells them apart visually, not a separate kind/section.
//
// Dedup/upsert: a NEW three-way branch (mirrors `upsertStagecraftMap`'s
// shape exactly, one level over) keyed on `compendiumRef.packId +
// compendiumRef.entryId` instead of `foundryRef.sceneUuid`:
//   - an ACCEPTED match (this row has already been imported, or a human
//     accepted it before import for some other reason) is LEFT UNTOUCHED,
//     same as `upsertStagecraftMap`'s own accepted-match branch -- "normal
//     accepted-map behavior" (see §4 below) means an imported row, from the
//     moment its `foundryRef.sceneUuid` is set, is indistinguishable from
//     any other accepted Foundry map asset: future pulls (whether via THIS
//     compendiumRef-keyed branch OR via the EXISTING sceneUuid-keyed
//     `upsertStagecraftMap` branch matching the newly-created world scene)
//     both find the SAME accepted record and both leave it untouched. This
//     is what makes "an imported entry's browse row and its resulting
//     world-scene row must NOT duplicate" hold structurally, with ZERO new
//     dedup logic beyond "both branches converge on one record because
//     compendiumRef and foundryRef.sceneUuid live on the SAME row after
//     import" -- not two rows reconciled after the fact.
//   - a still-PROPOSED match is updated in place (name/meta refresh, same
//     as `updateStagecraftAssetFields`'s existing re-ingest convention).
//   - otherwise, a brand-new proposed browse row is created.
// A non-Scene pack (§1's `entries` genuinely absent) contributes NOTHING to
// Stagecraft this phase -- browsable entries are a Scene-only concept per
// the bridge contract's own §1.7 reasoning.
//
// ===========================================================================
// §4. Import-on-accept: POST /api/session-planner/stagecraft/:id/accept (EXTENDED)
// ===========================================================================
// The EXISTING route (server.mjs, Phase 35/36) is extended, not forked: when
// the target asset has a non-null `compendiumRef` AND no `foundryRef?.sceneUuid`
// yet, accept is NO LONGER a synchronous status flip -- it composes
// `import_compendium_scene {packId, entryId}` (bridge contract v3 §2) onto
// the SAME ops channel `wf-mcp-server/lib/foundry-ops.mjs`'s `writeFoundryOps`
// already writes/polls (the exact "asynchronous like a staged push" shape
// `pushSceneToFoundry`/`flushDirtyStagedScenes` already establish, reused
// here for a SECOND kind of op against the SAME transport):
//
//   applied, ok:true  -> asset.foundryRef = {sceneUuid: result.foundryUuid},
//                        asset.status = "accepted", asset.pendingImport = null.
//                        Response 200: {status:'applied', ok:true, asset}
//   applied, ok:false -> asset UNCHANGED (stays 'proposed', compendiumRef
//                        intact, retryable). Response 200:
//                        {status:'applied', ok:false, error, asset}
//   queued (no live Foundry client picked the batch up within the poll
//   window) -> asset stays 'proposed'; a NEW `pendingImport: {opId,
//                        requestedAt}` field (additive, default `null`,
//                        mirrors `session-planner/scenes.mjs`'s own
//                        `pendingPush` ledger shape one store over) is set.
//                        Response 200: {status:'queued', assetId, opId,
//                        note, asset}
//
// A NON-compendiumRef accept (every existing caller -- a hand-added asset, a
// Foundry-`scenes[]`-pulled map, a re-accept of an already-imported row)
// takes the EXACT SAME PATH AS TODAY, byte-identical response shape `{asset}`
// -- this is a hard backward-compatibility pin, not just an intention: an
// e2e test in phase38-import-on-accept.e2e.mjs seeds an ordinary
// `compendiumRef:null` proposed asset and asserts the response is STILL
// exactly `{asset}` with no `status`/`ok` keys, so a careless "extend accept"
// implementation that always wraps the response can't silently regress every
// other Stagecraft/Reliquary accept caller.
//
// Reconciliation (the "reuse the 36.3 pending/reconcile machinery" instruction):
// a NEW `reconcilePendingCompendiumImports(dataDir, world)` in a stagecraft-
// import-ops module (mirrors `foundry-push-ops.mjs`'s `reconcilePendingResults`
// shape exactly, one store over -- scans stagecraft assets with a set
// `pendingImport.opId`, checks `world-fabric-foundry-results.json` for a
// matching `opId`, on `ok:true` sets `foundryRef`+`status:'accepted'`+clears
// `pendingImport`, on `ok:false` clears `pendingImport` only (stays
// 'proposed', retryable), consumes matched entries from the results file the
// same "remove only what I recognize" way §3's contract already documents).
// 38.0 pins the function's NAME/SHAPE/SEMANTICS; 38.2 decides the exact call
// site(s) (a natural choice: the SAME places `reconcilePendingResults` is
// already invoked, i.e. at the top of the next pull/accept/sync-now call for
// that world) -- at minimum, a stale `pendingImport` must never permanently
// block a retry (a later accept attempt on a still-proposed, still-pending
// row must re-check reconciliation, not throw/no-op forever).
//
// "next pull refreshes imagePath/dims" (task-plan prose) resolves to: once
// imported, the row is an ORDINARY accepted Foundry map asset with no
// special-casing at all -- §3's own accepted-match branch (in EITHER the
// compendiumRef-keyed or sceneUuid-keyed dedup path) leaves an accepted
// asset untouched, matching `upsertStagecraftMap`'s existing, unmodified
// convention. There is no bespoke "refresh accepted rows" behavior this task
// adds; an accepted row only ever changes via an explicit human action
// (edit/discard), same as every other accepted content record in this
// project.
//
// ===========================================================================
// §5. Plan-delete rail ✕ contract (app-shell.js's fillRailPlans)
// ===========================================================================
// Mirrors `fillRailScenes`/`toggleSceneDeleteConfirm` (app-shell.js:320-432)
// testid-for-testid, `shell-scene-library-item*` -> `shell-plan-item*`:
//
//   [data-testid="shell-plan-item-row"]                          -- wraps
//     name/meta + the new ✕ (mirrors `shell-scene-library-item-row`; the
//     EXISTING `shell-plan-item`/`shell-plan-item-name`/
//     `shell-plan-item-meta` testids are UNCHANGED, just now living inside
//     this row wrapper instead of directly under `shell-plan-item`).
//   [data-testid="shell-plan-item-delete-btn"][data-plan-id]      -- the ✕,
//     `e.stopPropagation()`'d exactly like the scene ✕ (a click must NOT
//     also fire the row's own `goto("planner/plan/<id>")` navigation).
//   [data-testid="shell-plan-item-delete-confirm-panel"][data-plan-id]
//   [data-testid="shell-plan-item-delete-confirm-btn"]
//   [data-testid="shell-plan-item-delete-cancel-btn"]
//   Copy: "Delete this plan entirely? It will be removed from the run list
//   — its scenes are untouched and stay in the Scene library." (mirrors the
//   EXISTING runsheet's own delete-confirm copy verbatim,
//   session-planner-view.js:699's `confirmDeletePlan`: "Delete this plan?
//   Its scenes are untouched and stay in the Scene library.")
//
// Backend: ZERO changes needed -- `deletePlan` (session-planner/plans.mjs:212)
// and `DELETE /api/scene-planning/plans/:planId` (server.mjs:2367-ish,
// already idempotent) are REAL, SHIPPED, working routes today. This is a
// pure UI-wiring task; the route-level scenes-survive/idempotency test in
// phase38-plan-delete.e2e.mjs is therefore a DELIBERATE GREEN PIN (see that
// file's own header), not a red-for-a-reason assertion -- it protects the
// existing backend contract while 38.3 builds the missing UI on top of it,
// reusing `deletePlanViaRoute` (phase28-fixture.mjs, already built for
// Phase 28's own route-level coverage) rather than inventing a second helper.
//
// ===========================================================================
// §6. Loyalty contract (world-view.js)
// ===========================================================================
// §6a. Segmented toggle, mounted into `.wv-tree-head` (alongside the
// existing "Where things are" label + expand/collapse toggle), mirroring
// `session-planner-view.js`'s `buildSegmentedControl` idiom LOCALLY (a
// mirrored copy in world-view.js, per the task plan's own "lift or mirror
// locally" instruction -- world-view.js has no existing import from
// session-planner-view.js and this project's convention is to avoid a new
// cross-view dependency for one small shared widget):
//
//   [data-testid="wv-tree-mode-toggle"]                       -- group wrapper
//   [data-testid="wv-tree-mode-spatial-btn"]  aria-pressed     -- default TRUE
//   [data-testid="wv-tree-mode-loyalty-btn"]  aria-pressed     -- default FALSE
//   [data-testid="world-tree"][data-tree-mode="spatial"|"loyalty"]   -- the
//     tree container itself carries the active mode as a data attribute, so
//     a test can assert which derivation is currently rendering without
//     depending on button aria-pressed alone.
//
// Mode is view-local UI state (like `ui.expanded`/`ui.query`), reset to
// "spatial" on `resetForWorld` (a world switch never carries Loyalty mode
// over) -- SPATIAL IS THE DEFAULT, every session lands on the existing,
// phase30/31/33-pinned containment tree unless the GM explicitly switches.
//
// §6b. Derived-tree parameterization: `buildDerived(graph)` is generalized
// to `buildDerived(graph, isParentEdge)` where `isParentEdge` defaults to
// `(e) => e.relationshipType === "containment"` (BYTE-IDENTICAL default
// behavior -- every existing call site that doesn't pass a second arg is
// unaffected, which is what makes the Spatial-tree guard test in
// phase38-loyalty.e2e.mjs a legitimate regression pin). The Loyalty
// predicate: `(e) => e.relationshipType === "membership" || e.relationshipType
// === "fealty"`.
//
// SINGLE-PARENT MOST-RECENT-WINS: unlike containment (where `reparentNode`
// already enforces at most one containment edge per child, so `buildDerived`
// never has to arbitrate), a node MAY carry more than one qualifying
// membership/fealty edge today (free-string vocab, hand-authored via
// writeup-import or older data) -- `buildDerived` must pick exactly ONE
// winner per child when building `parentOf`, not silently overwrite-by-array-
// order the way a plain `Map#set` loop would (that would be array-order-wins,
// not RECENCY-wins, coincidentally correct only when array order already
// reflects recency). The winner is the qualifying edge with the greatest
// `edge.updatedAt ?? edge.createdAt` (ISO-string comparison); if two or more
// tie (including "all null/absent" -- common in a headlessly-authored
// fixture with no real timestamps), the LAST one encountered in `graph.edges`
// wins (array order is itself a legitimate recency proxy -- the graph
// snapshot's edges array reflects write/upsert order). A node with only
// non-qualifying edges, or none, is a Loyalty ROOT (`parentIdOf(id) ===
// null`), rendered exactly like a Spatial root today (top-level tree row) --
// this covers "no loyalty parent = root" for the common case AND for a
// `faction`-typed node with no fealty/membership edge pointing OUT of it
// (a faction can still be a Loyalty CHILD of another faction/person via its
// own outgoing membership/fealty edge; it is a root only when it has none).
//
// `looseReasons`/loose-threads stay CONTAINMENT-based unconditionally (per
// the task plan's own explicit instruction) -- Loyalty mode reuses the same
// tree-rendering scaffold but does NOT swap the loose-threads panel's own
// predicate.
//
// §6c. Drag semantics: in Loyalty mode, dropping tree row A onto tree row B
// calls the NEW route (§6d) instead of the EXISTING `.../reparent` -- the
// SAME `wireReparentTarget`/`startDrag`/`dragId` plumbing, branching on the
// current UI mode at drop time (not two separate drag implementations). In
// Spatial mode (the default, and the ONLY mode that exists until 38.3
// lands), drag behavior is COMPLETELY UNCHANGED -- calls `.../reparent`
// exactly as today. Undo-toast copy family for a Loyalty re-anchor: `“<name>”
// now serves “<parent>”` (mirrors the existing containment toast's `“<name>”
// is now inside “<parent>”` structure, per the task plan's own "now serves
// X" instruction), with the SAME undo-restores-prior-parent mechanism.
//
// §6d. NEW op: `anchorMembership` (wf-mcp-server/lib/manual-edit-ops.mjs) +
// route `POST /api/graph/nodes/:entityId/anchor-membership {world, parentId}`.
// MIRRORS `reparentNode`'s shape exactly, type swapped:
//   - removes EVERY existing edge where `entityId` is `sourceId` AND
//     `relationshipType` is `"membership"` OR `"fealty"` (BOTH types, not
//     just membership -- collapsing any pre-existing multi-loyalty history
//     into the one new edge below is the point of this op).
//   - unless `parentId` is `null` (unparent-only, same as reparentNode),
//     adds exactly ONE new edge `{sourceId: entityId, targetId: parentId,
//     relationshipType: "membership"}` (ALWAYS `"membership"`, never
//     `"fealty"` -- per the task plan's own locked decision, "drag creates a
//     `membership` edge"; a `fealty` edge is a distinct, hand-authored
//     relationship this op never creates, only ever removes as part of the
//     "existing loyalty parent" cleanup).
//   - CYCLE GUARD: identical structure to `reparentNode`'s, walking the
//     LOYALTY parent chain (membership/fealty edges only, via the SAME
//     recency-tie-break as §6b when a still-uncollapsed node has more than
//     one) upward from `parentId`; if `entityId` itself is reached, refuse
//     (would create a Loyalty cycle).
//   - ATOMIC UNDO: one `applyManualMutations` call (every removed edge
//     re-created + the new edge deleted, EXACT mirror of `reparentNode`'s
//     own undo-inverse construction), one undo slot.
//   - `reparentNode` ITSELF IS NEVER MODIFIED -- `anchorMembership` is a
//     genuinely separate, sibling function/route, per the task plan's own
//     explicit "reparentNode untouched" instruction (this is re-asserted by
//     a dedicated unit-style route test: after an `anchorMembership` call,
//     `reparentNode`'s own OWN Spatial/containment behavior is unaffected --
//     see phase38-loyalty.e2e.mjs's guard test).
//   - Response shape: `{entityId, parentId, removedEdgeCount, edgeId}`,
//     IDENTICAL field names to `reparentNode`'s own response (deliberate,
//     so 38.3's UI-side toast/reload logic can share code between the two
//     call sites almost verbatim).
//
// ===========================================================================
// §7. Mock fixture index (§1's worldItems + Scene/non-Scene compendia)
// ===========================================================================
// `writeFoundryIndexV3Fixture` below -- a direct fs write (there is no real
// route that produces this file; same "plays the role of the Foundry-side
// module's own export" exemption `writeFoundryIndexFixture` (phase35-fixture.mjs)
// already established). Deliberately MINIMAL (no actors/scenes -- §1's two
// new top-level keys are independent of the existing actors/scenes/users/
// tokens/playlists arrays, and this suite's assertions only need the new
// keys) rather than reusing phase35's large actor-heavy index.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  setupPhase36Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  fetchGraphViaRoute,
  primeWorldSelection,
  reparentNodeViaRoute,
  pullActorsViaRoute,
  listStagecraftViaRoute,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
} from "./phase36-fixture.mjs";
import { deletePlanViaRoute } from "./phase28-fixture.mjs";
import { listItemsViaRoute } from "./phase35-fixture.mjs";

/** setupPhase36Env() verbatim -- no new store directory this phase (§ header note above: compendiumRef/pendingImport are additive fields on the EXISTING stagecraft store, not a new store). */
export const setupPhase38Env = setupPhase36Env;

export {
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  fetchGraphViaRoute,
  primeWorldSelection,
  reparentNodeViaRoute,
  pullActorsViaRoute,
  listStagecraftViaRoute,
  listItemsViaRoute,
  deletePlanViaRoute,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
};

// ---------------------------------------------------------------------------
// §7's mock index -- worldItems[] (two loose world items, one clearly
// inventory-shaped "potion", one of a type mapActorItemsToInventory's
// existing filter WOULD exclude on an actor -- "Longsword", type "weapon" --
// deliberately included to exercise §2's "no type filter for worldItems"
// resolution) + compendia[] (one Scene pack with 3 entries carrying
// name+thumb, one non-Scene Item pack with headers only, no `entries` key
// at all).
// ---------------------------------------------------------------------------
export function writeFoundryIndexV3Fixture(dataDir, world, overrides = {}) {
  const index = {
    version: 1,
    worldId: world,
    exportedAt: "2026-08-10T12:00:00.000Z",
    actors: [],
    users: [],
    scenes: [],
    tokens: [],
    playlists: [],
    worldItems: [
      {
        uuid: "Item.worldPotion",
        name: "Potion of Fire Breath",
        type: "consumable",
        img: "icons/consumables/potions/potion-bottle-corked-orange.webp",
        system: { quantity: 4, description: { value: "<p>Breathe fire for 1 minute.</p>" } }
      },
      {
        uuid: "Item.worldLongsword",
        name: "Longsword +1",
        type: "weapon",
        img: "icons/weapons/swords/sword-broad-silver.webp",
        system: { quantity: 1, description: { value: "<p>A finely balanced blade.</p>" } }
      }
    ],
    compendia: [
      {
        packId: "czepeku-taverns.scenes",
        label: "Czepeku Taverns — Scenes",
        documentType: "Scene",
        count: 3,
        entries: [
          { id: "scnEntryTavernA", name: "The Drowned Anchor", thumb: "modules/czepeku-taverns/thumbs/tavern-a.webp" },
          { id: "scnEntryTavernB", name: "The Gilded Cask", thumb: "modules/czepeku-taverns/thumbs/tavern-b.webp" },
          { id: "scnEntryTavernC", name: "The Salt & Smoke", thumb: null }
        ]
      },
      {
        packId: "plutonium-next.items",
        label: "Plutonium — Items",
        documentType: "Item",
        count: 5417
        // no `entries` key -- non-Scene pack, headers only (§1.7).
      }
    ],
    ...overrides
  };
  const dir = join(dataDir, "worlds", world);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "world-fabric-foundry-index.json"), JSON.stringify(index, null, 2), "utf8");
  return index;
}

// ---------------------------------------------------------------------------
// Route helpers, net-new this phase (non-asserting on status -- a non-200/404
// here IS the expected "red for the right reason" signal, per every prior
// phase-fixture's own under-construction convention; callers assert on the
// returned {status, body} themselves).
// ---------------------------------------------------------------------------

/** POST /api/session-planner/stagecraft/:id/accept {world} -- EXISTING route (200 today), extended-in-place per §4. */
export async function acceptStagecraftAssetViaRoute(base, world, assetId) {
  const res = await fetch(`${base}/api/session-planner/stagecraft/${encodeURIComponent(assetId)}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** POST /api/graph/nodes/:entityId/anchor-membership {world, parentId} -- 404 until 38.3 (§6d). */
export async function anchorMembershipViaRoute(base, world, entityId, parentId) {
  const res = await fetch(`${base}/api/graph/nodes/${encodeURIComponent(entityId)}/anchor-membership`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, parentId })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Direct-fs seed helper for a compendiumRef browse row (§3) -- there is no
// real producer for `compendiumRef`/`pendingImport` until 38.2 extends
// foundry-pull-ops.mjs/stagecraft-store.mjs, mirroring phase36-fixture.mjs's
// own `seedSceneStaged` "the ONE deliberate raw-fs exception" precedent
// exactly: a normal StagecraftAsset is first seeded via the REAL
// `saveStagecraftAsset` store function, then this helper patches ONLY the
// new fields onto its existing on-disk record.
// ---------------------------------------------------------------------------
export async function seedCompendiumBrowseRow(world, { name, packId, entryId, status = "proposed" } = {}) {
  const { saveStagecraftAsset, stagecraftRoot } = await import("../../../session-planner/stagecraft-store.mjs");
  const asset = saveStagecraftAsset(world, {
    kind: "map",
    name,
    source: "foundry",
    meta: "in compendium — import to stage",
    foundryRef: null,
    status
  });
  const path = join(stagecraftRoot(), `${world}.json`);
  const assets = JSON.parse(readFileSync(path, "utf8"));
  const rec = assets.find((a) => a.id === asset.id);
  rec.compendiumRef = { packId, entryId };
  rec.pendingImport = null;
  writeFileSync(path, JSON.stringify(assets, null, 2), "utf8");
  return rec;
}

/** @returns {object[]} the parsed foundry-ops array, or [] -- mirrors phase36-fixture.mjs's readFoundryOpsFileSync exactly, duplicated here (small, pure, no cross-file coupling) rather than importing a THIRD chain hop for one helper. */
export function readFoundryOpsFileSync(dataDir, world) {
  const path = join(dataDir, "worlds", world, "world-fabric-foundry-ops.json");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

/** Arms a one-shot fake Foundry-side watcher for an import_compendium_scene op -- mirrors phase36-fixture.mjs's armFakeFoundryWatcher exactly (duplicated for the same reason as readFoundryOpsFileSync above). */
export function armFakeFoundryWatcher(dataDir, world, results, delayMs = 25) {
  const opsPath = join(dataDir, "worlds", world, "world-fabric-foundry-ops.json");
  const resultsPath = join(dataDir, "worlds", world, "world-fabric-foundry-results.json");
  return setTimeout(() => {
    writeFileSync(resultsPath, JSON.stringify(results), "utf8");
    writeFileSync(opsPath, "[]", "utf8");
  }, delayMs);
}
