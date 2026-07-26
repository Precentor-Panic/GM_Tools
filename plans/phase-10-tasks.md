# GM_Tools — Phase 10 Task Plan: Per-Entity Narration & Persistence

**Status:** ready to execute. **Prerequisite reading:** `CLAUDE.md` → `PLAN.md` → this file → `plans/phase-10-review.md` (root cause + decisions — read it before touching `narrate.mjs`, the granularity/storage choices are settled, not a starting point to redesign) → `.claude/skills/gm-tools-conventions/SKILL.md`.

**What this is:** replaces whole-batch narration with per-entity narration, persisted durably (not just cached in a browser tab), targeted using the entity's own real graph connections instead of empty location/area hints. Directly fixes a cluster of real bugs found in first hands-on use: identical narration across every row, "regenerate" recycling the same generic text, no memory of a previously-accepted narration, and a default "session zero" framing caused by narrating with zero grounding context.

**What's already built and reusable — confirmed by reading the code, not assumed:**
- `mutation-engine/narrate.mjs`'s `assertBatchNarratable`/truncation-handling/`renderMutationSummary` pattern — the per-entity gate and truncation logic are the same shape, just scoped down from "every mutation in the batch" to "this one mutation."
- `mutation-engine/human-review.mjs` — the exact flat-JSON/`withLock`/env-override convention the new narration store should follow.
- Whatever BFS/adjacency helper `wf_get_adjacent`/`propagate.mjs` already expose for "this entity's immediate neighbors" — reuse for targeting context, don't write a second graph-walk.
- `mutation-engine/llm-call.mjs`'s `callModelDetailed` — already used by `narrate.mjs`, no change needed there.

---

## Task list

### 10.1 — Entity narration store
**Files:** `mutation-engine/entity-narration.mjs` (new)

- Follows `human-review.mjs`'s convention exactly: flat JSON, one file per world (or per world+entity — your call once in the code, matching whichever existing precedent fits better), `GM_TOOLS_ENTITY_NARRATION_DIR` env-override, `review-state.mjs`'s `withLock` reused for writes.
- Shape: a **history**, not a single "latest" value — each entry carries at minimum `{prose, createdAt, sourceMutationId, sourceBatchId, status}` where `status` is `'current'` or `'superseded'`. Only one entry per entity may be `'current'` at a time.
- `getEntityNarrationHistory(world, entityId)`, `getCurrentEntityNarration(world, entityId)`, `saveEntityNarration(world, entityId, {prose, sourceMutationId, sourceBatchId})` (marks any existing `'current'` entry `'superseded'` before writing the new one — never deletes history), `supersedeEntityNarration(world, entityId)` (marks current as superseded without adding a new one — called when the entity is mutated again, so a stale narration doesn't keep showing as current).

**Acceptance criteria:** unit tests matching `human-review.mjs`'s own test style: save-then-get round trip, a second save supersedes the first (both remain in history, only the newer is `'current'`), `supersedeEntityNarration` on an entity with no narration yet is a safe no-op, directory isolation via env override, a real concurrent-write test via the shared lock.

---

### 10.2 — Per-entity narration call
**Files:** `mutation-engine/narrate.mjs` (extend)

- New `narrateEntity(mutation, batch, ctx, opts)` (naming your call) — same gate as today (`status:'accepted'` on that specific mutation, not the whole batch), same truncation handling, but scoped to one mutation's own context instead of every mutation in the batch.
- **Targeting**: replace the always-empty `currentLocation`/`reachableAreas` slots with real grounding pulled from the entity's own immediate graph neighbors (reuse whatever adjacency helper `wf_get_adjacent`/`propagate.mjs` already expose — confirm the actual function signature by reading the code, don't guess it). This is the concrete fix for "less redundant, more targeted" — the model should be told what's actually near this entity, not asked to invent a scene from nothing.
- Decide (and document) what happens to whole-batch narration: per the design doc, per-entity is now the default path the UI uses; `narrateBatch` doesn't need to be deleted (existing tests/MCP tool `wf_narrate_batch` can keep working, in case a whole-scene summary is ever independently useful) but review-ui switches to the new entity-level call entirely.
- On success, call `saveEntityNarration` (10.1) so the result is durable, not just returned to the caller.

**Acceptance criteria:** unit tests (mocked LLM) confirming: the gate refuses a non-accepted mutation; the targeting context is built from real adjacent-entity data, not left empty; truncation handling still works at this granularity; a successful call persists via `saveEntityNarration`. A real-API smoke test comparing two DIFFERENT entities' narrations from the same batch and confirming they're genuinely different (not the same cached text) — this is the actual regression test for the bug that was found.

---

### 10.3 — Invalidation on re-mutation
**Files:** wherever mutations get applied/accepted for an entity already carrying a `'current'` narration (`wf-mcp-server/lib/mutation-ops.mjs` and/or `graph-import/headless-apply.mjs` — your call once you're in the code about the cleanest hook point)

- When an entity that has a `'current'` narration is mutated again (accepted/synced in a later batch), call `supersedeEntityNarration` for it — the old narration remains in history (recallable) but is no longer presented as current. This is the "persist unless the node is mutated" half of the requirement.

**Acceptance criteria:** a test proving: entity X gets narrated (current) → a later batch mutates X and gets accepted → X's narration is now superseded, not current, and querying history still returns the original prose.

---

### 10.4 — Wiring: MCP tool + review-ui routes
**Files:** `wf-mcp-server/index.mjs`, `wf-mcp-server/lib/mutation-ops.mjs`, `review-ui/server.mjs`

- New MCP tools (naming your call, matching existing conventions): narrate a specific entity, fetch an entity's current narration, fetch an entity's full history.
- New review-ui routes backing the same three operations, following `server.mjs`'s existing route-table pattern exactly.

**Acceptance criteria:** route-level tests matching `review-ui/test/routes.test.mjs`'s established style (deterministic, mocked-LLM-free where possible, real-API smoke test for the actual narration success path per this project's LLM-call testing convention).

---

### 10.5 — Frontend: per-row narration, not per-batch
**Files:** `review-ui/public/app.js`/`style.css`

- Replace `reviewState.narrationCache` (batch-wide, in-memory) with a per-row fetch of that entity's current narration (from 10.4's route), rendered in that row's own action area exactly where batch-level narration renders today — same visual treatment (serif/parchment card, distinct from the rationale card) established in Phase 6, just scoped correctly now.
- "Narrate This" becomes a per-row action, not a batch-wide one. Regenerate creates a new history entry (via 10.2/10.1) rather than overwriting in place.
- Add a small, secondary "view history" affordance per row (a GM asking "what did we narrate here last time" per the design doc's explicit ask) — doesn't need to be elaborate, a simple expandable list of past entries with timestamps is enough for v1.

**Acceptance criteria:** manually verified in a real browser (same standard as every prior UI phase — actual screenshots inspected, not assumed): narrating two different rows in the same batch produces two genuinely different texts; leaving and returning to a batch still shows the previously-generated narration for an already-narrated row (proving persistence, the specific thing that was broken); regenerating creates a new visible entry without losing the ability to see the prior one.

---

## How to work

- Ground every claim in the actual code — the adjacency/BFS helper this phase depends on for targeting must be read and confirmed, not assumed to have a particular shape.
- Write backend tests in the project's existing style (`node --test`, no framework); manual/screenshot-verified checks for the frontend, per established convention.
- Commit after each completed task.
- Self-review remediation pass at the end: specifically re-check that (a) the gate genuinely operates at entity grain now, not silently still requiring the whole batch to be accepted, (b) superseded narrations are never actually deleted, only marked, and (c) the frontend never shows a stale/superseded narration as if it were current.

## Definition of done for Phase 10

- [ ] `entity-narration.mjs` built and tested, following `human-review.mjs`'s exact convention.
- [ ] `narrateEntity` built, gated at entity grain, targeted using real adjacency data instead of empty context slots — confirmed via a real-API test that two entities in one batch get genuinely different narrations.
- [ ] Persistence confirmed durable across a fresh page load (the actual bug that was reported), not just in-memory.
- [ ] Re-mutating a narrated entity supersedes its narration without deleting history.
- [ ] MCP tool + review-ui routes wired; review-ui's frontend narrates per-row, shows history, and matches Phase 6's established visual convention for narration-vs-rationale distinction.
- [ ] Full test suite (root + wf-mcp-server + review-ui) still passes.
- [ ] Self-review remediation pass run and reported.
