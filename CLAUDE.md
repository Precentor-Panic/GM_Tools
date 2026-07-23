# GM Tools — Orientation

Read this first. It's the front door — point a fresh session at `GM_Tools/` and this file plus the two it links to should be enough to pick the work back up with no other context.

## What this is

A reusable stack for LLM-assisted TTRPG session design and live play, built on top of **World Fabric** (`/home/russell/foundry_worldFabric`, a Foundry VTT module that stores campaign lore as a knowledge graph). Generalized from "The Threadbare City" one-shot, but not tied to it or to D&D.

**The core pattern, everything else is built around this:**
```
event fires at a graph node
  → BFS outward: (node_id, distance, path_edge_type)[]        [code, not LLM]
  → LLM call [mutation]: event semantics × blast radius → structured graph mutations
  → apply mutations to graph                                   [code, not LLM]
  → LLM call [scene]: updated subgraph snapshot → scene/consequence description
```
Full LLM-vs-code task breakdown is in `PLAN.md`.

## Current status — always check `PLAN.md` § Build Sequence for the live table

Don't trust a summary of status here or in memory over that table; it's the thing kept current. As of the last update: **Graph Push** (bulk push WF entities → Foundry docs) and the **WF MCP server** are built. The generic Foundry actor/scene MCP is configured but needs approval. The linear "session runner" concept from the original plan has been superseded by a phased toolbox approach — see `PLAN.md` § Build Sequence and `plans/phase-1-tasks.md` for current status; Phase 1 (mutation engine core) is next up.

Engineering conventions for writing code in this repo live in `.claude/skills/gm-tools-conventions/` — load it before touching `mutation-engine/`, `time-skip/`, `graph-import/`, or `wf-mcp-server/`.

## Key architectural fact to internalize immediately

`GraphService`, World Fabric's graph store, only runs **inside the Foundry browser session** — it depends on `game.settings`. Nothing outside Foundry (this stack included) can call it directly. World Fabric bridges this with files in the world's data folder:

- `world-fabric-snapshot.json` — auto-exported on every graph write, readable by anything
- `world-fabric-mutations.json` — write here, the in-Foundry mutation watcher polls every 5s, applies, clears to `[]`

Every tool in this stack that touches the graph (the MCP server, and the session runner once built) goes through this file bridge, not through Foundry's API. **Mutations only apply while a Foundry client has the target world open.**

## Where things are

| Path | What |
|------|------|
| `PLAN.md` | The durable plan — architecture, all 5 tools, build sequence with live status, maps workflow, test list |
| `wf-mcp-server/` | Built. MCP server exposing the graph (query + mutate) as Claude tools. See its own `README.md` for the tool list and config. Registered in `~/.mcp.json` as `world-fabric`. |
| `session-runner/` | Not built yet. Next up per the build sequence. |
| `/home/russell/foundry_worldFabric` | The World Fabric module itself (separate project, own memory/history — entity/edge schema, GraphService, cockpit UI). Read its `CLAUDE.md`/memory if you need module internals, not just the bridge. |
| `/home/russell/campaign` | The pinned Threadbare City / Merrath one-shot — a *consumer* of this stack, not part of it. Has its own hand-authored `dm-engine/` (a scripted precursor to the generalized session runner). **Different track** — don't pull one-shot-specific content work into GM_Tools sessions unless explicitly asked. |

## Config already in place

`~/.mcp.json` has both `foundryvtt` (generic actor/scene MCP, pending approval) and `world-fabric` (this stack's MCP server, `WF_DATA_DIR=/home/russell/foundrydata/Data`).
