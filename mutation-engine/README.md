# mutation-engine

Phase 1's mutation engine core — pure, Foundry-free library modules (no
dependency on an active MCP session, Claude Code, or a live Foundry client).
`wf-mcp-server/index.mjs`'s conversational review tools are thin wrappers
over these; see that server's own README for the tool list.

## Pipeline

```
propagate.mjs        candidateDeltas()          -- deterministic: BFS impact / ambient decay
       |
texture.mjs           textureBatch()            -- 1 Anthropic call per region, validated against schema.mjs
       |
review-state.mjs       createBatch()            -- persists the batch, all mutations 'pending'
       |
grain.mjs         summarizeBatch()/render*()    -- conversational headline/region/entity display
       |
rollback.mjs   acceptMutations() / rollbackBatch()  -- capture pre-state at accept, restore on rollback
```

`llm-call.mjs` (`callModel`/`fillTemplate`/`parseJsonResponse`) is shared
outbound-LLM-call plumbing, extracted during Phase 2's remediation pass once
`time-skip/resolve-seed.mjs` became the second module (alongside
`texture.mjs`) making a real Anthropic API call — both now import from here
rather than keeping their own near-identical copy.

`diff.mjs` (`diffEntity`/`diffEdge`) is a standalone utility for computing
field-level before/after diffs. `wf-mcp-server/index.mjs`'s `wf_propose_mutations`
handler calls it (via its own `attachDiffs` helper) against the live snapshot
right after texturing and before `createBatch`, merging each proposed
mutation's `data` onto the current entity/edge state and attaching the
result as the mutation's `diff` field — this is what `grain.mjs`'s
`renderEntityDiff` renders in place of its raw-JSON fallback.

## Schema version

`schema.mjs` exports `SCHEMA_VERSION = 1` for the `Mutation`/`StoredMutation`/
`Batch`/`ReviewState` shapes, following the precedent `interchange.mjs`'s
`WFI_VERSION` already set in `foundry_worldFabric`. Bump it and note the
breaking change here if the shape changes.

`Mutation` extends `wf-mcp-server`'s existing `wf_apply_mutations` input
shape (`op`/`id`/`data`) with `rationale`, `batchId`, `sourceKind`, and
optional `impactScore`. It is `.strict()` — a freshly-proposed mutation
(texture.mjs's LLM output, or a hand-authored 'manual' mutation) must satisfy
exactly this shape, nothing more; an unexpected field is a validation error,
not silently ignored.

`StoredMutation` is the separate, wider schema for the envelope actually
persisted to a batch file: `Mutation`'s core plus `mutationId`/`status`
(review-state.mjs's `createBatch`), `regionId`/`entityContext` (texture.mjs's
enrichment), `preState` (rollback.mjs's `acceptMutations`), and `diff`
(diff.mjs's field-level diff, attached by `wf_propose_mutations` before
persisting — see below). Every write/re-write of a stored mutation object
validates against `StoredMutation`, not `Mutation` with `.passthrough()` —
splitting the two schemas means a typo'd field name on any of them is still
caught, instead of every field beyond `Mutation`'s core going completely
unchecked.

## Review-state file format

File-per-batch JSON at `GM_Tools/review-state/<world>/<batchId>.json`
(override the root with `GM_TOOLS_REVIEW_STATE_DIR`, mainly for tests).

```jsonc
{
  "id": "batch_...",
  "world": "wf-test",
  "createdAt": "2026-07-23T...",
  "scope": { "mode": "seed", "anchorId": "alvor", "depth": 2 },
  "elapsedTimeDescriptor": "2 sessions",
  "status": "open",              // 'open' | 'synced' | 'rolled-back'
  "mutations": [
    {
      // schema.mjs's validated Mutation core:
      "op": "upsert_entity",
      "id": "alvor",
      "data": { "description": "..." },
      "rationale": "...",
      "batchId": "batch_...",
      "sourceKind": "seeded-propagation",
      "impactScore": 0.72,

      // review-state.mjs bookkeeping (schema.mjs's StoredMutation, not part of the strict Mutation core):
      "mutationId": "m0",           // stable per-mutation handle; entity's own `id` may not exist yet for a create
      "status": "pending",          // schema.mjs's ReviewState enum

      // texture.mjs enrichment (StoredMutation), consumed by grain.mjs:
      "regionId": "region-0",       // texture.mjs's connectivity-cluster id -- grain.mjs groups by this, doesn't recompute BFS
      "entityContext": { "name": "Alvor", "importance": 0.5, "tags": [] },

      // rollback.mjs enrichment, set at accept-time:
      "preState": { /* full pre-mutation entity/edge object, or null if this mutation created it */ },

      // diff.mjs enrichment, computed and attached by wf_propose_mutations
      // against the live snapshot before persisting; grain.mjs's
      // renderEntityDiff prefers this over a raw data dump when present:
      "diff": [{ "field": "importance", "from": 0.5, "to": 0.7 }]
    }
  ]
}
```

Concurrency: every write takes an exclusive `<batchId>.json.lock` file
(created with `wx`, so a second writer's open fails outright) before
touching the batch file. A write that finds an existing lock throws
`ConcurrentWriteError` rather than blind-overwriting.

## Containment vs. presence vs. origin (Phase 1.5 / 1.5b)

`ambientDecay` (`propagate.mjs`) hard-excludes edges whose `relationshipType` is in `NON_DECAYING_RELATIONSHIP_TYPES` — currently `containment` and `origin` — no delta is ever computed for them, at any elapsed-session value. This is a deliberate skip, not a very-long half-life: a half-life is still monotonic decay and would eventually misfire on a long enough campaign. `propagateSeed` is unaffected — a seeded event still ripples through both edge types normally, since that's a different, legitimate use of the same edges (e.g. "the district burned" should still reach the buildings within it; news of a hometown's fall should still reach someone who's from there).

`containment` and `origin` get the same non-decay treatment for different reasons, and it's worth keeping the distinction straight rather than merging them into one "permanent edges" concept:

- **`containment`** is *structural/compositional* — a place is part of a region, a faction's headquarters is a place (`place.region`, `faction.headquarters`). The entity is (part of) the other entity.
- **`origin`** is *biographical* — a person's hometown (`person.homeLocation`). The entity is *from* the other entity, not part of it; moving away doesn't change where someone's from, but a person was never compositionally "part of" their hometown the way a building is part of a district.

Reusing `containment` for `origin` would repeat, at smaller scale, the exact modeling mistake the original `location` split fixed — a fact needing a distinct "never decays" treatment is not the same as a fact needing containment semantics. See `plans/phase-1.5-tasks.md` for the full design-review reasoning behind the `containment`/`presence` split (World Fabric's former catch-all `location` type), and its Phase 1.5b follow-up for `origin`.

## Design choices flagged for Russell's review (non-blocking)

- **Propagation-tuning defaults (task 1.3).** `EDGE_TYPE_WEIGHT`,
  `DECAY_HALF_LIFE_SESSIONS`, `IMPACT_THRESHOLD`, `IMPORTANCE_FLOOR` are
  shipped as prototype defaults, not calibrated against a real campaign.
  Calibration is a deferred future step once live playtest data exists —
  per the task file's own stop-and-check gate text, this does not block
  Phase 1.
- **Headline collapse override (task 1.6).** "Always show full" is sourced
  from the existing WF `tags` field via a `"pin-review"` tag convention
  (`grain.mjs`), rather than a new per-world config file — picked as the
  less-invasive option per the task's own instruction to choose and
  document one.
- **`wf_rollback_batch` MCP tool.** Not in task 1.8's original 6-tool table,
  but added because the Phase 1 Definition of Done explicitly requires
  exercising `rollbackBatch` as part of the conversational round trip, and
  there was otherwise no MCP surface to call it from. See
  `wf-mcp-server/README.md`.
- **`person.homeLocation` (task 1.5.2, resolved in 1.5b).** Left flagged
  during Phase 1.5 rather than moved to `presence` — the design review's
  `presence` guess didn't match how the code actually treats it (a Tier-1
  derive-edge recomputed wholesale on load, not part of world-scan's
  accumulate-then-decay presence tracking). Russell's call: `homeLocation`
  means origin/hometown, a fixed biographical fact that never decays but
  also isn't structural containment — so it got a new type, `origin`,
  rather than reusing `containment` or `presence`. See "Containment vs.
  presence vs. origin" above and `plans/phase-1.5-tasks.md`.
