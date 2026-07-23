# GM_Tools — Phase 2/2b Task Plan: Time-Skip Mode + Headless Apply

**Status:** ready to execute once Phase 1 (`plans/phase-1-tasks.md`) is done — this phase's orchestrator and headless-apply path both call directly into `mutation-engine/`'s Phase 1 library modules. **Prerequisite reading:** same as Phase 1 — `CLAUDE.md` → `PLAN.md` → this file → `gm-tools-conventions` skill.

**Why 2 and 2b are one file:** they're separable pieces of work but not separably *valuable* — time-skip mode without headless apply means every accepted batch still requires a live Foundry client to actually commit, which undercuts the "runs between sessions" pitch that makes time-skip the MVP wedge in the first place. Do both before calling this phase done.

**How to work this file:** same checkpoint-gated model as Phase 1 — work top to bottom, run acceptance tests after each task, don't run this as an unattended scheduled loop.

---

## Task list

### 2.1 — Scope resolution
**File:** `time-skip/scope.mjs`

- `resolveScope(snapshot, {mode: 'whole-graph'|'region'|'tag', anchorId?, depth?, tag?})` → `entityId[]`.
  - `whole-graph`: every entity in the snapshot.
  - `region`: BFS neighborhood from `anchorId` out to `depth` hops (reuse `wf-mcp-server/lib/graph.mjs`'s `neighborhood()` — don't reimplement).
  - `tag`: every entity whose `tags` array includes `tag`.

**Acceptance criteria:** unit tests for each mode against a fixture graph; `region` mode's output matches `neighborhood()`'s own entity list for the same anchor/depth (cross-check against the existing primitive rather than trusting a fresh reimplementation).

---

### 2.2 — Batch orchestrator
**File:** `time-skip/run.mjs`

Given `{world, scope, elapsedTimeDescriptor, seeds?: [{entityId, description, magnitude?}]}`:

1. Resolve scope via 2.1.
2. Run `propagate.mjs`'s `ambientDecay` across all edges touching the scope.
3. For each provided seed, run `propagate.mjs`'s `propagateSeed` (radius-bounded per a configurable `maxSeedDepth`), blended into the same candidate list as step 2's ambient deltas — this is the seeded-propagation-within-a-time-skip case, distinct from live-diff's always-single-seed mode.
4. Filter candidates to `needsLLM: true` (per 1.3's thresholds).
5. Group filtered candidates into a small, bounded number of `texture.mjs` calls by region/cluster — **acceptance-critical:** call count must scale sub-linearly with scope size, not 1:1 with node count. This is the behavior that makes the batching-driven cost-reduction real rather than theoretical.
6. Persist the result as one batch via `review-state.mjs`'s `createBatch`.

**Resumability:** write an incremental status file (`{batchId, phase: 'propagating'|'texturing'|'done', processedNodeIds: [...]}`) as work completes, not just at the end. On restart after a crash, skip already-completed work — don't reprocess nodes or re-bill their LLM calls.

**Acceptance criteria:**
- Unit test with a **mocked** `texture.mjs` (no real API calls) verifying: orchestration order (propagate before texture), correct call-grouping (assert call count < candidate count for a scope with ≥10 candidates), and resumability (simulate a kill mid-run by truncating the status file, restart, assert no duplicate `texture.mjs` invocations for already-processed nodes).
- **Integration smoke test** with real (small, cheap) API calls against the fixture graph: confirm total LLM call count is materially below entity count in scope — this empirically validates the cost-reduction design against real output, not just the mock. Record the actual call count observed for the fixture size, for later comparison once Russell's real campaign graph size is known.

---

### 2.3 — Headless apply
**File:** `graph-import/headless-apply.mjs`

- Import `importGraph()`/`exportGraph()` directly from `foundry_worldFabric/scripts/data/interchange.mjs` as a library dependency (already confirmed pure/Foundry-free — no `game.settings`, no Foundry runtime required).
- `applyHeadless(snapshotPath, mutations)` — loads the standalone snapshot JSON, runs `importGraph()` in merge mode, writes the result back. No live Foundry client required.
- `bootstrapSnapshot(snapshotPath)` — creates a brand-new empty snapshot file (entities: [], edges: [], entityTypes: []) for a campaign with no pre-existing Foundry world at all. (Minimal groundwork for the later Foundry-optional graph-construction phase — not full scope, just enough that headless apply doesn't assume a Foundry-created file already exists.)

**Acceptance criteria:** unit tests — (a) apply a batch of accepted mutations to a fixture snapshot file, verify the resulting file matches the expected merged state (entity/edge counts, field values); (b) `bootstrapSnapshot` on a non-existent path succeeds and produces a valid empty snapshot that `applyHeadless` can then write into.

---

### 2.4 — Sync wiring
**File:** `wf-mcp-server/index.mjs` (extend `wf_sync_to_foundry`, added in Phase 1 task 1.8)

- On sync: attempt the existing live `wf_apply_mutations` first (poll behavior unchanged from what it already does).
- On `queued`/timeout (no live Foundry client), fall back to 2.3's `applyHeadless` against the standalone snapshot.
- Report explicitly which path was used — `"applied via Foundry"` vs. `"applied headless (Foundry not open)"` — never just `"success"` (graceful degradation must be visible, not silent).

**Acceptance criteria:** manual test run twice — once with Foundry closed (headless path exercised, verify the standalone snapshot file updated correctly) and once with Foundry open (live path exercised, verify existing behavior unchanged). Both must report which path was actually used.

---

## Definition of done for Phase 2/2b

- [ ] All unit tests from 2.1–2.3 pass; the 2.2 integration smoke test has run at least once against real API calls and the observed call-count reduction is recorded.
- [ ] `wf_sync_to_foundry` correctly falls back to headless apply and reports which path it used, verified with Foundry both closed and open.
- [ ] A full time-skip round-trip has been run manually end-to-end: `wf_propose_mutations`-equivalent for time-skip (or a new `wf_run_timeskip` tool if you decide the batch-orchestrator warrants its own MCP entry point rather than reusing `wf_propose_mutations` with a `mode: 'timeskip'` flag — either is acceptable, pick one and document the choice) → review via Phase 1's conversational tools → accept/reject/regenerate → sync (both paths) → rollback works the same as it did in Phase 1.
- [ ] The "runs between sessions" claim is actually true: confirm a time-skip batch can be proposed, reviewed, and committed (via headless apply) with Foundry never having been opened during the process.
