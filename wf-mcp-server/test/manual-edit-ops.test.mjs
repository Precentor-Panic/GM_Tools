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
