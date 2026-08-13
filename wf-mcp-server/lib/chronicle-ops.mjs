/**
 * Chronicle composition operations — the actual business logic behind
 * review-ui/server.mjs's POST /api/chronicle/run, POST /api/chronicle/intents,
 * GET /api/chronicle/log, and GET /api/pending-entities routes, extracted
 * (MCP wave) so wf-mcp-server/index.mjs's wf_chronicle_run/wf_queue_intent/
 * wf_list_chronicle_log/wf_list_pending_intents tools call the EXACT same
 * code path instead of re-deriving it against a second, drifting copy —
 * per gm-tools-conventions' "front-ends are thin wrappers, never logic
 * duplicators" and the same precedent wf-mcp-server/lib/mutation-ops.mjs
 * already set for the review-workflow surface.
 *
 * Every exported function here takes already-resolved `dir`/`w` (see
 * ./resolve.mjs) and returns a plain JS object shaped exactly like what the
 * HTTP route used to build inline — callers (an MCP tool handler, an HTTP
 * route handler) decide how to serialize/frame that object, not this module.
 *
 * runChronicleOp bakes offline-degrade safety (./offline-clients.mjs) in
 * DIRECTLY, same as the route always has — a caller (HTTP or MCP) gets
 * keyless safety for free, never needs to think about it.
 */
import { randomUUID } from "node:crypto";

import { loadSnapshot, snapshotFilePath } from "./snapshot.mjs";
import { findEntity } from "./graph.mjs";
import { flaggedEntityIdSet } from "./mutation-ops.mjs";
import { offlineOpts, offlineTextureClient } from "./offline-clients.mjs";

import { applyHeadless } from "../../graph-import/headless-apply.mjs";
import { loadBatch, listBatches } from "../../mutation-engine/review-state.mjs";
import { summarizeBatch, renderHeadline } from "../../mutation-engine/grain.mjs";
import { listPendingEntities, readAvailablePending, writePending } from "../../mutation-engine/pending-ledger.mjs";
import { orchestrateBatch } from "../../time-skip/run.mjs";
import { resolveBranchesDeltas } from "../../time-skip/scope.mjs";
import { getWorldClock, advanceWorldClock } from "../../session-planner/world-clock.mjs";
import { getFortune } from "../../session-planner/fortune-track.mjs";
import { recordChronicleRun, getChronicleRun } from "../../session-planner/chronicle-run.mjs";

/**
 * `name = first line, truncated to ~maxLen chars` -- the ONE truncation rule
 * used both for a prompt-derived entity's name (60 chars) and the
 * chronicle-log history rail's `promptSummary` (80 chars), so the two never
 * drift out of sync with each other's idea of "the first line."
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
export function firstLineTruncated(text, maxLen) {
  const line = text.split("\n")[0].trim();
  return line.length > maxLen ? `${line.slice(0, maxLen).trimEnd()}…` : line;
}

/**
 * Resolve a free-typed name into an entity id -- the SHARED "dedup-or-create"
 * machinery POST /api/chronicle/intents and POST /api/chronicle/run's
 * prompt-seed reuse byte-for-byte. Case-insensitive exact-name dedup against
 * the live graph; no match -> create ONE minimal `concept`-typed entity via
 * the existing headless-apply path (mirrors writeup-import's own
 * dedup-or-create convention). `entities` is mutated IN PLACE with the
 * newly-created record when one is made, so a caller that goes on to pass
 * this SAME array into orchestrateBatch/textureRegion sees the new entity
 * immediately -- no second snapshot reload.
 * @param {string} snapPath
 * @param {object[]} entities  the live snapshot's entities (mutated on create)
 * @param {string} name
 * @returns {{entityId:string, entityType:string, created:boolean}}
 */
export function resolveOrCreateIntentEntity(snapPath, entities, name) {
  const lower = name.toLowerCase();
  const match = entities.find((e) => typeof e.name === "string" && e.name.toLowerCase() === lower);
  if (match) return { entityId: match.id, entityType: match.type ?? "concept", created: false };
  const entityId = `intent-${randomUUID()}`;
  applyHeadless(snapPath, [{ op: "upsert_entity", data: { id: entityId, name, type: "concept", importance: 0.4 } }]);
  entities.push({ id: entityId, name, type: "concept", importance: 0.4 });
  return { entityId, entityType: "concept", created: true };
}

/**
 * GET /api/pending-entities payload: every entity with an available
 * backlog, plus its entries and a display name/type.
 */
export function pendingEntitiesPayload(w, dir) {
  let entities = [];
  try {
    ({ entities } = loadSnapshot(dir, w).snapshot);
  } catch {
    // No snapshot yet is fine here -- pending entries can still be listed by id, just without a friendly name.
  }
  return listPendingEntities(w).map((entityId) => {
    const entity = findEntity(entities, entityId);
    return {
      entityId,
      name: entity?.name ?? entityId,
      type: entity?.type ?? null,
      entries: readAvailablePending(w, entityId)
    };
  });
}

/**
 * GET /api/chronicle/log payload -- a READ layer composing the EXISTING
 * listBatches(world) (already newest-first, already carrying
 * mutationCount/pendingCount/acceptedCount) with grain.mjs's EXISTING
 * summarizeBatch/renderHeadline for the friendly one-line headline, plus
 * chronicle-run.mjs's per-batch sidecar for the fields listBatches has no
 * source for (`span`/`fortuneAtRun`/`promptSummary`) -- null for a batch NOT
 * created via Chronicle's own composer, a real valid state, never a thrown
 * error or a guessed value. ZERO new persisted history of its own.
 */
export function chronicleLogPayload(w) {
  const batches = listBatches(w);
  const flaggedEntityIds = flaggedEntityIdSet(w);
  const entries = batches.map((b) => {
    const run = getChronicleRun(w, b.id);
    const summary = summarizeBatch(loadBatch(w, b.id), { flaggedEntityIds });
    return {
      batchRef: b.id,
      span: run?.span ?? null,
      scope: b.scope,
      fortuneAtRun: run?.fortuneAtRun ?? null,
      promptSummary: run?.promptSummary ?? null,
      at: b.createdAt,
      headline: renderHeadline(summary),
      mutationCount: b.mutationCount,
      pendingCount: b.pendingCount,
      acceptedCount: b.acceptedCount,
      status: b.status
    };
  });
  return { world: w, entries };
}

/**
 * POST /api/chronicle/run's full composition -- span/scope/prompt/tags ->
 * {batchId, mutationCount, headline, clock, fortuneAtRun, scopeKind}.
 * Mirrors the HTTP route EXACTLY, including the single-source elapsedSessions
 * rule (advanceWorldClock is called EXACTLY ONCE per run, here, and its own
 * returned elapsedSessions is the ONLY value ever merged into the resolved
 * scope spec -- a caller-supplied elapsedSessions is NEVER read anywhere in
 * this function) and the prompt-as-seed behavior (a typed `prompt` always
 * earns >=1 reviewable proposal, even with nothing queued/carried, via
 * resolveOrCreateIntentEntity above).
 *
 * Offline-safe: when ANTHROPIC_API_KEY is not set in this process's own
 * environment, the texture pass degrades to offlineTextureClient (a single
 * honest, clearly-labelled placeholder edit per region) instead of throwing
 * on client construction -- same behavior the HTTP route has always had.
 *
 * @param {string} dir  resolved data dir
 * @param {string} w    resolved world id
 * @param {{scopeKind?:string, branchIds?:string[], carriedEntryIds?:string[], span:object, prompt?:string, tags?:string[]}} body
 */
export async function runChronicleOp(dir, w, body) {
  const { entities, edges } = loadSnapshot(dir, w).snapshot;

  const scopeKind = body.scopeKind ?? "queued-intents";
  if (!["queued-intents", "branches", "whole-world"].includes(scopeKind)) {
    throw new Error(
      `runChronicleOp: unknown scopeKind "${scopeKind}" (expected 'queued-intents', 'branches', or 'whole-world').`
    );
  }

  const promptText = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const promptSummary = promptText ? firstLineTruncated(promptText, 80) : null;

  // THE single call site permitted to compute this run's elapsedSessions.
  const clock = advanceWorldClock(w, body.span);

  let scopeSpec;
  let precomputedDeltas;
  if (scopeKind === "queued-intents") {
    const carriedIds = Array.isArray(body.carriedEntryIds) ? new Set(body.carriedEntryIds) : null;
    const seeds = [];
    for (const entityId of listPendingEntities(w)) {
      for (const entry of readAvailablePending(w, entityId)) {
        if (carriedIds && !carriedIds.has(entry.entryId)) continue;
        seeds.push({ entityId, magnitude: Math.min(1, Math.abs(entry.impactScore)) });
      }
    }
    if (promptText) {
      const snapPath = snapshotFilePath(dir, w);
      const promptName = firstLineTruncated(promptText, 60);
      const { entityId: promptEntityId } = resolveOrCreateIntentEntity(snapPath, entities, promptName);
      seeds.push({ entityId: promptEntityId, magnitude: 1 });
    }
    scopeSpec = { mode: "seed", seeds, elapsedSessions: clock.elapsedSessions };
    const byId = new Map();
    for (const s of seeds) {
      const ent = findEntity(entities, s.entityId);
      if (!byId.has(s.entityId)) {
        byId.set(s.entityId, {
          kind: "seed-propagated",
          entityId: s.entityId,
          impactScore: Math.max(s.magnitude, 0.5),
          importance: Math.max(0, Math.min(1, ent?.importance ?? 0.3)),
          needsLLM: true
        });
      }
    }
    precomputedDeltas = [...byId.values()];
  } else if (scopeKind === "branches") {
    const branchIds = Array.isArray(body.branchIds) ? body.branchIds : [];
    if (!branchIds.length) {
      throw new Error("runChronicleOp: scopeKind 'branches' requires a non-empty branchIds[].");
    }
    precomputedDeltas = resolveBranchesDeltas({ entities, edges }, branchIds, { elapsedSessions: clock.elapsedSessions });
    scopeSpec = { mode: "branches", branchIds, elapsedSessions: clock.elapsedSessions };
  } else {
    scopeSpec = { mode: "ambient", elapsedSessions: clock.elapsedSessions };
  }

  const fortune = getFortune(w);
  const result = await orchestrateBatch(w, scopeSpec, body.prompt, {
    entities,
    edges,
    ...(precomputedDeltas !== undefined ? { precomputedDeltas } : {}),
    fortuneBias: fortune.bias,
    fortuneLabel: fortune.stopId,
    nudgeTags: Array.isArray(body.tags) ? body.tags : [],
    textureOpts: offlineOpts(() => offlineTextureClient(fortune.stopId))
  });

  recordChronicleRun(w, result.batchId, { span: body.span, fortuneAtRun: fortune.stopId, elapsedSessions: clock.elapsedSessions, promptSummary });

  return {
    batchId: result.batchId,
    mutationCount: result.mutationCount,
    headline: result.headline,
    clock: { currentDate: clock.currentDate, sessionNumber: clock.sessionNumber, elapsedSessions: clock.elapsedSessions },
    fortuneAtRun: fortune.stopId,
    scopeKind
  };
}

/**
 * POST /api/chronicle/intents' full composition -- "add a manual intent by
 * hand": resolve a free-typed NAME into an entityId via the SHARED
 * resolveOrCreateIntentEntity, then writePending with the pinned
 * `sourceBatchId:"manual"` sentinel + `cycleDescriptor:"Manual"` so the
 * deferred lane renders it exactly like a wrap-up intent. No new store:
 * pending-ledger.mjs's EXISTING writePending does the work.
 * @param {string} dir
 * @param {string} w
 * @param {{name:string, note?:string, tags?:string[]}} body
 */
export function queueIntentOp(dir, w, body) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new Error("queueIntentOp: `name` is required (the intent's subject).");
  if (name.length > 200) throw new Error("queueIntentOp: `name` must be 200 characters or fewer.");

  const snapPath = snapshotFilePath(dir, w);
  const { entities } = loadSnapshot(dir, w).snapshot;
  const { entityId, entityType } = resolveOrCreateIntentEntity(snapPath, entities, name);

  writePending(w, entityId, {
    causeTag: typeof body.note === "string" && body.note.trim() ? body.note.trim() : "Added by hand.",
    impactScore: 0.4,
    sourceBatchId: "manual",
    cycleDescriptor: "Manual",
    status: "pending",
    ...(Array.isArray(body.tags) ? { tags: body.tags } : {})
  });

  return {
    entityId,
    name,
    type: entityType,
    entries: readAvailablePending(w, entityId)
  };
}

// getWorldClock re-exported for convenience/symmetry (wf_get_world_clock can
// import straight from session-planner/world-clock.mjs instead -- this
// export exists only so a caller that already imports this module for
// everything else doesn't need a second import line).
export { getWorldClock };
