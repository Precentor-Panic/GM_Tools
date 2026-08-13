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
 *
 * Id-assignment read-back (Phase 4 task 4.1): a genuine create (an
 * upsert_entity/upsert_edge mutation with no `m.id`/`m.data.id`) has no id
 * for the caller to target with a later delete-based rollback
 * (mutation-engine/rollback.mjs) -- that id doesn't exist until this
 * function assigns one. Rather than let importGraph()'s own internal id
 * generator assign it invisibly, applyHeadless() pre-assigns an id (in the
 * SAME `wf_<timestamp>_<counter>` convention interchange.mjs's private
 * defaultMakeId() already establishes -- confirmed by reading that function
 * directly, not invented fresh here) for every id-less create BEFORE handing
 * it to importGraph, and reports the assignment back in the returned
 * `idAssignments` map, keyed by the create mutation's position (index) in
 * the `mutations` array this call received. The SAME generator instance is
 * also passed to importGraph as `opts.makeId`, so any id it still has to
 * generate on its own (e.g. a stub entity created for an unresolved named
 * edge endpoint) draws from the same monotonic counter -- one shared
 * sequence, so a pre-assigned id can never collide with one importGraph
 * generates internally in the same call.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { importGraph } from "../../foundry_worldFabric/scripts/data/interchange.mjs";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";

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
 * Same format as interchange.mjs's private defaultMakeId() (`wf_<ts36>_<n36>`)
 * -- that function isn't exported, so this is a same-convention sibling, not
 * a reused reference. One instance per applyHeadless() call: its counter is
 * shared between this module's own pre-assigned create ids AND importGraph's
 * `opts.makeId` for that same call, so the two id sources can never collide.
 */
function makeIdGenerator() {
  let n = 0;
  const ts = Date.now().toString(36);
  return () => `wf_${ts}_${(n++).toString(36)}`;
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
 *
 * Id resolution prefers top-level `m.id` (the documented, authoritative
 * field per mutation-engine/schema.mjs's Mutation shape -- `data` is a
 * plain field-value patch and never legitimately carries its own `id` in
 * any GM_Tools-produced mutation, since diff.mjs's own ENTITY_DIFF_FIELDS/
 * EDGE_DIFF_FIELDS deliberately exclude it). Falls back to `data.id` rather
 * than silently discarding it, purely as a defensive guard against a
 * malformed/hand-authored mutation that put `id` in the wrong place --
 * found during this phase's own manual round-trip verification, where a
 * hand-rolled test fixture made exactly that mistake and would otherwise
 * have silently created a duplicate/orphaned record instead of failing
 * loudly or updating the intended one.
 *
 * `assignedId` (Phase 4 task 4.1) is the id this call's makeIdGenerator()
 * pre-assigned for a genuine create (no `m.id`/`m.data.id` at all) -- used
 * only as the last fallback in the same `??` chain, so it never overrides a
 * real target id an update mutation actually carries.
 */
function mergedWfiRecord(m, currentMap, assignedId) {
  const targetId = m.id ?? m.data?.id ?? assignedId;
  const current = targetId ? currentMap.get(targetId) : undefined;
  return { ...(current ?? {}), ...(m.data ?? {}), id: targetId ?? current?.id };
}

/**
 * Apply a mutations array (the same {op, id, data} shape wf-mcp-server's
 * wf_apply_mutations/mutation-engine schema already use) directly to a
 * standalone snapshot file. No live Foundry client required.
 *
 * @param {string} snapshotPath
 * @param {object[]} mutations
 * @returns {{summary:object, deletedEntityCount:number, deletedEdgeCount:number, skipped:Array<{op:string,id:string,reason:string}>, idAssignments:Object<string,string>, idResolution:Object<string,string>}}
 *   `idAssignments` (Phase 4 task 4.1): for every id-less upsert_entity/
 *   upsert_edge mutation (a genuine create), maps its position (index, as a
 *   string object key) in the `mutations` array this call received to the
 *   id actually assigned. Empty object if every mutation already targeted a
 *   known id. The caller (wf-mcp-server's wf_sync_to_foundry) uses this to
 *   write the assigned id back onto the originating batch's stored mutation
 *   entry, so mutation-engine/rollback.mjs's later delete-based rollback has
 *   an id to target instead of skipping the entry as unresolvable.
 *
 *   `idResolution` (QA W1 Fix 2): for every upsert_entity mutation, maps its
 *   position (index) to the id its record ACTUALLY landed under after
 *   import -- see this function's own inline comment above the computation
 *   for the exact merge-fold mechanism this exists to make honest. For the
 *   common case (no name+type collision) this is identical to the id the
 *   mutation targeted/was assigned; callers that need the true persisted id
 *   of a create (manual-edit-ops.mjs's addNodeOp) must read this, not their
 *   own pre-assigned id.
 *
 * Locking (found missing during a QA pass, not part of the original design):
 * every other data store in this codebase (review-state.mjs, pending-ledger.mjs,
 * human-review.mjs, user-settings.mjs) wraps its read-modify-write in
 * review-state.mjs's withLock, but this was the one file that read, merged,
 * and rewrote a shared file (world-fabric-snapshot.json) with no locking at
 * all -- two concurrent callers (e.g. two review-ui tabs syncing at once)
 * could silently clobber each other. Wrapped in the SAME withLock this
 * codebase already uses everywhere else, reusing it rather than inventing a
 * second locking mechanism.
 */
export function applyHeadless(snapshotPath, mutations) {
  try {
    return withLock(snapshotPath, () => runApplyHeadless(snapshotPath, mutations));
  } catch (err) {
    if (err instanceof ConcurrentWriteError) {
      throw new HeadlessApplyError(
        `Snapshot file is locked by an in-progress write: ${snapshotPath}. Another headless apply (a sync, ` +
        `a rollback, or a crashed process) holds the lock. Retry once that write completes, or investigate a ` +
        `stale lock if it persists.`,
        { op: "apply", mutation: null }
      );
    }
    throw err;
  }
}

function runApplyHeadless(snapshotPath, mutations) {
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
  const idAssignments = {};
  // QA W1 Fix 2: every upsert_entity mutation's REQUESTED id (whatever the
  // caller/pre-assignment above targeted), keyed by its index in `mutations`
  // -- tracked so idResolution (below, after importGraph runs) can report
  // back the id the record actually landed under, which is NOT always the
  // same id (see idResolution's own comment).
  const requestedEntityIds = {};
  const makeId = makeIdGenerator();

  mutations.forEach((m, index) => {
    switch (m.op) {
      case "upsert_entity": {
        let assignedId;
        if (!(m.id ?? m.data?.id)) {
          assignedId = makeId();
          idAssignments[index] = assignedId;
        }
        requestedEntityIds[index] = { targetId: m.id ?? m.data?.id ?? assignedId, name: m.data?.name, type: m.data?.type };
        wfiEntities.push(mergedWfiRecord(m, entityMap, assignedId));
        break;
      }
      case "upsert_edge": {
        let assignedId;
        if (!(m.id ?? m.data?.id)) {
          assignedId = makeId();
          idAssignments[index] = assignedId;
        }
        const merged = mergedWfiRecord(m, edgeMap, assignedId);
        if (!merged.sourceId || !merged.targetId) {
          throw new HeadlessApplyError(
            `upsert_edge mutation for id="${m.id ?? assignedId ?? "(new)"}" has no sourceId/targetId, and no ` +
            `existing edge to merge onto -- importGraph would silently skip it. A create needs both in \`data\`; ` +
            `an update needs a matching existing edge id.`,
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
  });

  const wfi = { version: 1, entities: wfiEntities, edges: wfiEdges, entityTypes: wfiEntityTypes };
  const result = importGraph(wfi, existing, { mode: "merge", makeId });

  // QA W1 Fix 2 (data-integrity root cause): interchange.mjs's importGraph()
  // findExisting() matches an incoming entity by `${type}::${name}` BEFORE
  // this call's own requested id is ever consulted, and when it matches,
  // forces the merged record's id to the EXISTING entity's id, discarding
  // the id this call requested/pre-assigned entirely -- a name+type
  // collision silently folds a "create" into an update of a DIFFERENT
  // entity than the one the caller thinks it just made. idResolution
  // reports, for every id-carrying upsert_entity mutation (by its index in
  // `mutations`), the id the record ACTUALLY landed under after that merge
  // -- callers (manual-edit-ops.mjs's addNodeOp, the actual fix site) MUST
  // read this instead of trusting their own pre-assigned id, or they hand
  // back a phantom id that was never persisted (the dangling
  // scene.locationEntityId this was built to close). Computed post-import
  // by re-deriving the SAME `${type}::${name}` match interchange.mjs's own
  // findExisting() uses -- not a second traversal of import semantics, just
  // reading back its one observable outcome (which id survived) rather than
  // threading a new return value through the sibling repo. Edges never
  // merge-fold by name (importGraph keys edges strictly by id, no
  // name-based edge index -- confirmed by reading its edges loop directly)
  // so no equivalent lookup is needed for upsert_edge.
  const idResolution = {};
  for (const [index, req] of Object.entries(requestedEntityIds)) {
    if (result.entities.some((e) => e.id === req.targetId)) {
      idResolution[index] = req.targetId; // landed under the id we requested -- the common case
      continue;
    }
    const nameKey = (req.name ?? "").trim().toLowerCase();
    const survivor = nameKey && req.type
      ? result.entities.find((e) => e.type === req.type && (e.name ?? "").trim().toLowerCase() === nameKey)
      : undefined;
    // Fallback to req.targetId (never worse than the old blind-trust
    // behavior) only in the defensive case where even the name+type lookup
    // can't recover a survivor -- shouldn't happen given importGraph's own
    // "every incoming entity either matches or creates" contract, but this
    // must never itself throw.
    idResolution[index] = survivor ? survivor.id : req.targetId;
  }

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
    skipped,
    idAssignments,
    idResolution
  };
}
