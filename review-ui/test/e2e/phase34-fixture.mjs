// Phase 34 task 34.0 -- shared setup + THE FULL DOM/ROUTE CONTRACT for the
// Phase 34 "adopt the full designer app" e2e suite (phase34-nav-connection.e2e.mjs,
// phase34-delta-fixes.e2e.mjs). NOT itself an *.e2e.mjs file (the
// `npm run test:e2e` glob is test/e2e/*.e2e.mjs), same exemption as
// fixture.mjs/phase2N-fixture.mjs/phase30-fixture.mjs -- every Phase 34
// *.e2e.mjs file imports what it needs from here rather than each re-deriving
// the shared contract independently.
//
// THIS IS THE INTERFACE SPEC tasks 34.1-34.3 implement to match. Grounded in
// plans/phase-34-tasks.md (read that FIRST -- the pre-specified route/store
// contract §"Pre-specified route/store contract", which this file copies
// verbatim into each route helper's own doc comment so a drift between the
// two documents is visible at a glance) and the design record
// (.claude/plans/ok-i-m-back-with-dazzling-newt.md) + the NEW handoff
// (design/session-planner/{README.md,Connection Menu.dc.html,World
// Graph.dc.html,Session Planner.dc.html}, 34.0's own extraction). Every
// route/DOM contract below is confirmed NOT to exist yet against the real,
// current app-shell.js/world-view.js/session-planner-view.js/server.mjs
// (re-verified by direct read AND, for the route-level assertions, by
// grepping server.mjs's own route table for the literal path segments --
// none of `/api/foundry/connection`, `/api/foundry/sync-now`, bare
// `/api/settings`, `/api/lore/worldanvil`, `/api/graph/nodes/:id/
// remove-reparent-up` appear anywhere in it) -- every phase34 *.e2e.mjs
// UI-level scenario is EXPECTED TO FAIL right now with a Playwright
// selector-not-found/timeout error or a real HTTP 404 (the generic
// `sendJson(res, 404, {error:"No route: METHOD path"})` fallback,
// server.mjs's own last resort). That failure is the deliverable of task
// 34.0, not a bug in these files.
//
// PARALLEL-TASK NOTE (per this task's own instructions): 34.1 implements the
// SAME pre-specified contract concurrently, in the SAME working tree. Every
// route-level test below therefore asserts the FINAL CONTRACTED shape (not a
// tolerant "404-or-200" either/or) -- if 34.1 lands first, these tests turn
// green on their own with no edit; if not, they fail with a clean 404,
// documented per-test as the expected-red reason. The completion report
// records, for each route, which state was actually observed at verification
// time.
//
// ===========================================================================
// DESIGN DECISIONS THIS SUITE LOCKS IN (34.0's own judgment calls -- the
// design record/task plan deliberately leave exact testid/DOM shapes to the
// QE pass; documented here so 34.2/34.3's implementers match ONE contract):
// ===========================================================================
//
// 1. FOUR-WAY NAV. The existing `[data-testid="shell-surface-toggle-
//    planner"]` / `[data-testid="shell-surface-toggle-world"]` testids
//    (Phase 30) are UNCHANGED -- phase30/31/33's own e2e suites depend on
//    them and must stay green. TWO NEW nav items are added alongside them:
//    `[data-testid="shell-nav-chronicle"]` / `[data-testid="shell-nav-
//    library"]`, same visual nav-group (per the design's own top-bar
//    grouping, `design/session-planner/Chronicle.dc.html`'s own nav strip:
//    "Session planner · World · Chronicle · Library", confirmed by direct
//    read of all four `.dc.html` files' identical nav markup). Clicking
//    `shell-nav-chronicle` navigates to bare `#chronicle`; `shell-nav-
//    library` to bare `#library` (Decision 4's own "always the surface's
//    canonical entry" precedent, extended to the two new surfaces).
//    ACTIVE STATE: `[data-testid="app-shell"][data-surface="planner"|
//    "world"|"chronicle"|"library"]` -- the shell root's OWN `data-surface`
//    attribute grows two new values (today only "planner"/"world" are ever
//    set, confirmed by direct read of app-shell.js's `renderShell`). This
//    suite asserts the attribute value directly (mirrors Phase 30's own
//    "assert the attribute, not a derived CSS style" convention) rather than
//    a visual/class-based active check.
//    SCAFFOLD ROOTS: `[data-testid="chronicle-surface-root"]` /
//    `[data-testid="library-surface-root"]` -- placeholder pages (correct
//    chrome + "arrives in Phase 35/37" copy per this task's own charter);
//    this suite only asserts the root renders and is the sole occupant of
//    `[data-testid="shell-main"]`, not any placeholder copy verbatim.
//
// ===========================================================================
// 2. CONNECTION CHIP + PANEL (34.2's Connection Menu component)
// ===========================================================================
//    `[data-testid="conn-chip"][data-state="live"|"stale"|"off"]` -- renders
//    in the shell topbar (present on every shell surface: planner/world/
//    chronicle/library -- this suite checks planner and world, the two
//    surfaces that exist today). Sourced from `GET /api/foundry/connection`
//    (§4 below); this suite's fixture worlds never have a foundry-index
//    file, so `state` is always "off" for every UI-level assertion here
//    (the chip's live/stale rendering from a REAL index is 34.1/34.2's own
//    deterministic-test territory, not re-derived here).
//    Clicking the chip opens `[data-testid="conn-panel"]` (a floating panel,
//    per `Connection Menu.dc.html`'s own 560px-wide layout). Dismiss:
//      - `Escape` while the panel is open closes it (chip regains focus,
//        this suite only asserts the panel becomes hidden/removed).
//      - Clicking ANYWHERE outside the panel (this suite clicks the shell
//        topbar's world-select, a stable, always-present, panel-exterior
//        element) closes it.
//    Sections present (all attribute-level presence checks, not full visual
//    fidelity -- 34.2's own polish concern):
//      - `[data-testid="conn-panel-foundry-section"]` -- the "Foundry"
//        block (connect/world-switch/counts/sync-now per the design's
//        `connected`/`disconnected` `sc-if` branches).
//      - `[data-testid="conn-panel-lore-section"]` wraps TWO intake-mode
//        controls, per the design's `sourceTabs` (`Connection
//        Menu.dc.html`: "Paste text" / "World Anvil"):
//        `[data-testid="conn-lore-mode-paste"]` / `[data-testid="conn-lore-
//        mode-worldanvil"]`. This suite clicks each and asserts the OTHER
//        mode's own input disappears (`[data-testid="conn-lore-paste-
//        input"]` a textarea / `[data-testid="conn-lore-worldanvil-
//        input"]` a url input -- mutually exclusive, matching the design's
//        `isPaste`/`isUrl` sc-if pair).
//      - `[data-testid="conn-panel-history-section"]` -- the design's "Read
//        so far" block (over `GET /api/batches`, README/task-plan's own
//        history-over-listBatches instruction).
//      - `[data-testid="conn-panel-settings-section"]` -- the design's
//        "Campaign & keys" disclosure (collapsed by default per the
//        prototype's own `settingsOpen: false` initial state).
//
// ===========================================================================
// 3. REDIRECTS: `#settings` / `#import` retire-as-replaced
// ===========================================================================
//    Per the locked decision ("Legacy views: keep by-hash, retire-as-
//    replaced... This phase retires `#settings` (-> Connection Menu panel)
//    and `#import` (-> lore intake) with hash-redirects to the new homes"):
//    navigating to `#settings` rewrites `location.hash` to `#planner/plans`
//    (or whatever the shell's default landing is) WITH the Connection panel
//    OPEN and its settings section expanded (`[data-testid="conn-panel"]`
//    visible, `[data-testid="conn-panel-settings-section"]` in its OPEN/
//    expanded state); navigating to `#import` similarly redirects with the
//    panel open and its lore-intake section focused (source tab = paste, the
//    design's own default). This suite asserts BOTH the hash rewrite (
//    `location.hash` no longer equals `#settings`/`#import` after
//    navigation settles) AND that the OLD `view-settings`/`view-import`
//    legacy `<section>`s do NOT become the active view (`.view.active` is
//    never `#view-settings`/`#view-import` after landing).
//
// ===========================================================================
// 4. ROUTE-LEVEL: THE 34.1 BACKEND CONTRACT (copied from plans/
//    phase-34-tasks.md's own "Pre-specified route/store contract" verbatim,
//    so drift between the two documents is visible)
// ===========================================================================
//   - `GET /api/foundry/connection?world=` -> `{state:"live"|"stale"|"off",
//     exportedAt, ageMs, staleThresholdMs, counts:{actors,items,scenes,
//     journals}|null, lastSync:{at,ok,error?}|null, world}`. This suite's
//     fixture worlds have NO foundry-index file -> `state` MUST be `"off"`,
//     `counts` MUST be `null`.
//   - `POST /api/foundry/sync-now {world}` -> `{pulled:{bestiaryProposed,
//     partyProposed,alreadyLinked}, indexAgeMs, state}` -- no index -> MUST
//     be `{state:"off", ...}` with a clear message, must NOT throw/500.
//   - Settings store `session-planner/app-settings.mjs` (env
//     `GM_TOOLS_APP_SETTINGS_DIR`, added to this suite's own scratch env
//     below so 34.1's store is isolated the SAME way every prior new store's
//     fixture predated it -- Phase 28's own established convention).
//     `GET/POST /api/settings?world=` (POST = patch, only `campaignName` +
//     `calendar` + `staleThresholdMs` need be WIRED this phase per the task
//     plan -- this suite only exercises those three).
//   - `POST /api/lore/worldanvil {world, url}` -- server-side fetch. This
//     suite NEVER hits the real internet: it POSTs an unreachable LOCAL url
//     (`http://127.0.0.1:1/` -- port 1, nothing listens there, an immediate
//     ECONNREFUSED, no network egress) and asserts the FINAL contract: a 4xx
//     response whose `error` text names the fetch failure (not the generic
//     "No route" fallback text) -- this is both "confirmed red today" (the
//     route doesn't exist -> generic 404/"No route" text, which does NOT
//     match the fetch-failure wording this suite requires) and the FINAL
//     shape 34.1 must land.
//   - `POST /api/graph/nodes/:entityId/remove-reparent-up {world}` -> the
//     34.3 hybrid delete: reparent every containment-child to the node's
//     parent (or unparent if none) THEN delete the node cascading its
//     remaining edges -- ONE atomic undo slot -> `{entityId,
//     reparentedChildren, droppedEdges}`. `remove-from-scenes` (Phase 33,
//     UNCHANGED) is reused unchanged for the opt-in.
//
// ===========================================================================
// 5. D4 -- NAMED PREV/NEXT (34.3)
// ===========================================================================
//    REUSES the existing testids (`session-planner-view.js`'s
//    `buildSceneBreadcrumb`, confirmed by direct read to already render
//    `[data-testid="scene-breadcrumb-prev-btn"]`/`[data-testid="scene-
//    breadcrumb-next-btn"]` on the SHELL scene page too, `#planner/scene/
//    <id>` -- the "designer sub-bar" the file's own header comment refers
//    to) -- only the CONTENT contract changes, per
//    `design/session-planner/Session Planner.dc.html`'s own
//    `prevLabel`/`nextLabel` binding:
//      - `scene-breadcrumb-prev-btn` textContent === `"← " + <the previous
//        scene's real name>` when a previous scene exists in the plan's
//        `sceneIds` order; when there is none (first scene in the plan),
//        the button STILL RENDERS (not omitted, unlike today) with
//        textContent `"Start of plan"` and a real `disabled` attribute --
//        clicking it must NOT navigate.
//      - `scene-breadcrumb-next-btn` textContent === `<the next scene's
//        real name> + " →"`, else `"End of plan"` + `disabled` at the tail
//        end, same non-navigating guarantee.
//    Today (confirmed by direct read, `session-planner-view.js`): the
//    button textContent is the generic `"‹ Prev"`/`"Next ›"` (never a scene
//    name), and at either end the button is OMITTED entirely rather than
//    rendered disabled -- both are genuine RED-today conditions this suite
//    exercises independently (a middle scene for the naming assertion, the
//    plan's first/last scene for the disabled-at-the-ends assertion).
//
// ===========================================================================
// 6. D5-D8 -- HYBRID REMOVE-FROM-GRAPH (34.3, SUPERSEDES the Phase 33
//    confirm-panel contract -- phase33-remove-from-graph.e2e.mjs is trimmed
//    in the SAME commit as this file per this task's own instructions)
// ===========================================================================
//    REUSES `[data-testid="world-remove-from-graph-btn"][data-entity-id]`
//    (same header slot, Phase 33) but its behavior is now the design's
//    inline two-click ARM, not a separate confirm panel:
//      - FIRST click ARMS in place. The button's OWN textContent flips to
//        `"remove — sure?"` (matching `World Graph.dc.html`'s own
//        `removeLabel`).
//      - Compute three counts client-side from the already-loaded graph
//        cache + the already-fetched `scenesForEntity` appearances (same
//        "zero extra route call" reasoning Phase 33's own confirm panel
//        used): K = containment CHILDREN of this node (they get reparented
//        up), M = NON-containment edges touching this node (dropped -- the
//        node's own upward containment edge to ITS parent is NOT counted
//        here, it simply disappears with the node, not a "link" in the
//        warned sense), N = scenes referencing this node
//        (`scenesForEntity`'s own appearance count).
//      - K/M/N ALL zero (Russell's own HYBRID rule, distinct from the raw
//        prototype which always shows a hint): the button's flipped label
//        IS the entire armed UI -- NO `[data-testid="world-remove-
//        consequence-line"]` renders, no checkbox.
//      - Any of K/M/N nonzero: `[data-testid="world-remove-consequence-
//        line"][data-entity-id]` renders alongside the armed button, its
//        `textContent` matching `/reparents K inside/i` /
//        `/drops M links?/i` / `/used in N scenes?/i` with the REAL
//        numbers substituted, PLUS the opt-in `[data-testid="world-remove-
//        from-all-scenes-checkbox"]` (Phase 33's own testid, reused
//        verbatim), UNCHECKED by default (Phase 33's own locked default,
//        unchanged by the hybrid).
//      - SECOND click on the (now-armed) button EXECUTES: `POST /api/
//        graph/nodes/:entityId/remove-reparent-up {world}` (§4), PLUS,
//        only if the checkbox is checked, the EXISTING (Phase 33,
//        unchanged) `POST .../remove-from-scenes` for the opt-in scene
//        cleanup.
//      - DISARM: clicking anywhere else in the inspector (this suite uses
//        the already-existing, stable `[data-testid="world-inspector-
//        appears-in"]` element as the "elsewhere" target) returns the
//        button to its bare `"Remove from graph"` label, hides the
//        consequence line/checkbox, and performs NO route call.
//    Today (confirmed by direct read, Phase 33's own shipped code): clicking
//    the button opens a SEPARATE `[data-testid="world-remove-from-graph-
//    confirm-panel"]` (not an in-place arm), and `deleteNodeOp`'s own
//    DELETE route makes every child of the deleted node a NEW ROOT (no
//    reparent-up) -- both are the RED-today conditions this suite pins,
//    superseding Phase 33's own now-retired assertions of the same
//    behavior (see this task's own commit message for exactly what was
//    trimmed from phase33-remove-from-graph.e2e.mjs and why).
//
// ===========================================================================
// 7. D9-D12 -- COSMETICS (presence-level, 34.3 + Haiku)
// ===========================================================================
//    - Type-filter chips (`world-view.js`'s `.wv-chip`) become ICON-ONLY --
//      no label text child, glyph only (today each chip has TWO child
//      `<span>`s, glyph + label; this suite asserts exactly ONE child
//      element remains).
//    - `.wv-search`'s computed CSS width becomes exactly `220px` (today
//      `240px`, `style.css:2769`, confirmed by direct read) -- an
//      attribute/computed-style-level check only, per this task's own
//      charter, not a full visual diff.
//    - The scene-tray hint gains a NEW testid, `[data-testid="world-scene-
//      tray-hint"]`, and its copy becomes exactly `"Drop into a scene"`
//      (`World Graph.dc.html`'s own copy; today the hint has NO testid and
//      reads `"drag a node here → in the scene"`, `world-view.js:972`).
//
// ---------------------------------------------------------------------------
// Fixture/isolation conventions -- mirrors phase30/31/33-fixture.mjs exactly:
// real in-process createReviewServer({port:0}), real fixture seeding via the
// actual store/API functions (bootstrapSnapshot + applyHeadless for graph
// entities/edges, real POST routes for scenes/plans -- never hand-constructed
// fixture JSON). setupPhase34Env is setupPhase30Env PLUS the ONE new store
// directory (`GM_TOOLS_APP_SETTINGS_DIR`) 34.1's settings store introduces --
// same "added when first actually exercised" precedent every prior new
// store's own fixture predates (phase28-fixture.mjs's own header).
// ---------------------------------------------------------------------------
import { join } from "node:path";
import {
  setupPhase30Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  fetchGraphViaRoute,
  primeWorldSelection,
  reparentNodeViaRoute,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
} from "./phase30-fixture.mjs";

/** setupPhase30Env() plus the ONE new store dir Phase 34's settings route needs (§4 above). */
export function setupPhase34Env(prefix) {
  const { scratchDir, dataDir } = setupPhase30Env(prefix);
  process.env.GM_TOOLS_APP_SETTINGS_DIR = join(scratchDir, "app-settings");
  return { scratchDir, dataDir };
}

// ---------------------------------------------------------------------------
// Route helpers for the NEW routes §4 above. Deliberately do NOT assert
// res.status === 200 internally (unlike createSceneViaRoute/etc., which wrap
// ALREADY-SHIPPED routes) -- these routes may not exist yet, so a non-200
// here IS the expected, correct, "red for the right reason" signal task 34.0
// exists to produce (mirrors phase28/29-fixture.mjs's own under-construction
// precedent). Callers assert on the returned {status, body} themselves.
// ---------------------------------------------------------------------------

/** GET /api/foundry/connection?world= -- 404 until 34.1. */
export async function fetchConnectionViaRoute(base, world) {
  const res = await fetch(`${base}/api/foundry/connection?world=${encodeURIComponent(world)}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** POST /api/foundry/sync-now {world} -- 404 until 34.1. */
export async function syncNowViaRoute(base, world) {
  const res = await fetch(`${base}/api/foundry/sync-now`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** GET /api/settings?world= -- 404 until 34.1. */
export async function fetchSettingsViaRoute(base, world) {
  const res = await fetch(`${base}/api/settings?world=${encodeURIComponent(world)}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** POST /api/settings {world, ...patch} -- 404 until 34.1. */
export async function patchSettingsViaRoute(base, world, patch) {
  const res = await fetch(`${base}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, ...patch })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/**
 * POST /api/lore/worldanvil {world, url} -- 404 until 34.1. `url` defaults
 * to an UNREACHABLE LOCAL address (port 1, nothing listens -- immediate
 * ECONNREFUSED, zero real network egress) so this helper is safe to call
 * from any test without ever touching the real internet, per this task's own
 * "do NOT hit the real internet" instruction.
 */
export async function worldanvilImportViaRoute(base, world, url = "http://127.0.0.1:1/") {
  const res = await fetch(`${base}/api/lore/worldanvil`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, url })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** POST /api/graph/nodes/:entityId/remove-reparent-up {world} -- 404 until 34.3/34.1. */
export async function removeReparentUpViaRoute(base, world, entityId) {
  const res = await fetch(`${base}/api/graph/nodes/${encodeURIComponent(entityId)}/remove-reparent-up`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** Existing, UNCHANGED (Phase 33) route -- POST /api/graph/nodes/:entityId/remove-from-scenes {world}. */
export async function removeFromScenesViaRoute(base, world, entityId) {
  const res = await fetch(`${base}/api/graph/nodes/${encodeURIComponent(entityId)}/remove-from-scenes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world })
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
  reparentNodeViaRoute,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
};
