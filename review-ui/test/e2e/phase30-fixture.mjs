// Phase 30 task 30.0 -- shared setup + THE FULL DOM/ROUTE CONTRACT for the
// Phase 30 shell/rebuild e2e suite (phase30-shell.e2e.mjs,
// phase30-planner-surface.e2e.mjs, phase30-world-surface.e2e.mjs). NOT
// itself an *.e2e.mjs file (the `npm run test:e2e` glob is
// test/e2e/*.e2e.mjs), same exemption as fixture.mjs/phase26-28-29-
// fixture.mjs -- every Phase 30 *.e2e.mjs file imports what it needs from
// here rather than each re-deriving the shared contract independently.
//
// THIS IS THE INTERFACE SPEC tasks 30.2-30.4 implement to match. Grounded in
// plans/phase-30-structure.md (read that FIRST -- file layout, hash scheme,
// sequencing) and the design record (.claude/plans/
// ok-i-m-back-with-dazzling-newt.md) + design/session-planner/*.dc.html +
// README.md. Every route/DOM contract below is confirmed NOT to exist yet
// against the real, current index.html/app.js/session-planner-view.js/
// plans-view.js/server.mjs (re-verified by actually running this suite, not
// just reading source) -- every phase30 *.e2e.mjs UI-level scenario is
// EXPECTED TO FAIL right now with a Playwright selector-not-found/timeout
// error: no `#app-shell`/`[data-testid="app-shell"]` exists anywhere in
// index.html; `#planner`/`#world` match no branch in app.js's
// renderCurrentView, so nothing new ever renders. That failure is the
// deliverable of task 30.0, not a bug in these files. (The two World-backend
// routes this task expected to still be missing -- `scenesForEntity`/
// `reparentNode` -- landed CONCURRENTLY with this task, in this same working
// tree, confirmed by direct run; see Decision 7 below for the real shipped
// contract this file was corrected to match.)
//
// ===========================================================================
// DESIGN DECISIONS THIS SUITE LOCKS IN (30.0's own judgment calls -- the
// design record deliberately leaves exact route/testid shapes to the QE
// pass; documented here so 30.2-30.4's implementers match ONE contract):
// ===========================================================================
//
// 1. HASH SCHEME: `#planner/plans` | `#planner/plan/<planId>` |
//    `#planner/scene/<sceneId>` | `#world` | `#world/<entityId>`. The OLD
//    `#plans`/`#plans/<planId>`/`#session-planner/<sceneId>` hashes are
//    DELIBERATELY DISTINCT from the new ones -- they keep resolving to the
//    Phase 28/29 legacy DOM (shelved, off-nav, no rail chrome) until 30.3
//    actually retires that DOM. This suite never asserts anything about the
//    OLD hashes -- see phase-30-structure.md §2 for the full rationale.
//
// 2. ONE ROUTER: the shell is a NEW BRANCH inside app.js's existing
//    `renderCurrentView`/single `hashchange` listener (`app-shell.js`
//    exports a `renderShell(view, arg)` this file's branch calls), NOT a
//    second parallel router -- this is what keeps the 4 existing nav-cancel
//    hooks (`cancelActiveScan`/`flushActiveNoteSave`/`cancelActiveAssist`/
//    `cancelActiveCombatPlanningRequest`) firing on every shell navigation
//    for free. This suite does not re-test the cancel hooks directly (no
//    NEW interruptible affordance is introduced by 30.0's own contract --
//    that's 30.3's concern if it adds one), but DOES assert the visibility
//    switch: `[data-testid="app-shell"]` visible + legacy `header.topbar`/
//    `main` hidden while on a `#planner`/`#world` hash, and the reverse for
//    any legacy hash (`#queue`).
//
// 3. WORLD CONTRACT: `app-shell.js` reads/writes the EXACT SAME
//    `localStorage["gmReview.world"]` key every existing view module reads
//    -- `[data-testid="shell-world-select"]` is the shell's own `<select>`
//    (a NEW element, not a re-parented copy of the legacy `#world-select`),
//    but changing it must write the same key and re-render the current
//    shell view. This suite primes the world the SAME way every prior
//    e2e suite does (`primeWorldSelection`, a real page load + a direct
//    localStorage write) rather than driving the shell's own select for
//    every test -- one dedicated test below exercises the select itself.
//
// 4. SURFACE TOGGLE: clicking `shell-surface-toggle-planner` ALWAYS
//    navigates to `#planner/plans` (never a remembered last-visited planner
//    sub-route -- kept deliberately simple, a judgment call flagged here so
//    30.2 doesn't over-build); clicking `shell-surface-toggle-world` ALWAYS
//    navigates to bare `#world` (no node preselected).
//
// 5. ADD-TO-PLAN TARGET: the scene-library `+` button's "currently open
//    plan" is READ FROM THE BREADCRUMB, not a separate piece of state --
//    active (calls the real route) only when `[data-testid=
//    "shell-breadcrumb-plan"][data-plan-id]` is present in the DOM (i.e. the
//    main column is showing that plan's runsheet OR a scene reached from
//    within it). On the bare plans shelf (`#planner/plans`, no breadcrumb
//    plan segment), clicking `+` must NOT call any route -- it shows
//    `[data-testid="shell-add-to-plan-no-target-notice"]` instead. This
//    keeps "add to the open plan" well-defined without inventing a second,
//    independent "which plan is open" tracking mechanism.
//
// 6. DEDUPE + UNDO reuse the EXISTING generic `[data-testid="undo-toast"]`/
//    `[data-testid="undo-toast-undo-btn"]` pattern Phase 28 already
//    established (plans-view.js's `showUndoToast`) -- no second toast
//    mechanism. Dedupe (`shell-add-to-plan-dedupe-notice`) is a NEW,
//    non-toast inline notice (adding an already-member scene is not an
//    action that happened and needs undoing -- it's a no-op that needs
//    explaining), so it must NOT trigger an undo-toast.
//
// 7. WORLD BACKEND ROUTES -- LANDED CONCURRENTLY, MID-30.0. Task 30.1 (a
//    separate, parallel-safe task per plans/phase-30-tasks.md's own tiering
//    table) landed its two World-backend routes in this same working tree
//    WHILE this task was in progress (confirmed by direct run, not assumed
//    -- an earlier draft of this suite guessed at both shapes and asserted
//    404; the real run showed 200/400, both routes genuinely already wired,
//    corrected below to match the REAL shipped contract rather than a
//    stale guess). Both route PATHS this suite originally guessed turned
//    out correct; only field names differed from the guess:
//      - `GET /api/scene-planning/entities/:entityId/scenes?world=` --
//        "appears in" (`scenesForEntity`, `session-planner/scene-lookup.
//        mjs`), mirrors the sibling `GET /api/scene-planning/scenes/
//        :sceneId/plans` shape one entity type over. REAL response:
//        `200 {appearances:[{scene, roles}]}` -- `roles` is a subset of
//        `["anchor","member","element"]` (a scene can carry more than one
//        role for the same entity). `[]` (well -- `{appearances:[]}`) for
//        an entity appearing in no scene, never a 404 for a valid entity.
//      - `POST /api/graph/nodes/:entityId/reparent {world, parentId}` --
//        NOTE the real body key is `parentId`, not the `newParentId` an
//        earlier draft of this file guessed. Atomic reparent (delete every
//        existing containment edge where entityId is the child + add one
//        new edge to `parentId`, one undo slot; `parentId: null` unparents;
//        cycle-guarded). REAL response:
//        `200 {entityId, parentId, removedEdgeCount, edgeId}`.
//    30.0's own job (this file) does NOT modify or extend either route or
//    its own tests -- that's 30.1's task, already done and out of scope
//    here. This suite only locks the CONSUMPTION contract 30.4 builds the
//    World surface against, corrected to the real shapes above so 30.4
//    doesn't inherit a stale guess.
//
// ===========================================================================
// 1. SHELL VISIBILITY SWITCH (30.2)
// ===========================================================================
//   `[data-testid="app-shell"][data-surface="planner"|"world"]` -- the shell
//   root. Visible (not `hidden`) iff the current hash's leading segment is
//   `planner` or `world`; `data-surface` reflects which. While visible, the
//   legacy `header.topbar` and `main` elements (index.html's EXISTING,
//   untouched markup) must both be `hidden`, and vice versa for any legacy
//   hash (this suite uses `#queue` as the legacy control case).
//
// ===========================================================================
// 2. SHELL TOPBAR (30.2)
// ===========================================================================
//   `[data-testid="shell-topbar"]` inside `app-shell`, containing:
//     - `[data-testid="shell-world-select"]` -- a `<select>`, options from
//       the EXISTING `GET /api/worlds` route. Changing it writes
//       `localStorage["gmReview.world"]` (Decision 3) and re-renders the
//       current shell view (this suite seeds TWO worlds, switches via this
//       select while on `#planner/plans`, and asserts the rail's plan list
//       now reflects the OTHER world's own plans).
//     - `[data-testid="shell-surface-toggle-planner"]` /
//       `[data-testid="shell-surface-toggle-world"]` -- Decision 4. This
//       suite drives BOTH directions: from a real planner sub-route,
//       clicking world-toggle navigates to bare `#world` and
//       `[data-testid="world-surface-root"]` appears while
//       `[data-testid="shell-rail-planner"]` disappears; from `#world`,
//       clicking planner-toggle navigates to `#planner/plans` and
//       `[data-testid="planner-plans-view"]` appears while
//       `[data-testid="world-surface-root"]` disappears.
//     - `[data-testid="shell-breadcrumb"]`:
//         - `[data-testid="shell-breadcrumb-plans"]` -- ALWAYS present on
//           the planner surface (any of the three planner views), clicking
//           it navigates to `#planner/plans`.
//         - `[data-testid="shell-breadcrumb-plan"][data-plan-id]` -- present
//           iff `view` is `plan` or `scene` (and, for `scene`, iff the scene
//           has a plan context -- an orphaned scene reached with no plan in
//           context omits this segment, mirroring Phase 28's own
//           breadcrumb-back-btn "never a dead link" precedent). Clicking it
//           navigates to `#planner/plan/<planId>`.
//         - `[data-testid="shell-breadcrumb-scene"][data-scene-id]` --
//           present iff `view === "scene"`. This suite asserts it is the
//           LEAF (not clickable) -- clicking it must NOT change
//           `location.hash`.
//         - The breadcrumb is planner-surface-only: on `#world`, this suite
//           asserts `shell-breadcrumb` has a DOM count of 0 (the World
//           surface's own top-bar content -- search box, type-filter chips
//           -- is 30.4's concern, not asserted by this suite).
//
// ===========================================================================
// 3. SHELL RAIL -- planner surface (30.2)
// ===========================================================================
//   `[data-testid="shell-rail-planner"]` -- present iff the current shell
//   surface is `planner` (any of its three views); DOM count 0 on `#world`.
//     - `[data-testid="shell-plans-list"]` wraps
//       `[data-testid="shell-plan-item"][data-plan-id]`, one per Plan in
//       this world (via the EXISTING `GET /api/scene-planning/plans?world=`
//       route), each containing `[data-testid="shell-plan-item-name"]` (the
//       plan's own `name`) and `[data-testid="shell-plan-item-meta"]` (a
//       human scene count). Clicking a row navigates to
//       `#planner/plan/<planId>`.
//     - `[data-testid="shell-new-plan-btn"]` -- calls the EXISTING
//       `POST /api/scene-planning/plans` route and navigates straight to
//       `#planner/plan/<newId>` (this suite does not require an inline
//       name-input panel like the old `new-plan-panel` -- 30.2 may prompt
//       however it likes, e.g. a default name immediately editable on the
//       runsheet; this suite only asserts the CREATED plan is real, via a
//       fresh `GET /api/scene-planning/plans?world=`).
//     - `[data-testid="shell-scene-library-list"]` wraps
//       `[data-testid="shell-scene-library-item"][data-scene-id]`, one per
//       Scene in this world (via the EXISTING
//       `GET /api/scene-planning/scenes?world=` route), each containing
//       `[data-testid="shell-scene-library-item-name"]`. Clicking the row
//       (NOT the `+`, see below) navigates to `#planner/scene/<sceneId>`.
//     - `[data-testid="shell-scene-library-item-add-btn"][data-scene-id]`
//       -- the per-row `+`, "add to the open plan" (Decision 5):
//         - NO open plan (on `#planner/plans`): clicking shows
//           `[data-testid="shell-add-to-plan-no-target-notice"]`; this
//           suite asserts NO new route call happened (a fresh
//           `GET /api/scene-planning/plans?world=` shows every plan's
//           `sceneIds` UNCHANGED).
//         - Open plan does NOT already contain the scene: clicking calls
//           the EXISTING `POST /api/scene-planning/plans/:planId/scenes`
//           route, shows `[data-testid="undo-toast"]` (Decision 6), and a
//           fresh `GET /api/scene-planning/plans/:planId?world=` shows the
//           scene now in `sceneIds`. Clicking
//           `[data-testid="undo-toast-undo-btn"]` calls the EXISTING
//           `DELETE .../plans/:planId/scenes/:sceneId` route and a fresh
//           GET shows it removed again.
//         - Open plan ALREADY contains the scene (dedupe): clicking shows
//           `[data-testid="shell-add-to-plan-dedupe-notice"][data-plan-id]`
//           whose `textContent` contains BOTH the substring "already in"
//           and the plan's own real name (never a raw id) -- this suite
//           asserts via `textContent` matching, and asserts NO `undo-toast`
//           appears (Decision 6) and the plan's `sceneIds` length is
//           UNCHANGED by a fresh GET.
//
// ===========================================================================
// 4. MAIN COLUMN DISPATCH + DEEP LINK (30.2/30.3)
// ===========================================================================
//   `[data-testid="shell-main"]` -- wraps exactly ONE of the following at a
//   time (this suite asserts DOM count 1 for the current one, 0 for every
//   sibling):
//     - `[data-testid="planner-plans-view"]` (`#planner/plans`)
//     - `[data-testid="planner-plan-view"][data-plan-id]`
//       (`#planner/plan/<planId>`)
//     - `[data-testid="planner-scene-view"][data-scene-id]`
//       (`#planner/scene/<sceneId>`) -- 30.0 asserts ONLY that this root
//       appears with light stub sub-roots (full port is 30.3's job, per
//       plans/phase-30-tasks.md's own "keep this focused on shell-
//       integration flows... stub as TODO-red or keep light"):
//         - `[data-testid="planner-scene-place-header"]`
//         - `[data-testid="planner-scene-read-aloud"]`
//         - `[data-testid="planner-scene-elements"]`
//     - `[data-testid="world-surface-root"]` (`#world` / `#world/<id>`)
//   DEEP LINK: `page.goto(base + "#planner/scene/<sceneId>")` with NO prior
//   navigation/click must render `[data-testid="planner-scene-view"][data-
//   scene-id="<sceneId>"]` directly (this suite's single most important
//   shell-integration assertion, per the task's own explicit ask).
//
// ===========================================================================
// 5. WORLD SURFACE -- light 30.0 contract (30.4 fleshes out fully)
// ===========================================================================
//   `[data-testid="world-surface-root"]`:
//     - `[data-testid="world-tree"]` wraps
//       `[data-testid="world-tree-row"][data-entity-id]`, sourced from the
//       EXISTING `GET /api/graph?world=&filter=all` route (this suite seeds
//       a small real containment fixture via `applyHeadless` + a real
//       `containment`-typed edge, matching every prior graph e2e's own
//       fixture convention, and asserts each seeded node's row appears).
//     - Clicking a row selects it: `[data-testid="world-detail"][data-
//       entity-id]` appears, containing `[data-testid="world-detail-name"]`
//       / `[data-testid="world-detail-type"]` /
//       `[data-testid="world-detail-description"]` (the selected node's own
//       real fields), AND the hash updates to `#world/<entityId>` (this
//       suite also asserts the REVERSE -- a direct `page.goto` to
//       `#world/<entityId>` opens that node selected, no prior click, the
//       World surface's own deep-link case).
//     - `[data-testid="world-create-scene-here-btn"][data-entity-id]` --
//       present ONLY when the selected node's `type === "place"` (this
//       suite selects a non-place node and asserts DOM count 0, then a
//       place node and asserts count 1). Clicking it calls the EXISTING
//       `POST /api/session-planner/scenes {world,
//       locationEntityId:<entityId>}` route (the SAME route the designer
//       README documents as this action's backend, no new route) -- this
//       suite asserts a REAL new scene exists afterward via a fresh
//       `GET /api/session-planner/scenes/:id` on the response's own
//       returned scene id.
//     - `[data-testid="world-inspector"][data-entity-id]` wraps
//       `[data-testid="world-inspector-appears-in"]`, backed by the NOW-REAL
//       `scenesForEntity` route (Decision 7 -- `{appearances:[{scene,
//       roles}]}`). This suite seeds a REAL appearance (a scene anchored at
//       the selected entity) and asserts, once the World surface exists,
//       `world-inspector-appears-in`'s `textContent` includes that scene's
//       own name -- a genuine consumption assertion, not a mocked/tolerated-
//       404 placeholder (that fallback framing predates the route actually
//       landing and is no longer needed).
//
// ===========================================================================
// 6. ROUTE-LEVEL: THE TWO 30.1 WORLD-BACKEND ROUTES (Decision 7)
// ===========================================================================
//   This suite's route-level tests hit both routes directly (no browser) and
//   assert the REAL, already-shipped contract (§Decision 7) -- these two
//   specific assertions are legitimately GREEN right now (30.1 landed
//   concurrently with this task), not red-for-a-reason like everything else
//   in this suite. Kept here anyway (rather than deleted) because locking
//   the exact response shape is exactly what 30.4's own World-surface
//   consumption code needs pinned, and because a regression in either route
//   should show up in THIS suite's own run, not just 30.1's.
//
// ---------------------------------------------------------------------------
// Fixture/isolation conventions -- mirrors phase28-fixture.mjs/
// phase29-fixture.mjs exactly: real in-process createReviewServer({port:0}),
// real fixture seeding via the actual store/API functions (bootstrapSnapshot
// + applyHeadless for graph entities/edges, the real POST routes for scenes/
// plans -- never hand-constructed fixture JSON). setupPhase30Env is
// setupPhase29Env VERBATIM -- this task introduces NO new persisted store
// (scenesForEntity is a computed read over existing data, reparentNode is a
// new OP over the EXISTING graph store, not a new store of its own).
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import {
  setupPhase29Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  fetchGraphViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
} from "./phase29-fixture.mjs";

/** `setupPhase29Env()` verbatim -- see the header note above for why no new dirs are added here. */
export const setupPhase30Env = setupPhase29Env;

// ---------------------------------------------------------------------------
// Route helpers for the two 30.1 World-backend routes (§6 above) -- these
// wrap ALREADY-SHIPPED routes (30.1 landed concurrently with this task, see
// the Decision-7 note above), so unlike the rest of this file's convention
// for not-yet-built things, callers MAY treat a non-200 here as a genuine
// regression rather than an expected-red signal.
// ---------------------------------------------------------------------------

/** GET /api/scene-planning/entities/:entityId/scenes?world= -- "appears in" (scenesForEntity). Real route, {status, body:{appearances:[{scene,roles}]}}. */
export async function scenesForEntityViaRoute(base, world, entityId) {
  const res = await fetch(`${base}/api/scene-planning/entities/${encodeURIComponent(entityId)}/scenes?world=${encodeURIComponent(world)}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** POST /api/graph/nodes/:entityId/reparent {world, parentId} -- atomic reparent (note: real body key is `parentId`, not `newParentId`). Real route, {status, body:{entityId,parentId,removedEdgeCount,edgeId}}. */
export async function reparentNodeViaRoute(base, world, entityId, parentId) {
  const res = await fetch(`${base}/api/graph/nodes/${encodeURIComponent(entityId)}/reparent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, parentId })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** Real POST /api/scene-planning/plans/:planId/scenes round trip, returning {status,body} rather than asserting -- used where a test wants to observe the CURRENT (dedupe-aware) shell behavior rather than seed data via the raw route. Distinct from the imported addSceneToPlanViaRoute, which asserts 200 (setup-only use). */
export async function addSceneToPlanRaw(base, world, planId, sceneId) {
  const res = await fetch(`${base}/api/scene-planning/plans/${encodeURIComponent(planId)}/scenes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, sceneId })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export {
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  fetchGraphViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
};
