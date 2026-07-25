/**
 * Headless apply — pure, Foundry-free, unit-testable.
 *
 * The Foundry-optional counterpart to World Fabric's in-browser
 * GraphService.applyMutations()/exportSnapshot(): applies a mutations array
 * directly to a standalone world-fabric-snapshot.json file on disk, no live
 * Foundry client required. This is the fallback path wf_sync_to_foundry
 * (task 2.4) uses when no Foundry client has the world open.
 *
 * Reuses foundry_worldFabric/scripts/data/interchange.mjs's importGraph()/
 * exportGraph() directly (confirmed pure/Foundry-free -- no `game.`/`foundry.`
 * references anywhere in interchange.mjs or its own dependency, derivation.mjs)
 * rather than reimplementing merge semantics, per gm-tools-conventions'
 * "reuse existing primitives" rule. Deliberately does NOT reuse
 * graph-service.mjs's own applyMutations() -- that method only runs inside
 * the Foundry browser session (depends on `game.settings`/`foundry.utils`),
 * exactly the constraint this module exists to route around. It also reads
 * `m.data.id` for upsert ops rather than the top-level `m.id` field GM_Tools'
 * own mutation-engine/schema.mjs Mutation shape and wf-mcp-server's
 * mutationSchema actually populate -- copying that behavior here would silently
 * mis-target every headless upsert as a brand-new entity/edge instead of an
 * update. This module treats top-level `m.id` as authoritative, consistent
 * with the schema mutations are actually produced against throughout this repo.
 *
 * Mutation -> WFI translation: each upsert_entity/upsert_edge mutation's
 * `data` is merged onto the CURRENT entity/edge (if `m.id` matches one) before
 * being handed to importGraph, mirroring the exact merge semantics
 * mutation-engine/diff.mjs's own doc comment requires and time-skip/run.mjs's
 * attachDiffs already performs (`{...before, ...data}`, not a sparse patch)
 * -- required for correctness here, not just for diffing: importGraph's edge
 * path skips (rather than corrupts) an edge with no sourceId/targetId, so a
 * sparse `data:{strength:0.2}` patch fed in unmerged would silently vanish.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { importGraph } from "../../foundry_worldFabric/scripts/data/interchange.mjs";

export const SNAPSHOT_SCHEMA_VERSION = 1;

// World Fabric's own CORE_ENTITY_TYPES (constants.mjs) -- the same default a
// brand-new in-Foundry world seeds its entityTypes setting with (see
// module.mjs's game.settings.register default). JSON round-tripped rather
// than imported live so bootstrapSnapshot never depends on `foundry.utils.deepClone`.
import { CORE_ENTITY_TYPES } from "../../foundry_worldFabric/scripts/constants.mjs";

export class HeadlessApplyError extends Error {
  constructor(message, { op, mutation } = {}) {
    super(message);
    this.name = "HeadlessApplyError";
    this.op = op;
    this.mutation = mutation;
  }
}

function readSnapshotFile(snapshotPath) {
  return JSON.parse(readFileSync(snapshotPath, "utf8"));
}

function writeSnapshotFile(snapshotPath, payload) {
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify(payload, null, 2), "utf8");
}

/**
 * Create a brand-new, empty standalone snapshot file -- for a campaign with
 * no pre-existing Foundry world at all. Shape matches graph-service.mjs's
 * exportSnapshot() payload (meta/context/systemPrompt/snapshot wrapper) so
 * wf-mcp-server/lib/snapshot.mjs's loadSnapshot() and the live-Foundry path
 * can both read either kind of file interchangeably.
 *
 * Does NOT populate `context`/`systemPrompt` (those come from
 * llm-context.mjs's budgetedContext(), a live-session convenience this
 * headless path doesn't attempt to replicate -- wf_get_context simply
 * returns them empty for a headless-only world; known, documented scope
 * limit, not an oversight).
 *
 * @param {string} snapshotPath
 * @param {object} [opts]
 * @param {string} [opts.worldId]
 * @returns {object} the created snapshot payload
 */
export function bootstrapSnapshot(snapshotPath, opts = {}) {
  const now = new Date().toISOString();
  const payload = {
    meta: {
      version: SNAPSHOT_SCHEMA_VERSION,
      worldId: opts.worldId ?? "unknown",
      sessionNumber: 0,
      exportedAt: now,
      entityCount: 0,
      edgeCount: 0,
      contextTokenEstimate: 0,
      mutationsInstruction:
        "Drop world-fabric-mutations.json alongside this file as a JSON array of {op, id, data} objects, " +
        "or use graph-import/headless-apply.mjs's applyHeadless() directly (no live Foundry client needed).",
      headless: true
    },
    context: "",
    systemPrompt: "",
    snapshot: {
      entities: [],
      edges: [],
      entityTypes: JSON.parse(JSON.stringify(CORE_ENTITY_TYPES))
    }
  };
  writeSnapshotFile(snapshotPath, payload);
  return payload;
}

/**
 * Merge a mutation's `data` onto the current entity/edge it targets (by
 * top-level `m.id`), producing a full WFI-ready object. Returns `data`
 * as-is (no merge) for a genuine create (no `m.id`, or `m.id` not found).
 */
function mergedWfiRecord(m, currentMap) {
  const current = m.id ? currentMap.get(m.id) : undefined;
  return { ...(current ?? {}), ...(m.data ?? {}), id: m.id ?? current?.id };
}

/**
 * Apply a mutations array (the same {op, id, data} shape wf-mcp-server's
 * wf_apply_mutations/mutation-engine schema already use) directly to a
 * standalone snapshot file. No live Foundry client required.
 *
 * @param {string} snapshotPath
 * @param {object[]} mutations
 * @returns {{summary:object, deletedEntityCount:number, deletedEdgeCount:number, skipped:Array<{op:string,id:string,reason:string}>}}
 */
export function applyHeadless(snapshotPath, mutations) {
  if (!existsSync(snapshotPath)) {
    throw new HeadlessApplyError(
      `No snapshot file at "${snapshotPath}". Call bootstrapSnapshot() first for a brand-new campaign, ` +
      `or point snapshotPath at an existing world-fabric-snapshot.json.`
    );
  }
  const payload = readSnapshotFile(snapshotPath);
  const existing = payload.snapshot ?? { entities: [], edges: [], entityTypes: [] };
  const entityMap = new Map((existing.entities ?? []).map((e) => [e.id, e]));
  const edgeMap = new Map((existing.edges ?? []).map((e) => [e.id, e]));

  const wfiEntities = [];
  const wfiEdges = [];
  const wfiEntityTypes = [];
  const deletedEntityIds = new Set();
  const deletedEdgeIds = new Set();
  const skipped = [];

  for (const m of mutations) {
    switch (m.op) {
      case "upsert_entity": {
        wfiEntities.push(mergedWfiRecord(m, entityMap));
        break;
      }
      case "upsert_edge": {
        const merged = mergedWfiRecord(m, edgeMap);
        if (!merged.sourceId || !merged.targetId) {
          throw new HeadlessApplyError(
            `upsert_edge mutation for id="${m.id ?? "(new)"}" has no sourceId/targetId, and no existing edge to ` +
            `merge onto -- importGraph would silently skip it. A create needs both in \`data\`; an update needs ` +
            `a matching existing edge id.`,
            { op: m.op, mutation: m }
          );
        }
        wfiEdges.push(merged);
        break;
      }
      case "delete_entity":
        if (!m.id) throw new HeadlessApplyError("delete_entity mutation is missing id.", { op: m.op, mutation: m });
        deletedEntityIds.add(m.id);
        break;
      case "delete_edge":
        if (!m.id) throw new HeadlessApplyError("delete_edge mutation is missing id.", { op: m.op, mutation: m });
        deletedEdgeIds.add(m.id);
        break;
      case "upsert_type":
        if (!m.data?.id) throw new HeadlessApplyError("upsert_type mutation is missing data.id.", { op: m.op, mutation: m });
        wfiEntityTypes.push(m.data);
        break;
      case "upsert_relationship_type":
        // Relationship-type definitions live in a Foundry world SETTING
        // (SETTINGS.relationshipTypes), never in the exported snapshot's
        // entities/edges/entityTypes shape at all (confirmed against
        // graph-service.mjs's snapshot()) -- there is no on-disk target for
        // this op in headless mode. Reported, not silently dropped.
        skipped.push({ op: m.op, id: m.id, reason: "relationship-type registry is Foundry-settings-only; not representable in a standalone snapshot" });
        break;
      default:
        throw new HeadlessApplyError(`Unknown mutation op: "${m.op}"`, { op: m.op, mutation: m });
    }
  }

  const wfi = { version: 1, entities: wfiEntities, edges: wfiEdges, entityTypes: wfiEntityTypes };
  const result = importGraph(wfi, existing, { mode: "merge" });

  // importGraph() has no delete concept of its own -- apply deletes as a
  // separate pass afterward, including cascading edge deletes for a deleted
  // entity's own edges (matching graph-service.mjs's delete_entity behavior).
  const finalEntities = result.entities.filter((e) => !deletedEntityIds.has(e.id));
  const finalEdges = result.edges.filter(
    (e) => !deletedEdgeIds.has(e.id) && !deletedEntityIds.has(e.sourceId) && !deletedEntityIds.has(e.targetId)
  );

  const now = new Date().toISOString();
  const updatedPayload = {
    ...payload,
    meta: {
      ...(payload.meta ?? {}),
      entityCount: finalEntities.length,
      edgeCount: finalEdges.length,
      exportedAt: now
    },
    snapshot: {
      entities: finalEntities,
      edges: finalEdges,
      entityTypes: result.entityTypes
    }
  };
  writeSnapshotFile(snapshotPath, updatedPayload);

  return {
    summary: result.summary,
    deletedEntityCount: deletedEntityIds.size,
    // Total edges actually removed: explicit delete_edge targets PLUS any
    // edge cascade-deleted because one of its endpoints was itself deleted
    // (matching graph-service.mjs's delete_entity behavior).
    deletedEdgeCount: result.edges.length - finalEdges.length,
    skipped
  };
}
