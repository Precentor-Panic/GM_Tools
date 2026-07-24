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

`diff.mjs` (`diffEntity`/`diffEdge`) is a standalone utility any of the above
(or the MCP layer) can call to compute field-level before/after diffs for
display — it isn't wired into the pipeline itself.

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
