# World Fabric MCP Server

Exposes World Fabric's campaign graph to Claude as MCP tools, instead of the
manual `gm/wf-query.mjs | <llm> | gm/wf-apply.mjs` CLI pipe.

## How it works

`GraphService` (the graph store) only runs inside the Foundry browser
session — it depends on `game.settings`. This server never talks to Foundry
directly. It reads/writes the same file bridge the module already
maintains:

- **Read:** `worlds/<world>/world-fabric-snapshot.json` — re-exported by the
  module on every graph write (debounced ~600ms).
- **Write:** `worlds/<world>/world-fabric-mutations.json` — polled by the
  module's mutation watcher every 5s, applied, then cleared back to `[]`.

This means **mutations only apply while a Foundry client has the target
world open** with World Fabric active. `wf_apply_mutations` polls for ~7s
and reports `"status": "queued"` (not `"applied"`) if nobody picked it up —
that's not a bug, it means no live client is watching.

## Tools

| Tool | Purpose |
|------|---------|
| `wf_list_worlds` | Discover which worlds under the data dir have an active snapshot |
| `wf_get_context` | World Fabric's own pre-budgeted text serialization of the graph + system prompt |
| `wf_get_entity` | One entity (by ID or name) + its direct edges |
| `wf_get_adjacent` | BFS subgraph within N hops of an entity — the blast-radius primitive |
| `wf_get_entities_by_type` | All entities of a Layer-0 type |
| `wf_get_session_state` | Snapshot metadata (session number, counts, export time) — **not** doom-clock/thread state, that's Layer 2 (M13), not built yet |
| `wf_apply_mutations` | Write `upsert_entity` / `upsert_edge` / `delete_entity` / `delete_edge` / `upsert_type` mutations |

### Phase 1 — conversational mutation review tools

Thin wrappers over `../mutation-engine/` (see `mutation-engine/README.md`). All
persist to `GM_Tools/review-state/<world>/<batchId>.json`.

| Tool | Purpose |
|------|---------|
| `wf_propose_mutations` | Run propagation (seed BFS impact or ambient decay) + batched LLM texturing, write a new review batch. **Requires `ANTHROPIC_API_KEY` in this server process's own environment** — separate from any credential the calling Claude Code session uses, since the outbound call is made by this server, not by Claude Code. |
| `wf_review_batch` | Render a batch at `headline` / `region` / `entity` grain |
| `wf_accept` | Accept mutation(s) (`batch`\|`region`\|`entity` scope), capturing pre-state for rollback |
| `wf_reject` | Reject mutation(s), same scope semantics |
| `wf_regenerate` | Re-texture mutation(s) with a steering note; replaces, doesn't stack onto, the prior proposal for that scope. Same `ANTHROPIC_API_KEY` requirement as `wf_propose_mutations`. |
| `wf_sync_to_foundry` | Write accepted mutations to the Foundry file bridge (same `wf_apply_mutations` mechanism); reports `queued` if no Foundry client has the world open |
| `wf_rollback_batch` | Restore a batch's accepted mutations to their captured pre-accept state. Phase-1 scope: most-recently-accepted batch only (pass its id explicitly) — no multi-batch version history yet. Not in the original 6-tool task-1.8 table; added because the Definition of Done explicitly requires exercising rollback conversationally, and there was otherwise no MCP surface for it. |

## Config

Set in `~/.mcp.json` under `mcpServers.world-fabric`. Env vars:

- `WF_DATA_DIR` — Foundry data directory (the one containing `worlds/`). On
  this machine: `/home/russell/foundrydata/Data`. Falls back to OS-typical
  install paths if unset, but auto-detection has been unreliable across
  native/Docker installs — set it explicitly.
- `WF_DEFAULT_WORLD` — optional. If unset, every tool call must pass
  `world` explicitly (recommended, since multiple worlds/campaigns coexist
  on this machine).

## Local dev

```
npm install
node index.mjs        # starts stdio server, waits for a client
```

The original 7 read/write tools were smoke-tested manually against the live
`wf-test` world snapshot during initial build (read tools returned real
data; write tool correctly reported `"queued"` with no Foundry client
attached, and did not silently swallow the failure).

The Phase 1 mutation-review tools are covered two ways: `../test/*.test.mjs`
(`node --test` from the repo root) unit-tests the underlying
`mutation-engine/` library functions these tools wrap, and a manual
round-trip script (spawns this server via stdio with the real
`@modelcontextprotocol/sdk` client, against a realistic fixture snapshot)
verified `wf_propose_mutations` → `wf_review_batch` → `wf_accept`/`wf_reject`/
`wf_regenerate` → `wf_sync_to_foundry` → `wf_rollback_batch` end-to-end,
including that the two Anthropic-dependent tools (`wf_propose_mutations`,
`wf_regenerate`) fail honestly rather than crashing when `ANTHROPIC_API_KEY`
is unset. See the Phase 1 closing report for details.
