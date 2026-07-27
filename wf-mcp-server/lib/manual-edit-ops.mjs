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
 * Every write below goes through the SAME live-then-headless apply path
 * every other write in this project uses
 * (wf-mcp-server/lib/mutation-ops.mjs's applyMutationsWithHeadlessFallback)
 * — a manual edit is structurally the same kind of write as a synced batch
 * mutation, just without a review-state.mjs Batch wrapping it first, so it
 * reuses that machinery directly rather than reinventing a second apply
 * path (per gm-tools-conventions' "front-ends are thin wrappers" and "reuse
 * existing primitives" rules).
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
 * applyMutationsWithHeadlessFallback call, satisfying the design doc's
 * explicit "delete node with its cascade as ONE atomic undo unit"
 * requirement structurally, not just by intention.
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
import { loadSnapshot } from "./snapshot.mjs";
import { applyMutationsWithHeadlessFallback } from "./mutation-ops.mjs";
import { markHumanReviewed } from "../../mutation-engine/human-review.mjs";
import { markPrepContentStale } from "../../mutation-engine/prep-content.mjs";
import {
  supersedeEntityNarration,
  saveEntityNarration,
  getCurrentEntityNarration
} from "../../mutation-engine/entity-narration.mjs";
import { setUndoSlot, consumeUndoSlot, getUndoSlot } from "../../mutation-engine/manual-undo.mjs";

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
// GraphService/interchange.mjs itself own) and attributes/foundryRef/x/y
// (Foundry-authored fields with no meaningful manual-edit UI in this phase's
// scope, per the design doc's field list: "name/description/importance" for
// edit, plus this phase's own new metadata fields).
const ENTITY_EDITABLE_FIELDS = [
  "name", "type", "description", "summary", "importance", "tags",
  "status", "playerKnown", "canonLocked", "role", "namespace"
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

  await applyMutationsWithHeadlessFallback(dir, w, [{ op: "upsert_entity", id, data }]);
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

  await applyMutationsWithHeadlessFallback(dir, w, [{ op: "upsert_edge", id, data }]);
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

  await applyMutationsWithHeadlessFallback(dir, w, [{ op: "upsert_entity", id: entityId, data: patch }]);
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

  await applyMutationsWithHeadlessFallback(dir, w, [{ op: "upsert_edge", id: edgeId, data: patch }]);
  markHumanReviewed(w, [before.sourceId, before.targetId]);

  setUndoSlot(w, {
    kind: "edit_edge",
    description: `Edge (${before.relationshipType}) edited.`,
    graphMutations: [{ op: "upsert_edge", id: edgeId, data: before }]
  });

  return { edgeId, updated: patch };
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

  await applyMutationsWithHeadlessFallback(dir, w, [{ op: "delete_entity", id: entityId }]);
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

  await applyMutationsWithHeadlessFallback(dir, w, [{ op: "delete_edge", id: edgeId }]);

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
 * inverse -- either a graph-mutations array (via the same live-then-headless
 * apply path every write in this module uses) or a narration-history append
 * (entity-narration.mjs's own saveEntityNarration/supersedeEntityNarration,
 * no new mechanism).
 *
 * @param {string} dir
 * @param {string} w
 * @returns {Promise<{status:'empty'}|{status:'undone', kind:string, description:string}>}
 */
export async function undoLastManualEditOp(dir, w) {
  const action = consumeUndoSlot(w);
  if (!action) return { status: "empty", note: "Nothing to undo." };

  if (action.graphMutations) {
    await applyMutationsWithHeadlessFallback(dir, w, action.graphMutations);
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
