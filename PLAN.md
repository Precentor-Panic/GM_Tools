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
    "edgeWeights": { "causal": 1.0, "fealty": 0.9, "kinship": 0.85, "membership": 0.7, "ownership": 0.6, "location": 0.55, "knowledge": 0.5, "social": 0.4, "unspecified": 0.3 },
    "textureModel": "claude-sonnet-5",
    "textureModelOverride": "claude-opus-4-8",
    "sceneModel": "claude-sonnet-5"
  }
}
```
*(`edgeWeights` now covers all of World Fabric's `RELATIONSHIP_TYPES` — the propagation engine in `mutation-engine/propagate.mjs` needs a weight for every type it might encounter. `mutationModel`/`sceneModel` renamed `textureModel`/`sceneModel` to match the phased plan below: the mutation/texturing pass is now the propagation engine's batched LLM call, not a monolithic session-runner call.)*

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
| 1 | Mutation engine core: schema, propagation pass, review-state, diff, grain, rollback, batched texturing, conversational MCP review tools | Partially (infra) | **Next up — see `plans/phase-1-tasks.md`** |
| 2/2b | Time-skip mode + headless (Foundry-optional) apply — the MVP wedge | Yes | Depends on Phase 1 — see `plans/phase-2-tasks.md` |
| 3 | Live on-demand diff mode | Yes | Depends on Phase 1; stretch goal alongside 1–2 |
| 4 | Rollback hardening + unreviewed-accumulation tracking | Yes | Deferred |
| 5 | Import-from-writeup | Yes | Deferred |
| 6 | Dedicated web review UI | Yes | **Deferred by explicit choice** — design retained (see Tool 3/mutation-engine notes above), Russell's near-term workflow is conversational/JSON |
| 7 | Foundry-optional visual graph editor | Yes | Deferred |
| 8 | Rubber-duck creative mode | Yes | Deferred |

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
