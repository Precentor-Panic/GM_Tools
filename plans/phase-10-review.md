# Phase 10 — Per-Entity Narration & Persistence Design

**Why this document exists:** unlike every prior phase's design round (persona subagents reviewed before anything was built), this one is grounded directly in the project owner's own first real hands-on session with the built product — a more direct signal than a synthetic persona review, and exactly the kind of feedback the whole review-before-build discipline has been standing in for. This document records that feedback, the root cause found by reading the actual code, and the resulting decisions. `plans/phase-10-tasks.md` is the build plan.

---

## What was reported, verbatim in substance

Using the Review screen for the first time surfaced a cluster of narration complaints that turned out to share one root cause:

- "Narration is generated for one update in the batch and spread across all of the nodes" — every row shows the *same* text.
- "Regenerating the narration from any node seems to just recycle a single 'general' statement."
- "It always seems to preface it as if we are describing the scene 'session zero'."
- "If I leave and come back to the queue page, I can generate a new narration" (i.e. nothing persisted).
- Expectation stated directly: narration should be stored so a specific node can be selected and its narration recalled later; it should persist until the node is mutated or the narration is explicitly regenerated; and a *historic* accepted narration for that node should still be recallable afterward, not overwritten and lost.
- A concrete idea for how to make regeneration less generic: "use the fabric connections to make sure the narration is targeted and includes less redundant stuff."

## Root cause (confirmed by reading `mutation-engine/narrate.mjs` and `review-ui/public/app.js`, not assumed)

1. `narrateBatch()` has only ever narrated a whole **batch** in one call — never a single entity. This was a known, documented compromise from Phase 6 (`app.js`'s own comment: the design doc described narration appearing per-row, but the backend narrates a whole scene at once; the same batch-level prose was rendered into every accepted row to reconcile the two).
2. review-ui's narrate call **never passes `currentLocation`/`reachableAreas`** — those template slots are always `"(not specified)"`. With no scene-anchoring context at all, the model has nothing to ground a specific moment in, so it defaults to a generic introductory framing.
3. The result (`reviewState.narrationCache`) lives only in an in-memory JS object, reset every time `renderReview()` runs fresh. Nothing is ever written to disk. Leaving and returning discards it, and "regenerate" just re-runs the identical whole-batch call with no new grounding unless the user happens to type a location into a note field that doesn't exist in the current UI.

Every symptom traces back to these three facts. This is a real design gap, not user error, and not fixable with a small patch — it needs actual persistence and a change in granularity.

## Decisions (from direct Q&A with the project owner)

1. **Storage**: a new GM_Tools-side store, following `mutation-engine/human-review.mjs`'s established convention exactly (flat JSON, `withLock`-protected, env-overridable directory) — keyed by `(world, entityId)`, **not** a change to World Fabric's own graph schema. Purely additive; no cross-repo schema change, no ripple into `foundry_worldFabric`.
2. **Granularity**: per-entity narration becomes the **default** going forward, replacing whole-batch narration as the normal path (not kept as an equal alternative — this was a explicit, not a "keep both" choice).
3. **History**: each entity's store holds a genuine history, not just a "latest" value — a prior accepted narration must remain recallable even after a newer one is generated, and a narration is retired (not deleted) once the entity it describes is mutated again or a human explicitly regenerates it.
4. **Targeting**: use the entity's own graph connections (its immediate neighbors, matching the same style of local BFS `propagate.mjs`/`resolve-pending.mjs` already use elsewhere in this codebase) to ground the prompt in real, relevant context instead of an empty `currentLocation`/`reachableAreas` pair — directly addressing the "less redundant, more targeted" ask.

## What this does NOT change

- The no-silent-auto-write invariant, applied to narration exactly as it already is: narration still only ever runs against a mutation that is `status:'accepted'` (per-entity now, rather than per-batch — `assertBatchNarratable`'s equivalent check moves to entity grain).
- The rubber-duck/framing system (Phase 8) is untouched — a genuinely separate concern.
- Nothing about batch review, accept/reject/sync, or the Deferred Debt tab changes here.
