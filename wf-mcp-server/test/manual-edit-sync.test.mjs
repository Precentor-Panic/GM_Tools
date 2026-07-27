import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 13 task 13.1 -- the deferred-sync mechanism's own acceptance
 * criteria, proven for real rather than assumed:
 *   (a) a manual edit completes in well under a second (no live-Foundry-poll
 *       cost at all on the interactive path anymore);
 *   (b) multiple manual edits since the last sync accumulate into ONE open
 *       "manual-edit" batch, correctly surfaced by getManualEditSyncStatusOp;
 *   (c) the EXISTING, UNMODIFIED syncOp (the same function the Review
 *       screen's "Sync to Foundry" button calls) genuinely pushes that
 *       batch's accepted mutations through the real live-Foundry
 *       world-fabric-mutations.json bridge when a live client is "open"
 *       (simulated the same way sync-headless.test.mjs already does, by a
 *       background loop playing graph-service.mjs's own mutation-watcher
 *       role) -- not a no-op headless re-write. This is the specific thing
 *       the task file calls out as "don't ship a version that just writes
 *       headless and calls it done."
 *   (d) after a sync, a fresh manual edit starts a NEW batch (the synced one
 *       is no longer 'open').
 *
 * In-process (manual-edit-ops.mjs/mutation-ops.mjs are plain importable
 * modules, not MCP-tool-wrapped -- see that module's own doc comment for
 * why), mirroring wf-mcp-server/test/manual-edit-ops.test.mjs's and
 * sync-headless.test.mjs's own fixture/isolation conventions.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-manual-edit-sync-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.GM_TOOLS_PREP_CONTENT_DIR = join(scratchDir, "prep-content");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
process.env.WF_DATA_DIR = dataDir;

const { snapshotFilePath, mutationsPath, loadSnapshot } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { listBatches, loadBatch } = await import("../../mutation-engine/review-state.mjs");
const { addNodeOp, editNodeOp, getManualEditSyncStatusOp, MANUAL_EDIT_SCOPE_MODE } = await import("../lib/manual-edit-ops.mjs");
const { syncOp } = await import("../lib/mutation-ops.mjs");

const WORLD = "manual-edit-sync-test-world";
const snapPath = snapshotFilePath(dataDir, WORLD);
const mutPath = mutationsPath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [{ op: "upsert_entity", data: { id: "kael", name: "Kael", type: "person", importance: 0.5 } }]);

function entities() {
  return loadSnapshot(dataDir, WORLD).snapshot.entities;
}
function findEntity(id) {
  return entities().find((e) => e.id === id);
}
function openManualEditBatch() {
  return listBatches(WORLD).find((b) => b.status === "open" && b.scope?.mode === MANUAL_EDIT_SCOPE_MODE);
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

await test("addNodeOp completes in well under a second -- no live-Foundry-poll cost on the interactive path", async () => {
  const start = Date.now();
  const result = await addNodeOp(dataDir, WORLD, { name: "Fast Node", type: "concept" });
  const elapsedMs = Date.now() - start;
  assert.ok(findEntity(result.entityId), "the entity must be genuinely written to the headless snapshot immediately");
  assert.ok(elapsedMs < 1000, `expected well under 1000ms (no live-Foundry poll); took ${elapsedMs}ms`);
});

await test("manual edits accumulate into ONE open manual-edit batch, auto-accepted, until synced", async () => {
  await addNodeOp(dataDir, WORLD, { name: "Second Node", type: "concept" });
  await editNodeOp(dataDir, WORLD, { entityId: "kael", data: { importance: 0.8 } });

  const open = openManualEditBatch();
  assert.ok(open, "an open manual-edit batch must exist");
  const batch = loadBatch(WORLD, open.id);
  assert.equal(batch.status, "open", "the BATCH itself stays open (not synced) even though its mutations are accepted");
  assert.equal(batch.mutations.length, 3, "Fast Node + Second Node + Kael's edit, all in the SAME batch");
  assert.ok(batch.mutations.every((m) => m.status === "accepted"), "every manual-edit mutation is auto-accepted at creation, no pending review step");
  assert.ok(batch.mutations.every((m) => m.sourceKind === "manual"));
});

await test("getManualEditSyncStatusOp reports the real accumulated count and batch id", async () => {
  const status = getManualEditSyncStatusOp(WORLD);
  const open = openManualEditBatch();
  assert.equal(status.batchId, open.id);
  assert.equal(status.unsyncedCount, 3);
});

await test('syncOp on the manual-edit batch, "Foundry closed": falls back to headless (idempotent re-apply), marks the batch synced', async () => {
  const open = openManualEditBatch();
  const before = entities().length;

  const result = await syncOp(dataDir, WORLD, { batchId: open.id });

  assert.equal(result.path, "headless", `expected headless fallback (no live client); got: ${JSON.stringify(result)}`);
  assert.equal(result.syncedCount, 3);
  assert.equal(entities().length, before, "re-applying already-headlessly-applied creates/edits must be idempotent, not double-create");
  assert.equal(findEntity("kael").importance, 0.8, "kael's edit is still correctly reflected");

  const batch = loadBatch(WORLD, open.id);
  assert.equal(batch.status, "synced");
  assert.equal(getManualEditSyncStatusOp(WORLD).unsyncedCount, 0, "nothing left unsynced once the batch is marked synced");
});

await test("a fresh manual edit after a sync starts a NEW batch, not the just-synced one", async () => {
  const priorBatch = openManualEditBatch();
  assert.equal(priorBatch, undefined, "the just-synced batch must no longer read as 'open'");

  await addNodeOp(dataDir, WORLD, { name: "Post-Sync Node", type: "concept" });
  const fresh = openManualEditBatch();
  assert.ok(fresh, "a new open manual-edit batch must exist");
  assert.equal(fresh.mutationCount, 1);
});

await test('syncOp on the manual-edit batch, "Foundry open": genuinely writes to and polls the REAL world-fabric-mutations.json bridge file, reports path="live"', async () => {
  writeFileSync(mutPath, "[]", "utf8"); // clean slate -- no stale content from a prior test

  let capturedMutationsJson = null;
  let watcherActive = true;
  const watcherLoop = (async () => {
    while (watcherActive) {
      try {
        const raw = readFileSync(mutPath, "utf8").trim();
        if (raw && raw !== "[]") {
          capturedMutationsJson = raw; // proves the bridge file was genuinely written to, not skipped
          writeFileSync(mutPath, "[]", "utf8"); // exactly what graph-service.mjs's real startMutationWatcher does once applied
          break;
        }
      } catch { /* not written yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
  })();

  const open = openManualEditBatch();
  const result = await syncOp(dataDir, WORLD, { batchId: open.id });
  watcherActive = false;
  await watcherLoop;

  assert.equal(result.path, "live", `expected the live path (a "Foundry client" picked it up); got: ${JSON.stringify(result)}`);
  assert.equal(result.mutationsFilePath, mutPath);
  assert.ok(capturedMutationsJson, "the real bridge file must have genuinely been written to (not a headless no-op)");
  const capturedMutations = JSON.parse(capturedMutationsJson);
  assert.equal(capturedMutations.length, 1);
  assert.equal(capturedMutations[0].data.name, "Post-Sync Node", "the actual mutation content reaching the bridge must be the real manual-edit mutation, not a placeholder");

  const batch = loadBatch(WORLD, open.id);
  assert.equal(batch.status, "synced");
  assert.ok(existsSync(snapPath), "sanity: the standalone snapshot file still exists (headless path untouched by this call)");
});

console.log(`\n${passed} test(s) passed.`);
rmSync(scratchDir, { recursive: true, force: true });
