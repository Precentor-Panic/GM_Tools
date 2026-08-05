// Phase 29 task 29.0 -- shared setup + THE FULL NEW-FEATURE DOM/ROUTE
// CONTRACT for the Phase 29 Session Planner re-skin's e2e suite
// (phase29-stat-blocks.e2e.mjs, phase29-from-graph-reorder.e2e.mjs,
// phase29-objective-place.e2e.mjs, phase29-dressing-layout-mode.e2e.mjs,
// phase29-wrap-rail.e2e.mjs). NOT itself an *.e2e.mjs file (the
// `npm run test:e2e` glob is test/e2e/*.e2e.mjs), same exemption as
// fixture.mjs/phase26-fixture.mjs/phase27-fixture.mjs/phase28-fixture.mjs --
// every Phase 29 *.e2e.mjs file imports what it needs from here rather than
// each re-deriving the shared contract independently.
//
// THIS IS THE INTERFACE SPEC tasks 29.1-29.6 implement to match. Grounded in
// design/session-planner/README.md (the Claude-Designer handoff, quoted
// directly where a value/behaviour is copied) and plans/phase-29-tasks.md's
// own task list + "Settled decisions." Every route/DOM contract below is
// confirmed NOT to exist yet against the real, current
// session-planner/scene-elements.mjs, session-planner/scenes.mjs and
// review-ui/server.mjs/session-planner-view.js (re-verified by reading the
// actual source, not trusted from the design doc alone) -- every Phase-29
// *.e2e.mjs scenario is EXPECTED TO FAIL right now with either a real HTTP
// 404 (a route that doesn't exist yet), a route that exists but silently
// drops the new field (PATCH .../elements/:elementId today only reads
// `name`/`fields` off the body -- an unrecognized `stat` key is simply
// never looked at), or a Playwright selector-not-found/timeout (new DOM
// that `session-planner-view.js` doesn't render yet). That failure is the
// deliverable of task 29.0, not a bug in these files.
//
// This is an ADDITIVE phase, not a scrap-and-rebuild -- every EXISTING
// Phase 28 route/testid this file's helpers touch (scene creation, element
// creation, promote/demote, narration, propose-updates) is reused completely
// unmodified; phase28-fixture.mjs's own helpers are re-exported below rather
// than re-implemented, exactly as phase28-fixture.mjs did for phase27's.
//
// ===========================================================================
// ISOLATION / ENV-VAR NOTE (part of this contract, per the task instructions)
// ===========================================================================
// setupPhase29Env() is `setupPhase28Env()` UNCHANGED -- this phase introduces
// NO new persisted store. Every new feature below piggybacks on an EXISTING
// store's existing file: `stat` lives as a new field on the SAME SceneElement
// record session-planner/scene-elements.mjs already persists to
// `GM_TOOLS_SCENE_ELEMENTS_DIR`; the from-graph and reorder ops are new
// FUNCTIONS in that same module, same file, same env var; the objective-edit
// route reads/writes the SAME session-planner/scenes.mjs record already
// persisted to `GM_TOOLS_SESSION_SCENES_DIR` (via setupPhase26Env, itself
// inherited by every later setupPhaseNEnv). 29.1 must NOT introduce a new
// `GM_TOOLS_*_DIR` env var for any of §1-§4 below -- doing so would mean a
// second, parallel store nobody asked for. (The Wrap rail, §5 below, needs
// no new store either -- it reads the EXISTING review-state batch store
// through the EXISTING `GET /api/batches/:batchId` route.)
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import {
  setupPhase28Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  createSceneElementViaRoute,
  listSceneElementsViaRoute,
  promoteElementViaRoute,
  demoteElementViaRoute,
  removeElementViaRoute,
  saveNarrationViaRoute,
  getNarrationViaRoute,
  proposeUpdatesForSceneViaRoute,
  fetchGraphViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
} from "./phase28-fixture.mjs";

/** `setupPhase28Env()` verbatim -- see the ISOLATION note above for why no new dirs are added here. */
export const setupPhase29Env = setupPhase28Env;

// ===========================================================================
// 1. STAT BLOCKS -- `SceneElement.stat` (29.1/29.4)
// ===========================================================================
// Data shape (verbatim from design/session-planner/README.md's "Data shapes
// confirmed from the prototypes": `element.stat = {count:2, ac:"13",
// hp:"58 (9d8+18)", speed:"20 ft.", cr:"4 (1,100 XP)",
// foundryActor:"Actor.7fQ2mXnP", raw:"...multiline..."}` -- `count` is the
// ONLY numeric field, everything else is a free-text string so a DM can type
// "13" or "13 (from Studded Leather)" without a schema fight). All fields
// OPTIONAL (a freshly-opened stat block is `{count:1, ac:"", hp:"", ...}`,
// matching the prototype's own `addNpc`/`add stat block` initial value,
// README §C "Stat blocks"). `SceneElement.stat` itself is OPTIONAL/nullable
// -- most elements never carry one.
//
//   session-planner/scene-elements.mjs:
//     - new `StatBlock` zod object: `{count:z.number().optional(),
//       ac/hp/speed/cr/raw/foundryActor: z.string().optional()}.strict()`.
//     - `SceneElement` gains `stat: StatBlock.nullable().optional()`.
//     - `updateElement(world, sceneId, elementId, {name?, fields?, stat?})`
//       -- `stat` SHALLOW-MERGES onto the element's existing `stat` object
//       (creating one from `{}` if the element had none), same merge
//       semantics `fields` already uses -- so `patchSceneElementViaRoute(...,
//       {stat:{ac:"15"}})` on an element with `stat:{hp:"10"}` yields
//       `{hp:"10", ac:"15"}`, never a full-object replace.
//
//   ROUTE (existing path, extended body): `POST /api/scene-planning/scenes/
//   :sceneId/elements/:elementId {world, name?, fields?, stat?}` -> `200
//   {element}` with `element.stat` reflecting the merge above. THIS IS THE
//   RED-NOW CASE this suite's route-level test proves: today's route
//   (review-ui/server.mjs, confirmed by direct read) calls
//   `updateElement(w, sceneId, elementId, {name: body.name, fields:
//   body.fields})` -- a `stat` key on the body is READ BY NOBODY, so a PATCH
//   carrying `{stat:{...}}` returns 200 (never a hard error -- `stat` is
//   just an unrecognized-and-ignored body key, not a schema violation, since
//   the route handler destructures a fixed set of names) but the element's
//   OWN stored `stat` is untouched -- a fresh `GET .../elements` shows
//   `stat` still absent. That's "the route currently drops it," the
//   red-for-the-right-reason this task's own instructions call out
//   explicitly, and it's exactly what phase29-stat-blocks.e2e.mjs's
//   route-level test asserts.
//
//   GET .../elements?world= -> `elements[].stat` echoed once 29.1 lands.
//
// UI (session-planner-view.js, scene page, one per `scene-element-row`):
//   - `[data-testid="add-statblock-chip"][data-element-id]` -- appears in
//     the SAME dashed add-field-chip row as `+ TRIGGER`/`+ GIVES`/... (only
//     when the element has NO `stat` yet -- same "only unfilled things get
//     a chip" rule the existing add-field chips already follow). Clicking
//     it PATCHes `{stat:{count:1, ac:"", hp:"", speed:"", cr:"", raw:"",
//     foundryActor:""}}` and opens the panel below.
//   - `[data-testid="element-statblock-toggle"][data-element-id]` -- the
//     disclosure line, rendered instead of the chip once the element HAS a
//     `stat`. Text content is README §C's own `▸ <statblockRef>  ×N` /
//     `▾ ...` shape (this suite asserts the toggle glyph/count via
//     `textContent`, not a separate data attribute). Click toggles
//     `[data-testid="element-statblock-panel"][data-element-id]` open/closed
//     (view-local, like the existing `openFields` disclosure state).
//   - Inside the open panel, the SAME click-to-edit textarea-swap mechanism
//     as every other editable field in this app (Decision, plans/
//     phase-29-tasks.md's "settled decisions"): each of
//     `[data-testid="statblock-ac"]`/`-hp`/`-speed`/`-cr`/`-raw`/`-foundry"]`
//     is plain text at rest, clicking swaps in the matching `-input"]`
//     testid (a textarea, pre-filled), blur autosaves via the route above
//     (PATCHing only that one sub-key, e.g. `{stat:{ac:"<new>"}}, relying on
//     the shallow-merge to leave every other stat field untouched).
//   - `[data-testid="statblock-count"][data-element-id]` -- plain text
//     `×N`, not click-to-edit. `[data-testid="statblock-count-up-btn"]` /
//     `[data-testid="statblock-count-down-btn"]` -- PATCH `{stat:{count:
//     count+1}}` / `{stat:{count:Math.max(1,count-1)}}` (README's own
//     floor -- a stat block can't go below `×1` via the stepper).
//   - `[data-testid="npc-creature-btn"][data-scene-id]` -- the "▣ NPC or
//     creature" button, alongside `+ Add element`/`◇ From graph`/`✦ Suggest
//     dressing` below the elements list. Creates a NEW scene-local
//     (`kind:'local'`) element via the EXISTING create-element route with a
//     placeholder name AND an already-open, already-empty `stat` in the
//     SAME create call (`POST .../elements {world, name:"New creature",
//     fields:{}, stat:{count:1, ac:"", ...}}` -- this suite asserts the
//     CREATED element already carries a non-null `stat` via a fresh
//     `GET .../elements` re-fetch, matching the prototype's `addNpc`'s own
//     "creates a scene-local element with an open, empty stat block"
//     behaviour, README task-plan's own wording). This is UI-level red
//     today for TWO independent reasons worth keeping straight: the button
//     doesn't exist yet, AND even once clicked, `createElement`'s own zod
//     schema has no `stat` field to accept yet (29.1 must land both the
//     schema change and the create-path support, not just the PATCH path).
//
// `foundryActor` is STORED ONLY (design record's own explicit decision) --
// no route anywhere pushes it to Foundry. This suite never asserts a
// Foundry-side effect from setting it, only that the string round-trips.
//
// ===========================================================================
// 2. FROM-GRAPH PICKER (29.1/29.3)
// ===========================================================================
//   ROUTE: `POST /api/scene-planning/scenes/:sceneId/elements/from-graph
//   {world, entityId, name?}` -> `200 {element}` where `element.kind ===
//   "graph"` and `element.graphEntityId === entityId` (the EXISTING node --
//   `attachExistingNodeAsElement`, per the design record, creates NO new
//   graph node/edge, unlike `promoteElement`). `name` defaults to the
//   entity's own real name (looked up from the live snapshot) when omitted.
//   Confirmed RED today (re-verified by actually running this suite, not
//   just by reading the source): NOT a clean 404 -- `parts.length===6 &&
//   parts[4]==='elements'` also matches the EXISTING PATCH-style
//   element-update route (§ "SCENE-ELEMENTS STORE + ROUTES" in
//   phase28-fixture.mjs §11), which treats the literal string "from-graph"
//   as an `elementId`, calls `updateElement(w, sceneId, "from-graph", ...)`,
//   and that throws "No scene element found" -- `statusForError` maps it to
//   a real `400`. So today's observed failure is `400`, not `404` -- still
//   definitely "the route doesn't really exist," just via a path collision
//   rather than an unmatched route, and it's the concrete reason 29.1 must
//   route `.../elements/from-graph` and `.../elements/reorder` BEFORE the
//   generic `.../elements/:elementId` PATCH handler, not just add a new
//   `if` block anywhere in the file.
//
//   UI: `[data-testid="from-graph-btn"][data-scene-id]` -- alongside
//   `+ Add element`/`▣ NPC or creature`. Click opens
//   `[data-testid="from-graph-picker"][data-scene-id]` (inline, no modal,
//   matching every other inline-panel convention in this app):
//     - `[data-testid="from-graph-search-input"]` -- filters
//       `[data-testid="from-graph-results"]`, listing
//       `[data-testid="from-graph-option"][data-entity-id]` for every graph
//       node NOT already an element in this scene (this suite seeds one
//       eligible + one already-attached node and asserts the already-
//       attached one is excluded). Each option's text includes the entity's
//       name and type (this suite asserts via `textContent`, not a separate
//       data attribute, since the design only specifies display content,
//       not a machine-readable type attribute here).
//     - Clicking an option calls the route above and appends a new
//       `[data-testid="scene-element-row"][data-kind="graph"]` to the list
//       WITHOUT creating a second graph node (this suite re-fetches
//       `GET /api/graph` before/after and asserts the node COUNT is
//       unchanged -- "it never duplicates the node," README §C's own
//       explicit guarantee).
//
// ===========================================================================
// 3. ELEMENT REORDER (29.1)
// ===========================================================================
//   ROUTE: `POST /api/scene-planning/scenes/:sceneId/elements/reorder
//   {world, elementIds}` -> `200 {elements}` -- thin wrapper over the
//   ALREADY-BUILT `reorderElements(world, sceneId, orderedElementIds)` store
//   op (session-planner/scene-elements.mjs, confirmed present but unwired to
//   any route by direct read) -- mirrors the existing Plan-scene reorder
//   route's own shape (`POST /api/scene-planning/plans/:planId/reorder
//   {world, sceneIds}`, server.mjs:1951) exactly, one layer down. Confirmed
//   RED today via the SAME path-collision mechanism §2 above documents --
//   `POST .../elements/reorder` is swallowed by the generic PATCH-by-id
//   handler (`elementId` literally `"reorder"`) and returns `400`, not a
//   clean `404`; 29.1 needs the identical route-ordering fix for both. This
//   suite's route-level
//   test seeds three elements, reorders them, and re-fetches
//   `GET .../elements` asserting the NEW `order` -- no UI affordance is
//   REQUIRED by this suite (drag-and-drop or ↑/↓ buttons are 29.2/29.4's own
//   implementation choice); this task only locks the route contract.
//
// ===========================================================================
// 4. OBJECTIVE EDIT (29.1/29.3)
// ===========================================================================
//   ROUTE (NEW path, confirmed unclaimed by direct read of server.mjs's
//   `/api/session-planner/scenes/*` block -- today a POST to bare
//   `/api/session-planner/scenes/:sceneId` matches nothing, only
//   `.../rename` and `.../fork` do): `POST /api/session-planner/scenes/
//   :sceneId {world, objectiveNote?, name?}` -> `200 {scene}` -- both
//   fields optional/independent (passing only `objectiveNote` leaves `name`
//   untouched and vice versa, matching `updateElement`'s own "only patch
//   what's provided" convention). `updateScene(world, sceneId, {name?,
//   objectiveNote?})` in session-planner/scenes.mjs is the new store
//   function this route wraps -- NOT a rename of the existing `renameScene`
//   (that stays exactly as-is, still name-only, still used by whatever
//   currently calls it). 404 today.
//
//   UI: `[data-testid="scene-objective"][data-scene-id]` -- the SAME
//   click-to-edit textarea-swap contract as `scene-narration`/
//   `scene-place-name` (Decision: "keep the Phase 28 click-to-edit
//   textarea-swap mechanism") -- plain text at rest (the scene's own
//   `objectiveNote`, or empty), click swaps in
//   `[data-testid="scene-objective-input"]`, blur autosaves via the route
//   above. Always rendered (even empty -- same "core header field" status
//   as `scene-narration`, README §C.3 lists it as the THIRD body line,
//   right after the scene name).
//
// ===========================================================================
// 5. PLACE DESCRIPTION + MISSING-DESCRIPTION BANNER + DRAFT-READ-ALOUD (29.3)
// ===========================================================================
//   NO NEW ROUTE -- the place-description grid writes through the EXISTING
//   `POST /api/graph/nodes/:entityId {world, data:{description}}` route
//   (editNodeOp, Phase 12, confirmed live and already reused by this app's
//   place-NAME edit per phase28-fixture.mjs §5) -- editing it ALSO clears
//   the node's unreviewed flag (editNodeOp's own existing behaviour,
//   unchanged, README's own "editing it also clears the node's unreviewed
//   flag" callout for the parallel World-Graph case applies here too since
//   it's the identical route).
//
//   UI (all UI-level red -- none of this DOM exists in session-planner-
//   view.js today, confirmed by direct read):
//     - `[data-testid="scene-place-description"][data-entity-id]` -- the
//       anchor place's `description`, click-to-edit swap contract (same as
//       §4), swapping in `[data-testid="scene-place-description-input"]`.
//       Rendered ONLY when the place HAS a non-empty description (README
//       §C.4/§C.5: an empty description shows the banner INSTEAD, not an
//       empty click-target -- this is the one field in this contract where
//       "always rendered even empty" does NOT apply, a deliberate
//       divergence from §4's objective/narration precedent, called out here
//       so 29.3 doesn't just copy that pattern reflexively).
//     - `[data-testid="missing-description-banner"][data-entity-id]` --
//       rendered INSTEAD of `scene-place-description` when the place's
//       description is empty/null. Clicking it PATCHes the node with
//       `{data:{description:""}}` (seeding an empty-but-present
//       description so `scene-place-description` now renders) and focuses
//       its freshly-swapped-in input -- this suite asserts BOTH the DOM
//       swap (banner gone, `scene-place-description`/-input now present)
//       AND real focus (`page.evaluate(() => document.activeElement...)`)
//       after the click, matching README's own "Clicking seeds an empty
//       description and focuses it."
//     - `[data-testid="draft-read-aloud-link"][data-scene-id]` -- a ghost
//       link, rendered ONLY when `scene-narration` is CURRENTLY EMPTY **and**
//       the place has a real (non-empty) description (README §C.6: "When
//       empty and the place has a description... When the place has no
//       description the link is hidden -- the banner covers that case"; this
//       suite exercises all three states: empty+no-desc -> neither link nor
//       description renders, only the banner; empty+has-desc -> link
//       renders; non-empty-narration+has-desc -> link does NOT render).
//       Clicking it composes `description + objectiveNote` into a narration
//       string (this suite does not pin the EXACT composed text/format,
//       only that the result is non-empty and saved) and saves it via the
//       EXISTING `POST .../narration` route (§12 of phase28-fixture.mjs) --
//       this suite re-fetches `GET .../narration` afterward and asserts a
//       non-empty `text` landed, AND that `scene-narration`'s own displayed
//       text changed in the DOM without a page reload.
//
// ===========================================================================
// 6. SUGGEST DRESSING (29.3)
// ===========================================================================
//   NO NEW ROUTE -- purely client-side keyword matching (README §C, "Below
//   the elements": "Suggest dressing appends up to 3 MUNDANE elements chosen
//   by matching the anchor place's name + description against keyword
//   sets"), then creates each via the EXISTING `POST .../elements` route
//   (plain `kind:'local'` creates, no `stat`/no promotion). The keyword ->
//   items map is REPRODUCED VERBATIM from `design/session-planner/
//   Session Planner.dc.html`'s own `DRESSING` constant (~lines 516-537,
//   confirmed by direct read) -- five keyword groups (forge/smith/foundry/
//   anvil; vault/crypt/tomb/temple/shrine/chapel; waystation/inn/tavern/
//   common/hall; tower/bell/spire; market/dock/harbour/harbor/street/
//   square), each with 3-4 named items, plus a `DRESSING_FALLBACK` 3-item
//   list for a place matching none of them. 29.3 must copy this table
//   verbatim (not re-derive its own) -- the exact item NAMES this suite
//   asserts on are pulled from that same prototype constant, so a
//   re-derived table with different wording would fail this suite even if
//   "equally good," which is intentional (this is the one piece of
//   Suggest-dressing behaviour genuinely worth pinning exactly).
//
//   UI: `[data-testid="suggest-dressing-btn"][data-scene-id]` -- alongside
//   `+ Add element`/`▣ NPC or creature`/`◇ From graph`. Click appends UP TO
//   3 new `scene-element-row[data-kind="local"]` elements (this suite seeds
//   a place named "The Ironwood Forge" with no description and asserts the
//   forge/smith keyword group's items appear -- name-only match, per
//   README's own "matched on name only" toast case) and shows
//   `[data-testid="suggest-dressing-toast"]` -- this suite does not pin the
//   THREE distinct toast copy variants verbatim (README describes them
//   narratively, not as exact strings), only that the toast appears and
//   that clicking it a SECOND time on the same scene still adds new
//   (not duplicate) dressing items, since MUNDANE elements have no identity
//   dedup in this store.
//
// ===========================================================================
// 7. PAGE|CARDS LAYOUT + PREP|RUN MODE (29.5)
// ===========================================================================
//   View-local state only (design record's own "mode/layout are view-local
//   state, not persisted" -- URL stays the sole location source of truth,
//   no new route, no new persisted field anywhere).
//
//   `[data-testid="layout-page-btn"][data-scene-id]` /
//   `[data-testid="layout-cards-btn"][data-scene-id]` -- segmented control.
//   Selecting one sets `[data-testid="scene-elements-list"][data-layout=
//   "page"|"cards"]` (this suite asserts the attribute flips, not a full
//   visual-layout check -- that's 29.2/29.5's own polish concern). Defaults
//   to `"page"` on a fresh page load.
//
//   `[data-testid="mode-prep-btn"][data-scene-id]` /
//   `[data-testid="mode-run-btn"][data-scene-id]` -- segmented control.
//   Selecting Run sets `[data-testid="scene-page"][data-mode="run"]`
//   (default `"prep"`) and, WITHOUT a page reload:
//     - every edit-chrome control this suite already has a testid for
//       (`scene-element-remove-btn`, `scene-element-key-toggle`, the
//       add-field chips, `scene-add-element-row`, `npc-creature-btn`,
//       `from-graph-btn`, `suggest-dressing-btn`) becomes ABSENT from an
//       accessibility/interaction standpoint -- this suite asserts via
//       Playwright's own `.isVisible()` check (matching this project's
//       established "hidden, not removed" convention for chrome that must
//       come back instantly on switching back to Prep) rather than a DOM
//       count of 0.
//     - a MUNDANE element row (`data-kind="local"`, not carrying a `stat`)
//       shows ONLY its `gives` field-line (`[data-testid="scene-element-
//       field"][data-field="gives"]` stays visible; every OTHER field-line
//       on that same row, if any, becomes not-visible) -- "MUNDANE elements
//       collapse to their Gives line only," README §E verbatim. A KEY row
//       (`data-kind="graph"`) is UNCHANGED -- every one of its field-lines
//       stays visible in Run mode (README: "KEY elements stay full").
//     - `[data-testid="wrap-toggle-btn"]` becomes not-visible (README:
//       "the Wrap panel is force-closed" in Run mode) AND, if `wrap-panel`
//       was already open when Run is selected, it closes immediately (this
//       suite opens Wrap, THEN switches to Run, and asserts `wrap-panel`'s
//       visibility flips to false without any extra click).
//   Switching back to Prep restores every one of the above to its normal
//   visibility with no further interaction (this suite round-trips Run ->
//   Prep and re-asserts the Prep-mode baseline).
//
// ===========================================================================
// 8. RESHAPED INLINE WRAP RAIL -- proposal cards (29.6)
// ===========================================================================
//   NO NEW BACKEND -- reuses the EXISTING `GET /api/batches/:batchId`
//   (`batchDetailPayload`, giving per-mutation `op`/`data`/`diff`/`status`/
//   `rationale`) plus the EXISTING per-mutation `POST /api/batches/
//   :batchId/accept|reject {scope:'entity', id:mutationId}` plus the
//   EXISTING `POST /api/batches/:batchId/sync` -- all three confirmed live
//   and unmodified by this task. The `[data-testid="wrap-toggle-btn"]` /
//   `[data-testid="wrap-panel"][data-scene-id]` outer shell (Phase 28) is
//   UNCHANGED; what's NEW is what renders INSIDE the panel once note-intake
//   has produced a real `batchId` -- today's implementation (confirmed by
//   direct read of `session-planner-view.js`'s `buildWrapPanel`) renders
//   ONLY `[data-testid="wrap-review-batch-link"]` linking out to
//   `#review/<batchId>`; there is no inline mutation rendering at all. This
//   suite's UI-level test is therefore red for a genuine DOM-absence
//   reason, not a route problem -- the route-level test below independently
//   proves a real, reachable batch exists to render (seeded via the
//   EXISTING, unmodified `importWriteup()` in-process, mirroring
//   phase28-wrap.e2e.mjs's own established "mock the route boundary, seed a
//   REAL batch" pattern -- never a hand-built review-state batch record).
//
//   UI (all new, inside `wrap-panel`, alongside the EXISTING
//   `wrap-note-intake-result`/`wrap-promote-list` sections -- this suite
//   does not require either of those to be removed, only that the new
//   proposal-card rail appears once a batch is reachable):
//     - `[data-testid="wrap-proposal-card"][data-mutation-id][data-batch-id]`
//       -- one per mutation returned by `GET /api/batches/:batchId`, fetched
//       automatically once note-intake succeeds (no extra click required
//       beyond running note-intake itself -- README §D's blurb is shown
//       immediately: "Read your table notes... proposed N graph edits").
//         - `[data-testid="wrap-proposal-kind-badge"]` -- text content one
//           of `promote` / `field edit` / `new edge` / `new node`,
//           DERIVED client-side from the mutation's own `op`+`diff`
//           (README's own "the design's kind badge... is derivable
//           client-side from op+diff" -- no new server field). This suite
//           seeds an `upsert_entity`-with-no-prior-state mutation (a create)
//           and asserts the badge reads `new node` (the `(created)`
//           sentinel `diff.mjs` already emits for a brand-new entity is the
//           server-side signal this derivation keys off).
//         - `[data-testid="wrap-proposal-diff-removed"]` / `[data-testid=
//           "wrap-proposal-diff-added"]` -- rendered from `diff.from`/
//           `diff.to` (README: "Only render the − row when there is a
//           prior value" -- this suite's create-mutation case has NO prior
//           value, so it asserts `wrap-proposal-diff-removed` has a DOM
//           count of 0 for that card while `-diff-added` is present).
//         - `[data-testid="wrap-proposal-accept"][data-mutation-id]` /
//           `[data-testid="wrap-proposal-reject"][data-mutation-id]` --
//           call the EXISTING per-mutation accept/reject route (§ above).
//           This suite clicks Accept on one card and re-fetches
//           `GET /api/batches/:batchId` asserting THAT mutation's own
//           `status` is now `"accepted"` -- the same real, already-tested
//           route Batch Review's own list/graph modes already use, never a
//           second accept/reject implementation.
//     - `[data-testid="wrap-apply-btn"][data-batch-id]` -- calls the
//       EXISTING `/sync` route (applies only `status==='accepted'`
//       mutations, unchanged). This suite accepts one of two seeded
//       mutations, clicks Apply, and asserts (a) the accepted mutation's
//       entity now appears in a fresh `GET /api/graph` and (b) the
//       still-pending mutation's entity does NOT -- "Apply N to graph" only
//       ever syncs what's been decided, the no-silent-auto-write invariant
//       applying all the way through this reshaped rail exactly as it did
//       for the old link-out-to-#review version.
//
// ---------------------------------------------------------------------------
// Route helpers for the NEW routes §1-§4/§8 above. Deliberately do NOT
// assert res.status === 200 internally (unlike the re-exported Phase 28
// helpers below, which wrap ALREADY-SHIPPED routes) -- these routes don't
// exist yet, so a non-200/404 here IS the expected, correct, "red for the
// right reason" signal task 29.0 exists to produce (mirrors phase28-
// fixture.mjs's own deletePlanViaRoute-under-construction precedent).
// Callers assert on the returned {status, body} themselves.
// ---------------------------------------------------------------------------

/** PATCH-style POST to the EXISTING element-update route -- used for `stat` (§1) and plain name/fields patches alike, matching the route's own real `{world, name?, fields?, stat?}` body shape. */
export async function patchSceneElementViaRoute(base, world, sceneId, elementId, patch) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/elements/${encodeURIComponent(elementId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, ...patch })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** POST .../elements/from-graph (§2) -- 404 until 29.1. */
export async function createFromGraphElementViaRoute(base, world, sceneId, { entityId, name }) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/elements/from-graph`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, entityId, name })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** POST .../elements/reorder (§3) -- 404 until 29.1. */
export async function reorderElementsViaRoute(base, world, sceneId, elementIds) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/elements/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, elementIds })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** POST /api/session-planner/scenes/:sceneId (§4) -- 404 until 29.1. */
export async function updateSceneViaRoute(base, world, sceneId, patch) {
  const res = await fetch(`${base}/api/session-planner/scenes/${encodeURIComponent(sceneId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, ...patch })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export {
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  createSceneElementViaRoute,
  listSceneElementsViaRoute,
  promoteElementViaRoute,
  demoteElementViaRoute,
  removeElementViaRoute,
  saveNarrationViaRoute,
  getNarrationViaRoute,
  proposeUpdatesForSceneViaRoute,
  fetchGraphViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
};
