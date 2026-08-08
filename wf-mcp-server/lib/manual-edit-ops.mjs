/**
 * Manual graph editing — shared operations behind Phase 12's interactive
 * graph editor (review-ui/server.mjs's new routes; no MCP tool wrapping —
 * see this phase's closing report for why that's a deliberate decision, not
 * an oversight: manual edits are the GM DIRECTLY authoring the graph with no
 * review gate (plans/phase-12-review.md decision 1), and exposing that same
 * unreviewed write path to an LLM-driven MCP tool call would undermine the
 * whole reason this project's no-silent-auto-write invariant exists —
 * mutation-engine/entity-narration.mjs.
 *
 * PHASE 13 TASK 13.1 REWRITE: every write below used to go straight through
 * the SAME live-then-headless dual-path apply the Sync button uses
 * (applyMutationsWithHeadlessFallback), which meant every single micro-edit
 * independently paid the full ~7s live-Foundry-poll cost -- confirmed the
 * root cause of "manual edits take way too long" via direct investigation
 * (plans/phase-13-tasks.md). Every write now goes through
 * `applyManualMutations` below instead: it appends the mutation(s) to the
 * world's ONE ongoing "manual-edit" review-state.mjs batch (created lazily,
 * reused across edits until synced), marks them accepted immediately via
 * rollback.mjs's OWN acceptMutations (the same primitive a normal batch
 * accept uses -- also gets a manual edit real pre-state capture and
 * rollback-batch eligibility for free), and applies HEADLESSLY RIGHT AWAY
 * (graph-import/headless-apply.mjs's applyHeadless -- NOT the dual-path
 * function) for near-instant feedback, no live-Foundry-poll cost at all on
 * this path.
 *
 * Pushing a manual edit through to a live Foundry client is now a
 * SEPARATE, DEFERRED, EXPLICIT action, mirroring the existing batch
 * accept→sync pattern per the project owner's own direct request ("like we
 * do with the other updates"): because the batch's mutations are
 * status:'accepted' while the BATCH ITSELF stays status:'open', the
 * existing Queue rule (review-state.mjs's listBatches/acceptedCount) already
 * surfaces it as needing attention, and the EXISTING Sync button/route
 * (wf-mcp-server/lib/mutation-ops.mjs's syncOp, completely UNMODIFIED by
 * this phase) already knows how to push an open batch's accepted-but-
 * unsynced mutations through the real live-first applyMutationsWithHeadlessFallback
 * -- this is a genuine reuse, exercised for real (not assumed) by
 * wf-mcp-server/test/manual-edit-sync.test.mjs, which proves a later sync
 * attempt actually writes to and polls the real world-fabric-mutations.json
 * bridge file, not a no-op headless re-write.
 *
 * A manual edit is structurally the same kind of write as a synced batch
 * mutation, just auto-accepted at creation instead of sitting at 'pending'
 * first (manual edits don't go through a review step at all, per Phase 12's
 * decision 1) -- reusing review-state.mjs's batch machinery directly rather
 * than reinventing a second apply/sync path (per gm-tools-conventions'
 * "front-ends are thin wrappers" and "reuse existing primitives" rules).
 *
 * ID PRE-ASSIGNMENT: every create below (addNodeOp/addEdgeOp) generates its
 * own id BEFORE ever writing, and stamps it onto BOTH the mutation's
 * top-level `id` (the field headless-apply.mjs's mergedWfiRecord reads) AND
 * `data.id` (the field GraphService.applyMutations' live-Foundry upsert_entity/
 * upsert_edge case reads) -- this sidesteps rollback.mjs's own documented
 * "the live path can never report a created id back through the file
 * bridge" gap entirely, since there's nothing to report back: the id is
 * already known. This is what makes the undo mechanism below able to
 * generate a correct inverse (`delete_entity`/`delete_edge` targeting a real
 * known id) for a create, regardless of which path (live or headless)
 * actually applied it.
 *
 * UNDO: every write function below computes its own inverse mutations
 * (mirroring rollback.mjs's own pre-state-capture-then-restore pattern, one
 * level down from the batch grain to a single immediate write) and calls
 * mutation-engine/manual-undo.mjs's setUndoSlot with them, overwriting
 * whatever was there before (last-write-wins, per that module's own design).
 * deleteNodeOp is the one case worth calling out explicitly: it captures the
 * node's OWN pre-delete state AND every one of its cascade-deleted edges'
 * pre-delete state, and stores them together as ONE mutations array -- so
 * undo re-creates the node and every cascaded edge in a single
 * applyManualMutations call, satisfying the design doc's explicit "delete
 * node with its cascade as ONE atomic undo unit" requirement structurally,
 * not just by intention.
 *
 * REVIEW-STATE INTERACTION: every write also calls markHumanReviewed() on
 * the entity id(s) it touches -- per the design doc's explicit "manually-
 * created/edited nodes render in the normal reviewed color, never the
 * unreviewed-amber treatment" requirement. This isn't strictly necessary for
 * a brand-new create (a never-tracked entity is already unflagged by
 * default -- human-review.mjs's findUnreviewedEntities only iterates
 * entities with SOME tracked history), but IS necessary for editing an
 * entity that was previously flagged (an AI-authored entity a GM directly
 * edits has, by definition, just been looked at more closely than a mere
 * "review" would require) -- and doing it uniformly for every write is
 * simpler and more obviously correct than special-casing only the edit
 * path.
 */
import { loadSnapshot, snapshotFilePath } from "./snapshot.mjs";
import { nextMutationIndex } from "./mutation-ops.mjs";
import { createBatch, loadBatch, saveBatch, listBatches } from "../../mutation-engine/review-state.mjs";
import { acceptMutations } from "../../mutation-engine/rollback.mjs";
import { StoredMutation } from "../../mutation-engine/schema.mjs";
import { applyHeadless } from "../../graph-import/headless-apply.mjs";
import { markHumanReviewed } from "../../mutation-engine/human-review.mjs";
import { markPrepContentStale } from "../../mutation-engine/prep-content.mjs";
import {
  supersedeEntityNarration,
  saveEntityNarration,
  getCurrentEntityNarration
} from "../../mutation-engine/entity-narration.mjs";
import { setUndoSlot, consumeUndoSlot, getUndoSlot } from "../../mutation-engine/manual-undo.mjs";

// Every manual edit since the last sync/rollback lands in the SAME batch,
// found by this scope.mode tag -- see this module's own top-of-file doc
// comment for why (this is what makes "N manual edits not yet synced" a
// single coherent count/action, and what lets the existing Sync button work
// against it unmodified).
export const MANUAL_EDIT_SCOPE_MODE = "manual-edit";

/** Find this world's currently-open manual-edit batch, or start a fresh one. */
function findOrCreateManualEditBatch(w) {
  const open = listBatches(w).find((b) => b.status === "open" && b.scope?.mode === MANUAL_EDIT_SCOPE_MODE);
  if (open) return loadBatch(w, open.id);
  return createBatch(w, { mode: MANUAL_EDIT_SCOPE_MODE }, undefined, []);
}

/**
 * The actual write mechanism behind every manual write below (create/edit/
 * delete node/edge, and undo's own inverse) -- see this module's top-of-file
 * doc comment for the full "why". Applies ALL of `mutationCores` as ONE
 * atomic headless write (required for deleteNodeOp's cascade: the node's
 * own re-create AND every cascaded edge's re-create must land in a single
 * applyHeadless call, exactly as before this phase's change), after
 * appending them to the world's ongoing manual-edit batch and marking them
 * accepted (rollback.mjs's acceptMutations, which captures pre-state from
 * the SAME pre-write entities/edges snapshot this function loads once,
 * before any of these mutations apply -- matching that function's own "capture
 * before the mutation is ever applied" contract).
 *
 * @param {string} dir
 * @param {string} w
 * @param {Array<{op:string, id?:string, data?:object, rationale:string}>} mutationCores
 * @returns {{batchId:string, mutationIds:string[], headlessResult:object}}
 */
function applyManualMutations(dir, w, mutationCores) {
  const batch = findOrCreateManualEditBatch(w);
  const mutationIds = [];
  for (const core of mutationCores) {
    const mutationId = `m${nextMutationIndex(batch)}`;
    batch.mutations.push(
      StoredMutation.parse({ ...core, batchId: batch.id, mutationId, sourceKind: core.sourceKind ?? "manual", status: "pending" })
    );
    mutationIds.push(mutationId);
  }
  saveBatch(w, batch);

  const { entities, edges } = loadSnapshot(dir, w).snapshot;
  acceptMutations(w, batch.id, mutationIds, entities, edges);

  const snapshotPath = snapshotFilePath(dir, w);
  const headlessResult = applyHeadless(snapshotPath, mutationCores.map((c) => ({ op: c.op, id: c.id, data: c.data })));

  return { batchId: batch.id, mutationIds, headlessResult };
}

/** Single-mutation convenience wrapper over applyManualMutations. */
function applyManualMutation(dir, w, mutationCore) {
  const { batchId, mutationIds, headlessResult } = applyManualMutations(dir, w, [mutationCore]);
  return { batchId, mutationId: mutationIds[0], headlessResult };
}

/**
 * Same `wf_<ts36>_<random>` convention headless-apply.mjs's own
 * makeIdGenerator()/interchange.mjs's private defaultMakeId() already
 * establish -- a same-convention sibling (not a shared reference; each of
 * those is a per-call counter-based generator scoped to one batch/apply
 * call, whereas manual edits are independent one-off calls with no shared
 * counter to draw from, so a random suffix is used instead of a counter to
 * keep collision risk negligible without needing shared state).
 */
function makeManualId() {
  return `wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

// The subset of entity fields a manual create/edit is allowed to set
// directly -- deliberately excludes id/createdAt/updatedAt/source (bookkeeping
// GraphService/interchange.mjs itself own) and foundryRef/x/y (Foundry-authored
// fields with no meaningful manual-edit UI in this phase's scope, per the
// design doc's field list: "name/description/importance" for edit, plus this
// phase's own new metadata fields).
//
// Phase 22 task 22.2 addition: "attributes" -- both graph-service.mjs's
// upsertEntity() and interchange.mjs's normalizeEntity() already treat
// `attributes` as a generic pass-through bag (`data.attributes ?? existing?.attributes
// ?? {}`, verbatim in both), and it is the ONLY field on the entity schema's
// closed allowlist that can carry a genuinely new, un-enum'd marker without a
// foundry_worldFabric schema change -- session-planner/transit-entity.mjs's
// createTransitEntity relies on this to set `attributes.isTransit: true`
// through this SAME established addNodeOp mechanism (per plans/phase-21-review.md
// §12/plans/phase-22-tasks.md's explicit "don't invent a second entity-creation
// mechanism" instruction), rather than a second, parallel write path.
const ENTITY_EDITABLE_FIELDS = [
  "name", "type", "description", "summary", "importance", "tags",
  "status", "playerKnown", "canonLocked", "role", "namespace", "attributes"
];
const EDGE_EDITABLE_FIELDS = ["relationshipType", "label", "strength", "valence", "notes"];

function pickFields(source, fields) {
  const out = {};
  for (const f of fields) {
    if (source[f] !== undefined) out[f] = source[f];
  }
  return out;
}

// --- add ---------------------------------------------------------------

/**
 * @param {string} dir
 * @param {string} w
 * @param {object} fields  {name, type, description?, importance?, tags?, status?, playerKnown?, canonLocked?, role?}
 * @returns {Promise<{entityId:string, name:string, type:string}>}
 */
export async function addNodeOp(dir, w, fields = {}) {
  const name = requireNonEmptyString(fields.name, "name");
  const type = requireNonEmptyString(fields.type, "type");
  const id = makeManualId();
  const data = { id, name, type, ...pickFields(fields, ENTITY_EDITABLE_FIELDS.filter((f) => f !== "name" && f !== "type")) };

  applyManualMutation(dir, w, { op: "upsert_entity", id, data, rationale: `Manual edit: node "${name}" created.` });
  markHumanReviewed(w, [id]);

  setUndoSlot(w, {
    kind: "add_node",
    description: `Node "${name}" created.`,
    graphMutations: [{ op: "delete_entity", id }]
  });

  return { entityId: id, name, type };
}

/**
 * @param {string} dir
 * @param {string} w
 * @param {object} fields  {sourceId, targetId, relationshipType?, label?, strength?, valence?, notes?}
 * @returns {Promise<{edgeId:string, sourceId:string, targetId:string, relationshipType:string}>}
 */
export async function addEdgeOp(dir, w, fields = {}) {
  const sourceId = requireNonEmptyString(fields.sourceId, "sourceId");
  const targetId = requireNonEmptyString(fields.targetId, "targetId");
  if (sourceId === targetId) {
    throw new Error("Cannot create a self-loop edge (sourceId and targetId are the same entity).");
  }
  const { entities } = loadSnapshot(dir, w).snapshot;
  if (!entities.some((e) => e.id === sourceId)) throw new Error(`No entity "${sourceId}" found in the live graph.`);
  if (!entities.some((e) => e.id === targetId)) throw new Error(`No entity "${targetId}" found in the live graph.`);

  const id = makeManualId();
  const relationshipType = fields.relationshipType ?? "unspecified";
  const data = { id, sourceId, targetId, relationshipType, ...pickFields(fields, EDGE_EDITABLE_FIELDS.filter((f) => f !== "relationshipType")) };

  applyManualMutation(dir, w, { op: "upsert_edge", id, data, rationale: `Manual edit: edge created (${relationshipType}).` });
  markHumanReviewed(w, [sourceId, targetId]);

  setUndoSlot(w, {
    kind: "add_edge",
    description: `Edge created (${relationshipType}).`,
    graphMutations: [{ op: "delete_edge", id }]
  });

  return { edgeId: id, sourceId, targetId, relationshipType };
}

// --- edit ----------------------------------------------------------------

/**
 * @param {string} dir
 * @param {string} w
 * @param {{entityId:string, data:object}} args  `data` is a partial patch, same shape as any upsert_entity mutation's `data`
 * @returns {Promise<{entityId:string, updated:object}>}
 */
export async function editNodeOp(dir, w, { entityId, data } = {}) {
  requireNonEmptyString(entityId, "entityId");
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("editNodeOp requires a `data` object of fields to change.");
  }
  const { entities } = loadSnapshot(dir, w).snapshot;
  const before = entities.find((e) => e.id === entityId);
  if (!before) throw new Error(`No entity "${entityId}" found in the live graph.`);

  const patch = pickFields(data, ENTITY_EDITABLE_FIELDS);
  if (!Object.keys(patch).length) throw new Error("editNodeOp: no recognized editable fields in `data`.");

  applyManualMutation(dir, w, { op: "upsert_entity", id: entityId, data: patch, rationale: `Manual edit: "${before.name}" edited.` });
  markHumanReviewed(w, [entityId]);
  supersedeEntityNarration(w, entityId);
  markPrepContentStale(w, entityId);

  setUndoSlot(w, {
    kind: "edit_node",
    description: `"${before.name}" edited.`,
    graphMutations: [{ op: "upsert_entity", id: entityId, data: before }]
  });

  return { entityId, updated: patch };
}

/**
 * @param {string} dir
 * @param {string} w
 * @param {{edgeId:string, data:object}} args
 * @returns {Promise<{edgeId:string, updated:object}>}
 */
export async function editEdgeOp(dir, w, { edgeId, data } = {}) {
  requireNonEmptyString(edgeId, "edgeId");
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("editEdgeOp requires a `data` object of fields to change.");
  }
  const { edges } = loadSnapshot(dir, w).snapshot;
  const before = edges.find((e) => e.id === edgeId);
  if (!before) throw new Error(`No edge "${edgeId}" found in the live graph.`);

  const patch = pickFields(data, EDGE_EDITABLE_FIELDS);
  if (!Object.keys(patch).length) throw new Error("editEdgeOp: no recognized editable fields in `data`.");

  applyManualMutation(dir, w, { op: "upsert_edge", id: edgeId, data: patch, rationale: `Manual edit: edge (${before.relationshipType}) edited.` });
  markHumanReviewed(w, [before.sourceId, before.targetId]);

  setUndoSlot(w, {
    kind: "edit_edge",
    description: `Edge (${before.relationshipType}) edited.`,
    graphMutations: [{ op: "upsert_edge", id: edgeId, data: before }]
  });

  return { edgeId, updated: patch };
}

// --- reparent (Phase 30 task 30.1) ------------------------------------------

/**
 * Atomic drag-drop reparent for the World containment tree: removes every
 * existing `containment` edge where `entityId` is the CHILD (`sourceId`),
 * and -- unless unparenting -- adds exactly one new `containment` edge
 * `sourceId: entityId -> targetId: newParentId`. Both halves land in ONE
 * `applyManualMutations` call (the same atomic-batch mechanism every write
 * in this module already uses for a multi-mutation write, e.g.
 * deleteNodeOp's cascade) and ONE undo slot -- the single-slot undo
 * mechanism has no way to cover a separate delete-then-add as two
 * independent actions, so they MUST be grouped, per this task's own
 * requirement.
 *
 * `newParentId: null` (or omitted) means UNPARENT: every existing
 * containment edge is removed, no new one is added.
 *
 * CYCLE GUARD: a node can never become its own descendant. Walks the
 * containment chain upward from `newParentId` (child -> parent, i.e.
 * `sourceId -> targetId`, this project's own established containment
 * direction -- see addEdgeOp's callers / scene-elements.mjs's promoteElement);
 * if that walk ever reaches `entityId` itself, `newParentId` is currently a
 * DESCENDANT of `entityId`, so making `newParentId` the new parent would
 * create a cycle -- rejected before any write happens. A defensive
 * already-cyclic-data guard (a `seen` set) stops the walk from looping
 * forever even if the live graph somehow already contains a cycle from some
 * other source.
 *
 * @param {string} dir
 * @param {string} w
 * @param {string} entityId
 * @param {string|null} newParentId
 * @returns {Promise<{entityId:string, parentId:string|null, removedEdgeCount:number, edgeId:string|null}>}
 */
export async function reparentNode(dir, w, entityId, newParentId) {
  requireNonEmptyString(entityId, "entityId");
  const normalizedParentId = newParentId === undefined ? null : newParentId;
  const { entities, edges } = loadSnapshot(dir, w).snapshot;
  if (!entities.some((e) => e.id === entityId)) {
    throw new Error(`No entity "${entityId}" found in the live graph.`);
  }

  if (normalizedParentId !== null) {
    requireNonEmptyString(normalizedParentId, "newParentId");
    if (normalizedParentId === entityId) {
      throw new Error("Cannot reparent a node under itself.");
    }
    if (!entities.some((e) => e.id === normalizedParentId)) {
      throw new Error(`No entity "${normalizedParentId}" found in the live graph.`);
    }
    // Cycle guard: climb the containment chain from the PROPOSED parent
    // upward. If entityId turns up, normalizedParentId is currently one of
    // entityId's own descendants -- reparenting entityId under it would
    // make entityId its own ancestor.
    let cursor = normalizedParentId;
    const seen = new Set();
    while (cursor) {
      if (cursor === entityId) {
        throw new Error(
          `Cannot reparent "${entityId}" under "${normalizedParentId}" -- "${normalizedParentId}" is currently a descendant of "${entityId}" (this would create a cycle).`
        );
      }
      if (seen.has(cursor)) break; // defensive: pre-existing cycle in the data, never loop forever
      seen.add(cursor);
      const parentEdge = edges.find((e) => e.sourceId === cursor && e.relationshipType === "containment");
      cursor = parentEdge ? parentEdge.targetId : null;
    }
  }

  const existingEdges = edges.filter((e) => e.sourceId === entityId && e.relationshipType === "containment");

  const mutationCores = existingEdges.map((e) => ({
    op: "delete_edge",
    id: e.id,
    rationale: `Manual edit: reparent -- removed containment edge to "${e.targetId}".`
  }));

  let newEdgeId = null;
  if (normalizedParentId !== null) {
    newEdgeId = makeManualId();
    mutationCores.push({
      op: "upsert_edge",
      id: newEdgeId,
      data: { id: newEdgeId, sourceId: entityId, targetId: normalizedParentId, relationshipType: "containment" },
      rationale: `Manual edit: reparent -- containment edge to "${normalizedParentId}" created.`
    });
  }

  if (!mutationCores.length) {
    // Already unparented, and the caller asked to unparent again -- a
    // genuine no-op, not an error.
    return { entityId, parentId: null, removedEdgeCount: 0, edgeId: null };
  }

  applyManualMutations(dir, w, mutationCores);
  markHumanReviewed(w, normalizedParentId ? [entityId, normalizedParentId] : [entityId]);

  // Undo inverse, grouped as ONE action: re-create every removed edge with
  // its exact original data, and delete the new edge if one was created --
  // mirrors deleteNodeOp's own "capture pre-delete state for every cascaded
  // edge, restore all of them together" pattern, one level down (a
  // delete+add pair instead of a node-plus-cascade).
  const inverseMutations = [
    ...existingEdges.map((e) => ({ op: "upsert_edge", id: e.id, data: e })),
    ...(newEdgeId ? [{ op: "delete_edge", id: newEdgeId }] : [])
  ];
  setUndoSlot(w, {
    kind: "reparent_node",
    description: normalizedParentId
      ? `"${entityId}" reparented under "${normalizedParentId}".`
      : `"${entityId}" unparented.`,
    graphMutations: inverseMutations
  });

  return { entityId, parentId: normalizedParentId, removedEdgeCount: existingEdges.length, edgeId: newEdgeId };
}

// --- hybrid remove (Phase 34 task 34.1) -------------------------------------

/**
 * The "Remove from graph" hybrid delete (design record + plans/phase-34-
 * tasks.md's locked spec): for every containment CHILD of `entityId`
 * (edges where `entityId` is the containment PARENT -- `targetId`, per this
 * project's established child=sourceId/parent=targetId convention, same
 * direction reparentNode/scene-elements.mjs's promote already use), re-point
 * its containment edge to `entityId`'s OWN parent (or drop that edge
 * entirely if `entityId` is itself a root with no parent -- the child then
 * becomes a root). THEN delete `entityId` cascading its remaining edges
 * (its own upward containment edge, if any, plus every non-containment edge
 * touching it) -- composes reparentNode + deleteNodeOp's own internals, not
 * a third independent implementation of either half.
 *
 * ATOMICITY: every one of the above (0+ child reparent/drop mutations, plus
 * the node's own delete_entity) lands in ONE applyManualMutations call and
 * ONE undo slot, restoring the EXACT original topology on undo -- the
 * node itself, its own original edges (parent-direction + any non-
 * containment edges), AND every child's ORIGINAL containment edge (its
 * original targetId=entityId, whether that edge was repointed or dropped by
 * this op). This mirrors deleteNodeOp's own "capture pre-delete state for
 * every cascaded edge, restore all of them together" pattern, one level up
 * (children's edges plus the node's own edges, not just the node's own).
 *
 * `applyHeadless` does NOT process a call's mutations sequentially against
 * each other (each upsert merges onto the ORIGINAL pre-call snapshot, and
 * delete_entity's cascade runs as a separate pass over the FINAL merged
 * result afterward -- see headless-apply.mjs's own runApplyHeadless) --
 * which is exactly what makes emitting "repoint this child edge" and
 * "delete_entity for the node" in the SAME call correct regardless of
 * array order: a repointed child edge's `targetId` no longer equals
 * `entityId` in the merged result, so delete_entity's own cascade-delete
 * pass correctly leaves it alone (already reparented, not touching
 * `entityId` anymore) rather than double-handling it.
 *
 * @param {string} dir
 * @param {string} w
 * @param {string} entityId
 * @returns {Promise<{entityId:string, name:string, reparentedChildren:number, droppedEdges:number}>}
 */
export async function removeNodeReparentUp(dir, w, entityId) {
  requireNonEmptyString(entityId, "entityId");
  const { entities, edges } = loadSnapshot(dir, w).snapshot;
  const before = entities.find((e) => e.id === entityId);
  if (!before) throw new Error(`No entity "${entityId}" found in the live graph.`);

  // The node's own parent-direction containment edge(s) -- entityId is the
  // CHILD (sourceId). Reparenting logic below only ever needs "is entityId
  // a root or not," so the first one found is enough to answer that; any
  // additional (unusual, but legal per reparentNode's own precedent) parent
  // edges are still captured and restored via the generic cascadeEdges
  // sweep below.
  const parentEdge = edges.find((e) => e.sourceId === entityId && e.relationshipType === "containment");
  const grandparentId = parentEdge ? parentEdge.targetId : null;

  // The node's own containment CHILDREN -- entityId is the PARENT (targetId).
  const childEdges = edges.filter((e) => e.targetId === entityId && e.relationshipType === "containment");
  const childEdgeIds = new Set(childEdges.map((e) => e.id));

  const reparentMutations = [];
  let reparentedChildren = 0;
  let droppedEdges = 0;
  for (const childEdge of childEdges) {
    if (grandparentId !== null) {
      reparentMutations.push({
        op: "upsert_edge",
        id: childEdge.id,
        data: { targetId: grandparentId },
        rationale:
          `Manual edit: remove-from-graph -- "${childEdge.sourceId}" reparented up from "${entityId}" to "${grandparentId}".`
      });
      reparentedChildren++;
    } else {
      reparentMutations.push({
        op: "delete_edge",
        id: childEdge.id,
        rationale:
          `Manual edit: remove-from-graph -- containment link from "${childEdge.sourceId}" dropped ` +
          `("${entityId}" had no parent to reparent up to, so "${childEdge.sourceId}" becomes a root).`
      });
      droppedEdges++;
    }
  }

  // Every OTHER edge touching entityId -- its own parent-direction edge(s)
  // plus any non-containment edge from either side -- captured for the
  // undo restore AND left to delete_entity's own cascade to remove (see
  // this function's own doc comment for why omitting these from the
  // mutation array entirely, relying on the cascade, is correct here).
  const cascadeEdges = edges.filter((e) => (e.sourceId === entityId || e.targetId === entityId) && !childEdgeIds.has(e.id));

  const mutationCores = [
    ...reparentMutations,
    {
      op: "delete_entity",
      id: entityId,
      rationale:
        `Manual edit: "${before.name}" removed from the graph (${reparentedChildren} child(ren) reparented up, ` +
        `${droppedEdges} link(s) dropped).`
    }
  ];

  applyManualMutations(dir, w, mutationCores);
  supersedeEntityNarration(w, entityId);
  markPrepContentStale(w, entityId);
  const touchedForReview = [...childEdges.map((e) => e.sourceId), ...(grandparentId ? [grandparentId] : [])];
  if (touchedForReview.length) markHumanReviewed(w, touchedForReview);

  // Undo inverse, grouped as ONE action: re-create the node itself, every
  // one of its own cascade-captured edges, AND every child's ORIGINAL
  // containment edge (original id, original targetId=entityId) -- restores
  // the exact original topology, not just "the node comes back."
  const graphMutations = [
    { op: "upsert_entity", id: entityId, data: before },
    ...cascadeEdges.map((e) => ({ op: "upsert_edge", id: e.id, data: e })),
    ...childEdges.map((e) => ({ op: "upsert_edge", id: e.id, data: e }))
  ];
  setUndoSlot(w, {
    kind: "remove_reparent_up",
    description:
      `"${before.name}" removed from the graph (${reparentedChildren} child(ren) reparented up, ${droppedEdges} link(s) dropped).`,
    graphMutations
  });

  return { entityId, name: before.name, reparentedChildren, droppedEdges };
}

// --- delete ----------------------------------------------------------------

/**
 * Deletes a node AND every edge touching it (matching graph-service.mjs's
 * live delete_entity cascade / headless-apply.mjs's own equivalent cascade
 * filter) as one write, and captures a SINGLE undo action covering both --
 * the design doc's explicit "delete node with its cascade as ONE atomic
 * undo unit" requirement.
 *
 * @param {string} dir
 * @param {string} w
 * @param {{entityId:string}} args
 * @returns {Promise<{entityId:string, name:string, cascadeEdgeCount:number}>}
 */
export async function deleteNodeOp(dir, w, { entityId } = {}) {
  requireNonEmptyString(entityId, "entityId");
  const { entities, edges } = loadSnapshot(dir, w).snapshot;
  const before = entities.find((e) => e.id === entityId);
  if (!before) throw new Error(`No entity "${entityId}" found in the live graph.`);
  const cascadeEdges = edges.filter((e) => e.sourceId === entityId || e.targetId === entityId);

  applyManualMutation(dir, w, {
    op: "delete_entity",
    id: entityId,
    rationale: `Manual edit: "${before.name}" deleted (with ${cascadeEdges.length} connected edge${cascadeEdges.length === 1 ? "" : "s"}).`
  });
  supersedeEntityNarration(w, entityId);
  markPrepContentStale(w, entityId);

  const graphMutations = [
    { op: "upsert_entity", id: entityId, data: before },
    ...cascadeEdges.map((e) => ({ op: "upsert_edge", id: e.id, data: e }))
  ];
  setUndoSlot(w, {
    kind: "delete_node",
    description: `"${before.name}" deleted (with ${cascadeEdges.length} connected edge${cascadeEdges.length === 1 ? "" : "s"}).`,
    graphMutations
  });

  return { entityId, name: before.name, cascadeEdgeCount: cascadeEdges.length };
}

/**
 * @param {string} dir
 * @param {string} w
 * @param {{edgeId:string}} args
 * @returns {Promise<{edgeId:string, relationshipType:string}>}
 */
export async function deleteEdgeOp(dir, w, { edgeId } = {}) {
  requireNonEmptyString(edgeId, "edgeId");
  const { edges } = loadSnapshot(dir, w).snapshot;
  const before = edges.find((e) => e.id === edgeId);
  if (!before) throw new Error(`No edge "${edgeId}" found in the live graph.`);

  applyManualMutation(dir, w, { op: "delete_edge", id: edgeId, rationale: `Manual edit: edge (${before.relationshipType}) deleted.` });

  setUndoSlot(w, {
    kind: "delete_edge",
    description: `Edge (${before.relationshipType}) deleted.`,
    graphMutations: [{ op: "upsert_edge", id: edgeId, data: before }]
  });

  return { edgeId, relationshipType: before.relationshipType };
}

// --- narration reset (Phase 12 task 12.6) -----------------------------------

/**
 * Appends a new empty-content 'current' version to the entity's existing
 * narration history (entity-narration.mjs's OWN versioning mechanism,
 * completely unchanged) with `origin:'reset'`, superseding whatever was
 * current before -- nothing is ever deleted, matching that module's
 * standing invariant. Records the PRIOR current narration's prose (or null,
 * if there wasn't one) onto the manual-undo slot so undoing a reset can
 * restore it via a SECOND append (also never a delete) -- see
 * undoLastManualEditOp below.
 *
 * @param {string} w
 * @param {{entityId:string}} args
 * @returns {{entityId:string, history:object[]}}
 */
export function resetEntityNarrationOp(w, { entityId } = {}) {
  requireNonEmptyString(entityId, "entityId");
  const priorCurrent = getCurrentEntityNarration(w, entityId);
  const priorProse = priorCurrent ? priorCurrent.prose : null;

  const history = saveEntityNarration(w, entityId, { prose: "", origin: "reset" });

  setUndoSlot(w, {
    kind: "narration_reset",
    description: `Narration reset for ${entityId}.`,
    narrationUndo: { entityId, priorProse }
  });

  return { entityId, history };
}

// --- undo (Phase 12 task 12.4) ----------------------------------------------

/**
 * The single-slot undo consumer. Reads and CLEARS the slot atomically first
 * (mutation-engine/manual-undo.mjs's consumeUndoSlot), then applies the
 * inverse -- either a graph-mutations array or a narration-history append
 * (entity-narration.mjs's own saveEntityNarration/supersedeEntityNarration,
 * no new mechanism).
 *
 * PHASE 13: undo's own graph-mutations inverse now goes through the SAME
 * applyManualMutations (headless-immediate, appended to the ongoing
 * manual-edit batch) every other write in this module uses -- deliberately
 * NOT the old dual-path live-first function. Routing undo through the live
 * bridge independently of the batch it's undoing would be a real
 * correctness risk, not just a speed one: if a live Foundry client happened
 * to be open, undo's inverse could apply THERE while the original
 * (still-unsynced, still-accepted-in-the-manual-edit-batch) mutation it's
 * undoing never got removed from that batch -- a LATER sync of that batch
 * would then re-apply the original change on top of the live undo,
 * resurrecting exactly what was just undone. Keeping undo on the same
 * headless-immediate+batch-accumulation path sidesteps this entirely: both
 * the original write and its undo end up as two ordinary entries in the
 * SAME batch (create then delete, say), and syncing that batch later
 * replays both in order for a net-zero live effect -- always consistent
 * with the headless snapshot's own already-correct end state, at the cost
 * of one syncable no-op instead of a rewritten history.
 *
 * @param {string} dir
 * @param {string} w
 * @returns {Promise<{status:'empty'}|{status:'undone', kind:string, description:string}>}
 */
export async function undoLastManualEditOp(dir, w) {
  const action = consumeUndoSlot(w);
  if (!action) return { status: "empty", note: "Nothing to undo." };

  if (action.graphMutations) {
    applyManualMutations(dir, w, action.graphMutations.map((m) => ({ ...m, rationale: `Undo: ${action.description}` })));
    // Symmetry with the original write: whatever this undo just re-created/
    // re-set never shows up freshly flagged amber either.
    const touchedIds = [...new Set(action.graphMutations.map((m) => m.id).filter(Boolean))];
    if (touchedIds.length) markHumanReviewed(w, touchedIds);
    return { status: "undone", kind: action.kind, description: action.description };
  }

  const { entityId, priorProse } = action.narrationUndo;
  if (priorProse !== null) {
    // Restore the prior text as a NEW current entry (appended, never
    // overwriting/deleting the reset's own empty entry) -- entity-narration.mjs's
    // invariant holds through undo too, not just through the original write.
    saveEntityNarration(w, entityId, { prose: priorProse });
  } else {
    // Nothing was current before the reset -- restore that exact state by
    // superseding the reset's empty entry with no replacement, rather than
    // inventing a placeholder narration that was never real.
    supersedeEntityNarration(w, entityId);
  }
  return { status: "undone", kind: action.kind, description: action.description };
}

/** Read-only: what the undo toolbar item/toast should show, without consuming anything. */
export function getManualUndoStatusOp(w) {
  const action = getUndoSlot(w);
  return { available: !!action, action };
}

// --- deferred-sync status (Phase 13 task 13.1) ------------------------------

/**
 * Read-only: the standalone Graph view's "N manual edits not yet synced to
 * Foundry" affordance -- mirrors the Review screen's existing sync-bar
 * pattern (review-ui's #review-sync-bar/renderSyncBar), just pointed at the
 * world's ongoing manual-edit batch (see findOrCreateManualEditBatch above)
 * instead of a specific already-open reviewed batch. Syncing itself reuses
 * the EXISTING /api/batches/:batchId/sync route (mutation-ops.mjs's syncOp)
 * completely unmodified -- this function only reports what to point that
 * route at.
 *
 * @param {string} w
 * @returns {{batchId:string|null, unsyncedCount:number}}
 */
export function getManualEditSyncStatusOp(w) {
  const open = listBatches(w).find((b) => b.status === "open" && b.scope?.mode === MANUAL_EDIT_SCOPE_MODE);
  if (!open || !open.acceptedCount) return { batchId: null, unsyncedCount: 0 };
  return { batchId: open.id, unsyncedCount: open.acceptedCount };
}
