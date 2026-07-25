#!/usr/bin/env node
/**
 * World Fabric MCP server.
 *
 * Wraps the file-based bridge World Fabric already exports from inside
 * Foundry: world-fabric-snapshot.json (read, auto-refreshed on every graph
 * write) and world-fabric-mutations.json (write, picked up by the module's
 * mutation watcher within ~5s). See gm/wf-query.mjs and gm/wf-apply.mjs in
 * the foundry_worldFabric repo for the CLI precursor to this server.
 *
 * GraphService itself only runs inside the Foundry browser session (it
 * depends on `game.settings`), so this server never talks to Foundry
 * directly — it only reads/writes the snapshot and mutation files.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { listWorlds } from "./lib/data-dir.mjs";
import { loadSnapshot } from "./lib/snapshot.mjs";
import { neighborhood, edgesFor, findEntity, findEntityByName, findEdge } from "./lib/graph.mjs";
import { resolveWorld, resolveDir } from "./lib/resolve.mjs";

// Phase 3.5 task 3.5.2/3.5.3 — deferred/lazy consequence resolution:
// orchestrateCycle (headline-focus + backlog deferral, wrapped below as
// wf_run_cycle) and resolvePending (explicit, opt-in resolve of an
// accumulated backlog, wrapped below as wf_resolve_pending).
import { orchestrateCycle } from "../time-skip/run-cycle.mjs";
import { resolvePending } from "../time-skip/resolve-pending.mjs";

// Phase 2 task 2.0 — the propagate/scope-resolution and orchestration logic
// that used to be inlined in wf_propose_mutations's handler now lives in
// time-skip/ as reusable library code; this server just wires parameters
// through to it. See time-skip/scope.mjs, time-skip/run.mjs.
import { orchestrateBatch, attachDiffs } from "../time-skip/run.mjs";

// Phase 5 — import-from-writeup: propose a WFI-shaped document from freeform
// text (task 5.1), dry-run it through importGraph and convert the result into
// a normal review batch (task 5.2).
import { importWriteup } from "../graph-import/writeup-import.mjs";

// Phase 4 task 4.2 — unreviewed-accumulation tracking (read-only surface;
// the accept/reject-time bookkeeping itself lives in lib/mutation-ops.mjs now).
import { findUnreviewedEntities, DEFAULT_MAX_AGE_DAYS, DEFAULT_MAX_UNREVIEWED_ACCEPTS } from "../mutation-engine/human-review.mjs";

// Phase 6 — the actual review-workflow operations (accept/reject/regenerate/
// narrate/sync/rollback/review-grain) now live in lib/mutation-ops.mjs,
// shared verbatim with review-ui/server.mjs rather than kept as two
// independently-drifting copies. See that module's own doc comment.
import {
  applyMutationsToFoundry,
  reviewGrainOp,
  acceptOp,
  rejectOp,
  regenerateOp,
  narrateOp,
  syncOp,
  rollbackOp
} from "./lib/mutation-ops.mjs";

const server = new McpServer({ name: "world-fabric", version: "0.1.0" });

const worldParam = z.string().optional().describe(
  "World ID (Foundry world folder name). Defaults to WF_DEFAULT_WORLD env var if set. " +
  "Use wf_list_worlds to see what's available."
);
const dataDirParam = z.string().optional().describe(
  "Override the Foundry data directory. Defaults to WF_DATA_DIR env var, then OS-typical install paths."
);

function text(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorText(err) {
  return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
}

// --- wf_list_worlds ----------------------------------------------------------

server.registerTool(
  "wf_list_worlds",
  {
    title: "List worlds with an active World Fabric snapshot",
    description: "Lists Foundry world IDs under the data directory that have an exported world-fabric-snapshot.json.",
    inputSchema: { dataDir: dataDirParam }
  },
  async ({ dataDir }) => {
    try {
      const dir = resolveDir(dataDir);
      return text({ dataDir: dir, worlds: listWorlds(dir) });
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_get_context (pre-serialized LLM context, cheapest call) --------------

server.registerTool(
  "wf_get_context",
  {
    title: "Get the pre-serialized campaign context blob",
    description:
      "Returns World Fabric's own budgeted, token-bounded text serialization of the campaign graph, plus its " +
      "system prompt and session metadata. Cheapest way to get campaign-wide context without walking entities " +
      "yourself.",
    inputSchema: { world: worldParam, dataDir: dataDirParam }
  },
  async ({ world, dataDir }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const snap = loadSnapshot(dir, w);
      return text({ meta: snap.meta, systemPrompt: snap.systemPrompt, context: snap.context });
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_get_entity -------------------------------------------------------------

server.registerTool(
  "wf_get_entity",
  {
    title: "Get one entity by ID or name, with its direct edges",
    description: "Look up a single entity (person/place/faction/object/event/concept) and the edges touching it.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      entityId: z.string().optional().describe("Exact entity ID"),
      name: z.string().optional().describe("Entity name, case-insensitive, used if entityId is omitted")
    }
  },
  async ({ world, dataDir, entityId, name }) => {
    try {
      if (!entityId && !name) throw new Error("Provide entityId or name.");
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const { entities, edges } = loadSnapshot(dir, w).snapshot;
      const entity = entityId ? findEntity(entities, entityId) : findEntityByName(entities, name);
      if (!entity) throw new Error(`Entity not found: ${entityId ?? name}`);
      return text({ entity, edges: edgesFor(edges, entity.id) });
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_get_adjacent (BFS blast radius) ----------------------------------------

server.registerTool(
  "wf_get_adjacent",
  {
    title: "Get the BFS subgraph around an entity (blast radius)",
    description:
      "Returns all entities and edges reachable from the given entity within `depth` hops. This is the blast-radius " +
      "input for event-mutation reasoning: given an event epicenter, see what it can plausibly reach.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      entityId: z.string().optional(),
      name: z.string().optional().describe("Used if entityId is omitted"),
      depth: z.number().int().min(1).max(6).default(2)
    }
  },
  async ({ world, dataDir, entityId, name, depth }) => {
    try {
      if (!entityId && !name) throw new Error("Provide entityId or name.");
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const { entities, edges } = loadSnapshot(dir, w).snapshot;
      const root = entityId ? findEntity(entities, entityId) : findEntityByName(entities, name);
      if (!root) throw new Error(`Entity not found: ${entityId ?? name}`);
      return text(neighborhood(entities, edges, root.id, depth));
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_get_entities_by_type ----------------------------------------------------

server.registerTool(
  "wf_get_entities_by_type",
  {
    title: "List all entities of a given type",
    description: "Returns every entity of the given Layer-0 type (person, place, faction, object, event, concept).",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      type: z.enum(["person", "place", "faction", "object", "event", "concept"])
    }
  },
  async ({ world, dataDir, type }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const { entities } = loadSnapshot(dir, w).snapshot;
      return text(entities.filter((e) => e.type === type));
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_get_session_state -------------------------------------------------------

server.registerTool(
  "wf_get_session_state",
  {
    title: "Get current session/export metadata",
    description:
      "Returns the snapshot's session metadata (session number, entity/edge counts, last export time). " +
      "Note: World Fabric's session layer (doom clocks, thread status) is not yet built (Layer 2, M13) — " +
      "this only reflects Layer 1 world-canon export state, not live session bookkeeping.",
    inputSchema: { world: worldParam, dataDir: dataDirParam }
  },
  async ({ world, dataDir }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const snap = loadSnapshot(dir, w);
      return text(snap.meta);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_apply_mutations ----------------------------------------------------------

const mutationSchema = z.object({
  op: z.enum(["upsert_entity", "upsert_edge", "delete_entity", "delete_edge", "upsert_type", "upsert_relationship_type"]),
  id: z.string().optional(),
  data: z.record(z.string(), z.any()).optional()
});

// applyMutationsToFoundry/applyMutationsWithHeadlessFallback/
// writeBackIdAssignments now live in ./lib/mutation-ops.mjs (Phase 6),
// shared verbatim with review-ui/server.mjs — imported above.

server.registerTool(
  "wf_apply_mutations",
  {
    title: "Write graph mutations for World Fabric to apply",
    description:
      "Writes a mutations array to world-fabric-mutations.json. World Fabric's in-Foundry mutation watcher polls " +
      "every 5s, applies them (upsert/delete entity or edge), and clears the file. Requires a Foundry client to " +
      "have that world open and the module active — this tool cannot apply mutations if nobody has the world loaded. " +
      "Polls briefly to report whether the mutation was picked up.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      mutations: z.array(mutationSchema).min(1)
    }
  },
  async ({ world, dataDir, mutations }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const result = await applyMutationsToFoundry(dir, w, mutations);
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// ======================================================================================
// Phase 1 — conversational review MCP tools (mutation engine surface)
//
// Each tool below is a thin wrapper calling straight into mutation-engine/'s
// library functions — see plans/phase-1-tasks.md task 1.8. No independent
// business logic lives here beyond parameter wiring, scope resolution, and
// status-text formatting.
// ======================================================================================

// resolveMutationIds/entityIdsForMutations/flaggedEntityIdSet/nextMutationIndex
// now live in ./lib/mutation-ops.mjs (Phase 6), imported above and reused
// verbatim inside that module's own acceptOp/rejectOp/regenerateOp/
// reviewGrainOp — nothing left to wire here beyond parameter passthrough.

const proposeScopeSchema = z.object({
  mode: z.enum(["seed", "ambient", "tag", "region", "contained-in"]),
  anchorId: z.string().optional().describe(
    "Entity ID to propagate impact from (mode='seed', required unless seeds[] is given) or to scope the " +
    "traversal from (mode='region'/'contained-in', required)."
  ),
  depth: z.number().int().min(1).max(1000).optional().describe(
    "Max BFS hops. mode='seed': default 3. mode='region': default 2 (an intentionally shallow proximity " +
    "radius). mode='contained-in': default effectively-unbounded (1000) — a district -> building -> room " +
    "chain is the multi-hop case this mode exists for."
  ),
  tag: z.string().optional().describe("Tag to scope an ambient-decay pass to (mode='tag')."),
  elapsedSessions: z.number().min(0).optional().describe(
    "Sessions elapsed, for the ambient-decay half-life calculation " +
    "(mode='ambient'/'tag'/'region'/'contained-in' when no seeds are given). Default 1."
  )
});

// --- wf_propose_mutations ----------------------------------------------------------

server.registerTool(
  "wf_propose_mutations",
  {
    title: "Propose a batch of graph mutations (propagate + texture + create batch)",
    description:
      "Runs the deterministic propagation pass (time-skip/scope.mjs: seed-based BFS impact for mode='seed', " +
      "ambient time-decay for mode='ambient', decay filtered to a tag for mode='tag', all-types BFS proximity " +
      "for mode='region' [a GM time-skipping one area/faction without touching the rest of the graph], and " +
      "containment-edges-only reachability for mode='contained-in' [\"what's structurally inside this place " +
      "right now\" — district/building/room chains; never follows origin or presence edges]) to find candidate " +
      "changes, then makes one Anthropic API call per affected region (never one per entity) to texture them " +
      "into concrete mutations with rationale, then writes a new review batch to review-state/. Returns batchId " +
      "+ a headline summary — call wf_review_batch next to drill in. Requires ANTHROPIC_API_KEY to be set in " +
      "THIS server process's environment for the texturing call — separate from any credential the calling " +
      "Claude Code session uses, since this call is outbound from the MCP server itself. LATENCY (measured, " +
      "Phase 3 task 3.1, 5 real timed runs each at depth=2 and depth=3, mode='seed' against a 50-entity/129-edge " +
      "fixture whose 15-17 texture-eligible entities land in a single connected region): depth=3 min=34.4s " +
      "p50=59.0s p90=59.9s max=59.9s; depth=2 min=26.1s p50=51.4s p90=62.5s max=62.5s. Depth barely moves this " +
      "— the real cost driver is texture-eligible entity count within ONE affected region (-> output token count " +
      "for that single API call), not raw BFS hop count. This is NOT reliably sub-5s live for a moderately-" +
      "connected anchor. A calling Claude Code session should say something like 'resolving, one moment' to the " +
      "user BEFORE invoking this tool for a 'seed' proposal, rather than letting the call appear to hang " +
      "silently for up to a minute.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      scope: proposeScopeSchema,
      elapsedTimeDescriptor: z.string().optional().describe(
        "Human-readable descriptor stored on the batch, e.g. '2 sessions' or 'a few hours'."
      ),
      seeds: z
        .array(z.object({ entityId: z.string(), magnitude: z.number().min(0).max(1) }))
        .optional()
        .describe(
          "Multiple simultaneous seed epicenters (mode='seed' only). If omitted, scope.anchorId with " +
          "magnitude 1.0 is used as a single seed. Results from multiple seeds are merged, keeping the " +
          "strongest impact reaching each entity."
        )
    }
  },
  async ({ world, dataDir, scope, elapsedTimeDescriptor, seeds }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const { entities, edges } = loadSnapshot(dir, w).snapshot;
      const result = await orchestrateBatch(w, scope, elapsedTimeDescriptor, { entities, edges, seeds });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_propose_from_writeup -------------------------------------------------------

server.registerTool(
  "wf_propose_from_writeup",
  {
    title: "Propose graph entities/edges extracted from freeform text (bring your own world)",
    description:
      "Given freeform text (a campaign pitch, prep notes, a wiki export, a session recap), makes one Anthropic " +
      "API call to extract a WFI-shaped proposal (entities/edges, endpoints referenced by name -- graph-import/" +
      "writeup-import.mjs's proposeWfiFromWriteup), dry-runs it through interchange.mjs's importGraph against the " +
      "live snapshot WITHOUT persisting (existing name+type dedup: an entity the writeup mentions that already " +
      "exists in the graph merges into an UPDATE instead of duplicating; edges referencing an undescribed name " +
      "get a stub entity, exactly like any other WFI import), and writes the result as a normal review batch -- " +
      "same review gate (wf_review_batch/wf_accept/wf_reject/wf_regenerate/wf_sync_to_foundry) every other batch " +
      "goes through. Works against a freshly-bootstrapped empty snapshot (a genuinely new campaign) just as well " +
      "as an existing populated one. `mode='replace'` only changes how THIS PREVIEW classifies create-vs-existing " +
      "(importGraph's own replace semantics) -- the actual commit at wf_sync_to_foundry time always applies each " +
      "mutation individually and never wipes anything not mentioned in the batch. Requires ANTHROPIC_API_KEY in " +
      "this server process's own environment, same as wf_propose_mutations.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      text: z.string().min(1).describe("Freeform writeup text to extract graph entities/edges from."),
      mode: z.enum(["merge", "replace"]).optional().describe("Passed through to importGraph's dry-run preview. Default 'merge'.")
    }
  },
  async ({ world, dataDir, text: writeupText, mode }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const { entities, edges, entityTypes } = loadSnapshot(dir, w).snapshot;
      const result = await importWriteup(w, writeupText, { entities, edges, entityTypes }, { mode });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_review_batch -----------------------------------------------------------------

server.registerTool(
  "wf_review_batch",
  {
    title: "Render a proposed mutation batch at a given grain",
    description:
      "Renders the requested detail level for a batch created by wf_propose_mutations: 'headline' (whole batch, " +
      "collapsed by importance -- an entity flagged by long-unreviewed-accumulation tracking is forced into the " +
      "headline regardless of importance, see wf_get_unreviewed_entities), 'region' (one region's mutations, full " +
      "detail for important ones), or 'entity' (one mutation's full drill-down, regardless of collapse). Viewing " +
      "at 'region'/'entity' grain marks the entities actually shown as human-reviewed (Phase 4 task 4.2) -- " +
      "'headline' grain does NOT, since a collapsed one-liner isn't a genuine review of the diff underneath it.",
    inputSchema: {
      world: worldParam,
      batchId: z.string(),
      grain: z.enum(["headline", "region", "entity"]),
      regionId: z.string().optional().describe("Required for grain='region'."),
      entityId: z.string().optional().describe("mutationId or target entity/edge id — required for grain='entity'.")
    }
  },
  async ({ world, batchId, grain, regionId, entityId }) => {
    try {
      const w = resolveWorld(world);
      const { rendered } = reviewGrainOp(w, { batchId, grain, regionId, entityId });
      return text({ rendered });
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_accept / wf_reject -------------------------------------------------------------

const scopeIdParam = z.string().optional().describe(
  "regionId (scope='region') or mutationId/target entity-or-edge id (scope='entity'). Not needed for scope='batch'."
);

server.registerTool(
  "wf_accept",
  {
    title: "Accept mutation(s) in a review batch",
    description:
      "Marks mutation(s) accepted via review-state.mjs, capturing each target's pre-mutation entity/edge state " +
      "(from the live snapshot) for rollback.mjs's later use. Scope 'batch' accepts every mutation in the batch, " +
      "'region' accepts one region's mutations, 'entity' accepts a single mutation. If this batch originated from " +
      "wf_resolve_pending or a wf_run_cycle growth-bound sweep, accepting the affected region/batch also clears " +
      "(resolves) the pending-ledger entries it was resolving -- reported in the response as `ledgerResolved` when " +
      "applicable, omitted otherwise. Phase 4 task 4.2: scope 'region'/'entity' counts as a genuine human review " +
      "of the entities touched (updates lastHumanReviewedAt); scope 'batch' (accept-all) deliberately does NOT -- " +
      "it instead accumulates an unreviewed-accept count per entity, surfaced by wf_get_unreviewed_entities. This " +
      "is the entire point of the feature: a GM batch-accepting everything without reading any of it must not " +
      "count as having reviewed it.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      batchId: z.string(),
      scope: z.enum(["batch", "region", "entity"]),
      id: scopeIdParam
    }
  },
  async ({ world, dataDir, batchId, scope, id }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const result = await acceptOp(dir, w, { batchId, scope, id });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_reject",
  {
    title: "Reject mutation(s) in a review batch",
    description:
      "Marks mutation(s) rejected via review-state.mjs. Same scope semantics as wf_accept. If this batch " +
      "originated from wf_resolve_pending or a wf_run_cycle growth-bound sweep, rejecting the affected region/batch " +
      "reverts the pending-ledger entries it was resolving back to 'pending' (never deleted) -- reported as " +
      "`ledgerReverted` when applicable. Phase 4 task 4.2: scope 'region'/'entity' still counts as a genuine human " +
      "review of the entities touched (a deliberate reject is still an examined diff) -- updates " +
      "lastHumanReviewedAt. Scope 'batch' does not (consistent with wf_accept), but also does NOT accumulate an " +
      "unreviewed-accept count, since a rejected mutation never lands on the graph -- there's no unreviewed " +
      "content debt left behind by a reject.",
    inputSchema: {
      world: worldParam,
      batchId: z.string(),
      scope: z.enum(["batch", "region", "entity"]),
      id: scopeIdParam
    }
  },
  async ({ world, batchId, scope, id }) => {
    try {
      const w = resolveWorld(world);
      const result = rejectOp(w, { batchId, scope, id });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_regenerate ---------------------------------------------------------------------

server.registerTool(
  "wf_regenerate",
  {
    title: "Regenerate texturing for mutation(s), with a steering note",
    description:
      "Re-invokes the texturing pass (mutation-engine/texture.mjs) for the selected scope, appending `note` to " +
      "the prompt. REPLACES (does not stack onto) the prior proposal for that scope: the targeted mutations are " +
      "removed and new ones (status:'pending') take their place. Still makes one API call per affected region, " +
      "not one per mutation. Requires ANTHROPIC_API_KEY in this server's environment, same as wf_propose_mutations. " +
      "Phase 4 task 4.2: scope 'region'/'entity' counts as a genuine human review of the targeted entities (asking " +
      "for a redo is still an examined diff) -- updates lastHumanReviewedAt. Scope 'batch' does not. " +
      "Phase 5: for a batch produced by wf_propose_from_writeup (sourceKind 'writeup-import'), this instead " +
      "re-invokes graph-import/writeup-import.mjs's proposeWfiFromWriteup against the batch's ORIGINAL source text " +
      "plus `note`, then re-runs the dry-run merge -- writeup extraction is one holistic pass over the whole text, " +
      "not a per-entity delta, so scope='batch'/'region' (equivalent for a writeup-import batch -- it always has " +
      "exactly one region) replace the WHOLE proposal; scope='entity' is refused with a clear error rather than " +
      "attempting an unsound partial replace.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      batchId: z.string(),
      scope: z.enum(["batch", "region", "entity"]),
      id: scopeIdParam,
      note: z.string().describe("Steering note appended to the texturing prompt, e.g. 'make the tone darker'.")
    }
  },
  async ({ world, dataDir, batchId, scope, id, note }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const result = await regenerateOp(dir, w, { batchId, scope, id, note });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_sync_to_foundry ------------------------------------------------------------------

server.registerTool(
  "wf_sync_to_foundry",
  {
    title: "Sync a batch's accepted mutations to Foundry",
    description:
      "Writes every 'accepted' mutation in the given batch to world-fabric-mutations.json via the same file " +
      "bridge wf_apply_mutations uses (the live path — requires a Foundry client to have the world open). " +
      "If that path reports 'queued' (no live client picked it up within the poll window), falls back to " +
      "graph-import/headless-apply.mjs's applyHeadless() against the standalone world-fabric-snapshot.json " +
      "directly — no live Foundry client required. Always reports which path was actually used (`path`: " +
      "'live' or 'headless') — never just a bare 'success'. Marks the batch 'synced' either way. If the headless " +
      "path assigned an id to a newly-created entity/edge (a mutation with no id at propose time), that " +
      "assignment is written back onto the batch's stored mutation entry and reported under `idAssignments` " +
      "(mutationId -> assigned id) — this is what lets wf_rollback_batch later target the creation for a " +
      "delete-based rollback instead of skipping it (Phase 4 task 4.1). Known limitation of the headless path: " +
      "if this world ALSO has a live Foundry client that is merely closed right now (not a genuinely " +
      "headless-only campaign), that client's own next export will overwrite the snapshot file from its " +
      "in-Foundry game.settings state, silently discarding a headless-applied change — there is no " +
      "reconciliation path back into game.settings yet (a foundry_worldFabric-side change, out of this phase's scope).",
    inputSchema: { world: worldParam, dataDir: dataDirParam, batchId: z.string() }
  },
  async ({ world, dataDir, batchId }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const result = await syncOp(dir, w, { batchId });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_narrate_batch ---------------------------------------------------------------------

server.registerTool(
  "wf_narrate_batch",
  {
    title: "Narrate an accepted mutation batch as in-fiction, player-facing prose",
    description:
      "Generates 2-3 paragraphs of scene/consequence narration for a batch's mutations (mutation-engine/narrate.mjs) " +
      "-- what the players actually see, read aloud at the table. This is NOT the reviewer-facing `rationale` field " +
      "reused; it's new prose written for a different audience, with no meta-commentary. Hard-gated: every mutation " +
      "in the batch must already be status:'accepted' (via wf_accept) -- if any mutation is still pending/rejected/" +
      "regenerate-requested, this is refused with a clear typed error listing which ones, never partially narrated " +
      "and never silently skipped. Pass `note` to regenerate with steering guidance (e.g. 'make the tone darker') " +
      "-- this never touches review-state.mjs's mutation-acceptance status, only produces new prose. Requires " +
      "ANTHROPIC_API_KEY in this server process's own environment, same as wf_propose_mutations.",
    inputSchema: {
      world: worldParam,
      batchId: z.string(),
      note: z.string().optional().describe(
        "Steering note for regenerating narration with different tone/guidance, e.g. 'make it more ominous'. " +
        "Produces new prose only -- does not affect any mutation's accepted status."
      )
    }
  },
  async ({ world, batchId, note }) => {
    try {
      const w = resolveWorld(world);
      const result = await narrateOp(w, { batchId, note });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_rollback_batch -------------------------------------------------------------------

server.registerTool(
  "wf_rollback_batch",
  {
    title: "Roll back the most-recently-accepted batch",
    description:
      "Computes the mutations needed to restore this batch's accepted entries to their captured pre-accept " +
      "state (rollback.mjs), applies them via the live Foundry file bridge first and falls back to " +
      "graph-import/headless-apply.mjs's applyHeadless() against the standalone snapshot if no live client picks " +
      "them up within the poll window — same live-then-headless behavior wf_sync_to_foundry uses, and always " +
      "reports which path was used (`path`: 'live' or 'headless'), same convention (Phase 4 task 4.1: this tool " +
      "previously had no headless fallback at all, so a rollback against a genuinely headless-only campaign could " +
      "never actually apply). Marks the batch 'rolled-back' either way. Confirmed Phase-1 scope: the " +
      "most-recently-accepted batch only — pass that batch's id explicitly. Entries accepted before rollback.mjs " +
      "existed, or a newly-created entity/edge whose id was never written back onto this batch (this now happens " +
      "automatically when a create was synced via wf_sync_to_foundry's headless path, but NOT for one applied via " +
      "the live-Foundry path — Foundry does not report a created id back through the file bridge), are reported " +
      "in `skipped` rather than silently dropped.",
    inputSchema: { world: worldParam, dataDir: dataDirParam, batchId: z.string() }
  },
  async ({ world, dataDir, batchId }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const result = await rollbackOp(dir, w, { batchId });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// ======================================================================================
// Phase 4 task 4.2 — unreviewed-accumulation tracking (mutation-engine/human-review.mjs).
// Thin wrapper, same convention as everything above: no independent business logic
// beyond parameter wiring.
// ======================================================================================

// --- wf_get_unreviewed_entities -----------------------------------------------------------

server.registerTool(
  "wf_get_unreviewed_entities",
  {
    title: "Surface entities whose applied-but-unreviewed history has gone too long",
    description:
      "Runs mutation-engine/human-review.mjs's findUnreviewedEntities(): entities that have accumulated real, " +
      "applied graph mutations without a human ever genuinely reviewing them (viewing at 'region'/'entity' grain " +
      "via wf_review_batch, or a scoped 'region'/'entity' accept/reject/regenerate) -- a whole-batch accept-all " +
      "never counts as review, by design, so it's exactly the debt this surfaces. An entity is flagged if it was " +
      "never reviewed at all ('never-reviewed'), last reviewed more than `maxAgeDays` ago ('stale'), or has " +
      "accumulated at least `maxUnreviewedAccepts` batch-accept-all touches since its last real review " +
      "('accumulated') -- either threshold alone is enough. Only entities with SOME tracked accept/review history " +
      "appear at all; an entity nothing has ever touched has no debt to flag. The same flagged set also forces a " +
      "flagged entity into wf_review_batch's headline rendering regardless of importance.",
    inputSchema: {
      world: worldParam,
      maxAgeDays: z.number().min(0).optional().describe(`Default ${DEFAULT_MAX_AGE_DAYS}.`),
      maxUnreviewedAccepts: z.number().int().min(1).optional().describe(`Default ${DEFAULT_MAX_UNREVIEWED_ACCEPTS}.`)
    }
  },
  async ({ world, maxAgeDays, maxUnreviewedAccepts }) => {
    try {
      const w = resolveWorld(world);
      const flagged = findUnreviewedEntities(w, { maxAgeDays, maxUnreviewedAccepts });
      return text({ world: w, count: flagged.length, entities: flagged });
    } catch (err) {
      return errorText(err);
    }
  }
);

// ======================================================================================
// Phase 3.5 — deferred/lazy consequence resolution (mutation-engine/pending-ledger.mjs,
// time-skip/run-cycle.mjs, time-skip/resolve-pending.mjs). Thin wrappers, same convention
// as everything above: no independent business logic beyond parameter wiring.
// ======================================================================================

// --- wf_run_cycle ------------------------------------------------------------------------

server.registerTool(
  "wf_run_cycle",
  {
    title: "Run one deferred-resolution time-skip cycle (headline focus now, everything else deferred)",
    description:
      "Runs time-skip/run-cycle.mjs's orchestrateCycle(): resolves `cycleScope` (same shape as " +
      "wf_propose_mutations' `scope` -- everything this cycle could plausibly touch) via time-skip/scope.mjs, " +
      "eagerly textures a small 'headline' neighborhood (region-mode BFS around `headlineAnchorId`, depth " +
      "`headlineDepth`) into a real review batch, and defers EVERYTHING ELSE in cycleScope -- including deltas " +
      "that would have cleared needsLLM on their own -- to mutation-engine/pending-ledger.mjs instead of texturing " +
      "or discarding it. Zero further API cost is ever spent on a deferred entity unless wf_resolve_pending is " +
      "later called on it explicitly. Any entity touched by this cycle whose ledger already exceeds " +
      "`growthBoundThreshold` (default 5) gets its full accumulated backlog folded into THIS cycle's resolution " +
      "too (one more texture call), rather than left to grow further unbounded. Requires ANTHROPIC_API_KEY in " +
      "this server process's own environment for the headline texturing call (and the growth-bound sweep call, " +
      "if triggered) -- same latency caveat as wf_propose_mutations applies to the headline call.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      cycleScope: proposeScopeSchema.describe(
        "Full scope for this cycle -- same shape as wf_propose_mutations' `scope`. Everything this could " +
        "plausibly touch; the headline subset (below) is textured now, everything else is deferred."
      ),
      headlineAnchorId: z.string().describe("Entity id to eagerly texture THIS cycle -- the 'headline' focus."),
      headlineDepth: z.number().int().min(1).max(6).default(1).describe(
        "BFS depth around headlineAnchorId textured now. Default 1 (the anchor plus its close neighborhood) -- " +
        "deliberately small, this is the 'spend real money here' half of the cycle."
      ),
      elapsedTimeDescriptor: z.string().optional().describe("Human-readable descriptor stored on the batch, e.g. '1 month'."),
      cycleDescriptor: z.string().describe(
        "Short label for this cycle, e.g. 'month 3'. Stored on every deferred ledger entry this cycle writes and " +
        "used for chronological ordering when wf_resolve_pending eventually renders them."
      ),
      growthBoundThreshold: z.number().int().min(1).optional().describe(
        "Pending-entry count above which an already-bloated entity touched by this cycle gets swept into this " +
        "cycle's resolution instead of growing further. Default 5."
      )
    }
  },
  async ({ world, dataDir, cycleScope, headlineAnchorId, headlineDepth, elapsedTimeDescriptor, cycleDescriptor, growthBoundThreshold }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const { entities, edges } = loadSnapshot(dir, w).snapshot;
      const result = await orchestrateCycle(
        w,
        { cycleScope, headlineAnchorId, headlineDepth, elapsedTimeDescriptor, cycleDescriptor },
        { entities, edges, growthBoundThreshold }
      );
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_resolve_pending ------------------------------------------------------------------

server.registerTool(
  "wf_resolve_pending",
  {
    title: "Resolve an entity's accumulated pending-ledger backlog (explicit, opt-in only)",
    description:
      "Runs time-skip/resolve-pending.mjs's resolvePending(): the ONLY way anything ever gets pulled out of " +
      "mutation-engine/pending-ledger.mjs's backlog and turned into a real review batch. Gathers `entityId`'s own " +
      "pending ledger, finds its BFS neighborhood (depth), filters to neighbors that also carry a pending backlog, " +
      "sorts them by highest single pending impactScore descending, and folds in only the top `maxNeighbors` " +
      "(default 8) -- THE FAN-OUT CAP, which bounds cost regardless of how large or high-degree the neighborhood " +
      "is. Excluded neighbors are left untouched (still 'pending', still available for a future resolve). " +
      "Everything included gets hydrated with its full source-batch context and rendered chronologically by cycle " +
      "before ONE texturing call produces the resulting mutations. " +
      "IMPORTANT: this tool is NEVER invoked automatically by wf_get_entity, wf_get_context, or wf_get_adjacent, " +
      "or by any other read-path tool -- resolving costs a real API call, so it only ever runs when explicitly " +
      "requested here. An incidental read that happens to touch a tagged entity must never silently trigger a " +
      "resolve. Requires ANTHROPIC_API_KEY in this server process's own environment, same as wf_propose_mutations.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      entityId: z.string().describe("The entity a GM is asking about -- its accumulated backlog (if any) gets resolved."),
      depth: z.number().int().min(1).max(4).optional().describe("Neighbor BFS depth. Default 1."),
      maxNeighbors: z.number().int().min(1).max(50).optional().describe(
        "The fan-out cap: max neighboring pending-bearing entities folded into this same resolve call, ranked by " +
        "highest single pending impactScore. Default 8."
      ),
      elapsedTimeDescriptor: z.string().optional()
    }
  },
  async ({ world, dataDir, entityId, depth, maxNeighbors, elapsedTimeDescriptor }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const { entities, edges } = loadSnapshot(dir, w).snapshot;
      const result = await resolvePending(w, entityId, { depth, maxNeighbors }, { entities, edges, elapsedTimeDescriptor });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// Guard the actual stdio connect behind an entrypoint check so this module
// can be imported (e.g. by test/*.test.mjs, to unit-test attachDiffs against
// this file's real wiring) without spinning up a live MCP transport.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Exported for testing only (attachDiffs is pure/deterministic; see
// test/propose-diff.test.mjs). Not part of the MCP tool surface.
export { attachDiffs };
