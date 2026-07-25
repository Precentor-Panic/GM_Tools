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

Don't trust a summary of status here or in memory over that table; it's the thing kept current. As of the last update: **Graph Push** (bulk push WF entities → Foundry docs) and the **WF MCP server** are built. The generic Foundry actor/scene MCP is configured but needs approval. The linear "session runner" concept from the original plan has been superseded by a phased toolbox approach — see `PLAN.md` § Build Sequence and `plans/phase-1-tasks.md` for current status; **Phase 1 (mutation engine core) is done** (tasks 1.1–1.8; task 1.9's web UI stays deferred to Phase 6). **Phase 2/2b (time-skip mode + headless apply) is done** — `time-skip/`, `graph-import/` built and tested per `plans/phase-2-tasks.md`; the two real-API smoke tests (resumability cost-reduction, LLM-inferred seed resolution) are written but not executed — no `ANTHROPIC_API_KEY` in the build environment. **Phase 3 (live on-demand diff mode) is done** — the scene-narration LLM call (`mutation-engine/narrate.mjs`) is built, gated to accepted batches only, and wired as `wf_narrate_batch`; real latency measurement showed `wf_propose_mutations` is not reliably sub-5s live (p50 ~51-59s) regardless of BFS depth, so the MCP tool description now sets that expectation rather than the code pretending otherwise. See `plans/phase-3-tasks.md`. **Phase 3.5 (deferred/lazy consequence resolution) is done** — a new pending-resolution ledger (`mutation-engine/pending-ledger.mjs`) lets large time-skips (`wf_run_cycle`) eagerly texture only a per-cycle "headline" focus and defer everything else in scope as a cheap ledger tag, resolved later only on explicit request (`wf_resolve_pending`), with a fan-out cap bounding cost. See `plans/phase-3.5-tasks.md` and `PLAN.md`'s Phase 3.5 row for the full build summary. **Phase 4 (rollback hardening + unreviewed-accumulation tracking) is done** — the newly-created-entity rollback gap is closed for the headless path (`graph-import/headless-apply.mjs` now reports back assigned ids, written onto the batch by `wf_sync_to_foundry`), the live-Foundry path is confirmed unclosable from this side (documented, not left unexamined), and a new `mutation-engine/human-review.mjs` tracks per-entity `lastHumanReviewedAt` — updated only by genuine scoped review actions, never by a whole-batch accept-all — surfaced via the new `wf_get_unreviewed_entities` tool and forced into `wf_review_batch`'s headline rendering regardless of importance. See `plans/phase-4-tasks.md` and `PLAN.md`'s Phase 4 row for the full build summary. **Phase 5 (import-from-writeup) is done** — `graph-import/writeup-import.mjs` turns freeform text into a WFI-shaped proposal via one LLM call, dry-runs it through World Fabric's existing `importGraph` merge/dedup logic without persisting, and converts the result into a normal review batch (`wf_propose_from_writeup`) that goes through the exact same review/accept/sync pipeline as every other mutation batch. A real, API-backed round trip confirmed both the dedup-not-duplicate case (an existing entity merges instead of creating a second one) and the bootstrap-from-nothing case (a freshly-bootstrapped empty campaign). See `plans/phase-5-tasks.md` and `PLAN.md`'s Phase 5 row for the full build summary, including a real cross-mutation id-stability bug found and fixed via that same smoke test. **Phase 6 (dedicated web review UI) is done** — `review-ui/server.mjs` (a small, dependency-free `node:http` server) plus a vanilla HTML/CSS/JS frontend (`review-ui/public/`) give the project its first actual visual surface: a pending-work Queue, a Batch Review screen with per-mutation accept/reject/regenerate/narrate and the narration-vs-rationale visual distinction, a Deferred Debt tab, and Settings (sync status, one-shot rollback, a stubbed graph-browser link). `wf-mcp-server`'s review-workflow tool handlers were refactored (no behavior change, full test suite reconfirmed) into a new shared `wf-mcp-server/lib/mutation-ops.mjs` so review-ui reuses the exact same code instead of a second copy. Actually visually verified via a real headless-Chromium run (no interactive browser was available in this environment) — see `plans/phase-6-tasks.md` and `PLAN.md`'s Phase 6 row for the full build summary, including a real rendering bug found and fixed only because of that visual check.

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
