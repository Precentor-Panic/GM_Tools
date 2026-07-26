# GM_Tools — Phase 11 Task Plan: Per-Node Content Generation

**Status:** ready to execute — queued behind Phase 10 (per-entity narration) and Phase 7 (visual graph view), both of which touch overlapping files (`wf-mcp-server/index.mjs`/`lib/`, `review-ui/public/*`). Do not start until both are committed and the working tree is clean. **Prerequisite reading:** `CLAUDE.md` → `PLAN.md` → this file → `plans/phase-11-review.md` (the design reasoning — settled, not a starting point to redesign) → `.claude/skills/gm-tools-conventions/SKILL.md`.

**What this is:** an opt-in, entity-scoped "develop this node" action — a framing-first, two-stage LLM pipeline (mirroring the existing whole-writeup rubber-duck mode) that generates structured, type-specific prep content (description, secrets, potential rolls, hooks) for an already-committed entity, stored durably and editable at field granularity afterward. Deliberately separate from the mutation-engine/graph-diff pipeline — this is authorial reference material, not a proposed change to graph structure.

**Confirmed decision (resolves the one open question `phase-11-review.md` flagged)**: PrepContent **never syncs to Foundry**. It's purely GM-side reference material living in GM_Tools' own store — no wiring into `wf_sync_to_foundry` or any Foundry-visible journal entry at all. Simplest, zero leak risk for secret-field content. If a future phase ever wants in-Foundry visibility, that's new, separately-scoped work — do not build a GM-only/player-visible split speculatively here.

**Already built and reusable — confirmed by reading the code, not assumed:**
- The whole-writeup rubber-duck mode's framing mechanism (`graph-import/writeup-import.mjs`'s `proposeFramingsFromWriteup`, `prompts/writeup-framing.md`, the one-round reject-loop bound in `resolveRejectLoop`/`MAX_FRAMING_ROUNDS`) — this phase's per-entity framing step is the same pattern, one level down. Read it before building a second one from scratch.
- `mutation-engine/human-review.mjs` — the exact flat-JSON/`withLock`/env-override convention `PrepDoc`'s new store should follow (same convention Phase 10's `entity-narration.mjs` just followed — read that file too, it's the most recent, freshest example of this exact pattern).
- Whatever adjacency/neighborhood helper Phase 7/10 ended up using for "this entity's immediate graph context" (`wf-mcp-server/lib/graph.mjs`'s `neighborhood()`, confirmed to exist) — reuse for grounding the framing/generation prompts, per the design doc's explicit "graph-neighborhood-aware generation" requirement.
- `mutation-engine/llm-call.mjs`'s `callModelDetailed` — truncation-aware model-calling primitive, use it for both new LLM calls in this phase.

---

## Task list

### 11.1 — PrepDoc store
**Files:** `mutation-engine/prep-content.mjs` (new)

- Follows `human-review.mjs`/`entity-narration.mjs`'s established convention exactly: flat JSON, `GM_TOOLS_PREP_CONTENT_DIR` env-override, `withLock` reused for writes.
- Shape per the design doc: `{entityId, entityType, framingUsed, status: 'proposed'|'accepted'|'stale', generatedAt, lastRegeneratedAt, fields: {...type-specific}}`. `fields`' exact keys per type are specified in `phase-11-review.md`'s template list — implement all six entity types (person/place/faction/object/event get full templates; concept gets the reduced `description` + `howItSurfaces` scope per the design doc's explicit scoping call).
- `getPrepContent(world, entityId)`, `savePrepContent(world, entityId, doc)`, `markPrepContentStale(world, entityId)` (called when the entity's core fields are later mutated — see task 11.4), `updatePrepField(world, entityId, fieldName, newValue)` (the field-granular living-doc edit path).

**Acceptance criteria:** unit tests matching `entity-narration.mjs`'s own test style: save-then-get round trip for each entity type's template shape, `markPrepContentStale` flips status without deleting fields, `updatePrepField` mutates one field without touching others, directory isolation via env override, a real concurrent-write test via the shared lock.

---

### 11.2 — Framing + generation calls
**Files:** `mutation-engine/prep-content.mjs` (extend), `prompts/prep-framing.md` (new, per-entity-type sections or a shared template with type-conditional instructions — your call), `prompts/prep-generation.md` (new, same)

- `proposeFramingsForEntity(entity, neighborhoodContext, opts)` — same shape as `proposeFramingsFromWriteup`: cheap, small `maxTokens`, exactly 3 one-sentence angles, retry-once-then-typed-error, entity-type-aware prompt (a person's framing angles are about "who they really are," a place's about "its actual role," etc. — per the design doc's template breakdown).
- `generatePrepContent(entity, neighborhoodContext, framingSelection, opts)` — the fuller call, steered by the chosen/blended framing, producing the type-specific structured `fields` object. Validate the model's output against the entity type's expected field shape (zod, matching this codebase's established validate-before-trusting-LLM-output convention) with the same retry-once-then-typed-error pattern.
- Both calls pull `neighborhood()`-based graph context for the entity as grounding (the design doc's explicit "graph-neighborhood-aware generation" addition) — build this context once per invocation, don't re-fetch redundantly across the two calls.
- Reuse the existing one-round reject-loop bound pattern from writeup-import's rubber-duck mode (`MAX_FRAMING_ROUNDS`-equivalent) for this phase's own reject/reframe flow.

**Acceptance criteria:** unit tests (mocked LLM) per entity type confirming correct template validation; a real-API smoke test proving two different entities (e.g. a person and a place) produce genuinely different, type-appropriate field shapes — the actual regression test for "generic mushy content forced onto everything," which is the specific failure mode this phase's framing-first design exists to prevent.

---

### 11.3 — MCP tool + review-ui wiring
**Files:** `wf-mcp-server/index.mjs`, `wf-mcp-server/lib/mutation-ops.mjs` (or a new `prep-content-ops.mjs` — your call), `review-ui/server.mjs`

- New MCP tools (naming your call, matching existing conventions): propose framings for an entity, generate/accept prep content, get an entity's current prep content, regenerate a single field, mark an entity's prep content stale.
- New review-ui routes backing the same operations. **"Develop this node" is reached from wherever the GM already looks at a settled, already-committed entity** (per the design doc: NOT a Batch Review row action) — this likely means a new small entity-detail surface if one doesn't already exist; check what's actually reachable today (the standalone Graph view from Phase 7, if built first, is a natural place for this to hang off of — confirm against whatever's actually landed by the time this phase executes, don't assume Phase 7's exact shape without checking).
- **No bulk "develop all" affordance anywhere** — this is a hard constraint from the design doc, not a nice-to-have; do not add a batch/multi-select trigger for this feature.

**Acceptance criteria:** route-level tests matching the established style; real-API smoke test covering the full flow (frame → pick → generate → accept → later regenerate one field → confirm the rest of the fields are untouched).

---

### 11.4 — Staleness on re-mutation
**Files:** wherever mutations get applied/accepted for an entity (same hook point Phase 10 task 10.3 used for narration invalidation — reuse the same integration point if it's a clean fit, don't add a second one)

- When an entity with existing PrepContent has its core fields mutated by a later-accepted batch, call `markPrepContentStale` — the content remains fully readable but flagged, so the GM knows it may no longer reflect the entity's current state without losing what was already written.

**Acceptance criteria:** a test proving: entity X gets prep content generated (accepted) → a later batch mutates X and gets accepted → X's prep content is now `status:'stale'`, fields unchanged and still fully readable.

---

### 11.5 — Frontend: "Develop this node"
**Files:** review-ui frontend files, exact set depends on where task 11.3 ended up placing the entry point

- A clearly separate, deliberately NOT-batch-review-adjacent UI: an entity detail view (or an addition to wherever Phase 7's standalone Graph view's node click lands, if that's already built) showing: current prep content (if any) rendered per its type-specific fields, a "Develop this node" trigger if none exists yet, the framing-pick step (reuse whatever visual pattern Phase 8's framing-selection screen established, don't invent a second one), and per-field regenerate/edit controls once content exists.
- Visually distinguish `stale` content (a quiet marker, not an alarming one — matching this project's established "mild interrupt" convention for status flags elsewhere, e.g. the unreviewed-accumulation amber border).

**Acceptance criteria:** manually verified in a real browser (same standard as every prior UI phase — actual screenshots inspected): developing a person and a place produces visibly different, type-appropriate content sections; regenerating one field visibly leaves the others untouched; a staleness marker appears after the underlying entity is remutated.

---

## How to work

- Ground every claim in the actual code — the entry-point location (task 11.3/11.5) genuinely depends on what Phase 7 built, not on an assumption made before either phase existed. Check, don't guess.
- Write backend tests in the project's existing style (`node --test`, no framework); manual/screenshot-verified checks for the frontend.
- Commit after each completed task.
- Self-review remediation pass at the end: specifically re-check (a) PrepContent genuinely never reaches any Foundry-sync code path — grep for it, don't just trust the design intent, (b) no bulk-generate affordance was accidentally added, and (c) staleness marks content without ever deleting it.

## Definition of done for Phase 11

- [ ] `prep-content.mjs` store built and tested, all six entity-type templates implemented (concept reduced per design doc).
- [ ] Framing + generation calls built, gated the same way every other LLM call in this codebase is (retry-once-then-typed-error, truncation-aware), grounded in real graph-neighborhood context — confirmed via a real-API test that two different entity types produce genuinely different, type-appropriate content.
- [ ] MCP tools + review-ui routes wired; entry point is NOT a Batch Review row action.
- [ ] No bulk "develop all" affordance exists anywhere in the UI or API surface.
- [ ] Staleness flagging works on re-mutation without deleting content.
- [ ] Confirmed by direct code inspection: PrepContent is never referenced by `wf_sync_to_foundry` or any Foundry-write path.
- [ ] Full test suite (root + wf-mcp-server + review-ui) still passes.
- [ ] Self-review remediation pass run and reported.
