# GM_Tools — Phase 22 Task Plan: Scene Engine (no UI)

**Status:** ready to execute. **Prerequisite reading, in order:** `CLAUDE.md` → `PLAN.md` → `plans/phase-21-review.md` in full (the design record this phase builds — read §1-§9 for intent, §10 for the questions, §12 for how they were resolved and why — this file assumes all of it) → this file → `.claude/skills/gm-tools-conventions/SKILL.md`.

**Scope:** engine + API only, no UI — matches this project's established engine-then-UI precedent (Phase 16→17, Phase 18→19). Phase 23 (construction UI) and Phase 24 (Scenes tab) both depend on this phase; neither can start until this phase's contracts exist.

**Process, same as every phase since 16:** tests before implementation. Task 22.0 writes contract-defining tests against modules that don't exist yet, confirmed red, before any implementation task starts.

---

## Grounding — what already exists, confirmed live in this repo

- **`session-planner/scenes.mjs`**: `createScene(world, {locationEntityId, objectiveNote}, opts)`, `forkScene(world, parentSceneId, {...}, opts)`, `getScene(world, sceneId)`, `listScenesForWorld(world)` — a flat per-world list, `parentSceneId` already captures fork/branch lineage (time axis). No cross-session persistence concept beyond what Phase 20.2 added at the UI layer (a `localStorage` last-active pointer) and no scene-to-scene spatial-linkage concept at all — that's this phase's job, resolved in the design record as **derived, not stored** (§12 Q1).
- **`session-planner/corridor.mjs`**: `shortestPath(entities, edges, fromId, toId)`, `routePath(entities, edges, orderedLocationIds)`, `corridorNodes(entities, edges, path, tolerance)`. **`wf-mcp-server/lib/graph.mjs`**: `neighborhood(entities, edges, entityId, depth)`, `edgesFor`, `findEntity`, `findEdge`, `findEntityByName`. These are the traversal primitives task 22.1 (linkage) and 22.3 (arbitrary-add + intervening-fill) build on — no new graph-traversal algorithm needed, this phase composes what's already there.
- **`mutation-engine/manual-undo.mjs`**: `getUndoSlot`/`setUndoSlot`/`clearUndoSlot`/`consumeUndoSlot`, explicitly single-slot/last-write-wins per its own header comment ("there is no history list to push onto"). Task 22.4's new module is a sibling, not a replacement — single-node "Develop this node" keeps using this unchanged; only the new batch flow needs the new mechanism.
- **`wf-mcp-server/lib/prep-content-ops.mjs`**: `proposePrepFramingsOp(dir, w, {entityId})` → `reframePrepFramingsOp(dir, w, {entityId, priorRoundCount})` (iterative Q&A round-trip) → `generatePrepContentOp(dir, w, {entityId, selection})` → `acceptPrepContentOp`/`discardPrepContentOp`. Task 22.5's orchestrator wraps this per-node flow across every scene member — it does NOT reimplement the Q&A logic, it sequences calls into it.
- **`mutation-engine/review-state.mjs`**: `createBatch(world, scope, elapsedTimeDescriptor, mutations, opts)`, `loadBatch`, `saveBatch`, `updateMutationStatus`, `listBatches`, `withLock`/`ConcurrentWriteError`. The store-pattern and locking convention every new store in this phase should match.
- **The entity `type` enum is independently duplicated, NOT shared, across at least four locations** — confirmed live: `wf-mcp-server/index.mjs:223` (the mutation-apply validation — the one that actually rejects a bad `upsert_entity`), `graph-import/scan-mentions.mjs:96`, `graph-import/writeup-import.mjs:158`, `mutation-engine/prep-content.mjs:70`. All four currently read `z.enum(["person", "place", "faction", "object", "event", "concept"])`. **Per the design record's resolution (§12), task 22.2 does NOT touch any of these four files or add a new enum value** — transit entities commit as `type: "place"` with a distinguishing attribute, sidestepping a coordinated 4-file change entirely. If a task in this phase finds itself wanting to edit any of these four enum definitions, stop — that means the design record's resolution was misread.
- Re-verify all of the above fresh when implementing — line numbers may have drifted since this grounding pass.

---

## Task list

### 22.0 — QE test-authoring pass (runs first, standalone)
**Files:** new `test/scene-planning/*.test.mjs`, new `review-ui/test/scene-planning-routes.test.mjs` (or wherever this project's route-test convention currently lives — check `review-ui/test/session-planner-routes.test.mjs`/`combat-planning-routes.test.mjs` for the exact pattern and match it)

Define and test every module in 22.1–22.7 below, contract-first — same discipline as every QE pass since Phase 16.0. Required coverage, from the design record's own hard requirements:

- **Linkage derivation never persists anything** — a test asserting the linkage-query function makes no writes, is pure, and returns the same result on repeated calls against unchanged graph state (proving it's genuinely derived, not cached-and-drifting).
- **Transit entity creation never touches the entity-type enum files** — a source-grep test (matching this project's established convention for this kind of assertion, e.g. Phase 19's LLM-free-orchestrator check) confirming the transit-entity-creation module's own source contains no new `z.enum(...)` literal and imports nothing from a modified copy of the four enum locations. The created entity's `type` field must literally equal `"place"` with a separate, clearly-named distinguishing field (e.g. `isTransit: true` or similar — pin the exact field name here, this is the interface contract 22.2 implements to).
- **Transit entity default naming** — a concrete default (e.g. "Path" or "The Road to \<destination\>") is asserted directly, not left as "some string."
- **Arbitrary-node-add reachability behavior, both branches**: adding an unreachable node succeeds with no side effects beyond the add itself; adding a reachable node returns/offers the real intervening node ids (via `shortestPath`) without adding them automatically — a separate, explicit confirmation step adds them.
- **Scene-scoped batch-undo is genuinely a list, not a slot**: a test that performs undo-tracked actions against two different entities within one scene-development session and asserts BOTH are recoverable, in reverse order, proving this isn't `manual-undo.mjs`'s single-slot behavior copy-pasted with a new name. A second test confirms `manual-undo.mjs`'s existing single-node "Develop this node" path is completely untouched by this new module (no shared mutable state, no behavior change).
- **Batch orchestrator partial-failure handling**: a test where node 3 of a 5-node batch fails (mock a `proposePrepFramingsOp` rejection mid-batch) — assert the other 4 nodes' results are still returned/usable, the failure is reported per-node not as a whole-batch abort, and nothing partially-applied gets silently treated as accepted.
- **Batch orchestrator is genuinely sequenced server-side, not a dumb parallel fan-out** — a test asserting some real ordering/rate property (e.g., calls happen with real sequencing you can observe via a call-order-recording mock), not just "eventually resolves."
- **Quick-gen primitive is a single LLM call, not the multi-round Q&A pattern** — a test confirming it makes exactly one call and returns a usable result, no `reframePrepFramingsOp`-style round-trip involved, and completes fast (assert on call count, not wall-clock time, matching this project's established convention for testing latency-sensitive things deterministically).
- **Route-level security tests**: every new route rejects a malicious/traversal-shaped `world` id and never accepts a client-supplied `dataDir`, extending the exact existing pattern (`review-ui/test/routes.test.mjs`'s convention), not inventing a new one.
- **`.gitignore`** entries (with `.gitkeep`) for any new data store this phase introduces (the scene-scoped undo store, at minimum) — this project's own recurring gap, check now while the store shape is being specified.

**Acceptance criteria:** every new test file fails with a clear "module not found"/"not a function" error; full existing suite (root, `wf-mcp-server`, `review-ui` deterministic + all e2e) still passes.

---

### 22.1 — Scene-to-scene linkage (derived, not stored)
**Files:** new `session-planner/scene-linkage.mjs`

- `linkedScenesForScene(world, sceneId, snapshot)` — given a scene, walks its anchor entity's graph adjacency (`neighborhood`/`shortestPath`) and cross-references against `listScenesForWorld(world)` to find which OTHER scenes in this world are anchored to graph-adjacent entities. Pure function over already-loaded data plus a store read for the scene list — no new persisted linkage field anywhere.
- This is the query Phase 24's Scenes tab will call directly — keep its return shape simple and UI-ready (scene id, anchor entity id/name, hop-distance) rather than raw graph internals.

**Acceptance criteria:** 22.0's linkage-purity tests pass.

---

### 22.2 — Transit/path entity creation
**Files:** new `session-planner/transit-entity.mjs`

- `createTransitEntity(world, {fromEntityId, toEntityId, name})` — commits a real, minimal World Fabric entity via the existing mutation-apply path (reuse whatever this project's established entity-creation route already uses — check `wf-mcp-server/index.mjs`'s `upsert_entity`-shaped mutation, don't invent a second entity-creation mechanism). `type: "place"`, plus a distinguishing attribute (pin the exact field name in 22.0's test contract and match it here — do not touch any of the four enum-definition files). Default `name` if none given (e.g. "Path" or similarly generic, per the design record's explicit "stay exactly as generic as 'Path' indefinitely" allowance).
- No lazy/deferred creation — per the design record's explicit correction, this commits immediately when a transit scene is added, not on first "develop."

**Acceptance criteria:** 22.0's transit-entity tests pass, including the enum-files-untouched source-grep check.

---

### 22.3 — Arbitrary node add + reachability-aware intervening-node offer
**Files:** new `session-planner/scene-membership.mjs`

- `addNodeToScene(world, sceneId, entityId)` / `removeNodeFromScene(world, sceneId, entityId)` — trivially easy add/remove, per the design record's own framing that this is "the complete answer" to needing more than 1-hop.
- `offerInterveningNodes(entities, edges, sceneAnchorId, targetEntityId)` — pure function using `shortestPath`; returns the intervening node ids if a path exists (for the caller to OFFER, never auto-add), or an empty/null result if unreachable (in which case the caller just adds the target directly, no offer needed).

**Acceptance criteria:** 22.0's reachable/unreachable branch tests pass.

---

### 22.4 — Scene-scoped batch-undo
**Files:** new `mutation-engine/scene-undo.mjs`

- Reuses `manual-undo.mjs`'s `UndoAction` shape (the `graphMutations`/`narrationUndo` union — import the type/schema, don't redefine it) but stores an ORDERED LIST scoped to one scene-development session, not a single slot. Store convention matches `review-state.mjs`'s batch-of-mutations shape more closely than `manual-undo.mjs`'s single-slot file.
- `startSceneUndoSession(world, sceneId)`, `recordSceneUndoAction(world, sceneId, action)`, `undoLastSceneAction(world, sceneId)` (pops and reverses the most recent), `undoAllSceneActions(world, sceneId)` (reverses the whole list in order, for a full scene-development unwind), `clearSceneUndoSession(world, sceneId)`.
- Explicitly verify (per 22.0's test): zero shared mutable state with `manual-undo.mjs` — the two modules coexist, single-node development still uses the old global slot untouched.

**Acceptance criteria:** 22.0's scene-scoped-undo tests pass, including the "manual-undo.mjs untouched" isolation check.

---

### 22.5 — Batch "develop this scene" orchestrator
**Files:** new `mutation-engine/scene-develop.mjs`

- `developScene(dir, world, sceneId, memberEntityIds, opts)` — sequences `proposePrepFramingsOp`/`reframePrepFramingsOp`/`generatePrepContentOp` (from `prep-content-ops.mjs`, imported and called, not reimplemented) across every member entity, with real server-side sequencing (not a naive `Promise.all` fan-out with no ordering control) and explicit per-node partial-failure handling — one node's Q&A round erroring must not silently drop or corrupt the others' results.
- Each node's result still lands on the existing accept/discard gate (`acceptPrepContentOp`/`discardPrepContentOp`) — this orchestrator sequences proposals, it does not auto-accept anything. Matches the design record's explicit requirement that this reuses the existing review pattern, not bypasses it.
- Record each node's development action into 22.4's scene-undo session as it completes, so the scene-local rollback control (Phase 23) has something real to unwind.

**Acceptance criteria:** 22.0's partial-failure and real-sequencing tests pass.

---

### 22.6 — Fast quick-gen primitive
**Files:** new `mutation-engine/quick-gen.mjs`

- `quickGenerate(prompt, opts)` — a single `callModelDetailed` call (via `mutation-engine/llm-call.mjs`, matching every other LLM call site's convention), no multi-round Q&A. Built specifically for the mid-session "+" ad-hoc scene flow's "one field, one button, genuinely fast" bar — this is deliberately a much thinner wrapper than `prep-content-ops.mjs`'s flow, not a smaller version of it.

**Acceptance criteria:** 22.0's single-call/no-round-trip test passes.

---

### 22.7 — Server routes
**Files:** `review-ui/server.mjs`

- New routes under `/api/scene-planning/*` (or match whatever prefix convention this project's most recent routes use — check `session-planner`/`combat-planning`'s exact prefix style and stay consistent): linkage query, transit-entity creation, node add/remove + intervening-offer, scene-undo session actions, scene-develop kickoff, quick-gen.
- Every route uses the existing parameterless `resolveDir()`/`resolveWorld()` pattern — no route in this task accepts a client-supplied `dataDir`, the single highest-risk regression every phase since 16 has had to guard against explicitly.
- No UI wiring — these routes exist for 22.0's tests and for Phase 23/24 to consume later.

**Acceptance criteria:** 22.0's route-level tests pass, including the security cases.

---

## How to work

- Task 22.0 must fully complete, commit, and be confirmed red before 22.1 starts.
- 22.3 has no dependency on 22.1/22.2/22.4/22.5/22.6 (pure traversal over existing primitives) — per the PM phasing pass, it can be built/tested first if that's convenient, but doesn't have to be.
- 22.5 depends on 22.4 (needs a real undo-session to record into) — sequence accordingly.
- Ground every implementation task in the actual current code — re-locate exact lines/signatures fresh.
- Commit after each completed task, clean incremental history. Stage files explicitly, never `git add -A`.
- No `foundry_worldFabric` changes anywhere in this phase. Verify `git -C /opt/dev/foundry_worldFabric status --short` is unchanged before and after (should show only its known pre-existing unrelated state — note the path is `/opt/dev/foundry_worldFabric` now, not `/home/russell/foundry_worldFabric`, following the recent drive migration).
- Self-review remediation pass at the end of 22.7: run the full test suite, re-confirm the enum-files-untouched property holds, re-confirm `manual-undo.mjs` is genuinely untouched by the new scene-undo module, and re-confirm the batch orchestrator's partial-failure path doesn't silently accept anything.

## Definition of done for Phase 22

- [ ] 22.0's test suite committed, confirmed red before any implementation exists.
- [ ] Linkage derivation (22.1) — pure, no new stored field.
- [ ] Transit entity creation (22.2) — `type:"place"` + attribute, enum files untouched, real default naming.
- [ ] Arbitrary node add + intervening-offer (22.3) — both reachable/unreachable branches correct.
- [ ] Scene-scoped batch-undo (22.4) — genuine ordered history, `manual-undo.mjs` untouched.
- [ ] Batch develop orchestrator (22.5) — real sequencing, per-node partial-failure handling, still gated on the existing accept/discard step.
- [ ] Quick-gen primitive (22.6) — single call, no round-trip.
- [ ] Server routes (22.7) — existing + new security tests passing.
- [ ] Full existing test suite still passes throughout.
- [ ] `.gitignore` entries present for every new store.
- [ ] `foundry_worldFabric` confirmed untouched.
- [ ] Self-review remediation pass run and reported.
