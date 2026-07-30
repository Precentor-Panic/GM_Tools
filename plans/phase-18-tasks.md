# GM_Tools — Phase 18 Task Plan: Encounter Guidance (engine + API)

**Status:** ready to execute. **Prerequisite reading, in order:** `CLAUDE.md` → `PLAN.md` → `plans/phase-18-review.md` in full (read it before this file, this file assumes it — especially §2, the resolved v1 scoring heuristic, and §7, the deferred simulator NOT being built this phase) → this file → `.claude/skills/gm-tools-conventions/SKILL.md`.

**Scope:** engine + API only, matching how Phase 16 preceded Phase 17 — no UI in this phase. **Explicitly not building §7** (the deferred round-simulator) — if any task here seems to require simulating rounds, stop, that means the design record was misread; everything in this phase is pure extraction + deterministic scoring, no sequencing.

**Process, same as Phase 16/17:** tests before implementation. Task 18.0 writes tests against modules that don't exist yet — those test files' header comments ARE the interface contract. Implement to make them green without loosening what they assert; if a test looks wrong once deep in real implementation, flag it, don't silently patch around it.

---

## Grounding — what already exists, confirmed live in this repo

- **`mutation-engine/llm-call.mjs`**'s `callModelDetailed(prompt, opts)` passes `prompt` straight through as `content` in the Anthropic SDK call (`messages: [{ role: "user", content: prompt }]`) — the Anthropic SDK's `content` field accepts either a plain string OR an array of content blocks (text, document, image, etc.). This means **PDF ingestion likely needs zero changes to `llm-call.mjs` itself** — a caller can pass an array like `[{type: "document", source: {type: "base64", media_type: "application/pdf", data}}, {type: "text", text: extractionPrompt}]` as the `prompt` argument and it should pass through correctly. **Verify this against the real Anthropic SDK/API early in task 18.1** (a quick live-API smoke check with a real small PDF) before building the rest of ingestion on top of the assumption — this is reasoned from reading the code shape, not from having exercised PDF input in this codebase before.
- **`graph-import/writeup-import.mjs`** — the established propose → typed-validation-error → preview/dedup → commit pattern, and `DEFAULT_WRITEUP_IMPORT_MAX_TOKENS`/truncation-retry convention via `callModelDetailed`. Bestiary/party-roster ingestion (18.1/18.2) follow this shape.
- **`mutation-engine/entity-narration.mjs`** + **`mutation-engine/review-state.mjs`** (`withLock`/`ConcurrentWriteError`) — the store-pattern precedent (`DEFAULT_ROOT`, `GM_TOOLS_*_DIR` env override) for the new bestiary/party-roster stores.
- **`wf-mcp-server/lib/prep-content-ops.mjs`** — the lighter accept/discard review pattern (vs. the full mutation-review batch machinery) that bestiary/party-roster entries should use, per the design record's explicit call that these aren't graph mutations.
- **`mutation-engine/narrate.mjs`**'s `buildAdjacencyContext` — the grounding-context pattern `getPartyContext()` (18.6) follows.
- **`mutation-engine/propagate.mjs`** — the pure, Foundry-free, unit-testable deterministic-module convention that 18.3/18.4 (scoring, burst/snowball/pack) must match exactly: no store I/O, no LLM calls, plain functions over data.
- Re-verify exact current line numbers/signatures fresh when implementing — this grounding may have drifted by the time each task starts.

---

## Task list

### 18.0 — QE test-authoring pass (runs first, standalone)
**Files:** new `test/combat-planning/*.test.mjs`, new `review-ui/test/combat-planning-routes.test.mjs` (or wherever `review-ui/test/session-planner-routes.test.mjs` actually lives — match it)

Read `plans/phase-18-review.md` in full plus every grounding file above, then define and write tests for every module in 18.1–18.7 below. Each test file's header comment must precisely specify: module path, exported function signatures, parameter/return shapes — since none of this exists yet, this pass is also the interface spec. Required coverage, per the design record's own hard requirements:

- **Extraction/scoring split** (§2): a test proving the action-economy score is computed by a pure function from raw fields, not asserted to come from the LLM call's own output — i.e., the LLM-facing extraction function's contract returns ONLY raw fields (no score field), and a separate pure function's contract takes those raw fields and returns the score.
- **Ingestion-time outlier sanity check** (§1a): a case with an implausible DPR-to-HP ratio gets flagged for human confirmation rather than silently accepted.
- **The six-axis effect-impact taxonomy** (§2): tests for at least 4-5 well-known D&D 5e condition names (Stunned, Restrained, Frightened, Poisoned) mapping to their expected dominant axis; a test for an UNRECOGNIZED/homebrew effect name explicitly returning an "unscored, needs manual tagging" state — **never a silently-guessed default score**, matching this project's established "render empty rather than padded" discipline (Phase 16/17's ambient-digest precedent).
- **Axis 5 (resource-drain) never blends into the shared impact pool** (§2) — a test asserting a resource-drain effect's contribution is reported separately, not summed with the other five axes.
- **Duration as an axis-aware multiplier** (§2) — a test proving the SAME duration value produces different score deltas depending on which axis it's multiplying (steep for axes 1/2/6, flatter for 3/4).
- **Dominant-axis-plus-decay aggregation, not flat summing** (§2) — the single most load-bearing correctness requirement from the review round: a test with an effect hitting two axes at once, asserting the combined score is LESS than the flat sum of both axis scores (proving decay is actually applied, not just present in a comment).
- **Burst ceiling's unconditional-or-cheap-setup guard** (§2) — a test with a burst component requiring 2+ setup steps being excluded from the ceiling number (or discounted), proving the "fantasy ceiling" guard is real.
- **Snowball delta against two candidates, not one** (§2) — a test asserting the function returns two deltas (top-damage-contributor removed, top-effective-HP-contributor removed), not a single "most critical" figure.
- **Pack coefficient** (§2) — a test proving N identical monsters with a focus-fire trait score higher than N independent copies without one.
- **Asymmetric risk as a secondary flag, not blended into the primary score** (§2) — a test asserting the "expected" score is IDENTICAL whether or not the burst-ceiling threshold fires; only a separate flag field changes.
- **`getPartyContext()` opt-in, never force-injected** (§3) — this is a consumer-facing API contract test: confirm nothing in `mutation-engine/narrate.mjs` or `mutation-engine/texture.mjs` calls it automatically (a grep-based or import-based test, not just a unit test of the function itself).
- **Bestiary storage is not the World Fabric graph** (§1a) — confirm no import of anything Foundry-facing in the bestiary/party-roster store modules, mirroring Phase 16's equivalent test for `scenes.mjs`.
- **Route-level security tests** (18.7) — every new route rejects a malicious/path-traversal-shaped `world` id and never accepts a client-supplied `dataDir`, extending the existing pattern in `review-ui/test/routes.test.mjs`/`session-planner-routes.test.mjs`, not inventing a new convention.
- **`.gitignore`** entries (with `.gitkeep`) for every new data store this phase introduces (bestiary, party-roster) — check the exact `DEFAULT_ROOT` each new store module declares and add the ignore line at spec time, this project's own recurring gap.

**Acceptance criteria:** every new test file fails with a clear "module not found" / "not a function" error (not a vacuous pass, not zero tests collected); full existing suite (root, `wf-mcp-server`, `review-ui` deterministic + e2e) still passes.

---

### 18.1 — Bestiary ingestion
**Files:** new `combat-planning/bestiary-ingest.mjs`, new `combat-planning/bestiary-store.mjs`

- `bestiary-ingest.mjs`: LLM extraction ONLY (no scoring) from pasted text or a PDF — raw fields per §1a/§2 (name, type, CR/level if present, HP, AC, per-attack to-hit/damage dice, multiattack structure, recharge value, legendary action count/cost, lair/aura effects as flags, a list of applied-effect names the creature can inflict). Truncation-aware via `callModelDetailed`, typed validation error on unparseable shape (matching `WriteupImportValidationError`'s pattern). **First thing in this task: the live-API PDF-input smoke check noted in Grounding above** — confirm before building the rest of ingestion on top of the assumption.
- `bestiary-store.mjs`: flat store (`DEFAULT_ROOT`/`GM_TOOLS_BESTIARY_DIR`, `withLock`), the ingestion-time outlier sanity check, a lighter accept/discard review step (matching `prep-content-ops.mjs`'s pattern, not the graph's mutation-review batch machinery). Store the raw extracted fields alongside whatever scoring gets computed on top later (18.3) — show-your-work requires both to persist together, not just the final score.
- Resolve the design record's open per-world-vs-per-user scoping question (§1a/§4) — your call, but state the decision and reasoning in a code comment since the design record explicitly left it open.

**Acceptance criteria:** 18.0's bestiary-ingestion tests pass; `.gitignore` entry present.

---

### 18.2 — Party roster ingestion
**Files:** new `combat-planning/party-roster-ingest.mjs`, new `combat-planning/party-roster-store.mjs`

- Same extraction-only shape as 18.1, applied to PC character sheets (pasted text or PDF). Split extracted fields per §1b: combat-relevant (class/level, AC, HP, attack bonus/damage-per-round estimate, save DCs, notable defensive/offensive abilities) vs. broader build-relevant (skills/expertise, notable traits, backstory hooks) — these feed different consumers (18.3's heuristic vs. 18.6's context API) and should be structurally distinguishable in the stored shape, not just informally documented.
- Store per-world (unlike bestiary's open scoping question, PCs genuinely belong to one campaign per the design record) — same store-pattern convention.

**Acceptance criteria:** 18.0's party-roster tests pass; `.gitignore` entry present.

---

### 18.3 — Action economy + effect-impact taxonomy scoring
**Files:** new `combat-planning/action-economy.mjs`, new `combat-planning/effect-impact.mjs`

- `action-economy.mjs`: pure function computing the action-economy score from 18.1/18.2's raw extracted fields (attacks/round, recharge value, legendary action count/cost). No LLM involvement.
- `effect-impact.mjs`: the six-axis taxonomy from `plans/phase-18-review.md` §2 (action-economy, mobility, accuracy-self, survivability-as-target, resource-drain [kept separate, never blended], forced-action). A hand-curated lookup table for well-known D&D 5e condition names (Stunned, Paralyzed, Restrained, Prone, Frightened, Grappled, Poisoned, Blinded, Charmed, Incapacitated, Petrified, Unconscious, Deafened, Exhaustion — a reasonable v1 starting set, extend if an obvious gap surfaces) mapping each to its axis scores. **An effect name that doesn't match the table returns an explicit "unscored" result, never a guessed/defaulted score** — this is a hard requirement, not a nice-to-have, matching this project's established discipline against silently fabricating data.
- Duration-aware multiplier (steep for axes 1/2/6, flatter for 3/4, no-op for axis 5) and the dominant-axis-plus-decay aggregation function (NOT flat summing) — both per §2, both real requirements 18.0's tests will check directly.

**Acceptance criteria:** 18.0's taxonomy/scoring tests pass, including the unscored-effect case and the aggregation-isn't-flat-summing case.

---

### 18.4 — Burst ceiling, snowball delta, pack coefficient
**Files:** new `combat-planning/burst-ceiling.mjs`, new `combat-planning/snowball-delta.mjs`, new `combat-planning/pack-coefficient.mjs`

- `burst-ceiling.mjs`: worst-case burst computation per §2, with the unconditional-or-≤1-free-setup-step guard against "fantasy ceiling" numbers.
- `snowball-delta.mjs`: runs the base scoring (18.3's combined output) twice against two candidate PCs — top damage contributor, top effective-HP/mitigation contributor — reporting both deltas, not one.
- `pack-coefficient.mjs`: the static `effective_threat × f(mob_count, has_focus_fire_trait)` multiplier.
- All three: pure functions, zero store I/O, zero LLM calls, matching `propagate.mjs`'s convention.

**Acceptance criteria:** 18.0's tests for all three pass, including the two-candidate snowball assertion and the focus-fire-trait pack-coefficient comparison.

---

### 18.5 — Encounter heuristic orchestrator
**Files:** new `combat-planning/encounter-heuristic.mjs`

- Ties 18.1–18.4 together: given a target difficulty and a candidate monster pool, suggests combinations/quantities hitting that target using the deterministic scoring from 18.3/18.4. Exposes the knobs from §2 (add/remove combatants, minion-rules toggle, legendary-action toggle, scaling sliders, pack coefficient, assumed player-tactics slider) as plain parameters — all deterministic, all instant, no LLM in this module at all.
- The candidate pool itself is expected to already be thematically filtered before reaching this module — **this module has no LLM call and should import nothing from `mutation-engine/llm-call.mjs`**. The LLM's thematic-filtering role (§2's closing paragraph — suggesting which bestiary tags fit the scene, grounded via the same pattern as `narrate.mjs`'s `buildAdjacencyContext`) is a separate, thin function that narrows the pool BEFORE calling into this orchestrator — keep it in its own small module (`combat-planning/thematic-filter.mjs`) so the deterministic core stays LLM-free and independently testable without mocking a client.
- Asymmetric-risk flag threshold (§2) applied here, as a field alongside (never blended into) the primary score.

**Acceptance criteria:** 18.0's orchestrator tests pass; a direct import-graph check (or simple grep, documented in a comment) confirms `encounter-heuristic.mjs` has no dependency on `mutation-engine/llm-call.mjs`.

---

### 18.6 — Party context-exposure API
**Files:** new addition to `combat-planning/party-roster-store.mjs` or a small new `combat-planning/party-context.mjs`, your call on placement

- `getPartyContext(world)` per §3: compact, prose-ready summary of the broader build-relevant fields from 18.2 (skills/expertise, notable traits, backstory hooks) — NOT the combat-relevant fields, which stay internal to the heuristic.
- Opt-in only — do not wire this into any existing prompt template (`narrate.mjs`, `texture.mjs`, etc.) as part of this task. Exposing the function is the whole scope here; deciding where it gets consumed is future work for whichever feature wants it.

**Acceptance criteria:** 18.0's opt-in-never-force-injected test passes.

---

### 18.7 — Server routes
**Files:** `review-ui/server.mjs`

- New routes under `/api/combat-planning/*`: bestiary ingest/list/accept/discard, party-roster ingest/list, and an encounter-suggestion endpoint wrapping 18.5's orchestrator (plus 18.5's thematic-filter, which DOES need the LLM — this is the one route in this set that makes a real API call).
- Every route uses the existing parameterless `resolveDir()`/`resolveWorld()` pattern — **no route in this task accepts a client-supplied `dataDir`**, the single highest-risk regression given several new routes land at once, exactly as flagged in Phase 16/17's equivalent tasks.
- No UI wiring — these routes exist for 18.0's route-level tests and for a future UI phase to consume, nothing in `review-ui/public/` changes here.

**Acceptance criteria:** 18.0's route-level tests pass, including the security cases; `review-ui/test/routes.test.mjs`'s existing security tests still pass unmodified.

---

## How to work

- Task 18.0 must fully complete, commit, and be confirmed red before 18.1 starts.
- Ground every implementation task in the actual current code — re-locate exact lines fresh.
- Commit after each completed task, clean incremental history. Stage files explicitly, never `git add -A`.
- `foundry_worldFabric` is not touched anywhere in this phase (bestiary/party-roster storage is deliberately not the World Fabric graph, per the design record). Verify `git -C /home/russell/foundry_worldFabric status --short` is unchanged before and after, matching this project's standing discipline around that repo's pre-existing unrelated uncommitted changes.
- Self-review remediation pass at the end of 18.7: run the full `node --test` suite (root + `wf-mcp-server` + `review-ui` deterministic + e2e), confirm nothing outside this phase's own new files regressed, and specifically re-verify the dominant-plus-decay aggregation isn't secretly flat summing and the unscored-effect case never silently guesses — these are the two correctness properties most likely to quietly regress under implementation pressure.

## Definition of done for Phase 18

- [ ] 18.0's test suite committed, confirmed red before any implementation exists.
- [ ] Bestiary ingestion (18.1) built and tested, PDF-input assumption verified against the real API early.
- [ ] Party roster ingestion (18.2) built and tested, combat-relevant vs. build-relevant fields structurally separated.
- [ ] Action economy + six-axis taxonomy scoring (18.3) built and tested, unscored-effect and non-flat-aggregation behaviors confirmed.
- [ ] Burst ceiling, snowball delta (two candidates), pack coefficient (18.4) built and tested.
- [ ] Encounter heuristic orchestrator (18.5) built and tested, confirmed LLM-free; thematic filter kept in its own separate module.
- [ ] `getPartyContext()` (18.6) built and tested, confirmed not wired into any existing prompt template.
- [ ] Server routes (18.7) wired, existing + new security tests passing.
- [ ] Full existing test suite (root + `wf-mcp-server` + `review-ui` deterministic + e2e) still passes.
- [ ] `.gitignore` entries present for every new store.
- [ ] `foundry_worldFabric` confirmed untouched throughout.
- [ ] Self-review remediation pass run and reported.
