#!/usr/bin/env node
/**
 * Review-UI HTTP server — Phase 6 task 6.1.
 *
 * A thin local HTTP layer over the mutation engine's library modules,
 * importing them DIRECTLY (no MCP round-trip, no requirement that a Claude
 * Code session be open) — same architectural point Phase 2's headless-apply
 * made: reviewing shouldn't require a live chat session. Every route below
 * calls straight into mutation-engine/*, time-skip/*, or
 * wf-mcp-server/lib/mutation-ops.mjs's shared review-workflow operations
 * (see that module's own doc comment — it's the exact code wf-mcp-server's
 * wf_accept/wf_reject/wf_regenerate/wf_sync_to_foundry/wf_rollback_batch/
 * wf_review_batch tools call, extracted so this server reuses it verbatim
 * instead of re-deriving the same logic against a second, drifting copy —
 * per gm-tools-conventions' "front-ends are thin wrappers, never logic
 * duplicators"). No independent business logic lives in this file beyond
 * request parsing, routing, and status-code mapping.
 *
 * Dependency choice: bare `node:http`, no framework. This project's
 * established convention is "no frontend framework, no build step" for
 * anything UI-facing, and the route surface here (a dozen or so JSON
 * endpoints plus static file serving) is small and uniform enough that a
 * hand-rolled router (~40 lines, see `route()`/`serveStatic()` below) is
 * less machinery than adding a new runtime dependency for it — matching
 * gm-tools-conventions' "keep the dependency footprint proportionate"
 * instruction and its explicit "flag a new dependency rather than adding it
 * silently" rule (this note IS that flag: a framework was considered and
 * deliberately not used).
 *
 * review-ui/package.json declares NO dependencies at all: every import below
 * is either a Node built-in or a relative path into mutation-engine/,
 * time-skip/, graph-import/, or wf-mcp-server/lib/ — none of which this
 * server needs its own node_modules for for (their own transitive deps,
 * zod/@anthropic-ai/sdk, resolve from GM_Tools/'s root node_modules via
 * Node's normal upward node_modules search, the same way wf-mcp-server's own
 * mutation-engine/* imports already do).
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { listWorlds } from "../wf-mcp-server/lib/data-dir.mjs";
import { loadSnapshot } from "../wf-mcp-server/lib/snapshot.mjs";
import { resolveWorld, resolveDir } from "../wf-mcp-server/lib/resolve.mjs";
import { findEntity, neighborhood } from "../wf-mcp-server/lib/graph.mjs";

import { loadBatch, listBatches } from "../mutation-engine/review-state.mjs";
import { summarizeBatch } from "../mutation-engine/grain.mjs";
import { findUnreviewedEntities, DEFAULT_MAX_AGE_DAYS, DEFAULT_MAX_UNREVIEWED_ACCEPTS } from "../mutation-engine/human-review.mjs";
import { listPendingEntities, readAvailablePending } from "../mutation-engine/pending-ledger.mjs";
import { resolvePending } from "../time-skip/resolve-pending.mjs";
import { getUserSettings, setRubberDuckMode } from "../mutation-engine/user-settings.mjs";

import {
  flaggedEntityIdSet,
  reviewGrainOp,
  acceptOp,
  acceptMutationIds,
  rejectMutationIds,
  regenerateOp,
  narrateOp,
  syncOp,
  rollbackOp,
  proposeFromWriteupOp,
  selectFramingForNewBatch,
  selectFramingForExistingBatch,
  rejectWithLoopOp,
  narrateEntityOp,
  getEntityNarrationOp,
  getEntityNarrationHistoryOp
} from "../wf-mcp-server/lib/mutation-ops.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

export const DEFAULT_PORT = 8787;

// --- small request/response helpers -----------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Map a thrown error to an HTTP status code. Every route handler funnels its
 * errors through here rather than letting an unhandled exception 500 the
 * process — per task 6.1's explicit requirement that a narration request
 * against a non-fully-accepted batch "must 4xx cleanly ... not a generic
 * 500", generalized to every route (the same care is owed everywhere, not
 * just narrate).
 */
function statusForError(err) {
  if (err.name === "NarrationGateError") return 409; // batch not fully accepted -- a real conflict with narrate's precondition, not a bad request shape
  if (err.name === "ConcurrentWriteError") return 409; // another writer holds the lock right now -- retryable
  if (err.name === "WriteupImportRegenerateScopeError") return 400;
  // Phase 8: the bounded re-framing round is already spent -- a real
  // conflict with the reject-loop's own precondition (needs a note now),
  // not a malformed request.
  if (err.name === "FramingRoundLimitError") return 409;
  if (/no (batch|region|entity|world|snapshot) found/i.test(err.message ?? "")) return 404;
  if (/not found/i.test(err.message ?? "")) return 404;
  return 400; // everything else thrown by this codebase's library modules is a deliberate, caller-facing validation error, not a crash
}

function sendError(res, err) {
  const status = statusForError(err);
  sendJson(res, status, { error: err.message, name: err.name ?? "Error", ...(err.notAccepted ? { notAccepted: err.notAccepted } : {}) });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(new Error(`Invalid JSON request body: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function serveStatic(res, filePath) {
  if (!existsSync(filePath)) {
    sendJson(res, 404, { error: `Not found: ${filePath}` });
    return;
  }
  const type = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
  const body = readFileSync(filePath);
  res.writeHead(200, { "Content-Type": type, "Content-Length": body.length });
  res.end(body);
}

// --- domain helpers (thin wiring only, no new business logic) --------------

/**
 * Full batch-detail payload for the Review view: headline + per-region,
 * per-entity data (grain.mjs's summarizeBatch), each entity augmented with
 * its actual review-state status (accepted/pending/rejected/...) -- a field
 * summarizeBatch's own output deliberately doesn't carry (it's a grain/
 * collapse concern, not a status concern), cross-referenced here from the
 * raw batch.mutations by mutationId. Also reports `narratable` (every
 * mutation status==='accepted') so the frontend knows whether to offer
 * narration without needing its own copy of narrate.mjs's gate rule.
 */
function batchDetailPayload(w, batchId) {
  const batch = loadBatch(w, batchId);
  const statusByMutationId = new Map(batch.mutations.map((m) => [m.mutationId, m.status]));
  const summary = summarizeBatch(batch, { flaggedEntityIds: flaggedEntityIdSet(w) });
  const regions = summary.regions.map((region) => ({
    ...region,
    entities: region.entities.map((e) => ({ ...e, status: statusByMutationId.get(e.mutationId) }))
  }));
  const narratable = batch.mutations.length > 0 && batch.mutations.every((m) => m.status === "accepted");
  return {
    batch: {
      id: batch.id,
      world: batch.world,
      createdAt: batch.createdAt,
      status: batch.status,
      scope: batch.scope,
      elapsedTimeDescriptor: batch.elapsedTimeDescriptor,
      mutationCount: batch.mutations.length
    },
    headline: summary.headline,
    regions,
    narratable
  };
}

/**
 * The batch Settings' "Undo Last Batch" button targets: the most-recently-
 * created batch (review-state.mjs's listBatches is already newest-first)
 * that is not already rolled-back and has at least one accepted mutation
 * (rollback.mjs's own scope -- "most-recently-accepted batch only", but
 * nothing upstream tracks that id for a caller, so this is that lookup).
 * Returns null if nothing is rollback-able.
 */
function findLastRollbackableBatch(w) {
  for (const summary of listBatches(w)) {
    if (summary.status === "rolled-back") continue;
    const batch = loadBatch(w, summary.id);
    if (batch.mutations.some((m) => m.status === "accepted")) {
      return { id: batch.id, createdAt: batch.createdAt, status: batch.status };
    }
  }
  return null;
}

/** GET /api/pending-entities payload: every entity with an available backlog, plus its entries and a display name. */
function pendingEntitiesPayload(w, dir) {
  let entities = [];
  try {
    ({ entities } = loadSnapshot(dir, w).snapshot);
  } catch {
    // No snapshot yet is fine here -- pending entries can still be listed by id, just without a friendly name.
  }
  return listPendingEntities(w).map((entityId) => ({
    entityId,
    name: findEntity(entities, entityId)?.name ?? entityId,
    entries: readAvailablePending(w, entityId)
  }));
}

// ---------------------------------------------------------------------------
// Phase 7 -- graph data route (task 7.1). Thin composition over EXISTING
// primitives only, per the task's own instruction: wf-mcp-server/lib/graph.mjs's
// neighborhood() for BFS (no second graph-walk), mutation-ops.mjs's
// flaggedEntityIdSet (itself just human-review.mjs's findUnreviewedEntities,
// already used above by /api/unreviewed-entities) for the unreviewed
// channel, pending-ledger.mjs's listPendingEntities (already used above by
// /api/pending-entities) for the deferred-debt channel. No new business
// logic beyond request shaping lives here.
// ---------------------------------------------------------------------------

const GRAPH_STATUS_FILTER_TOKENS = new Set(["unreviewed", "deferred-debt"]);

/**
 * Parse a `filter` query param into the Set of active status tokens, or
 * `null` for "show everything" (`filter=all`, the explicit escape hatch).
 * Omitting the param entirely defaults to BOTH tokens -- the confirmed
 * flagged-only default the standalone Graph view (task 7.4) must ship with.
 */
function parseGraphFilter(raw) {
  if (raw === "all") return null;
  const tokens = (raw ? raw.split(",") : ["unreviewed", "deferred-debt"])
    .map((t) => t.trim())
    .filter((t) => GRAPH_STATUS_FILTER_TOKENS.has(t));
  return new Set(tokens.length ? tokens : ["unreviewed", "deferred-debt"]);
}

/**
 * Full-graph degree map (entityId -> edge count), built once over the
 * WHOLE snapshot's edges -- a node's hub-ness is a real property of the
 * persisted graph, not an artifact of how much context happens to be
 * fetched around it in any one request.
 */
function graphDegreeMap(edges) {
  const m = new Map();
  for (const e of edges) {
    m.set(e.sourceId, (m.get(e.sourceId) ?? 0) + 1);
    m.set(e.targetId, (m.get(e.targetId) ?? 0) + 1);
  }
  return m;
}

function graphNodePayload(entity, { degrees, flaggedIds, debtIds, proposed }) {
  return {
    id: entity.id,
    name: entity.name ?? entity.id,
    type: entity.type ?? "unknown",
    degree: degrees.get(entity.id) ?? 0,
    flaggedUnreviewed: flaggedIds.has(entity.id),
    hasDeferredDebt: debtIds.has(entity.id),
    ...(proposed !== undefined ? { proposed } : {})
  };
}

function graphEdgePayload(edge, { proposed }) {
  return {
    id: edge.id,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    relationshipType: edge.relationshipType ?? "unspecified",
    label: edge.label,
    ...(proposed !== undefined ? { proposed } : {})
  };
}

/**
 * Batch-scoped graph payload: this batch's own proposed entities/edges
 * (every entity/edge touched by one of its mutations, regardless of
 * accept/reject/pending status -- accepting doesn't write to the graph
 * until sync, so even an accepted mutation is still "proposed" here) plus
 * their one-hop (or `depth`-hop) PERSISTED neighbors, via neighborhood().
 *
 * A create with no persisted counterpart yet gets a synthetic node keyed
 * `new:<mutationId>` -- writeup-import (graph-import/writeup-import.mjs)
 * pre-assigns a real id to every entity it creates, but texture.mjs's
 * LLM-authored creates are NOT guaranteed to (schema.mjs's `Mutation.id` is
 * optional), so this route can't assume every entity mutation carries a
 * resolved id the way Phase 5's own id-stability fix could.
 */
function graphPayloadForBatch(w, dir, batchId, depth) {
  const batch = loadBatch(w, batchId);
  let entities = [];
  let edges = [];
  try {
    ({ entities, edges } = loadSnapshot(dir, w).snapshot);
  } catch {
    // No persisted snapshot yet (a brand-new world) -- the batch's own
    // proposed nodes still render, just with no persisted context.
  }
  const entityMap = new Map(entities.map((e) => [e.id, e]));
  const edgeMap = new Map(edges.map((e) => [e.id, e]));

  const proposedEntityIds = new Set(); // real + synthetic keys
  const syntheticEntities = new Map(); // key -> {id, name, type}
  const proposedEdgeIds = new Set();
  const syntheticEdges = new Map(); // key -> {id, sourceId, targetId, relationshipType, label}
  const seedRealIds = new Set(); // real persisted ids to expand neighborhood() from

  for (const m of batch.mutations) {
    if (m.op === "upsert_entity" || m.op === "delete_entity") {
      const key = m.id ?? `new:${m.mutationId}`;
      proposedEntityIds.add(key);
      if (m.id && entityMap.has(m.id)) {
        seedRealIds.add(m.id);
      } else {
        syntheticEntities.set(key, {
          id: key,
          name: m.entityContext?.name ?? m.data?.name ?? key,
          type: m.data?.type ?? "unknown"
        });
      }
    } else if (m.op === "upsert_edge" || m.op === "delete_edge") {
      const existingEdge = m.id ? edgeMap.get(m.id) : undefined;
      const sourceId = m.data?.sourceId ?? existingEdge?.sourceId;
      const targetId = m.data?.targetId ?? existingEdge?.targetId;
      if (!sourceId || !targetId) continue; // can't place an edge we can't resolve both endpoints for
      const key = m.id ?? `new-edge:${m.mutationId}`;
      proposedEdgeIds.add(key);
      syntheticEdges.set(key, {
        id: key,
        sourceId,
        targetId,
        relationshipType: m.data?.relationshipType ?? existingEdge?.relationshipType ?? "unspecified",
        label: m.data?.label ?? existingEdge?.label
      });
      for (const endpointId of [sourceId, targetId]) {
        if (entityMap.has(endpointId)) {
          seedRealIds.add(endpointId);
        } else if (!syntheticEntities.has(endpointId) && !proposedEntityIds.has(endpointId)) {
          // An edge endpoint this batch never directly mutates as an entity
          // and that isn't in the live snapshot either -- shouldn't happen
          // in practice (every producer creates/stubs both endpoints before
          // an edge referencing them), but render a minimal placeholder
          // rather than a dangling edge if it ever does.
          syntheticEntities.set(endpointId, { id: endpointId, name: endpointId, type: "unknown" });
        }
        proposedEntityIds.add(endpointId);
      }
    }
  }

  // Expand context: PERSISTED neighbors of every real seed entity this
  // batch touches -- reusing neighborhood(), one call per seed, merged.
  const contextEntities = new Map();
  const contextEdges = new Map();
  for (const seedId of seedRealIds) {
    const nb = neighborhood(entities, edges, seedId, depth);
    for (const e of nb.entities) contextEntities.set(e.id, e);
    for (const e of nb.edges) contextEdges.set(e.id, e);
  }

  const degrees = graphDegreeMap(edges);
  const flaggedIds = flaggedEntityIdSet(w);
  const debtIds = new Set(listPendingEntities(w));

  const nodesById = new Map();
  for (const e of syntheticEntities.values()) {
    nodesById.set(e.id, graphNodePayload(e, { degrees, flaggedIds, debtIds, proposed: true }));
  }
  for (const e of contextEntities.values()) {
    nodesById.set(e.id, graphNodePayload(e, { degrees, flaggedIds, debtIds, proposed: proposedEntityIds.has(e.id) }));
  }

  const edgesById = new Map();
  for (const e of syntheticEdges.values()) {
    edgesById.set(e.id, graphEdgePayload(e, { proposed: true }));
  }
  for (const e of contextEdges.values()) {
    if (!edgesById.has(e.id)) edgesById.set(e.id, graphEdgePayload(e, { proposed: proposedEdgeIds.has(e.id) }));
  }

  return { nodes: [...nodesById.values()], edges: [...edgesById.values()] };
}

/**
 * Standalone whole-graph payload (tasks 7.1/7.4): every persisted entity,
 * filtered by status. Omitting `filter` entirely defaults to the CONFIRMED
 * flagged-only default (unreviewed OR deferred-debt) -- "show everything"
 * is an explicit `filter=all`, never the unstated default.
 */
function graphPayloadStandalone(w, dir, filterRaw) {
  let entities = [];
  let edges = [];
  try {
    ({ entities, edges } = loadSnapshot(dir, w).snapshot);
  } catch {
    return { nodes: [], edges: [] };
  }
  const degrees = graphDegreeMap(edges);
  const flaggedIds = flaggedEntityIdSet(w);
  const debtIds = new Set(listPendingEntities(w));
  const activeFilters = parseGraphFilter(filterRaw); // null = show everything

  const selected = entities.filter((e) => {
    if (!activeFilters) return true;
    return (activeFilters.has("unreviewed") && flaggedIds.has(e.id)) ||
           (activeFilters.has("deferred-debt") && debtIds.has(e.id));
  });
  const selectedIds = new Set(selected.map((e) => e.id));

  const nodes = selected.map((e) => graphNodePayload(e, { degrees, flaggedIds, debtIds }));
  const visibleEdges = edges
    .filter((e) => selectedIds.has(e.sourceId) && selectedIds.has(e.targetId))
    .map((e) => graphEdgePayload(e, {}));

  return { nodes, edges: visibleEdges };
}

// --- routing -----------------------------------------------------------------

/**
 * @param {object} [opts]
 * @param {number} [opts.port]
 * @returns {import('node:http').Server}
 */
export function createReviewServer(opts = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);

      if (parts[0] !== "api") {
        return handleStatic(url.pathname, res);
      }

      await handleApi(req, res, url, parts);
    } catch (err) {
      sendError(res, err);
    }
  });

  return server.listen(opts.port ?? DEFAULT_PORT);
}

function handleStatic(pathname, res) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(PUBLIC_DIR, rel);
  // Guard against path traversal outside public/ -- a fixed, small file set is served, no reason to ever escape PUBLIC_DIR.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 400, { error: "Invalid path" });
  }
  serveStatic(res, filePath);
}

async function handleApi(req, res, url, parts) {
  const method = req.method;
  const q = url.searchParams;

  // GET /api/worlds
  if (method === "GET" && parts.length === 2 && parts[1] === "worlds") {
    const dir = resolveDir(q.get("dataDir"));
    return sendJson(res, 200, { dataDir: dir, worlds: listWorlds(dir) });
  }

  // GET /api/batches
  if (method === "GET" && parts.length === 2 && parts[1] === "batches") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { world: w, batches: listBatches(w) });
  }

  // GET /api/batches/:batchId
  if (method === "GET" && parts.length === 3 && parts[1] === "batches") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, batchDetailPayload(w, parts[2]));
  }

  // POST /api/batches/:batchId/view  { world, grain, regionId, entityId }
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "view") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const result = reviewGrainOp(w, { batchId: parts[2], grain: body.grain, regionId: body.regionId, entityId: body.entityId });
    return sendJson(res, 200, { ok: true, ...result });
  }

  // POST /api/batches/:batchId/accept  { world, dataDir, scope, id }
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "accept") {
    const body = await readBody(req);
    const dir = resolveDir(body.dataDir);
    const w = resolveWorld(body.world);
    const result = await acceptOp(dir, w, { batchId: parts[2], scope: body.scope, id: body.id });
    return sendJson(res, 200, result);
  }

  // POST /api/batches/:batchId/reject  { world, dataDir, scope, id, note, quickPickReason }
  // Phase 8: dispatches through rejectWithLoopOp, which is a byte-identical
  // pass-through to the old plain-reject behavior for every batch that
  // isn't a rubber-duck-mode writeup-import batch at scope='batch'/'region'
  // -- see mutation-ops.mjs's own doc comment for the full state machine.
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "reject") {
    const body = await readBody(req);
    const dir = resolveDir(body.dataDir);
    const w = resolveWorld(body.world);
    const result = await rejectWithLoopOp(dir, w, {
      batchId: parts[2],
      scope: body.scope,
      id: body.id,
      note: body.note,
      quickPickReason: body.quickPickReason
    });
    return sendJson(res, 200, result);
  }

  // POST /api/batches/:batchId/bulk-accept  { world, dataDir, mutationIds, reviewedMutationIds }
  // The checkbox multi-select "Accept Selected" action: an arbitrary subset
  // of mutationIds, not necessarily a whole region/batch. `reviewedMutationIds`
  // (a subset of mutationIds) is per-mutation: only rows the GM actually
  // expanded before accepting count as genuinely reviewed
  // (markHumanReviewed); everything else accepted this way accumulates the
  // unreviewed-accept count (recordUnreviewedAccept) -- see
  // mutation-ops.mjs's acceptMutationIds doc comment for the full reasoning.
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "bulk-accept") {
    const body = await readBody(req);
    const dir = resolveDir(body.dataDir);
    const w = resolveWorld(body.world);
    const mutationIds = body.mutationIds;
    if (!Array.isArray(mutationIds) || !mutationIds.length) {
      throw new Error("bulk-accept requires a non-empty mutationIds array");
    }
    const { entities, edges } = loadSnapshot(dir, w).snapshot;
    // Self-review remediation: mutation-ops.mjs's acceptMutationIds defaults
    // an OMITTED reviewedMutationIds to mutationIds (everything counts as
    // reviewed) -- correct for acceptOp's scope-based callers, which always
    // pass an explicit value either way, but the wrong default for THIS
    // route: a caller of the bulk endpoint that forgets the field should not
    // silently over-credit review. Default to [] (nothing reviewed) here at
    // the HTTP boundary instead of passing an omitted field straight through.
    const result = acceptMutationIds(w, parts[2], mutationIds, {
      entities,
      edges,
      reviewedMutationIds: body.reviewedMutationIds ?? []
    });
    return sendJson(res, 200, result);
  }

  // POST /api/batches/:batchId/bulk-reject  { world, mutationIds, reviewedMutationIds }
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "bulk-reject") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const mutationIds = body.mutationIds;
    if (!Array.isArray(mutationIds) || !mutationIds.length) {
      throw new Error("bulk-reject requires a non-empty mutationIds array");
    }
    // Same conservative-default reasoning as bulk-accept above.
    const result = rejectMutationIds(w, parts[2], mutationIds, { reviewedMutationIds: body.reviewedMutationIds ?? [] });
    return sendJson(res, 200, result);
  }

  // POST /api/batches/:batchId/regenerate  { world, dataDir, scope, id, note }
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "regenerate") {
    const body = await readBody(req);
    const dir = resolveDir(body.dataDir);
    const w = resolveWorld(body.world);
    const result = await regenerateOp(dir, w, { batchId: parts[2], scope: body.scope, id: body.id, note: body.note });
    return sendJson(res, 200, result);
  }

  // POST /api/batches/:batchId/narrate  { world, note }
  // Hard-gated by narrate.mjs's assertBatchNarratable (via narrateOp ->
  // narrateBatch): a batch with any non-accepted mutation throws
  // NarrationGateError, mapped to a clean 409 by sendError -- never a crash,
  // never a silent partial narration.
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "narrate") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const result = await narrateOp(w, { batchId: parts[2], note: body.note });
    return sendJson(res, 200, result);
  }

  // ---------------------------------------------------------------------
  // Phase 10 -- per-entity narration & persistence (task 10.4). This is now
  // the DEFAULT narration path the frontend uses (task 10.5); the whole-batch
  // /narrate route above is left unchanged and still works if ever needed.
  // ---------------------------------------------------------------------

  // POST /api/batches/:batchId/narrate-entity  { world, dataDir, mutationId, note }
  // Entity-grain gate (mutation-engine/narrate.mjs's assertMutationNarratable,
  // via narrateEntity): only the targeted mutationId must be status:'accepted'
  // -- a sibling mutation elsewhere in the batch being pending/rejected does
  // NOT block this call, unlike the whole-batch /narrate route above. On
  // success the result is durably persisted (mutation-engine/entity-narration.mjs)
  // before this route ever responds.
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "narrate-entity") {
    const body = await readBody(req);
    const dir = resolveDir(body.dataDir);
    const w = resolveWorld(body.world);
    if (!body.mutationId) throw new Error("POST .../narrate-entity requires a `mutationId`.");
    const result = await narrateEntityOp(dir, w, { batchId: parts[2], mutationId: body.mutationId, note: body.note });
    return sendJson(res, 200, result);
  }

  // GET /api/entities/:entityId/narration?world=...
  // The current (status:'current') narration for one entity, or {narration:null}
  // if it has never been narrated (or was superseded with nothing yet
  // replacing it) -- a pure read, no model call.
  if (method === "GET" && parts.length === 4 && parts[1] === "entities" && parts[3] === "narration") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, getEntityNarrationOp(w, { entityId: parts[2] }));
  }

  // GET /api/entities/:entityId/narration-history?world=...
  // The entity's FULL history (current + every superseded entry) -- backs
  // review-ui's per-row "view history" affordance (task 10.5).
  if (method === "GET" && parts.length === 4 && parts[1] === "entities" && parts[3] === "narration-history") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, getEntityNarrationHistoryOp(w, { entityId: parts[2] }));
  }

  // POST /api/batches/:batchId/sync  { world, dataDir }
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "sync") {
    const body = await readBody(req);
    const dir = resolveDir(body.dataDir);
    const w = resolveWorld(body.world);
    const result = await syncOp(dir, w, { batchId: parts[2] });
    return sendJson(res, 200, result);
  }

  // POST /api/batches/:batchId/rollback  { world, dataDir }
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "rollback") {
    const body = await readBody(req);
    const dir = resolveDir(body.dataDir);
    const w = resolveWorld(body.world);
    const result = await rollbackOp(dir, w, { batchId: parts[2] });
    return sendJson(res, 200, result);
  }

  // GET /api/last-rollbackable-batch  -- what Settings' "Undo Last Batch" button targets
  if (method === "GET" && parts.length === 2 && parts[1] === "last-rollbackable-batch") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { batch: findLastRollbackableBatch(w) });
  }

  // GET /api/unreviewed-entities
  if (method === "GET" && parts.length === 2 && parts[1] === "unreviewed-entities") {
    const w = resolveWorld(q.get("world"));
    const maxAgeDays = q.get("maxAgeDays") ? Number(q.get("maxAgeDays")) : undefined;
    const maxUnreviewedAccepts = q.get("maxUnreviewedAccepts") ? Number(q.get("maxUnreviewedAccepts")) : undefined;
    const flagged = findUnreviewedEntities(w, { maxAgeDays, maxUnreviewedAccepts });
    return sendJson(res, 200, {
      world: w,
      defaults: { maxAgeDays: DEFAULT_MAX_AGE_DAYS, maxUnreviewedAccepts: DEFAULT_MAX_UNREVIEWED_ACCEPTS },
      entities: flagged
    });
  }

  // GET /api/pending-entities
  if (method === "GET" && parts.length === 2 && parts[1] === "pending-entities") {
    const dir = resolveDir(q.get("dataDir"));
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { world: w, entities: pendingEntitiesPayload(w, dir) });
  }

  // POST /api/pending-entities/:entityId/resolve  { world, dataDir, depth, maxNeighbors, elapsedTimeDescriptor }
  if (method === "POST" && parts.length === 4 && parts[1] === "pending-entities" && parts[3] === "resolve") {
    const body = await readBody(req);
    const dir = resolveDir(body.dataDir);
    const w = resolveWorld(body.world);
    const { entities, edges } = loadSnapshot(dir, w).snapshot;
    const result = await resolvePending(
      w,
      parts[2],
      { depth: body.depth, maxNeighbors: body.maxNeighbors },
      { entities, edges, elapsedTimeDescriptor: body.elapsedTimeDescriptor }
    );
    return sendJson(res, 200, result);
  }

  // ---------------------------------------------------------------------
  // Phase 7 -- graph data route (task 7.1).
  // GET /api/graph?world=...&dataDir=...&batchId=...&depth=...   (batch-scoped, with persisted one-hop context)
  // GET /api/graph?world=...&dataDir=...&filter=...              (standalone whole-graph; filter omitted -> flagged-only default)
  // ---------------------------------------------------------------------
  if (method === "GET" && parts.length === 2 && parts[1] === "graph") {
    const w = resolveWorld(q.get("world"));
    const dir = resolveDir(q.get("dataDir"));
    if (q.get("batchId")) {
      const depth = q.get("depth") ? Number(q.get("depth")) : 1;
      return sendJson(res, 200, graphPayloadForBatch(w, dir, q.get("batchId"), depth));
    }
    return sendJson(res, 200, graphPayloadStandalone(w, dir, q.get("filter")));
  }

  // ---------------------------------------------------------------------
  // Phase 8 — rubber-duck mode: settings + the two-phase writeup flow.
  // ---------------------------------------------------------------------

  // GET /api/settings/rubber-duck
  if (method === "GET" && parts.length === 3 && parts[1] === "settings" && parts[2] === "rubber-duck") {
    return sendJson(res, 200, getUserSettings().rubberDuckMode);
  }

  // POST /api/settings/rubber-duck  { enabled }
  if (method === "POST" && parts.length === 3 && parts[1] === "settings" && parts[2] === "rubber-duck") {
    const body = await readBody(req);
    if (typeof body.enabled !== "boolean") {
      throw new Error("POST /api/settings/rubber-duck requires a boolean `enabled` field.");
    }
    return sendJson(res, 200, setRubberDuckMode(body.enabled).rubberDuckMode);
  }

  // POST /api/writeup-propose  { world, dataDir, text, mode }
  // Phase A of the two-phase flow (mirrors wf_propose_from_writeup). Rubber-duck
  // OFF: returns importWriteup()'s own result unchanged, a real batch is created.
  // Rubber-duck ON: returns {phase:'framing', framings, writeupText, mode, rubberDuck} --
  // no batch created yet.
  if (method === "POST" && parts.length === 2 && parts[1] === "writeup-propose") {
    const body = await readBody(req);
    const dir = resolveDir(body.dataDir);
    const w = resolveWorld(body.world);
    if (typeof body.text !== "string" || !body.text.trim()) {
      throw new Error("POST /api/writeup-propose requires a non-empty `text` field.");
    }
    const result = await proposeFromWriteupOp(dir, w, { text: body.text, mode: body.mode });
    return sendJson(res, 200, result);
  }

  // POST /api/writeup-select-framing  { world, dataDir, writeupText?, batchId?, mode, framings, selection, rubberDuck? }
  // Phase B: either creates a new batch (writeupText path, the reviewer's
  // first pick) or replaces an existing batch's mutations (batchId path,
  // the reviewer's pick after a plain-reject-triggered re-framing round).
  if (method === "POST" && parts.length === 2 && parts[1] === "writeup-select-framing") {
    const body = await readBody(req);
    const dir = resolveDir(body.dataDir);
    const w = resolveWorld(body.world);
    if (body.batchId) {
      const result = await selectFramingForExistingBatch(dir, w, {
        batchId: body.batchId,
        framings: body.framings,
        selection: body.selection
      });
      return sendJson(res, 200, result);
    }
    if (!body.writeupText) {
      throw new Error("POST /api/writeup-select-framing requires either `batchId` or `writeupText`.");
    }
    const result = await selectFramingForNewBatch(dir, w, {
      writeupText: body.writeupText,
      mode: body.mode,
      framings: body.framings,
      selection: body.selection,
      rubberDuck: body.rubberDuck
    });
    return sendJson(res, 200, result);
  }

  sendJson(res, 404, { error: `No route: ${req.method} ${url.pathname}` });
}

// Guard the actual listen() behind an entrypoint check so this module can be
// imported by tests (spinning up its own server on an ephemeral port)
// without also starting a second server on DEFAULT_PORT.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = process.env.REVIEW_UI_PORT ? Number(process.env.REVIEW_UI_PORT) : DEFAULT_PORT;
  createReviewServer({ port });
  console.log(`review-ui server listening on http://localhost:${port}`);
  console.log(`  WF_DATA_DIR=${process.env.WF_DATA_DIR ?? "(not set -- pass dataDir explicitly or set this)"}`);
  console.log(`  WF_DEFAULT_WORLD=${process.env.WF_DEFAULT_WORLD ?? "(not set -- pass world explicitly or set this)"}`);
}
