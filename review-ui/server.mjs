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
 *
 * SECURITY: this server has NO authentication layer of its own -- every
 * route below is reachable by anyone who can reach the port (this project's
 * own documented remote-access recommendation is a mesh VPN like Tailscale,
 * specifically because this file has nothing to authenticate a request
 * with). Given that, every route calls the shared resolveDir() with NO
 * argument, deliberately never forwarding a client-supplied `dataDir` from
 * `body`/the query string into it, even though wf-mcp-server/lib/resolve.mjs's
 * resolveDir() function itself still accepts an explicit override (needed
 * there for the MCP tool surface, which is local/trusted, spawned directly
 * by a Claude Code session over stdio, never network-facing). Found via a
 * real security review: resolveDir(explicit) and resolveWorld(world) both
 * used to pass an unvalidated client string straight into join()-based file
 * paths across all seven of this project's flat-JSON stores plus the
 * snapshot/mutations-bridge paths -- node:path's join() does not stop `..`
 * traversal, so an unauthenticated request with a crafted `dataDir` was a
 * real arbitrary-file-read/write primitive scoped to whatever this Node
 * process's OS user can touch, not just "read/write your campaign data."
 * Fixed by removing the untrusted input from this file entirely (dataDir
 * always resolves from WF_DATA_DIR/OS-default here, never from a request)
 * rather than trying to validate an arbitrary path string -- a validator
 * is one more thing that can itself have a bug (symlinks, encoding,
 * normalization edge cases); not accepting the input at all has no such
 * failure mode. `world` is separately hardened at its source in
 * resolve.mjs's own resolveWorld() (format-restricted, not removed --
 * unlike dataDir, a world id is a genuinely meaningful client-supplied
 * value here, e.g. switching worlds from the UI's own dropdown).
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { listWorlds } from "../wf-mcp-server/lib/data-dir.mjs";
import { loadSnapshot, snapshotFilePath } from "../wf-mcp-server/lib/snapshot.mjs";
import { resolveWorld, resolveDir } from "../wf-mcp-server/lib/resolve.mjs";
import { findEntity, neighborhood } from "../wf-mcp-server/lib/graph.mjs";
import { bootstrapSnapshot } from "../graph-import/headless-apply.mjs";

import { loadBatch, listBatches } from "../mutation-engine/review-state.mjs";
import { summarizeBatch } from "../mutation-engine/grain.mjs";
import { findUnreviewedEntities, markHumanReviewed, DEFAULT_MAX_AGE_DAYS, DEFAULT_MAX_UNREVIEWED_ACCEPTS } from "../mutation-engine/human-review.mjs";
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
  narrateEntityStandaloneOp,
  getEntityNarrationOp,
  getEntityNarrationHistoryOp,
  scanMentionsOp,
  patchPendingMutationData,
  redirectMentionScanRowToExistingOp
} from "../wf-mcp-server/lib/mutation-ops.mjs";

// Phase 12 tasks 12.3/12.4/12.6 -- manual node/edge create/edit/delete,
// the single-slot "Undo Last Manual Edit" mechanism, and narration reset.
// Deliberately NOT exposed as MCP tools -- see manual-edit-ops.mjs's own
// top-of-file doc comment for why (manual edits bypass the review gate by
// design; an LLM-driven MCP call reaching this same unreviewed write path
// would undermine the no-silent-auto-write invariant this whole project is
// built around).
import {
  addNodeOp,
  addEdgeOp,
  editNodeOp,
  editEdgeOp,
  deleteNodeOp,
  deleteEdgeOp,
  resetEntityNarrationOp,
  undoLastManualEditOp,
  getManualUndoStatusOp,
  getManualEditSyncStatusOp
} from "../wf-mcp-server/lib/manual-edit-ops.mjs";

// Phase 11 -- per-node content generation ("develop this node"). A
// deliberately separate operations module from mutation-ops.mjs above (see
// mutation-engine/prep-content.mjs's own doc comment) -- none of these
// routes take a batchId, so this surface is not reachable from Batch
// Review even in principle.
import {
  proposePrepFramingsOp,
  reframePrepFramingsOp,
  generatePrepContentOp,
  getPrepContentOp,
  acceptPrepContentOp,
  discardPrepContentOp,
  regeneratePrepFieldOp,
  markPrepContentStaleOp
} from "../wf-mcp-server/lib/prep-content-ops.mjs";

// Phase 16 -- Session Planner engine (task 16.6). Thin wrappers only, same
// convention as every other route in this file: resolveWorld/resolveDir()
// with NO client-supplied dataDir override anywhere below.
import { createScene, forkScene, getScene, listScenesForWorld, renameScene, deleteScene } from "../session-planner/scenes.mjs";
import { buildSessionBrief } from "../session-planner/brief.mjs";
import { captureNote, runBatchIntake } from "../session-planner/session-notes.mjs";

// Phase 18 -- Encounter Guidance engine (task 18.7). Thin wrappers only,
// same convention as every other route in this file: resolveWorld()/
// resolveDir() with NO client-supplied dataDir override anywhere below.
// Bestiary routes are deliberately NEVER world-scoped (bestiary-store.mjs's
// own per-user/library-wide storage decision, task 18.1) -- party-roster and
// encounter-suggest ARE world-scoped, same as session-planner's own routes
// above.
import { buildAdjacencyContext, DEFAULT_ENTITY_NARRATE_DEPTH } from "../mutation-engine/narrate.mjs";
import { proposeBestiaryEntryFromText, proposeBestiaryEntryFromPdf } from "../combat-planning/bestiary-ingest.mjs";
import {
  saveBestiaryEntry,
  listBestiaryEntries,
  acceptBestiaryEntry,
  discardBestiaryEntry
} from "../combat-planning/bestiary-store.mjs";
import { proposePartyMemberFromText, proposePartyMemberFromPdf } from "../combat-planning/party-roster-ingest.mjs";
import { savePartyMember, listPartyMembers } from "../combat-planning/party-roster-store.mjs";
import { proposeThematicTags } from "../combat-planning/thematic-filter.mjs";
import { suggestEncounter, scoreCombination } from "../combat-planning/encounter-heuristic.mjs";

// Phase 22 (task 22.7) -- Scene Engine routes. Thin wrappers only, same
// convention as every other route in this file: resolveWorld()/resolveDir()
// with NO client-supplied dataDir override anywhere below. getScene is
// already imported above (Phase 16's session-planner import block) and
// reused here unmodified.
import { linkedScenesForScene } from "../session-planner/scene-linkage.mjs";
import { createTransitEntity } from "../session-planner/transit-entity.mjs";
import { addNodeToScene, removeNodeFromScene, getSceneMembership, offerInterveningNodes } from "../session-planner/scene-membership.mjs";
import {
  startSceneUndoSession,
  listSceneUndoActions,
  recordSceneUndoAction,
  undoLastSceneAction,
  undoAllSceneActions,
  clearSceneUndoSession
} from "../mutation-engine/scene-undo.mjs";

// Phase 26 task 26.1 -- Plan store. Thin wrappers only, same convention as
// every other route in this file: resolveWorld() with NO client-supplied
// dataDir override anywhere below (the store never touches the graph
// snapshot at all).
import { createPlan, getPlan, listPlansForWorld, addSceneToPlan, removeSceneFromPlan } from "../session-planner/plans.mjs";

// Phase 26 task 26.3 -- scene-link store, §26.C. Thin wrappers only, same
// convention as every other route in this file: resolveWorld() with NO
// client-supplied dataDir override anywhere below (the store never touches
// the graph snapshot at all -- deliberately, per §26.C's "dedicated store,
// not graph entities" decision).
import { linkScenes, unlinkScenes, getLinkedScenes } from "../session-planner/scene-links.mjs";

// Phase 26 task 26.9, §26.E -- post-session graph update. Thin composition
// only: proposeUpdatesForPlan (session-planner/plan-updates.mjs) assembles
// a Plan's scenes' notes then delegates straight to the EXISTING,
// completely unmodified importWriteup -- no logic duplicated here.
import { proposeUpdatesForPlan } from "../session-planner/plan-updates.mjs";

// Phase 26 task 26.10, §26.F -- "Drop this into Foundry". Lives directly
// under review-ui/ (not wf-mcp-server/lib/) -- see foundry-push.mjs's own
// header for why (playwright's runtime dependency only resolves from
// review-ui's own node_modules).
import { pushEntityToFoundry } from "./foundry-push.mjs";
import { developScene } from "../mutation-engine/scene-develop.mjs";
import { quickGenerate } from "../mutation-engine/quick-gen.mjs";

// Phase 22 ADDENDUM -- "Add Encounter" persistence (plans/phase-21-review.md
// §6: equal-weight sibling of "Add Event"/session-notes.mjs's captureNote).
// Thin wrapper only, same convention as every route in this file/block.
import {
  saveEncounter,
  listEncountersForScene,
  removeSavedEncounter,
  listEncountersForWorld,
  attachEncounterToScene,
  detachEncounterFromScene
} from "../combat-planning/saved-encounter.mjs";
// Only used to distinguish "the Anthropic API itself failed" (502, an
// upstream/infra problem) from "this codebase's own library modules threw a
// deliberate validation error" (400) in statusForError below -- see that
// function's own Phase 18 branch.
import { AnthropicError } from "@anthropic-ai/sdk";

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
  // Phase 11: same conflict, one level down (a single entity's prep-content
  // framing round, not a whole writeup-import batch).
  if (err.name === "PrepFramingRoundLimitError") return 409;
  if (err.name === "NoNarratableBatchError") return 404; // task 14.7: no accepted mutation exists yet for this entity
  if (/already exists/i.test(err.message ?? "")) return 409; // task 14.2: creating a world id that's already taken
  if (/no (batch|region|entity|world|snapshot) found/i.test(err.message ?? "")) return 404;
  if (/not found/i.test(err.message ?? "")) return 404;
  // Phase 18 task 18.7: an LLM-touching route (bestiary/party-roster ingest,
  // encounter-suggest's thematic filter) that failed because the Anthropic
  // API itself couldn't be reached/authenticated is a genuine upstream/infra
  // failure, not a caller-facing validation problem -- must NOT collapse
  // into the same 400 every deliberate validation throw uses, or a route
  // whose world/dataDir handling is completely correct would look
  // indistinguishable from one that rejected the request outright (exactly
  // the distinction review-ui/test/combat-planning-routes.test.mjs's own
  // dataDir-never-honored test on encounter-suggest checks for). Caught two
  // ways: a real AnthropicError instance (an actual failed/rejected HTTP
  // call), or the SDK's own pre-request "Could not resolve authentication
  // method" check (a plain Error, not an AnthropicError subclass, thrown
  // when no API key is configured at all -- as will be the case in this
  // project's own deterministic test runs, which never set one).
  if (err instanceof AnthropicError || /Could not resolve authentication method/i.test(err.message ?? "")) return 502;
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
  // Phase 17 task 17.0/17.3: review-ui/public/debounced-save.mjs is a real
  // ES module imported by session-planner-view.js -- without this, the
  // browser fetches it, gets served as application/octet-stream (the
  // extname()-miss fallback below), and refuses to load it as a module
  // script (strict MIME-type enforcement per the HTML spec), silently
  // breaking the ENTIRE app.js module graph (every other view along with
  // it) since app.js -> session-planner-view.js -> debounced-save.mjs is one
  // static import chain. Found by actually driving this in a browser, not
  // from reading the JS alone -- every pre-existing e2e test started failing
  // too, which is what surfaced it.
  ".mjs": "text/javascript; charset=utf-8",
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

// ---------------------------------------------------------------------------
// Task 14.8 (QA-pass finding): scan-for-mentioned-entities had no
// cancellation and no duplicate-request guard -- navigating away while a
// scan was in flight didn't cancel it server-side (it silently completed
// and created a batch the user never saw appear), and the natural "nothing
// seemed to happen, let me click it again" retry created a second, fully
// redundant batch, wasting an LLM call.
//
// Server-side half of the fix (paired with an AbortController on the
// frontend, review-ui/public/app.js): a lightweight, IN-MEMORY (this
// process only -- not a new persisted data store, proportionate to the
// actual risk per the task's own "don't over-engineer a general
// request-deduplication framework" guidance) guard against firing a second
// genuinely-identical scan (same world, same source entity, same text)
// while one is still in flight OR was very recently completed -- returns
// the SAME result instead of starting a new one.
// ---------------------------------------------------------------------------
const SCAN_DEDUPE_WINDOW_MS = 10_000; // "very recently completed" -- long enough to absorb a confused retry-click, short enough to never mask a genuinely new request
const recentScans = new Map(); // key -> { promise, settledAt: number|null }

function scanDedupeKey(w, entityId, text) {
  return `${w}::${entityId}::${text}`;
}

/**
 * Runs `runScan()` (the real scanMentionsOp call) UNLESS an identical scan
 * (same key) is already in flight or settled within SCAN_DEDUPE_WINDOW_MS,
 * in which case the same promise/result is reused. `runScan` is a thunk
 * (not eagerly invoked) so a deduped call never triggers a second LLM call
 * even speculatively.
 */
function dedupedScan(w, entityId, text, runScan) {
  const key = scanDedupeKey(w, entityId, text);
  const existing = recentScans.get(key);
  const now = Date.now();
  if (existing && (existing.settledAt === null || now - existing.settledAt < SCAN_DEDUPE_WINDOW_MS)) {
    return existing.promise;
  }
  const promise = runScan();
  const entry = { promise, settledAt: null };
  recentScans.set(key, entry);
  promise.then(
    () => {
      entry.settledAt = Date.now();
      // Self-review remediation: without this, a successfully-settled entry
      // would sit in `recentScans` for the server process's ENTIRE lifetime
      // (only ever unreachable, never removed) -- an unbounded-growth leak
      // over a long-running session with many distinct (world, entity,
      // text) scans. Bound it to roughly "the current dedupe window's worth
      // of history" instead -- only remove THIS entry, and only if nothing
      // newer has already replaced it under the same key.
      setTimeout(() => { if (recentScans.get(key) === entry) recentScans.delete(key); }, SCAN_DEDUPE_WINDOW_MS).unref?.();
    },
    () => { recentScans.delete(key); } // a failed scan should NOT be cached -- a real retry after an error must actually retry
  );
  return promise;
}

// Exported for direct, deterministic unit testing of the dedup mechanism
// itself (no real LLM call needed -- see test/scan-dedupe.test.mjs)
// separately from the real-API end-to-end proof in routes-live.smoke.mjs.
export { dedupedScan, recentScans as __testOnlyRecentScans };

/**
 * GET /api/unreviewed-entities payload: every flagged entity, plus a real
 * display name looked up from the live snapshot -- task 14.6 (QA-pass
 * finding, confirmed independently by BOTH personas). Mirrors
 * pendingEntitiesPayload's exact same "look up from the live snapshot,
 * degrade gracefully to the raw id if there's no snapshot yet" convention
 * immediately below, rather than a second lookup approach.
 */
function unreviewedEntitiesPayload(w, dir, opts) {
  const flagged = findUnreviewedEntities(w, opts);
  let entities = [];
  try {
    ({ entities } = loadSnapshot(dir, w).snapshot);
  } catch {
    // No snapshot yet is fine here -- flagged entries can still be listed by id, just without a friendly name.
  }
  return flagged.map((f) => ({ ...f, name: findEntity(entities, f.entityId)?.name ?? f.entityId }));
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
 * `null` for "show everything." Task 7.4 originally shipped with
 * flagged-only as the default (filter omitted); real usage reversed that --
 * having to hit "Show everything" on every single visit was the actual
 * complaint. Omitting the param (or passing `all`, or a param with no
 * recognizable tokens) now all mean "show everything"; only an explicit,
 * recognized token list narrows the result.
 */
function parseGraphFilter(raw) {
  if (!raw || raw === "all") return null;
  const tokens = raw.split(",").map((t) => t.trim()).filter((t) => GRAPH_STATUS_FILTER_TOKENS.has(t));
  return tokens.length ? new Set(tokens) : null;
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

// Phase 12 task 12.2: matches foundry_worldFabric's own
// game.settings default for SETTINGS.staleThreshold (see
// llm-context.mjs's own `staleThreshold = 3` default and
// graph-service.mjs's `?? 3` fallback) -- a best-effort constant, not a
// live per-world read. Metadata nomination #5 ("surface already-existing
// fields") was explicitly confirmed GM_Tools-side-only/no-schema-change,
// so exporting the live per-world override into the snapshot meta is out
// of scope here; this reproduces WF's OWN default rather than inventing a
// different one.
const DEFAULT_STALE_THRESHOLD = 3;

/** Same recency-staleness formula as llm-context.mjs's budgetedContext (session-count based, not wall-clock). */
function isSessionStale(entity, sessionNumber) {
  return sessionNumber > 0 && entity.sessionSeen != null && (sessionNumber - entity.sessionSeen) >= DEFAULT_STALE_THRESHOLD;
}

/**
 * Phase 12 task 12.2: adds importance, session-staleness, foundryRef
 * presence, and the four new World Fabric entity fields (status/
 * playerKnown/canonLocked/role, task 12.1) to the existing node payload --
 * pure additive UI wiring over already-fetchable snapshot data, no new
 * backend logic. A synthetic/proposed-only entity (a batch-mode create with
 * no persisted counterpart, or an in-flight manual-edit placeholder) simply
 * has these come back `null`/`false`, same as every other already-optional
 * field this function produces.
 */
function graphNodePayload(entity, { degrees, flaggedIds, debtIds, proposed, sessionNumber }) {
  return {
    id: entity.id,
    name: entity.name ?? entity.id,
    type: entity.type ?? "unknown",
    degree: degrees.get(entity.id) ?? 0,
    flaggedUnreviewed: flaggedIds.has(entity.id),
    hasDeferredDebt: debtIds.has(entity.id),
    importance: typeof entity.importance === "number" ? entity.importance : null,
    hasFoundryRef: !!entity.foundryRef,
    sessionStale: isSessionStale(entity, sessionNumber ?? 0),
    lastSession: entity.lastSession ?? null,
    description: entity.description ?? "",
    status: entity.status ?? null,
    playerKnown: entity.playerKnown ?? null,
    canonLocked: entity.canonLocked ?? false,
    role: entity.role ?? null,
    // Phase 25 task 25.3: same additive-payload-growth pattern as the
    // task 19.6 comment above -- foundry_worldFabric/scripts/data/
    // graph-service.mjs's upsertEntity already persists summary/imageUrl/
    // tags (confirmed directly), but this route never returned them, so
    // Table Mode's member-roster nested-expand zone (description/summary/
    // imageUrl/tags) had nothing to read. Pure additive UI wiring over
    // already-fetchable snapshot data, no new backend logic, no new route.
    summary: entity.summary ?? "",
    imageUrl: entity.imageUrl ?? null,
    tags: Array.isArray(entity.tags) ? entity.tags : [],
    // Phase 19 task 19.6: a small, additive, backward-compatible response
    // field (same category of change as the Phase 18 addendum's additive
    // REQUEST fields on encounter-suggest -- growing an EXISTING route's
    // payload, not a new route) -- combat-planning-view.js's Resync-from-
    // Foundry button reads a WF entity's own already-stored generic
    // `attributes` bag (matched to a PartyMember by name) as the closest
    // real "read live data via the existing snapshot/file-bridge" path
    // available: WF graph entities have no dedicated hp field of their own
    // (confirmed by reading entity-schema/graphNodePayload fresh), so this
    // is a genuine, flagged gap, not an established convention being
    // reused -- see combat-planning-view.js's own header comment for the
    // full reasoning.
    attributes: entity.attributes ?? {},
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
    // Phase 12 task 12.2/12.3: the edge popover (new work) needs these to
    // render/pre-fill an edit form -- absent from Phase 7's original
    // read-only payload, which only ever rendered a line + optional arrow.
    strength: typeof edge.strength === "number" ? edge.strength : null,
    valence: edge.valence ?? null,
    notes: edge.notes ?? null,
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
  let sessionNumber = 0;
  try {
    const loaded = loadSnapshot(dir, w);
    ({ entities, edges } = loaded.snapshot);
    sessionNumber = loaded.meta?.sessionNumber ?? 0;
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
    nodesById.set(e.id, graphNodePayload(e, { degrees, flaggedIds, debtIds, proposed: true, sessionNumber }));
  }
  for (const e of contextEntities.values()) {
    nodesById.set(e.id, graphNodePayload(e, { degrees, flaggedIds, debtIds, proposed: proposedEntityIds.has(e.id), sessionNumber }));
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
  let sessionNumber = 0;
  try {
    const loaded = loadSnapshot(dir, w);
    ({ entities, edges } = loaded.snapshot);
    sessionNumber = loaded.meta?.sessionNumber ?? 0;
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

  const nodes = selected.map((e) => graphNodePayload(e, { degrees, flaggedIds, debtIds, sessionNumber }));
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
    const dir = resolveDir();
    return sendJson(res, 200, { dataDir: dir, worlds: listWorlds(dir) });
  }

  // POST /api/worlds  { world, dataDir }
  // Task 14.2: bootstrapSnapshot() (graph-import/headless-apply.mjs) already
  // existed and was already tested, but was never called from any production
  // code path -- a genuinely new campaign with no prior Foundry world had no
  // UI affordance to create one at all, a hard wall on New Import. This wires
  // it into a real, reachable route: create an empty standalone snapshot for
  // a brand-new world id, which listWorlds() (GET /api/worlds, above) picks
  // up immediately since it just checks for an on-disk snapshot file.
  if (method === "POST" && parts.length === 2 && parts[1] === "worlds") {
    const body = await readBody(req);
    const dir = resolveDir();
    const worldId = typeof body.world === "string" ? body.world.trim() : "";
    if (!worldId || !/^[a-zA-Z0-9_-]+$/.test(worldId)) {
      throw new Error(
        "POST /api/worlds requires a non-empty `world` id using only letters, digits, hyphens, and underscores " +
        "(it becomes a directory name on disk)."
      );
    }
    const snapPath = snapshotFilePath(dir, worldId);
    if (existsSync(snapPath)) {
      throw new Error(`World "${worldId}" already exists at ${snapPath} -- pick a different id, or select it from the existing worlds list instead.`);
    }
    bootstrapSnapshot(snapPath, { worldId });
    return sendJson(res, 200, { world: worldId, dataDir: dir, created: true });
  }

  // GET /api/batches
  if (method === "GET" && parts.length === 2 && parts[1] === "batches") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { world: w, batches: listBatches(w) });
  }

  // GET /api/entities/:entityId?world=&dataDir=  -- a single committed entity's own
  // record from the live snapshot (name/type/description/etc.), no edges/narration/prep
  // attached. Backs Phase 11's entity-detail view header (task 11.5); the narration and
  // prep-content sub-resources below are fetched separately by the same page.
  if (method === "GET" && parts.length === 3 && parts[1] === "entities") {
    const w = resolveWorld(q.get("world"));
    const dir = resolveDir();
    const { entities } = loadSnapshot(dir, w).snapshot;
    const entity = findEntity(entities, parts[2]);
    if (!entity) throw new Error(`No committed entity "${parts[2]}" found in world "${w}"'s live snapshot.`);
    return sendJson(res, 200, { entity });
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
    const dir = resolveDir();
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
    const dir = resolveDir();
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
    const dir = resolveDir();
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
    const dir = resolveDir();
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
    const dir = resolveDir();
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

  // POST /api/entities/:entityId/narrate  { world, dataDir, note }
  // Task 14.7: "Narrate This" from the standalone entity page, which has no
  // batchId of its own to call narrate-entity with directly. Looks up the
  // most recent batch/mutation that genuinely addressed this entity and
  // narrates that (narrateEntityStandaloneOp); throws NoNarratableBatchError
  // (mapped to a clean 404 below, never a silent no-op) if nothing ever has.
  if (method === "POST" && parts.length === 4 && parts[1] === "entities" && parts[3] === "narrate") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await narrateEntityStandaloneOp(dir, w, { entityId: parts[2], note: body.note });
    return sendJson(res, 200, result);
  }

  // POST /api/entities/:entityId/foundry-push  { world }
  // Phase 26 task 26.10, §26.F -- "Drop this into Foundry" (replaces
  // buildPlayerKnownGate). Genuinely slow/external (headless Chromium login
  // + ChatMessage.create) -- world is resolved/validated FIRST, before any
  // of that runs.
  if (method === "POST" && parts.length === 4 && parts[1] === "entities" && parts[3] === "foundry-push") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await pushEntityToFoundry(dir, w, parts[2]);
    return sendJson(res, 200, result);
  }

  // POST /api/batches/:batchId/sync  { world, dataDir }
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "sync") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await syncOp(dir, w, { batchId: parts[2] });
    return sendJson(res, 200, result);
  }

  // POST /api/batches/:batchId/rollback  { world, dataDir }
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "rollback") {
    const body = await readBody(req);
    const dir = resolveDir();
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
    const dir = resolveDir();
    const maxAgeDays = q.get("maxAgeDays") ? Number(q.get("maxAgeDays")) : undefined;
    const maxUnreviewedAccepts = q.get("maxUnreviewedAccepts") ? Number(q.get("maxUnreviewedAccepts")) : undefined;
    return sendJson(res, 200, {
      world: w,
      defaults: { maxAgeDays: DEFAULT_MAX_AGE_DAYS, maxUnreviewedAccepts: DEFAULT_MAX_UNREVIEWED_ACCEPTS },
      entities: unreviewedEntitiesPayload(w, dir, { maxAgeDays, maxUnreviewedAccepts })
    });
  }

  // POST /api/unreviewed-entities/:entityId/mark-reviewed  { world }
  // Real gap found via hands-on use: a flagged entity only ever cleared by
  // being individually expanded inside SOME open batch that happened to
  // touch it -- an entity with no current open batch (or one the GM doesn't
  // want to open just to dismiss a flag) had no way to be acknowledged at
  // all, so it sat in "Long-unreviewed entities" indefinitely. This is a
  // standalone dismiss, no batch context required -- markHumanReviewed()
  // itself never depended on one.
  if (method === "POST" && parts.length === 4 && parts[1] === "unreviewed-entities" && parts[3] === "mark-reviewed") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    markHumanReviewed(w, [parts[2]]);
    return sendJson(res, 200, { world: w, entityId: parts[2], marked: true });
  }

  // GET /api/pending-entities
  if (method === "GET" && parts.length === 2 && parts[1] === "pending-entities") {
    const dir = resolveDir();
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { world: w, entities: pendingEntitiesPayload(w, dir) });
  }

  // POST /api/pending-entities/:entityId/resolve  { world, dataDir, depth, maxNeighbors, elapsedTimeDescriptor }
  if (method === "POST" && parts.length === 4 && parts[1] === "pending-entities" && parts[3] === "resolve") {
    const body = await readBody(req);
    const dir = resolveDir();
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
    const dir = resolveDir();
    if (q.get("batchId")) {
      const depth = q.get("depth") ? Number(q.get("depth")) : 1;
      return sendJson(res, 200, graphPayloadForBatch(w, dir, q.get("batchId"), depth));
    }
    return sendJson(res, 200, graphPayloadStandalone(w, dir, q.get("filter")));
  }

  // ---------------------------------------------------------------------
  // Phase 12 tasks 12.3/12.4 — manual node/edge create/edit/delete, and
  // "Undo Last Manual Edit". Every write here is IMMEDIATE, no review gate
  // (plans/phase-12-review.md decision 1) -- deliberately NOT exposed as MCP
  // tools, see manual-edit-ops.mjs's own doc comment.
  // ---------------------------------------------------------------------

  // POST /api/graph/nodes  { world, dataDir, name, type, description?, importance?, tags?, status?, playerKnown?, canonLocked?, role? }
  if (method === "POST" && parts.length === 3 && parts[1] === "graph" && parts[2] === "nodes") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await addNodeOp(dir, w, body);
    return sendJson(res, 200, result);
  }

  // POST /api/graph/edges  { world, dataDir, sourceId, targetId, relationshipType?, label?, strength?, valence?, notes? }
  if (method === "POST" && parts.length === 3 && parts[1] === "graph" && parts[2] === "edges") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await addEdgeOp(dir, w, body);
    return sendJson(res, 200, result);
  }

  // PATCH-style: POST /api/graph/nodes/:entityId  { world, dataDir, data:{...} }
  if (method === "POST" && parts.length === 4 && parts[1] === "graph" && parts[2] === "nodes") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await editNodeOp(dir, w, { entityId: parts[3], data: body.data });
    return sendJson(res, 200, result);
  }

  // POST /api/graph/edges/:edgeId  { world, dataDir, data:{...} }
  if (method === "POST" && parts.length === 4 && parts[1] === "graph" && parts[2] === "edges") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await editEdgeOp(dir, w, { edgeId: parts[3], data: body.data });
    return sendJson(res, 200, result);
  }

  // DELETE /api/graph/nodes/:entityId  { world, dataDir } (query or body — accept both, body is simpler for fetch())
  if (method === "DELETE" && parts.length === 4 && parts[1] === "graph" && parts[2] === "nodes") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world ?? q.get("world"));
    const result = await deleteNodeOp(dir, w, { entityId: parts[3] });
    return sendJson(res, 200, result);
  }

  // DELETE /api/graph/edges/:edgeId  { world, dataDir }
  if (method === "DELETE" && parts.length === 4 && parts[1] === "graph" && parts[2] === "edges") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world ?? q.get("world"));
    const result = await deleteEdgeOp(dir, w, { edgeId: parts[3] });
    return sendJson(res, 200, result);
  }

  // GET /api/manual-edit-sync-status?world=...  -- Phase 13 task 13.1: "N
  // manual edits not yet synced to Foundry" affordance. Syncing reuses the
  // EXISTING /api/batches/:batchId/sync route below (syncOp) unmodified --
  // this route only reports which batchId to point that route at.
  if (method === "GET" && parts.length === 2 && parts[1] === "manual-edit-sync-status") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, getManualEditSyncStatusOp(w));
  }

  // GET /api/manual-undo?world=...  -- toolbar/toast status, read-only, never consumes the slot
  if (method === "GET" && parts.length === 2 && parts[1] === "manual-undo") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, getManualUndoStatusOp(w));
  }

  // POST /api/manual-undo  { world, dataDir }  -- consumes and applies the single undo slot
  if (method === "POST" && parts.length === 2 && parts[1] === "manual-undo") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await undoLastManualEditOp(dir, w);
    return sendJson(res, 200, result);
  }

  // ---------------------------------------------------------------------
  // Phase 12 task 12.6 — narration reset. Covered by the same undo
  // mechanism above (a reset's undo is a narrationUndo action, not a
  // graphMutations one — see manual-edit-ops.mjs's resetEntityNarrationOp).
  // ---------------------------------------------------------------------

  // POST /api/entities/:entityId/narration/reset  { world }
  if (method === "POST" && parts.length === 5 && parts[1] === "entities" && parts[3] === "narration" && parts[4] === "reset") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const result = resetEntityNarrationOp(w, { entityId: parts[2] });
    return sendJson(res, 200, result);
  }

  // ---------------------------------------------------------------------
  // Phase 12 task 12.5 — scan for mentioned entities. Routes through the
  // EXISTING batch/accept/reject/regenerate flow (decision 3) -- this is a
  // normal review-state.mjs batch, not the manual-edit immediate-write path.
  // ---------------------------------------------------------------------

  // POST /api/entities/:entityId/scan-mentions  { world, dataDir, text }
  // Task 14.8: a rapid double-trigger of the SAME scan (same world/entity/
  // text) -- whether a genuine double-click, a confused retry after
  // navigating away mid-request, or two tabs -- reuses the same in-flight
  // or very-recently-settled result instead of paying for and creating a
  // second, fully redundant batch. See dedupedScan's own doc comment.
  if (method === "POST" && parts.length === 4 && parts[1] === "entities" && parts[3] === "scan-mentions") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    if (typeof body.text !== "string" || !body.text.trim()) {
      throw new Error("POST .../scan-mentions requires a non-empty `text` field.");
    }
    const result = await dedupedScan(w, parts[2], body.text, () => scanMentionsOp(dir, w, { entityId: parts[2], text: body.text }));
    return sendJson(res, 200, result);
  }

  // POST /api/batches/:batchId/mutations/:mutationId/patch-data  { world, data:{...} }
  // The "editable relationship-type dropdown" primitive (task 12.5's
  // [DECIDED] shape) for a still-PENDING mutation -- generalized as a small
  // reusable capability rather than scan-mentions-specific, but only ever
  // wired into the frontend for scan-mention rows in this phase.
  if (method === "POST" && parts.length === 6 && parts[1] === "batches" && parts[3] === "mutations" && parts[5] === "patch-data") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const result = patchPendingMutationData(w, { batchId: parts[2], mutationId: parts[4], data: body.data });
    return sendJson(res, 200, { ok: true, batchId: result.id });
  }

  // POST /api/batches/:batchId/mutations/:mutationId/redirect-to-existing
  //   { world, existingEntityId, existingEntityName? }
  // Phase 13 task 13.3: a "propose new" mention-scan row, redirected to link
  // to an already-existing entity instead of creating a duplicate.
  if (method === "POST" && parts.length === 6 && parts[1] === "batches" && parts[3] === "mutations" && parts[5] === "redirect-to-existing") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    if (typeof body.existingEntityId !== "string" || !body.existingEntityId.trim()) {
      throw new Error("POST .../redirect-to-existing requires a non-empty `existingEntityId`.");
    }
    const result = redirectMentionScanRowToExistingOp(dir, w, {
      batchId: parts[2],
      mutationId: parts[4],
      existingEntityId: body.existingEntityId,
      existingEntityName: body.existingEntityName
    });
    return sendJson(res, 200, result);
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
    const dir = resolveDir();
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
    const dir = resolveDir();
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

  // ---------------------------------------------------------------------
  // Phase 11 -- per-node content generation ("develop this node"). Entirely
  // separate from every /api/batches/* route above: no batchId anywhere in
  // this surface, so it is not reachable from Batch Review even in
  // principle. All routes below hang off /api/entities/:entityId/prep(...)
  // -- entityId is an already-committed entity/edge id from the live
  // snapshot, resolved the same way the narration routes above already do.
  // ---------------------------------------------------------------------

  // GET /api/entities/:entityId/prep?world=...
  if (method === "GET" && parts.length === 4 && parts[1] === "entities" && parts[3] === "prep") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, getPrepContentOp(w, { entityId: parts[2] }));
  }

  // POST /api/entities/:entityId/prep/propose-framings  { world, dataDir }
  if (method === "POST" && parts.length === 5 && parts[1] === "entities" && parts[3] === "prep" && parts[4] === "propose-framings") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await proposePrepFramingsOp(dir, w, { entityId: parts[2] });
    return sendJson(res, 200, result);
  }

  // POST /api/entities/:entityId/prep/reframe  { world, dataDir, priorRoundCount }
  if (method === "POST" && parts.length === 5 && parts[1] === "entities" && parts[3] === "prep" && parts[4] === "reframe") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await reframePrepFramingsOp(dir, w, { entityId: parts[2], priorRoundCount: body.priorRoundCount });
    return sendJson(res, 200, result);
  }

  // POST /api/entities/:entityId/prep/generate  { world, dataDir, selection }
  if (method === "POST" && parts.length === 5 && parts[1] === "entities" && parts[3] === "prep" && parts[4] === "generate") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    if (!body.selection) throw new Error("POST .../prep/generate requires a `selection` field.");
    const result = await generatePrepContentOp(dir, w, { entityId: parts[2], selection: body.selection });
    return sendJson(res, 200, result);
  }

  // POST /api/entities/:entityId/prep/accept  { world }
  if (method === "POST" && parts.length === 5 && parts[1] === "entities" && parts[3] === "prep" && parts[4] === "accept") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    return sendJson(res, 200, acceptPrepContentOp(w, { entityId: parts[2] }));
  }

  // POST /api/entities/:entityId/prep/discard  { world }
  if (method === "POST" && parts.length === 5 && parts[1] === "entities" && parts[3] === "prep" && parts[4] === "discard") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    return sendJson(res, 200, discardPrepContentOp(w, { entityId: parts[2] }));
  }

  // POST /api/entities/:entityId/prep/regenerate-field  { world, dataDir, fieldName, note }
  if (method === "POST" && parts.length === 5 && parts[1] === "entities" && parts[3] === "prep" && parts[4] === "regenerate-field") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    if (!body.fieldName) throw new Error("POST .../prep/regenerate-field requires a `fieldName` field.");
    const result = await regeneratePrepFieldOp(dir, w, { entityId: parts[2], fieldName: body.fieldName, note: body.note });
    return sendJson(res, 200, result);
  }

  // POST /api/entities/:entityId/prep/mark-stale  { world }
  if (method === "POST" && parts.length === 5 && parts[1] === "entities" && parts[3] === "prep" && parts[4] === "mark-stale") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    return sendJson(res, 200, markPrepContentStaleOp(w, { entityId: parts[2] }));
  }

  // ---------------------------------------------------------------------
  // Phase 16 -- Session Planner engine (task 16.6). Every route below is a
  // thin wrapper over session-planner/{scenes,brief,session-notes}.mjs --
  // resolveWorld()/resolveDir() with NO argument, exactly like every route
  // above; no route here accepts a client-supplied `dataDir`.
  // ---------------------------------------------------------------------

  // POST /api/session-planner/scenes  { world, locationEntityId?, objectiveNote?, name? }
  if (method === "POST" && parts.length === 3 && parts[1] === "session-planner" && parts[2] === "scenes") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const scene = createScene(w, { locationEntityId: body.locationEntityId, objectiveNote: body.objectiveNote, name: body.name });
    return sendJson(res, 200, { scene });
  }

  // POST /api/session-planner/scenes/:id/fork  { world, locationEntityId?, objectiveNote?, name? }
  if (method === "POST" && parts.length === 5 && parts[1] === "session-planner" && parts[2] === "scenes" && parts[4] === "fork") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const scene = forkScene(w, parts[3], { locationEntityId: body.locationEntityId, objectiveNote: body.objectiveNote, name: body.name });
    return sendJson(res, 200, { scene });
  }

  // GET /api/session-planner/scenes/:id?world=...
  if (method === "GET" && parts.length === 4 && parts[1] === "session-planner" && parts[2] === "scenes") {
    const w = resolveWorld(q.get("world"));
    const scene = getScene(w, parts[3]);
    return sendJson(res, 200, { scene });
  }

  // POST /api/session-planner/scenes/:id/rename  { world, name }  -- Phase 26 task 26.2
  if (method === "POST" && parts.length === 5 && parts[1] === "session-planner" && parts[2] === "scenes" && parts[4] === "rename") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const scene = renameScene(w, parts[3], body.name ?? null);
    return sendJson(res, 200, { scene });
  }

  // DELETE /api/session-planner/scenes/:sceneId   { world } (body or query, matching
  // the sibling members/plan-membership DELETE convention) -- Phase 27 task 27.1, F1.
  // A TRUE delete (scenes.mjs's deleteScene cascade) -- distinct from the plan-scoped
  // DELETE /api/scene-planning/plans/:planId/scenes/:sceneId unlink-only route below.
  if (method === "DELETE" && parts.length === 4 && parts[1] === "session-planner" && parts[2] === "scenes") {
    const body = await readBody(req);
    const w = resolveWorld(body.world ?? q.get("world"));
    const result = deleteScene(w, parts[3]);
    return sendJson(res, 200, result);
  }

  // GET /api/session-planner/brief?world=...&sceneId=...&corridorTolerance=...
  if (method === "GET" && parts.length === 3 && parts[1] === "session-planner" && parts[2] === "brief") {
    const w = resolveWorld(q.get("world"));
    const scene = getScene(w, q.get("sceneId"));
    const dir = resolveDir();
    const { entities, edges } = loadSnapshot(dir, w).snapshot;
    const corridorToleranceRaw = q.get("corridorTolerance");
    const corridorTolerance = corridorToleranceRaw ? Number(corridorToleranceRaw) : undefined;
    const brief = buildSessionBrief(w, { entities, edges }, scene, { corridorTolerance });
    return sendJson(res, 200, { brief });
  }

  // POST /api/session-planner/notes  { world, text, anchorEntityId?, sceneId? }
  if (method === "POST" && parts.length === 3 && parts[1] === "session-planner" && parts[2] === "notes") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const note = captureNote(w, { text: body.text, anchorEntityId: body.anchorEntityId, sceneId: body.sceneId });
    return sendJson(res, 200, { note });
  }

  // POST /api/session-planner/notes/intake  { world, noteIds }
  // Makes a real LLM call via proposeMentionedEntities (runBatchIntake) --
  // world format is validated (resolveWorld) BEFORE any of that runs.
  if (method === "POST" && parts.length === 4 && parts[1] === "session-planner" && parts[2] === "notes" && parts[3] === "intake") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const dir = resolveDir();
    const { entities, edges, entityTypes } = loadSnapshot(dir, w).snapshot;
    const result = await runBatchIntake(w, body.noteIds ?? [], { entities, edges, entityTypes }, {});
    return sendJson(res, 200, result);
  }

  // ---------------------------------------------------------------------
  // Phase 18 (task 18.7) -- Encounter Guidance engine routes. Bestiary
  // routes carry NO `world` concept at all (bestiary-store.mjs's own
  // per-user/library-wide storage decision) -- party-roster and
  // encounter-suggest routes ARE world-scoped via the same resolveWorld()
  // every other world-scoped route in this file already uses. No route
  // here accepts a client-supplied dataDir.
  // ---------------------------------------------------------------------

  // POST /api/combat-planning/bestiary/ingest   { text } or { pdfBase64 }
  // Library-wide -- deliberately no `world` parameter. Makes a real LLM
  // call via bestiary-ingest.mjs's extraction.
  if (method === "POST" && parts.length === 4 && parts[1] === "combat-planning" && parts[2] === "bestiary" && parts[3] === "ingest") {
    const body = await readBody(req);
    const raw = body.pdfBase64
      ? await proposeBestiaryEntryFromPdf(body.pdfBase64, {})
      : await proposeBestiaryEntryFromText(body.text, {});
    const entry = saveBestiaryEntry({
      rawFields: raw,
      sourceText: body.pdfBase64 ? null : body.text,
      sourcePdfName: body.pdfBase64 ? (body.sourcePdfName ?? null) : null
    });
    return sendJson(res, 200, { entry });
  }

  // GET /api/combat-planning/bestiary   -- no `world` parameter (library-wide)
  if (method === "GET" && parts.length === 3 && parts[1] === "combat-planning" && parts[2] === "bestiary") {
    return sendJson(res, 200, { entries: listBestiaryEntries() });
  }

  // POST /api/combat-planning/bestiary/:id/accept
  if (method === "POST" && parts.length === 5 && parts[1] === "combat-planning" && parts[2] === "bestiary" && parts[4] === "accept") {
    const entry = acceptBestiaryEntry(parts[3]);
    return sendJson(res, 200, { entry });
  }

  // POST /api/combat-planning/bestiary/:id/discard
  if (method === "POST" && parts.length === 5 && parts[1] === "combat-planning" && parts[2] === "bestiary" && parts[4] === "discard") {
    const entry = discardBestiaryEntry(parts[3]);
    return sendJson(res, 200, { entry });
  }

  // POST /api/combat-planning/party-roster/ingest   { world, text } or { world, pdfBase64 }
  // World-scoped -- resolveWorld(body.world), no client-supplied dataDir.
  // Makes a real LLM call via party-roster-ingest.mjs's extraction.
  if (method === "POST" && parts.length === 4 && parts[1] === "combat-planning" && parts[2] === "party-roster" && parts[3] === "ingest") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const raw = body.pdfBase64
      ? await proposePartyMemberFromPdf(body.pdfBase64, {})
      : await proposePartyMemberFromText(body.text, {});
    const member = savePartyMember(w, {
      name: raw.name,
      combatRelevant: raw.combatRelevant,
      buildRelevant: raw.buildRelevant,
      sourceText: body.pdfBase64 ? null : body.text,
      sourcePdfName: body.pdfBase64 ? (body.sourcePdfName ?? null) : null
    });
    return sendJson(res, 200, { member });
  }

  // GET /api/combat-planning/party-roster?world=...
  if (method === "GET" && parts.length === 3 && parts[1] === "combat-planning" && parts[2] === "party-roster") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { members: listPartyMembers(w) });
  }

  // POST /api/combat-planning/encounter-suggest
  //   { world, targetDifficulty, sceneEntityId, knobs?, themeText?, attendingMemberIds?, manualCombination? }
  // World format IS validated (resolveWorld) BEFORE any LLM call runs.
  // dataDir is NEVER honored from the client -- resolveDir() with no
  // argument, same as every other route in this file.
  //
  // Phase 18 addendum (QA pass found during Phase 19 task 19.0's
  // test-authoring pass -- see review-ui/test/e2e/combat-planning-fixture.mjs's
  // header comment for the full, authoritative contract this implements):
  // as originally shipped, this route unconditionally called
  // thematic-filter.mjs's proposeThematicTags (a real LLM call) on EVERY
  // request, always against the FULL roster, with no way to score an
  // explicit DM-picked combination -- contradicting plans/phase-19-review.md
  // §2's "deterministic, local, instant, zero LLM calls except the ingestion
  // screen and an explicit, optional theme box" design claim. Three new
  // OPTIONAL, backward-compatible request fields fix this -- a caller using
  // only the original request shape (world/targetDifficulty/sceneEntityId/
  // knobs) still gets a valid { suggestion } response, no new failure mode
  // introduced, per combat-planning-fixture.mjs's own contract:
  //   - themeText: omitted/blank/whitespace-only => proposeThematicTags is
  //     SKIPPED ENTIRELY, candidatePool is the full accepted-bestiary pool
  //     (the same status:"accepted"-only pool the Phase 19 catalog browses),
  //     zero LLM calls -- this IS the new default, deliberately, since the
  //     whole point of this fix is that ordinary difficulty-rail/knob/
  //     attendance interactions never need one. Non-empty => the original
  //     shipped behavior, unchanged (a real proposeThematicTags call,
  //     narrowing that same pool by theme fit).
  //   - attendingMemberIds: when present, `party` is listPartyMembers(w)
  //     filtered to only these ids. Omitted => the full roster, unchanged.
  //   - manualCombination: when present, scores EXACTLY this combination
  //     (via encounter-heuristic.mjs's scoreCombination, applying `knobs` and
  //     computing burstCeiling/snowballDelta/asymmetricRiskFlag the IDENTICAL
  //     way suggestEncounter's own auto-fill does) instead of auto-building
  //     one via targetDifficulty -- looked up against the full accepted
  //     bestiary (not the theme-filtered pool, since a manual pick is an
  //     already-made catalog choice, not something theme-fit should
  //     silently exclude). The response's `combination` echoes back exactly
  //     what was sent. Omitted => the original shipped auto-fill behavior.
  if (method === "POST" && parts.length === 3 && parts[1] === "combat-planning" && parts[2] === "encounter-suggest") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const dir = resolveDir();

    const themeText = typeof body.themeText === "string" ? body.themeText.trim() : "";
    const acceptedPool = () =>
      listBestiaryEntries()
        .filter((e) => e.status === "accepted")
        .map((e) => ({ entryId: e.id, rawFields: e.rawFields, derivedScore: e.derivedScore }));

    let candidatePool;
    if (themeText) {
      // Task 20.5 -- CONFIRMED ROOT CAUSE (reproduced directly, not guessed):
      // this branch used to call loadSnapshot(dir, w) UNCONDITIONALLY, which
      // throws ("No World Fabric snapshot found for world ...") the instant
      // that world has never had a WF snapshot exported -- but Encounter
      // Builder is DELIBERATELY NOT graph-backed (design record §1a,
      // confirmed by review-ui/test/e2e/combat-planning-fixture.mjs's own
      // primeWorldSelection header: "combat-planning's bestiary/party-roster
      // stores are deliberately NOT graph-backed... this suite has no
      // snapshot file for GET /api/worlds to discover at all"), and
      // review-ui/public/combat-planning-view.js's onThemeSubmit never sends
      // a sceneEntityId at all (the Encounter Builder view has no scene
      // concept anywhere) -- so the snapshot, when it does exist, was never
      // even being used for anything beyond an always-absent sceneEntityId
      // lookup. The result: narrowing by theme threw a hard 400 for any
      // world without a live/ever-exported WF snapshot -- exactly the
      // real-world "just using Encounter Builder standalone" case -- instead
      // of ever reaching proposeThematicTags at all. Degrade gracefully
      // instead: only load the snapshot (for the optional scene-grounding
      // context) when one actually exists on disk; otherwise proceed with an
      // ungrounded sceneContext, matching buildAdjacencyContext's own
      // existing "degrade to the raw id rather than throwing" convention for
      // an unresolvable entityId.
      let sceneContext = { entityLabel: undefined, neighborDescriptions: [] };
      if (existsSync(snapshotFilePath(dir, w))) {
        const { entities, edges } = loadSnapshot(dir, w).snapshot;
        sceneContext = buildAdjacencyContext(entities, edges, body.sceneEntityId, DEFAULT_ENTITY_NARRATE_DEPTH);
      }
      const fullPool = listBestiaryEntries().map((e) => ({ entryId: e.id, rawFields: e.rawFields, derivedScore: e.derivedScore }));
      const { filteredEntryIds } = await proposeThematicTags(sceneContext, fullPool, {});
      const filteredIdSet = new Set(filteredEntryIds);
      candidatePool = fullPool.filter((c) => filteredIdSet.has(c.entryId));
    } else {
      candidatePool = acceptedPool();
    }

    let party = listPartyMembers(w);
    if (Array.isArray(body.attendingMemberIds)) {
      const attendingSet = new Set(body.attendingMemberIds);
      party = party.filter((m) => attendingSet.has(m.id));
    }
    // Phase 19 task 19.6 addition (small, additive, backward-compatible --
    // same category of change as the three fields above): `hpOverrides`
    // ({memberId: hp}) substitutes a WORKING-SESSION hp value into scoring
    // for this request ONLY -- never written back to party-roster-store.mjs.
    // review-ui/public/combat-planning-view.js's Resync-from-Foundry button
    // is the one caller; see that file's header for the full grounding on
    // why this (rather than a persisted write) is the correct shape for
    // "working session, not persisted record."
    if (body.hpOverrides && typeof body.hpOverrides === "object") {
      party = party.map((m) =>
        Object.prototype.hasOwnProperty.call(body.hpOverrides, m.id) && typeof body.hpOverrides[m.id] === "number"
          ? { ...m, combatRelevant: { ...m.combatRelevant, hp: body.hpOverrides[m.id] } }
          : m
      );
    }

    const suggestion = Array.isArray(body.manualCombination)
      ? scoreCombination({
          combination: body.manualCombination,
          // manualCombination is looked up against the full accepted pool,
          // not the (possibly theme-filtered) candidatePool above -- an
          // already-made manual catalog pick must never be silently dropped
          // for not matching the theme. When themeText was blank,
          // candidatePool IS already exactly this pool -- reused rather than
          // re-read.
          candidatePool: themeText ? acceptedPool() : candidatePool,
          party,
          knobs: body.knobs ?? {}
        })
      : suggestEncounter({
          targetDifficulty: body.targetDifficulty,
          candidatePool,
          party,
          knobs: body.knobs ?? {}
        });
    return sendJson(res, 200, { suggestion });
  }

  // ---------------------------------------------------------------------
  // Phase 22 (task 22.7) -- Scene Engine routes, prefix `/api/scene-planning/*`
  // matching session-planner's own `/api/session-planner/*` and
  // combat-planning's own `/api/combat-planning/*` precedent exactly. Every
  // route below is a thin wrapper over the corresponding session-planner/ or
  // mutation-engine/ module (22.1-22.6) -- resolveWorld()/resolveDir() with
  // NO client-supplied dataDir override anywhere below, and `world` is
  // always resolved (and so validated) before any snapshot read, store
  // write, or LLM-touching call for that route.
  // ---------------------------------------------------------------------

  // GET /api/scene-planning/scenes?world=
  // Phase 24 task 24.1 -- thin wrapper over listScenesForWorld, the one real
  // gap plans/phase-24-tasks.md's grounding pass found: Phase 22 shipped
  // linkage/transit/membership/undo/develop/quick-gen routes but never
  // exposed scenes.mjs's own listScenesForWorld over HTTP. No new store
  // logic here, same resolveWorld()/resolveDir() convention (no
  // client-supplied dataDir) as every other route in this file.
  if (method === "GET" && parts.length === 3 && parts[1] === "scene-planning" && parts[2] === "scenes") {
    const w = resolveWorld(q.get("world"));
    const scenes = listScenesForWorld(w);
    return sendJson(res, 200, { scenes });
  }

  // GET /api/scene-planning/linkage?world=&sceneId=&maxHops=
  if (method === "GET" && parts.length === 3 && parts[1] === "scene-planning" && parts[2] === "linkage") {
    const w = resolveWorld(q.get("world"));
    const dir = resolveDir();
    const { entities, edges } = loadSnapshot(dir, w).snapshot;
    const maxHopsRaw = q.get("maxHops");
    const maxHops = maxHopsRaw ? Number(maxHopsRaw) : undefined;
    const linked = linkedScenesForScene(w, q.get("sceneId"), { entities, edges }, { maxHops });
    return sendJson(res, 200, { linked });
  }

  // POST /api/scene-planning/transit-entity   { world, fromEntityId, toEntityId, name? }
  if (method === "POST" && parts.length === 3 && parts[1] === "scene-planning" && parts[2] === "transit-entity") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const dir = resolveDir();
    const entity = await createTransitEntity(dir, w, {
      fromEntityId: body.fromEntityId,
      toEntityId: body.toEntityId,
      name: body.name
    });
    return sendJson(res, 200, { entity });
  }

  // GET /api/scene-planning/scenes/:sceneId/members?world=
  if (method === "GET" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "members") {
    const w = resolveWorld(q.get("world"));
    const membership = getSceneMembership(w, parts[3]);
    return sendJson(res, 200, { membership });
  }

  // POST /api/scene-planning/scenes/:sceneId/members   { world, entityId }
  if (method === "POST" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "members") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const membership = addNodeToScene(w, parts[3], body.entityId);
    return sendJson(res, 200, { membership });
  }

  // DELETE /api/scene-planning/scenes/:sceneId/members/:entityId   { world } (query or body)
  if (method === "DELETE" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "members") {
    const body = await readBody(req);
    const w = resolveWorld(body.world ?? q.get("world"));
    const membership = removeNodeFromScene(w, parts[3], parts[5]);
    return sendJson(res, 200, { membership });
  }

  // GET /api/scene-planning/scenes/:sceneId/intervening-offer?world=&targetEntityId=
  if (method === "GET" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "intervening-offer") {
    const w = resolveWorld(q.get("world"));
    const dir = resolveDir();
    const scene = getScene(w, parts[3]);
    const { entities, edges } = loadSnapshot(dir, w).snapshot;
    const offer = offerInterveningNodes(entities, edges, scene.locationEntityId, q.get("targetEntityId"));
    return sendJson(res, 200, { offer });
  }

  // POST /api/scene-planning/scenes/:sceneId/undo/start   { world }
  if (method === "POST" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "undo" && parts[5] === "start") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const session = startSceneUndoSession(w, parts[3]);
    return sendJson(res, 200, { session });
  }

  // GET /api/scene-planning/scenes/:sceneId/undo?world=   (peek/list)
  if (method === "GET" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "undo") {
    const w = resolveWorld(q.get("world"));
    const actions = listSceneUndoActions(w, parts[3]);
    return sendJson(res, 200, { actions });
  }

  // POST /api/scene-planning/scenes/:sceneId/undo/record  { world, action }
  if (method === "POST" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "undo" && parts[5] === "record") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const session = recordSceneUndoAction(w, parts[3], body.action);
    return sendJson(res, 200, { session });
  }

  // POST /api/scene-planning/scenes/:sceneId/undo/last    { world }
  if (method === "POST" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "undo" && parts[5] === "last") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const action = undoLastSceneAction(w, parts[3]);
    return sendJson(res, 200, { action });
  }

  // POST /api/scene-planning/scenes/:sceneId/undo/all     { world }
  if (method === "POST" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "undo" && parts[5] === "all") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const actions = undoAllSceneActions(w, parts[3]);
    return sendJson(res, 200, { actions });
  }

  // POST /api/scene-planning/scenes/:sceneId/undo/clear   { world }
  if (method === "POST" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "undo" && parts[5] === "clear") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    clearSceneUndoSession(w, parts[3]);
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/scene-planning/scenes/:sceneId/develop   { world, memberEntityIds, selections?, reframeMemberIds?, priorRoundCounts? }
  // Makes real LLM calls transitively (via the prep-content operations
  // module) -- world is resolved/validated FIRST, before any of that runs.
  if (method === "POST" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "develop") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const dir = resolveDir();
    const result = await developScene(dir, w, parts[3], body.memberEntityIds ?? [], {
      selections: body.selections,
      reframeMemberIds: body.reframeMemberIds,
      priorRoundCounts: body.priorRoundCounts
    });
    return sendJson(res, 200, result);
  }

  // POST /api/scene-planning/quick-gen   { world, prompt }
  // Makes a real LLM call -- world is resolved/validated FIRST, before any of that runs.
  if (method === "POST" && parts.length === 3 && parts[1] === "scene-planning" && parts[2] === "quick-gen") {
    const body = await readBody(req);
    resolveWorld(body.world); // validated for security parity with every other route; quickGenerate itself carries no world concept
    const result = await quickGenerate(body.prompt, {});
    return sendJson(res, 200, result);
  }

  // -----------------------------------------------------------------------
  // Phase 22 ADDENDUM -- "Add Encounter" persistence, same
  // `/api/scene-planning/scenes/:sceneId/*` prefix/style as this file's
  // Phase 22 `.../members` routes above (mirrored deliberately, not a new
  // convention). Thin wrappers over combat-planning/saved-encounter.mjs
  // (22.7-addendum) -- resolveWorld()/resolveDir() with NO client-supplied
  // dataDir override, same as every route in this block.
  // -----------------------------------------------------------------------

  // POST /api/scene-planning/scenes/:sceneId/encounters   { world, name?, combination, knobs?, scoreSnapshot? }
  if (method === "POST" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "encounters") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const encounter = saveEncounter(w, parts[3], {
      name: body.name,
      combination: body.combination,
      knobs: body.knobs,
      scoreSnapshot: body.scoreSnapshot
    });
    return sendJson(res, 200, { encounter });
  }

  // GET /api/scene-planning/scenes/:sceneId/encounters?world=
  if (method === "GET" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "encounters") {
    const w = resolveWorld(q.get("world"));
    const encounters = listEncountersForScene(w, parts[3]);
    return sendJson(res, 200, { encounters });
  }

  // Phase 27 task 27.2, F11 -- GET /api/scene-planning/encounters?world=
  // The world-picker feed (3-part path, distinct from the 5-part
  // scene-scoped GET above): every saved-encounter DEFINITION for the world,
  // each appearing exactly once regardless of how many scenes reference it.
  if (method === "GET" && parts.length === 3 && parts[1] === "scene-planning" && parts[2] === "encounters") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { encounters: listEncountersForWorld(w) });
  }

  // Phase 27 task 27.2, F11 -- POST /api/scene-planning/scenes/:sceneId/encounters/:encounterId/attach   { world }
  // Attaches an EXISTING encounter definition to this scene (a shared
  // reference -- not a re-saved copy). Idempotent.
  if (method === "POST" && parts.length === 7 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "encounters" && parts[6] === "attach") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const encounter = attachEncounterToScene(w, parts[5], parts[3]);
    return sendJson(res, 200, { encounter });
  }

  // DELETE /api/scene-planning/scenes/:sceneId/encounters/:encounterId   { world } (query or body, matching the sibling members route's own convention)
  // Phase 27 task 27.2, F11 -- REDEFINED as detach-from-this-scene (removes
  // ONLY this scene's membership), NOT delete-the-definition -- a shared
  // encounter definition still referenced by another scene survives.
  if (method === "DELETE" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "encounters") {
    const body = await readBody(req);
    const w = resolveWorld(body.world ?? q.get("world"));
    const encounter = detachEncounterFromScene(w, parts[5], parts[3]);
    return sendJson(res, 200, { encounter });
  }

  // -----------------------------------------------------------------------
  // Phase 26 task 26.1 -- Plan store routes, prefix `/api/scene-planning/
  // plans/*`, matching this file's established `/api/scene-planning/*`
  // prefix (Phase 22) exactly. Thin wrappers over session-planner/plans.mjs
  // only -- no independent business logic here, per gm-tools-conventions.
  // -----------------------------------------------------------------------

  // POST /api/scene-planning/plans   { world, name }
  if (method === "POST" && parts.length === 3 && parts[1] === "scene-planning" && parts[2] === "plans") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const plan = createPlan(w, { name: body.name });
    return sendJson(res, 200, { plan });
  }

  // GET /api/scene-planning/plans?world=
  if (method === "GET" && parts.length === 3 && parts[1] === "scene-planning" && parts[2] === "plans") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { plans: listPlansForWorld(w) });
  }

  // GET /api/scene-planning/plans/:planId?world=
  if (method === "GET" && parts.length === 4 && parts[1] === "scene-planning" && parts[2] === "plans") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { plan: getPlan(w, parts[3]) });
  }

  // POST /api/scene-planning/plans/:planId/scenes   { world, sceneId }
  if (method === "POST" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "plans" && parts[4] === "scenes") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const plan = addSceneToPlan(w, parts[3], body.sceneId);
    return sendJson(res, 200, { plan });
  }

  // DELETE /api/scene-planning/plans/:planId/scenes/:sceneId   { world } (body or query, matching scene-membership's own DELETE convention)
  if (method === "DELETE" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "plans" && parts[4] === "scenes") {
    const body = await readBody(req);
    const w = resolveWorld(body.world ?? q.get("world"));
    const plan = removeSceneFromPlan(w, parts[3], parts[5]);
    return sendJson(res, 200, { plan });
  }

  // -----------------------------------------------------------------------
  // Phase 26 task 26.3 -- scene-link store routes, prefix
  // `/api/scene-planning/scene-links`. Thin wrappers over
  // session-planner/scene-links.mjs only.
  // -----------------------------------------------------------------------

  // POST /api/scene-planning/scene-links   { world, sceneIdA, sceneIdB, reason? }
  if (method === "POST" && parts.length === 3 && parts[1] === "scene-planning" && parts[2] === "scene-links") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const link = linkScenes(w, body.sceneIdA, body.sceneIdB, body.reason);
    return sendJson(res, 200, { link });
  }

  // GET /api/scene-planning/scene-links?world=&sceneId=
  if (method === "GET" && parts.length === 3 && parts[1] === "scene-planning" && parts[2] === "scene-links") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { linked: getLinkedScenes(w, q.get("sceneId")) });
  }

  // DELETE /api/scene-planning/scene-links   { world, sceneIdA, sceneIdB }
  if (method === "DELETE" && parts.length === 3 && parts[1] === "scene-planning" && parts[2] === "scene-links") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const result = unlinkScenes(w, body.sceneIdA, body.sceneIdB);
    return sendJson(res, 200, result);
  }

  // ---------------------------------------------------------------------
  // Phase 26 task 26.9, §26.E -- post-session graph update from a Plan's
  // scenes' notes. A thin composition route: assemble writeup-shaped text
  // (session-planner/plan-updates.mjs), then delegate straight to the
  // EXISTING importWriteup() -- the exact same LLM-extraction -> dry-run
  // merge -> review-state-batch pipeline POST /api/writeup-propose already
  // uses, never duplicated. `llmOpts` forwards straight through (the same
  // dependency-injection seam proposeWfiFromWriteup's own tests use).
  // ---------------------------------------------------------------------

  // POST /api/scene-planning/plans/:planId/propose-updates   { world }
  // NOTE: `llmOpts.client` injection is NOT threaded through this HTTP route
  // (same established limitation as /api/writeup-propose, per rubber-duck-
  // routes.test.mjs's own documented reasoning -- a live function reference
  // cannot survive a real HTTP JSON round trip). Tests wanting a genuinely
  // working injected client call proposeUpdatesForPlan directly, in-process.
  if (method === "POST" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "plans" && parts[4] === "propose-updates") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await proposeUpdatesForPlan(dir, w, parts[3]);
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
