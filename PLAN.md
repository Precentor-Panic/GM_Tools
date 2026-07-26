# GM Tools — Reusable Stack Plan

A collection of tools for LLM-assisted tabletop RPG session design and live play. Generalized from "The Threadbare City" one-shot (Merrath, pinned at `/home/russell/campaign/`). Not D&D-specific; applicable to any TTRPG that uses World Fabric for world state.

---

## The Core Pattern

Any sufficiently complex one-shot or campaign session can be modeled as:

```
event fires at a graph node
  → BFS outward: (node_id, distance, path_edge_type)[]
  → LLM call [mutation]: event semantics × blast radius → structured graph mutations
  → apply mutations to graph
  → LLM call [scene]: updated subgraph snapshot → scene/consequence description (2–3 paragraphs)
```

This "blast radius" pattern works for any world-as-graph system. The tools in this collection implement it in a config-driven, session-agnostic way.

---

## LLM vs. Non-LLM Split

| Task | LLM | Reason |
|------|-----|--------|
| BFS blast radius traversal | ❌ | Pure graph math |
| Apply graph mutations to WF | ❌ | Pure data write |
| Doom clock counter / threshold | ❌ | Simple integer |
| WFI import / export | ❌ | Existing code |
| Scene / actor creation in Foundry | ❌ | API call |
| Event mutation interpretation | ✅ | Semantic + creative |
| Scene-setting narration | ✅ | Creative, contextual |
| Map prompt generation | ✅ | One-time design task |
| NPC card generation | ✅ | One-time design task |

The LLM is called twice per event — once to decide what changes (structured output only), once to describe the result (bounded narration). Everything else is deterministic code.

---

## Tool 1: World Fabric "Graph Push to Foundry" (Feature Request)

**This belongs in the World Fabric project, not this folder. File as a GitHub issue / CLAUDE.md note there.**

**Location:** `/home/russell/foundry_worldFabric`  
**Integration point:** `scripts/apps/cockpit-app.mjs` lines 645–662, `_createFoundryDoc`  
**Current state:** Creates one entity at a time via right-click UI  

**Feature scope:**
- Add "Push to Foundry" bulk action (toolbar or multi-select right-click)
- For each selected entity: `place` → Foundry Scene, `person` → Actor, `faction` → JournalEntry
- Seed fields: `name`, `description`, `imageUrl` (as scene background or actor image), `tags` as Foundry flags
- After creation: write Foundry doc UUID back to entity's `foundryRef` field (already supported in schema)
- Scenes: `description` → scene notes; movement edges → scene navigation links (if Foundry v14 supports)

**Not built here.** Write the feature request and leave a pointer from this file.

---

## Tool 2: Foundry MCP Server (Install, Don't Build)

Install from Foundry package manager into local Foundry instance (`http://localhost:30000`). Configure in Claude Code MCP settings.

**Options (in order of preference):**
1. `foundry-mcp-bridge` — official Foundry package, package manager install
2. `laurigates/foundryvtt-mcp` — 20 tools: actor querying, scene management, content generation, world search
3. `adambdooley/foundry-vtt-mcp` — bridges Foundry data with Claude Desktop

**Verification:** After install, confirm Claude can query actors and scenes via MCP tool calls.

**Not built here.** Install action only.

---

## Tool 3: World Fabric MCP Server

**Location:** `GM_Tools/wf-mcp-server/`  
**Why:** Querying a full WF graph serialized into LLM context is expensive and drifts. An MCP server lets Claude make targeted queries during live sessions without owning state.

**Operations:**

| Operation | Input | Output |
|-----------|-------|--------|
| `get_entity(id)` | Entity ID | Single entity with all attributes |
| `get_adjacent(id, depth)` | Entity ID + hop count | Subgraph within N hops (blast radius input) |
| `apply_mutations(mutations[])` | Array of WF schema mutations | Calls `importGraph` from `interchange.mjs`, returns updated entity/edge counts |
| `get_entities_by_type(type)` | Entity type string | All entities of that type |
| `get_session_state()` | — | Current doom clock position, thread statuses (from session-layer bookkeeping) |

**Implementation:** Wraps `GraphService` (`scripts/data/graph-service.mjs`) via Foundry's module API. If running outside Foundry context, reads from exported WFI JSON directly.

**WFI mutation schema (output format for `apply_mutations`):**
```json
{
  "version": "1.0",
  "entities": [
    { "id": "...", "attributes": { "key": "newValue" } }
  ],
  "edges": [
    { "sourceId": "...", "targetId": "...", "strength": 0.8, "valence": "negative" }
  ]
}
```

---

## Tool 4: Parameterizable Session Runner

**Location:** `GM_Tools/session-runner/`  
**Why:** The blast-radius pipeline doesn't need to be baked into any specific campaign. Any session config + WFI graph → runnable session.

**Config schema:**
```json
{
  "session": {
    "name": "",
    "doomClockThreshold": 7,
    "doomClockMode": "scene-counter"
  },
  "events": {
    "scripted": [
      { "id": "T-1", "type": "scripted", "narrativePath": "narrations/t1.md" },
      { "id": "penultimate", "type": "scripted", "trigger": "doom_clock_threshold" }
    ],
    "pool": [
      {
        "id": "A",
        "tier": "linen",
        "phrase": "...",
        "type": "dynamic"
      }
    ]
  },
  "pipeline": {
    "bfsDepth": 3,
    "edgeWeights": { "causal": 1.0, "fealty": 0.9, "kinship": 0.85, "membership": 0.7, "ownership": 0.6, "containment": 0.6, "origin": 0.6, "presence": 0.55, "knowledge": 0.5, "social": 0.4, "unspecified": 0.3 },
    "textureModel": "claude-sonnet-5",
    "textureModelOverride": "claude-opus-4-8",
    "sceneModel": "claude-sonnet-5"
  }
}
```
*(`edgeWeights` now covers all of World Fabric's `RELATIONSHIP_TYPES` — the propagation engine in `mutation-engine/propagate.mjs` needs a weight for every type it might encounter. `mutationModel`/`sceneModel` renamed `textureModel`/`sceneModel` to match the phased plan below: the mutation/texturing pass is now the propagation engine's batched LLM call, not a monolithic session-runner call. Phase 1.5 split World Fabric's old catch-all `location` type into `containment` (structural, e.g. a place's parent region — excluded from `ambientDecay` entirely) and `presence` (temporal, e.g. an actor's recent whereabouts — decays same as `location` did); `edgeWeights` above reflects the rename. Phase 1.5b resolved the `person.homeLocation` question left open by Phase 1.5: it's `origin` (biographical — where someone is *from*, distinct from `containment`'s structural sense even though both are hard-excluded from `ambientDecay`), weighted the same as `containment`. See `plans/phase-1.5-tasks.md`.)*

**Components:**

- `burn-algorithm.mjs` — BFS traversal of WF graph from event epicenter. Returns `(node_id, distance, path_edge_types)[]`. Uses edge weight config for severity scoring.
- `apply-mutations.mjs` — Takes structured LLM mutation output, writes to World Fabric via `apply_mutations` MCP call (or direct WFI import in merge mode).
- `session-runner.mjs` — Orchestrator. Manages doom clock counter, routes events to scripted or pipeline path, sequences the two LLM calls, triggers penultimate event at threshold.
- `prompt-mutation.md` — LLM Call 1 template. Input: event phrase/type + blast radius list + node states. Output: JSON mutations in WF schema. No free text.
- `prompt-scene.md` — LLM Call 2 template. Input: current location, reachable areas, updated subgraph diff. Output: 2–3 paragraphs ending on sensory hook or decision point. No character voice, no state tracking.

**Doom clock modes:**
- `scene-counter` — increments per scene completed. Threshold fires penultimate. Bidirectional (AW-style): event can advance clock OR clock advancing can fire event.
- `real-time` — wall-clock based fallback for firing scripted endings at thematically appropriate moments (optional, session-specific config).

---

## Tool 5: Claude Code Skills

**Location:** `~/.claude/CLAUDE.md` (global) or project-level CLAUDE.md  
**Why:** Structured input → consistent output. Reduces planning drift. Repeatable design tasks that shouldn't cost open-ended conversation tokens.

| Skill | Input | Output |
|-------|-------|--------|
| `/plan-session [doc]` | Session design .md | WFI seed JSON + NPC cards + event pool config |
| `/npc-card [name] [role] [secret] [motivation]` | Structured fields | Formatted NPC entity ready for WFI import |
| `/scene-brief [location] [event] [party]` | Structured context | 2–3 paragraph scene description + suggested event/thread |
| `/event-resolve [phrase] [target] [nearby-nodes]` | Structured input | Structured graph mutations (WF schema) |
| `/push-session [config]` | Session config file | Validates config, confirms pool, previews doom clock, confirms BFS depth |

Each skill is a CLAUDE.md-defined prompt template with explicit field structure. Not open-ended conversation.

---

## Maps Workflow

No API path exists for contextual, artistically appropriate map generation from a node graph. Workflow:

**Step 1 — Generate map prompts (LLM, one-time per district/area):**  
Produce a detailed text prompt per district and key area-node. Prompt specifies: city style, district character, landmarks, mood, visual references. Save to `campaign/maps/prompts/[district]-[area-node].md`.

**Step 2 — Generate maps (manual, any tool):**  
Take prompts to GPT-4o, Gemini, Midjourney, commissioned artist, or commercial map pack. Output to `campaign/maps/generated/[district]-[area-node].png`.

**Commercial packs to evaluate (Foundry-native):** Baileywiki, 2-Minute Tabletop, Tom Cartos (urban focus). A city pack likely covers all districts without custom generation.

**Step 3 — Verify (Claude vision):**  
Claude can read map images via vision. Confirm each map matches its area-node description before assigning.

**Step 4 — Graph Push loads them:**  
Tool 1 (Graph Push feature) reads `imageUrl` from WF entities and assigns maps as Foundry scene backgrounds during bulk push. Filename convention: `[district]-[area-node].png` must match WF entity names.

---

## Build Sequence (steps 1–3: historical, still accurate) / Phased Toolbox Plan (current)

Steps 1–3 below predate the toolbox reframing and remain accurate completed-work history. **From step 4 onward, this linear sequence is superseded** by a phased, independently-shippable toolbox plan — see `plans/phase-N-tasks.md` for the current, detailed execution checklists.

| Step | Item | Location | Notes |
|------|------|----------|-------|
| 1 | ~~File~~ Build Graph Push | World Fabric project | Built directly (M13a), not just filed. `cockpit-app.mjs _pushSelectionToFoundry()` |
| 2 | Install Foundry MCP server | Foundry package manager | Configured in `~/.mcp.json` as `foundryvtt` (generic actor/scene MCP) — pending approval in Claude Code |
| 3 | Build WF MCP server | `GM_Tools/wf-mcp-server/` | **Done.** Reads `world-fabric-snapshot.json` / writes `world-fabric-mutations.json` (the file bridge GraphService already exports) rather than reaching into the Foundry module directly — GraphService only runs in-browser. Registered in `~/.mcp.json` as `world-fabric`. Smoke-tested against live `wf-test` snapshot. |

**Current phased plan** (toolbox framing — each phase independently shippable, no single critical path; see `plans/` for task-level detail):

| Phase | Deliverable | Ships independently? | Status |
|---|---|---|---|
| 0 | Prep-time tools (NPC cards, scene briefs, doom clocks, VTT push via step 1's Graph Push) | Yes | Not started |
| 1 | Mutation engine core: schema, propagation pass, review-state, diff, grain, rollback, batched texturing, conversational MCP review tools | Partially (infra) | **Done** — tasks 1.1–1.8 built and unit-tested (`mutation-engine/`, 7 new `wf-mcp-server` tools); task 1.9 (dedicated web review UI) explicitly deferred to Phase 6 per its own text. See `plans/phase-1-tasks.md` and `mutation-engine/README.md`. Propagation-tuning constants (task 1.3) are prototype defaults, calibration deferred. Post-Phase-1 remediation also landed: `Mutation`/`StoredMutation` schema split (dropped `.passthrough()`), `diff.mjs` wired into the live review path, `npm test` fixed. |
| 1.5 | **World Fabric containment/presence split** — fixes a real schema gap (see `plans/phase-1.5-tasks.md`): `location` was conflating structural containment with decaying presence, which would have made GM_Tools' own `ambientDecay` eventually produce spurious "building stopped being in its district" mutations on a long campaign. Out of numeric order, inserted before Phase 2 because Phase 2's `contained-in` scope mode depends on it. | Yes (fixes existing behavior) | **Done** — tasks 1.5.1–1.5.4 landed across both repos: World Fabric gained `containment`/`presence` relationship types (`place.region`/`faction.headquarters` derive `containment`; world-scan's token-placement tracking uses `presence`; one-time migration relabels persisted `scan:loc:*` edges), GM_Tools' `ambientDecay` hard-excludes `containment` while `propagateSeed` still traverses it normally. **1.5b (done):** `person.homeLocation` resolved to its own type, `origin` (biographical — where someone is *from*; never decays, but isn't structural containment either) rather than reusing `containment` or moving to `presence`. Needed its own entityTypes-level migration in World Fabric (`_runMigration`'s "merge new attributeDefs" step is additive-only and does not retroactively update an already-persisted attributeDef's `deriveEdge`, contrary to Phase 1.5's original "no migration needed" assumption — confirmed by inspection against a live test world). GM_Tools' `ambientDecay` exclusion refactored to a `NON_DECAYING_RELATIONSHIP_TYPES` set covering both `containment` and `origin`; `propagateSeed` traverses `origin` normally. **1.5c (done):** found and fixed the same additive-only-migration gap for the *original* `containment` case — `place.region`/`faction.headquarters`'s persisted `deriveEdge` was still frozen at `location` on already-existing worlds (confirmed live against `wf-test`) despite `constants.mjs` saying `containment` since 1.5. Migration extended to cover both; live-reverified. |
| 2/2b | Time-skip mode + headless (Foundry-optional) apply — the MVP wedge, now including LLM-inferred seed resolution and `region`/`contained-in` scope modes | Yes | **Done** — tasks 2.0–2.4 built and tested per `plans/phase-2-tasks.md`. `time-skip/scope.mjs`/`run.mjs` extracted from `wf_propose_mutations`'s prior inline logic (byte-identical, task 2.0); `region` (shallow, all-edge-type BFS) and `contained-in` (containment-typed-edges-only reachability, unbounded-ish depth) scope modes added (task 2.1); `orchestrateBatch` gained per-region checkpointing/resumability with a real cross-process kill-and-resume test (task 2.2); `time-skip/resolve-seed.mjs` resolves a freeform event description to an entity id via LLM, kept deliberately separate from the deterministic `resolveScope` (task 2.2b); `graph-import/headless-apply.mjs` applies mutations directly to a standalone snapshot with no live Foundry client, reusing `interchange.mjs`'s `importGraph` (task 2.3); `wf_sync_to_foundry` now falls back to the headless path and always reports which path was used (task 2.4). A remediation pass found and fixed two real issues: `texture.mjs`/`resolve-seed.mjs`'s duplicated LLM-call plumbing extracted to `mutation-engine/llm-call.mjs`, and `contained-in` + ambient mode was a structural no-op (containment edges — used to find the in-scope entity set — are themselves excluded from decay; fixed to decay any real edge between two already-in-scope entities instead). The two real-API integration smoke tests (2.2's cost-reduction check, 2.2b's resolveSeed check) are written and unit-tested via mocks but **not executed** — `ANTHROPIC_API_KEY` was not set in the build environment. |
| 3 | Live on-demand diff mode | Yes | **Done** — tasks 3.1–3.3 built and tested per `plans/phase-3-tasks.md`. Task 3.1 confirmed `time-skip/scope.mjs`'s existing `seed` mode needed no code changes, but measured (5 real timed runs each, depth=2 and depth=3, against a 50-entity/129-edge fixture) that `wf_propose_mutations` is NOT reliably sub-5s live: depth=3 p50=59.0s (min 34.4s, max 59.9s), depth=2 p50=51.4s (min 26.1s, max 62.5s) — depth barely moves the number, since the real cost driver is texture-eligible entity count within the single affected region (-> output tokens for that one API call), not BFS hop count, so `scope.mjs`'s depth default was deliberately left unchanged at 3. Task 3.2 built `mutation-engine/narrate.mjs` — the project's long-missing second LLM call (`PLAN.md`'s original "Core Pattern": mutation call + narration call) — producing 2-3 paragraphs of player-facing prose per accepted batch, hard-gated so it never runs against a batch with any non-`accepted` mutation (`NarrationGateError`, code-enforced, not just prompt-level), reusing `llm-call.mjs`'s shared plumbing. Task 3.3 wired `wf_narrate_batch` into `wf-mcp-server/index.mjs` and added a latency-guidance note (citing 3.1's real numbers) to `wf_propose_mutations`'s tool description so a calling Claude Code session says "resolving, one moment" before a live-diff proposal rather than appearing to hang. A real-subprocess, real-MCP-protocol, real-API round trip (propose → review → accept → narrate → regenerate-with-note → sync, plus confirming the narration gate refuses a batch with pending/rejected mutations) ran and passed against the live Anthropic API — see `wf-mcp-server/test/live-diff-narrate.smoke.mjs` and the Phase 3 closing report for the actual transcript/narration text. |
| 3.5 | **Deferred/lazy consequence resolution** — for large time-skips, resolve only a per-cycle "headline" scope eagerly (reusing Phase 3's `seed`-mode mechanism) and record everything else as a cheap, unresolved ledger tag instead of texturing or discarding it. Zero further cost unless a tagged entity is later explicitly asked about; on-demand resolution caps fan-out by impact score (top-K, not sub-clustering) rather than risking a cost spike on a high-degree anchor. | Yes | **Done** — tasks 3.5.1–3.5.5 built and tested per `plans/phase-3.5-tasks.md`. `mutation-engine/pending-ledger.mjs` (task 3.5.1) is the new per-entity JSON ledger (`pending-resolution/<world>/<entityId>.json`), reusing `review-state.mjs`'s `withLock`/`ConcurrentWriteError` (exported for that purpose) rather than duplicating file-locking; schema.mjs bumped to `SCHEMA_VERSION` 2 for the additive `SourceKind` value `'deferred-resolution'` and `Batch.resolvedPendingEntries`. `time-skip/run-cycle.mjs`'s `orchestrateCycle` (task 3.5.2, new file, `orchestrateBatch` untouched) textures one small headline neighborhood per cycle and defers everything else in the cycle's scope to the ledger — including deltas that would have cleared `needsLLM` on their own — plus a growth-bound sweep that folds an already-bloated entity's full backlog into the current cycle rather than letting it grow unbounded. `time-skip/resolve-pending.mjs`'s `resolvePending` (task 3.5.3) is the explicit on-demand resolve: gathers a requested entity's own backlog plus its BFS neighborhood's pending-bearing entities, applies **the fan-out cap** (top-`maxNeighbors`, default 8, by impact score — flat, not sub-clustering, per the architect's settled reasoning), and renders everything **chronologically by `cycleDescriptor`** (new `renderPendingResolutionSummary` in `texture.mjs`, reusing `textureRegion` via a new `deltaSummaryOverride` hook rather than forking a parallel texturing path) in one API call. Task 3.5.4 wires `pending-ledger.mjs`'s `applyLedgerOutcome` into `wf_accept`/`wf_reject` — accept clears resolved entries, reject reverts them to `'pending'`, never silently dropped. Task 3.5.5 adds `wf_run_cycle`/`wf_resolve_pending` to `wf-mcp-server/index.mjs`; confirmed by direct inspection that none of `wf_get_entity`/`wf_get_context`/`wf_get_adjacent`'s handlers reference the resolve path. A real, API-backed multi-cycle round trip (`wf_run_cycle` ×3 with rotating headline foci → backlog accumulation confirmed → `wf_resolve_pending` → real LLM output that explicitly synthesizes all three cycles → `wf_accept` → ledger cleared → `wf_sync_to_foundry` → a 4th cycle → resolve again → `wf_reject` → entry back to `'pending'`, not gone → `wf_rollback_batch` still functions on a resolve-originated batch) ran twice against the live Anthropic API and passed both times — see `wf-mcp-server/test/deferred-resolution-multicycle.smoke.mjs`. A self-review remediation pass found and fixed one real issue (a `safeBatchHeadline` helper and a `readPending(...).filter(status==='pending')` idiom duplicated verbatim across `run-cycle.mjs`/`resolve-pending.mjs`, factored into `pending-ledger.mjs` as `sourceBatchHeadline`/`readAvailablePending`); the fan-out cap this phase builds is noted as the same mechanism that would fix Phase 3's live-diff latency (~50s p50) if that's ever revisited, but is deliberately NOT retrofitted into that path as part of this phase. |
| 4 | Rollback hardening + unreviewed-accumulation tracking | Yes | **Done** — tasks 4.1–4.2 built and tested per `plans/phase-4-tasks.md`. Task 4.1 closed the confirmed newly-created-entity rollback gap: `graph-import/headless-apply.mjs`'s `applyHeadless` now pre-assigns and reports back the id it gives every id-less create (same `wf_<ts>_<n>` convention `interchange.mjs`'s own generator uses, one shared counter so the two can never collide), and `wf_sync_to_foundry` writes that id back onto the batch's stored mutation entry so `rollback.mjs`'s existing preState:null + entry.id logic resolves to a real delete instead of skipping — no code change needed in `rollback.mjs` itself. The live-Foundry path has the same underlying gap but is confirmed unclosable from this side without a `foundry_worldFabric` change (the mutation watcher never reports a created id back through the file bridge) — documented, not silently left unexamined, and still gracefully skipped rather than crashing. A real end-to-end proof (`wf-mcp-server/test/rollback-created-entity.test.mjs`, spawns the real MCP server against a real fixture snapshot) confirmed a created entity is genuinely deleted from the snapshot after propose→accept→sync(headless)→rollback. Found and fixed one adjacent gap while proving this: `wf_rollback_batch` had no headless fallback at all (unlike `wf_sync_to_foundry`), so a rollback could never actually apply against a genuinely headless-only campaign — fixed by extracting the shared live-then-headless behavior into `applyMutationsWithHeadlessFallback()`, reused by both tools; reverified against the real, API-backed `deferred-resolution-multicycle.smoke.mjs`. Task 4.2 built unreviewed-accumulation tracking from scratch: new `mutation-engine/human-review.mjs` tracks per-entity `lastHumanReviewedAt`/`unreviewedAcceptCount`, updated by `wf_accept`/`wf_reject`/`wf_regenerate` at `region`/`entity` scope and `wf_review_batch` at `region`/`entity` grain, but deliberately NOT by a whole-`batch`-scope accept-all (the entire point of the feature) or `headline`-grain viewing (a collapsed overview, not a shown diff); new `wf_get_unreviewed_entities` tool surfaces flagged entities (never-reviewed / stale-by-`maxAgeDays` / accumulated-by-`maxUnreviewedAccepts`, both configurable, substituting "N days" for the original "N sessions" framing since no per-entity session-counter primitive exists elsewhere in this project); `grain.mjs`'s `summarizeBatch` gained an optional `flaggedEntityIds` Set (stays pure/Foundry-free) that forces a flagged entity out of headline collapse regardless of importance. A real end-to-end MCP-protocol test (`wf-mcp-server/test/unreviewed-accumulation.test.mjs`) proved the core distinction (batch-accept-all leaves an entity flagged; a scoped accept/entity-grain view clears it; headline-grain viewing does not) and the force-into-headline behavior. A self-review remediation pass found and fixed one real issue (a repo-pollution bug: four existing wf-mcp-server test/smoke files exercising `wf_accept` through the real MCP server weren't isolating `GM_TOOLS_HUMAN_REVIEW_DIR`, so running them wrote real files into the repo's default `human-review/` root — fixed to match the established `GM_TOOLS_REVIEW_STATE_DIR`/`GM_TOOLS_PENDING_LEDGER_DIR` isolation pattern) plus two small non-functional cleanups in `human-review.mjs` (a duplicated per-entity lookup, a redundant `Date` round-trip).
| 5 | Import-from-writeup | Yes | **Done** — tasks 5.1–5.3 built and tested per `plans/phase-5-tasks.md`. Task 5.1 (`graph-import/writeup-import.mjs`'s `proposeWfiFromWriteup`, `prompts/writeup-import.md`) is one LLM call turning freeform text into a WFI-shaped proposal (entities/edges referencing endpoints by name, never an id, each with a `rationale`), reusing `mutation-engine/llm-call.mjs`'s shared plumbing and the same retry-once-then-typed-error convention as `texture.mjs`/`resolve-seed.mjs`, gated by a simple v1 length guard (`MAX_WRITEUP_CHARS`, a typed `WriteupTooLargeError`). Task 5.2 (`previewWriteupImport`, same file) dry-runs the proposal through `interchange.mjs`'s `importGraph` WITHOUT persisting and converts the effective changes into a normal review-state.mjs batch (`importWriteup`) — confirmed by a real test (not assumed) that a writeup mentioning both a brand-new entity and one already in the graph produces one create and one update targeting the real existing id, not two creates; edges referencing entities purely by name resolve correctly and stub-creation happens for a referenced-but-undescribed endpoint, matching `importGraph`'s existing behavior exactly. New additive `SourceKind` value `'writeup-import'` (`schema.mjs`, `SCHEMA_VERSION` 2 → 3). `regenerateWriteupImport` re-invokes the LLM call against the batch's own recorded source text (`batch.scope.text`) plus a steering note, replacing the whole batch's mutations — writeup extraction is a holistic pass, not a per-entity delta, so `wf_regenerate`'s `scope='entity'` is refused for a writeup-import batch with a clear typed error rather than attempting an unsound partial replace. Task 5.3 wired `wf_propose_from_writeup` into `wf-mcp-server/index.mjs` as a thin wrapper; `wf_accept`/`wf_reject`/`wf_sync_to_foundry`/`wf_rollback_batch` needed NO changes at all (already generic over batch shape), and `wf_regenerate` gained the dispatch described above. A real, API-backed MCP-protocol round trip (`wf-mcp-server/test/writeup-import-roundtrip.smoke.mjs`: propose → review → regenerate-with-note → accept → sync) ran against BOTH an existing populated snapshot (confirming an existing entity deduped to exactly one, not duplicated) AND a freshly-bootstrapped empty snapshot (confirming the bootstrap-from-nothing case genuinely works, not assumed from Phase 2.3's original scope) — both passed. That same smoke test caught a real bug before it shipped: every other mutation producer in this codebase omits `id` on a genuine create and lets it be assigned later at actual apply time, safe because their deltas never need one create referenced by another mutation in the same batch — writeup-import breaks that assumption (a new entity + an edge to it, in one proposal), so leaving create ids unassigned meant the entity and the edge referencing it got assigned different ids independently at apply time, leaving the edge dangling and causing `importGraph` to spawn a phantom stub entity named after the stale id string. Fixed by having `previewWriteupImport` pre-assign and commit to real, final ids for every entity it creates, reused consistently by that entity's own upsert and any edge referencing it — regression-tested at both the unit and real-API smoke-test level. A self-review remediation pass found no other issues (data-dir isolation and no-premature-persistence were both checked and clean); it did add a short Phase 5 section to `wf-mcp-server/README.md`'s tool table. |
| 6 | Dedicated web review UI | Yes | **Done** — tasks 6.1–6.6 built and tested per `plans/phase-6-tasks.md`; design followed from `plans/phase-6-review.md` as written, no redesign. Prep (not its own numbered task, but real work found necessary before 6.1): `wf-mcp-server/index.mjs`'s wf_accept/wf_reject/wf_regenerate/wf_sync_to_foundry/wf_rollback_batch/wf_review_batch handlers carried real orchestration logic inline — extracted verbatim into new `wf-mcp-server/lib/mutation-ops.mjs` (`acceptOp`/`rejectOp`/`regenerateOp`/`narrateOp`/`syncOp`/`rollbackOp`/`reviewGrainOp` plus the dual-path-apply/id-write-back/scope-resolution helpers) and `wf-mcp-server/lib/resolve.mjs`, so review-ui reuses the EXACT code wf-mcp-server's tools call rather than re-deriving it — confirmed byte-identical behavior by rerunning wf-mcp-server's full test suite unchanged after the extraction. Also generalized accept/reject's review-marking from "batch scope never reviewed, region/entity scope always reviewed" to an explicit per-mutation `reviewedMutationIds` split (`acceptMutationIds`/`rejectMutationIds`), needed because review-ui's checkbox multi-select can genuinely mix individually-expanded and merely-bulk-selected mutations in one call — `acceptOp`/`rejectOp` are unchanged-behavior wrappers over these. Task 6.1 built `review-ui/server.mjs` (bare `node:http`, no framework, zero dependencies of its own — documented reasoning in the file) with routes for listing/detail/accept/reject/bulk-accept/bulk-reject/regenerate/narrate/sync/rollback/unreviewed-entities/pending-entities/resolve, all calling straight into `mutation-ops.mjs` and the existing library modules; a 14-case deterministic route suite (`review-ui/test/routes.test.mjs`) plus a real-API smoke test (`review-ui/test/routes-live.smoke.mjs`, run against the live Anthropic API and passed) cover every route including both narration-gate failure cases and the actual narrate/resolve-pending success paths. Tasks 6.2–6.6 built the vanilla HTML/CSS/JS frontend (`review-ui/public/`) exactly per the design doc: hash-routed single shell, four sections, sticky Accept/Reject/Select-All-Boring bar, two-column diff tables, regenerate-with-note inline, the amber accumulation-flag treatment, Deferred Debt search-and-resolve-in-place (reusing the same diff renderer, not a second one), Settings sync-status/rollback/graph-stub, an 8s undo toast, and j/k/space/Enter keyboard triage. **Real visual verification was actually performed**, not just reasoned from source: no interactive `claude-in-chrome` browser was available in this execution environment (no live user-facing Chrome instance), so a real headless Chromium was driven instead via Playwright already installed in the sibling `foundry_worldFabric` project's `node_modules` (read-only use, nothing in that repo touched) against a real running instance of `review-ui/server.mjs` pointed at hand-built fixture worlds, with actual screenshots captured and inspected. This caught a real bug no test or code-read had caught: the in-place refresh after accept/reject/regenerate/narrate was rebuilding every row from scratch and collapsing all `<details>`, including the one just acted on, so narration/regenerate results never stayed visible — fixed with an explicit open-row-preservation pass (`currentlyOpenMutationIds`/`openEntityIdHint`). Screenshots confirmed, in both light and dark mode, that the narration card (serif, parchment/warm-dark-brown tint) is visually distinct from the rationale card (sans-serif, plain neutral) at a glance, that the amber accumulation-flag border/dot/note render correctly, that keyboard j/k/space/Enter and Select-All-Boring behave correctly against real mixed-importance data, and that Deferred Debt's resolve-in-place produces a real LLM-synthesized diff. A self-review remediation pass (per the task file's own instruction to specifically re-check narration-gating and the accept-vs-review distinction) found and fixed one real gap: `acceptMutationIds`/`rejectMutationIds`'s documented default (an omitted `reviewedMutationIds` counts everything as reviewed — correct for `acceptOp`/`rejectOp`'s always-explicit callers) was passed through unchanged at review-ui's bulk-accept/bulk-reject HTTP boundary, where the safe default should be the opposite (nothing reviewed unless explicitly listed) — fixed at the route layer (not by changing the shared library default, which remains correct for its existing callers) and covered by a new regression test. One noted, deliberate design-doc reconciliation: the doc describes narration as appearing per-row, replacing "that row's action bar," but the actual backend (`narrate.mjs`) narrates a whole BATCH in one call, not one mutation — resolved by fetching the batch-level prose once and rendering it into every accepted row's own action area, satisfying the doc's visual/adjacency description without conflicting with the real API shape; documented inline in `app.js`. |
| 7 | Foundry-optional visual graph editor | Yes | Deferred |
| 8 | Rubber-duck creative mode | Yes | **Done** — tasks 8.1–8.5 built and tested per `plans/phase-8-tasks.md`; design followed from `plans/phase-8-review.md` as written, no redesign needed. Task 8.1: `proposeFramingsFromWriteup` (`graph-import/writeup-import.mjs`, new `prompts/writeup-framing.md`) turns a writeup into 3 cheap one-sentence interpretive framings, deliberately cheap by construction (`DEFAULT_FRAMING_MODEL = "claude-haiku-4-5"`, distinct from `DEFAULT_WRITEUP_IMPORT_MODEL`'s `claude-sonnet-5`; small `maxTokens`; retry-once-then-typed `FramingProposalError`) — a real API smoke test measured it at ~5-25s versus Phase 3's ~51-59s p50 extraction baseline and confirmed the three framings are genuinely distinct readings (as low as 9% pairwise word overlap in one run), not near-duplicate paraphrases. Task 8.2: the reject-loop's decisive design — `composeFramingNote`/`recordFramingRound`/`requestReframing`/`resolveRejectLoop`, all pure and unit-tested independent of any HTTP/MCP transport — implements the three distinct paths exactly as the design doc resolved them: an explicit note resolves straight to `{kind:'regenerate'}` (skips the framing loop entirely, reuses the existing `regenerateWriteupImport` unchanged); a quick-pick reason resolves to `{kind:'reframe'}`, informed by *why* the prior round didn't land, bounded to one round via `batch.scope.framingHistory.length` (a second plain reject throws `FramingRoundLimitError`). Task 8.3: `mutation-engine/user-settings.mjs` follows `human-review.mjs`'s exact flat-JSON/env-override/`withLock` convention for a single global `{rubberDuckMode:{enabled,updatedAt}}` toggle. Task 8.4 (`wf-mcp-server/lib/mutation-ops.mjs`, shared by both front-ends): `proposeFromWriteupOp` reads `getUserSettings()` **exactly once**, at submission time — off-mode is a byte-identical pass-through to Phase 5's `importWriteup` (confirmed: Phase 5's own `writeup-import-roundtrip.smoke.mjs` re-run completely unchanged still passes); on-mode returns phase-A framings with no batch created yet. `selectFramingForNewBatch`/`selectFramingForExistingBatch` (phase B) create or replace a batch's mutations and record the completed round onto `batch.scope.framingHistory`; `rejectWithLoopOp` is `wf_reject`'s new dispatch, a byte-identical pass-through to the old `rejectOp` for any batch that isn't a rubber-duck writeup-import batch at scope='batch'/'region'. New MCP tools `wf_select_framing`, `wf_get_rubber_duck_mode`, `wf_set_rubber_duck_mode`; `wf_reject` gained optional `note`/`quickPickReason` params. review-ui gained matching routes (`/api/settings/rubber-duck`, `/api/writeup-propose`, `/api/writeup-select-framing`) and its `/reject` route now dispatches through the same `rejectWithLoopOp`. A real, API-backed MCP-protocol smoke test (`wf-mcp-server/test/rubber-duck-writeup.smoke.mjs`) ran all 5 required scenarios in one pass against the live Anthropic API: rubber-duck OFF unchanged, rubber-duck ON full happy path, plain-reject-loops-to-new-framings, a second plain reject refused once the bounded budget is spent, and an explicit-note reject skipping straight to regenerate even past that exhausted budget. Task 8.5: a genuinely new review-ui frontend surface — a "New Import" paste-a-writeup screen (review-ui had none before Phase 8; writeup import was MCP-tool-only through Phase 6), a "First Reactions" framing-selection screen (three radio cards + blend line, reusing Phase 6's existing card/button visual language), a reject-loop quick-pick panel on Batch Review (renders only when the *batch's own* stamped `scope.rubberDuck.enabled` is true, never the live setting), and a Settings toggle. **Actually visually verified**, not assumed from source: no interactive browser was available in this environment (confirmed via tool search finding no `claude-in-chrome` MCP tools, same as Phase 6), so real headless Chromium was driven via Playwright borrowed read-only from the sibling `foundry_worldFabric` project's `node_modules` against a real running `review-ui/server.mjs`; a real, API-backed click-through drove the entire flow end-to-end (enable rubber-duck mode → submit a writeup → 3 real distinct framing cards → pick with a blend line → a real 26-mutation batch → expand the reject panel → plain-reject into a real second framing round → complete it → hit the real round-limit message on a third attempt → reject-with-note past that limit → disable rubber-duck mode and confirm the reject panel is completely absent on a normal-mode batch), 15 screenshots captured and inspected plus 2 more confirming dark-mode contrast, no bugs found. A self-review remediation pass (checking, per the task file's own instruction, specifically rubber-duck-off byte-identity, the round bound actually being enforced, and `batch.scope.rubberDuck` never being re-read live) found and fixed one real gap: `selectFramingForExistingBatch` had no bound check of its own — only `requestReframing`'s pre-flight check (gating *new* framing calls) enforced `MAX_FRAMING_ROUNDS`, so a caller invoking `wf_select_framing`/`writeup-select-framing` directly with a stale or reused `framings` array (bypassing `wf_reject` entirely) could have pushed `framingHistory` past the bound purely by committing rounds, never by requesting new ones — fixed by adding an independent, defense-in-depth bound check at the commit step too, covered by a new regression test. One deliberate, documented scope decision: the reject-loop applies only at scope='batch'/'region' (mirroring `regenerateWriteupImport`'s own established whole-batch-only design and the fact that a writeup-import batch always has exactly one region) — a scope='entity' reject, even on a rubber-duck batch, stays a normal unlooped reject, since discarding one extracted item isn't "I don't like this whole first pass." No `SCHEMA_VERSION` bump was needed (unlike Phase 5's `SourceKind` addition): `Batch.scope` was already a fully open `z.record(z.string(), z.any())`, so `rubberDuck`/`framingHistory` are purely additive untyped metadata that need no schema change — a deliberate, documented judgment call per task 8.2's own "your call" instruction. Full test suite (root + `wf-mcp-server` + `review-ui`, 20+ suites) passes throughout. |
| 9 | **Deterministic structural mutations** (flagged, not scoped) — extend `propagate.mjs`'s non-LLM mechanisms so certain node types can add new connections or change location/containment programmatically (e.g. "item X sold" deterministically re-parenting a containment edge from seller to buyer), rather than requiring an LLM call to decide it. Surfaced by a real gap found while discussing containment: `texture.mjs`'s prompt currently only lets the model set descriptive fields (`relationshipType`/`label`/`strength`/`valence`/`notes`) on an *existing* entity/edge — it has no vocabulary for creating a new edge with explicit endpoints or reassigning one, so "the amulet moves from store to buyer" isn't representable today even via an explicit GM-authored seed. Keeping this in the non-LLM layer (like `ambientDecay`/`propagateSeed` already are) would mean zero added cost for structural reassignment — only the narrative texturing around it costs anything, same split as everything else in `propagate.mjs`. | Yes | **Flagged, deliberately not scoped into a task plan yet** — no design work done beyond naming the gap. |

The old steps 5–9 (Claude Code skills, `/code-review ultra`, map prompts, map sourcing, resuming the one-shot) are not deleted as *ideas* — Claude Code skills (Tool 5) remain a real, still-valid mechanism for the content-generation templates it always described (NPC cards, scene briefs); the maps workflow and one-shot resumption remain valid future work — they're just no longer positioned as sequential steps 5–9 of one linear build. Pick them up whenever it makes sense against the phase table above, not in forced numeric order.

---

## Tests (for steps 3–4)

- **BFS algorithm:** Given a mock WFI graph, confirm blast radius output at distances 1/2/3 with correct edge-weight severity scoring
- **Mutation schema validation:** LLM Call 1 output conforms to WF schema before `apply-mutations` runs; malformed output is rejected before write
- **Doom clock counter:** Counter increments correctly, threshold fires penultimate event, bidirectional trigger works
- **WFI seed import:** Campaign seed imports cleanly into World Fabric in merge mode, entity/edge counts correct
- **Session walkthrough:** Opening scripted event + first dynamic event produces expected graph state delta

---

## Folder Structure (Target)

```
/home/russell/
  GM_Tools/
    PLAN.md                    ← this file
    wf-mcp-server/             ← Tool 3: World Fabric MCP server
    session-runner/            ← Tool 4: parameterizable session runner
      burn-algorithm.mjs
      apply-mutations.mjs
      session-runner.mjs
      prompt-mutation.md
      prompt-scene.md
  campaign/                    ← pinned one-shot (Merrath / Threadbare City)
  foundry_worldFabric/         ← existing module (Graph Push sprint goes here)
```

---

## Pinned One-Shot Reference

All design decisions for "The Threadbare City" (Merrath) are at:
- **Plan:** `/home/russell/.claude/plans/ok-i-used-a-valiant-robin.md`
- **Content:** `/home/russell/campaign/`

Resume one-shot work at Step 9 above. The one-shot will use this stack as its backend. The campaign folder provides:
- Session config for the parameterizable runner (Merrath-specific event pool, doom clock threshold 7)
- WFI seed (Merrath spatial graph + NPCs + threads)
- Scripted bookend narrations (T-1 tutorial, penultimate Vane burn, G-1 fork)
- 5 character sheets (level 8, encounter math at `campaign/characters/encounter-math.md`)
