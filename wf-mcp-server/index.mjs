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
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { resolveDataDir, listWorlds } from "./lib/data-dir.mjs";
import { loadSnapshot, mutationsPath, snapshotFilePath } from "./lib/snapshot.mjs";
import { neighborhood, edgesFor, findEntity, findEntityByName, findEdge } from "./lib/graph.mjs";

// Phase 1 mutation engine — pure library code, this server is a thin wrapper
// (see gm-tools-conventions skill: "front-ends are thin wrappers, never
// logic duplicators"). No business logic lives below beyond parameter
// wiring and status-text formatting.
import { textureRegion } from "../mutation-engine/texture.mjs";
import { loadBatch, saveBatch, updateMutationStatus } from "../mutation-engine/review-state.mjs";
import { summarizeBatch, renderHeadline, renderRegionDiff, renderEntityDiff } from "../mutation-engine/grain.mjs";
import { acceptMutations, rollbackBatch } from "../mutation-engine/rollback.mjs";

// Phase 3.5 task 3.5.4 — resolve-outcome wiring: a batch that originated
// from time-skip/resolve-pending.mjs or run-cycle.mjs's growth-bound sweep
// carries `resolvedPendingEntries` metadata naming which pending-ledger.mjs
// entries it resolves. applyLedgerOutcome() (defined in pending-ledger.mjs,
// not here, to avoid a circular import with review-state.mjs -- see its own
// doc comment) is the single hook point for both wf_accept and wf_reject
// below: accept resolves (clears) the entries, reject reverts them to
// 'pending' rather than losing them. No-op for the overwhelming common case
// of a batch with no resolvedPendingEntries at all.
import { applyLedgerOutcome } from "../mutation-engine/pending-ledger.mjs";

// Phase 3.5 task 3.5.2/3.5.3 — deferred/lazy consequence resolution:
// orchestrateCycle (headline-focus + backlog deferral, wrapped below as
// wf_run_cycle) and resolvePending (explicit, opt-in resolve of an
// accumulated backlog, wrapped below as wf_resolve_pending).
import { orchestrateCycle } from "../time-skip/run-cycle.mjs";
import { resolvePending } from "../time-skip/resolve-pending.mjs";

// Phase 3 task 3.2/3.3 — the scene-narration pass (player-facing prose, NOT
// the reviewer-facing `rationale` field), hard-gated to already-accepted
// batches only. See mutation-engine/narrate.mjs's own doc comment.
import { narrateBatch } from "../mutation-engine/narrate.mjs";

// Phase 2 task 2.0 — the propagate/scope-resolution and orchestration logic
// that used to be inlined in wf_propose_mutations's handler now lives in
// time-skip/ as reusable library code; this server just wires parameters
// through to it. See time-skip/scope.mjs, time-skip/run.mjs.
import { orchestrateBatch, attachDiffs } from "../time-skip/run.mjs";

// Phase 2 task 2.3/2.4 — the Foundry-optional headless-apply fallback
// wf_sync_to_foundry uses when no live Foundry client picks up a mutation.
import { applyHeadless } from "../graph-import/headless-apply.mjs";

const server = new McpServer({ name: "world-fabric", version: "0.1.0" });

const worldParam = z.string().optional().describe(
  "World ID (Foundry world folder name). Defaults to WF_DEFAULT_WORLD env var if set. " +
  "Use wf_list_worlds to see what's available."
);
const dataDirParam = z.string().optional().describe(
  "Override the Foundry data directory. Defaults to WF_DATA_DIR env var, then OS-typical install paths."
);

function resolveWorld(world) {
  const resolved = world ?? process.env.WF_DEFAULT_WORLD;
  if (!resolved) {
    throw new Error(
      "No world specified and WF_DEFAULT_WORLD is not set. Call wf_list_worlds to see available worlds, " +
      "then pass one explicitly."
    );
  }
  return resolved;
}

function resolveDir(dataDir) {
  const dir = resolveDataDir(dataDir);
  if (!dir) {
    throw new Error(
      "Could not locate the Foundry data directory. Pass dataDir explicitly or set WF_DATA_DIR."
    );
  }
  return dir;
}

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

/**
 * Write mutations to the file bridge and poll briefly for the in-Foundry
 * watcher to pick them up. Shared by wf_apply_mutations and
 * wf_sync_to_foundry so the write+poll behavior isn't duplicated between
 * the two tools (gm-tools-conventions: thin wrappers, no logic duplication).
 */
async function applyMutationsToFoundry(dir, w, mutations) {
  const path = mutationsPath(dir, w);
  writeFileSync(path, JSON.stringify(mutations, null, 2), "utf8");

  // The watcher clears the file back to "[]" once applied. Poll briefly.
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (!existsSync(path)) break;
    const contents = readFileSync(path, "utf8").trim();
    if (contents === "[]") {
      return { status: "applied", count: mutations.length, path };
    }
  }
  return {
    status: "queued",
    count: mutations.length,
    path,
    note: "Not confirmed applied within 7s — check that a Foundry client has this world open with World Fabric active."
  };
}

/**
 * Apply a mutations array via the live-Foundry file bridge first; if no live
 * client picks it up within the poll window, fall back to
 * graph-import/headless-apply.mjs's applyHeadless() against the standalone
 * snapshot directly. Shared by wf_sync_to_foundry (task 2.4, the original
 * home of this fallback) and wf_rollback_batch (task 4.1) so the
 * live-then-headless behavior isn't duplicated between the two tools
 * (gm-tools-conventions: thin wrappers, no logic duplication).
 *
 * Extracted during task 4.1's own end-to-end verification: wf_rollback_batch
 * previously had NO headless fallback at all (only wf_sync_to_foundry did),
 * which meant a rollback could never actually apply against a genuinely
 * headless-only campaign (no live Foundry client ever open) — the restore
 * mutations would sit "queued" in world-fabric-mutations.json forever,
 * never reaching the snapshot. Task 4.1's own acceptance criterion (roll
 * back a batch, confirm the created entity is ACTUALLY deleted from the
 * snapshot) cannot be satisfied against a headless-only fixture without
 * this — so it's fixed here as part of closing that task, not left as a
 * separately-scoped gap.
 *
 * @returns {{path:'live'|'headless', liveResult:object, headlessResult?:object, snapshotPath?:string}}
 */
async function applyMutationsWithHeadlessFallback(dir, w, mutations) {
  const liveResult = await applyMutationsToFoundry(dir, w, mutations);
  if (liveResult.status === "applied") {
    return { path: "live", liveResult };
  }
  const snapshotPath = snapshotFilePath(dir, w);
  const headlessResult = applyHeadless(snapshotPath, mutations);
  return { path: "headless", liveResult, headlessResult, snapshotPath };
}

/**
 * Task 4.1: write applyHeadless()'s reported `idAssignments` (keyed by
 * position in the mutations array it received) back onto the originating
 * batch's stored mutation entries, keyed instead by mutationId (the index
 * is an internal accounting detail of this one call, not something a caller
 * outside this function should need to know about). Mutates `batch.mutations`
 * in place; the caller still owns saveBatch() (both wf_sync_to_foundry and
 * anyone else calling this also need to set batch.status, so one combined
 * save is cheaper than saving twice).
 *
 * `orderedSourceEntries` must be the exact same array (same order) the
 * mutations passed to applyHeadless() were mapped from — wf_sync_to_foundry
 * passes its own `accepted` array, since `mutations = accepted.map(...)`
 * preserves that 1:1 index correspondence.
 *
 * @param {object} batch
 * @param {object[]} orderedSourceEntries   StoredMutation entries, same order/length as the mutations array applyHeadless() received
 * @param {Object<string,string>} idAssignments   applyHeadless()'s returned idAssignments
 * @returns {Object<string,string>} {mutationId: assignedId} for whatever this call actually wrote back
 */
function writeBackIdAssignments(batch, orderedSourceEntries, idAssignments) {
  const written = {};
  if (!idAssignments) return written;
  for (const [indexStr, assignedId] of Object.entries(idAssignments)) {
    const sourceEntry = orderedSourceEntries[Number(indexStr)];
    if (!sourceEntry) continue; // defensive: shouldn't happen, index always came from the same-length array we built
    const entry = batch.mutations.find((m) => m.mutationId === sourceEntry.mutationId);
    if (!entry) continue;
    entry.id = assignedId;
    written[sourceEntry.mutationId] = assignedId;
  }
  return written;
}

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

/** Resolve a batch-scoped set of mutationIds for accept/reject/regenerate. */
function resolveMutationIds(batch, scope, id) {
  if (scope === "batch") return batch.mutations.map((m) => m.mutationId);
  if (scope === "region") {
    if (!id) throw new Error("scope='region' requires id (the regionId)");
    return batch.mutations
      .filter((m) => (m.regionId ?? `solo-${m.mutationId}`) === id)
      .map((m) => m.mutationId);
  }
  if (scope === "entity") {
    if (!id) throw new Error("scope='entity' requires id (a mutationId or target entity/edge id)");
    return batch.mutations.filter((m) => m.mutationId === id || m.id === id).map((m) => m.mutationId);
  }
  throw new Error(`Unknown scope: ${scope}`);
}

/** Next unused m<N> mutationId index in a batch, for appending regenerated mutations. */
function nextMutationIndex(batch) {
  let max = -1;
  for (const m of batch.mutations) {
    const match = /^m(\d+)$/.exec(m.mutationId ?? "");
    if (match) max = Math.max(max, parseInt(match[1], 10));
  }
  return max + 1;
}

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

// --- wf_review_batch -----------------------------------------------------------------

server.registerTool(
  "wf_review_batch",
  {
    title: "Render a proposed mutation batch at a given grain",
    description:
      "Renders the requested detail level for a batch created by wf_propose_mutations: 'headline' (whole batch, " +
      "collapsed by importance), 'region' (one region's mutations, full detail for important ones), or 'entity' " +
      "(one mutation's full drill-down, regardless of collapse).",
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
      const batch = loadBatch(w, batchId);
      const summary = summarizeBatch(batch);

      if (grain === "headline") {
        return text({ rendered: renderHeadline(summary) });
      }
      if (grain === "region") {
        if (!regionId) throw new Error("grain='region' requires regionId");
        const region = summary.regions.find((r) => r.regionId === regionId);
        if (!region) throw new Error(`No region "${regionId}" in batch "${batchId}"`);
        return text({ rendered: renderRegionDiff(region) });
      }
      if (grain === "entity") {
        if (!entityId) throw new Error("grain='entity' requires entityId");
        const entity = summary.regions
          .flatMap((r) => r.entities)
          .find((e) => e.mutationId === entityId || e.entityId === entityId);
        if (!entity) throw new Error(`No entity "${entityId}" in batch "${batchId}"`);
        return text({ rendered: renderEntityDiff(entity) });
      }
      throw new Error(`Unknown grain: ${grain}`);
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
      "applicable, omitted otherwise.",
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
      const batch = loadBatch(w, batchId);
      const mutationIds = resolveMutationIds(batch, scope, id);
      if (!mutationIds.length) throw new Error(`No mutations matched scope="${scope}" id="${id ?? ""}"`);
      const { entities, edges } = loadSnapshot(dir, w).snapshot;
      const updated = acceptMutations(w, batchId, mutationIds, entities, edges);
      // Phase 3.5 task 3.5.4: if this batch resolves any pending-ledger
      // entries (see pending-ledger.mjs's applyLedgerOutcome doc comment),
      // accepting clears them -- they're now real, reviewed graph mutations.
      const ledgerResolved = applyLedgerOutcome(updated, mutationIds, "accepted");
      return text({
        batchId,
        accepted: mutationIds,
        batchStatus: updated.status,
        ...(ledgerResolved.length ? { ledgerResolved } : {})
      });
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
      "`ledgerReverted` when applicable.",
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
      const batch = loadBatch(w, batchId);
      const mutationIds = resolveMutationIds(batch, scope, id);
      if (!mutationIds.length) throw new Error(`No mutations matched scope="${scope}" id="${id ?? ""}"`);
      let updated;
      for (const mutationId of mutationIds) updated = updateMutationStatus(w, batchId, mutationId, "rejected");
      // Phase 3.5 task 3.5.4: reject reverts any resolved ledger entries
      // back to 'pending' -- the underlying debt is real and must not
      // silently vanish just because this particular resolution attempt
      // was rejected.
      const ledgerReverted = applyLedgerOutcome(updated, mutationIds, "rejected");
      return text({
        batchId,
        rejected: mutationIds,
        batchStatus: updated.status,
        ...(ledgerReverted.length ? { ledgerReverted } : {})
      });
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
      "not one per mutation. Requires ANTHROPIC_API_KEY in this server's environment, same as wf_propose_mutations.",
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
      const batch = loadBatch(w, batchId);
      const mutationIds = resolveMutationIds(batch, scope, id);
      if (!mutationIds.length) throw new Error(`No mutations matched scope="${scope}" id="${id ?? ""}"`);
      const targeted = batch.mutations.filter((m) => mutationIds.includes(m.mutationId));

      const { entities, edges } = loadSnapshot(dir, w).snapshot;

      // Group by original regionId so regeneration still costs one API call
      // per region, not one per mutation (same cost-control behavior as
      // the original propose pass).
      const byRegion = new Map();
      for (const m of targeted) {
        const key = m.regionId ?? `solo-${m.mutationId}`;
        if (!byRegion.has(key)) byRegion.set(key, []);
        byRegion.get(key).push(m);
      }

      const newMutations = [];
      let nextIdx = nextMutationIndex(batch);
      for (const [regionId, entries] of byRegion) {
        const entityIds = [...new Set(entries.map((m) => m.id).filter(Boolean))];
        const deltas = entries.map((m) => ({
          kind: m.sourceKind === "ambient-decay" ? "ambient-decay" : "seed-propagated",
          entityId: m.id,
          edgeId: m.op.includes("edge") ? m.id : undefined,
          impactScore: m.impactScore ?? 0.5,
          needsLLM: true
        }));
        const sourceKind = entries[0].sourceKind ?? "manual";
        const regionMutations = await textureRegion(
          { regionId, entityIds, deltas },
          { entities, edges, world: w, batchId, sourceKind, elapsedTimeDescriptor: batch.elapsedTimeDescriptor, note },
          {}
        );
        for (const rm of regionMutations) {
          newMutations.push({ ...rm, mutationId: `m${nextIdx++}`, status: "pending" });
        }
      }

      batch.mutations = batch.mutations.filter((m) => !mutationIds.includes(m.mutationId));
      batch.mutations.push(...newMutations);
      const saved = saveBatch(w, batch);

      return text({
        batchId,
        replaced: mutationIds,
        regenerated: newMutations.map((m) => m.mutationId),
        batchStatus: saved.status
      });
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
      const batch = loadBatch(w, batchId);
      const accepted = batch.mutations.filter((m) => m.status === "accepted");
      if (!accepted.length) {
        return text({ status: "no-op", batchId, note: "No mutations in this batch have status 'accepted'." });
      }
      const mutations = accepted.map((m) => ({ op: m.op, id: m.id, data: m.data }));

      const { path, liveResult, headlessResult, snapshotPath } = await applyMutationsWithHeadlessFallback(dir, w, mutations);

      if (path === "live") {
        batch.status = "synced";
        saveBatch(w, batch);
        // NOTE: liveResult itself carries its own `path` field (the
        // mutations file path, from applyMutationsToFoundry) -- renamed to
        // mutationsFilePath here so it can't collide with (and silently get
        // overwritten by, or silently overwrite) this `path: "live"` label,
        // which is the thing wf_sync_to_foundry's contract actually promises
        // callers ("always report which path was used").
        const { path: mutationsFilePath, ...rest } = liveResult;
        return text({ path: "live", ...rest, mutationsFilePath, batchId, syncedCount: accepted.length });
      }

      // path === "headless" -- no live Foundry client picked this up within
      // the poll window. Fell back to the headless path (task 2.3) against
      // the standalone snapshot file. Task 4.1: write back any ids the
      // headless apply assigned to newly-created entities/edges so a later
      // rollback can target them.
      const idAssignments = writeBackIdAssignments(batch, accepted, headlessResult.idAssignments);
      batch.status = "synced";
      saveBatch(w, batch);
      return text({
        path: "headless",
        status: "applied",
        batchId,
        syncedCount: accepted.length,
        snapshotPath,
        liveAttempt: liveResult,
        summary: headlessResult.summary,
        deletedEntityCount: headlessResult.deletedEntityCount,
        deletedEdgeCount: headlessResult.deletedEdgeCount,
        skipped: headlessResult.skipped,
        ...(Object.keys(idAssignments).length ? { idAssignments } : {}),
        note:
          "No live Foundry client picked up the mutation within the poll window; applied directly to the " +
          "standalone snapshot instead. If a live Foundry client for this world reopens later, its own export " +
          "will overwrite this file from game.settings -- no reconciliation path exists yet for a mixed " +
          "live/headless world."
      });
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
      const batch = loadBatch(w, batchId);
      const result = await narrateBatch(batch, { world: w, note }, {});
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
      const { restoreMutations, skipped } = rollbackBatch(w, batchId);
      if (!restoreMutations.length) {
        return text({ batchId, status: "no-op", skipped, note: "No restorable accepted mutations found." });
      }
      const { path, liveResult, headlessResult, snapshotPath } = await applyMutationsWithHeadlessFallback(dir, w, restoreMutations);

      if (path === "live") {
        const { path: mutationsFilePath, ...rest } = liveResult;
        return text({ path: "live", ...rest, mutationsFilePath, batchId, restoredCount: restoreMutations.length, skipped });
      }

      return text({
        path: "headless",
        status: "applied",
        batchId,
        restoredCount: restoreMutations.length,
        snapshotPath,
        liveAttempt: liveResult,
        summary: headlessResult.summary,
        deletedEntityCount: headlessResult.deletedEntityCount,
        deletedEdgeCount: headlessResult.deletedEdgeCount,
        skipped,
        note:
          "No live Foundry client picked up the rollback within the poll window; applied directly to the " +
          "standalone snapshot instead. If a live Foundry client for this world reopens later, its own export " +
          "will overwrite this file from game.settings -- no reconciliation path exists yet for a mixed " +
          "live/headless world."
      });
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
