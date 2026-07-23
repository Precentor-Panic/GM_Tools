import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-rollback-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = scratchDir;

const { createBatch, loadBatch } = await import("../mutation-engine/review-state.mjs");
const { acceptMutations, rollbackBatch } = await import("../mutation-engine/rollback.mjs");

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

/** Tiny local stand-in for what World Fabric's importGraph merge would do. */
function applyMutation(entities, mutation) {
  if (mutation.op === "upsert_entity") {
    const idx = entities.findIndex((e) => e.id === mutation.id);
    if (idx === -1) {
      entities.push({ id: mutation.id, ...mutation.data });
    } else {
      entities[idx] = { ...entities[idx], ...mutation.data };
    }
  } else if (mutation.op === "delete_entity") {
    const idx = entities.findIndex((e) => e.id === mutation.id);
    if (idx !== -1) entities.splice(idx, 1);
  }
  return entities;
}

test("accept -> simulate apply -> rollback: end state matches pre-accept state exactly", () => {
  const originalEntity = { id: "alvor", name: "Alvor", type: "person", importance: 0.5, description: "A smith." };
  let entities = [{ ...originalEntity }];
  const edges = [];

  const batch = createBatch(
    WORLD,
    { mode: "seed" },
    "1 session",
    [
      {
        op: "upsert_entity",
        id: "alvor",
        data: { importance: 0.9, description: "Shaken by the siege." },
        rationale: "The siege reached his forge.",
        batchId: "placeholder",
        sourceKind: "seeded-propagation"
      }
    ],
    { makeId: () => "batch_rollback_1" }
  );

  // Accept: captures pre-state (importance 0.5) before anything is applied.
  const accepted = acceptMutations(WORLD, batch.id, ["m0"], entities, edges);
  const acceptedEntry = accepted.mutations.find((m) => m.mutationId === "m0");
  assert.equal(acceptedEntry.status, "accepted");
  assert.deepEqual(acceptedEntry.preState, originalEntity);

  // Simulate apply: the mutation actually lands on the graph.
  entities = applyMutation(entities, acceptedEntry);
  assert.equal(entities.find((e) => e.id === "alvor").importance, 0.9);
  assert.equal(entities.find((e) => e.id === "alvor").description, "Shaken by the siege.");

  // Rollback: compute the restore mutations and apply them the same way.
  const { restoreMutations, skipped } = rollbackBatch(WORLD, batch.id);
  assert.equal(skipped.length, 0);
  assert.equal(restoreMutations.length, 1);
  assert.equal(restoreMutations[0].op, "upsert_entity");
  assert.equal(restoreMutations[0].id, "alvor");
  assert.deepEqual(restoreMutations[0].data, originalEntity);

  for (const m of restoreMutations) entities = applyMutation(entities, m);
  assert.deepEqual(entities.find((e) => e.id === "alvor"), originalEntity, "end state should match pre-accept state exactly");

  const reloaded = loadBatch(WORLD, batch.id);
  assert.equal(reloaded.status, "rolled-back");
  assert.equal(reloaded.mutations.find((m) => m.mutationId === "m0").status, "rolled-back");
});

test("rollback: a created entity (preState null) with a known id restores via delete", () => {
  const entities = [];
  const edges = [];

  const batch = createBatch(
    WORLD,
    {},
    undefined,
    [
      {
        op: "upsert_entity",
        id: "new-rumor", // id known ahead of time in this scenario
        data: { name: "A New Rumor", type: "concept" },
        rationale: "A rumor spreads.",
        batchId: "placeholder",
        sourceKind: "manual"
      }
    ],
    { makeId: () => "batch_rollback_create" }
  );

  const accepted = acceptMutations(WORLD, batch.id, ["m0"], entities, edges);
  assert.equal(accepted.mutations[0].preState, null, "entity did not exist before -- pre-state is null");

  const { restoreMutations, skipped } = rollbackBatch(WORLD, batch.id);
  assert.equal(skipped.length, 0);
  assert.equal(restoreMutations[0].op, "delete_entity");
  assert.equal(restoreMutations[0].id, "new-rumor");
});

test("rollback: a created entity with NO known id is skipped, not crashed on (documented Phase 1 limitation)", () => {
  const entities = [];
  const edges = [];

  const batch = createBatch(
    WORLD,
    {},
    undefined,
    [
      {
        op: "upsert_entity",
        // no id -- genuinely new entity, id assigned by Foundry at apply time
        data: { name: "Another New Thing", type: "object" },
        rationale: "Something new appears.",
        batchId: "placeholder",
        sourceKind: "manual"
      }
    ],
    { makeId: () => "batch_rollback_no_id" }
  );

  acceptMutations(WORLD, batch.id, ["m0"], entities, edges);
  const { restoreMutations, skipped } = rollbackBatch(WORLD, batch.id);
  assert.equal(restoreMutations.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].mutationId, "m0");
});

test("rollback: only accepted mutations are considered; pending/rejected are left alone", () => {
  const entities = [{ id: "e1", name: "E1", importance: 0.5 }];
  const edges = [];

  const batch = createBatch(
    WORLD,
    {},
    undefined,
    [
      { op: "upsert_entity", id: "e1", data: { importance: 0.7 }, rationale: "x", batchId: "placeholder", sourceKind: "manual" },
      { op: "upsert_entity", id: "e1", data: { importance: 0.8 }, rationale: "y", batchId: "placeholder", sourceKind: "manual" }
    ],
    { makeId: () => "batch_rollback_partial" }
  );

  // Only accept the first mutation.
  acceptMutations(WORLD, batch.id, ["m0"], entities, edges);

  const { restoreMutations } = rollbackBatch(WORLD, batch.id);
  assert.equal(restoreMutations.length, 1);
  assert.equal(restoreMutations[0].id, "e1");

  const reloaded = loadBatch(WORLD, batch.id);
  assert.equal(reloaded.mutations.find((m) => m.mutationId === "m1").status, "pending", "unaccepted mutation should be untouched by rollback");
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
