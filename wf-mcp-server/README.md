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

No test suite yet — smoke-tested manually against the live `wf-test` world
snapshot during initial build (read tools returned real data; write tool
correctly reported `"queued"` with no Foundry client attached, and did not
silently swallow the failure).
