# Phase 11 — Per-Node Content Generation Design

**Why this document exists:** the generalized version of an old idea (auto-generated NPC/location "cards") that was shelved early in this project as "specific to one particular one-shot campaign." Reframed by the project owner after real hands-on use — "I'd also expect to be able to 'rubber duck' the narration for each node/scene... and develop the 'description', some actions, secrets, potential rolls" — as a genuinely generalized feature, deliberately scoped as its own phase (not folded into Phase 7's graph-view work, per the owner's own explicit choice). This document records the DM + creative-collaboration review; `plans/phase-11-tasks.md` (not yet drafted — see note at the end) will be the build plan.

---

## The DM's stated needs (gathered directly)

1. **Framing-first, same discipline as whole-writeup rubber-duck mode, one level down.** A freshly-extracted entity is *thin* — a name, a one-liner, maybe a type. Asking the model to dump a full description/secret/rolls block straight off that thin seed reproduces the exact "sticky first idea" problem whole-writeup framing mode exists to prevent, just at the per-node scale. Three cheap one-sentence angles first ("who is this person really" / "what's this place's actual role" / "what really happened here"), picked or blended, **then** the fuller generation call runs steered by that framing.
2. **Different content templates per entity type, not one generic shape.** A person and a place need genuinely different fields (concretely specified per type below) — a shared skeleton (description + secret + potential rolls) underneath, but the type-specific fields are the actual value.
3. **Triggered after commit, not in Batch Review.** At review time the GM is judging extraction *correctness* (right entity, right type, right name), not ready to spend creative attention or an API call developing something that might still get merged, renamed, or rejected in the same pass. This is a "Develop this node" action reached from an already-settled entity, wherever the GM already looks at settled entities — not a Batch Review row action.
4. **Living-doc regeneration at field granularity, but never bypassing the review gate.** Initial generation goes through the same accept/reject/regenerate gate as everything else in this system (nothing auto-applies). Once accepted, it's a living prep doc — a secret gets revealed, a personality deepens after a session — so later revision should operate on individual fields, not force a full regenerate-the-whole-block cycle every time.
5. **Deliberately selective, not a bulk default.** Out of a dozen extracted entities, maybe 2-4 actually matter enough to develop before the next session. No "develop all" bulk action — every generation is a real API call and an act of authorial attention meant to be spent on purpose.

### Content templates per entity type
- **Person (NPC)**: description/appearance, personality & mannerisms, motivation/goal, secret, potential roll(s) (`{skill, dc, purpose}`), hook/plot tie-in.
- **Place**: description/atmosphere, notable features/points of interest, secret or hidden element, a potential encounter or complication, potential roll(s).
- **Faction**: public face/goals, internal conflict or secret, resources/reach, a potential hook or consequence of crossing them.
- **Object**: appearance, mechanical/plot properties if relevant, origin/secret, how it's discovered, potential roll to identify/use it.
- **Event**: the public account, the actual truth, ripple consequences, roll(s) to uncover the truth.
- **Concept**: reduced scope — description + how it surfaces in play; no rolls/secrets template fits.

## The technical/creative-collaboration synthesis

### Call shape: two staged calls, mirroring the existing framing-mode mechanism
1. **Framing call** (cheap) — entity-type-specific prompt, grounded in the entity's current fields **plus its immediate graph neighborhood** (pulled via the same adjacency helper Phase 7/existing `wf_get_adjacent` already expose — not the entity's isolated fields alone, otherwise generated content invents disconnected lore instead of tying into factions/places it's actually linked to). Output: 3 one-sentence angles.
2. **Generation call**, steered by the picked/blended framing. Output: a **structured object matching the entity-type template** (not flat prose) — this is what makes field-level regeneration, per-field accept, and any future table-facing rendering (e.g. hiding `secret` from a player-visible view) possible.

### Data shape
```
PrepContent {
  entityId, entityType
  framingUsed: string        // which angle, or blended text, chosen at the framing step
  status: 'proposed' | 'accepted' | 'stale'
  generatedAt / lastRegeneratedAt
  fields: { ...type-specific per-template fields, see list above }
}
```

### Where it lives — a new, separate store, not the mutation-engine pipeline
The existing `GraphMutation`/`wf_propose_mutations`/`wf_apply_mutations`/rollback machinery is built around structural graph diffs headed into world canon as first-class facts. Prep content is categorically different — authorial reference material *about* an already-settled entity, not a proposed change to graph structure. A "secret" isn't a traversable graph fact; forcing a later "revise this NPC's secret" through mutation/rollback semantics built for entity/edge diffs is the wrong fit. **Recommendation**: a lightweight per-entity record (e.g. `PrepDoc` keyed by `entityId`), following this project's own established flat-JSON-store convention (matching `human-review.mjs`), living alongside the entity but not as a new graph node/edge type.

### Review/accept mechanism
Reuse the **interaction pattern** (propose → review → accept/reject/regenerate), not the same underlying objects — a parallel, distinct tool/route surface rather than routing through `wf_propose_mutations`. Accept/regenerate operates at **field granularity** after the initial full-block accept, per the DM's living-doc requirement.

**Caveat, stated explicitly by the reviewing persona**: this recommendation was reasoned from the design pattern described, not verified against the actual current review-state architecture (the codebase was deliberately not read for this design-only review round). **Confirm against the real `mutation-engine/review-state.mjs`/`schema.mjs` shape before locking the task plan** — this is a task-planning-time verification step, not yet done.

### Flagged additions (the reviewing persona's own judgment, not explicitly requested)
1. **Staleness flag** — if an entity's core fields are edited later in the graph, its `PrepContent` should flip to `status:'stale'` rather than silently drifting out of sync with the canonical entity. Same underlying concern as the framing-history audit trail added to whole-writeup rubber-duck mode.
2. **Graph-neighborhood-aware generation** — both calls pull the entity's immediate graph context as grounding, not just its isolated fields. Necessary for useful (not disconnected) content, not explicitly asked for.
3. **No bulk "develop all"** — explicit v1 constraint, carried directly from the DM's own stated requirement, restated here as a hard design constraint rather than just a convention.
4. **One-round regenerate bound** — mirrors the existing rubber-duck-mode precedent (bounded reject/regenerate before requiring a manual edit instead) — same runaway-API-call concern applies here.
5. **Concept-type entities get reduced scope** — skip or minimize the full template for `concept` entities; not discussed directly by the owner, flagged as a scoping call.
6. **Secret-field/Foundry-sync safety check** — prep content (especially `secret` fields) should very likely be **excluded from `wf_sync_to_foundry`'s default behavior**, or at minimum needs an explicit decision about whether GM-only fields could end up in a player-visible Foundry journal entry. Flagged as a real leak risk worth deciding before build, not after — **this needs a direct answer before task-planning proceeds** (see open question below).

## Open questions before `phase-11-tasks.md` can be drafted

1. Confirm the `PrepDoc`-as-separate-store recommendation against the real `review-state.mjs`/`schema.mjs` code (the persona's own flagged caveat).
2. **Secret-field Foundry-sync safety** — should `PrepContent` never be pushed to Foundry at all (pure GM-side reference), or does it need a player-visible/GM-only split with explicit control over what syncs? This affects the data shape and the sync-path wiring materially enough to resolve before drafting tasks.
