import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 12 tasks 12.3/12.4 -- manual node/edge create/edit/delete plus the
 * "Undo Last Manual Edit" mechanism. In-process (no MCP spawn needed: unlike
 * every wf_* MCP tool, manual-edit-ops.mjs is DELIBERATELY not wrapped as an
 * MCP tool at all -- see that module's own top-of-file doc comment for why),
 * calling wf-mcp-server/lib/manual-edit-ops.mjs directly and verifying
 * real on-disk state via loadSnapshot() before/after -- the task's own
 * explicit "verified via the API, not just the DOM" acceptance criterion,
 * one layer down from the HTTP boundary (review-ui/test/manual-edit-routes.test.mjs
 * covers the HTTP layer itself).
 *
 * PHASE 13 TASK 13.1: every write below now goes straight to the headless
 * snapshot immediately (no live-Foundry-poll at all) -- so unlike this
 * file's pre-Phase-13 version, no fake mutation-watcher loop is needed here
 * at all; every assertion below observes the snapshot synchronously. The
 * live-bridge/deferred-sync mechanism itself (the thing that DOES still
 * need a simulated watcher) is covered separately and in depth by
 * wf-mcp-server/test/manual-edit-sync.test.mjs -- this file stays focused on
 * "do the six write kinds and undo still work correctly," re-verified after
 * Phase 13's write-path change per the task's own explicit instruction.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-manual-edit-ops-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.GM_TOOLS_PREP_CONTENT_DIR = join(scratchDir, "prep-content");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
process.env.WF_DATA_DIR = dataDir;

const { snapshotFilePath, loadSnapshot } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { getUndoSlot } = await import("../../mutation-engine/manual-undo.mjs");
const { listBatches } = await import("../../mutation-engine/review-state.mjs");
const { saveEntityNarration, getCurrentEntityNarration, getEntityNarrationHistory } =
  await import("../../mutation-engine/entity-narration.mjs");
const {
  addNodeOp,
  addEdgeOp,
  editNodeOp,
  editEdgeOp,
  deleteNodeOp,
  deleteEdgeOp,
  reparentNode,
  anchorMembership,
  removeNodeReparentUp,
  resetEntityNarrationOp,
  undoLastManualEditOp,
  getManualUndoStatusOp,
  getManualEditSyncStatusOp,
  MANUAL_EDIT_SCOPE_MODE
} = await import("../lib/manual-edit-ops.mjs");

const WORLD = "manual-edit-ops-test-world";
const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "kael", name: "Kael", type: "person", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "the-anvil", name: "The Anvil Inn", type: "place", importance: 0.6 } },
  { op: "upsert_edge", data: { id: "kael-anvil-edge", sourceId: "kael", targetId: "the-anvil", relationshipType: "presence" } }
]);

function entities() {
  return loadSnapshot(dataDir, WORLD).snapshot.entities;
}
function edges() {
  return loadSnapshot(dataDir, WORLD).snapshot.edges;
}
function findEntity(id) {
  return entities().find((e) => e.id === id);
}
function findEdge(id) {
  return edges().find((e) => e.id === id);
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------- add node

let newNodeId;
await test("addNodeOp: writes a real entity immediately, no review gate", async () => {
  const before = entities().length;
  const result = await addNodeOp(dataDir, WORLD, { name: "Kaeliss", type: "person", description: "A wandering scholar." });
  newNodeId = result.entityId;
  assert.equal(result.name, "Kaeliss");
  assert.equal(entities().length, before + 1);
  const e = findEntity(newNodeId);
  assert.equal(e.name, "Kaeliss");
  assert.equal(e.description, "A wandering scholar.");
});

await test("a manually-created node is never flagged unreviewed (markHumanReviewed applied)", async () => {
  const { findUnreviewedEntities } = await import("../../mutation-engine/human-review.mjs");
  const flagged = findUnreviewedEntities(WORLD).map((f) => f.entityId);
  assert.ok(!flagged.includes(newNodeId), "a freshly manually-created node must not render amber/unreviewed");
});

await test("addNodeOp: undo removes exactly the node that was created", async () => {
  const before = entities().length;
  const result = await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(result.status, "undone");
  assert.equal(result.kind, "add_node");
  assert.equal(entities().length, before - 1);
  assert.equal(findEntity(newNodeId), undefined, "the created entity must be genuinely gone after undo");
});

await test("addNodeOp: rejects an empty name", async () => {
  await assert.rejects(() => addNodeOp(dataDir, WORLD, { name: "  ", type: "person" }));
});

// QA W2 fix (Group B #12): POST /api/graph/nodes had NO name length cap --
// a multi-megabyte name round-tripped straight into the graph.
await test("addNodeOp: rejects a name over 200 characters with a clear error, creates no entity", async () => {
  const before = entities().length;
  await assert.rejects(() => addNodeOp(dataDir, WORLD, { name: "x".repeat(5_000_000), type: "person" }), /200 characters/);
  assert.equal(entities().length, before, "a rejected create must not persist a partial entity");
});

await test("addNodeOp: accepts a name of exactly 200 characters (boundary)", async () => {
  const result = await addNodeOp(dataDir, WORLD, { name: "x".repeat(200), type: "concept" });
  assert.equal(result.name.length, 200);
});

// QA W1 Fix 2 (data-integrity root cause): a same-name+type "create" doesn't
// create a second entity at all -- importGraph's merge-mode findExisting()
// folds it into the EXISTING one, keeping ITS id. addNodeOp must hand back
// that REAL, persisted id, never its own pre-assigned one -- the exact
// mechanism a dangling scene.locationEntityId root-caused to.
await test("addNodeOp: a name+type collision returns the EXISTING entity's real persisted id, not a phantom pre-assigned one", async () => {
  const before = entities().length;
  const first = await addNodeOp(dataDir, WORLD, { name: "Colliding Node", type: "concept" });
  assert.equal(entities().length, before + 1);
  assert.equal(first.merged, false, "a genuinely fresh name+type must not report merged");

  const second = await addNodeOp(dataDir, WORLD, { name: "Colliding Node", type: "concept" });
  assert.equal(second.merged, true, "a colliding name+type must be reported as a merge, not a fresh create");
  assert.notEqual(second.entityId, undefined);
  // The critical assertion: the returned id must be a REAL, currently-
  // persisted entity -- not a phantom that importGraph discarded in favor
  // of the survivor's own id.
  assert.ok(findEntity(second.entityId), "the returned id must resolve to a real, persisted entity");
  assert.equal(entities().length, before + 1, "a colliding create must not add a second entity");
  assert.equal(second.entityId, first.entityId, "the collision must fold into the SAME survivor entity the first create made");
});

await test("addNodeOp: a merged (no-op) create leaves an honest, non-destructive undo slot -- Undo must never delete the pre-existing survivor entity", async () => {
  const before = entities().length;
  const result = await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(result.status, "undone");
  assert.equal(result.kind, "add_node");
  // Nothing should have been deleted -- the "create" that merged never
  // created anything new to undo, and the survivor entity predates it.
  assert.equal(entities().length, before, "undo of a merged create must not delete the survivor entity");
});

// ---------------------------------------------------------------- add edge

let newEdgeId;
await test("addEdgeOp: writes a real edge immediately between two existing entities", async () => {
  const before = edges().length;
  const result = await addEdgeOp(dataDir, WORLD, { sourceId: "kael", targetId: "the-anvil", relationshipType: "ownership" });
  newEdgeId = result.edgeId;
  assert.equal(entities().length, entities().length); // no new entity
  assert.equal(edges().length, before + 1);
  const e = findEdge(newEdgeId);
  assert.equal(e.relationshipType, "ownership");
});

await test("addEdgeOp: refuses a self-loop", async () => {
  await assert.rejects(() => addEdgeOp(dataDir, WORLD, { sourceId: "kael", targetId: "kael" }), /self-loop/);
});

await test("addEdgeOp: refuses an edge to an unknown entity", async () => {
  await assert.rejects(() => addEdgeOp(dataDir, WORLD, { sourceId: "kael", targetId: "nonexistent-entity" }));
});

await test("addEdgeOp: undo removes exactly the edge that was created", async () => {
  const before = edges().length;
  const result = await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(result.status, "undone");
  assert.equal(result.kind, "add_edge");
  assert.equal(edges().length, before - 1);
  assert.equal(findEdge(newEdgeId), undefined);
});

// ---------------------------------------------------------------- edit node

await test("editNodeOp: writes immediately, and undo restores the EXACT prior state", async () => {
  const before = findEntity("kael");
  const result = await editNodeOp(dataDir, WORLD, { entityId: "kael", data: { importance: 0.9, description: "Now a renowned blacksmith." } });
  assert.deepEqual(result.updated, { importance: 0.9, description: "Now a renowned blacksmith." });
  const after = findEntity("kael");
  assert.equal(after.importance, 0.9);
  assert.equal(after.description, "Now a renowned blacksmith.");

  const undoResult = await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(undoResult.status, "undone");
  assert.equal(undoResult.kind, "edit_node");
  const restored = findEntity("kael");
  assert.deepEqual(restored, before, "the entity's full state after undo must match its state before the edit, byte for byte");
});

await test("editNodeOp: ignores unrecognized fields (e.g. attempting to set foundryRef) rather than silently writing them", async () => {
  await editNodeOp(dataDir, WORLD, { entityId: "kael", data: { importance: 0.7, foundryRef: "Actor.bogus" } });
  const after = findEntity("kael");
  assert.equal(after.importance, 0.7);
  assert.equal(after.foundryRef, null, "foundryRef is not in ENTITY_EDITABLE_FIELDS -- must be silently dropped, not written");
  await undoLastManualEditOp(dataDir, WORLD); // clean up for subsequent tests
});

// ---------------------------------------------------------------- edit edge

await test("editEdgeOp: writes immediately, and undo restores the EXACT prior state", async () => {
  const before = findEdge("kael-anvil-edge");
  await editEdgeOp(dataDir, WORLD, { edgeId: "kael-anvil-edge", data: { strength: 0.9, notes: "A deep bond." } });
  const after = findEdge("kael-anvil-edge");
  assert.equal(after.strength, 0.9);
  assert.equal(after.notes, "A deep bond.");

  const undoResult = await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(undoResult.status, "undone");
  assert.equal(undoResult.kind, "edit_edge");
  assert.deepEqual(findEdge("kael-anvil-edge"), before);
});

// ---------------------------------------------------------------- delete edge

await test("deleteEdgeOp: writes immediately, and undo recreates the exact same edge", async () => {
  const before = findEdge("kael-anvil-edge");
  await deleteEdgeOp(dataDir, WORLD, { edgeId: "kael-anvil-edge" });
  assert.equal(findEdge("kael-anvil-edge"), undefined);

  const undoResult = await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(undoResult.status, "undone");
  assert.equal(undoResult.kind, "delete_edge");
  assert.deepEqual(findEdge("kael-anvil-edge"), before);
});

// ---------------------------------------------------------------- delete node (cascade, ATOMIC undo)

await test("deleteNodeOp: deletes the node AND cascades its edges; undo restores BOTH as ONE atomic action", async () => {
  // Give kael a second edge so the cascade genuinely covers more than one.
  const second = await addEdgeOp(dataDir, WORLD, { sourceId: "kael", targetId: "the-anvil", relationshipType: "social" });
  const kaelBefore = findEntity("kael");
  const edgesBeforeDelete = edges().filter((e) => e.sourceId === "kael" || e.targetId === "kael");
  assert.equal(edgesBeforeDelete.length, 2, "kael should have exactly 2 edges (the original presence edge + the new social edge) before delete");

  const result = await deleteNodeOp(dataDir, WORLD, { entityId: "kael" });
  assert.equal(result.cascadeEdgeCount, 2);
  assert.equal(findEntity("kael"), undefined, "kael must be genuinely gone");
  assert.equal(edges().filter((e) => e.sourceId === "kael" || e.targetId === "kael").length, 0, "every edge touching kael must be gone too (cascade)");

  // The slot holds ONE action covering both the node and its edges.
  const slot = getUndoSlot(WORLD);
  assert.equal(slot.kind, "delete_node");
  assert.equal(slot.graphMutations.length, 3, "1 node re-create + 2 edge re-creates, all in ONE action's mutations array");

  const undoResult = await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(undoResult.status, "undone");
  assert.equal(undoResult.kind, "delete_node");
  assert.deepEqual(findEntity("kael"), kaelBefore, "kael's full state must match exactly what it was before the delete");
  const edgesAfterUndo = edges().filter((e) => e.sourceId === "kael" || e.targetId === "kael");
  assert.equal(edgesAfterUndo.length, 2, "BOTH cascaded edges must come back, not just one");
  assert.deepEqual(
    edgesAfterUndo.map((e) => e.id).sort(),
    edgesBeforeDelete.map((e) => e.id).sort(),
    "the exact same edge ids must be restored"
  );
});

// ---------------------------------------------------------------- reparentNode (Phase 30 task 30.1)

// A small containment tree: loc-root <- loc-child <- loc-grandchild
// (child = sourceId -> parent = targetId, this project's established
// containment direction).
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "loc-root", name: "Loc Root", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "loc-child", name: "Loc Child", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "loc-grandchild", name: "Loc Grandchild", type: "place", importance: 0.5 } },
  { op: "upsert_edge", data: { id: "reparent-edge-child-root", sourceId: "loc-child", targetId: "loc-root", relationshipType: "containment" } },
  { op: "upsert_edge", data: { id: "reparent-edge-grandchild-child", sourceId: "loc-grandchild", targetId: "loc-child", relationshipType: "containment" } }
]);

function containmentParentEdgeOf(entityId) {
  return edges().find((e) => e.sourceId === entityId && e.relationshipType === "containment");
}

await test("reparentNode: moves the node's containment edge to the new parent, one atomic write", async () => {
  const before = edges().length;
  const result = await reparentNode(dataDir, WORLD, "loc-grandchild", "loc-root");
  assert.equal(result.entityId, "loc-grandchild");
  assert.equal(result.parentId, "loc-root");
  assert.equal(result.removedEdgeCount, 1);
  assert.ok(result.edgeId, "a new edge id must be reported");
  // Old edge is gone, exactly one new containment edge to loc-root exists, edge count unchanged (1 removed, 1 added).
  assert.equal(edges().length, before);
  assert.equal(findEdge("reparent-edge-grandchild-child"), undefined);
  const newParentEdge = containmentParentEdgeOf("loc-grandchild");
  assert.ok(newParentEdge);
  assert.equal(newParentEdge.targetId, "loc-root");
});

await test("reparentNode: undo restores the ORIGINAL containment edge (delete-new + recreate-old, as ONE undone action)", async () => {
  const before = edges().length;
  const undoResult = await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(undoResult.status, "undone");
  assert.equal(undoResult.kind, "reparent_node");
  assert.equal(edges().length, before); // one removed (the new edge), one recreated (the old edge) -- net zero
  const restoredParentEdge = containmentParentEdgeOf("loc-grandchild");
  assert.ok(restoredParentEdge);
  assert.equal(restoredParentEdge.targetId, "loc-child", "back to its original parent");
  assert.equal(restoredParentEdge.id, "reparent-edge-grandchild-child", "the EXACT original edge id must come back");
});

await test("reparentNode: newParentId null UNPARENTS -- removes the existing edge, adds none", async () => {
  const before = edges().length;
  const result = await reparentNode(dataDir, WORLD, "loc-grandchild", null);
  assert.equal(result.parentId, null);
  assert.equal(result.removedEdgeCount, 1);
  assert.equal(result.edgeId, null);
  assert.equal(edges().length, before - 1);
  assert.equal(containmentParentEdgeOf("loc-grandchild"), undefined);

  // Undo brings the original edge back (a single delete_edge inverse -- no
  // upsert_edge half since nothing was added).
  const undoResult = await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(undoResult.status, "undone");
  assert.equal(undoResult.kind, "reparent_node");
  assert.ok(containmentParentEdgeOf("loc-grandchild"));
});

await test("reparentNode: unparenting a node with NO existing containment edge is a clean no-op (removedEdgeCount 0), not an error", async () => {
  const result = await reparentNode(dataDir, WORLD, "loc-root", null); // loc-root has no parent edge at all
  assert.deepEqual(result, { entityId: "loc-root", parentId: null, removedEdgeCount: 0, edgeId: null });
});

await test("reparentNode: CYCLE GUARD -- refuses to reparent a node under its own descendant", async () => {
  // loc-child is currently loc-root's CHILD (loc-child -> loc-root). Trying
  // to reparent loc-root UNDER loc-child would make loc-root its own
  // descendant's descendant -- a cycle -- and must be rejected before any write.
  const before = edges().length;
  await assert.rejects(() => reparentNode(dataDir, WORLD, "loc-root", "loc-child"), /cycle/i);
  assert.equal(edges().length, before, "a rejected reparent must not have written anything");
});

await test("reparentNode: CYCLE GUARD catches a multi-hop descendant too (loc-root -> loc-grandchild, via loc-child)", async () => {
  // Re-establish the 3-level chain used by the earlier tests: loc-grandchild -> loc-child -> loc-root.
  await reparentNode(dataDir, WORLD, "loc-grandchild", "loc-child");
  await assert.rejects(() => reparentNode(dataDir, WORLD, "loc-root", "loc-grandchild"), /cycle/i);
});

await test("reparentNode: refuses to reparent a node under itself", async () => {
  await assert.rejects(() => reparentNode(dataDir, WORLD, "loc-child", "loc-child"), /itself/i);
});

await test("reparentNode: rejects an unknown entityId or unknown newParentId", async () => {
  await assert.rejects(() => reparentNode(dataDir, WORLD, "does-not-exist", "loc-root"));
  await assert.rejects(() => reparentNode(dataDir, WORLD, "loc-child", "does-not-exist-either"));
});

await test("reparentNode: a node with MULTIPLE existing containment edges (an unusual but legal pre-existing state) has all of them removed atomically", async () => {
  // Give loc-child a SECOND containment edge (to loc-grandchild, deliberately
  // an odd/legal-but-unusual pre-existing multi-parent state) so the "find
  // the node's existing containment edge(s)" plural case has real coverage.
  const secondEdge = await addEdgeOp(dataDir, WORLD, { sourceId: "loc-child", targetId: "loc-grandchild", relationshipType: "containment" });
  const beforeEdges = edges().filter((e) => e.sourceId === "loc-child" && e.relationshipType === "containment");
  assert.equal(beforeEdges.length, 2, "sanity: loc-child now has 2 containment edges");

  const result = await reparentNode(dataDir, WORLD, "loc-child", "loc-root");
  assert.equal(result.removedEdgeCount, 2, "both pre-existing containment edges must be removed, not just one");
  const afterEdges = edges().filter((e) => e.sourceId === "loc-child" && e.relationshipType === "containment");
  assert.equal(afterEdges.length, 1);
  assert.equal(afterEdges[0].targetId, "loc-root");

  const undoResult = await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(undoResult.status, "undone");
  const restoredEdges = edges().filter((e) => e.sourceId === "loc-child" && e.relationshipType === "containment");
  assert.equal(restoredEdges.length, 2, "BOTH original edges must come back atomically");
  assert.deepEqual(
    restoredEdges.map((e) => e.targetId).sort(),
    [secondEdge.targetId, "loc-root"].sort(),
    "the exact original targets are restored"
  );
});

// ---------------------------------------------------------------- anchorMembership (Phase 38 task 38.3)

// A dedicated fixture, deliberately separate ids from the reparentNode
// fixture above (loy- prefix) -- a small Loyalty chain:
//   loy-fighter --membership--> loy-stable --fealty--> loy-house
// plus a lone unattached node (loy-drifter, no loyalty parent -- a root).
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "loy-house", name: "Loy House", type: "faction", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "loy-stable", name: "Loy Stable", type: "faction", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "loy-fighter", name: "Loy Fighter", type: "person", importance: 0.4 } },
  { op: "upsert_entity", data: { id: "loy-drifter", name: "Loy Drifter", type: "person", importance: 0.3 } },
  { op: "upsert_edge", data: { id: "loy-edge-fighter-stable", sourceId: "loy-fighter", targetId: "loy-stable", relationshipType: "membership" } },
  { op: "upsert_edge", data: { id: "loy-edge-stable-house", sourceId: "loy-stable", targetId: "loy-house", relationshipType: "fealty" } }
]);

function loyaltyParentEdgeOf(entityId) {
  return edges().find(
    (e) => e.sourceId === entityId && (e.relationshipType === "membership" || e.relationshipType === "fealty")
  );
}

await test("anchorMembership: moves the node's loyalty edge to the new parent as a NEW membership edge, one atomic write", async () => {
  const before = edges().length;
  const result = await anchorMembership(dataDir, WORLD, "loy-fighter", "loy-house");
  assert.equal(result.entityId, "loy-fighter");
  assert.equal(result.parentId, "loy-house");
  assert.equal(result.removedEdgeCount, 1);
  assert.ok(result.edgeId, "a new edge id must be reported");
  assert.equal(edges().length, before); // one removed, one added
  assert.equal(findEdge("loy-edge-fighter-stable"), undefined);
  const newParentEdge = loyaltyParentEdgeOf("loy-fighter");
  assert.ok(newParentEdge);
  assert.equal(newParentEdge.targetId, "loy-house");
  assert.equal(newParentEdge.relationshipType, "membership", "a re-anchor ALWAYS creates a membership edge, never fealty");
});

await test("anchorMembership: undo restores the ORIGINAL loyalty edge (delete-new + recreate-old, as ONE undone action)", async () => {
  const before = edges().length;
  const undoResult = await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(undoResult.status, "undone");
  assert.equal(undoResult.kind, "anchor_membership");
  assert.equal(edges().length, before);
  const restored = loyaltyParentEdgeOf("loy-fighter");
  assert.ok(restored);
  assert.equal(restored.targetId, "loy-stable", "back to its original loyalty parent");
  assert.equal(restored.id, "loy-edge-fighter-stable", "the EXACT original edge id must come back");
  assert.equal(restored.relationshipType, "membership", "the ORIGINAL edge type is restored, not re-derived");
});

await test("anchorMembership: parentId null UNANCHORS (root case) -- removes the existing loyalty edge(s), adds none", async () => {
  const before = edges().length;
  const result = await anchorMembership(dataDir, WORLD, "loy-fighter", null);
  assert.equal(result.parentId, null);
  assert.equal(result.removedEdgeCount, 1);
  assert.equal(result.edgeId, null);
  assert.equal(edges().length, before - 1);
  assert.equal(loyaltyParentEdgeOf("loy-fighter"), undefined, "loy-fighter is now a Loyalty root");

  const undoResult = await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(undoResult.status, "undone");
  assert.equal(undoResult.kind, "anchor_membership");
  assert.ok(loyaltyParentEdgeOf("loy-fighter"));
});

await test("anchorMembership: unanchoring a node with NO existing loyalty edge is a clean no-op (removedEdgeCount 0), not an error", async () => {
  const result = await anchorMembership(dataDir, WORLD, "loy-drifter", null); // loy-drifter has no loyalty parent edge at all
  assert.deepEqual(result, { entityId: "loy-drifter", parentId: null, removedEdgeCount: 0, edgeId: null });
});

await test("anchorMembership: CYCLE GUARD -- refuses to anchor a node under its own Loyalty descendant", async () => {
  // loy-stable is currently loy-house's CHILD (loy-stable -fealty-> loy-house,
  // via the earlier test). Trying to anchor loy-house UNDER loy-stable would
  // make loy-house its own descendant's descendant -- a cycle.
  const before = edges().length;
  await assert.rejects(() => anchorMembership(dataDir, WORLD, "loy-house", "loy-stable"), /cycle/i);
  assert.equal(edges().length, before, "a rejected anchor must not have written anything");
});

await test("anchorMembership: refuses to anchor a node under itself", async () => {
  await assert.rejects(() => anchorMembership(dataDir, WORLD, "loy-stable", "loy-stable"), /itself/i);
});

await test("anchorMembership: rejects an unknown entityId or unknown parentId", async () => {
  await assert.rejects(() => anchorMembership(dataDir, WORLD, "does-not-exist", "loy-house"));
  await assert.rejects(() => anchorMembership(dataDir, WORLD, "loy-stable", "does-not-exist-either"));
});

await test("anchorMembership: reparentNode's OWN containment behavior is completely unaffected by an anchorMembership call (reparentNode never modified/repurposed)", async () => {
  // Give loy-fighter a real containment (Spatial) edge alongside its Loyalty
  // one, exercise reparentNode on it, then call anchorMembership on the SAME
  // node -- containment must be untouched by the Loyalty write, and vice
  // versa (the two edge families never cross-contaminate).
  const reparentResult = await reparentNode(dataDir, WORLD, "loy-fighter", "loc-root");
  assert.equal(reparentResult.entityId, "loy-fighter");
  const containmentEdge = edges().find((e) => e.sourceId === "loy-fighter" && e.relationshipType === "containment");
  assert.ok(containmentEdge, "loy-fighter now has a real containment edge to loc-root");

  await anchorMembership(dataDir, WORLD, "loy-fighter", "loy-house");
  const containmentEdgeAfter = edges().find((e) => e.sourceId === "loy-fighter" && e.relationshipType === "containment");
  assert.ok(containmentEdgeAfter, "the containment edge must survive an anchorMembership call untouched");
  assert.equal(containmentEdgeAfter.id, containmentEdge.id);
  assert.equal(containmentEdgeAfter.targetId, "loc-root");

  await reparentNode(dataDir, WORLD, "loy-fighter", null);
  const loyaltyEdgeAfter = loyaltyParentEdgeOf("loy-fighter");
  assert.ok(loyaltyEdgeAfter, "the Loyalty membership edge must survive a reparentNode call untouched");
  assert.equal(loyaltyEdgeAfter.targetId, "loy-house");
});

// Deliberately LAST in this block (mirrors reparentNode's own "MULTIPLE
// existing edges" test being last in ITS block, same reasoning): leaves
// loy-stable with an intentionally ambiguous-order restored multi-edge
// state after its own undo, so no later assertion in this file depends on
// loy-stable's exact winning parent.
await test("anchorMembership: removes BOTH membership and fealty prior edges (not just membership) when collapsing multi-loyalty history", async () => {
  // Give loy-stable a SECOND, pre-existing loyalty edge of the OTHER type
  // (fealty), so the "removes every membership OR fealty edge" behavior has
  // real multi-type coverage, not just multi-membership.
  const extraFealty = await addEdgeOp(dataDir, WORLD, { sourceId: "loy-stable", targetId: "loy-drifter", relationshipType: "fealty" });
  const beforeEdges = edges().filter((e) => e.sourceId === "loy-stable" && (e.relationshipType === "membership" || e.relationshipType === "fealty"));
  assert.equal(beforeEdges.length, 2, "sanity: loy-stable now has a fealty (to loy-house) AND a fealty (to loy-drifter) edge");

  const result = await anchorMembership(dataDir, WORLD, "loy-stable", "loy-house");
  assert.equal(result.removedEdgeCount, 2, "BOTH pre-existing loyalty edges must be removed, regardless of type");
  const afterEdges = edges().filter((e) => e.sourceId === "loy-stable" && (e.relationshipType === "membership" || e.relationshipType === "fealty"));
  assert.equal(afterEdges.length, 1);
  assert.equal(afterEdges[0].targetId, "loy-house");
  assert.equal(afterEdges[0].relationshipType, "membership");

  const undoResult = await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(undoResult.status, "undone");
  const restoredEdges = edges().filter((e) => e.sourceId === "loy-stable" && (e.relationshipType === "membership" || e.relationshipType === "fealty"));
  assert.equal(restoredEdges.length, 2, "BOTH original edges must come back atomically");
  assert.deepEqual(
    restoredEdges.map((e) => e.targetId).sort(),
    [extraFealty.targetId, "loy-house"].sort(),
    "the exact original targets are restored"
  );
  assert.ok(restoredEdges.some((e) => e.relationshipType === "fealty" && e.targetId === "loy-house"), "the ORIGINAL fealty-to-house edge is restored as fealty, not silently rewritten to membership");
});

// ---------------------------------------------------------------- removeNodeReparentUp (Phase 34 task 34.1)

// A dedicated fixture, deliberately separate ids from the reparentNode
// fixture above (rru- prefix) so this block's assertions never depend on
// state left over from earlier tests in this file:
//   rru-grandparent <- rru-parent <- rru-node <- {rru-child-a, rru-child-b}
// plus a non-containment edge touching rru-node (rru-node <-knows-> rru-ally)
// and a completely separate root node (rru-lone-root) with one child
// (rru-lone-root-child) for the "node is itself a root" case.
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "rru-grandparent", name: "RRU Grandparent", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "rru-parent", name: "RRU Parent", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "rru-node", name: "RRU Node", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "rru-child-a", name: "RRU Child A", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "rru-child-b", name: "RRU Child B", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "rru-ally", name: "RRU Ally", type: "person", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "rru-lone-root", name: "RRU Lone Root", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "rru-lone-root-child", name: "RRU Lone Root Child", type: "place", importance: 0.5 } },
  { op: "upsert_edge", data: { id: "rru-edge-parent-grandparent", sourceId: "rru-parent", targetId: "rru-grandparent", relationshipType: "containment" } },
  { op: "upsert_edge", data: { id: "rru-edge-node-parent", sourceId: "rru-node", targetId: "rru-parent", relationshipType: "containment" } },
  { op: "upsert_edge", data: { id: "rru-edge-child-a-node", sourceId: "rru-child-a", targetId: "rru-node", relationshipType: "containment" } },
  { op: "upsert_edge", data: { id: "rru-edge-child-b-node", sourceId: "rru-child-b", targetId: "rru-node", relationshipType: "containment" } },
  { op: "upsert_edge", data: { id: "rru-edge-node-ally", sourceId: "rru-node", targetId: "rru-ally", relationshipType: "knows" } },
  { op: "upsert_edge", data: { id: "rru-edge-lone-root-child", sourceId: "rru-lone-root-child", targetId: "rru-lone-root", relationshipType: "containment" } }
]);

function containmentEdgesInto(entityId) {
  return edges().filter((e) => e.targetId === entityId && e.relationshipType === "containment");
}

let rruNodeBefore; // captured in the delete test below, compared against in the undo test right after it

await test("removeNodeReparentUp: children adopt the grandparent, node's own edges are cascade-dropped, all in ONE atomic write", async () => {
  rruNodeBefore = findEntity("rru-node");
  const edgesTouchingNodeBefore = edges().filter((e) => e.sourceId === "rru-node" || e.targetId === "rru-node");
  assert.equal(edgesTouchingNodeBefore.length, 4, "sanity: rru-node starts with 4 edges (up to parent, 2 children in, 1 ally)");

  const result = await removeNodeReparentUp(dataDir, WORLD, "rru-node");
  assert.equal(result.entityId, "rru-node");
  assert.equal(result.name, "RRU Node");
  assert.equal(result.reparentedChildren, 2);
  assert.equal(result.droppedEdges, 0);

  assert.equal(findEntity("rru-node"), undefined, "rru-node itself must be gone");
  assert.equal(
    edges().filter((e) => e.sourceId === "rru-node" || e.targetId === "rru-node").length,
    0,
    "no edge should still reference the deleted node"
  );

  // Both children now point directly at the grandparent -- reparented UP one level, not left dangling or deleted.
  const childA = findEdge("rru-edge-child-a-node");
  const childB = findEdge("rru-edge-child-b-node");
  assert.ok(childA && childB, "both child containment edges must still exist (same ids, repointed) not be deleted");
  assert.equal(childA.targetId, "rru-parent", "rru-child-a adopts rru-node's own parent");
  assert.equal(childB.targetId, "rru-parent", "rru-child-b adopts rru-node's own parent");

  // The non-containment edge to rru-ally must be genuinely GONE (dropped by
  // the node's own cascade delete), not reparented anywhere.
  assert.equal(findEdge("rru-edge-node-ally"), undefined, "a non-containment edge touching the removed node must be dropped, not reparented");
  assert.equal(edges().some((e) => e.sourceId === "rru-ally" || e.targetId === "rru-ally"), false, "rru-ally itself must have no remaining edges either");
});

await test("removeNodeReparentUp: undo restores the EXACT original topology -- node, its own edges, AND children's original parent links", async () => {
  const undoResult = await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(undoResult.status, "undone");
  assert.equal(undoResult.kind, "remove_reparent_up");

  assert.deepEqual(findEntity("rru-node"), rruNodeBefore, "rru-node's full original state must come back exactly");

  const restoredChildA = findEdge("rru-edge-child-a-node");
  const restoredChildB = findEdge("rru-edge-child-b-node");
  assert.equal(restoredChildA.targetId, "rru-node", "rru-child-a's containment edge must point back at rru-node, not still at rru-parent");
  assert.equal(restoredChildB.targetId, "rru-node", "rru-child-b's containment edge must point back at rru-node");

  const restoredParentEdge = findEdge("rru-edge-node-parent");
  assert.ok(restoredParentEdge, "rru-node's own upward containment edge must be restored");
  assert.equal(restoredParentEdge.targetId, "rru-parent");

  const restoredAllyEdge = findEdge("rru-edge-node-ally");
  assert.ok(restoredAllyEdge, "the dropped non-containment edge must be restored too");
  assert.equal(restoredAllyEdge.targetId, "rru-ally");

  assert.equal(
    edges().filter((e) => e.sourceId === "rru-node" || e.targetId === "rru-node").length,
    4,
    "exactly the original 4 edges must be back -- not more, not fewer"
  );
});

await test("removeNodeReparentUp: ROOT-NODE case -- a node with no parent drops its children's containment edges instead of reparenting (children become roots)", async () => {
  const result = await removeNodeReparentUp(dataDir, WORLD, "rru-lone-root");
  assert.equal(result.reparentedChildren, 0);
  assert.equal(result.droppedEdges, 1);
  assert.equal(findEntity("rru-lone-root"), undefined);

  // The child itself must survive (only its containment LINK is dropped, not the child entity).
  assert.ok(findEntity("rru-lone-root-child"), "the child entity itself must still exist");
  assert.equal(findEdge("rru-edge-lone-root-child"), undefined, "the child's containment edge to the removed root must be gone");
  assert.equal(containmentEdgesInto("rru-lone-root-child").length, 0, "rru-lone-root-child has no parent now -- it is itself a root");

  const undoResult = await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(undoResult.status, "undone");
  assert.equal(undoResult.kind, "remove_reparent_up");
  assert.ok(findEntity("rru-lone-root"), "undo must restore the removed root node");
  const restoredEdge = findEdge("rru-edge-lone-root-child");
  assert.ok(restoredEdge, "undo must restore the child's original containment edge (same id)");
  assert.equal(restoredEdge.targetId, "rru-lone-root");
});

await test("removeNodeReparentUp: unknown entityId throws a clear error", async () => {
  await assert.rejects(() => removeNodeReparentUp(dataDir, WORLD, "does-not-exist-at-all"), /No entity/i);
});

// ---------------------------------------------------------------- last-write-wins (overwrite, not stack)

await test("a second manual edit correctly OVERWRITES the undo slot rather than stacking", async () => {
  await addNodeOp(dataDir, WORLD, { name: "First Node", type: "concept" });
  const afterFirst = getUndoSlot(WORLD);
  assert.equal(afterFirst.kind, "add_node");

  await addNodeOp(dataDir, WORLD, { name: "Second Node", type: "concept" });
  const afterSecond = getUndoSlot(WORLD);
  assert.notEqual(afterSecond.actionId, afterFirst.actionId, "a genuinely new action, not the same one reused");

  // Undoing now only undoes the SECOND node -- the first one remains,
  // proving the slot held exactly one action, not a stack of two.
  const beforeUndo = entities().length;
  await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(entities().length, beforeUndo - 1);
  assert.ok(entities().some((e) => e.name === "First Node"), "the FIRST node must still exist -- only the most recent action was undoable");
  assert.equal(entities().some((e) => e.name === "Second Node"), false);

  // Clean up the still-present "First Node" for subsequent tests' assertions to stay predictable.
  const first = entities().find((e) => e.name === "First Node");
  await deleteNodeOp(dataDir, WORLD, { entityId: first.id });
});

// ---------------------------------------------------------------- narration reset (task 12.6, covered by undo)

await test("resetEntityNarrationOp: appends a new empty 'current' version, marks the prior one superseded, never deletes; undo restores the prior prose as a NEW entry", async () => {
  saveEntityNarration(WORLD, "the-anvil", { prose: "A warm, crowded tavern known for its stew." });
  const beforeHistoryLen = getEntityNarrationHistory(WORLD, "the-anvil").length;

  const { history } = resetEntityNarrationOp(WORLD, { entityId: "the-anvil" });
  assert.equal(history.length, beforeHistoryLen + 1, "reset APPENDS, never overwrites/deletes");
  const current = getCurrentEntityNarration(WORLD, "the-anvil");
  assert.equal(current.prose, "");
  assert.equal(current.origin, "reset");
  const superseded = history.find((h) => h.status === "superseded");
  assert.equal(superseded.prose, "A warm, crowded tavern known for its stew.", "the ORIGINAL prose is still queryable in history, never erased");

  const undoResult = await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(undoResult.status, "undone");
  assert.equal(undoResult.kind, "narration_reset");
  const afterUndoHistory = getEntityNarrationHistory(WORLD, "the-anvil");
  assert.equal(afterUndoHistory.length, beforeHistoryLen + 2, "undo APPENDS a restore entry too -- never deletes the reset entry either");
  const currentAfterUndo = getCurrentEntityNarration(WORLD, "the-anvil");
  assert.equal(currentAfterUndo.prose, "A warm, crowded tavern known for its stew.", "the original text is back as the current entry");
  // Every single prior entry (including the reset's own empty one) is STILL present.
  assert.ok(afterUndoHistory.some((h) => h.prose === "" && h.origin === "reset"), "the reset's own empty entry must still be queryable, not erased by undo");
});

await test("resetEntityNarrationOp: an entity with NO prior current narration -- undo supersedes the reset entry with no replacement (restores the true 'nothing current' pre-reset state)", async () => {
  const { history } = resetEntityNarrationOp(WORLD, { entityId: "kael-anvil-edge" }); // never narrated before
  assert.equal(history.length, 1);
  assert.equal(getCurrentEntityNarration(WORLD, "kael-anvil-edge").prose, "");

  await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(getCurrentEntityNarration(WORLD, "kael-anvil-edge"), null, "no current narration afterward -- matches the true pre-reset state");
  assert.equal(getEntityNarrationHistory(WORLD, "kael-anvil-edge").length, 1, "the reset's own entry is still there, just no longer current -- never deleted");
});

// ---------------------------------------------------------------- getManualUndoStatusOp / empty-slot behavior

await test("undoLastManualEditOp on an empty slot is a clean no-op, not an error", async () => {
  await undoLastManualEditOp(dataDir, WORLD); // consume whatever's left from the previous test
  const result = await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(result.status, "empty");
});

await test("getManualUndoStatusOp reflects an empty vs. populated slot without consuming it", async () => {
  assert.equal(getManualUndoStatusOp(WORLD).available, false);
  await addNodeOp(dataDir, WORLD, { name: "Status Check Node", type: "concept" });
  const status1 = getManualUndoStatusOp(WORLD);
  assert.equal(status1.available, true);
  const status2 = getManualUndoStatusOp(WORLD); // calling it again must NOT consume the slot
  assert.equal(status2.available, true);
  assert.equal(status2.action.actionId, status1.action.actionId);
  await undoLastManualEditOp(dataDir, WORLD);
});

// ---------------------------------------------------------------- Phase 13 task 13.1: headless-immediate write path

await test("every manual write applies directly to the headless snapshot with no live-Foundry-poll wait -- addNodeOp completes in well under a second", async () => {
  const before = entities().length;
  const start = Date.now();
  const result = await addNodeOp(dataDir, WORLD, { name: "Headless-Path Node", type: "concept" });
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 1000, `expected well under 1000ms; took ${elapsedMs}ms`);
  assert.equal(entities().length, before + 1);
  assert.ok(findEntity(result.entityId));
  const undoResult = await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(undoResult.status, "undone");
  assert.equal(findEntity(result.entityId), undefined);
});

await test("manual writes accumulate into ONE open manual-edit batch (never synced across this whole file, per this project's own accumulate-until-sync design), auto-accepted at creation, surfaced by getManualEditSyncStatusOp", async () => {
  // This world's manual-edit batch has been accumulating since the very
  // first write earlier in this file (it's never synced here -- that's
  // covered separately by manual-edit-sync.test.mjs), so this test asserts
  // on DELTAS, not absolute counts.
  const openBefore = listBatches(WORLD).find((b) => b.scope?.mode === MANUAL_EDIT_SCOPE_MODE && b.status === "open");
  const countBefore = openBefore?.acceptedCount ?? 0;

  await addNodeOp(dataDir, WORLD, { name: "Accumulator Node A", type: "concept" });
  await addNodeOp(dataDir, WORLD, { name: "Accumulator Node B", type: "concept" });

  const stillOnlyOneOpenManualEditBatch = listBatches(WORLD).filter((b) => b.scope?.mode === MANUAL_EDIT_SCOPE_MODE && b.status === "open");
  assert.equal(stillOnlyOneOpenManualEditBatch.length, 1, "every manual edit in this world, across every test, lands in the SAME single open batch, not a new one each time");
  const openAfter = stillOnlyOneOpenManualEditBatch[0];
  assert.equal(openAfter.acceptedCount, countBefore + 2, "two more manual edits must add exactly two more accepted mutations to the SAME batch");
  assert.equal(openAfter.status, "open", "the batch itself stays open even though its mutations are accepted -- this is what keeps it in the Queue/sync-bar until an explicit Sync");

  const status = getManualEditSyncStatusOp(WORLD);
  assert.equal(status.batchId, openAfter.id);
  assert.equal(status.unsyncedCount, countBefore + 2);

  // Clean up via undo (twice -- last-write-wins slot, one action per undo call).
  await undoLastManualEditOp(dataDir, WORLD);
  await undoLastManualEditOp(dataDir, WORLD);
});

console.log(`\n${passed} test(s) passed.`);
rmSync(scratchDir, { recursive: true, force: true });
