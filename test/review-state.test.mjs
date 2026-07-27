import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the review-state store at an isolated scratch directory before
// importing the module (reviewStateRoot() reads the env var lazily on every
// call, so setting it before first use is sufficient and this test file
// never touches the repo's real review-state/ directory).
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-review-state-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = scratchDir;

const {
  createBatch,
  loadBatch,
  saveBatch,
  updateMutationStatus,
  listBatches,
  ConcurrentWriteError
} = await import("../mutation-engine/review-state.mjs");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.message);
    process.exitCode = 1;
  }
}

const WORLD = "wf-test";

function sampleMutations(batchIdPlaceholder = "placeholder") {
  return [
    {
      op: "upsert_entity",
      id: "ent1",
      data: { importance: 0.6 },
      rationale: "The guild lost its grip on the docks.",
      batchId: batchIdPlaceholder,
      sourceKind: "seeded-propagation",
      impactScore: 0.42
    },
    {
      op: "upsert_edge",
      id: "edge1",
      data: { strength: 0.3 },
      rationale: "Trust erodes after the betrayal.",
      batchId: batchIdPlaceholder,
      sourceKind: "ambient-decay"
    }
  ];
}

// --------------------------------------------------------- create/save/load

test("createBatch: round-trips create -> load with pending statuses and mutationIds assigned", () => {
  let n = 0;
  const batch = createBatch(WORLD, { mode: "seed", anchorId: "ent1", depth: 2 }, "1 session", sampleMutations(), {
    makeId: () => `batch_test_${n++}`
  });
  assert.equal(batch.status, "open");
  assert.equal(batch.mutations.length, 2);
  assert.equal(batch.mutations[0].mutationId, "m0");
  assert.equal(batch.mutations[1].mutationId, "m1");
  assert.ok(batch.mutations.every((m) => m.status === "pending"));
  assert.ok(batch.mutations.every((m) => m.batchId === batch.id));

  const loaded = loadBatch(WORLD, batch.id);
  assert.deepEqual(loaded, batch);
});

test("createBatch: throws on a malformed mutation rather than persisting it", () => {
  const bad = [{ op: "upsert_entity", data: {}, sourceKind: "manual" /* missing rationale */ }];
  assert.throws(() => createBatch(WORLD, {}, undefined, bad, { makeId: () => "batch_bad" }));
  assert.equal(existsSync(join(scratchDir, WORLD, "batch_bad.json")), false, "malformed batch should not be written to disk");
});

test("saveBatch: persists changes made to a loaded batch", () => {
  const batch = createBatch(WORLD, {}, undefined, sampleMutations(), { makeId: () => "batch_save_test" });
  const loaded = loadBatch(WORLD, batch.id);
  loaded.status = "synced";
  saveBatch(WORLD, loaded);
  const reloaded = loadBatch(WORLD, batch.id);
  assert.equal(reloaded.status, "synced");
});

// ------------------------------------------------------- updateMutationStatus

test("updateMutationStatus: updates a single mutation's status and persists it", () => {
  const batch = createBatch(WORLD, {}, undefined, sampleMutations(), { makeId: () => "batch_status_test" });
  const updated = updateMutationStatus(WORLD, batch.id, "m0", "accepted");
  assert.equal(updated.mutations.find((m) => m.mutationId === "m0").status, "accepted");
  assert.equal(updated.mutations.find((m) => m.mutationId === "m1").status, "pending", "other mutations untouched");

  const reloaded = loadBatch(WORLD, batch.id);
  assert.equal(reloaded.mutations.find((m) => m.mutationId === "m0").status, "accepted");
});

test("updateMutationStatus: rejects an invalid status value", () => {
  const batch = createBatch(WORLD, {}, undefined, sampleMutations(), { makeId: () => "batch_invalid_status" });
  assert.throws(() => updateMutationStatus(WORLD, batch.id, "m0", "not-a-real-status"));
});

test("updateMutationStatus: throws for an unknown mutationId", () => {
  const batch = createBatch(WORLD, {}, undefined, sampleMutations(), { makeId: () => "batch_unknown_mutation" });
  assert.throws(() => updateMutationStatus(WORLD, batch.id, "m99", "accepted"));
});

// ------------------------------------------------------------- listBatches

test("listBatches: returns lightweight summaries, newest first", () => {
  createBatch(WORLD, { mode: "seed" }, "1 session", sampleMutations(), { makeId: () => "batch_list_a" });
  createBatch(WORLD, { mode: "ambient" }, "2 sessions", sampleMutations(), { makeId: () => "batch_list_b" });
  const list = listBatches(WORLD);
  const ids = list.map((b) => b.id);
  assert.ok(ids.includes("batch_list_a"));
  assert.ok(ids.includes("batch_list_b"));
  const a = list.find((b) => b.id === "batch_list_a");
  assert.equal(a.mutationCount, 2);
  assert.equal(a.pendingCount, 2);
  assert.equal(a.acceptedCount, 0);
});

test("listBatches: acceptedCount reflects real per-mutation status, distinct from pendingCount", () => {
  const batch = createBatch(WORLD, { mode: "manual" }, "1 session", sampleMutations(), { makeId: () => "batch_list_counts" });
  updateMutationStatus(WORLD, batch.id, batch.mutations[0].mutationId, "accepted");
  updateMutationStatus(WORLD, batch.id, batch.mutations[1].mutationId, "rejected");
  const summary = listBatches(WORLD).find((b) => b.id === "batch_list_counts");
  assert.equal(summary.pendingCount, 0);
  assert.equal(summary.acceptedCount, 1);
});

test("listBatches: empty for a world with no batches yet", () => {
  assert.deepEqual(listBatches("wf-nonexistent-world"), []);
});

// ------------------------------------------------------------- concurrency

test("concurrent write: an existing lock file causes the write to be rejected, not silently clobbered", () => {
  const batch = createBatch(WORLD, {}, undefined, sampleMutations(), { makeId: () => "batch_concurrency_test" });
  const originalRaw = JSON.stringify(loadBatch(WORLD, batch.id));

  // Simulate another writer holding the lock.
  const lockPath = join(scratchDir, WORLD, `${batch.id}.json.lock`);
  const fd = openSync(lockPath, "wx");
  closeSync(fd);

  try {
    assert.throws(
      () => updateMutationStatus(WORLD, batch.id, "m0", "accepted"),
      ConcurrentWriteError
    );
    // The batch file on disk must be untouched by the rejected write.
    const afterRaw = JSON.stringify(loadBatch(WORLD, batch.id));
    assert.equal(afterRaw, originalRaw, "batch file must be unchanged after a rejected concurrent write");
  } finally {
    rmSync(lockPath, { force: true });
  }

  // Once the lock clears, a normal write succeeds.
  const updated = updateMutationStatus(WORLD, batch.id, "m0", "accepted");
  assert.equal(updated.mutations.find((m) => m.mutationId === "m0").status, "accepted");
});

console.log(`\n${passed} passed`);

// Clean up the scratch directory.
process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
