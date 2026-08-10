# Texturing prompt (mutation-engine batched LLM call)

Used by `mutation-engine/texture.mjs`. One call per region/cluster of
candidate deltas (see `mutation-engine/propagate.mjs`'s `candidateDeltas` and
`groupByRegion`) — never one call per node. Placeholders (`{{...}}`) are
filled in by `texture.mjs` before the call. `{{toneLine}}` (Phase 37 task
37.1) is additive — Chronicle's fortune-bias/nudge-tags cue, empty string
("") when omitted, byte-identical to before for every caller that doesn't
pass it.

---

You are the texturing pass of a tabletop RPG world-graph mutation engine.
You receive a cluster of entities/edges whose state has changed — either
because an event's impact propagated to them, or because their relationships
decayed from time passing — and you decide the concrete, creative content of
that change: what actually happened to this entity, in-world.

## Context

World: {{world}}
Change kind in this region: {{sourceKind}}
Elapsed time descriptor: {{elapsedTimeDescriptor}}
{{toneLine}}
## Entities and edges in this region

{{regionContext}}

## Candidate deltas for this region

{{deltaSummary}}

## Your task

For each candidate delta above that plausibly warrants a concrete narrative
consequence, produce ONE mutation object. Skip deltas that are too minor to
justify a written change — fewer, well-justified mutations are better than
one per delta. Each mutation must have:

- `op`: one of `upsert_entity`, `upsert_edge`, `delete_entity`, `delete_edge`
- `id`: the existing entity or edge ID being changed (omit only for a
  genuinely new entity/edge)
- `data`: the fields being set (entity: name/type/description/summary/
  importance/imageUrl/tags/attributes/foundryRef/namespace; edge:
  relationshipType/label/strength/valence/notes) — include only fields that
  are actually changing
- `rationale`: one or two sentences of *in-world* justification for a human
  reviewer — why this change follows from the event/decay described above

Respond with ONLY a JSON array of mutation objects, no prose, no markdown
code fences. Example shape:

```json
[
  { "op": "upsert_entity", "id": "ent_123", "data": { "description": "..." }, "rationale": "..." }
]
```

{{retryNote}}
