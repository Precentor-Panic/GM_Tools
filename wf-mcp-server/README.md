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
| `wf_sync_to_foundry` | Write accepted mutations to the Foundry file bridge (same `wf_apply_mutations` mechanism); falls back to `graph-import/headless-apply.mjs` if no Foundry client has the world open, always reports which path was used (`path`: `'live'`\|`'headless'`). A headless-applied create's assigned id is written back onto the batch (`idAssignments`) so `wf_rollback_batch` can later target it (Phase 4 task 4.1). |
| `wf_rollback_batch` | Restore a batch's accepted mutations to their captured pre-accept state. Same live-then-headless-fallback behavior as `wf_sync_to_foundry` (Phase 4 task 4.1 — it previously had no headless fallback at all, so rollback could never actually apply against a headless-only campaign). Phase-1 scope: most-recently-accepted batch only (pass its id explicitly) — no multi-batch version history yet. Not in the original 6-tool task-1.8 table; added because the Definition of Done explicitly requires exercising rollback conversationally, and there was otherwise no MCP surface for it. |

### Phase 3 — scene narration

| Tool | Purpose |
|------|---------|
| `wf_narrate_batch` | Player-facing scene/consequence narration (`mutation-engine/narrate.mjs`) for a batch — the second LLM call from `PLAN.md`'s original two-call pattern (mutation call, then narration call), distinct from `rationale`'s reviewer-facing text. Hard-gated to batches where every mutation is `status:'accepted'` — refuses with a typed error (listing which mutations aren't) rather than partially narrating. Pass `note` to regenerate with steering guidance; this never touches mutation-acceptance status. Same `ANTHROPIC_API_KEY` requirement as `wf_propose_mutations`. |

### Phase 4 task 4.2 — unreviewed-accumulation tracking

Thin wrapper over `../mutation-engine/human-review.mjs`. `wf_accept`/`wf_reject`/`wf_regenerate` (scope `region`/`entity`) and `wf_review_batch` (grain `region`/`entity`) all update `lastHumanReviewedAt` for the entities they touch; scope/grain `batch`/`headline` deliberately never does — see each tool's own description above for the exact rule per action.

| Tool | Purpose |
|------|---------|
| `wf_get_unreviewed_entities` | Entities whose applied-but-unreviewed history has gone too long: never reviewed, stale (`maxAgeDays`, default 14), or accumulated too many batch-accept-all touches since the last real review (`maxUnreviewedAccepts`, default 5). The same flagged set forces a flagged entity into `wf_review_batch`'s headline rendering regardless of importance. |

### Phase 5 — import-from-writeup

Thin wrapper over `../graph-import/writeup-import.mjs`. Produces a normal review batch
(`sourceKind: 'writeup-import'`) — `wf_review_batch`/`wf_accept`/`wf_reject`/
`wf_sync_to_foundry`/`wf_rollback_batch` above all handle it unmodified, since they're
already generic over batch shape.

| Tool | Purpose |
|------|---------|
| `wf_propose_from_writeup` | Given freeform text (a pitch, prep notes, a wiki export), one LLM call extracts a WFI-shaped proposal (entities/edges referencing endpoints by name), dry-runs it through `interchange.mjs`'s `importGraph` against the live snapshot without persisting (existing name+type dedup: a mentioned entity that already exists in the graph merges as an UPDATE instead of duplicating; an undescribed edge endpoint gets a stub, same as any other WFI import), and writes the result as a review batch. Works against a freshly-bootstrapped empty snapshot (a brand-new campaign) as well as an existing populated one. Same `ANTHROPIC_API_KEY` requirement as `wf_propose_mutations`. |

`wf_regenerate` dispatches specially for a writeup-import batch: it re-invokes the
extraction against the batch's own recorded source text plus the steering note (not
`texture.mjs`'s per-region texturing, which has no meaning for a holistic
text-extraction pass) — see that tool's own description. `scope='entity'` is refused
for a writeup-import batch (there's no principled way to regenerate one extracted item
out of a whole-document pass); use `scope='batch'`/`'region'` (equivalent — a
writeup-import batch always has exactly one region) or reject the specific mutation via
`wf_reject`.

## MCP wave — Session Planner / Library / Chronicle tools

Agents could already work the graph/review/prep/writeup surface above but had
no access to the Session Planner (scenes/plans/elements/tray), the Library
(bestiary/party/items/stagecraft), or the Chronicle (clock/fortune/intents/
runs). This wave closes that gap. Every tool below reuses the SAME store/lib
module `review-ui/server.mjs`'s matching HTTP route calls — mirrored, not
forked. See `wf-mcp-server/lib/chronicle-ops.mjs` and `lib/planner-ops.mjs`
for the two pieces of route-composition logic extracted into a shared module
so both front-ends run the exact same code.

**Multi-world safety**: every tool in this wave requires `world` explicitly
in its schema (not `.optional()`) — it will not silently fall back to
`WF_DEFAULT_WORLD` even if that env var happens to be set. Run
`wf_list_worlds` first if unsure which id to use. (Bestiary tools are the
one deliberate exception: bestiary-store.mjs is library-wide, not
world-scoped — no `world` parameter exists on those at all, mirroring
`GET /api/combat-planning/bestiary`'s own convention.)

### Session Planner — reads

| Tool | Purpose |
|------|---------|
| `wf_list_plans` | Every Plan for a world |
| `wf_get_plan` | One Plan by id |
| `wf_list_scenes` | Every Scene (`recency:true` for most-recently-touched-first) |
| `wf_get_scene` | One Scene, composed: record + elements + tray + narration in one call |
| `wf_get_scene_elements` | A Scene's ordered elements |

### Session Planner — direct working-state mutations (no review gate, like the UI)

| Tool | Purpose |
|------|---------|
| `wf_create_plan` / `wf_rename_plan` / `wf_add_scene_to_plan` / `wf_reorder_plan` | Plan CRUD |
| `wf_create_scene` / `wf_update_scene` | Scene CRUD — `locationEntityId` must resolve to a `place`-type entity if it resolves to anything |
| `wf_add_scene_element` / `wf_update_scene_element` | Scene element CRUD, incl. `stat` (shallow-merges on update) |
| `wf_tray_drop` / `wf_tray_remove` / `wf_set_xp_budget` | Scene tray roster + XP budget — a creature drop's first occurrence creates a stat-carrying element, a repeat only stacks the roster |

### Library — reads

| Tool | Purpose |
|------|---------|
| `wf_list_bestiary` (no `world`) / `wf_get_bestiary_entry` (no `world`) | The library-wide bestiary shelf, with client-side `status`/`source` filters |
| `wf_list_party` | A world's party roster |
| `wf_list_items` | A world's Reliquary items |
| `wf_list_stagecraft` | A world's Stagecraft assets — includes `compendiumRef` browse rows and `catalogRef` catalog rows, not just already-accepted assets, so an agent suggesting maps sees the whole catalog |

### Library — hand-authoring (accepted immediately, no LLM call, no review gate)

| Tool | Purpose |
|------|---------|
| `wf_add_bestiary_entry` (no `world`) | Mirrors `POST /api/combat-planning/bestiary/hand-add` |
| `wf_add_party_member` | Mirrors `POST /api/combat-planning/party-roster/hand-add` |
| `wf_add_item` | Mirrors `POST /api/combat-planning/items/hand-add` |
| `wf_add_stagecraft_asset` | Mirrors `POST /api/session-planner/stagecraft/hand-add` |

### Chronicle — reads

| Tool | Purpose |
|------|---------|
| `wf_get_world_clock` | Current in-fiction date/session number |
| `wf_get_fortune` | Current Fortune Track stop/bias |
| `wf_list_chronicle_log` | Every Chronicle-run batch, newest-first, with headline + span/fortuneAtRun/promptSummary |
| `wf_list_pending_intents` | Queued/deferred intents (pending-ledger backlog) available to carry into the next run |

### Chronicle — mutations

| Tool | Purpose |
|------|---------|
| `wf_chronicle_run` | **THROUGH THE REVIEW GATE** (creates a batch, `wf_accept`/`wf_reject` still required). Mirrors `POST /api/chronicle/run` exactly: the single-source `elapsedSessions` rule (the world clock advances exactly once, from `span` only) and prompt-as-seed (a typed `prompt` always earns ≥1 reviewable proposal). |
| `wf_queue_intent` | Direct write, no review gate — queues a thread for a *future* `wf_chronicle_run` to resolve; doesn't itself touch the graph. Pinned `sourceBatchId:"manual"` sentinel. |
| `wf_set_fortune` | Direct write, no review gate — biases the next `wf_chronicle_run`'s texturing pass. |

**Reconciled, not duplicated**: prose intake ("writeup text → graph proposal,
both rubber-duck phases") is `wf_propose_from_writeup` (above) — already
returns a framing phase when rubber-duck mode is on, and `wf_select_framing`
(above) is already its pick companion. No `wf_receive_information` tool was
added; nothing was missing.

## Keyless / offline safety

Every LLM-backed tool in this server (both pre-existing and new) now goes
through `lib/offline-clients.mjs`'s shared `offlineOpts()` — the SAME
degrade `review-ui/server.mjs`'s HTTP routes have used since the QA
fix-wave. With no `ANTHROPIC_API_KEY` set in **this server process's own
environment**, an LLM-backed call degrades to an honest, clearly-labelled
placeholder response (a real, reviewable batch/framing/prep-content draft)
instead of failing on the raw Anthropic SDK's own construction-time "Could
not resolve authentication method" error. `test/keyless-offline-safety.test.mjs`
is the automated proof — it spawns the real server with no key and drives
every LLM-backed tool through a real call, asserting none of them ever
produce that error signature. (This corrects a gap found during the MCP
wave: unlike the HTTP routes, these tools previously called straight into
their library functions with NO offline opts at all — a genuinely real,
reproducible failure mode for a keyless MCP session, not a hypothetical.)

## Config

Set in `~/.mcp.json` under `mcpServers.world-fabric` (see `.mcp.json.example`
at the repo root for a ready-to-copy starting point). Env vars:

- `WF_DATA_DIR` — Foundry data directory (the one containing `worlds/`). On
  this machine: `/home/russell/foundrydata/Data`. Falls back to OS-typical
  install paths if unset, but auto-detection has been unreliable across
  native/Docker installs — set it explicitly.
- `WF_DEFAULT_WORLD` — optional, and NOT recommended if you run more than
  one world/campaign (Russell does — an ongoing campaign plus a separate
  one-shot). If unset, every tool call must pass `world` explicitly; every
  tool added in the MCP wave above requires it explicitly regardless of
  whether this is set.
- `ANTHROPIC_API_KEY` — optional. Needed only for a real (non-placeholder)
  LLM-backed call. See "Keyless / offline safety" above — every tool works
  without it, just with honest placeholder content instead of real model
  output.

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
