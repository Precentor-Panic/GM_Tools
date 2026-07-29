# GM_Tools — Phase 16 Task Plan: Session Planner (engine + API)

**Status:** ready to execute. **Prerequisite reading, in order:** `CLAUDE.md` → `PLAN.md` → `plans/phase-16-review.md` (the full design record — read it before this file, this file assumes it) → this file → `.claude/skills/gm-tools-conventions/SKILL.md`.

**Scope cut, deliberate:** this phase builds the engine and API surface only — traversal, scenes, ambient digest data, the two flags, notes-as-deferred-intake, and the Session Brief as a data structure. It does **not** build the review-ui "Plan a Session" page, the hyperlinked brief rendering, or the annotation popover — that's UI work with its own real interaction-design surface and belongs in a follow-on phase (17) once the engine underneath it is solid and tested. Building the engine test-first, without a UI to eyeball, is exactly the kind of work this project's existing `node --test` discipline handles well; the UI phase will want its own Playwright-driven verification pass, same as Phase 15.

**Process for this phase, explicitly requested:** tests are written *before* implementation, by a dedicated QE pass (task 16.0), against contracts that don't exist yet. That means 16.0's tests are expected to fail (missing-module errors, not assertion failures) the moment they're written — that's correct, not a bug. Task 16.1 onward implement against those tests until green, without loosening what the tests assert; if a test looks wrong once real implementation is underway, that's a flag to raise, not silently patch around.

---

## Grounding — what already exists, confirmed live in this repo

- **`wf-mcp-server/lib/graph.mjs`** already has the core traversal primitive: `neighborhood(entities, edges, entityId, depth = 2)` — undirected BFS over `edge.sourceId`/`edge.targetId`, returns visited entities/edges. Also `edgesFor`, `findEntity`, `findEdge`, `findEntityByName`. The path-corridor engine (16.1) builds directly on top of this rather than reimplementing graph walking.
- **`mutation-engine/propagate.mjs`** is the existing precedent for "pure, Foundry-free, unit-testable" deterministic (non-LLM) graph mechanisms — same shape task 16.1 and 16.3 should follow (plain functions over `{entities, edges}`, no I/O, fully unit-testable without a running server).
- **`graph-import/scan-mentions.mjs`** has the intake pipeline task 16.4 reuses: `proposeMentionedEntities`, `applyFuzzyPrepass`, `findFuzzyEntityMatch`, `previewMentionScan`, `scanForMentionedEntities`. `applyFuzzyPrepass` already accepts pre-existing-entity hints — exactly the mechanism for feeding a note's anchor-entity into the batch intake pass with high confidence.
- **`mutation-engine/entity-narration.mjs`** is the store-pattern precedent for 16.2/16.4's new stores: `DEFAULT_ROOT` + `GM_TOOLS_*_DIR` env override, `withLock`/`ConcurrentWriteError` from `mutation-engine/review-state.mjs` for concurrency safety.
- **`wf-mcp-server/lib/prep-content-ops.mjs`** is the precedent for an "ops" module's function signature convention: `(dir, w, { ...namedParams })` for anything touching Foundry/LLM, plain `(w, { ...params })` for pure store reads/writes.
- Re-verify exact current line numbers/signatures fresh when implementing — this summary is from a grounding pass just before writing this plan, not guaranteed still exact by the time 16.1 starts.

---

## Task list

### 16.0 — QE test-authoring pass (runs first, standalone)
**Files:** new test files under `test/session-planner/*.test.mjs` (project root, alongside the existing root `test/*.test.mjs` suite — not under `review-ui/`, since this phase is engine/API only) and `wf-mcp-server/test/session-planner-routes.test.mjs` if new server routes are included in this phase's scope (they are, see 16.6).

This is a contract-first pass, not a bug hunt. Job:

1. Read `plans/phase-16-review.md` in full, plus the grounding section above and the actual current contents of `wf-mcp-server/lib/graph.mjs`, `mutation-engine/propagate.mjs`, `mutation-engine/entity-narration.mjs`, `graph-import/scan-mentions.mjs`, `wf-mcp-server/lib/prep-content-ops.mjs`, and `review-ui/server.mjs`'s route-registration pattern.
2. For each new module in tasks 16.1–16.6 below, **define the exact function signatures, module paths, and expected input/output shapes** — since none of this code exists yet, this pass is also the interface spec, not just tests against a pre-agreed API. Write that spec down as clear comments at the top of each test file (module path, exported function names, parameter shapes, return shapes) so 16.1–16.6 implement to match rather than improvising independently.
3. Write real `node --test` test files exercising every behavior called out in the design record as a hard requirement, specifically including:
   - Corridor traversal degenerates correctly to plain radius-from-point with a single-node path (design record §2.1/§4).
   - Corridor traversal with a multi-point route picks up nodes near *any* point on the path, not just the path's own nodes.
   - Ambient digest renders **empty/omitted**, never padded or fabricated, for an entity with no relationship-fact or hook to show (§3) — this needs a real test asserting absence, not just presence for well-populated entities.
   - The two flags (content-readiness vs. structural under-connection, §5) fire independently — a case where one fires and not the other, both directions.
   - Content-readiness flag severity is scoped to current corridor relevance (loud in-corridor, quiet/collapsed count beyond it) — not a flat unscoped list (§5).
   - A note capture auto-anchored to an entity, when run through batch intake, produces a fuzzy-prepass hint that resolves to the *existing* entity rather than proposing a duplicate (§6) — this is the concrete, testable form of the "high-confidence hint" claim in the design record, verify it actually prevents a duplicate-entity proposal in a realistic near-miss-name scenario.
   - Notes-as-deferred-intake never auto-writes to canon — captured notes stay inert until an explicit batch-intake call, and intake output lands as normal pending mutations on the existing review/accept gate, not auto-accepted (§6, ties to the project's standing no-silent-write invariant).
   - A scene fork carries forward parent-scene/location/objective-note metadata onto the new scene record (§2.2).
   - Scene state and session-notes stores follow the established isolation pattern (`GM_TOOLS_*_DIR` override, tests never touch the real default directory) — mirror the fix already made once in this project for `user-settings.test.mjs`'s flawed "must not exist" assumption; use a before/after diff or an isolated temp dir, not an assertion that the default dir is empty.
   - New server.mjs routes (16.6) reject a malicious/traversal-shaped `world` id the same way the existing routes do post-security-fix (`resolve.mjs`'s `VALID_WORLD_ID` regex) — add these as new cases alongside the existing pattern in `review-ui/test/routes.test.mjs`, don't invent a separate security-test convention.
4. Add a `.gitignore` entry (with `.gitkeep`) for every new data store this phase introduces (scenes, session-notes) — this project has hit this exact gap on nearly every phase that added a store; check the `DEFAULT_ROOT` in each new `mutation-engine/*.mjs`-style module and add the ignore line at the same time the store is spec'd, not after.
5. Run the new suite and confirm every test fails with a clear "module not found" / "not a function" error (proving the tests are real and wired to run, not silently skipped) — do not leave any test passing vacuously before implementation exists.

**Acceptance criteria:** a committed, runnable (if currently failing) test suite exists for every module in 16.1–16.6, each test file's header comment states the exact contract it's testing against, and a fresh `node --test test/session-planner/*.test.mjs` run shows real failures (not zero tests collected, not silent passes).

---

### 16.1 — Path-corridor traversal engine
**Files:** new `session-planner/corridor.mjs` (project root, sibling to `mutation-engine/`, `time-skip/`, `graph-import/` — this is its own pipeline stage, not a sub-folder of an existing one)

- `shortestPath(entities, edges, fromId, toId)` — BFS shortest path between two entity ids over the same undirected adjacency `neighborhood()` already builds; returns an ordered list of entity ids, or `null` if unreachable.
- `routePath(entities, edges, orderedLocationIds)` — chains `shortestPath` across a multi-stop route (concatenating consecutive-pair paths, deduping the shared endpoints).
- `corridorNodes(entities, edges, path, tolerance)` — unions `neighborhood(entities, edges, nodeId, tolerance)` for every node in `path`, returns the deduped set with each node tagged by its minimum distance to the path. A single-node `path` (home-base-only case) degenerates to plain `neighborhood()` — confirm this is a real code path, not just a claim, per 16.0's test.
- Pure functions only — no store I/O, no Foundry/LLM calls, matching `propagate.mjs`'s existing convention exactly.

**Acceptance criteria:** all corridor-related 16.0 tests pass; module has zero imports beyond `wf-mcp-server/lib/graph.mjs`.

---

### 16.2 — Scene state store
**Files:** new `session-planner/scenes.mjs`

- Lightweight per-world JSON store, `DEFAULT_ROOT` under a new `session-scenes/` directory, `GM_TOOLS_SESSION_SCENES_DIR` override, `withLock`/`ConcurrentWriteError` reused from `mutation-engine/review-state.mjs` — same shape as `entity-narration.mjs`.
- `createScene(world, { locationEntityId, objectiveNote })` — new root scene.
- `forkScene(world, parentSceneId, { locationEntityId, objectiveNote })` — new scene carrying `parentSceneId` and the fork-time context forward, per design record §2.2.
- `getScene(world, sceneId)`, `listScenesForWorld(world)`.
- Explicitly **not** a World Fabric graph entity — this store never touches `foundry_worldFabric`, confirm no import of anything Foundry-facing.

**Acceptance criteria:** all scene-related 16.0 tests pass; `.gitignore` entry present.

---

### 16.3 — Ambient digest + two flags
**Files:** new `session-planner/digest.mjs`, new `session-planner/flags.mjs`

- `digest.mjs`: `buildAmbientDigestEntry(entity, edge, narration)` → `{ name, roleTag, hook }` or `null`. Per design record §3: name + one-word role tag + a single relationship-to-here fact, hard-capped short — and `null` (omitted, not padded) when there's no real fact/hook to show. Draw the relationship fact from the edge's `label`/`notes` field where present; draw the hook from the entity's current narration (`getCurrentEntityNarration`, `mutation-engine/entity-narration.mjs`) if any exists; if neither exists, return `null`.
- `flags.mjs`:
  - `contentReadinessFlag(world, entityId)` — reuses existing `pending-resolution` (deferred debt) lookups plus `getCurrentEntityNarration` absence, per design record §5. Kept independent of the structural flag.
  - `structuralUnderConnectionFlag(entities, edges, entityId, { minEdges })` — pure graph function, edge-count threshold, no store I/O.
  - Both accept a corridor-distance value so callers can apply the severity scoping from §5 (loud in-corridor, quiet beyond) — the scoping/collapsing logic itself belongs in the brief assembler (16.5), these two functions just need to expose the raw flag plus the distance it was computed at.

**Acceptance criteria:** all digest/flag 16.0 tests pass, including the explicit "renders empty" and "flags fire independently" cases.

---

### 16.4 — Notes-as-deferred-intake
**Files:** new `session-planner/session-notes.mjs`

- Append-only per-world store (same store-pattern precedent as 16.2), one entry per captured note: `{ id, text, anchorEntityId, sceneId, timestamp, consumed: boolean }`.
- `captureNote(world, { text, anchorEntityId, sceneId })` — zero-ceremony capture, no validation beyond the world-id check already centralized in `resolve.mjs`.
- `listPendingNotes(world)` — unconsumed notes only.
- `runBatchIntake(world, noteIds, existingSnapshot, opts)` — packages the selected notes' text into the shape `scanForMentionedEntities`/`previewWriteupImport` (`graph-import/scan-mentions.mjs`, `graph-import/writeup-import.mjs`) already expect, seeds `applyFuzzyPrepass` with each note's `anchorEntityId` as a high-confidence existing-entity hint, and returns the same proposed-mutations shape those functions already produce — this function is a thin adapter over the existing pipeline, not new intake logic. Marks the consumed notes `consumed: true` only after the intake call succeeds (matches the project's "nothing is silently lost" convention already used elsewhere, e.g. entity-narration's supersede-not-delete pattern).
- Explicitly do **not** add any "promote to context" or auto-accept path — batch intake output lands on the existing pending-mutation review/accept gate exactly like any other proposal, per design record §6.

**Acceptance criteria:** all notes-related 16.0 tests pass, including the duplicate-entity-avoidance test and the never-auto-writes-to-canon test.

---

### 16.5 — Session Brief assembler
**Files:** new `session-planner/brief.mjs`

- `buildSessionBrief(world, snapshot, scene, { corridorTolerance })` — pure orchestration: calls `corridorNodes` (16.1) rooted at the scene's route/location, builds a `buildAmbientDigestEntry` (16.3) per corridor node, computes both flags (16.3) per node and applies the severity/scoping split from design record §5 (in-corridor nodes get a full flag, beyond-corridor nodes collapse into a count), and folds in `listPendingNotes` (16.4) for the scene's anchor entities.
- Returns a plain data structure (locations → digest entries → flags → note counts) — **no HTML, no document formatting, no numbering scheme** (design record §7's framing correction is a data-shape decision as much as a UI one: don't emit anything that implies a linear chapter sequence — return the corridor nodes as an unordered/distance-tagged collection, let the eventual Phase 17 UI decide how to lay them out, don't bake chapter order into the data itself).
- Also exposes a `checkStaleness(world, scene, currentLocationEntityId)` helper — compares the scene's anchor location against wherever the party actually currently is (if that's been recorded), for the proactive staleness detection called out in §7. This phase implements the check; Phase 17 wires it to actually notify the DM in the UI.

**Acceptance criteria:** all brief-assembly 16.0 tests pass; a manual test confirms `buildSessionBrief`'s output contains no ordinal/chapter-numbering field anywhere in its shape.

---

### 16.6 — Server routes
**Files:** `review-ui/server.mjs`

- `POST /api/session-planner/scenes` (create), `POST /api/session-planner/scenes/:id/fork`, `GET /api/session-planner/scenes/:id` — thin wrappers over 16.2.
- `GET /api/session-planner/brief?sceneId=...&corridorTolerance=...` — wraps 16.5.
- `POST /api/session-planner/notes` (capture), `POST /api/session-planner/notes/intake` (batch-run, body: note ids) — wraps 16.4.
- Every route uses the existing `resolveWorld`/`resolveDir()` (parameterless) pattern established by the Phase 15-era security fix — **no route in this task should re-introduce a client-controlled `dataDir`**, this is the single highest-risk regression to watch for given this phase adds several brand-new routes at once.
- No new UI wiring — these routes exist for 16.0's route-level tests and for Phase 17 to consume later, nothing in `review-ui/public/` changes in this phase.

**Acceptance criteria:** all 16.0 route-level tests pass; `review-ui/test/routes.test.mjs`'s existing security tests (client-supplied `dataDir` ignored, invalid `world` rejected) still pass unmodified, and the same two checks now also cover every new route added here.

---

## How to work

- Task 16.0 must fully complete, commit, and be confirmed red (failing on missing implementation, not silently passing) before 16.1 starts.
- Ground every implementation task in the actual current code — re-locate exact lines fresh, the grounding section above may have drifted by the time each task starts.
- Commit after each completed task, clean incremental history. Stage files explicitly, never `git add -A`.
- `foundry_worldFabric` is not touched anywhere in this phase (confirmed in the design record — no schema change needed for the corrected corridor-distance mechanism). Verify `git -C /home/russell/foundry_worldFabric status --short` is unchanged before and after this phase regardless, matching this project's standing discipline around that repo's pre-existing unrelated uncommitted changes.
- Self-review remediation pass at the end of 16.6: run the full `node --test` suite (root + `wf-mcp-server` + `review-ui`), confirm nothing outside this phase's own new files regressed.

## Definition of done for Phase 16

- [ ] 16.0's test suite committed, confirmed red before any implementation exists.
- [ ] Path-corridor traversal engine (16.1) built and unit-tested, degenerate single-point case confirmed.
- [ ] Scene store (16.2) built and tested, fork metadata confirmed carried forward.
- [ ] Ambient digest + two independent flags (16.3) built and tested, "renders empty" behavior confirmed.
- [ ] Notes-as-deferred-intake (16.4) built and tested, duplicate-avoidance and never-auto-writes-to-canon behaviors confirmed.
- [ ] Session Brief assembler (16.5) built and tested, no chapter-numbering in the data shape.
- [ ] Server routes (16.6) wired, existing + new security tests passing.
- [ ] Full existing test suite (root + `wf-mcp-server` + `review-ui`) still passes.
- [ ] `.gitignore` entries present for every new store.
- [ ] `foundry_worldFabric` confirmed untouched throughout.
- [ ] Self-review remediation pass run and reported.
