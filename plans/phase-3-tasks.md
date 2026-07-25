# GM_Tools — Phase 3 Task Plan: Live On-Demand Diff Mode

**Status:** ready to execute. **Prerequisite reading:** `CLAUDE.md` → `PLAN.md` → this file → `.claude/skills/gm-tools-conventions/SKILL.md`.

**What's already done, verified against the real code before writing this file (don't rebuild it):** `time-skip/scope.mjs`'s `resolveScope` already has a `seed` mode (`scope.mjs:54-102`) that takes a single `anchorId` as shorthand for a one-element seed list — this **is** "given that X happens, right now" resolution. `wf_propose_mutations` already runs it end-to-end through the same propose → texture → batch pipeline as time-skip. **Do not build a new mutation-generation path for this phase.** What's actually missing, confirmed by grep against `wf-mcp-server/index.mjs` (no `narrate`/`scene`/`narration` matches anywhere): the **second LLM call** from the project's original two-call pattern (`PLAN.md`'s "Core Pattern" — mutation call, then a separate scene/consequence-narration call for what the GM reads aloud) has never been built. Everything textured so far produces a `rationale` field for the *reviewer* — nobody has written prose meant to be read at the table. That's this phase's real content, plus confirming the existing pipeline is actually fast enough to use live.

**Why this phase matters beyond itself:** the deferred/lazy-resolution feature discussed after this (informally "Phase 3.5" — not yet task-planned, drafted only once this phase's actual code exists to ground it in) reuses this phase's single-seed resolution as its per-cycle "headline" mechanism. Get the latency and narration behavior right here; 3.5 inherits it unchanged.

---

## Task list

### 3.1 — Latency validation for live use
**Files:** no new files; instrumentation/measurement only, plus a config default change if warranted

- Run `wf_propose_mutations` with `scope.mode: 'seed'`, a single `anchorId`, against a realistic fixture, and measure actual wall-clock time for propagate → texture → `attachDiffs` → `createBatch` (the full path `wf_review_batch` then reads from). Record real numbers — don't estimate.
- `scope.mjs`'s `seed` mode currently defaults BFS depth to 3 (same as time-skip's default). For live/synchronous use, a shallower default (e.g. 2) is probably right — smaller blast radius, fewer candidate deltas, fewer/smaller texture calls, tighter latency — but confirm this against what you actually measure rather than assuming. If depth 3 already comes in comfortably under the ~5s p50 target from a live table's perspective, don't change the default just to change it.
- **If it's not reliably fast:** don't try to force synchronous speed at the cost of correctness. Instead, make sure the MCP tool response makes the async nature explicit and immediate — a GM should never see a silent multi-second hang. Confirm (or add, if missing) an immediate acknowledgment path so a conversational Claude Code session can say "resolving, one moment" rather than appearing frozen. Report actual measured latency in your final report either way — this number matters for Phase 3.5's design too.

**Acceptance criteria:** at least 5 real timed runs against non-trivial fixtures (not the 3-entity toy graph), reporting p50/p90-ish informally (exact numbers, not vibes). A documented conclusion: "reliably live" (and at what depth) or "needs async framing" (and why).

---

### 3.2 — Scene narration pass (new)
**Files:** `mutation-engine/narrate.mjs` (new), `prompts/narrate.md` (new)

- One more LLM call, structurally parallel to `texture.mjs`'s texturing pass but a genuinely different job: given an **accepted** batch's mutations (with their diffs), write 2-3 paragraphs of in-fiction scene/consequence description — what the players actually see and experience, ending on a sensory hook or a decision point. This is *not* the reviewer-facing `rationale` field reused — it's new prose, written for a different audience (players, read aloud) with different constraints (no meta-commentary, no "this entity's importance increased," just what's happening in the world).
- **Reuse `mutation-engine/llm-call.mjs`'s shared plumbing** (`fillTemplate`, `parseJsonResponse` or plain text depending on output shape, `Anthropic` client pattern) — this is exactly the kind of second call site that plumbing was extracted for. Don't re-copy `callModel`-shaped boilerplate a third time.
- `prompts/narrate.md`: template takes the accepted batch's entity/edge diffs (post-mutation state, not the raw delta objects) plus enough surrounding context (current location if known, reachable areas) to ground the scene. Output is plain prose, not JSON — no schema validation needed the way `texture.mjs`'s mutation output needs it, since this never touches the graph.
- **Hard constraint, matches the project's standing trust invariant:** narration only ever runs against an **already-accepted** batch, never a pending/proposed one. Read-aloud text at the table functions as stated fact to players — generating it before a human has confirmed the underlying mutations would be a narrower but real violation of "no silent auto-write, no exceptions." Enforce this in code (check batch/mutation status before narrating), not just in the prompt.
- Support **regenerate-with-note** for narration, same UX pattern as mutation regeneration elsewhere in this project (if the tone's wrong, the GM can ask again with guidance) — but narration regeneration never touches `review-state.mjs`'s mutation-acceptance status, only produces new prose.

**Acceptance criteria:** unit test with a mocked API call verifying the prompt is built correctly from an accepted batch's diffs and that a status check rejects narrating a non-accepted batch (typed error, not silent no-op or a crash). Manual/integration smoke test (`.smoke.mjs`, matching the project's existing pattern) making one real call against a real accepted batch, producing prose a human can actually judge for fit — include the real output in your closing report, not just "it worked."

---

### 3.3 — MCP tool wiring
**File:** `wf-mcp-server/index.mjs` (extend)

- New tool `wf_narrate_batch`: input `world`, `batchId`, optional `note` (for regeneration). Loads the batch via `review-state.mjs`, verifies every mutation being narrated is `status: 'accepted'` (reject with a clear typed error listing which mutations aren't, if any aren't — don't partially narrate), calls `narrate.mjs`, returns the prose. Follows the existing tool-handler conventions (zod `inputSchema`, `try/catch` → `errorText(err)` → `{isError:true}` shape) — match `wf_accept`/`wf_regenerate`'s style exactly, don't introduce a new response shape.
- Confirm `wf_propose_mutations`'s existing `scope.mode: 'seed'` + single `anchorId` already works as the live-diff entry point with no changes needed — if you find it needs a change to work well for this use case (vs. time-skip's use of the same mode), make the smallest change that fixes it and explain why in your report, don't redesign the mode.

**Acceptance criteria:** manual smoke test driving the real deployed MCP server (same pattern Phase 2's `sync-headless.test.mjs` used — real subprocess, real MCP protocol, not a mocked handler call) through a full live-diff round trip: `wf_propose_mutations` (single seed) → `wf_review_batch` → `wf_accept` → `wf_narrate_batch` → confirm the narration is rejected if attempted against a batch with pending/rejected mutations still in it.

---

## Definition of done for Phase 3

- [ ] Latency measured and reported honestly (task 3.1) — not assumed.
- [ ] `mutation-engine/narrate.mjs` built, tested, reuses `llm-call.mjs`'s shared plumbing (no duplicated API-call boilerplate).
- [ ] Narration is provably gated on batch-acceptance status — a test exercises the rejection path, not just the happy path.
- [ ] `wf_narrate_batch` wired into `wf-mcp-server/index.mjs`, matching existing tool conventions.
- [ ] A full live-diff round trip run manually end-to-end through the real MCP server: propose (single seed) → review → accept → narrate → regenerate-with-note on the narration → sync.
- [ ] No changes made to `time-skip/scope.mjs`'s `seed` mode unless task 3.1's latency testing revealed a real need — and if so, the change and its justification are called out explicitly in the closing report.
- [ ] Real narration output included in the closing report for a human to judge tone/fit — this is exactly the kind of "read the first several real outputs closely" milestone flagged earlier in this project's planning.
