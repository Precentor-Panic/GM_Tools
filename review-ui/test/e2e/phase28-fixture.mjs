// Phase 28 task 28.0 -- shared setup + THE FULL DOM/ROUTE CONTRACT for the
// Phase 28 SCRAP-AND-REBUILD e2e suite (phase28-navigation-spine.e2e.mjs,
// phase28-scene-page.e2e.mjs, phase28-scene-elements.e2e.mjs,
// phase28-wrap.e2e.mjs, phase28-deletes.e2e.mjs,
// phase28-scenes-tab-in-plans.e2e.mjs). NOT itself an *.e2e.mjs file (the
// npm run test:e2e glob is test/e2e/*.e2e.mjs), same exemption as
// fixture.mjs/phase26-fixture.mjs/phase27-fixture.mjs -- every Phase 28
// *.e2e.mjs file imports what it needs from here rather than each
// re-deriving the shared contract independently.
//
// THIS IS THE INTERFACE SPEC tasks 28.1-28.6 implement to match. Grounded in
// the design record (.claude/plans/i-m-still-not-sure-compressed-pizza.md,
// "The reframe" + "Recommended design" sections) and
// plans/phase-28-tasks.md's own task 28.0 checklist + "Settled decisions."
// Every route/DOM contract below is confirmed NOT to exist yet against the
// real, current session-planner-view.js/scenes-view.js/app.js/server.mjs
// (re-verified by reading the actual source, not trusted from the design
// doc alone) -- every Phase-28 *.e2e.mjs scenario is EXPECTED TO FAIL right
// now with either a Playwright selector-not-found/timeout error (the new
// `#plans`/`#plans/<planId>` hashes match no dispatch branch in app.js's
// renderCurrentView, and `#session-planner/<sceneId>` still renders the OLD
// chain view, never the new `[data-testid="scene-page"]`) or a real HTTP 404
// from a route that doesn't exist yet (deletePlan, plansContainingScene,
// scene-elements, scene-narration, scene-scoped propose-updates). That
// failure is the deliverable of task 28.0, not a bug in these files.
//
// This is a SCRAP-AND-REBUILD, not an additive phase like 26/27 -- so unlike
// phase26-fixture.mjs/phase27-fixture.mjs, this file intentionally does NOT
// build on session-planner-view.js's old chain-view DOM contract at all. It
// reuses only what genuinely survives: the Plan store routes (already shipped,
// Phase 26, `session-planner/plans.mjs`), the Scene store's create/get/delete
// routes (already shipped, Phase 16/27, `session-planner/scenes.mjs`), the
// graph manual-edit routes (`POST/DELETE /api/graph/nodes`, `POST /api/graph/
// edges`, already shipped, Phase 12), and the review-batch surface
// (`GET /api/batches/:batchId`, `#review/<batchId>`, already shipped).
//
// ===========================================================================
// DESIGN DECISIONS THIS SUITE LOCKS IN (task 28.0's own judgment calls, since
// the design record deliberately leaves exact route/testid shapes to the QE
// pass where it says "e.g." -- documented here so 28.1-28.6's implementers
// match ONE contract, not their own independent guess):
// ===========================================================================
//
// 1. NAV ENTRY: the existing `[data-nav="session-planner"][data-testid=
//    "session-planner-nav"]` topnav button ("Plan Session") is REPURPOSED to
//    `data-nav="plans"` / `data-testid="plans-nav"`, routing to `#plans`
//    (mirroring the existing `data-nav="scenes"`/`data-testid="scenes-nav"`
//    pairing convention exactly). This suite asserts the NEW pairing exists;
//    it does not assert the OLD `session-planner-nav` testid is gone (that's
//    28.2's own implementation freedom -- rename in place vs. add a new
//    button -- this suite only pins the destination behavior).
//
// 2. `#session-planner/<sceneId>` STAYS the scene-page hash (per the design
//    record's own explicit "Keep #session-planner/<sceneId>" decision, to
//    preserve the Encounter-Builder-return and Scenes-tab-open round trips)
//    -- but its RENDER is entirely replaced: `renderSessionPlanner(sceneId)`
//    now renders ONE `[data-testid="scene-page"][data-scene-id]` root, never
//    the old `scene-chain`/`scene-actions-bar`/Table-Mode DOM (all of which
//    this suite's sibling retirement pass (Part B) removes test coverage
//    for). A bare `#session-planner` / `#session-planner/new` (no sceneId)
//    is OUT OF SCOPE for this suite -- the design record's nav spine has no
//    "start a scene with no plan" entry point any more (scene creation is
//    always plan-scoped, via `#plans/<planId>`'s ghost-row).
//
// 3. UNDO TOAST: a single shared, generic pattern used by every reversible
//    remove in this phase (plan-scene-row removal, scene-element removal) --
//    `[data-testid="undo-toast"]` (at most one live at a time -- a second
//    remove while one is showing replaces it, this suite does not pin the
//    exact replace-vs-queue behavior beyond "the LATEST removed thing is
//    always what Undo restores"), containing `[data-testid="undo-toast-
//    undo-btn"]`. Clicking Undo re-creates the removed record via the SAME
//    real route a fresh add would use (`POST .../plans/:planId/scenes` for a
//    plan-scene-row, `POST .../scenes/:sceneId/elements` for a scene-element)
//    -- this suite asserts the OBSERVABLE effect (the row/element is back,
//    verified via a fresh route GET) not an internal "undo slot" mechanism.
//
// 4. ELEMENT FIELD NAMES (mirrors plans/phase-28-tasks.md 28.1's own
//    `fields:{trigger?,gives?,looks?,means?,checks?,function?,wants?,
//    secret?,statblockRef?}` shape verbatim): `trigger`, `gives` are the
//    ALWAYS-CORE fields (rendered even when the row has nothing else);
//    `looks`, `means`, `function`, `wants`, `secret` are OPTIONAL, rendered
//    ONLY when non-empty/non-null on that element. `checks` is an array
//    `[{skill, dc, purpose?}]`, rendered as its own repeated field-line group
//    only when non-empty. Each rendered field-line carries
//    `[data-testid="scene-element-field"][data-field="<fieldName>"]`.
//
// 5. PLACE-NAME EDIT reuses the EXISTING `POST /api/graph/nodes/:entityId
//    {world, data:{name}}` route (editNodeOp, confirmed live, Phase 12) --
//    no new route for renaming a place. This suite asserts persistence via
//    THAT existing route's own observable effect (a fresh `GET /api/graph`
//    shows the new name), never a new session-planner-scoped rename route.
//
// 6. WRAP's "propose graph updates" step is a scene-scoped mirror of the
//    already-shipped Phase 26 `POST /api/scene-planning/plans/:planId/
//    propose-updates` (`assembleWriteupTextForScene`/`proposeUpdatesForScene`,
//    `session-planner/plan-updates.mjs`, 28.1's own bullet) -- SAME response
//    shape (`{batchId, mutationCount, importSummary, suggestions, headline}`),
//    SAME "review-gated, reachable through the existing, unmodified
//    `GET /api/batches/:batchId` route / `#review/<batchId>` screen" contract
//    Phase 26's own post-session-graph-update.e2e.mjs already proved for the
//    plan-scoped version (that file is retired in Part B because its UI
//    trigger point -- Table Mode's `table-active-plan-list` -- is scrapped,
//    but the underlying delegation contract this decision describes is
//    unchanged, just re-pointed at a scene-scoped route + a scene-page
//    trigger). This suite MOCKS the route boundary via `page.route()` for
//    the UI-level test (this project's established "mock at the route
//    boundary for slow/external actions" convention) and separately proves
//    the route-level 404-before-501 shape with a raw fetch.
//
// 7. WRAP's "promote scene-local elements" step reuses the SAME per-element
//    promote route (§8 below) the per-element `⭑` gesture uses -- no second
//    promotion mechanism. The Wrap panel's own contribution is UI-only: a
//    pre-selected, skimmable checklist over the scene's OWN already-loaded
//    scene-local elements, confirmed as one batch action.
//
// ===========================================================================
// 1. NAVIGATION SPINE -- `#plans` (28.2)
// ===========================================================================
//   `[data-testid="plans-shelf"]` -- direct child of `#session-planner-body`
//   OR a new `#plans-body` container (this suite locates content via
//   `[data-testid="plans-shelf"]`/`[data-testid="plans-empty-state"]`
//   directly, not via a specific parent id, so 28.2 has latitude on whether
//   `#plans` reuses `#view-session-planner` or gets its own `<section>`).
//     - `[data-testid="plans-empty-state"]` -- rendered INSTEAD of
//       `plans-shelf` when `listPlansForWorld(world)` is `[]`.
//     - `[data-testid="plan-shelf-item"][data-plan-id]` -- one per Plan,
//       containing `[data-testid="plan-shelf-name"]` (the Plan's own `name`,
//       never a raw id) and `[data-testid="plan-shelf-scene-count"]` (a
//       human count of `plan.sceneIds.length`).
//     - `[data-testid="plan-shelf-open-btn"][data-plan-id]` -- navigates to
//       `#plans/<planId>`.
//     - `[data-testid="plan-shelf-delete-btn"][data-plan-id]` -- opens
//       `[data-testid="plan-shelf-delete-confirm-panel"][data-plan-id]`
//       (a real confirm step, matching this project's established
//       confirm-panel convention) with `[data-testid="plan-shelf-delete-
//       confirm-btn"]`/`[data-testid="plan-shelf-delete-cancel-btn"]`.
//       Confirming calls the NEW `DELETE /api/scene-planning/plans/:planId`
//       route (§9 below) and removes the row; the Plan's OWN scenes are
//       UNTOUCHED (survive, per Decision 2 -- deleting a Plan never deletes
//       a Scene).
//     - `[data-testid="new-plan-btn"]` -- opens
//       `[data-testid="new-plan-panel"]`: `[data-testid="new-plan-name-
//       input"]` + `[data-testid="new-plan-submit-btn"]` +
//       `[data-testid="new-plan-status"]`. Submitting calls the EXISTING
//       `POST /api/scene-planning/plans` route and navigates straight to
//       `#plans/<newId>` (the "open it and start adding scenes" flow this
//       suite treats as the natural next step, per the design record's
//       "make a new plan... open a single plan... edit its contents").
//
// ===========================================================================
// 2. NAVIGATION SPINE -- `#plans/<planId>` (28.2)
// ===========================================================================
//   `[data-testid="plan-detail"][data-plan-id]` -- root for a resolved Plan.
//   An UNKNOWN planId renders `[data-testid="plan-detail-not-found"]`
//   (this suite does not exercise that path beyond it existing).
//     - `[data-testid="plan-detail-name"]` -- the Plan's own name (plain
//       text is sufficient for this suite; click-to-edit on the Plan name
//       itself is NOT required by this phase's checklist and is not
//       asserted here either way).
//     - EMPTY Plan (`plan.sceneIds.length === 0`):
//       `[data-testid="plan-empty-state"][data-plan-id]`, containing ONLY
//       the ghost-row add-scene control below -- NO `plan-scene-list`
//       anywhere in the DOM (mirrors Phase 27's own "a new/empty plan
//       renders a screen whose only construction action is +Add scene").
//     - NON-EMPTY: `[data-testid="plan-scene-list"][data-plan-id]`,
//       containing one `[data-testid="plan-scene-row"][data-scene-id]
//       [data-order]` per `plan.sceneIds` entry, IN `sceneIds` ORDER
//       (`data-order` is that array index, zero-based -- this suite's
//       reorder scenario asserts against this attribute directly, not a
//       visual position, since visual position is comparatively fragile).
//       Each row:
//         - `[data-testid="plan-scene-row-name"]` -- the scene's resolved
//           display name (falls back to its anchor place's name, matching
//           `resolveSceneDisplayName`'s existing precedent).
//         - `[data-testid="plan-scene-row-open-btn"][data-scene-id]` --
//           clicking the row (or this button specifically -- this suite
//           clicks the button, the most robust target) navigates to
//           `#session-planner/<sceneId>` (§3 below).
//         - `[data-testid="plan-scene-row-up-btn"]`/`[data-testid="plan-
//           scene-row-down-btn"]` -- reorder via the EXISTING Plan record
//           (no new reorder route required by THIS suite's own contract --
//           28.1/28.2 may implement it as a client-side reordered array
//           persisted through a POST/PATCH-shaped call of their choosing;
//           this suite asserts the OBSERVABLE effect only: after clicking
//           down on row N, a fresh `GET /api/scene-planning/plans/:planId`
//           shows `sceneIds[N]`/`sceneIds[N+1]` swapped). The up-btn on the
//           FIRST row / down-btn on the LAST row are absent or disabled
//           (this suite asserts absence via `data-testid` count, the
//           simpler of the two to pin).
//         - `[data-testid="plan-scene-row-remove-btn"][data-scene-id]` --
//           hover-affordance in the design record's own language, but this
//           suite does not require actual CSS hover-only visibility (that's
//           a 28.6 polish concern) -- only that the button exists and, when
//           clicked, IMMEDIATELY calls the EXISTING `DELETE /api/scene-
//           planning/plans/:planId/scenes/:sceneId` route with NO confirm
//           step (unlink is reversible -- undo toast, §3 above -- so no
//           blocking confirm, per the design record's explicit "no confirm
//           -- reversible"), removes the row, and shows `undo-toast`.
//           Clicking `undo-toast-undo-btn` re-adds the scene (a fresh
//           `plan-scene-list` reflects it again). The scene record itself
//           is COMPLETELY untouched by a remove-from-plan (this suite
//           re-fetches `GET /api/session-planner/scenes/:id` and asserts
//           200 throughout) -- this is the "Deletes" checklist's own
//           "remove-from-plan (scene survives)" scenario, covered here
//           rather than duplicated in phase28-deletes.e2e.mjs.
//     - Ghost-row add-scene, ALWAYS present (empty or non-empty Plan):
//       `[data-testid="plan-add-scene-row"][data-plan-id]` -- click opens
//       `[data-testid="plan-add-scene-panel"][data-plan-id]`:
//         - `[data-testid="plan-add-scene-place-mode-existing-btn"]`
//           (default active) / `[data-testid="plan-add-scene-place-mode-
//           new-btn"]` -- toggles which sub-panel is shown, mirroring this
//           project's established place-required-flow shape (Phase 26 §3).
//         - EXISTING: `[data-testid="plan-add-scene-place-input"]` /
//           `[data-testid="plan-add-scene-place-results"]` /
//           `[data-testid="plan-add-scene-place-option"][data-entity-id]`
//           (a `buildEntityPicker`-shaped instance, reused).
//         - NEW: `[data-testid="plan-add-scene-new-place-name-input"]` +
//           `[data-testid="plan-add-scene-new-place-submit-btn"]` -- calls
//           the EXISTING `POST /api/graph/nodes {world, name, type:"place"}`
//           route.
//         - Once a place is resolved (either path):
//           `[data-testid="plan-add-scene-contained-in-step"][data-place-
//           entity-id]` -- the design record's "New-location creation"
//           mechanic ("specify a 'contained in' relationship to an existing
//           place... or leave it floating"):
//             - `[data-testid="plan-add-scene-contained-in-yes-btn"]` --
//               reveals `[data-testid="plan-add-scene-contained-in-input"]`/
//               `[data-testid="plan-add-scene-contained-in-results"]`/
//               `[data-testid="plan-add-scene-contained-in-option"][data-
//               entity-id]` (another `buildEntityPicker`-shaped instance,
//               picking the CONTAINER place) + `[data-testid="plan-add-
//               scene-contained-in-confirm-btn"]`, which calls the EXISTING
//               `POST /api/graph/edges {world, sourceId:<the NEW place's
//               own entity id>, targetId:<the picked container's entity
//               id>, relationshipType:"containment"}` route (addEdgeOp) --
//               this suite asserts the created edge's `relationshipType`
//               is literally `"containment"` (§1's already-live
//               `RELATIONSHIP_TYPES` entry, per the design record's own
//               grounding).
//             - `[data-testid="plan-add-scene-contained-in-no-btn"]` --
//               skips edge creation entirely -- the new place stays
//               floating (no containment edge), per the design record's
//               explicit "or leave it floating."
//           This step is ONLY offered when the place was just CREATED
//           (`plan-add-scene-place-mode-new-btn` path) -- picking an
//           EXISTING place skips straight to scene creation below (an
//           existing place's own containment, if any, is none of this
//           flow's business to re-litigate). This suite only exercises the
//           new-place path for this reason.
//         - Either way, once resolved: calls the EXISTING `POST /api/
//           session-planner/scenes {world, locationEntityId}` route, THEN
//           the EXISTING `POST /api/scene-planning/plans/:planId/scenes
//           {world, sceneId}` route to attach it to THIS plan. A new
//           `plan-scene-row` appears (or `plan-empty-state` is replaced by
//           `plan-scene-list` if this was the plan's first scene).
//         - `[data-testid="plan-add-scene-status"]` -- feedback throughout.
//
// ===========================================================================
// 3. NAVIGATION SPINE -- scene page breadcrumb + prev/next (28.2/28.3)
// ===========================================================================
//   Inside `[data-testid="scene-page"]`:
//     - `[data-testid="scene-breadcrumb"]` -- always present.
//       `[data-testid="scene-breadcrumb-back-btn"]` navigates to
//       `#plans/<planId>` for the FIRST plan (stable order: `listPlansFor
//       World`'s own append/creation order, matching `plansContainingScene`
//       §9's own documented order) containing this scene, or to bare
//       `#plans` if the scene belongs to no plan at all (an orphaned scene
//       reached via a direct Scenes-tab open) -- never a dead link.
//     - `[data-testid="scene-breadcrumb-prev-btn"]` /
//       `[data-testid="scene-breadcrumb-next-btn"]` -- step to the
//       previous/next scene in THAT SAME plan's own `sceneIds` order.
//       Absent (not merely disabled -- this suite asserts a real DOM-count
//       of 0) at the first/last position, and absent entirely for an
//       orphaned scene (no plan context to step within).
//
// ===========================================================================
// 4. THE SCENE PAGE -- place header + narration (28.3)
// ===========================================================================
//   `[data-testid="scene-page"][data-scene-id]` -- root.
//     - `[data-testid="scene-place-name"][data-entity-id]` -- the anchor
//       place's resolved name, rendered as plain text AT REST (no visible
//       textarea/input chrome until interacted with -- "invisible at rest").
//       CLICKING it (a real `.click()`) swaps in
//       `[data-testid="scene-place-name-input"]` (a textarea, pre-filled
//       with the current name). Typing + blur (or navigating away) autosaves
//       via the EXISTING `POST /api/graph/nodes/:entityId {world,
//       data:{name}}` route (§5 above) -- this suite asserts the NEW name
//       persists via a fresh `GET /api/graph` re-fetch, not just in-page
//       DOM state. Focus ALONE (this suite drives this via `page.locator(...)
//       .focus()`, which fires a real DOM focus event with NO click) must
//       NOT swap in the input -- `scene-place-name-input` must have a count
//       of 0 after `.focus()` alone, only appearing after an actual
//       `.click()`.
//     - `[data-testid="scene-narration"][data-scene-id]` -- THIS scene's own
//       narration (the design record's explicit "show THIS scene's
//       time-slice only"), same click-to-edit/autosave contract as the place
//       name above, swapping in `[data-testid="scene-narration-input"]` on
//       click. Autosaves via the NEW `POST /api/scene-planning/scenes/
//       :sceneId/narration {world, text}` route (§10 below). Always
//       rendered (even when empty -- an empty narration still needs a
//       click-target to start typing, per the design record's "click-to-edit
//       ... invisible at rest" -- this is the scene page's own CORE header
//       field, not one of the elements list's optional show-only-if-filled
//       fields, so the "only non-empty fields render" rule below does NOT
//       apply to it).
//
// ===========================================================================
// 5. THE SCENE PAGE -- elements list, only-non-empty fields (28.3)
// ===========================================================================
//   `[data-testid="scene-elements-list"][data-scene-id]` -- wraps
//   `[data-testid="scene-element-row"][data-element-id][data-kind="local"|
//   "graph"]`, one per element from `GET /api/scene-planning/scenes/
//   :sceneId/elements` (§11 below), in the store's own `order`.
//     - `[data-testid="scene-element-name"]` -- click-to-edit (same
//       contract as §4), swaps in `[data-testid="scene-element-name-
//       input"]`.
//     - `[data-testid="scene-element-field"][data-field="<name>"]` -- ONE
//       per NON-EMPTY entry in the element's own `fields` object (§4's
//       Design Decision above). An element created with only `trigger` set
//       renders EXACTLY ONE `scene-element-field` (`data-field="trigger"`)
//       -- this suite asserts a `looks`/`means`/`function`/`wants`/`secret`
//       field-line is ABSENT (real DOM-count-0, not merely unpopulated) when
//       that field is null/omitted on the underlying record. Each rendered
//       field-line is ALSO click-to-edit (swaps in `[data-testid="scene-
//       element-field-input"][data-field="<name>"]`), autosaving via the
//       UPDATE route (§11).
//     - KEY rows (`data-kind="graph"`) additionally carry
//       `[data-testid="scene-element-graph-badge"][data-graph-entity-id]`
//       (this suite asserts its presence/absence tracks `data-kind`
//       directly, not a separate visual-only check).
//
// ===========================================================================
// 6. ELEMENTS -- add/promote/demote/remove (28.1/28.3)
// ===========================================================================
//     - `[data-testid="scene-add-element-row"][data-scene-id]` -- a
//       ghost-row, ALWAYS present at the bottom of `scene-elements-list`.
//       Click reveals `[data-testid="scene-add-element-name-input"]`;
//       pressing Enter (or a `[data-testid="scene-add-element-submit-btn"]`,
//       this suite accepts either -- see the test file's own fallback) calls
//       the NEW `POST /api/scene-planning/scenes/:sceneId/elements {world,
//       name}` route (§11) with NO `kind` field, which the store defaults to
//       `kind:"local"` (the design record's explicit "new elements default
//       to MUNDANE/scene-local... never classify importance at creation") --
//       this suite asserts the CREATED element's `kind` is literally
//       `"local"` via a fresh `GET .../elements` re-fetch. The row re-arms
//       (stays present, ready for the next add) rather than closing.
//     - `[data-testid="scene-element-key-toggle"][data-element-id][data-
//       kind="local"|"graph"]` -- ONE per element row, the design record's
//       `Key ⭑` gesture:
//         - on a `local` element: PROMOTES. Calls the NEW `POST
//           /api/scene-planning/scenes/:sceneId/elements/:elementId/promote
//           {world}` route (§11), which (per 28.1's own spec) creates a REAL
//           graph node (`addNodeOp`, `type` defaulting to a reasonable
//           element type -- this suite does not pin the exact `type` string,
//           only that a NEW entity id appears in `GET /api/graph` afterward)
//           AND a REAL `containment` edge from the new node to the scene's
//           OWN anchor place (`addEdgeOp({relationshipType:"containment"})`)
//           -- this suite asserts BOTH via a fresh `GET /api/graph` re-fetch
//           (a node with the returned `graphEntityId` exists; an edge with
//           that `relationshipType` connects it to the scene's anchor).
//           The row's own `data-kind` flips to `"graph"` and a
//           `scene-element-graph-badge` appears.
//         - on a `graph` element: DEMOTES. Calls the NEW `POST .../elements/
//           :elementId/demote {world}` route. The row's `data-kind` flips
//           back to `"local"`, `scene-element-graph-badge` disappears --
//           but the UNDERLYING GRAPH NODE IS NOT DELETED (this suite
//           re-fetches `GET /api/graph` after demoting and asserts the node
//           STILL EXISTS by its entity id -- "demote never deletes the
//           node," the design record's own explicit guarantee).
//     - `[data-testid="scene-element-remove-btn"][data-element-id]` --
//       calls the NEW `DELETE /api/scene-planning/scenes/:sceneId/elements/
//       :elementId {world}` route, removes the row, shows `undo-toast`
//       (§3 above); clicking `undo-toast-undo-btn` re-creates the element
//       (a fresh `GET .../elements` shows it again -- this suite does not
//       pin whether the re-created element keeps its ORIGINAL elementId,
//       only that an element with the same name/fields/kind reappears).
//       Removing a `graph`-kind element does NOT delete its graph node
//       either (same "never auto-touch the graph" invariant as demote).
//
// ===========================================================================
// 7. WRAP -- review-gated, mocked LLM (28.1/28.4)
// ===========================================================================
//   `[data-testid="wrap-toggle-btn"][data-scene-id]` -- top-right of
//   `scene-page` (alongside the eventual `…` overflow, not asserted here).
//   Click opens `[data-testid="wrap-panel"][data-scene-id]` (an inline
//   slide-down, not a modal -- this suite asserts the trigger stays in the
//   SAME page, no navigation, per the design record's "no modals").
//     - Note-intake sub-section:
//       `[data-testid="wrap-note-intake-run-btn"][data-scene-id]` -- calls
//       the NEW `POST /api/scene-planning/scenes/:sceneId/propose-updates
//       {world}` route (§6 above / §12 below). This suite MOCKS this exact
//       route via `page.route()` (matching post-session-graph-update
//       .e2e.mjs's own established precedent for the plan-scoped sibling)
//       for the UI-level test, returning a realistic `{batchId,
//       mutationCount, importSummary, suggestions, headline}` body. On
//       success: `[data-testid="wrap-note-intake-result"]` renders,
//       containing `[data-testid="wrap-review-batch-link"][data-batch-id]`
//       -- this suite clicks it and asserts navigation to `#review/
//       <batchId>` with REAL batch content rendering there (the mocked
//       route's `batchId` is a REAL batch created via the actual
//       review-state machinery in this suite's own setup, exactly matching
//       post-session-graph-update.e2e.mjs's own "mock the route, not the
//       downstream batch" pattern) -- proving "proposes, reachable through
//       the EXISTING unmodified Batch Review screen," never a second/
//       parallel review surface. Nothing writes to the graph merely from
//       opening Wrap or even running note-intake -- only accepting inside
//       the real Batch Review screen does (the standing no-silent-auto-write
//       invariant, unchanged).
//     - Element-promotion sub-section:
//       `[data-testid="wrap-promote-list"][data-scene-id]` -- one
//       `[data-testid="wrap-promote-item"][data-element-id]` per CURRENTLY
//       scene-local (`kind:"local"`) element, each with
//       `[data-testid="wrap-promote-checkbox"][data-element-id]`
//       (pre-checked by default -- the design record's "pre-select the
//       obvious, reject-easy") and
//       `[data-testid="wrap-promote-confirm-btn"][data-scene-id]`.
//       Confirming calls the SAME real per-element promote route (§6) for
//       every CHECKED item only -- this suite asserts (a) merely opening
//       Wrap / merely rendering the checklist promotes NOTHING (a fresh
//       `GET .../elements` still shows every element as `kind:"local"`
//       until confirm is clicked -- "proposes, never auto-writes"), and
//       (b) UNCHECKING an item before confirming leaves THAT element
//       `kind:"local"` while a still-checked sibling becomes `kind:"graph"`.
//
// ===========================================================================
// 8. SCENE-ELEMENT PROMOTE/DEMOTE ROUTES (28.1) -- referenced by §6/§7
// ===========================================================================
//   `POST /api/scene-planning/scenes/:sceneId/elements/:elementId/promote
//   {world}` -> `200 {element}` (`element.kind === "graph"`,
//   `element.graphEntityId` set to a real, freshly-created entity id).
//   `POST /api/scene-planning/scenes/:sceneId/elements/:elementId/demote
//   {world}` -> `200 {element}` (`element.kind === "local"`,
//   `element.graphEntityId` cleared -- the underlying graph node is
//   UNTOUCHED, per §6 above).
//
// ===========================================================================
// 9. deletePlan / plansContainingScene ROUTES (28.1)
// ===========================================================================
//   `DELETE /api/scene-planning/plans/:planId {world}` (body or query,
//   matching the sibling scene-membership DELETE route's own established
//   convention) -> `200 {deleted:true}`. Removes ONLY the Plan record --
//   every scene it referenced survives completely untouched (still fetchable
//   via `GET /api/session-planner/scenes/:id`, still a member of any OTHER
//   Plan). Idempotent-in-shape: deleting an already-deleted/unknown planId
//   must not 500.
//   `GET /api/scene-planning/scenes/:sceneId/plans?world=` -> `200
//   {plans:[...]}` -- every Plan (full record, not just an id) whose
//   `sceneIds` includes this scene, in `listPlansForWorld`'s own stable
//   append order (this suite's breadcrumb-back-btn contract, §3 above,
//   depends on this exact ordering being "first plan created that contains
//   this scene," not an arbitrary/unstable order). `[]` for a scene that
//   belongs to no Plan (never a 404 -- an orphaned scene is a valid, real
//   state per the design record's shared-reference model).
//
// ===========================================================================
// 10. DELETES -- four distinct, guarded (28.1/28.3/28.5)
// ===========================================================================
//   (a) remove-from-plan -- §2 above (`plan-scene-row-remove-btn`), scene
//       survives, undo toast.
//   (b) delete-scene -- the EXISTING, ALREADY-SHIPPED Scenes-tab
//       `scene-list-item-delete` / `-confirm-panel` / `-confirm-btn` flow
//       (unchanged by this suite -- see phase28-fixture.mjs's own sibling
//       note in the retirement pass: scene-delete.e2e.mjs's Scenes-tab
//       scenario and its route-level cascade scenario are KEPT, trimmed of
//       the scene-link-specific assertion only). This suite does not
//       re-test it; it is still covered, still green, still asserts the
//       place entity survives.
//   (c) delete-plan -- §9 above (`plan-shelf-delete-btn`), plan's scenes
//       survive.
//   (d) delete-node-from-graph -- explicit, guarded, reached from the scene
//       page's "beyond this room" drawer (the design record's own disclosure
//       list: "a bottom 'beyond this room' drawer (graph neighbors...)"):
//       `[data-testid="beyond-room-drawer-toggle"][data-scene-id]` opens
//       `[data-testid="beyond-room-drawer"][data-scene-id]` (a real
//       `<details>`, collapsed by default, matching this project's
//       established free/JS-free-collapse precedent), listing
//       `[data-testid="beyond-room-neighbor-item"][data-entity-id]` per
//       graph neighbor of the scene's anchor place (this suite seeds a
//       neighbor via the real `POST /api/graph/edges` route in setup, then
//       asserts it appears here -- no new "neighbors" route required, this
//       reuses the existing `GET /api/graph?filter=all` payload, joined
//       client-side, matching scenes-view.js's own `fetchEntityInfoMap`
//       precedent). Each item carries `[data-testid="beyond-room-neighbor-
//       delete-btn"][data-entity-id]` -- a REAL confirm step (this suite
//       asserts the underlying `DELETE /api/graph/nodes/:entityId` route is
//       NOT called merely from clicking this button, only after confirming)
//       -- `[data-testid="beyond-room-neighbor-delete-confirm-panel"][data-
//       entity-id]` with `[data-testid="beyond-room-neighbor-delete-confirm-
//       btn"]`/`[data-testid="beyond-room-neighbor-delete-cancel-btn"]`.
//       Confirming calls the EXISTING `DELETE /api/graph/nodes/:entityId`
//       route (deleteNodeOp, unmodified) and shows
//       `[data-testid="beyond-room-neighbor-delete-status"][data-cascade-
//       edge-count]` -- the `data-cascade-edge-count` attribute is sourced
//       DIRECTLY from that route's own real `cascadeEdgeCount` response
//       field (this suite seeds a SECOND edge on the deleted neighbor
//       specifically so `cascadeEdgeCount >= 1`, proving the "warns if
//       referenced elsewhere" contract against the engine's own real
//       cascade count, not a guessed/precomputed client-side warning).
//
// ===========================================================================
// 11. SCENE-ELEMENTS STORE + ROUTES (28.1)
// ===========================================================================
//   `session-planner/scene-elements.mjs`: per-scene ordered list,
//   `{id, sceneId, world, kind:'local'|'graph', graphEntityId?, name,
//   fields:{trigger?,gives?,looks?,means?,checks?,function?,wants?,secret?,
//   statblockRef?}, order}` (verbatim shape from plans/phase-28-tasks.md
//   28.1). Routes, all under `/api/scene-planning/scenes/:sceneId/
//   elements*` (matching this file's own established `/api/scene-planning/*`
//   prefix):
//     - `POST .../elements {world, name, kind?, fields?}` -> `200 {element}`
//       (`kind` defaults to `"local"` when omitted, §6 above).
//     - `GET .../elements?world=` -> `200 {elements:[...]}`, in `order`.
//     - `POST .../elements/:elementId {world, name?, fields?}` -> `200
//       {element}` (PATCH-style via POST, matching this file's own
//       `POST /api/graph/nodes/:entityId` precedent).
//     - `DELETE .../elements/:elementId {world}` -> `200 {deleted:true}`.
//     - `POST .../elements/:elementId/promote {world}` -> `200 {element}`
//       (§8 above).
//     - `POST .../elements/:elementId/demote {world}` -> `200 {element}`
//       (§8 above).
//
// ===========================================================================
// 12. SCENE-NARRATION STORE + ROUTES (28.1)
// ===========================================================================
//   `session-planner/scene-narration.mjs`: `sceneId`-keyed, mirrors
//   `entity-narration.mjs`'s history/supersede shape.
//     - `POST /api/scene-planning/scenes/:sceneId/narration {world, text}`
//       -> `200 {narration:{sceneId, text, ...}}` -- saves (supersedes any
//       prior current version, never destructively overwrites history).
//     - `GET /api/scene-planning/scenes/:sceneId/narration?world=` -> `200
//       {narration: {...} | null}` -- the CURRENT version, or `null` for a
//       scene with no narration saved yet (never a 404 -- absence is a
//       valid state).
//
// ===========================================================================
// 13. SCENES TAB -- "In plans:" chips replace "linked scenes" (28.5)
// ===========================================================================
//   `renderSceneListItem`'s existing `[data-testid="scene-list-item-linked-
//   toggle"]` / `[data-testid="linked-scenes-panel"]` mechanism (scenes-view
//   .js, current) is REPLACED (real DOM-absence for the OLD testids --
//   see this suite's own DOM-absence assertion) by:
//     - `[data-testid="scene-list-item-plans-toggle"][data-scene-id]` --
//       same "opens, never closes, idempotent" contract the old linked-
//       toggle established. Opens `[data-testid="in-plans-panel"][data-
//       scene-id]`, backed by the NEW `GET /api/scene-planning/scenes/
//       :sceneId/plans?world=` route (§9 above) -- READ-ONLY (no
//       link/unlink affordance here, matching the design record's "a short
//       label + the list of plans containing the scene").
//     - `[data-testid="in-plans-chip"][data-plan-id]` -- one per plan
//       returned, each showing that plan's OWN `name` (never a raw id).
//       Clicking a chip navigates to `#plans/<planId>` (this suite asserts
//       this -- the one interactive affordance the read-only panel offers,
//       per the design record's own "the list of plans containing the
//       scene," a natural jump-in point).
//     - `[data-testid="in-plans-empty"]` -- rendered instead of any chips
//       when the scene belongs to zero Plans.
//
// ---------------------------------------------------------------------------
// Fixture/isolation conventions -- mirrors phase26-fixture.mjs/phase27-
// fixture.mjs exactly: real in-process createReviewServer({port:0}), real
// fixture seeding via the actual store/API functions (bootstrapSnapshot +
// applyHeadless for graph entities/edges, the real POST /api/session-planner/
// scenes route for scenes, the real Plan routes for plans -- never
// hand-constructed fixture JSON). setupPhase28Env is setupPhase27Env plus TWO
// new store directories (session-planner/scene-elements.mjs, session-planner/
// scene-narration.mjs) that this phase introduces -- same "added when first
// actually exercised" gap every prior new store's own fixture predates (see
// fixture.mjs's own header for the established precedent). The exact env var
// names below (`GM_TOOLS_SCENE_ELEMENTS_DIR`/`GM_TOOLS_SCENE_NARRATION_DIR`)
// are PART OF THIS CONTRACT -- 28.1's two new stores must read these exact
// names (mirroring `GM_TOOLS_SESSION_SCENES_DIR`/`GM_TOOLS_PLANS_DIR`'s own
// naming convention), or every test in this suite that seeds/isolates
// through them silently leaks across test files.
// ---------------------------------------------------------------------------
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  setupPhase27Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
} from "./phase27-fixture.mjs";

/**
 * setupPhase27Env() plus the TWO additional store directories Phase 28
 * introduces (session-planner/scene-elements.mjs, session-planner/
 * scene-narration.mjs) that predate this suite.
 */
export function setupPhase28Env(prefix) {
  const { scratchDir, dataDir } = setupPhase27Env(prefix);
  process.env.GM_TOOLS_SCENE_ELEMENTS_DIR = join(scratchDir, "session-scene-elements");
  process.env.GM_TOOLS_SCENE_NARRATION_DIR = join(scratchDir, "session-scene-narration");
  return { scratchDir, dataDir };
}

// ---------------------------------------------------------------------------
// Route helpers for the NEW routes this suite contracts (§8-§12 above).
// Deliberately do NOT assert res.status === 200 internally (unlike
// createSceneViaRoute/createPlanViaRoute/addSceneToPlanViaRoute above, which
// wrap ALREADY-SHIPPED routes and so may safely treat a non-200 as broken
// test setup) -- these routes don't exist yet, so a non-200/404 here IS the
// expected, correct, "red for the right reason" signal task 28.0 exists to
// produce (mirrors phase27-fixture.mjs's own deleteSceneViaRoute precedent,
// written under the identical not-built-yet condition). Callers assert on
// the returned {status, body} themselves.
// ---------------------------------------------------------------------------

export async function deletePlanViaRoute(base, world, planId) {
  const res = await fetch(`${base}/api/scene-planning/plans/${encodeURIComponent(planId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function plansContainingSceneViaRoute(base, world, sceneId) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/plans?world=${encodeURIComponent(world)}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function createSceneElementViaRoute(base, world, sceneId, fields) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/elements`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, ...fields })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function listSceneElementsViaRoute(base, world, sceneId) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/elements?world=${encodeURIComponent(world)}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function promoteElementViaRoute(base, world, sceneId, elementId) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/elements/${encodeURIComponent(elementId)}/promote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function demoteElementViaRoute(base, world, sceneId, elementId) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/elements/${encodeURIComponent(elementId)}/demote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function removeElementViaRoute(base, world, sceneId, elementId) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/elements/${encodeURIComponent(elementId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function saveNarrationViaRoute(base, world, sceneId, text) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/narration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, text })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function getNarrationViaRoute(base, world, sceneId) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/narration?world=${encodeURIComponent(world)}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function proposeUpdatesForSceneViaRoute(base, world, sceneId) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/propose-updates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** Real GET /api/graph?filter=all round trip (already-shipped route). */
export async function fetchGraphViaRoute(base, world) {
  const res = await fetch(`${base}/api/graph?world=${encodeURIComponent(world)}&filter=all`);
  const body = await res.json();
  return body; // {nodes:[...], edges:[...]}
}

export {
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
};
