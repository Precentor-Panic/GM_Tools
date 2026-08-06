# Phase 30 task 30.0 — Frontend structure decision

Read first: `plans/phase-30-tasks.md`, the design record (`.claude/plans/ok-i-m-back-with-dazzling-newt.md`), `design/session-planner/*.dc.html` + `README.md`. This doc is what 30.2–30.4 execute against — don't relitigate the calls below without flagging it.

## 1. File layout

| File | Status | Owns |
|---|---|---|
| `review-ui/public/index.html` | **edited (30.2)** | Add new shell markup as a sibling of the existing `<header class="topbar">`/`<main>` — a new `<div id="app-shell" data-testid="app-shell" hidden>` containing the shell topbar, the surface-specific rail slot, and a `#shell-main` mount point. The existing `<header class="topbar">` + `<main>` + every `<section class="view" id="view-*">` stay **completely untouched** (still the real DOM for every shelved legacy view). `app.js`'s `renderCurrentView` toggles which of the two top-level roots is visible based on the hash's leading segment — see §2. |
| `review-ui/public/app-shell.js` | **new (30.2)** | The designer FRAME + router: topbar (world select synced to `localStorage["gmReview.world"]`, Session planner\|World toggle, Plans/plan/scene breadcrumb), the persistent rail (delegates to the surface-specific rail builder), and dispatch over the `view` enum into `#shell-main`. Exports something like `renderShell(view, arg)` that `app.js`'s existing `renderCurrentView` calls for the `planner`/`world` hash prefixes — **one router, one hashchange listener, one set of nav-cancel hooks** (see §4), not a second parallel routing mechanism. |
| `review-ui/public/session-planner-view.js` | **kept, extended (30.3)** | Already holds the real business logic (API calls, `createFlushableDebounce` autosave, `buildEntityPicker`, stat blocks, Wrap rail, dressing, from-graph, draft-read-aloud). 30.3 adds new exported render functions that build the designer-shaped DOM (`planner-scene-view` etc.) reusing this existing logic — **not** a second copy of it, per `gm-tools-conventions`'s "front-ends are thin wrappers" rule. The OLD chain-view render functions this file also holds stay present and reachable (legacy `#session-planner/<sceneId>` hash, §3) until whichever later wave actually deletes them. |
| `review-ui/public/plans-view.js` | **kept, reused (30.2/30.3)** | `mountEditableList`, `showUndoToast`, `buildEntityPicker` and friends are imported by both the legacy `#plans` view (unchanged) and the new shell's rail/plan-runsheet — same reuse rule. |
| `review-ui/public/world-view.js` | **new (30.4)** | The World surface: containment tree, node detail, contents pane, loose-threads triage, right inspector, scene-drop tray, drag-drop reparent, "Create a scene here." Wired to the existing `GET /api/graph` + graph CRUD ops, plus the 30.1 `scenesForEntity`/`reparentNode` routes. |
| `review-ui/public/graph-view.js` | **kept, superseded-not-deleted** | The force-directed `#graph` standalone view stays as shelved/legacy (reachable by hash) until a later wave explicitly retires it; `world-view.js` does not import from it. |
| `review-ui/public/debounced-save.mjs` | **kept, reused** | Unchanged; both surfaces use it. |
| `review-ui/server.mjs`, `review-ui/public/*.js` other than the above | **untouched in 30.0** | Task boundary — 30.1 (separate task) adds the World backend routes; 30.2–30.4 do the actual wiring. |

## 2. Routing

**One router.** `app.js`'s existing `parseHash`/`renderCurrentView`/single `hashchange` listener stay exactly as they are structurally — no second independent router is introduced. `renderCurrentView` gets two new branches:

```js
else if (view === "planner" || view === "world") renderShell(view, arg);   // app-shell.js
```

and, at the top of `renderCurrentView` (alongside the existing `.view`/`.topnav` toggling), a shell-vs-legacy visibility switch:

```js
const inShell = view === "planner" || view === "world";
document.getElementById("app-shell").hidden = !inShell;
document.querySelector("header.topbar").hidden = inShell;   // legacy chrome
document.querySelector("main").hidden = inShell;             // legacy view sections
```

This keeps the shell's dispatch running through the **same** `renderCurrentView` call that already invokes the 4 nav-cancel hooks unconditionally on every navigation (§4) — a shell hash change is not a special case for that mechanism.

### Hash scheme

| Hash | Surface | `view` | Notes |
|---|---|---|---|
| `#planner/plans` | Session planner | `plans` | Plan shelf (grid of plan cards + New plan). |
| `#planner/plan/<planId>` | Session planner | `plan` | Plan runsheet. |
| `#planner/scene/<sceneId>` | Session planner | `scene` | Scene page. Deep-linkable — a fresh `page.goto` straight to this hash must open the scene directly with no prior click. |
| `#world` | World | — | Containment tree, no node selected. |
| `#world/<entityId>` | World | — | Containment tree with `entityId` selected in the detail/inspector panes. |

All other hashes (`#queue`, `#review/<id>`, `#debt`, `#settings`, `#import`, `#framing`, `#graph`, `#entity/<id>`, `#combat-planning`, `#combat-planning-ingest`, `#scenes`, and — deliberately — the OLD `#plans`, `#plans/<planId>`, `#session-planner/<sceneId>`) still resolve through the existing dispatch table, unmodified, rendered in the legacy chrome (no rail, no shell breadcrumb). **`#plans` and `#planner/plans` are deliberately different hashes** even though they're conceptually "the same idea" — this avoids the ambiguity of one hash string serving two different DOM contracts depending on which nav path reached it. The new nav (shell toggle) only ever points at `#planner/*`; the old `data-nav="plans"` topnav button (now off the new nav, still present in the shelved legacy topbar for direct-hash users) still points at `#plans`. When 30.3 supersedes the Phase 28/29 DOM, `#plans`/`#session-planner/<sceneId>` become pure legacy fallbacks — nothing new is built against them again.

**World contract preserved.** `app-shell.js` reads/writes the exact same `localStorage["gmReview.world"]` key `app.js`'s `initWorldSelect` and every existing view module already read — one shell-owned `<select data-testid="shell-world-select">`, not a second independent world-selection mechanism. Changing it re-renders the current shell view, mirroring `initWorldSelect`'s existing `change` handler.

## 3. What's kept vs. superseded

- **Backend: kept 100%** in this task. 30.1 (parallel/separate task) adds World-only additions (`scenesForEntity` route, `reparentNode` op+route, place-type guard) — nothing here touches `server.mjs`.
- **Every existing route is reused wholesale**: plans/scenes/elements/narration/propose-updates (`/api/scene-planning/*`, `/api/session-planner/*`), graph CRUD (`/api/graph/*`), batch accept/reject/sync (`/api/batches/*`).
- **Phase 29 wiring logic is reused**, not rewritten: `createFlushableDebounce`, `showUndoToast`/`mountEditableList`, `buildEntityPicker`, `makeClickToEditField`, the Wrap rail's `/api/batches/*` delegation, stat-block editing, Suggest-dressing, from-graph picker, draft-read-aloud — all imported by the NEW designer-shaped DOM in 30.3, not reimplemented against it.
- **The Phase 28/29 hand-built DOM/CSS is superseded**, not reused, where it differs from the designer prototypes (the plan shelf, runsheet, and scene-page markup 30.3 replaces). It is **not deleted** in this task — see §5/the retire map below for when.
- **Legacy tools are shelved**, not removed: Queue/Batch Review/Import/Framing/Deferred Debt/Settings/Encounter Builder/Entity/standalone Graph/Scenes-tab stay fully functional, reachable by their existing hashes, rendered without the new rail chrome, off the new nav.

## 4. Preserving the 4 nav-cancel hooks + world contract

`app.js`'s `renderCurrentView` already calls, unconditionally, on every navigation: `cancelActiveScan()`, `flushActiveNoteSave()`, `cancelActiveAssist()`, `cancelActiveCombatPlanningRequest()`. Because the shell dispatch is a branch *inside* `renderCurrentView` (§2) rather than a second router, these fire exactly the same way for a `#planner/*`/`#world*` navigation as for any legacy hash — no new cancel-hook needed, no risk of the shell bypassing them. `app-shell.js` itself does not need to define its own cancellation hooks in 30.0/30.2; if 30.3's ported scene page introduces its own new async/interruptible affordance, it registers into this same existing set rather than creating a fifth parallel mechanism.

## 5. Sequencing note — keeping `master` green between waves

- **30.2** lands `index.html`'s shell markup + `app-shell.js` with the topbar/rail/breadcrumb real, but its main-column mount for `view=plan`/`view=scene` may legitimately **delegate straight to the existing `renderPlansView`/`renderSessionPlanner` legacy render functions** (Phase 28/29 DOM), just mounted inside the new shell's `#shell-main` instead of the old `<main>`. This makes 30.2's own commit green against a *reduced* version of the phase30 contract (shell chrome + rail + `view=plans` shelf) while `view=plan`/`view=scene` temporarily still show old-style DOM under new chrome — an intentional, temporary seam, not a bug. 30.2 should say explicitly in its own commit/report which phase30 assertions it does and does not turn green.
- **30.3** replaces that delegation with the real designer-faithful port (`planner-plan-view`, `planner-scene-view` per this contract), turning the rest of the shell + full Session-Planner-surface phase30 tests green, and is the wave that actually retires the Phase 28/29 DOM/e2e (see the retire map).
- **30.4** adds `world-view.js` and turns the World-surface phase30 tests green; it depends on 30.1's backend landing first (parallel-safe, but 30.4 itself is sequenced after both 30.1 and 30.2).
- Each wave's own commit should leave `npm run test:e2e` fully green **except** for the specific phase30 scenarios that wave doesn't yet implement — never leave a previously-green scenario newly red.

## 6. Testid/route contract locked by this task

The exact DOM/route contract 30.2–30.4 implement against lives in `review-ui/test/e2e/phase30-fixture.mjs` (mirrors the `phase28-fixture.mjs`/`phase29-fixture.mjs` pattern — not itself an `*.e2e.mjs` file). Summary:

- **Shell chrome**: `[data-testid="app-shell"][data-surface="planner"|"world"]`, `[data-testid="shell-surface-toggle-planner"]`/`-world`, `[data-testid="shell-world-select"]`, `[data-testid="shell-breadcrumb"]` with `-plans`/`-plan[data-plan-id]`/`-scene[data-scene-id]` children.
- **Planner rail**: `[data-testid="shell-rail-planner"]` → `[data-testid="shell-plans-list"]`/`[data-testid="shell-plan-item"][data-plan-id]`/`[data-testid="shell-new-plan-btn"]`; `[data-testid="shell-scene-library-list"]`/`[data-testid="shell-scene-library-item"][data-scene-id]`/`[data-testid="shell-scene-library-item-add-btn"]` with dedupe (`shell-add-to-plan-dedupe-notice`) + no-target-plan (`shell-add-to-plan-no-target-notice`) + real add via the existing plan-scenes route + `undo-toast`/`undo-toast-undo-btn`.
- **Main column**: `[data-testid="shell-main"]` → `[data-testid="planner-plans-view"]` / `[data-testid="planner-plan-view"][data-plan-id]` / `[data-testid="planner-scene-view"][data-scene-id]` (with light stub sub-roots `planner-scene-place-header`/`planner-scene-read-aloud`/`planner-scene-elements` — full port is 30.3's job) / `[data-testid="world-surface-root"]`.
- **World surface** (light 30.0 contract, fleshed out in 30.4): `[data-testid="world-tree"]`/`[data-testid="world-tree-row"][data-entity-id]`, `[data-testid="world-detail"][data-entity-id]`, `[data-testid="world-create-scene-here-btn"][data-entity-id]` (place-only, reuses the existing scene-create route), `[data-testid="world-inspector"][data-entity-id]`/`[data-testid="world-inspector-appears-in"]` (backed by the 30.1 route, tolerates today's 404 as an empty list).
- **World-backend routes.** Task 30.1 (a separate, parallel-safe task per the tiering table) landed **concurrently with this task, in this same working tree** (now committed as `ec613b5`), confirmed by directly running this suite (an earlier draft assumed 404 and was corrected once the real run showed otherwise): `GET /api/scene-planning/entities/:entityId/scenes?world=` (`scenesForEntity`) → `200 {appearances:[{scene, roles}]}`, and `POST /api/graph/nodes/:entityId/reparent {world, parentId}` (atomic reparent) → `200 {entityId, parentId, removedEdgeCount, edgeId}`. Both paths match what this task guessed before seeing 30.1 land; only the field names (`parentId` not `newParentId`, `appearances` not `scenes`) differ from the guess — `phase30-fixture.mjs` is written against the real shipped shape. These two routes are the only part of the phase30 suite that is legitimately green already rather than red-for-a-reason; kept in the suite anyway to pin the exact response shape 30.4 consumes. 30.1 also added a **place-type guard directly on `POST /api/session-planner/scenes`** (server.mjs, not `scenes.mjs` itself, which stays pure) — a scene's `locationEntityId`, when it resolves to a known entity, must be `type: "place"` or the route throws. This affects every phase30 fixture that creates a scene: they now anchor at place-type entities throughout.

Full field-by-field detail, including which behaviors are asserted at the UI level vs. the route level, is in `phase30-fixture.mjs` itself — treat that file, not this summary table, as the source of truth for exact assertions.

## 7. e2e keep/retire map

**Do not delete any e2e file in this task.** This is the inventory + classification; deletions happen in the wave noted, at the same commit that lands the replacement DOM (keeps every commit green).

| File | Classification | Retired in | Why |
|---|---|---|---|
| `phase28-navigation-spine.e2e.mjs` | RETIRE-AND-REPLACE | 30.3 | Asserts the old `#plans`/`#plans/<planId>`/`plan-shelf-*`/`plan-detail`/`plan-scene-row` DOM the rebuild replaces with `#planner/*`/`shell-*`/`planner-plan-view`/`plan-scene-row`-equivalent designer DOM. |
| `phase28-scene-page.e2e.mjs` | RETIRE-AND-REPLACE | 30.3 | Old `scene-page`/`scene-place-name`/`scene-narration` chain-view DOM, superseded by the designer scene page. |
| `phase28-scene-elements.e2e.mjs` | RETIRE-AND-REPLACE | 30.3 | Old `scene-elements-list`/`scene-element-row` DOM, superseded. |
| `phase28-wrap.e2e.mjs` | RETIRE-AND-REPLACE | 30.3 | Old `wrap-panel` shell superseded by the designer Wrap rail (though the underlying `/api/batches/*` delegation it proves is reused). |
| `phase28-deletes.e2e.mjs` | RETIRE-AND-REPLACE | 30.3 | Exercises `plan-scene-row-remove-btn`/`beyond-room-drawer` on the old DOM. |
| `phase28-scenes-tab-in-plans.e2e.mjs` | RETIRE-AND-REPLACE | 30.3 | `in-plans-panel`/`in-plans-chip` are Scenes-tab-side, but assert against old Plan DOM/hash for the click-through target. |
| `phase29-stat-blocks.e2e.mjs` | RETIRE-AND-REPLACE | 30.3 | Stat-block DOM lives inside the old scene-page element rows. |
| `phase29-from-graph-reorder.e2e.mjs` | RETIRE-AND-REPLACE | 30.3 | Same — old scene-page DOM. |
| `phase29-objective-place.e2e.mjs` | RETIRE-AND-REPLACE | 30.3 | Same. |
| `phase29-dressing-layout-mode.e2e.mjs` | RETIRE-AND-REPLACE | 30.3 | Same — Page/Cards + Prep/Run + dressing all inside the old scene page. |
| `phase29-wrap-rail.e2e.mjs` | RETIRE-AND-REPLACE | 30.3 | Same — inline Wrap proposal cards inside the old scene page. |
| `plans-crud.e2e.mjs` | RETIRE-AND-REPLACE | 30.3 | Pre-Phase-28 Plans DOM, already superseded once by Phase 28 and now again by the designer shelf. |
| `scene-delete.e2e.mjs` | **KEEP** | — | Scenes-tab delete-scene flow (Deletes-checklist item (b)) — Scenes tab itself is shelved-but-untouched by this rebuild; its own DOM contract is unaffected. |
| `scenes-tab-browse-and-navigate.e2e.mjs` | **KEEP** | — | Scenes tab (`#scenes`) is a shelved legacy view, not touched by 30.2–30.4. |
| `combat-planning-*.e2e.mjs` (11 files) | **KEEP** | — | Encounter Builder is entirely shelved, off-nav, untouched. |
| `graph-popover-accept-mousedown.e2e.mjs`, `graph-zoom-controls-pin.e2e.mjs`, `placement-click-on-existing-node.e2e.mjs`, `popover-delete-dismiss-race.e2e.mjs`, `rubber-band-listener-leak.e2e.mjs` | **KEEP** | — | Standalone force-directed `#graph` is shelved-but-untouched (superseded conceptually by the World surface, but its own DOM/route contract is not modified or deleted by this rebuild). |
| `fixture.mjs`, `phase26-fixture.mjs`, `phase27-fixture.mjs`, `phase28-fixture.mjs`, `phase29-fixture.mjs`, `scene-construction-fixture.mjs`, `combat-planning-fixture.mjs` | **KEEP** (not `*.e2e.mjs`, not run standalone) | — | Fixture/contract files. Once the sibling `*.e2e.mjs` files that import from `phase28-fixture.mjs`/`phase29-fixture.mjs` are retired in 30.3, those two fixture files become dead weight and MAY be deleted at that point too — noted here, decided in 30.3, not now. |

Route-level coverage embedded in the retired files (e.g. `phase28-fixture.mjs`'s route helpers proving `deletePlan`/`plansContainingScene`/scene-elements CRUD/narration routes work) is **backend behavior, not DOM** — those routes are untouched by this rebuild and stay correct; 30.3 should confirm whether any of that route-level coverage needs a lightweight non-DOM regression home before the DOM-level files that currently carry it are deleted (a judgment call left to 30.3, flagged here so it isn't silently dropped).

## Verification (re-run, not just trusted)

- `review-ui` deterministic: `node --test test/*.test.mjs` unaffected (this task adds only e2e + a doc).
- `npm run test:e2e`: existing suite passes unchanged (nothing here touches existing DOM/routes); the phase30 UI-level scenarios are red for the documented reason (selector timeouts — shell/World DOM doesn't exist yet). The two route-level tests against the 30.1 World-backend routes are green, since that task landed concurrently in this same working tree during this task's own execution (see §6 above) — not a gap in this task's own red-confirmation, just an accurate reflection of what was actually true at verification time.
- `foundry_worldFabric`: untouched, baseline diff only.
