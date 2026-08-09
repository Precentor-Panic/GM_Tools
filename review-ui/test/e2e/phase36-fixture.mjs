// Phase 36 task 36.0 -- shared setup + THE FULL CONTRACT for the Phase 36
// "ready to run: the QUIET staged scene push" e2e suite
// (phase36-stage-route-and-ui.e2e.mjs, phase36-flush-ops-shapes.e2e.mjs,
// phase36-pull-imagepath.e2e.mjs). NOT itself an *.e2e.mjs file (the
// `npm run test:e2e` glob is test/e2e/*.e2e.mjs), same exemption as
// fixture.mjs/phase30/34/35-fixture.mjs -- every phase36 *.e2e.mjs file
// imports what it needs from here rather than each re-deriving the shared
// contract independently.
//
// THIS IS THE WRITTEN CONTRACT task 36.1 (foundry_worldFabric module ops)
// and 36.2 (GM_Tools quiet composer + stage-it toggle) implement to match --
// per plans/phase-36-tasks.md's own instruction, 36.0 is a hard dependency
// of both. Grounded in, in order: plans/phase-36-tasks.md (the "Settled
// decisions" + "Grounding facts" sections, binding), .claude/plans/
// ok-i-m-back-with-dazzling-newt.md's Phase 36 section, plans/
// phase-32-bridge-contract.md (v2, amended alongside this file -- the WIRE
// FORMAT this file's flush composer targets) + plans/phase-32-deferred.md
// §2/§3 (pre-designed op shapes, reused verbatim where noted), plans/
// wf-test-setup.md:120-135 (the v14 Level-doc gotcha), wf-mcp-server/lib/
// foundry-ops.mjs (writeFoundryOps/FoundryOpsInFlightError semantics),
// wf-mcp-server/lib/foundry-push-ops.mjs (pushSceneToFoundry, the slice
// 36.2 extends), review-ui/server.mjs's push-scene route + tray/stagecraft/
// scene routes + touchSceneSafely, session-planner/scenes.mjs +
// scene-tray.mjs + stagecraft-store.mjs + token-store.mjs, wf-mcp-server/
// lib/foundry-pull-ops.mjs's upsertStagecraftMap (where background.src is
// currently discarded), and review-ui/test/e2e/phase35-fixture.mjs (the
// header-as-contract convention this file continues).
//
// Every route/DOM contract below is confirmed NOT to exist yet against the
// real, current session-planner-view.js/server.mjs/scenes.mjs/
// stagecraft-store.mjs/foundry-pull-ops.mjs trees (re-verified by direct
// read AND grep before writing this file): `stagedForFoundry`/
// `lastPushedAt` appear nowhere in scenes.mjs; `POST .../scenes/:id/stage`
// appears nowhere in server.mjs's route table; `foundryRef.imagePath` is
// never set by upsertStagecraftMap (only `foundryRef.sceneUuid`);
// `touchSceneSafely` is called from exactly one place inside the tray/drop
// route (the creature-first-occurrence branch only) and NOWHERE in
// tray/remove, tray/budget, or stagecraft/:id/accept; `POST
// /api/foundry/sync-now`'s response has no `pushed` key. Every phase36
// *.e2e.mjs UI-level scenario is therefore EXPECTED TO FAIL right now with
// a Playwright selector-not-found/timeout error, and every phase36
// *.e2e.mjs route-level/ops-file scenario is EXPECTED TO FAIL with either a
// real HTTP 404 or a clean assertion failure against the REAL, already-
// shipped route's current (pre-36.2) behavior. That failure is the
// deliverable of task 36.0, not a bug in these files.
//
// ===========================================================================
// §1. Scene additive fields (session-planner/scenes.mjs)
// ===========================================================================
// `stagedForFoundry: boolean` (default `false`) and `lastPushedAt: string |
// null` (default `null`) join the Scene record. Additive-optional, per
// scenes.mjs's own already-established convention for `updatedAt`/
// `foundrySceneRef` (that module has no `SCHEMA_VERSION` constant to bump --
// "a scene persisted before this change simply has no key, treated
// identically to the default"). `createScene`/`forkScene` both start a new
// scene with `stagedForFoundry: false, lastPushedAt: null` (a fork does NOT
// inherit staged-ness, same reasoning already documented for `name`/
// `foundrySceneRef`: a fork is a materially different scene instance, and
// silently mirroring the parent's live-in-Foundry status onto it would be
// surprising).
//
// `stagedForFoundry` is patched through `updateScene`'s EXISTING patch-key
// vocabulary (join the same `undefined`-means-untouched merge convention as
// `name`/`objectiveNote`/`foundrySceneRef`/`locationEntityId`) -- toggling it
// IS a genuine "this scene record was touched" event, so `updateScene`'s own
// unconditional `updatedAt` re-stamp on every patch call is CORRECT here,
// not a problem (see §5's dirty-predicate discussion for why).
//
// `lastPushedAt`/`foundrySceneRef` write-back after a successful push is
// DIFFERENT -- see §5 "Write-back must not race-clobber a concurrent edit"
// below for why this does NOT reuse `updateScene` and instead needs a new,
// narrower `markScenePushed(world, sceneId, {foundrySceneRef?, lastPushedAt})`
// that touches ONLY those two fields and deliberately never re-stamps
// `updatedAt`.
//
// ===========================================================================
// §2. NEW route: POST /api/session-planner/scenes/:id/stage
// ===========================================================================
//   POST /api/session-planner/scenes/:id/stage   {world, staged:boolean}   -> {scene}
// Thin wrapper: `updateScene(world, id, {stagedForFoundry: !!body.staged})`.
// Unknown `id` -> the same "No scene found" 404 every other scene route
// already produces (statusForError's `/not found/i` rule). Toggling `staged`
// to `true` is one of the two flush TRIGGERS (§5) -- toggling it `false`
// schedules nothing (a no-op flush would find the scene no longer dirty-
// eligible anyway, since the dirty predicate requires `stagedForFoundry ===
// true`).
//
// ===========================================================================
// §3. touchSceneSafely additions (review-ui/server.mjs)
// ===========================================================================
// Exact routes that gain a `touchSceneSafely(w, sceneId)` call, none of
// which call it today (grep-confirmed against the real file before writing
// this):
//   - `POST .../tray/drop` -- currently calls it ONLY inside the "creature,
//     first occurrence, new element created" branch. Extended to call it
//     UNCONDITIONALLY for every successful drop of every kind
//     (creature/hero/asset), including a creature's SECOND+ drop (roster
//     stacking only, no new element) -- any tray-roster change is itself a
//     "this scene's ready-to-run content changed" event, not just the
//     first-occurrence element-creation side effect.
//   - `DELETE .../tray/:kind/:id` (tray remove) -- gains it unconditionally
//     on a successful removal (a roster removal is exactly the same class of
//     "content changed" event as a drop).
//   - `POST .../tray/budget` (tray budget) -- gains it unconditionally (an
//     XP budget isn't itself pushed to Foundry, but per this project's
//     existing `touchScene`-on-any-tray-write precedent it's simplest and
//     safest to touch on every tray mutation uniformly rather than
//     special-casing budget-only as exempt).
//   - `POST /api/session-planner/stagecraft/:id/accept` (stagecraft accept)
//     -- gains a FAN-OUT touch, not a single-scene one: after accepting,
//     scan `scene-tray.mjs`'s per-world tray records for every
//     `{kind:'asset', id: assetId}` roster row (across ALL scenes in that
//     world) and call `touchSceneSafely` for each matching `sceneId`.
//     Reasoning: an asset's proposed->accepted transition doesn't change the
//     SCENE record, but changes whether the flush composer may legally use
//     it (only ACCEPTED stagecraft assets are eligible for
//     background/foreground/create_journal_image inclusion, §5 -- an
//     unreviewed proposal must never be silently pushed), so every staged
//     scene referencing this asset needs re-evaluation on the next flush.
//
// TRIGGER WIRING (see §5's debounce mechanism): `touchSceneSafely` itself
// becomes the single choke point that ALSO fires the flush-schedule hook --
// after a successful touch, read the scene back and call
// `scheduleFlush(world)` if-and-only-if `scene.stagedForFoundry === true`.
// The `/stage` route (§2) and any direct `updateScene`/`renameScene` call on
// a scene RECORD (name/objective edits) do the same after a successful
// write. This means 36.2 does NOT need a bespoke trigger call at every one
// of the sites above independently -- extending `touchSceneSafely` (plus the
// 2-3 direct scene-record-patch call sites) is the ONE place the hook lives.
//
// ===========================================================================
// §4. Pull capture: foundryRef.imagePath (wf-mcp-server/lib/foundry-pull-ops.mjs)
// ===========================================================================
// `upsertStagecraftMap` (foundry-pull-ops.mjs:199-220) currently builds:
//   { name, source:"foundry", meta, foundryRef:{sceneUuid: scene.uuid} }
// Gains `imagePath` (additive optional key on `foundryRef`) whenever
// `scene.background?.src` is a non-empty string (the existing
// `hasUsableBackground` guard already computes exactly this condition, just
// never threads the value itself into `foundryRef`):
//   foundryRef: { sceneUuid: scene.uuid, imagePath: scene.background.src }
// A scene with no usable background is UNCHANGED (still filtered out
// entirely by the existing `hasUsableBackground` gate -- README §H's "a null
// background has nothing findable" -- there is no map asset row to attach
// `imagePath` to in that case).
//
// StagecraftAsset ALSO gains a second additive optional field this phase,
// `localFilePath: string | null` (default `null`) -- NOT populated by the
// pull path (a Foundry-sourced map already has `foundryRef.imagePath`,
// which is a Foundry-relative path Foundry can already resolve, needing no
// copy). This field exists for a HAND-ADDED `source:'local'` asset (a
// splash/map Russell points at a file on his own filesystem, outside
// Foundry's data dir) -- it is the one thing the §5 flush composer's local-
// copy step needs and nothing in the pre-Phase-36 `StagecraftAsset` shape
// provides (`meta` is explicitly documented as "free-form display string,
// not parsed back", so it cannot double as a real path). Out of scope for
// 36.0/36.1 to POPULATE (no UI/route yet writes it) -- flagged here because
// the flush composer's src-resolution order (§5) depends on it existing as a
// field, even before anything writes a real value into it.
//
// ===========================================================================
// §5. Flush semantics -- THE quiet-push engine's full contract
// ===========================================================================
//
// --- Dirty predicate ---
//   dirty(scene) = scene.stagedForFoundry === true
//                  && (scene.lastPushedAt === null || scene.updatedAt > scene.lastPushedAt)
// A never-pushed staged scene (`lastPushedAt === null`) is ALWAYS dirty
// regardless of how old `updatedAt` is (there is nothing to compare against
// yet -- "never pushed" always needs a push). A previously-pushed scene is
// dirty only if it has been touched again since.
//
// --- Write-back must not race-clobber a concurrent edit (pinned decision,
//     flagged as open in the task plan) ---
// `lastPushedAt` is stamped to the scene's own `updatedAt` VALUE AS READ AT
// COMPOSE TIME (the moment the flush engine builds the ops for this scene),
// NOT wall-clock "now" at result-received time. Reasoning: a push is
// asynchronous (write ops -> poll up to 7s -> read results) -- if a scene is
// edited AGAIN while a push for its PRIOR state is still in flight, and the
// write-back stamped "now" (a timestamp always later than that edit), the
// dirty predicate would go permanently false even though the edit was never
// actually reflected in what got pushed, silently dropping it forever. Using
// the compose-time `updatedAt` snapshot instead means: if a later edit lands
// before the result comes back, its own `updatedAt` is strictly greater than
// the (now-stale) `lastPushedAt` being written, so the scene correctly stays
// (or becomes) dirty again and gets picked up on the NEXT flush trigger.
// This is why `markScenePushed` (§1) is a NEW, NARROW store function rather
// than a reuse of `updateScene`'s patch vocabulary -- `updateScene`
// unconditionally re-stamps `updatedAt` to ITS OWN call-time `now` on every
// call (Phase 30's documented behavior), which would itself become the
// race: a concurrent edit's route call and the push write-back's call could
// land in either order, and whichever lands LAST would clobber the other's
// `updatedAt`, silently losing either the edit-is-newer signal or the
// legitimate "just got pushed" state. `markScenePushed` sets ONLY
// `foundrySceneRef`/`lastPushedAt`, never touching `updatedAt` at all, so no
// ordering between it and a concurrent record-edit route call can clobber
// anything.
//
// --- Create-vs-update composition ---
// `scene.foundrySceneRef == null` -> compose a `create_scene` op.
// `scene.foundrySceneRef != null` -> compose an `update_scene` op targeting
// that `sceneUuid`, `patch` carrying the same field set as create's `data`
// MINUS `tokens` (update_scene's contract shape, plans/
// phase-32-bridge-contract.md v2 §2, has no `tokens` key -- see the
// "update-path never re-emits token/journal-image ops" limitation below for
// why that's deliberate, not an oversight).
//
// --- Background/foreground field population (both create and update) ---
// Exactly ONE accepted `kind:'map'` roster asset (in roster order, first
// match) determines `background`; if the roster has zero accepted map
// assets, `background` is OMITTED from the op entirely (not `null`, not an
// empty string -- matches this contract's "additive-only" omit-not-null
// convention) -- Russell may stage a scene with no map yet (a splash-only or
// bare scene push is still a valid "get something into Foundry" action).
// Extras beyond the first accepted map asset are SKIPPED with a recorded
// reason (`"only one map per scene push, first-pass"`) -- multi-map scenes
// are a known, deliberate first-pass limitation.
// `foreground`/`create_journal_image` follow the identical "first accepted
// kind:'splash' roster asset, extras skipped-with-reason" rule,
// independently of the map rule (a scene may carry both a map AND a splash
// at once).
//
// --- Map/splash src resolution order (per asset) ---
//   1. `foundryRef.imagePath` (§4) -- used AS-IS, already a Foundry-
//      resolvable path.
//   2. `source === 'local'` AND `localFilePath` (§4) is a non-empty string
//      -- `fs.copyFile(localFilePath, <foundrydata>/worlds/<world>/
//      scenes-from-gmtools/<basename(localFilePath)>)` (deferred §3d(a)'s
//      recommended direct-filesystem-copy answer, reused verbatim -- both
//      repos are co-located on this host). The op's `src` field becomes the
//      Foundry-relative path `worlds/<world>/scenes-from-gmtools/<filename>`
//      (mirrors how `mapSrc` was already documented as "already-a-path-in-
//      Foundry's-data-dir" for the 32.3 slice this extends). The copy MUST
//      happen and succeed BEFORE the op referencing it is written into the
//      batch -- an op must never reference a path that doesn't exist yet.
//   3. Neither resolves -> SKIP this asset entirely with a recorded reason
//      (`"no image source available for asset <id>"`) -- never write a
//      guessed/fabricated src.
//
// --- Token composition (roster creatures/heroes) ---
// Only roster rows whose underlying record (`BestiaryEntry` for
// `kind:'creature'`, `PartyMember` for `kind:'hero'`) has `status ===
// 'accepted'` AND a non-null `foundryActorRef` are eligible -- an
// unaccepted/proposed roster occupant, or one with no linked Foundry actor
// (hand-authored, never pulled), is SKIPPED with a recorded reason (never
// silently omitted without a trace, and never a guessed/fabricated
// `actorUuid`). Each eligible row expands to `n` individual token placements
// (the roster's own stack count) -- e.g. a `{id, n:3, kind:'creature'}` row
// with a linked bestiary entry emits THREE `create_token` ops, one per
// individual.
//
// --- Token cluster layout (pinned, first-pass -- "a grid-step cluster at
//     scene center") ---
// `DEFAULT_CANVAS` / `DEFAULT_GRID_SIZE` below are the fallback when the
// scene op being composed carries no `width`/`height`/`grid.size` of its own
// (the common case for a scene with no map yet, or a map asset whose real
// dims aren't captured this phase). When the SAME op's own `data.width`/
// `data.height` ARE present, center = `{x: width/2, y: height/2}`; the grid
// step = `data.grid.size` if present, else `DEFAULT_GRID_SIZE`. Exported
// `clusterTokenPositions(count, {center, gridSize})` below is the exact,
// deterministic formula 36.2 must reuse (not reinvent) -- arranges `count`
// points on a centered square-ish grid, `ceil(sqrt(count))` columns, one
// grid-step apart, in roster order (creatures first, then heroes; each
// row's own `n` copies consecutive).
//
// --- Splash/journal-image composition ---
// `create_journal_image.data = { imageSrc: <resolved src>, journalName:
// asset.name, pageName: asset.name }` (no `folder`, not populated this
// phase). Composed ONLY on the scene's CREATE path (see the limitation
// immediately below) -- same restriction as token placement.
//
// --- KNOWN LIMITATION, pinned deliberately (flagged in 36.0's own report,
//     not silently absorbed): update-path never re-emits token/
//     journal-image ops ---
// `create_token` has no per-token stable id in this wire format (plans/
// phase-32-deferred.md §2's own flagged gap, restated in the v2 bridge
// contract) -- there is no way to "upsert" a previously-placed token, only
// to create a new one. If every dirty-flush of an ALREADY-PUSHED scene
// re-emitted its full roster's `create_token` batch, repeated edits would
// accumulate duplicate tokens in Foundry without bound. The chosen first-
// pass behavior: token/journal-image sub-ops are composed ONLY when
// `scene.foundrySceneRef == null` (the CREATE path, i.e. this scene's very
// first push). An UPDATE-path flush (an already-pushed, since-edited scene)
// composes ONLY the scene patch op itself (name/background/width/height/
// grid/foreground) -- roster changes after the first push do NOT
// re-synchronize tokens onto the live Foundry scene. This trades "tokens can
// go stale after the first push" for "never silently duplicates tokens" --
// the safer failure mode for a quiet, no-push-button feature. A future phase
// with a real per-token stable id (the v2 contract's own flagged gap) would
// remove this limitation.
//
// --- 409 in-flight retry/queue ---
// One flush cycle composes a SINGLE ops array covering EVERY currently-dirty
// staged scene together (a scene's own op group -- scene op, then create-
// path-only token ops in roster order, then create-path-only
// create_journal_image -- stays contiguous; scenes are iterated in
// `listScenesByRecency` order, most-recently-touched first) and writes it
// with ONE `writeFoundryOps` call. If that call throws
// `FoundryOpsInFlightError` (a prior batch -- from ANY source, not
// necessarily this engine -- hasn't cleared yet), the WHOLE cycle is a
// no-op: nothing is marked pushed, nothing is partially applied, and the
// error is swallowed into a `{flushed:0, queued:true, note}`-shaped result
// (never thrown up to a route caller as a 500) -- retried, from scratch
// (fresh dirty-scan, not a replay of the stale composed batch), on the NEXT
// flush trigger.
//
// --- Flush triggers + the exact debounce mechanism (pinned decision,
//     flagged as open in the task plan) ---
// TWO triggers:
//   1. Staged-scene mutation (server-side, debounced ONE TICK). Mechanism:
//      a per-process `let flushScheduled = new Set()` (keyed by world) --
//      the trigger hook (§3's touchSceneSafely/stage-route/record-edit call
//      sites) calls `scheduleFlush(world)`, which does NOTHING if
//      `flushScheduled.has(world)` is already true, else sets it and calls
//      `setTimeout(() => { flushScheduled.delete(world); flushDirtyStagedScenes(world); }, 0)`.
//      "One tick" = a single `setTimeout(..., 0)` macrotask (NOT
//      `process.nextTick`/a microtask, which could starve I/O under a burst
//      of synchronous-ish route calls) -- every trigger that fires within
//      the same macrotask window before the scheduled flush actually runs
//      coalesces into that ONE flush call, which re-reads "which scenes are
//      dirty right now" fresh at fire time (not a snapshot taken at
//      schedule time), so it naturally covers every mutation that happened
//      before it fires regardless of how many separate route calls
//      contributed. `flushScheduled` is cleared BEFORE
//      `flushDirtyStagedScenes` runs (not after) so a mutation arriving
//      WHILE a flush is actively in flight (e.g. blocked on the 7s poll)
//      schedules a genuine follow-up flush rather than being silently
//      absorbed into the in-flight one.
//   2. Sync-now: `POST /api/foundry/sync-now {world}` (an EXISTING,
//      REUSED route, Phase 34) gains a `pushed` key in its response,
//      additive alongside the existing `pulled`/`indexAgeMs`/`state` --
//      `{flushed: number, results: object[], skipped: object[]}`
//      (`skipped` = the src-resolution/eligibility skip reasons, §5 above).
//      The push half runs UNCONDITIONALLY, independent of the pull half's
//      own `state:'off'`-when-no-index early return -- a world with staged
//      scenes but no Foundry index yet must still attempt to flush them
//      (push and pull are independent concerns; gating push on pull's own
//      precondition would silently block "ready to run" for a world Russell
//      hasn't pulled FROM yet, which is a real, valid use case). Sync-now
//      flushes ALL currently-dirty staged scenes for that world in one call
//      (same underlying `flushDirtyStagedScenes(world)` the debounced
//      trigger calls, invoked synchronously/awaited rather than scheduled).
//
// --- Results round-trip ---
// For the scene op itself (`create_scene`/`update_scene`), `ok:true` ->
// `markScenePushed(world, sceneId, {foundrySceneRef: result.foundryUuid ??
// existing, lastPushedAt: <the compose-time updatedAt snapshot>})`.
// `ok:false` -> scene is left untouched (stays dirty, retried next trigger),
// same convention `pushSceneToFoundry` already established. For
// `create_token`/`create_journal_image` sub-ops, NO store write-back on
// success (deferred §2's own "no store write-back needed" reasoning --
// nothing in GM_Tools owns a ref to a placed token or a journal image); a
// sub-op's `ok:false` is recorded into the flush result's own diagnostics
// but does NOT block the scene op's own successful write-back (best-effort,
// not independently retried unless the scene becomes dirty again for an
// unrelated reason -- a known, flagged limitation, not silently dropped).
//
// ===========================================================================
// §6. Exact ops-file JSON shapes -- fixture constants/builders (36.2
//     implements to THESE, 36.1's pure-fn tests consume the SAME shapes --
//     the shared-fixture discipline from Phase 32, reused for Phase 36)
// ===========================================================================
// See `expectedCreateSceneOpData`/`expectedUpdateSceneOpData`/
// `expectedCreateTokenOpData`/`expectedCreateJournalImageOpData` below --
// each returns the `data` object per plans/phase-32-bridge-contract.md v2
// §2 verbatim (opId/kind are asserted separately, since opId is
// dynamically generated per op).
//
// ===========================================================================
// §7. UI/DOM testid contract (36.2 implements against this; this file's own
//     naming decision -- no existing `.dc.html` mockup covers this toggle,
//     since Russell's "no push button, a stage-it toggle" decision postdates
//     the Phase-35 design handoff; the Phase-34 Connection-Menu naming
//     convention -- `conn-panel-<section>` -- is extended, not reinvented)
// ===========================================================================
// SCENE PAGE (mounted on the existing scene page, alongside `[data-testid=
// "scene-objective"]`):
//   `[data-testid="scene-stage-toggle"][data-staged="true"|"false"]` -- the
//   one small toggle affordance (a checkbox/switch, per the locked "NO push
//   button" decision -- this suite only asserts presence + the `data-staged`
//   attribute, not visual styling). Calls `POST .../scenes/:id/stage`.
//   `[data-testid="scene-stage-status-line"]` -- present ONLY when
//   `stagedForFoundry === true` (absent entirely for an unstaged scene, per
//   the "quiet, nothing modal/loud" decision -- no visible line for a scene
//   that was never marked). Text content is the "in Foundry · updated Xm
//   ago" / "in Foundry · not yet pushed" copy -- this suite asserts
//   PRESENCE/absence and that it does NOT contain a push button or any
//   "push"/"sync now" verb (the quiet-line, not an action), not exact
//   copy.
//
// CONNECTION PANEL (`[data-testid="conn-panel-foundry-section"]`, Phase 34):
//   gains `[data-testid="conn-panel-staged-summary"]` -- the quiet "N staged
//   · last push Xm ago" line (matches the panel's existing row idiom, no new
//   visual language per the task's own instruction). This suite asserts
//   presence only when at least one scene in the current world is staged.
//
// ===========================================================================
// Fixture/isolation conventions -- mirrors phase30/34/35-fixture.mjs
// exactly: real in-process createReviewServer({port:0}), real fixture
// seeding via the actual store/route functions where the target already
// exists (scenes/stagecraft/scene-tray/bestiary/party-roster all already
// exist as of Phase 35 -- ONLY the staged-field seed below is a raw-fs
// exception, since no real producer for `stagedForFoundry`/`lastPushedAt`
// exists until 36.2, same class of deliberate exception as phase35-
// fixture.mjs's own `writeFoundryIndexFixture`/`seedItemRecords`).
// `setupPhase36Env` is `setupPhase35Env` verbatim -- no NEW store directory
// is introduced this phase (every additive field lives on an ALREADY-
// gitignored store directory).
// ---------------------------------------------------------------------------
// ===========================================================================
// ADDENDUM — 36.3 live-smoke reconcile (orchestrator, 2026-08-09). The first
// LIVE run of this contract against a real Foundry client surfaced two
// defects in the contract itself; both amended here, in the shape tests, and
// in plans/phase-32-bridge-contract.md, with the implementation updated in
// the same commit:
//   1. CREATE-PATH TOKENS ARE INLINE. §5's original "create_token ops tie to
//      the same batch via ordering/grouping, not a resolved sceneUuid" was
//      unimplementable: the module's create_token creator resolves sceneUuid
//      via fromUuid() and rejected the opId correlation token live
//      ('unresolvable sceneUuid "op_..."'). create_scene.data.tokens[] (which
//      the module ALREADY batch-places post-create) is the create-path
//      carrier; standalone create_token is reserved for a future update path
//      holding a real sceneUuid.
//   2. THE PENDING-PUSH LEDGER. The quiet flush's short poll window
//      (~1.5s default) routinely closes before Foundry's 5s watcher applies
//      the batch, so §5's "no result -> stays dirty, retried next trigger"
//      rule DUPLICATED the scene on retry (the create applied late; its
//      result sat unconsumed; foundrySceneRef stayed null; the retry
//      composed a second create_scene). Amended flow: a queued-after-write
//      cycle records `scene.pendingPush = {opId, snapshotUpdatedAt}` (narrow
//      writer setScenePendingPush, no updatedAt restamp); every flush cycle
//      FIRST reconciles pending scenes against the results file
//      (reconcilePendingResults: ok:true -> markScenePushed with the
//      LEDGER's snapshotUpdatedAt + clear; ok:false -> clear only; consumed
//      entries removed from the results file, unknown entries left for their
//      own poller) and EXCLUDES still-pending scenes from recomposition;
//      the server chains ONE delayed (~8s) follow-up flush after a queued
//      outcome so the loop closes without user action (a still-queued
//      follow-up ends the chain -- no infinite loop when Foundry is closed).
// ===========================================================================
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  setupPhase35Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  fetchGraphViaRoute,
  primeWorldSelection,
  reparentNodeViaRoute,
  writeFoundryIndexFixture,
  pullActorsViaRoute,
  listStagecraftViaRoute,
  addStagecraftTagViaRoute,
  removeStagecraftTagViaRoute,
  fetchSceneTrayViaRoute,
  dropOnSceneTrayViaRoute,
  removeFromSceneTrayViaRoute,
  setSceneTrayBudgetViaRoute,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
} from "./phase35-fixture.mjs";

/** setupPhase35Env() verbatim -- no new store directory this phase (§ header note above). */
export const setupPhase36Env = setupPhase35Env;

// ---------------------------------------------------------------------------
// §5's token-cluster formula -- exported so both this suite's assertions AND
// 36.2's real flush composer can share ONE implementation (shared-fixture
// discipline). Deterministic, pure, no I/O.
// ---------------------------------------------------------------------------
export const DEFAULT_CANVAS = { width: 4000, height: 3000 };
export const DEFAULT_GRID_SIZE = 100;

/**
 * @param {number} count
 * @param {{center?:{x:number,y:number}, gridSize?:number}} [opts]
 * @returns {{x:number,y:number}[]}   `count` points, in a deterministic
 *   generation order, arranged on a centered square-ish grid one `gridSize`
 *   apart -- "a grid-step cluster at scene center" (§5).
 */
export function clusterTokenPositions(count, opts = {}) {
  const center = opts.center ?? { x: DEFAULT_CANVAS.width / 2, y: DEFAULT_CANVAS.height / 2 };
  const gridSize = opts.gridSize ?? DEFAULT_GRID_SIZE;
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const positions = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const offsetX = (col - (cols - 1) / 2) * gridSize;
    const offsetY = (row - (rows - 1) / 2) * gridSize;
    positions.push({ x: Math.round(center.x + offsetX), y: Math.round(center.y + offsetY) });
  }
  return positions;
}

// ---------------------------------------------------------------------------
// §6 -- exact op `data` shape builders, plans/phase-32-bridge-contract.md v2 §2.
// ---------------------------------------------------------------------------

/** create_scene op data -- background/grid/tokens/foreground all OPTIONAL, omitted (never null) when absent. */
export function expectedCreateSceneOpData({ name, backgroundSrc, width, height, grid, tokens, foregroundSrc } = {}) {
  const data = { name };
  if (backgroundSrc !== undefined) data.background = { src: backgroundSrc };
  if (width !== undefined) data.width = width;
  if (height !== undefined) data.height = height;
  if (grid !== undefined) data.grid = grid;
  if (tokens !== undefined) data.tokens = tokens;
  if (foregroundSrc !== undefined) data.foreground = { src: foregroundSrc };
  return data;
}

/** update_scene op data. */
export function expectedUpdateSceneOpData({ sceneUuid, patch }) {
  return { sceneUuid, patch };
}

/** create_token op data. */
export function expectedCreateTokenOpData({ sceneUuid, actorUuid, x, y, img }) {
  const data = { sceneUuid, actorUuid, x, y };
  if (img !== undefined) data.img = img;
  return data;
}

/** create_journal_image op data. */
export function expectedCreateJournalImageOpData({ imageSrc, journalName, pageName }) {
  return { imageSrc, journalName, pageName };
}

// ---------------------------------------------------------------------------
// Ops-file read helper -- direct fs read of the SAME path production code
// writes (wf-mcp-server/lib/snapshot.mjs's foundryOpsPath convention),
// mirroring foundry-push-ops.test.mjs's own established pattern for how
// phase32-era tests fake/inspect the foundry data dir (no live Foundry
// anywhere -- WF_DATA_DIR, set by setupPhase35Env/setupScratchEnv, IS the
// "foundry-data-dir the fixture owns" this task calls for).
// ---------------------------------------------------------------------------

/** @returns {object[]} the parsed ops array, or [] if the file doesn't exist / is empty -- matches production's own readJsonArray tolerance. */
export function readFoundryOpsFileSync(dataDir, world) {
  const path = join(dataDir, "worlds", world, "world-fabric-foundry-ops.json");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

/** Arms a one-shot fake Foundry-side watcher (mirrors foundry-push-ops.test.mjs's armFakeWatcher exactly): after `delayMs`, writes `results` and clears the ops file to "[]". Lets a test observe a real `ok:true` round-trip without a live Foundry client. */
export function armFakeFoundryWatcher(dataDir, world, results, delayMs = 25) {
  const opsPath = join(dataDir, "worlds", world, "world-fabric-foundry-ops.json");
  const resultsPath = join(dataDir, "worlds", world, "world-fabric-foundry-results.json");
  return setTimeout(() => {
    writeFileSync(resultsPath, JSON.stringify(results), "utf8");
    writeFileSync(opsPath, "[]", "utf8");
  }, delayMs);
}

// ---------------------------------------------------------------------------
// Direct-fs seed helper for the staged-scene fields (§1) -- the ONE
// deliberate raw-fs exception this file introduces (see the header note
// above): there is no real producer for `stagedForFoundry`/`lastPushedAt`
// until 36.2 builds the `/stage` route + `markScenePushed`. Patches the
// EXACT on-disk shape scenes.mjs's own worldFilePath/readScenes/writeScenes
// convention uses (`<GM_TOOLS_SESSION_SCENES_DIR>/<world>.json`, a flat
// array) -- a scene created via createSceneViaRoute (the real route) is
// first seeded normally, then this helper patches ONLY the new fields onto
// its existing record, leaving everything else the real route already
// wrote untouched.
// ---------------------------------------------------------------------------
export function seedSceneStaged(world, sceneId, { stagedForFoundry = true, lastPushedAt = null, foundrySceneRef } = {}) {
  const root = process.env.GM_TOOLS_SESSION_SCENES_DIR;
  const path = join(root, `${world}.json`);
  const scenes = JSON.parse(readFileSync(path, "utf8"));
  const scene = scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`seedSceneStaged: no scene "${sceneId}" found on disk for world "${world}"`);
  scene.stagedForFoundry = stagedForFoundry;
  scene.lastPushedAt = lastPushedAt;
  if (foundrySceneRef !== undefined) scene.foundrySceneRef = foundrySceneRef;
  writeFileSync(path, JSON.stringify(scenes, null, 2), "utf8");
  return scene;
}

// ---------------------------------------------------------------------------
// Roster-seed helpers -- ALL real store functions (bestiary-store.mjs/
// party-roster-store.mjs/stagecraft-store.mjs/scene-tray.mjs all already
// exist as of Phase 35), so these are thin composition helpers, not raw-fs
// exceptions, matching this project's own "seed through the real producer
// whenever one exists" convention.
// ---------------------------------------------------------------------------

/**
 * Seeds an ACCEPTED, foundry-linked bestiary entry (does NOT itself drop it
 * into any scene's tray -- callers use the real, already-shipped
 * `dropOnSceneTrayViaRoute(base, world, sceneId, {kind:'creature', id:entry.id})`
 * for that, once per stack count, exercising the real route/touch wiring).
 * Returns the entry.
 */
export async function seedRosterCreature(world, { name, foundryActorRef } = {}) {
  const { saveBestiaryEntry, acceptBestiaryEntry } = await import("../../../combat-planning/bestiary-store.mjs");
  const entry = acceptBestiaryEntry(
    saveBestiaryEntry({ rawFields: { name, hp: 10, ac: 12, challengeRating: 1 }, foundryActorRef }).id
  );
  return entry;
}

/** Seeds an ACCEPTED, foundry-linked party member. Returns the member. */
export async function seedRosterHero(world, { name, foundryActorRef } = {}) {
  const { savePartyMember } = await import("../../../combat-planning/party-roster-store.mjs");
  return savePartyMember(world, {
    name,
    combatRelevant: { class: "Fighter", level: 5, ac: 16, hp: 44, attackBonus: 6, saveDCs: {} },
    buildRelevant: { skills: [], expertise: [] },
    foundryActorRef,
    status: "accepted"
  });
}

/** Seeds an ACCEPTED `kind:'map'|'splash'` StagecraftAsset (foundry-sourced, imagePath set) and returns it. */
export async function seedRosterMapOrSplashAsset(world, { kind, name, imagePath, localFilePath } = {}) {
  const { saveStagecraftAsset, acceptStagecraftAsset } = await import("../../../session-planner/stagecraft-store.mjs");
  const foundryRef = imagePath !== undefined ? { imagePath } : null;
  const asset = saveStagecraftAsset(world, {
    kind,
    name,
    source: imagePath !== undefined ? "foundry" : "local",
    foundryRef,
    status: "proposed"
  });
  const accepted = acceptStagecraftAsset(world, asset.id);
  if (localFilePath !== undefined) {
    // localFilePath (§4) has no dedicated store setter yet this phase -- direct
    // patch, same class of exception as seedSceneStaged, scoped to this one field.
    const { stagecraftRoot } = await import("../../../session-planner/stagecraft-store.mjs");
    const path = join(stagecraftRoot(), `${world}.json`);
    const assets = JSON.parse(readFileSync(path, "utf8"));
    const rec = assets.find((a) => a.id === accepted.id);
    rec.localFilePath = localFilePath;
    writeFileSync(path, JSON.stringify(assets, null, 2), "utf8");
    return rec;
  }
  return accepted;
}

export {
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  fetchGraphViaRoute,
  primeWorldSelection,
  reparentNodeViaRoute,
  writeFoundryIndexFixture,
  pullActorsViaRoute,
  listStagecraftViaRoute,
  addStagecraftTagViaRoute,
  removeStagecraftTagViaRoute,
  fetchSceneTrayViaRoute,
  dropOnSceneTrayViaRoute,
  removeFromSceneTrayViaRoute,
  setSceneTrayBudgetViaRoute,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
};

// ---------------------------------------------------------------------------
// Route helpers, net-new this phase (non-asserting on status -- a non-200
// here IS the expected "red for the right reason" signal, mirroring every
// prior phase-fixture's own under-construction convention).
// ---------------------------------------------------------------------------

/** POST /api/session-planner/scenes/:id/stage {world, staged} -- 404 until 36.2. */
export async function stageSceneViaRoute(base, world, sceneId, staged) {
  const res = await fetch(`${base}/api/session-planner/scenes/${encodeURIComponent(sceneId)}/stage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, staged })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/**
 * POST /api/foundry/sync-now {world} -- ALREADY-SHIPPED route (Phase 34),
 * MUST still return 200 (a genuine regression otherwise) -- but its `pushed`
 * key (§5) does not exist yet, so callers assert on `.body.pushed`
 * themselves rather than this helper asserting a shape that isn't there
 * yet.
 */
export async function syncNowViaRoute(base, world) {
  const res = await fetch(`${base}/api/foundry/sync-now`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world })
  });
  const body = await res.json().catch(() => null);
  if (res.status !== 200) {
    throw new Error(`POST /api/foundry/sync-now must still succeed (it's a reused, already-shipped route) -- got ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}
