# GM_Tools — Phase 4 Task Plan: Rollback Hardening + Unreviewed-Accumulation Tracking

**Status:** ready to execute. **Prerequisite reading:** `CLAUDE.md` → `PLAN.md` → this file → `.claude/skills/gm-tools-conventions/SKILL.md`.

**Two genuinely different pieces, grounded in real code before writing this file, not assumed:**

1. **Rollback hardening — a specific, confirmed, still-open gap.** `mutation-engine/rollback.mjs`'s own doc comment says: *"a mutation that created a brand-new entity/edge... cannot be targeted for a delete-based rollback... that's explicitly Phase 2b's job."* Phase 2b (headless apply) shipped, but `graph-import/headless-apply.mjs` was checked directly for this file and exports only `bootstrapSnapshot`/`applyHeadless` — **no id-read-back mechanism exists.** The gap was never actually closed, just built past. This is task 4.1, and it's concrete, not speculative.
2. **Unreviewed-accumulation tracking — a real gap, nothing built yet.** Confirmed via grep: no `lastHumanReviewed`/`lastReviewed` code exists anywhere in the repo, only mentions in planning docs. This is genuinely new work, distinct from Phase 3.5's pending-ledger (that tracks content not yet *resolved*/textured; this tracks content that *was* applied but never actually looked at by a human — different kind of debt, don't conflate them or try to reuse the pending-ledger for this).

---

## Task list

### 4.1 — Close the newly-created-entity rollback gap
**Files:** `graph-import/headless-apply.mjs` (extend), `mutation-engine/rollback.mjs` (extend), `wf-mcp-server/index.mjs` (check `applyMutationsToFoundry`'s live-Foundry path too — the same gap likely exists there, not just headless)

- `applyHeadless(snapshotPath, mutations)` currently merges mutations into a snapshot but (confirmed by reading the file) doesn't report back which ids got assigned to `create`-shaped mutations (an `upsert_entity`/`upsert_edge` with no `id`). Extend it to return an id-assignment map (`{tempRef|index -> assignedId}` — check how `interchange.mjs`'s `importGraph` currently generates ids for id-less upserts and use the same convention, don't invent a second one) alongside its existing return shape.
- Check the live-Foundry path (`applyMutationsToFoundry` in `wf-mcp-server/index.mjs`, and whatever it calls for the live case) for the same gap — Foundry assigns document UUIDs on creation too, and if that path also doesn't report them back, `acceptMutations`' pre-state capture (`mutation-engine/rollback.mjs`) has no id to attach even after this task, for anything created live rather than headless. Fix both paths if both need it; if only headless needed it, say so and explain why the live path was already fine.
- `rollback.mjs`'s `acceptMutations`/`rollbackBatch` currently `skip` entries with no known id rather than crash — keep that graceful-skip behavior for any case this task doesn't close (e.g. if the live-Foundry path turns out to need more than a small fix), but the headless-created case should now resolve to a real, targetable delete.

**Acceptance criteria:** unit test: propose a batch that creates a new entity, accept it, apply it headless, confirm the id-assignment comes back and `preState` capture can now target it; roll back that batch; confirm the created entity is actually deleted from the snapshot (not just reported as `skipped`). A second test confirms the existing graceful-skip behavior still works for whatever case (if any) remains genuinely unresolvable after this task.

---

### 4.2 — Unreviewed-accumulation tracking
**Files:** likely `mutation-engine/review-state.mjs` (extend) for the timestamp/query primitive, `mutation-engine/grain.mjs` (extend `summarizeBatch`/`HEADLINE_IMPORTANCE_THRESHOLD`-adjacent logic) for the force-into-headline behavior — confirm the right home for each piece once you're in the code, this split is a starting hypothesis, not a mandate.

- Add a `lastHumanReviewedAt` concept, distinct from any existing `updatedAt`/`lastSession`-style timestamp — this marks the last time a human actually looked at (not just auto-accepted) a diff for a given entity. Update it whenever a human reviews an entity's diff at the `region`/`entity` grain (`wf_review_batch`) or explicitly accepts/rejects/regenerates a mutation touching it — **not** on a whole-batch accept-all, since that's exactly the case this feature exists to guard against (a GM batch-accepting 40 things without reading any of them shouldn't count as "reviewed").
- A query surfacing entities whose applied-but-unreviewed history has gone too long — reuse the "N sessions or M accepted-mutations" framing from the project's original requirements doc if you can find it referenced in `PLAN.md`/memory; if not, a reasonable default (document your choice, make it configurable) is fine.
- **Force-into-headline behavior:** when `summarizeBatch` (or whatever function currently decides headline-vs-collapsed using `HEADLINE_IMPORTANCE_THRESHOLD`) processes a batch touching a flagged entity, that entity's diff should surface in the headline regardless of its `importance` score — this is the actual point of the feature: an entity accumulating silent, unreviewed AI-authored history shouldn't stay hideable just because it's individually low-importance.

**Acceptance criteria:** unit test confirming `lastHumanReviewedAt` updates on an actual review/individual-accept action and does *not* update on a batch-accept-all of unreviewed diffs; unit test confirming a flagged (long-unreviewed) low-importance entity gets forced into a batch's headline even though `HEADLINE_IMPORTANCE_THRESHOLD` alone would have collapsed it; a query test confirming the "surface flagged entities" function actually finds entities seeded with an old `lastHumanReviewedAt` and excludes recently-reviewed ones.

---

## Definition of done for Phase 4

- [ ] The specific, confirmed rollback gap (newly-created entities) is closed for the headless path, and the live-Foundry path is confirmed either already-fine or fixed too — not left unexamined.
- [ ] `lastHumanReviewedAt` is a real, tracked concept, distinct from other timestamps, updated only by genuine human review actions — not by batch-accept-all.
- [ ] A working query surfaces long-unreviewed entities.
- [ ] Grain/headline logic demonstrably forces a flagged entity into view regardless of importance — test proves this, not just describes it.
- [ ] Full test suite (`npm test` from `/home/russell/GM_Tools`, plus `wf-mcp-server`'s own suite) passes.
- [ ] Self-review remediation pass run and reported, same as the last several phases.
