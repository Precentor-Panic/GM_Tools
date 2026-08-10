// Phase 37 task 37.0 -- shared setup + THE FULL CONTRACT for the Phase 37
// "Chronicle" e2e suite (phase37-clock-fortune-log.e2e.mjs,
// phase37-advance-atomicity.e2e.mjs, phase37-chronicle-surface.e2e.mjs,
// phase37-review-green-guard.e2e.mjs). NOT itself an *.e2e.mjs file (the
// `npm run test:e2e` glob is test/e2e/*.e2e.mjs), same exemption as
// fixture.mjs/phase3N-fixture.mjs -- every phase37 *.e2e.mjs file imports
// what it needs from here rather than each re-deriving the shared contract
// independently.
//
// THIS IS THE WRITTEN CONTRACT tasks 37.1 (fortune/scope/advance-writer
// wiring) and 37.2 (Chronicle UI) implement TO. Grounded in, in order:
// plans/phase-37-tasks.md ("Settled decisions" -- binding), .claude/plans/
// ok-i-m-back-with-dazzling-newt.md's Phase 37 section + the persona-
// adoption paragraph, design/session-planner/Chronicle.dc.html (pixel/seed-
// shape authority, read in full) + README.md's Chronicle section (the "ONE
// proposal/diff card" reuse discipline), and the real backend this contract
// sits OVER: time-skip/run.mjs (orchestrateBatch, attachDiffs), time-skip/
// run-cycle.mjs (orchestrateCycle), time-skip/scope.mjs (the 5 real modes),
// mutation-engine/pending-ledger.mjs (the deferred-intents ledger),
// mutation-engine/review-state.mjs (createBatch/listBatches/withLock),
// mutation-engine/schema.mjs (Batch/StoredMutation), mutation-engine/
// grain.mjs (summarizeBatch/renderHeadline), session-planner/app-settings.mjs
// (the existing per-world settings store -- calendar row lives here),
// review-ui/server.mjs (route table conventions, `pendingEntitiesPayload`,
// `graphPayloadForBatch`'s `sessionNumber` read), and the phase34/36/38-
// fixture.mjs precedent for this header-as-contract convention.
//
// Every route/DOM contract below is confirmed NOT to exist yet against the
// real, current app-shell.js/server.mjs/mutation-engine/*/time-skip/*/
// session-planner/* trees (re-verified by direct read AND grep before
// writing this file): `world-clock`/`fortune`/`chronicle` appear nowhere in
// server.mjs's route table except the existing placeholder scaffold
// (`[data-testid="chronicle-surface-root"]`, app-shell.js:938, copy-only,
// `renderChronicleSurface` is never called -- confirmed by grep, only
// `renderLibrarySurface` is wired at app-shell.js:1023); `session-planner/
// world-clock.mjs`, `session-planner/fortune-track.mjs`, `session-planner/
// chronicle-run.mjs`, and `review-ui/public/proposal-card.js` do not exist
// anywhere in the tree (confirmed via `ls`); `StoredMutation` has no `type`/
// `risk` fields (schema.mjs read in full, SCHEMA_VERSION 4); `PendingEntry`
// has no `tags` field (pending-ledger.mjs read in full, SCHEMA_VERSION 1).
// Every phase37 *.e2e.mjs UI-level scenario below is therefore EXPECTED TO
// FAIL with a Playwright selector-not-found/timeout error, and every
// route-level scenario is EXPECTED TO FAIL with a real HTTP 404 (server.mjs's
// generic `{error:"No route: METHOD path"}` fallback) -- EXCEPT the
// deliberate green pins named below, which are protecting real, already-
// shipped behavior. That failure is the deliverable of task 37.0, not a bug
// in these files.
//
// ===========================================================================
// §0. NAMING COLLISION FLAGGED EXPLICITLY: two unrelated "sessionNumber"s
// ===========================================================================
// World Fabric's OWN snapshot-meta `sessionNumber` (read at
// review-ui/server.mjs:834/933-937 via `loaded.meta?.sessionNumber`, used
// ONLY by `isSessionStale` for entity-level "hasn't been touched in N
// sessions" staleness) is a DIFFERENT field from the NEW world-clock store's
// own `sessionNumber` this contract defines below. Confirmed by grep (both
// this repo and `/opt/dev/foundry_worldFabric`): World Fabric's
// `meta.sessionNumber` has NO WRITER ANYWHERE -- `graph-import/
// headless-apply.mjs`'s `bootstrapSnapshot` hardcodes it to `0` and nothing
// else ever sets it, in either repo. It is a genuinely dead, read-only
// field today (matches the task's own framing). The Chronicle world-clock
// store's `sessionNumber` (below) is a SEPARATE, GM_Tools-owned, actively-
// written running total with its own meaning (cumulative elapsed-session-
// equivalent total across every Chronicle advance ever made in this world).
// The two must never be confused or unified -- this contract keeps them
// fully independent, on purpose, since unifying them would require writing
// to World Fabric's own snapshot meta (a live-Foundry-only field this
// headless stack cannot safely touch) for no real benefit.
//
// ===========================================================================
// §1. Calendar/world-clock store -- session-planner/world-clock.mjs (NEW)
// ===========================================================================
// Per-world flat JSON, `<worldClockRoot>/<world>.json`
// (`GM_TOOLS_WORLD_CLOCK_DIR`, default sibling `world-clock/`), following
// app-settings.mjs's exact one-file-per-world/withLock convention.
// SCHEMA_VERSION 1. PERSISTED shape: `{currentDate: string, sessionNumber:
// number, updatedAt: string}` -- deliberately does NOT persist `calendar`
// (see the relationship pin immediately below).
//
// CALENDAR RELATIONSHIP (pinned, per the task's own "pin the relationship"
// instruction): `calendar` is SOURCED, ALWAYS, from the EXISTING
// `session-planner/app-settings.mjs` store's own `calendar` field
// (`AppSettings.calendar`, already shipped, Phase 34). world-clock.mjs's
// reader (`getWorldClock(world)`) composes the two stores at READ time --
// `{world, calendar: getSettings(world).calendar ?? null, currentDate,
// sessionNumber, updatedAt}` -- and NEVER writes/duplicates a calendar copy
// of its own. There is no `setCalendar` in world-clock.mjs; changing the
// calendar identity stays exactly where it already is today, `POST
// /api/settings {world, calendar}` (app-settings.mjs's `patchSettings`,
// unmodified). This is the FIRST single-source rule this contract pins (a
// narrower one than the elapsedSessions rule in §2) -- exactly one store
// owns calendar text, exactly one route can change it.
//
// DATE-ADVANCE SCOPE DECISION (flagged, not silently guessed): app-settings'
// own `calendar` field is documented as a free descriptive STRING (its own
// schema comment: "campaign name, game system, calendar... genuinely differ
// world to world"), not a structured month/day/season definition -- there is
// no calendar-math engine anywhere in this codebase to turn "+90 days" into
// a real fantasy month/day string the way the prototype's hardcoded seed
// text ("14 Marrow, 1104") implies. Building one is explicitly OUT OF SCOPE
// for Phase 37 (a real future enhancement, same "noted-not-adopted" posture
// as "everywhere-except-party" scope). `currentDate` is instead a plain,
// GM-legible, generic fallback string derived from an internal day-count:
// default `"Day 0"` for a brand-new world (no advance yet); every
// `advanceWorldClock` call re-renders it as `"Day " + N` where N is the
// running day-count (parsed back out of the stored string -- world-clock.mjs
// owns this parse/render pair privately, `parseDayCount`/`renderCurrentDate`,
// so a future real calendar engine has exactly one place to swap in a
// richer formatter without touching any caller). This is a deliberate,
// documented v1 simplification, not an oversight.
//
// ===========================================================================
// §2. THE ADVANCE WRITER + THE elapsedSessions SINGLE-SOURCE RULE
// ===========================================================================
// `advanceWorldClock(world, span)` -- world-clock.mjs's one write function.
// `span` is EXACTLY ONE of two shapes (never both; passing both is an
// error): `{days: number}` (explicit) or `{spanId: "week"|"month"|"season"|
// "year"|"long"}` (named, resolved via the canonical `SPAN_DAYS` table below
// -- the FIVE ids/labels are copied verbatim from Chronicle.dc.html's own
// seeded `SPANS` array so 37.2's span-chip UI needs zero relabeling):
//
//   SPAN_DAYS = { week: 7, month: 30, season: 91, year: 365, long: 8030 }
//     (long = "a generation" = 22 years x 365, matching the prototype's own
//     "Twenty-two years on" headline text for spanId 'long' verbatim.)
//
// ONE call atomically (single withLock-protected read-modify-write, same
// concurrency discipline as every sibling store):
//   (a) resolves `days = span.days ?? SPAN_DAYS[span.spanId]` (throws on an
//       unresolvable/both-given/neither-given span -- fail fast, per the
//       no-silent-auto-write project's general "fail loud, don't guess"
//       posture);
//   (b) computes `elapsedSessions = clampMin1(Math.round(days / 7))` -- the
//       ONE canonical, deterministic days-to-decay-basis conversion, also
//       exported as `spanToElapsedSessions(days)` so 37.1's route can reuse
//       it rather than re-deriving; floor of 1 matches scope.mjs's own
//       `elapsedSessions ?? 1` default (an advance must always represent at
//       least *some* passage for the decay math, never 0);
//   (c) advances `currentDate` per §1's day-count scheme by `days`;
//   (d) sets `sessionNumber = sessionNumber + elapsedSessions` (the
//       CUMULATIVE running total -- see §0's naming-collision flag; this
//       field is a history/display statistic, read by the chronicle-log's
//       history rail and nowhere else -- see the next paragraph for why it
//       must NEVER be fed back into scope.mjs);
//   (e) persists once, stamps `updatedAt`.
// Returns `{world, calendar, currentDate, sessionNumber, elapsedSessions,
// spanDays: days, updatedAt}` -- `elapsedSessions` here is THIS CALL's own
// per-advance delta (e.g. 13 for a "season"/91-day advance), NOT the
// cumulative `sessionNumber` total.
//
// WHY THE DELTA, NOT THE CUMULATIVE TOTAL, FEEDS THE DECAY MATH (pinned
// explicitly -- the task's own phrasing "the elapsed-sessions basis the
// decay math reads" could be misread either way, so this is the resolved
// reading, with the reasoning that rules it out): `elapsedSessions` is READ
// today at time-skip/scope.mjs's `resolveScope` (every mode except 'seed'
// forwards `scopeSpec.elapsedSessions ?? 1` straight into
// mutation-engine/propagate.mjs's `candidateDeltas`/`ambientDecay`, whose
// formula is `clamp01(from * Math.pow(0.5, elapsedSessions / halfLife))` --
// a HALF-LIFE decay computed FRESH per call). Feeding that formula a
// monotonically-growing CUMULATIVE total (world-clock's own `sessionNumber`,
// which only ever grows) would decay every field toward zero more and more
// aggressively on every subsequent Chronicle run regardless of how much real
// time that specific run represents -- a correctness bug, not a style
// choice; confirmed by reading propagate.mjs's `ambientDecay` directly. The
// PER-CALL delta is therefore the only sane value to pass, and this
// contract pins it as such.
//
// SINGLE-SOURCE ENFORCEMENT (grep-provable, the task's own explicit ask --
// "no second duration input anywhere"):
//   1. `advanceWorldClock` is the ONLY function in this codebase permitted
//      to compute a "how many sessions did this span represent" number (the
//      `spanToElapsedSessions` table lives ONLY in world-clock.mjs; nothing
//      else may define a second such table or inline formula).
//   2. `POST /api/chronicle/run` (§3.4 below, 37.1's run-composition route)
//      is the ONLY call site anywhere in review-ui/server.mjs that is
//      permitted to set `scopeSpec.elapsedSessions` for a Chronicle-produced
//      batch, and it MUST set it from `advanceWorldClock(...).elapsedSessions`
//      (the return value), NEVER from a client-supplied request-body field.
//      The route's own request-body contract (§3.4) has NO `elapsedSessions`
//      key at all -- even if a caller POSTs one, it is silently ignored
//      (not merged, not validated, not used) because the route computes its
//      own value internally and never reads that key off the body. A
//      dedicated red test (phase37-advance-atomicity.e2e.mjs) posts a
//      deliberately-wrong `elapsedSessions:9999` in the request body
//      alongside a real `span`, and once the route exists (37.1), asserts
//      the batch's persisted `scope.elapsedSessions` matches the
//      `spanToElapsedSessions(span)` value, NEVER `9999` -- this is the
//      test that keeps a future implementer honest about the single-source
//      rule even after this contract's own prose is forgotten.
//   3. 37.2's Composer UI has EXACTLY ONE control that can express a
//      duration -- `[data-testid="chronicle-span-control"]` (§4.2) -- shared
//      byte-identically between Composer mode's chip row and Timeline mode's
//      scrubber (mirroring the prototype's own single `state.spanId` field
//      driving BOTH `sc-if` branches, confirmed by direct read of
//      Chronicle.dc.html's Component class). This suite's DOM contract test
//      asserts there is no SECOND numeric/duration-shaped input anywhere in
//      the rendered Chronicle surface (`chronicle-surface-root`) besides the
//      one span control.
//
// ===========================================================================
// §3. Fortune store -- session-planner/fortune-track.mjs (NEW)
// ===========================================================================
// ONE GLOBAL track per world (not per-branch -- per-branch fortune is the
// explicitly noted-future flag). Per-world flat JSON,
// `<fortuneRoot>/<world>.json` (`GM_TOOLS_FORTUNE_DIR`), SCHEMA_VERSION 1.
// PERSISTED shape: `{stopId: FortuneStopId, updatedAt: string}`.
//
// The control's own shape, taken verbatim from Chronicle.dc.html's seeded
// `FORTUNES` array (the "position/bounds/labels" the task asks to pin) --
// FIVE ordered, discrete stops, no continuous slider:
//
//   FORTUNE_STOPS = [
//     { stopId: "bountiful", label: "Bountiful", bias:  2 },
//     { stopId: "fair",      label: "Fair",       bias:  1 },
//     { stopId: "middling",  label: "Middling",   bias:  0 },
//     { stopId: "lean",      label: "Lean",       bias: -1 },
//     { stopId: "ruinous",   label: "Ruinous",    bias: -2 }
//   ]
//
// `bias` (an integer, bounds -2..2 inclusive -- THE "bounds" the task's own
// phrasing asks for) is a NEW, 37.0-added convenience derivation not present
// in the prototype's own seed data (the prototype only ever needed a
// discrete id for its own display) -- added here so 37.1 has a ready-made
// numeric knob to plumb into `orchestrateBatch`'s texture-prompt opts
// (per plans/phase-37-tasks.md's own 37.1 charter: "Fortune bias plumbed
// into the texture prompts") without having to invent its own id-to-number
// mapping ad hoc. `middling` (bias 0) is the default for a world with no
// fortune record yet, matching the prototype's own initial `state.fortune:
// "middling"`.
//
// Route: `GET /api/chronicle/fortune?world=` -> `{world, stopId, bias,
// updatedAt}`. `POST /api/chronicle/fortune {world, stopId}` -> same shape,
// rejects an unknown `stopId` (400, not a silent fallback).
//
// ===========================================================================
// §4. Chronicle-log -- a READ layer, NO new event store
// ===========================================================================
// Per the task's own instruction ("a READ layer over listBatches + the
// time-skip status files -- no duplicate event store"): `chronicle-log`
// itself introduces ZERO new persisted history. It composes, at read time:
//   - `mutation-engine/review-state.mjs`'s EXISTING `listBatches(world)`
//     (already newest-first; already carries `id`/`createdAt`/`status`/
//     `scope`/`elapsedTimeDescriptor`/`mutationCount`/`pendingCount`/
//     `acceptedCount` -- covers `batchRef`("id")/`scope`/`at`("createdAt")
//     of the required `{batchRef, span, scope, fortuneAtRun, at}` shape
//     directly, with ZERO new code);
//   - `mutation-engine/grain.mjs`'s EXISTING `summarizeBatch`+`renderHeadline`
//     (a friendly one-line `headline` per entry, same primitive
//     `time-skip/run.mjs`'s own `orchestrateBatch` return value already
//     uses -- reused, not reimplemented);
//   - the SIDECAR this contract decides+pins below, for the two fields
//     `listBatches` genuinely has no source for: `span` and `fortuneAtRun`.
//
// SIDECAR DECISION (the task's own "likely a small sidecar per batch --
// decide and pin"): `session-planner/chronicle-run.mjs` (NEW), a tiny
// per-batch file `<chronicleRunRoot>/<world>/<batchId>.json`
// (`GM_TOOLS_CHRONICLE_RUN_DIR`), SCHEMA_VERSION 1, shape `{batchId, span,
// fortuneAtRun: FortuneStopId, elapsedSessions, createdAt}`. This is NOT a
// second event log (it carries no history of its own beyond one batch's own
// run-composition metadata, 1:1 keyed to an EXISTING review-state batch file
// that is itself the permanent record) -- it is exactly the same kind of
// "small enrichment file keyed to an existing primary record" pattern
// time-skip/status.mjs already establishes for a batch's OWN texturing
// progress, one level over. Written EXACTLY ONCE, by `POST /api/chronicle/
// run` (§3.4), in the same request that calls `createBatch` (via
// `orchestrateBatch`/`orchestrateCycle`) -- `recordChronicleRun(world,
// batchId, {span, fortuneAtRun, elapsedSessions})`. A batch created by ANY
// OTHER path (a bare `wf_propose_mutations`/`wf_run_cycle` MCP call, a
// writeup-import, a mention-scan) has NO sidecar -- `getChronicleRun`
// returns `null, and the composed chronicle-log entry for that batch
// renders `span: null, fortuneAtRun: null` (a real, valid, distinguishable
// state -- "this batch didn't come from Chronicle's own composer" -- never
// a thrown error or a synthetic guessed value).
//
// Route: `GET /api/chronicle/log?world=` -> `{world, entries:
// [{batchRef, span, scope, fortuneAtRun, at, headline, mutationCount,
// pendingCount, acceptedCount, status}]}`, newest-first (inherits
// `listBatches`' own order, unmodified).
//
// ===========================================================================
// §5. The "queued intents" default scope -- reuses pending-ledger.mjs,
//     no new intents store, decorates the EXISTING /api/pending-entities
// ===========================================================================
// The prototype's left-rail "Deferred" lane (named intents with type/
// source/note/tags, checkable) maps onto `mutation-engine/pending-ledger.mjs`'s
// EXISTING per-entity ledger -- NOT a new store (backend-reuse is the whole
// point of this phase, per the task's own framing). The mapping, pinned
// field-by-field because the two shapes don't line up 1:1 out of the box:
//   - intent "name"      <- the entity's own `name` (graph lookup, already
//                            resolved server-side by the EXISTING
//                            `pendingEntitiesPayload` helper, review-ui/
//                            server.mjs:668 -- confirmed by direct read: it
//                            already returns `[{entityId, name, entries}]`
//                            via the EXISTING, ALREADY-SHIPPED route `GET
//                            /api/pending-entities?world=`).
//   - intent "type"       <- NOT present on `pendingEntitiesPayload` today
//                            (confirmed by direct read). 37.1 ADDS ONE
//                            additive field to that EXISTING function --
//                            `type: findEntity(entities, entityId)?.type ??
//                            null` -- rather than standing up a parallel
//                            route (`findEntity`/`entities` are already in
//                            scope at that call site). This is a REUSE pin,
//                            not a new route.
//   - intent "note"       <- `PendingEntry.causeTag` (already a free-text
//                            string on every entry -- e.g. "ripple from
//                            events at Gorrim's Forge, month 3" -- reused
//                            verbatim, no rename).
//   - intent "source"     <- `PendingEntry.cycleDescriptor` (already a
//                            short free-text label per entry -- reused as
//                            the provenance string; for a HAND-ADDED intent
//                            typed into the Composer's "Add an intent by
//                            hand" input, 37.1's write path sets
//                            `cycleDescriptor: "Manual"`, matching the
//                            prototype's own `source: "Manual"` seed value
//                            verbatim).
//   - intent "tags"       <- NOT present on `PendingEntry` today (confirmed
//                            by direct read). ADDITIVE schema bump:
//                            `PendingEntry` SCHEMA_VERSION 1 -> 2 gains
//                            `tags: z.array(z.string()).optional()`
//                            (old ledger files still parse unchanged, per
//                            this project's schema-versioning discipline --
//                            pending-ledger.mjs's own header must gain the
//                            same "bumped N -> N+1" comment convention
//                            schema.mjs already uses).
//   - "carried" (checked)  <- PURELY CLIENT-SIDE, transient UI state (mirrors
//                            the prototype's own `state.off = {}` -- nothing
//                            persisted until a run actually happens). The
//                            ONLY persistence point is `POST /api/chronicle/
//                            run`'s own request body: `carriedEntryIds:
//                            string[]` (a subset of currently-`readAvailable
//                            Pending`-eligible entry ids across the whole
//                            world). OMITTING this field means "everything
//                            currently queued" (matches "Default scope =
//                            queued intents ONLY" -- the unchecked-nothing
//                            case is the SAME as the field-omitted case,
//                            both meaning "take it all"; an EMPTY ARRAY
//                            `[]` is a real, different, valid "carry
//                            nothing this pass" instruction and must be
//                            respected literally, not treated as omitted).
//   - HAND-ADDED entries' `sourceBatchId` <- pinned sentinel: the literal
//                            string `"manual"` (no real source batch exists
//                            for a hand-typed intent). This is SAFE against
//                            `pending-ledger.mjs`'s own `sourceBatchHeadline`
//                            helper, confirmed by direct read: it already
//                            degrades gracefully to `"(source batch
//                            unavailable)"` for any unreadable/missing
//                            batch id via a try/catch, so no code change is
//                            needed there for this sentinel to render safely.
//
// No new "add a manual intent" store-write function is needed either --
// `mutation-engine/pending-ledger.mjs`'s EXISTING `writePending(world,
// entityId, entry)` already does exactly this; 37.1's ONLY new work here is
// the route that resolves a free-typed name into an `entityId` (create a
// new minimal `concept`-typed entity via the existing headless-apply path
// if no matching entity exists yet, mirroring writeup-import's own
// dedup-or-create convention) then calls `writePending`.
//
// ===========================================================================
// §6. Scope-kind -> real scope.mjs mode translation (37.1's job; pinned here
//     so the Composer's request contract is stable before 37.1 exists)
// ===========================================================================
// `POST /api/chronicle/run` accepts a FRIENDLY `scopeKind` field, never a
// raw scope.mjs mode string (keeps the Composer's 3 chips simple and keeps
// the mode-selection judgment call in ONE place, server-side):
//   - `scopeKind: "queued-intents"` (DEFAULT when omitted, per the settled
//     decision) -> `{mode: "seed", seeds: carried.map(e => ({entityId:
//     e.entityId, magnitude: Math.min(1, Math.abs(e.impactScore))}))}` --
//     `depth` deliberately omitted (falls through to scope.mjs's own
//     `DEFAULT_SEED_DEPTH`, not re-decided here). Empty `carried` (every
//     intent unchecked, or none queued) is a VALID no-op run (zero deltas,
//     zero mutations, batch still created for a clean audit trail) --
//     NEVER silently upgraded to a wider scope.
//   - `scopeKind: "branches"`, `branchIds: string[]` (>=1 required, 400 if
//     empty) -> for EACH id, `resolveScope({mode:"contained-in", anchorId:
//     id})` independently, then the results are MERGED by entityId keeping
//     the max `impactScore` per entity (mirrors `scope.mjs`'s OWN
//     `resolveSeedDeltas` merge-by-max pattern, applied one layer up in
//     run-composition code -- `scope.mjs`'s `contained-in` mode ITSELF is
//     UNCHANGED, still single-anchorId, per its own established signature;
//     no new scope.mjs mode is added). A single `branchIds` entry is the
//     common case (the prototype's own UI defaults to picking one branch at
//     a time) but multi-branch union is supported from day one rather than
//     artificially capped, since the merge is cheap and the prototype's own
//     chip-removal UI clearly anticipates more than one.
//   - `scopeKind: "whole-world"` -> `{mode: "ambient"}`.
//   Every resolved scope spec above gets `elapsedSessions` merged in from
//   `advanceWorldClock`'s own return value (§2's single-source rule) before
//   being handed to `orchestrateBatch`/`orchestrateCycle` -- this merge
//   happens in the SAME place regardless of `scopeKind`, so the single-
//   source guard in §2 covers all three.
//
// `POST /api/chronicle/run` full request contract: `{world, scopeKind?,
// branchIds?, carriedEntryIds?, span, prompt?, tags?}` (`tags` = the
// prototype's own "nudge it further" checkbox ids, forwarded as-is into
// `orchestrateBatch`'s texture opts by 37.1 -- 37.0 does not further
// decompose this field). Response: `{batchId, mutationCount, headline,
// clock: {currentDate, sessionNumber, elapsedSessions}, fortuneAtRun,
// scopeKind}`.
//
// ===========================================================================
// §7. The shared proposal/diff card -- review-ui/public/proposal-card.js
//     (NEW, exported -- "the future agent-review engine", not Chronicle-local)
// ===========================================================================
// A single vanilla-ES-module component, `renderProposalCard(mutation, opts)`
// -> a DOM node, mountable ANYWHERE a `StoredMutation`-shaped object needs
// review UI (Chronicle's own "What changed" panel first, per 37.2; then the
// Wrap rail + Connection-Menu lore-intake review, per 37.3, replacing their
// own local card renderers -- the README's "implement once" rule). Testid
// contract (pinned here so 37.2 builds it and 37.3 adopts it VERBATIM, per
// the task's own charter):
//
//   [data-testid="proposal-card"][data-mutation-id][data-type][data-risk]
//     [data-decided="yes"|"no"|""]        -- the card root. `data-type` /
//     `data-risk` are the triage-bucket attributes the task asks for --
//     see the SCHEMA ADDITIONS below for where these values come from.
//   [data-testid="proposal-card-kind-badge"]      -- op-derived label
//     ("field edit"/"new node"/"new edge"/"promote"/"removed", per
//     mutation.op + a create-vs-edit check -- mirrors the prototype's own
//     `PROPOSALS[].kind` vocabulary).
//   [data-testid="proposal-card-target"]          -- the entity's display
//     name (entityContext.name, already attached by texture.mjs today).
//   [data-testid="proposal-card-risk-label"]      -- human label for
//     data-risk ("safe"/"wants a look"/"fights canon", prototype's own
//     RISK label strings verbatim).
//   [data-testid="proposal-card-diff-before"]     -- present IFF the
//     mutation has a non-empty "before" state (diffEntity/diffEdge's own
//     null-before convention: a create has none). Iff the diff includes a
//     `description` field change, this row renders THAT field's `from`
//     text (matches the prototype's own before/after prose framing, which
//     is always description-shaped); otherwise it falls back to a plain
//     "field: value" line per non-description changed field (diff.mjs's own
//     `{field,from,to}` tuples, rendered client-side -- no new backend
//     renderer, `renderEntityDiff`'s markdown-flavored text stays MCP/
//     conversational-surface-only, unused by this DOM component).
//   [data-testid="proposal-card-diff-after"]      -- same rule, the `to`
//     side; ALWAYS present (a create has an "after" with no "before").
//   [data-testid="proposal-card-why"]             -- `mutation.rationale`
//     (already exists on every mutation, `Mutation.rationale` is required).
//   [data-testid="proposal-card-accept-btn"]      -- calls the EXISTING
//     `POST /api/batches/:batchId/accept {world, scope:"mutation",
//     id:mutationId}` route, unmodified (per gm-tools-conventions: reuse,
//     never duplicate review-state plumbing).
//   [data-testid="proposal-card-reject-btn"]      -- calls the EXISTING
//     `POST /api/batches/:batchId/reject` route, unmodified, same shape.
//
// TRIAGE-BUCKET SEMANTICS (from the prototype's own `BUCKETS`, verbatim):
// three risk buckets, `safe` / `look` ("wants a look") / `contradict`
// ("fights canon"), each with its own accent color + a collapsible group in
// the "Triaged" review-mode toggle (vs. "Every change", a flat list -- BOTH
// modes render the SAME `proposal-card` instances, just grouped
// differently -- this is the component reuse discipline in miniature, one
// card, two containers).
//
// SCHEMA ADDITIONS -- `type`/`risk` DO NOT EXIST on any mutation today
// (confirmed: `StoredMutation`, schema.mjs, has neither field; the
// prototype's own `PROPOSALS[].type`/`.risk` are hand-authored seed data
// with no real backend source). Pinned, additive, buildable-without-further-
// judgment-calls resolution:
//   - `StoredMutation` SCHEMA_VERSION 4 -> 5: TWO new optional fields,
//     `type: z.string().optional()` and `risk: z.enum(["safe","look",
//     "contradict"]).optional()` (old batch files still parse unchanged --
//     an ABSENT `risk` on a pre-Phase-37 batch is a real, valid state; the
//     shared card must render a neutral/unlabeled state for it, never crash
//     on a missing attribute).
//   - BOTH fields are computed and stamped in `time-skip/run.mjs`'s EXISTING
//     `attachDiffs(mutations, entities, edges)` (the ONE function both
//     `orchestrateBatch` AND `orchestrateCycle` already call before
//     `createBatch` -- extending it here means BOTH orchestrators gain
//     `type`/`risk` for free, no second call site to remember).
//   - `type` <- `current?.type ?? m.data?.type ?? "concept"` (the SAME
//     `current` lookup `attachDiffs` already performs via `findEntity`/
//     `findEdge` for the diff itself -- zero new graph lookups; `"concept"`
//     is the neutral fallback for the pathological case neither side names
//     a type, matching World Fabric's own core-entity-type vocabulary's
//     least-specific member).
//   - `risk` <- a NEW, deliberately CHEAP, DETERMINISTIC (non-LLM) v1
//     heuristic -- `deriveRisk(mutation, {flaggedEntityIds})`:
//       1. `delete_entity` / `delete_edge` -> `"contradict"` (an outright
//          removal always wants a careful look, no exceptions).
//       2. the touched entity id is in `flaggedEntityIds` (the SAME
//          `human-review.mjs`-sourced set `grain.mjs`'s own
//          `isFlaggedUnreviewed` already reads for headline-collapse
//          overrides -- reused, not a new signal) -> `"contradict"` (an
//          entity already flagged for accumulating unreviewed AI-authored
//          history is exactly the "read this one before you take it" case
//          the prototype's own `p7`/`p8` contradict examples model).
//       3. a CREATE (no `current` match found -- `diffEntity`/`diffEdge`'s
//          own null-before case) -> `"look"` (matches the prototype's own
//          `p5` "new node... arrive unreviewed" -- a brand-new node/edge
//          always wants a glance).
//       4. `(mutation.impactScore ?? 0) >= HEADLINE_IMPORTANCE_THRESHOLD`
//          (REUSES `grain.mjs`'s own existing `0.5` constant -- no second
//          magic number introduced) -> `"look"`.
//       5. otherwise -> `"safe"` (an ordinary field edit on an already-
//          reviewed, non-flagged entity, low impact).
//     Flagged explicitly: this is a v1 approximation, not an LLM-graded
//     judgment -- 37.1/37.2 may refine it further, but this resolution is
//     concrete and buildable without a further open question, and gives
//     `phase37-chronicle-surface.e2e.mjs` a real, assertable behavior to
//     pin once 37.1 exists.
//
// ===========================================================================
// §8. Chronicle surface DOM contract (37.2's build target)
// ===========================================================================
//   [data-testid="chronicle-surface-root"]            -- EXISTING scaffold
//     root (Phase 34), currently placeholder-copy-only; 37.2 replaces its
//     contents, testid unchanged.
//   [data-testid="chronicle-worldclock-line"]         -- the top sub-bar's
//     "{{ worldClock }}" line, sourced from `GET /api/chronicle/world-clock`.
//   [data-testid="chronicle-deferred-lane"]           -- left rail, wraps
//     [data-testid="chronicle-intent-row"][data-entity-id][data-entry-id]
//       [data-carried="true"|"false"], each containing a checkbox toggling
//       ONLY client-side `carried` state (§5). Footer:
//     [data-testid="chronicle-intent-add-input"]      -- hand-add, Enter
//       commits (mirrors the prototype's own `newIntentKey` Enter-to-commit).
//   [data-testid="chronicle-adv-mode-toggle"]         -- Composer|Timeline
//     segmented control, wraps
//     [data-testid="chronicle-adv-mode-btn"][data-mode="composer"|"timeline"].
//   [data-testid="chronicle-composer"]                -- present iff mode is
//     composer. Contains:
//     [data-testid="chronicle-prompt-input"]          -- the prose textarea.
//     [data-testid="chronicle-scope-chip"][data-scope-kind="queued-intents"|
//       "branches"|"whole-world"]                     -- §6's 3 scopeKinds.
//     [data-testid="chronicle-branch-picker-toggle"]  -- opens the inline
//       node search (present only meaningfully when scope-kind is
//       "branches"); picked branches render as
//       [data-testid="chronicle-branch-chip"][data-entity-id] with a remove
//       control, mirroring the prototype's own removable chip row.
//   [data-testid="chronicle-timeline"]                -- present iff mode is
//     timeline. Contains
//     [data-testid="chronicle-span-chip"][data-span-id="week"|"month"|
//       "season"|"year"|"long"] (the scrubber's own discrete stops).
//   [data-testid="chronicle-span-control"]            -- THE ONE shared
//     duration control (§2's single-source DOM pin) -- present in BOTH modes,
//     backed by the SAME underlying state regardless of which mode is
//     showing (this suite asserts: picking a span chip in Composer mode,
//     then switching to Timeline mode, shows the SAME `data-span-id`
//     selected there, and vice versa -- one state, two views, per the
//     prototype's own single `state.spanId` field). SELECTED-STATE
//     ATTRIBUTE CONVENTION (pinned so 37.2 doesn't have to invent one and
//     this suite can assert a single, unambiguous attribute): every chip
//     with a "currently picked" concept in the Chronicle surface (span
//     chips, scope chips, fortune stops) carries `aria-pressed="true"|
//     "false"`, mirroring the EXISTING `wv-tree-mode-spatial-btn`/
//     `wv-tree-mode-loyalty-btn` convention (world-view.js, Phase 38) rather
//     than inventing a second `data-selected`-style attribute for the same
//     concept elsewhere in this codebase.
//   [data-testid="chronicle-fortune-track"]           -- wraps
//     [data-testid="chronicle-fortune-stop"][data-stop-id] x5 (§3's FIVE
//     stops), present in BOTH modes (the prototype renders it in both
//     `sc-if` branches identically).
//   [data-testid="chronicle-run-btn"]                 -- calls `POST
//     /api/chronicle/run` (§6).
//   [data-testid="chronicle-proposals"]               -- "What changed",
//     wraps `[data-testid="proposal-card"]` instances (§7, THE shared
//     component -- this suite asserts the SAME testid vocabulary appears
//     here as any future batch-detail/Wrap-rail mount, not a
//     Chronicle-local re-implementation).
//   [data-testid="chronicle-history"]                 -- right rail, wraps
//     [data-testid="chronicle-history-entry"][data-batch-id], sourced from
//     `GET /api/chronicle/log` (§4), newest first.
//
// ===========================================================================
// §9. GREEN GUARD -- the EXISTING #review/<batchId> screen + /api/batches/*
//     routes MUST keep working (phase37-review-green-guard.e2e.mjs)
// ===========================================================================
// Per the settled decision ("#queue/#review SCREENS retire once Chronicle's
// review subsumes them (batch ROUTES stay)"): 37.0 does not touch, and this
// suite does not expect red for, ANY of `GET /api/batches`, `GET /api/
// batches/:id`, `POST /api/batches/:id/accept`, `POST /api/batches/:id/
// reject` (all real, already-shipped, unmodified), or the legacy `#review/
// <batchId>` hash view (`#view-review`, app.js) -- these are DELIBERATE
// GREEN PINS (mirrors phase38-fixture.mjs's own "plan-delete route" precedent
// for a pin that protects existing behavior rather than asserting new red).
// The point: 37.3's later screen retirement (bare `#queue`/`#review` nav
// entry points folding into Chronicle) must not regress the underlying
// batch-review capability a deep link or an API client still depends on.
//
// ===========================================================================
// Implementation below: setup + route helpers, mirroring phase34/36/38-
// fixture.mjs's own "helpers do not assert res.status -- a non-200/404 here
// IS the expected red-for-the-right-reason signal" convention. Nothing here
// imports `session-planner/world-clock.mjs` / `fortune-track.mjs` /
// `chronicle-run.mjs` / `review-ui/public/proposal-card.js` directly (none
// of the four exist yet) -- every interaction goes through HTTP, exactly
// like every precedent fixture's own under-construction routes.
// ===========================================================================
import { join } from "node:path";
import {
  setupPhase34Env,
  cleanupScratchEnv,
  primeWorldSelection,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
} from "./phase34-fixture.mjs";

/** setupPhase34Env() (app-settings dir, needed for §1's calendar-relationship pin) PLUS the THREE new store dirs this phase's stores will need once 37.1 builds them. */
export function setupPhase37Env(prefix) {
  const { scratchDir, dataDir } = setupPhase34Env(prefix);
  process.env.GM_TOOLS_WORLD_CLOCK_DIR = join(scratchDir, "world-clock");
  process.env.GM_TOOLS_FORTUNE_DIR = join(scratchDir, "fortune-track");
  process.env.GM_TOOLS_CHRONICLE_RUN_DIR = join(scratchDir, "chronicle-run");
  return { scratchDir, dataDir };
}

export { cleanupScratchEnv, primeWorldSelection, DESKTOP_VIEWPORT, IPHONE_13_VIEWPORT };

// The canonical span table, duplicated here ONLY for test-side expectation
// building (asserting against the real route's output once it exists) --
// NOT a second source of truth for production code, which must import this
// from world-clock.mjs itself once 37.1 builds it (see §2's single-source
// pin: this table lives in exactly one production module).
export const SPAN_DAYS = { week: 7, month: 30, season: 91, year: 365, long: 8030 };
export function spanToElapsedSessions(days) {
  return Math.max(1, Math.round(days / 7));
}

export const FORTUNE_STOPS = [
  { stopId: "bountiful", label: "Bountiful", bias: 2 },
  { stopId: "fair", label: "Fair", bias: 1 },
  { stopId: "middling", label: "Middling", bias: 0 },
  { stopId: "lean", label: "Lean", bias: -1 },
  { stopId: "ruinous", label: "Ruinous", bias: -2 }
];

// ---------------------------------------------------------------------------
// Route helpers -- §1/§2 world-clock. 404 until 37.1.
// ---------------------------------------------------------------------------

/** GET /api/chronicle/world-clock?world= -- 404 until 37.1. */
export async function fetchWorldClockViaRoute(base, world) {
  const res = await fetch(`${base}/api/chronicle/world-clock?world=${encodeURIComponent(world)}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** POST /api/chronicle/world-clock/advance {world, span} -- 404 until 37.1. `extraBody` lets a test smuggle in an illegitimate field (e.g. elapsedSessions) to prove it's ignored. */
export async function advanceWorldClockViaRoute(base, world, span, extraBody = {}) {
  const res = await fetch(`${base}/api/chronicle/world-clock/advance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, span, ...extraBody })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Route helpers -- §3 fortune. 404 until 37.1.
// ---------------------------------------------------------------------------

/** GET /api/chronicle/fortune?world= -- 404 until 37.1. */
export async function fetchFortuneViaRoute(base, world) {
  const res = await fetch(`${base}/api/chronicle/fortune?world=${encodeURIComponent(world)}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** POST /api/chronicle/fortune {world, stopId} -- 404 until 37.1. */
export async function setFortuneViaRoute(base, world, stopId) {
  const res = await fetch(`${base}/api/chronicle/fortune`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, stopId })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Route helper -- §4 chronicle-log. 404 until 37.1.
// ---------------------------------------------------------------------------

/** GET /api/chronicle/log?world= -- 404 until 37.1. */
export async function fetchChronicleLogViaRoute(base, world) {
  const res = await fetch(`${base}/api/chronicle/log?world=${encodeURIComponent(world)}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Route helper -- §6 the run-composition route. 404 until 37.1.
// ---------------------------------------------------------------------------

/** POST /api/chronicle/run {world, scopeKind?, branchIds?, carriedEntryIds?, span, prompt?, tags?} -- 404 until 37.1. */
export async function runChronicleViaRoute(base, world, params) {
  const res = await fetch(`${base}/api/chronicle/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, ...params })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Existing, ALREADY-SHIPPED route helpers this suite reuses/green-guards --
// duplicated here (small, pure) rather than importing a chain of sibling
// fixtures, mirroring phase38-fixture.mjs's own "small duplicated helper"
// precedent for readFoundryOpsFileSync/armFakeFoundryWatcher.
// ---------------------------------------------------------------------------

/** GET /api/pending-entities?world= -- EXISTING, shipped route (§5's reuse target). */
export async function fetchPendingEntitiesViaRoute(base, world) {
  const res = await fetch(`${base}/api/pending-entities?world=${encodeURIComponent(world)}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** GET /api/batches?world= -- EXISTING, shipped route (§9 green guard). */
export async function fetchBatchesViaRoute(base, world) {
  const res = await fetch(`${base}/api/batches?world=${encodeURIComponent(world)}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** GET /api/batches/:id?world= -- EXISTING, shipped route (§9 green guard). */
export async function fetchBatchDetailViaRoute(base, world, batchId) {
  const res = await fetch(`${base}/api/batches/${encodeURIComponent(batchId)}?world=${encodeURIComponent(world)}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** POST /api/batches/:id/accept {world, scope, id} -- EXISTING, shipped route (§9 green guard). `scope` is mutation-ops.mjs's real enum: "batch"|"region"|"entity" (an "entity"-scoped `id` accepts either a mutationId or the target entity/edge id, per resolveMutationIds's own doc comment). */
export async function acceptMutationViaRoute(base, world, batchId, { scope = "entity", id } = {}) {
  const res = await fetch(`${base}/api/batches/${encodeURIComponent(batchId)}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world, scope, id })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
