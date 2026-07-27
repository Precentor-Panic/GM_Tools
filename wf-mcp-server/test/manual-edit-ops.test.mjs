import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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
 * Runs a background fake mutation-watcher loop (same convention
 * sync-headless.test.mjs already established) so every write below takes
 * the FAST live-Foundry-simulated path rather than waiting out the full 7s
 * poll-then-headless-fallback window on every single call -- except one
 * test near the end which deliberately pauses the watcher to prove the
 * headless fallback path also works correctly for a representative action.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-manual-edit-ops-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.GM_TOOLS_PREP_CONTENT_DIR = join(scratchDir, "prep-content");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
process.env.WF_DATA_DIR = dataDir;

const { snapshotFilePath, mutationsPath, loadSnapshot } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { getUndoSlot } = await import("../../mutation-engine/manual-undo.mjs");
const { saveEntityNarration, getCurrentEntityNarration, getEntityNarrationHistory } =
  await import("../../mutation-engine/entity-narration.mjs");
const {
  addNodeOp,
  addEdgeOp,
  editNodeOp,
  editEdgeOp,
  deleteNodeOp,
  deleteEdgeOp,
  resetEntityNarrationOp,
  undoLastManualEditOp,
  getManualUndoStatusOp
} = await import("../lib/manual-edit-ops.mjs");

const WORLD = "manual-edit-ops-test-world";
const snapPath = snapshotFilePath(dataDir, WORLD);
const mutPath = mutationsPath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "kael", name: "Kael", type: "person", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "the-anvil", name: "The Anvil Inn", type: "place", importance: 0.6 } },
  { op: "upsert_edge", data: { id: "kael-anvil-edge", sourceId: "kael", targetId: "the-anvil", relationshipType: "presence" } }
]);

// Fake mutation watcher: mirrors graph-service.mjs's own startMutationWatcher
// (poll, apply, clear to "[]" once populated) so applyMutationsWithHeadlessFallback's
// live-path poll resolves in well under a second instead of waiting out its
// full 7s window on every call. Unlike sync-headless.test.mjs's simpler
// simulation (which only clears the file and explicitly does NOT touch the
// snapshot, since that test only asserts on path='live'/'headless' status),
// THIS test needs the snapshot to genuinely reflect each write so its
// before/after entity-state assertions are real -- so this fake watcher
// actually applies the mutations (via the SAME applyHeadless() a real
// in-browser GraphService.applyMutations()+exportSnapshot() would produce an
// equivalent on-disk result to) before clearing the file, rather than a
// no-op clear.
let watcherActive = true;
let stopWatcher = false;
const watcherLoop = (async () => {
  while (!stopWatcher) {
    if (watcherActive && existsSync(mutPath)) {
      const contents = readFileSync(mutPath, "utf8").trim();
      if (contents !== "[]" && contents !== "") {
        const mutations = JSON.parse(contents);
        if (Array.isArray(mutations) && mutations.length) {
          applyHeadless(snapPath, mutations);
        }
        writeFileSync(mutPath, "[]", "utf8");
      }
    }
    await new Promise((r) => setTimeout(r, 30));
  }
})();

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

// ---------------------------------------------------------------- headless fallback path (one representative case)

await test("headless fallback: when no live client picks up the mutation, addNodeOp still applies correctly (and is still undoable)", async () => {
  watcherActive = false; // simulate "Foundry closed" for this one call
  const before = entities().length;
  const result = await addNodeOp(dataDir, WORLD, { name: "Headless-Path Node", type: "concept" });
  watcherActive = true;
  assert.equal(entities().length, before + 1);
  assert.ok(findEntity(result.entityId));
  const undoResult = await undoLastManualEditOp(dataDir, WORLD);
  assert.equal(undoResult.status, "undone");
  assert.equal(findEntity(result.entityId), undefined);
});

console.log(`\n${passed} test(s) passed.`);
stopWatcher = true;
await watcherLoop;
rmSync(scratchDir, { recursive: true, force: true });
