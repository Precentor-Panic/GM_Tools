// Phase 25 task 25.0 -- shared setup + THE FULL DOM/ROUTE CONTRACT for the
// Table Mode e2e suite (review-ui/test/e2e/table-mode-*.e2e.mjs). NOT itself
// an *.e2e.mjs file (the npm run test:e2e glob is test/e2e/*.e2e.mjs), same
// exemption as fixture.mjs/scene-construction-fixture.mjs -- every
// table-mode-*.e2e.mjs file imports what it needs from here rather than
// each re-deriving the shared contract independently.
//
// THIS IS THE INTERFACE SPEC the (not yet dispatched) 25.1-25.6 implementation
// tasks build to match. None of the DOM described below exists yet --
// session-planner-view.js currently renders ONLY Phase 23's construction
// chain view (`[data-testid="scene-chain"]`). Every file in this suite is
// EXPECTED TO FAIL right now with a Playwright selector-not-found/timeout
// error. That failure is the deliverable of task 25.0, not a bug in these
// files. Read this header FIRST; each sibling file's own header only adds
// scenario-specific detail, matching scene-construction-fixture.mjs's own
// established "read the shared header once" precedent.
//
// Grounded directly in the real, currently-shipped code (re-verified fresh,
// not trusted from plans/phase-25-tasks.md's own grounding section, which
// itself is 1-2 pointers stale in one place -- see the FLAGGED GAP note at
// the bottom of this header):
//   - review-ui/public/session-planner-view.js's renderLocationCard (~line
//     439), toggleNotePanel (~line 552), ensureSceneExtras/sceneExtrasCache
//     (~line 1502/280), loadAndRenderChain (~line 1705) -- Table Mode is an
//     ADDITIVE alternate render of the SAME #session-planner-body container
//     these already populate, not a new top-level nav view.
//   - review-ui/public/app.js's parseHash(): `const [view, arg] =
//     raw.split("/")` -- only TWO segments are ever extracted from the hash.
//     This is why Table Mode's own URL scheme (below) packs the mode
//     signal INTO the single `arg` slot (`sceneId?mode=table`) rather than
//     a third `/table` path segment, which parseHash would silently drop.
//
// ===========================================================================
// 1. URL SCHEME + TABLE MODE TOGGLE (task 25.0 scenario 1 / impl task 25.2)
// ===========================================================================
//   - Construction view (Phase 23, unchanged): `#session-planner/<sceneId>`.
//   - Table Mode (NEW): `#session-planner/<sceneId>?mode=table` -- the
//     WHOLE `sceneId?mode=table` string is `arg` per parseHash's own
//     split-on-"/" behavior (confirmed above), so renderSessionPlanner(arg)
//     is responsible for splitting `arg` on "?mode=table" itself; this file
//     never asserts HOW that parsing happens internally, only the
//     OBSERVABLE contract: entering this hash directly (a fresh page load,
//     not a click-through from construction view) renders Table Mode
//     immediately -- THIS is what "both addressable via the URL" (task
//     25.0's own scenario 1 wording) means, and what makes a RELOAD
//     preserve which mode was active.
//   - `[data-testid="table-mode-toggle-btn"]` -- lives in the CONSTRUCTION
//     view, a direct child of `#session-planner-body` (sibling of
//     `scene-chain`, matching `quick-add-scene-btn`'s own established
//     top-level-not-scoped-to-one-scene-item placement), always for
//     whichever scene is CURRENTLY loaded (not any other chain item).
//     Clicking it navigates to `#session-planner/<currentSceneId>
//     ?mode=table`.
//   - `[data-testid="construction-mode-toggle-btn"]` -- lives in Table
//     Mode, mirrors the above in reverse: navigates back to
//     `#session-planner/<currentSceneId>` (no `?mode=`).
//   - `[data-testid="table-mode-view"][data-scene-id="<id>"]` -- Table
//     Mode's own root container, direct child of `#session-planner-body`.
//     MUTUALLY EXCLUSIVE with `[data-testid="scene-chain"]` -- exactly one
//     of the two is ever present at a time.
//
// ===========================================================================
// 2. TOP STRIP + CORRECTED FLAG CODING (scenario 2 / impl task 25.2, 25.1)
// ===========================================================================
//   `[data-testid="table-top-strip"][data-scene-id]` -- direct child of
//   `table-mode-view`, describing the scene's own ANCHOR entity (the same
//   entity/flags/digest data `brief.locations`' distance-0 entry already
//   carries, per session-planner/brief.mjs, confirmed live):
//     - `[data-testid="table-top-strip-name"]` -- anchor entity name.
//     - `[data-testid="table-top-strip-path-badge"]` -- "on the path"
//       equivalent of location-card-anchor-badge.
//     - Flag badges: REUSES the EXISTING `.flag-badge`/`.flag-badge--content`/
//       `.flag-badge--structural`/`.location-card-digest--empty` CSS
//       classes verbatim (style.css lines ~617/626/627 as of this writing --
//       re-verify fresh) -- task 25.1's color-token fix is a SHARED CSS
//       change, and Table Mode's top strip must benefit from it by reusing
//       the same classes, not inventing parallel ones the fix wouldn't
//       reach. Each rendered badge/empty-state element additionally carries
//       `data-testid="table-flag-badge"` with `data-flag-kind="content"|
//       "structural"|"empty"` so this suite can address each one without
//       depending on exact copy text.
//
// ===========================================================================
// 3. NAVIGATION ZONE (scenarios 3+4+5 / impl task 25.2, design record §3a)
// ===========================================================================
//   `[data-testid="table-nav-zone"][data-scene-id]` -- direct child of
//   `table-mode-view`, positioned directly adjacent to the top strip (DOM
//   order: table-top-strip, then table-nav-zone, both ahead of the roster/
//   notes-encounters/actions zones -- this suite asserts DOM order, not
//   pixel position, for "directly adjacent").
//     - `[data-testid="table-nav-search-input"]` -- sits above the adjacent
//       strip per §3a. Typing filters `GET /api/scene-planning/scenes
//       ?world=` (the SAME route Phase 24's scenes-view.js already uses,
//       confirmed live) by substring match on anchor name, client-side.
//     - `[data-testid="table-nav-search-results"]` -- rendered while the
//       search input is non-empty, containing
//       `[data-testid="table-nav-search-result"][data-scene-id]` per match.
//       Clicking one navigates to `#session-planner/<thatSceneId>
//       ?mode=table` -- MUST stay in table mode (this is scenario 4's whole
//       point: a non-adjacent jump that never leaves Table Mode).
//     - `[data-testid="table-adjacent-strip"]` -- contains
//       `[data-testid="table-adjacent-scene-item"][data-scene-id]`, one per
//       `linkedScenesForScene` result with `hopDistance === 1` (the SAME
//       `GET /api/scene-planning/linkage?world=&sceneId=` route Phase 22/24
//       already ship, confirmed live) -- a single tap, no picker, no
//       intermediate step; navigates to `#session-planner/<id>?mode=table`.
//     - `[data-testid="table-full-list"]` -- a real `<details>` element
//       (matching renderBeyondCorridorSummary's / scene-chain-item's own
//       established "free, JS-free collapse" precedent), COLLAPSED by
//       default (no `open` attribute), with
//       `<summary data-testid="table-full-list-toggle">`. Inside:
//       `[data-testid="table-full-list-item"][data-scene-id]` per scene in
//       the world (from the same `GET /api/scene-planning/scenes` fetch the
//       search bar uses), each navigating to `#session-planner/<id>
//       ?mode=table` on click.
//
// ===========================================================================
// 4. MEMBER ROSTER + playerKnown GATE (scenarios 6+7 / impl task 25.3)
// ===========================================================================
//   `[data-testid="table-roster"][data-scene-id]` -- one
//   `[data-testid="table-roster-row"][data-entity-id][data-card-role]` per
//   scene member (anchor/satellite/added, same role vocabulary as
//   location-card), each ALWAYS showing (no expand needed):
//     - `[data-testid="table-roster-row-name"]`
//     - `[data-testid="table-roster-row-role-tag"]`
//     - `[data-testid="table-roster-row-hook"]`
//     - `[data-testid="table-roster-expand-btn"]` -- a real, persistently
//       visible `<button>` (never hover-only -- this suite never calls
//       `.hover()` to reveal it, only `.click()`), toggling
//       `[data-testid="table-roster-detail"][data-entity-id]`:
//         - `[data-testid="table-roster-detail-description"]`
//         - `[data-testid="table-roster-detail-summary"]`
//         - `[data-testid="table-roster-detail-image"]` -- an `<img>` with
//           a real `src` reflecting the entity's `imageUrl`, rendered ONLY
//           if `imageUrl` is set.
//         - `[data-testid="table-roster-detail-tag"]` -- one per string in
//           the entity's `tags` array.
//       NO CAP on how many rows can be expanded at once (design record §5's
//       direct adjudication, task 25.0 scenario 6's own explicit purpose:
//       lock this in so a future implementer doesn't "fix" it into an
//       accordion by assumption) -- expanding a 4th row must NEVER collapse
//       any of the first 3.
//     - `playerKnown` is NEVER rendered inside `table-roster-detail` by the
//       general expand above. Instead, `table-roster-detail` also contains
//       `[data-testid="table-roster-playerknown-gate-btn"][data-entity-id]`
//       -- a SEPARATE, more deliberate control. Clicking it reveals
//       `[data-testid="table-roster-playerknown-confirm-panel"]` with
//       `[data-testid="table-roster-playerknown-confirm-btn"]` and
//       `[data-testid="table-roster-playerknown-cancel-btn"]`. ONLY clicking
//       CONFIRM causes `[data-testid="table-roster-playerknown-value"]
//       [data-player-known="true"|"false"]` to be added to the DOM.
//       Cancelling (or never clicking confirm) must leave the DOM with
//       ZERO `table-roster-playerknown-value` elements anywhere in the
//       document -- not CSS-hidden, genuinely absent
//       (`document.querySelector(...) === null`).
//
// ===========================================================================
// 5. NOTES + ENCOUNTERS ZONE (scenarios 8+9 / impl task 25.4)
// ===========================================================================
//   `[data-testid="table-notes-encounters-zone"][data-scene-id]` -- ONE
//   unified list. `[data-testid="table-notes-encounters-item"]
//   [data-item-type="note"|"encounter"][data-item-id]` -- notes
//   (session-planner/session-notes.mjs's listPendingNotes, already
//   scene-aware via each note's own sceneId/anchorEntityId -- this suite
//   seeds notes via the real `POST /api/session-planner/notes` route with
//   `anchorEntityId` set to the scene's own anchor, exactly mirroring how
//   Phase 23's own Add Event already captures notes, confirmed live) and
//   saved encounters (`GET /api/scene-planning/scenes/:sceneId/encounters
//   ?world=`, confirmed live) are DOM SIBLINGS under this ONE parent --
//   "interleaved, not two separately-sized sections" (design record §3,
//   Phase 21 §6's standing equal-weight rule) is asserted directly as
//   "same parentElement", the same measurable definition
//   scene-construction-events-encounters.e2e.mjs's own equal-weight test
//   already established for Add Event/Add Encounter.
//     - Note item: `[data-testid="table-note-text"]`.
//     - Encounter item: `[data-testid="table-encounter-name"]`, plus one
//       `[data-testid="table-encounter-roster-row"][data-entry-id]` per
//       `combination[]` entry, ALWAYS showing (unexpanded):
//         - `[data-testid="table-encounter-roster-name"]`
//         - `[data-testid="table-encounter-roster-hp"]`
//         - `[data-testid="table-encounter-roster-ac"]`
//       resolved by cross-referencing `combination[].entryId` against
//       `GET /api/combat-planning/bestiary`'s real accepted entries
//       (`entry.rawFields.name/hp/ac`, confirmed live shape) -- NOT a
//       second, UI-only copy of the stat block; `saveEncounter`'s own
//       `combination` field only ever stores `{entryId, count}` pairs
//       (confirmed directly in combat-planning/saved-encounter.mjs /
//       combat-planning-view.js's toManualCombination), so resolving to a
//       real name/hp/ac genuinely requires this real bestiary fetch.
//       `[data-testid="table-encounter-roster-expand-btn"]` reveals
//       `[data-testid="table-encounter-roster-detail"][data-entry-id]`
//       containing `[data-testid="table-encounter-roster-attack"]` (one per
//       `rawFields.attacks[]`) and, if present,
//       `[data-testid="table-encounter-roster-recharge-ability"]` (one per
//       `rawFields.rechargeAbilities[]`, this project's real "beyond
//       attacks" stat-block field, confirmed live in
//       combat-planning/bestiary-ingest.mjs's RawBestiaryFields schema --
//       there is no `traits` field anywhere in this codebase's real
//       bestiary shape, so this suite uses the real field that exists
//       instead of inventing one) -- both ONLY visible after the nested
//       expand, never in the unexpanded row.
//
// ===========================================================================
// 6. BOTTOM ACTIONS BAR (scenario 10 / impl task 25.5)
// ===========================================================================
//   `[data-testid="table-actions-bar"][data-scene-id]` -- direct child of
//   `table-mode-view`, containing (DOM siblings, same parent):
//     - `[data-testid="table-add-event-btn"]` -- reuses the EXISTING
//       `POST /api/session-planner/notes` route exactly as Phase 23's own
//       add-event-btn does.
//     - `[data-testid="table-add-encounter-btn"]` -- reuses the EXISTING
//       return-context navigation (`#combat-planning/<sceneId>`) exactly as
//       Phase 23's own add-encounter-btn does.
//     - `[data-testid="table-quick-gen-btn"]` -- Phase 22's already-shipped
//       fast single-call primitive, reused as-is (not this suite's concern
//       beyond confirming it renders as a genuine sibling, not tested for
//       its own network behavior here -- quick-gen's own network contract
//       is already covered by scene-construction-quick-gen.e2e.mjs).
//   Equal visual weight between Add Event and Add Encounter specifically
//   (Phase 21 §6's standing rule) -- SAME real-measurement convention as
//   scene-construction-events-encounters.e2e.mjs's own `.boundingBox()` +
//   same-parentElement + same-computed-font-size test.
//
// ===========================================================================
// 7. RESPONSIVE (scenario 11 / impl task 25.6)
// ===========================================================================
//   At IPHONE_13_VIEWPORT (390x844), on initial page load (no scrolling
//   performed), `table-top-strip` and `table-nav-zone` (specifically
//   `table-adjacent-strip` and `table-nav-search-input`) must both have a
//   real, measurable `.boundingBox()` fully within [0, viewport.height] --
//   i.e. reachable with ZERO scrolling, per §3a's own explicit "navigation
//   must never degrade into a scroll-and-hunt fallback" requirement. This
//   suite does NOT test "stays pinned while scrolling" (a distinct, related
//   but separately-scoped design intent) -- only the literal "reachable
//   without scrolling" wording task 25.0's own scenario 11 uses.
//
// ===========================================================================
// FLAGGED GAP (found while grounding this file against the REAL current
// code, not just the task-plan's own summary of it): plans/phase-25-tasks.md
// ("Grounding" section) states entity `summary`/`imageUrl`/`tags` are
// "[a]lready returned by the existing GET /api/graph?filter=all fetch...
// no new route needed, just render more of what's already fetched." This is
// only PARTLY true as of this writing -- review-ui/server.mjs's
// graphNodePayload() (~line 528) returns `description`/`status`/
// `playerKnown`/`canonLocked`/`role`/`attributes` but does NOT currently
// include `summary`, `imageUrl`, or `tags` anywhere in its returned shape,
// even though foundry_worldFabric's graph-service.mjs's upsertEntity does
// persist all three (confirmed directly). This suite still asserts the
// FULL §3 contract (description/summary/imageUrl/tags all rendering) since
// that's the adjudicated design requirement, not a UI-only nicety -- but
// whoever implements task 25.3 will ALSO need a small, additive widening of
// graphNodePayload's own returned fields (the same "growing an EXISTING
// route's payload" pattern the task 19.6 comment already documents at
// server.mjs ~line 545) before this suite's roster-detail assertions can
// pass. Flagged here explicitly so it isn't rediscovered from scratch.
// ---------------------------------------------------------------------------
import {
  setupSceneConstructionEnv,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
} from "./scene-construction-fixture.mjs";

/** `#session-planner/<sceneId>` -- Phase 23's existing construction-view hash (no leading "#"). */
export function constructionHash(sceneId) {
  return `session-planner/${sceneId}`;
}

/** `#session-planner/<sceneId>?mode=table` -- Table Mode's own URL-addressable hash (no leading "#"). See this file's header §1 for why the mode signal is packed into the single arg slot rather than a third path segment. */
export function tableModeHash(sceneId) {
  return `session-planner/${sceneId}?mode=table`;
}

export async function gotoConstructionMode(page, base, sceneId) {
  await page.goto(`${base}/#${constructionHash(sceneId)}`);
}

export async function gotoTableMode(page, base, sceneId) {
  await page.goto(`${base}/#${tableModeHash(sceneId)}`);
}

export {
  setupSceneConstructionEnv,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
};
