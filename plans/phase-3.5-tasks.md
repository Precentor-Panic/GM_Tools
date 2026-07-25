# GM_Tools — Phase 3.5 Task Plan: Deferred/Lazy Consequence Resolution

**Status:** ready to execute once Phase 3 (`plans/phase-3-tasks.md`) is done. **Prerequisite reading:** `CLAUDE.md` → `PLAN.md` → this file → `.claude/skills/gm-tools-conventions/SKILL.md`.

**What this is:** for a large time-skip ("one year later"), resolving everything eagerly is expensive — Phase 3's own latency measurement showed a single 15-17-entity region takes ~50s to texture, and that cost is driven by *how many entities land in one call*, not by BFS depth. This phase makes big time-skips cheap by resolving only a GM-specified "headline" focus eagerly per cycle (reusing the exact mechanism Phase 3 already validated), and deferring everything else in the blast radius to a cheap, deterministic ledger entry instead of either texturing it now or discarding it. If a deferred entity is never asked about again, **zero further cost is ever spent on it.** If it is asked about, one bounded, explicit resolve call synthesizes everything it accumulated since it was last resolved.

**Design is fully settled** — the ledger shape, trigger model, and fan-out cap were reviewed by a systems-architecture pass before this file was written; nothing below is a first draft. Cite the reasoning in your report if you need to explain a decision, don't re-litigate it.

**One more thing settled in the same conversation, worth building this way on purpose:** the fan-out cap this phase needs (task 3.5.3) is the *same* mechanism that would fix Phase 3's live-diff latency if that's ever revisited — cap how many entities get textured in one call, defer the rest. Build it as a reusable primitive, not something narrowly wired to "resolve a neighbor set." Don't retrofit it into Phase 3's live-diff path as part of this phase — that's explicitly out of scope here — just don't paint yourself into a corner that makes doing so later harder than it needs to be.

---

## Task list

### 3.5.1 — Pending-resolution ledger primitive
**File:** `mutation-engine/pending-ledger.mjs` (new)

- Per-entity JSON file: `GM_Tools/pending-resolution/<world>/<entityId>.json` — an array of entries, each `{entryId, causeTag, impactScore, sourceBatchId, cycleDescriptor, status, createdAt}`. `status` is `'pending'` (available to be resolved) or `'proposed'` (locked — currently part of an in-flight resolve batch, see task 3.5.4).
- `causeTag` is a **cheap, deterministic label**, not a new LLM output — e.g. derived from the headline anchor's name + `cycleDescriptor` ("ripple from events at Riverwood, month 3"). Do not add a new LLM-generated field to `texture.mjs`'s output for this — the whole point of the ledger is that it costs nothing to write. Full narrative context gets pulled in later, at resolve time, from `sourceBatchId` via `review-state.mjs`'s existing `loadBatch()` — never duplicate rationale text into a ledger entry.
- Functions: `writePending(world, entityId, entry)` (append), `readPending(world, entityId)` (returns `[]` if no file exists — not an error), `listPendingEntities(world)` (readdirSync the world's ledger dir, return entity IDs with a non-empty pending backlog — no separate index file; directory listing is cheap at this scale and a second index would be a second source of truth that can drift), `markProposed(world, entityId, entryIds)`, `markResolved(world, entityId, entryIds)` (removes them — this is the terminal state, not a status flag, since a resolved entry has no further use), `revertToPending(world, entityId, entryIds)` (the reject path — status back to `'pending'`, nothing deleted).
- **Reuse `review-state.mjs`'s file-locking, don't duplicate it.** `withLock`/`ConcurrentWriteError` exist there today but `withLock` is currently module-private (not exported) — export it from `review-state.mjs` as part of this task (small, additive change to that file) and import it here. Do not write a second locking implementation.

**Acceptance criteria:** unit tests covering: write/read round-trip; `listPendingEntities` correctly finds entities with backlogs and ignores those without; a concurrent-write attempt on the same entity's ledger file is rejected via the reused `ConcurrentWriteError`, not silently clobbered; `markResolved` actually removes entries (not just flags them) and `revertToPending` restores status without deleting.

---

### 3.5.2 — Deferred-cycle orchestration
**File:** `time-skip/run-cycle.mjs` (new — do not modify `time-skip/run.mjs`'s existing `orchestrateBatch`; its current eager-texture-everything behavior is correct and tested for time-skip's existing ambient/tag/region/contained-in modes and must keep working unchanged)

- `orchestrateCycle(world, {cycleScope, headlineAnchorId, headlineDepth, elapsedTimeDescriptor, cycleDescriptor}, opts)`:
  1. Resolve `cycleScope` via the existing `resolveScope`/`candidateDeltas` machinery (same as `orchestrateBatch` already does) to get the full set of candidate deltas for this cycle.
  2. Separately resolve the headline subset — `region` mode anchored at `headlineAnchorId` with `headlineDepth` (small; the anchor plus its close neighborhood) — and texture *that* subset now, via the same `groupByRegion`/`textureBatch` flow `orchestrateBatch` already uses. This is the "spend real money on the headline, every cycle" half.
  3. For every candidate delta in `cycleScope` that is **not** part of the headline subset — regardless of whether it clears `needsLLM` — call `pending-ledger.mjs`'s `writePending()` instead of texturing it or discarding it. Use the delta's own already-computed `impactScore`/decay magnitude as the ledger entry's `impactScore`. This is the actual "don't discard sub-threshold impact, defer it" behavior the whole feature exists for — note it applies more broadly than just `needsLLM: false` deltas; anything outside the headline scope gets deferred, even a delta that would otherwise have cleared threshold on its own.
  4. **Growth-bound pass (per the architect's design):** before finishing, call `listPendingEntities(world)`, intersect with entities actually touched by this cycle's `cycleScope`, and for any whose ledger already exceeds a configurable threshold (default ~5 entries), fold their accumulated backlog into *this* cycle's resolution too (texture them now, using their full accumulated ledger, same rendering task 3.5.3 builds) rather than letting them grow further. This is not a new automatic trigger — it's the existing explicit cycle-run doing more of its job, per the architect's reasoning for why silent expiry is wrong here.
  5. Persist the headline batch via `review-state.mjs`'s `createBatch` as usual.

**Acceptance criteria:** unit test with a mocked `textureBatch`: confirm headline-subset entities get textured, confirm non-headline entities get ledger entries instead (assert on `pending-ledger.mjs`'s state, not just that texture wasn't called for them), confirm a deliberately-bloated fixture entity (pre-seeded with 6+ existing pending entries) gets swept into the current cycle's resolution rather than growing to 7.

---

### 3.5.3 — On-demand resolve orchestration
**File:** `time-skip/resolve-pending.mjs` (new)

- `resolvePending(world, requestedEntityId, {depth = 1, maxNeighbors = 8} = {}, opts)`:
  1. Gather the requested entity's own pending ledger via `readPending`.
  2. Find its neighborhood via `wf-mcp-server/lib/graph.mjs`'s `neighborhood(entities, edges, requestedEntityId, depth)` (reuse — don't reimplement BFS a third time in this codebase).
  3. Of those neighbors, filter to ones with a non-empty pending ledger (`listPendingEntities` intersected with the neighbor-id set), sort by each entity's highest single pending `impactScore` descending, take the top `maxNeighbors` (default 8). **This is the fan-out cap** — flat, by impact score, not sub-clustering (sub-clustering degenerates badly for a single-anchor neighborhood per the architect's reasoning: it either collapses to one giant cluster or one-call-per-node, exactly the cost blowup this cap prevents).
  4. For the requested entity plus the capped neighbor set: for each, hydrate full context for every pending entry by loading its `sourceBatchId` via `review-state.mjs`'s `loadBatch()`, and render them **sorted chronologically by `cycleDescriptor`**, each line explicitly labeled with its cycle (not an undated bullet dump — per the architect, presenting entries flat reads as "everything happened at once" instead of a sequence). This likely means a new render function in `mutation-engine/grain.mjs` or `texture.mjs` alongside the existing `renderDeltaSummary` — check both before adding a third rendering path, this may extend one of them rather than needing a wholly new function.
  5. One `textureBatch`-shaped call (reuse `mutation-engine/texture.mjs`, don't fork it) producing mutations for the resolved entities.
  6. Create a review batch via `createBatch`, and record which ledger entries this batch is resolving in the batch's metadata (needed by task 3.5.4 to know what to clear/revert on accept/reject).
  7. Mark the resolved ledger entries `'proposed'` via `markProposed` — locks them out of being pulled into a second concurrent resolve while this batch is pending review.

**Acceptance criteria:** unit test confirming the fan-out cap actually caps (a fixture with 15 pending-bearing 1-hop neighbors resolves at most 8 of them, the rest stay `'pending'`); unit test confirming chronological ordering in the rendered output (a 3-entry, out-of-order-by-creation fixture renders in `cycleDescriptor` order, not insertion order); unit test confirming multi-cause entries for a single entity all appear in one rendered call, not split across multiple.

---

### 3.5.4 — Resolve outcome wiring
**File:** `wf-mcp-server/index.mjs` (extend `wf_accept`/`wf_reject`'s handlers, or `mutation-engine/review-state.mjs` if the hook belongs closer to the data layer — your call, but don't duplicate accept/reject logic to add this, hook into the existing path)

- On accepting a batch that resolves ledger entries (per 3.5.3's recorded metadata): call `markResolved` for those entries — they're now real, reviewed graph mutations; the ledger has no further use for them, `review-state.mjs`'s own batch history is the permanent record.
- On rejecting (in whole or in part) a batch that resolves ledger entries: call `revertToPending` for the entries corresponding to rejected mutations — a rejected resolution should not silently vanish the underlying pending debt; it goes back to being available for a future resolve attempt, possibly with more accumulated context by then.

**Acceptance criteria:** manual/integration test (real subprocess, real MCP protocol, matching Phase 2/3's established smoke-test pattern) driving a full cycle: run a cycle with deferred entities → explicitly resolve one → accept it → confirm its ledger is cleared (`readPending` returns `[]`) → run another cycle that defers to the *same* entity again → resolve again → reject this time → confirm the entry is back in `'pending'` status, not gone.

---

### 3.5.5 — MCP tool wiring
**File:** `wf-mcp-server/index.mjs` (extend)

- `wf_run_cycle`: wraps `orchestrateCycle` (task 3.5.2) — conversational entry point for "advance time by one month, headline focus on X."
- `wf_resolve_pending`: wraps `resolvePending` (task 3.5.3) — the explicit, opt-in resolve trigger. Input: `world`, `entityId`, optional `depth`/`maxNeighbors` overrides. **This tool must never be called automatically by any read path** (`wf_get_entity`, `wf_get_context`, `wf_get_adjacent`) — confirm none of those tools' handlers reference it. The whole point of explicit-trigger-only is that a GM decides when to spend the call; an incidental read pulling in a tagged entity must never silently trigger a resolve.
- Both follow existing tool conventions (zod `inputSchema`, `try/catch` → `errorText(err)` → `{isError:true}` shape) — match the style already established by `wf_accept`/`wf_narrate_batch`.

**Acceptance criteria:** manual smoke test running a real multi-cycle scenario against a realistic fixture (`wf_run_cycle` × 3, simulating three months with a different headline focus each time) → confirm ledger backlog accumulates correctly across cycles for non-headline entities → `wf_resolve_pending` on one accumulated entity → confirm the resulting batch's rendered content actually references multiple cycles (not just the latest) → `wf_accept` → confirm sync/rollback still behave normally on a batch that originated from a resolve rather than a fresh propose.

---

## Definition of done for Phase 3.5

- [ ] `pending-ledger.mjs` built and tested; `review-state.mjs`'s `withLock` exported and reused, not duplicated.
- [ ] `orchestrateCycle` defers non-headline candidates instead of discarding or eagerly texturing them; `time-skip/run.mjs`'s existing `orchestrateBatch` is unmodified and its existing tests still pass.
- [ ] Growth-bound sweep confirmed working (bloated backlog gets folded into the next cycle, not silently expired, not left to grow unbounded).
- [ ] `resolvePending`'s fan-out cap confirmed with a test that actually exercises more candidates than the cap.
- [ ] Multi-cause chronological rendering confirmed — entries from different cycles are labeled and ordered, not presented as simultaneous.
- [ ] Accept clears resolved ledger entries; reject reverts them to pending, doesn't delete them.
- [ ] `wf_resolve_pending` confirmed never invoked by any read-path tool.
- [ ] A full multi-cycle scenario run manually end-to-end through the real MCP server: several `wf_run_cycle` calls with different headline foci → backlog accumulation confirmed → explicit resolve → accept → sync.
- [ ] No changes made to Phase 3's live-diff (`scope.mode: 'seed'`) path — the shared fan-out-cap insight is noted for a future retrofit, not acted on here.
