# GM_Tools — Phase 1 Task Plan: Mutation Engine Core

**Status:** ready to execute. **Prerequisite reading for whoever (human or autonomous session) picks this up:** `GM_Tools/CLAUDE.md` → `GM_Tools/PLAN.md` → this file → the `gm-tools-conventions` skill (auto-loads if project-scoped; see `.claude/skills/gm-tools-conventions/SKILL.md`).

**How to work this file:** tasks are ordered — later tasks depend on earlier ones. Run each task's acceptance-criteria tests before moving to the next. A **stop-and-check gate** on a task means: flag the specific point in your final report to Russell, but do not treat it as blocking — finish the rest of Phase 1 and let him weigh in on the flagged item asynchronously, unless the gate text says otherwise. Do not run this phase as a scheduled/unattended loop — it's meant to be a checkpointed session.

**Scope note (revised from an earlier draft of this plan):** Phase 1's review interface is **conversational, via new MCP tools** — not a web UI. Russell confirmed he's running a purely LLM-enabled/JSON-comfortable workflow near-term and wants the dedicated web UI *designed but deferred* to a later phase (Phase 6). That design is preserved in `PLAN.md`'s phase table for when that phase gets picked up — don't build it as part of this file's tasks.

---

## Task list

### 1.1 — Mutation schema module
**File:** `mutation-engine/schema.mjs`

Zod schemas:
- `Mutation` — extends `wf-mcp-server`'s existing `wf_apply_mutations` shape (`op`, `id`, `data`) with: `rationale: string`, `batchId: string`, `sourceKind: enum['ambient-decay', 'seeded-propagation', 'manual']`, `impactScore: number.optional()`.
- `Batch` — `{ id, world, createdAt, scope, elapsedTimeDescriptor, mutations: Mutation[], status }`.
- `ReviewState` — per-mutation status: `enum['pending', 'accepted', 'rejected', 'regenerate-requested', 'rolled-back']`.

Export `SCHEMA_VERSION = 1`.

**Acceptance criteria:** unit tests (`node --test` style, mirroring `foundry_worldFabric/test/m1.test.mjs`) validate at least one good and one bad example object per schema; `SCHEMA_VERSION` is exported and asserted in a test.

---

### 1.2 — Diff engine
**File:** `mutation-engine/diff.mjs`

- `diffEntity(before, after)` → `{field, from, to}[]` over the known entity fields (`name`, `type`, `description`, `summary`, `importance`, `imageUrl`, `tags`, `attributes`, `foundryRef`, `namespace`) — **excludes** `updatedAt`/`createdAt`/`id`.
- `diffEdge(before, after)` → same shape over edge fields (`relationshipType`, `label`, `strength`, `valence`, `notes`).
- `before === null` (new entity/edge) produces a single `{field: '(created)', from: null, to: after}` marker, not a per-field diff.
- No-change case returns `[]`.

**Acceptance criteria:** unit tests cover all three cases (changed fields, no change, created).

---

### 1.3 — Propagation engine
**File:** `mutation-engine/propagate.mjs`

Implements two deterministic (non-LLM) mechanisms, config-driven:

```js
export const EDGE_TYPE_WEIGHT = {
  causal: 1.0, fealty: 0.9, kinship: 0.85, membership: 0.7,
  ownership: 0.6, location: 0.55, knowledge: 0.5, social: 0.4, unspecified: 0.3,
};
export const DECAY_HALF_LIFE_SESSIONS = {
  fealty: 8, kinship: 10, membership: 6, causal: 12,
  ownership: 6, location: 4, knowledge: 5, social: 2, unspecified: 3,
};
export const IMPACT_THRESHOLD = 0.15;
export const IMPORTANCE_FLOOR = 0.2;
export const PRUNE_FLOOR = 0.01;
```

**Superseded by Phase 1.5** (see `plans/phase-1.5-tasks.md`): the block above is
the values as originally shipped for Phase 1 and is kept here as a historical
record of what task 1.3 delivered. The live constants in `mutation-engine/propagate.mjs`
now rename the `location` key to `presence` (same value, 0.55/4 — a rename,
not a retune) and add a `containment` key (`EDGE_TYPE_WEIGHT.containment: 0.6`;
no `DECAY_HALF_LIFE_SESSIONS` entry — `containment` edges are hard-excluded
from `ambientDecay` entirely, not merely slow-decaying).

**Further superseded by Phase 1.5b:** adds an `origin` key
(`EDGE_TYPE_WEIGHT.origin: 0.6`, matching `containment`; no
`DECAY_HALF_LIFE_SESSIONS` entry, same hard-exclusion treatment as
`containment` — see `plans/phase-1.5-tasks.md`'s addendum) for
`person.homeLocation`'s origin/hometown edges, a biographical fact
distinct from `containment`'s structural one despite sharing the
non-decay treatment.

- `propagateSeed(entities, edges, seedId, seedMagnitude, maxDepth)` — weighted BFS diffusion of an impact score outward from a seed entity, using `EDGE_TYPE_WEIGHT[edge.relationshipType] * edge.strength` as the per-hop multiplier. Returns `Map<entityId, impactScore>`.
- `ambientDecay(edges, elapsedSessions)` — per-`relationshipType` half-life decay of edge `strength`, reusing the same decay-formula shape as `foundry_worldFabric/scripts/data/llm-context.mjs`'s existing `recencyScore()` (`Math.pow(0.5, elapsed/halfLife)`). Returns an array of `{edgeId, relationshipType, from, to, delta}`.
- `candidateDeltas(entities, edges, {seedId?, seedMagnitude?, elapsedSessions})` — combines both into a flat list of `{kind: 'seed-propagated'|'ambient-decay', ..., needsLLM: boolean}`, where `needsLLM` is derived from `IMPACT_THRESHOLD`/`IMPORTANCE_FLOOR`/decay-magnitude.

This reuses the algorithm validated in the planning pass's prototype — re-implement from this design, no throwaway script to copy from.

**Acceptance criteria (unit tests against a small fixture graph, e.g. reuse `foundry_worldFabric/test/e2e-m2.mjs`'s Riverwood/Whiterun/Companions fixture shape):**
- Impact strictly decreases with hop distance from a seed.
- At equal hop-distance, a stronger/higher-weight edge ranks above a weaker one (e.g. a strong `kinship` edge should outrank a weaker `location` edge at the same hop distance).
- Entities below `IMPORTANCE_FLOOR` + `IMPACT_THRESHOLD` produce `needsLLM: false`.
- Ambient decay reduces `strength` monotonically with elapsed sessions and respects per-type half-life ordering (a `social` edge decays faster than a `fealty` edge over the same elapsed time).

**Stop-and-check gate (non-blocking):** `EDGE_TYPE_WEIGHT`, `DECAY_HALF_LIFE_SESSIONS`, `IMPACT_THRESHOLD`, and `IMPORTANCE_FLOOR` above are plausible starting values, not calibrated against a real campaign. **Ship them as-is.** Russell has explicitly deferred tuning to a distinct future step once he has live playtest data from actually running time-skip batches — do not block Phase 1 completion on calibrating these. Flag in your final report that these are "shipped as prototype defaults, calibration pass scheduled for later, not now."

---

### 1.4 — Review-state store
**File:** `mutation-engine/review-state.mjs`

- File-per-batch JSON persistence: `GM_Tools/review-state/<world>/<batchId>.json`.
- `createBatch(world, scope, elapsedTimeDescriptor, mutations)` → writes a new batch file, all mutations `status: 'pending'`.
- `loadBatch(world, batchId)` / `saveBatch(world, batch)`.
- `updateMutationStatus(world, batchId, mutationId, status)`.
- `listBatches(world)`.
- **Concurrency guard:** before writing, check for an existing unflushed/in-progress marker on the same batch file; reject or queue rather than blind-overwrite.

**Acceptance criteria:** unit tests round-trip create → save → load; a simulated concurrent-write attempt is rejected/queued, not silently clobbered.

---

### 1.5 — Batched LLM texturing
**Files:** `mutation-engine/texture.mjs`, `prompts/texture.md`

- **New dependency: `@anthropic-ai/sdk`** — first place `GM_Tools` calls the Anthropic API outward (everything else so far is called *by* Claude via MCP).
- Given a batch of `candidateDeltas` (from 1.3) that have `needsLLM: true`, grouped by region/cluster (not one call per node — this is the acceptance-critical cost-control behavior), make one structured-output Anthropic API call per group producing an array of `Mutation` objects (1.1's schema) with `rationale` text.
- Default model: `claude-sonnet-5`. Accept an override for higher-stakes calls (not needed within Phase 1 itself, but the parameter should exist for Phase 3/live-diff to use later).
- Self-validates output against 1.1's schema; on validation failure, retry once with the validation error appended to the prompt; on a second failure, surface a typed error rather than silently dropping the batch.

**Acceptance criteria:** unit test with a mocked API call verifies the validate → retry-once → typed-error-on-second-failure path. A manual/integration smoke test (documented, not necessarily automated in CI) makes one real API call against a small fixture batch and confirms the output validates.

---

### 1.6 — Headline/grain logic
**File:** `mutation-engine/grain.mjs`

- `summarizeBatch(batch)` → `{headline: string, regions: [{regionId, entities, headline}]}`, using each entity's `importance` to decide default collapse, plus an override flag (add `alwaysShowFull: boolean` to the entity-level review preference — sourced from World Fabric's existing `tags` field via a convention like a `"pin-review"` tag, or a small new per-world config file; pick whichever is less invasive and document the choice) to force full-diff visibility regardless of `importance`.
- Render functions for **conversational display** (plain text/markdown suitable for a chat message, not HTML): `renderHeadline(summary)`, `renderRegionDiff(region)`, `renderEntityDiff(entityId)`.

**Acceptance criteria:** unit tests verify region grouping by BFS-distance/tag, verify the override flag forces an otherwise-collapsed entity into the headline, and verify the render functions produce readable plain-text output (a human-readability check, not just "doesn't throw").

---

### 1.7 — Rollback
**File:** `mutation-engine/rollback.mjs`

- At accept-time, capture the pre-mutation entity/edge state into the batch record (before applying).
- `rollbackBatch(world, batchId)` — re-applies the captured pre-state. **Confirmed scope: most-recently-accepted batch only** — no multi-batch version history needed.

**Acceptance criteria:** unit test: accept a batch (mocked apply) → simulate apply → rollback → verify end state matches pre-accept state exactly.

---

### 1.8 — Conversational review MCP tools
**File:** `wf-mcp-server/index.mjs` (extend the existing server)

This is Phase 1's review *surface* — six new MCP tools, following the exact zod-`inputSchema` + handler pattern the file's existing 7 tools already use. Each is a thin wrapper calling straight into `mutation-engine/`'s library functions (1.1–1.7) — no logic duplication.

| Tool | Input | Behavior |
|---|---|---|
| `wf_propose_mutations` | `world`, `scope` (`{mode, anchorId?, depth?, tag?}`), `elapsedTimeDescriptor?`, `seeds?` | Runs 1.3 (propagate) → 1.5 (texture) → 1.4 (createBatch). Returns `batchId` + 1.6's headline. |
| `wf_review_batch` | `world`, `batchId`, `grain` (`'headline'\|'region'\|'entity'`), `regionId?`, `entityId?` | Renders the requested grain via 1.6's render functions. |
| `wf_accept` | `world`, `batchId`, `scope` (`'batch'\|'region'\|'entity'`), `id?` | Marks mutation(s) accepted via 1.4, captures rollback state via 1.7. |
| `wf_reject` | `world`, `batchId`, `scope`, `id?` | Marks mutation(s) rejected via 1.4. |
| `wf_regenerate` | `world`, `batchId`, `scope`, `id?`, `note` | Re-invokes 1.5 for the selected scope with the note appended to the prompt; **replaces**, does not stack onto, the prior proposal for that scope. |
| `wf_sync_to_foundry` | `world`, `batchId` | Attempts the existing live `wf_apply_mutations` for accepted mutations. **Known Phase-1 limitation, expected and resolved in Phase 2b:** until the headless-apply path (Phase 2b's `graph-import/headless-apply.mjs`) exists, this reports `queued`/`not confirmed` whenever no Foundry client is open — same behavior `wf_apply_mutations` already has today. Don't build a headless fallback in Phase 1; that's explicitly Phase 2b's job. |

**Acceptance criteria:** manual smoke test from an actual Claude Code session — call `wf_propose_mutations` against a real (or realistic fixture) snapshot, confirm a batch file appears on disk, call `wf_review_batch` at each grain level and confirm the rendered text is legible, accept/reject/regenerate at least one item each, confirm `review-state.mjs`'s file reflects the changes, call `wf_sync_to_foundry` and confirm it reports status honestly (queued if no Foundry client open).

---

### 1.9 — [DEFERRED — do not build in Phase 1]
The dedicated web review UI (batch list, headline view, drill-down diff, accept/reject/regenerate/sync buttons) is **explicitly deferred** to Phase 6 per Russell's direction — he wants it designed and kept on record, not built now. See `PLAN.md`'s phase table for the retained design (Express/`node:http` + vanilla JS/HTML, no framework, no build step) — pick that up unchanged when that phase is scheduled. Do not start any `review-ui/` work as part of Phase 1.

---

## Definition of done for Phase 1

- [ ] All unit tests from 1.1–1.7 pass.
- [ ] A full manual conversational round-trip works end-to-end against a real or realistic-fixture snapshot: `wf_propose_mutations` → `wf_review_batch` (headline) → drill into one region → `wf_accept` one item, `wf_reject` one item, `wf_regenerate` one item with a note → `wf_sync_to_foundry` (reports `queued` if no Foundry client — expected) → `rollbackBatch` the accepted item(s) → confirm graph state matches pre-accept.
- [ ] The propagation-tuning stop-and-check gate (task 1.3) has been flagged in the closing report, not silently skipped and not treated as blocking.
- [ ] `SCHEMA_VERSION` (1.1) and the review-state file format are documented (a short note in `mutation-engine/README.md` is sufficient — no need for a formal ADR for this alone).
