# GM_Tools — Phase 5 Task Plan: Import-from-Writeup

**Status:** ready to execute. **Prerequisite reading:** `CLAUDE.md` → `PLAN.md` → this file → `.claude/skills/gm-tools-conventions/SKILL.md`.

**What this is:** given unstructured text — a pasted campaign pitch, an exported World Anvil/wiki page, loose prep notes — propose a WFI-shaped set of entities/edges to add to the graph, route that proposal through the *same* review gate as every other mutation batch (diff, headline/grain, accept/reject/regenerate), and only commit on accept. This is the "bring your own world" capability from early in this project's planning — closing the gap where the tool currently assumes a graph already exists.

**The hard part is already built — confirmed by reading the code, not assumed.** `foundry_worldFabric/scripts/data/interchange.mjs`'s `importGraph(wfi, existing, opts)` already does case-insensitive name+type matching against existing entities (`findExisting`), auto-creates stub entities for edges that reference not-yet-existing endpoints by name (`resolveEndpoint`), and returns a rich `summary` (created/updated/stub/skipped counts, names) plus derivation-pass `suggestions`. It's pure (takes plain arrays, doesn't mutate `existing` in place) and already unit-tested at the World Fabric layer. **Don't reimplement dedup/matching/stub-creation logic in `mutation-engine/` or `graph-import/` — this phase is "get an LLM-proposed WFI document into `importGraph`'s merge logic, then wrap the result for review," not a new merge algorithm.**

**What's actually new:** (1) an LLM call that turns freeform text into a WFI-shaped proposal (entities + edges referencing endpoints *by name*, matching WFI's own established hand-authorable format — never invent ids, `importGraph`'s own resolution already handles name→id), and (2) converting that proposal's *effect* (what `importGraph` would create/update if applied) into `StoredMutation`-shaped entries the existing review pipeline already knows how to diff/render/accept/reject — not a new review mechanism, a new *producer* feeding the existing one.

---

## Task list

### 5.1 — Writeup-to-WFI proposal
**Files:** `graph-import/writeup-import.mjs` (new — this module name was anticipated back in early planning, use it), `prompts/writeup-import.md` (new)

- One LLM call (reuse `mutation-engine/llm-call.mjs`'s shared plumbing — `fillTemplate`, `parseJsonResponse`/`stripCodeFences`, the `Anthropic` client pattern — don't re-copy `callModel`-shaped boilerplate a fourth time): given freeform text, produce a WFI-shaped document (`{version, entities: [...], edges: [...]}`, matching `WFI_VERSION`/the shape `interchange.mjs`'s `normalizeEntity`/`normalizeEdge` expect) where edges reference entity endpoints by **name**, not id — this is exactly the hand-authorable WFI convention `importGraph` already resolves.
- Each proposed entity/edge should carry a short rationale (why this was extracted from the text / what specific passage it came from) — the review pipeline requires a `rationale` per mutation (task 5.2), so this needs to exist somewhere in the LLM's output; attach it per-item in the proposal document (WFI's own schema doesn't need to validate this extra field, it's carried informally until task 5.2 converts each item into a real `StoredMutation`).
- Validate the model's output is genuinely WFI-shaped before it goes anywhere near `importGraph` (retry-once-then-typed-error, same pattern `texture.mjs`/`resolve-seed.mjs` already establish) — malformed output must never reach the merge step.
- Large writeups (a long wiki export) may need chunking or a token-budget check before the call — check `llm-call.mjs`'s existing patterns for anything reusable here; if nothing exists yet, a simple length guard with a clear error is enough for v1, don't over-build a chunking system speculatively.

**Acceptance criteria:** unit test with a mocked API call verifying a well-formed writeup produces a valid WFI document with per-item rationale; a test verifying malformed model output is retried once then surfaces a typed error, not silently dropped. Manual/integration smoke test (`.smoke.mjs`, matching the project's pattern) with a real short writeup against the real API, output included in your closing report.

---

### 5.2 — Dry-run merge preview → review batch
**Files:** likely `graph-import/writeup-import.mjs` (extend) or a new small module — your call once you're in the code

- Run the proposed WFI document through `importGraph(wfi, existingSnapshot, {mode: 'merge', runDerivation: true})` **without persisting** — `importGraph` is pure and returns a new result rather than mutating `existing`, so this is a safe dry run. This resolves names to ids, applies existing dedup (an entity the writeup calls "Gerdur" that already exists in the graph should merge, not duplicate — confirm this actually happens with a real test, don't just assume `findExisting`'s case-insensitive name+type match does what you expect), and creates stub entities for referenced-but-undescribed endpoints exactly as it already does for other WFI imports.
- Convert the dry-run's effective changes (`summary.createdNames`/`updatedNames`, the resulting entity/edge arrays) into `StoredMutation`-shaped entries (`op: 'upsert_entity'`/`'upsert_edge'`, matching task 5.1's per-item rationale to the corresponding created/updated entity by name) and persist as a batch via `review-state.mjs`'s `createBatch` — reuse the exact same review-state machinery every other batch already goes through, don't build a parallel one.
- **Add a new `SourceKind` value** (`schema.mjs`'s `Mutation`/`StoredMutation` currently has `["ambient-decay", "seeded-propagation", "manual"]`) — something like `"writeup-import"` — small, additive, versioned schema change (bump `SCHEMA_VERSION`'s usage/document it per the existing convention, `interchange.mjs`'s `WFI_VERSION` precedent). This matters for auditability (NFR5 from the original requirements — "what proposed it" should be answerable months later) and lets the headline/grain rendering distinguish a bulk import from an ordinary event consequence if that's ever useful.
- `diff.mjs`'s existing `before === null` → "(created)" marker handling should already cover the common case (most writeup-import mutations are creates) — confirm this rather than assuming, and handle the update case (an existing entity getting new/merged fields from the writeup) through the same diff path everything else uses.

**Acceptance criteria:** unit test confirming a writeup mentioning both a brand-new entity and an existing one (seed the fixture snapshot with an entity matching by name+type) produces one create-shaped mutation and one update-shaped mutation, not two creates; unit test confirming edges referencing entities purely by name resolve correctly and stub-creation still happens for a referenced-but-undescribed entity, matching `importGraph`'s existing behavior exactly (cross-check against `importGraph`'s own test fixtures/behavior rather than asserting a fresh expectation).

---

### 5.3 — Commit path + MCP tool wiring
**File:** `wf-mcp-server/index.mjs` (extend)

- New tool `wf_propose_from_writeup`: input `world`, `text`, optional `mode` (default `'merge'`). Runs tasks 5.1+5.2, returns the batch id + headline, following the existing `wf_propose_mutations`-style conventions (zod `inputSchema`, `try/catch` → `errorText(err)` → `{isError:true}` shape).
- On accept, commit through the **existing** dual-path apply (`applyMutationsWithHeadlessFallback` from Phase 4, or whatever `wf_sync_to_foundry`/`wf_rollback_batch` currently share) — don't build a new commit path. If there's no existing Foundry world at all yet (a genuinely brand-new campaign), confirm `graph-import/headless-apply.mjs`'s existing `bootstrapSnapshot` (built in Phase 2.3) correctly handles "import into a snapshot that doesn't exist yet" — this is exactly the scenario it was built for; verify it rather than assume.
- Regenerate-with-note should work here too, same as everywhere else (a GM saying "no, treat 'Gerdur' and 'Gerdur the smith's sister' as the same person" or "that should be a `containment` edge, not `location`" and getting a revised proposal) — reuse the existing regenerate pattern (re-invoke 5.1's LLM call for the affected scope with the note appended, replacing not stacking).

**Acceptance criteria:** manual smoke test driving the real deployed MCP server (real subprocess, real MCP protocol, matching the established pattern) through a full round trip: `wf_propose_from_writeup` (against a fixture writeup) → `wf_review_batch` → `wf_accept` → `wf_sync_to_foundry` (both against an existing populated snapshot AND against a freshly-bootstrapped empty one) → confirm the committed graph state actually reflects the writeup's content, not just that the tool call succeeded.

---

## Definition of done for Phase 5

- [ ] `writeup-import.mjs` built and tested; reuses `llm-call.mjs`'s shared plumbing, doesn't duplicate it.
- [ ] Dry-run merge preview correctly dedups against existing entities by name+type (real test, not assumed) and correctly creates stubs for name-only edge references, matching `importGraph`'s established behavior.
- [ ] New `SourceKind` value added, small and additive, documented.
- [ ] `wf_propose_from_writeup` wired in, matching existing tool conventions; commits through the existing headless/live dual-path, not a new one.
- [ ] Bootstrap-from-nothing case (brand-new campaign, no prior Foundry world) verified working, not assumed from Phase 2.3's original scope.
- [ ] A full round trip run manually end-to-end through the real MCP server, against both an existing and a freshly-bootstrapped snapshot.
- [ ] Self-review remediation pass run and reported, same as every phase since Phase 2.
