# GM_Tools — Phase 2/2b Task Plan (revised post-Phase-1/1.5/1.5b review)

**This is a rewrite of the original phase-2 plan, not the original.** Before executing Phase 2, Russell asked for a technical review pass — a re-review of this plan plus a fresh systems-architecture pass on an open design question it depended on. Both landed with real findings, not a rubber stamp; this file is the result. Full review reasoning lives in `plans/phase-2-review.md` — read it if a task's rationale here needs more depth than the task itself gives.

**What changed, in short:** re-reading the original plan against what Phase 1 actually shipped found that `wf_propose_mutations` (task 1.8) already implements most of what the original tasks 2.1/2.2 assumed still needed building — whole-graph ambient decay, tag filtering, multi-seed propagation, and region-batched texturing are all live today, built directly into the MCP tool handler rather than a separate `time-skip/` module. Executing the original plan as written would have duplicated that logic or built dead code. This version restructures around that finding (a new extraction-first task 2.0), and folds in two capabilities the original file predates: LLM-inferred seed resolution (kept as its own task, deliberately not mixed into deterministic scope-resolution code) and a `region` + `contained-in` scope mode pair, the latter now unblocked by a systems-architecture review that resolved its open semantic question (`containment`-typed edges only, not `origin`).

**Status:** ready to execute. **Prerequisite reading:** `CLAUDE.md` → `PLAN.md` → this file → `.claude/skills/gm-tools-conventions/SKILL.md` → `plans/phase-2-review.md` (the "why" behind this restructure).

**How to work this file:** checkpoint-gated, same model as Phase 1/1.5 — work top to bottom, run acceptance tests after each task, don't run as an unattended scheduled loop. **Budget a remediation session as a planned step, not a contingency** — Phase 1's real path was one build session followed by two remediation rounds (a code-review pass, then a live-state-verification pass), not one clean pass. Expect Phase 2 to need at least the first of those, and plan the "verify against already-existing persisted state, not just fresh fixtures" pass explicitly rather than hoping tests catch it (they didn't, last time).

---

## Task list

### 2.0 — Extract the existing orchestration into `time-skip/` (do first)
**Files:** `time-skip/scope.mjs`, `time-skip/run.mjs`; **modify:** `wf-mcp-server/index.mjs`

- Pull `wf_propose_mutations`'s current scope-resolution branching (`seed`/`ambient`/`tag`, lines ~407–438 of `wf-mcp-server/index.mjs` as of this writing) into `time-skip/scope.mjs` as `resolveScope(snapshot, scopeSpec)` — same three modes, same semantics, same field names (`mode`, `anchorId`, `depth`, `tag`, `elapsedSessions`, `seeds`). **Do not rename anything** — this MCP tool is already live and may already be in conversational use.
- Pull the propagate → filter → group → texture → `attachDiffs` → `createBatch` sequence (lines ~440–458) into `time-skip/run.mjs` as `orchestrateBatch(world, scopeSpec, elapsedTimeDescriptor, opts)`.
- Re-point `wf_propose_mutations`'s handler to call `resolveScope()` + `orchestrateBatch()` instead of inlining the logic.

**This is refactor-only — no new behavior, no new test cases to design.** Verification: `wf_propose_mutations`'s existing manual/smoke-test coverage (and any of Phase 1's automated tests that exercise it) must produce byte-identical results before and after the extraction. If you find yourself designing new test scenarios for this task, stop — that means you've drifted from "extract" into "redesign," which isn't this task's job.

---

### 2.1 — Add `region` and `contained-in` scope modes
**File:** `time-skip/scope.mjs` (extend `resolveScope`)

- New mode: `region` — BFS neighborhood from `anchorId` out to `depth` hops (reuse `wf-mcp-server/lib/graph.mjs`'s `neighborhood()`, don't reimplement), then apply `ambientDecay` (or seeded propagation, if seeds are also given) scoped to just that neighborhood's entities/edges — letting a GM time-skip one region/faction without touching the rest of the graph.
- New mode: `contained-in` — plain reachability BFS from `anchorId`, filtered to **`containment`-typed edges only**. Do **not** include `origin` edges — those answer a different question ("who's biographically from this place, regardless of where they are now") than `contained-in` ("what's structurally inside this place right now"). Conflating them would repeat, one layer up in `scope.mjs`, the exact category error the `containment`/`presence`/`origin` split was fixing at the schema level. Default depth **unbounded** (or a very high cap) — a district→building→room chain is the multi-hop case this mode exists for, unlike `region`'s intentionally shallow default. Do not assume or validate a strict single-parent tree; nothing in the schema enforces that (confirmed: no cardinality check on any relationship type in `graph-service.mjs`), so use the same visited-set BFS shape `neighborhood()` already uses, which handles a DAG/cycle safely without needing tree validation.
- This resolves the semantic question the original version of this task left open — see `plans/phase-2-review.md` for the full systems-architecture reasoning.

**Acceptance criteria:** unit test confirming `region` mode's entity set matches `neighborhood()`'s own output for the same anchor/depth (cross-check against the primitive, don't trust a fresh reimplementation); unit test confirming ambient decay under `region` mode only affects edges within the resolved neighborhood, not the whole graph; unit test confirming `contained-in` mode traverses `containment`-typed edges only (a fixture graph mixing `containment`/`origin`/`presence` edges should prove `origin` and `presence` are never followed); unit test confirming `contained-in` correctly reaches a multi-hop chain (e.g. district → building → room) that `region`'s shallow default depth would miss.

---

### 2.2 — Resumability
**File:** `time-skip/run.mjs` (extend `orchestrateBatch`)

- Write an incremental status file (`{batchId, phase: 'propagating'|'texturing'|'done', processedNodeIds: [...]}`) as work completes, not just at the end.
- On restart after an interruption, skip already-completed work — don't reprocess nodes or re-bill their LLM calls for regions already textured.

**Acceptance criteria:**
- Unit test with a mocked `texture.mjs`: simulate a kill mid-run (truncate/inspect the status file after partial completion), restart, assert no duplicate texture calls for already-processed regions.
- **Verify against already-written state, not just a freshly-created status file** (this exact category of gap slipped through automated tests in Phase 1.5 — see `plans/phase-2-review.md`). Specifically: start a run, let it write partial progress to disk, kill the *test process itself* (not just call the resume function again in the same process), then resume in a fresh process invocation and confirm it reads the already-persisted status file correctly rather than relying on in-memory state that a real crash wouldn't have.
- Integration smoke test with real (small, cheap) API calls confirming total call count stays materially below entity count for a multi-region fixture scope — validates the cost-reduction design empirically, not just via the mock.

---

### 2.2b — LLM-inferred seed resolution (kept separate, not folded into `resolveScope`)
**File:** `time-skip/resolve-seed.mjs`

- Given a freeform event description ("the tavern owner dies"), resolve it to a graph entity ID — an LLM call against the snapshot's entity list (or a relevant subset, e.g. via `wf_get_context`'s existing budgeted serialization) to find the best match, with disambiguation when multiple entities plausibly match (return candidates + ask, don't silently guess wrong).
- **Kept deliberately separate from `resolveScope()`** — that function is pure/deterministic and should stay that way (it's what made Phase 1's `propagate.mjs` cheap to verify: 85 assertions, no mocking needed for the graph-math half). Seed inference is LLM-dependent and needs the `texture.mjs`-style test pattern instead, not `propagate.mjs`'s.

**Acceptance criteria:** unit test with a mocked API call verifying single-match resolution, multi-match disambiguation (returns candidates rather than guessing), and no-match handling (typed error, not a silent no-op). Manual/integration smoke test with a real API call against the fixture graph.

---

### 2.3 — Headless apply
**File:** `graph-import/headless-apply.mjs`

*(Confirmed genuinely not started, no drift from the original plan to correct.)*

- Import `importGraph()`/`exportGraph()` directly from `foundry_worldFabric/scripts/data/interchange.mjs` as a library dependency (confirmed pure/Foundry-free).
- `applyHeadless(snapshotPath, mutations)` — loads the standalone snapshot JSON, runs `importGraph()` in merge mode, writes the result back. No live Foundry client required.
- `bootstrapSnapshot(snapshotPath)` — creates a brand-new empty snapshot file for a campaign with no pre-existing Foundry world at all.

**Acceptance criteria:**
- Unit test: `bootstrapSnapshot` on a non-existent path succeeds and produces a valid empty snapshot.
- Unit test: `applyHeadless` against a **fixture snapshot that already has prior content** (not just the empty-then-apply case) — verify the resulting file's merged state is correct. This is the realistic case; testing only against a freshly-bootstrapped empty file would pass even with a subtle merge-into-existing-data bug (the same already-persisted-state blind spot as 2.2, applied here to a different file).

---

### 2.4 — Sync wiring
**File:** `wf-mcp-server/index.mjs` (extend `wf_sync_to_foundry`, added in Phase 1 task 1.8)

*(Same intent as the original plan; mechanics updated to call into 2.0's extraction rather than duplicate logic.)*

- On sync: attempt the existing live `wf_apply_mutations` first.
- On `queued`/timeout (no live Foundry client), fall back to 2.3's `applyHeadless` against the standalone snapshot.
- Report explicitly which path was used — never just `"success"`.

**Acceptance criteria:** manual test run twice — Foundry closed (headless path exercised, standalone snapshot verified updated) and Foundry open (live path exercised, existing behavior unchanged). Both report which path was used.

---

## Definition of done for Phase 2/2b

- [ ] All unit tests from 2.0–2.4 pass; the 2.2 integration smoke test has run at least once against real API calls with the observed call-count reduction recorded.
- [ ] 2.0's extraction verified byte-identical to `wf_propose_mutations`'s pre-extraction behavior — no silent mode-name or semantics drift on an already-shipped tool.
- [ ] `contained-in` scope mode built and tested per task 2.1, confirmed to traverse `containment`-typed edges only (never `origin`/`presence`), with unbounded depth and no strict-tree assumption.
- [ ] 2.2's resumability test includes a real cross-process kill-and-resume, not just an in-process simulation.
- [ ] 2.3's merge test includes an already-populated fixture snapshot, not just the empty-bootstrap case.
- [ ] `wf_sync_to_foundry` correctly falls back to headless apply and reports which path it used, verified with Foundry both closed and open.
- [ ] A full time-skip round-trip run manually end-to-end, including at least one `region`-mode run, one `contained-in`-mode run, and one LLM-inferred-seed run.
- [ ] **A remediation pass has actually happened** — either a code-review pass surfaced nothing (state that explicitly, don't just skip it) or issues were found and fixed, mirroring Phase 1's real pattern rather than assuming a clean first pass.
