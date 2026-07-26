import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";

/**
 * Phase 10 task 10.4's deterministic route coverage for the new per-entity
 * narration routes (POST .../narrate-entity, GET .../narration, GET
 * .../narration-history), matching test/routes.test.mjs's own established
 * split: this file proves everything that doesn't require a real, billed
 * Anthropic API call -- the entity-grain GATE (the single most important
 * correctness requirement, same as the whole-batch /narrate route), 400
 * validation, and plain reads against entity-narration.mjs's store (seeded
 * directly, not via a real narrate call). The actual narration SUCCESS path
 * is covered by the sibling routes-live.smoke.mjs, same convention as the
 * whole-batch route.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-entity-narration-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "entity-narration-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createBatch } = await import("../../mutation-engine/review-state.mjs");
const { saveEntityNarration } = await import("../../mutation-engine/entity-narration.mjs");
const { createReviewServer } = await import("../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });

let entityCounter = 0;
function makeTwoMutationBatch() {
  const suffix = entityCounter++;
  const idA = `alvor-${suffix}`;
  const idB = `riverwood-${suffix}`;
  applyHeadless(snapPath, [
    { op: "upsert_entity", data: { id: idA, name: `Alvor ${suffix}`, type: "person", importance: 0.5 } },
    { op: "upsert_entity", data: { id: idB, name: `Riverwood ${suffix}`, type: "place", importance: 0.7 } }
  ]);
  const batch = createBatch(WORLD, { mode: "manual" }, "a test session", [
    {
      op: "upsert_entity",
      id: idA,
      data: { importance: 0.6 },
      rationale: "Alvor's standing shifts.",
      batchId: "placeholder",
      sourceKind: "manual",
      entityContext: { name: `Alvor ${suffix}`, importance: 0.6, tags: [] }
    },
    {
      op: "upsert_entity",
      id: idB,
      data: { importance: 0.8 },
      rationale: "Riverwood grows more prominent.",
      batchId: "placeholder",
      sourceKind: "manual",
      entityContext: { name: `Riverwood ${suffix}`, importance: 0.8, tags: [] }
    }
  ]);
  return { ...batch, idA, idB };
}

let server;
let base;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratchDir, { recursive: true, force: true });
});

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}
async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test("GET /api/entities/:id/narration for a never-narrated entity returns {narration: null}, not an error", async () => {
  const { status, body } = await getJson(`/api/entities/never-narrated-entity/narration?world=${WORLD}`);
  assert.equal(status, 200);
  assert.equal(body.entityId, "never-narrated-entity");
  assert.equal(body.narration, null);
});

test("GET /api/entities/:id/narration-history for a never-narrated entity returns an empty array", async () => {
  const { status, body } = await getJson(`/api/entities/never-narrated-entity/narration-history?world=${WORLD}`);
  assert.equal(status, 200);
  assert.deepEqual(body.history, []);
});

test("GET /api/entities/:id/narration returns a seeded current narration", async () => {
  saveEntityNarration(WORLD, "seeded-entity", { prose: "A seeded narration.", sourceMutationId: "m0", sourceBatchId: "batch-seed" }, { now: "2026-01-01T00:00:00.000Z", makeId: () => "n1" });
  const { status, body } = await getJson(`/api/entities/seeded-entity/narration?world=${WORLD}`);
  assert.equal(status, 200);
  assert.equal(body.narration.prose, "A seeded narration.");
  assert.equal(body.narration.status, "current");
});

test("GET /api/entities/:id/narration-history returns BOTH a superseded and a current entry, in order", async () => {
  saveEntityNarration(WORLD, "history-entity", { prose: "First.", sourceMutationId: "m0", sourceBatchId: "b1" }, { now: "2026-01-01T00:00:00.000Z", makeId: () => "n1" });
  saveEntityNarration(WORLD, "history-entity", { prose: "Second.", sourceMutationId: "m1", sourceBatchId: "b2" }, { now: "2026-02-01T00:00:00.000Z", makeId: () => "n2" });
  const { status, body } = await getJson(`/api/entities/history-entity/narration-history?world=${WORLD}`);
  assert.equal(status, 200);
  assert.equal(body.history.length, 2);
  assert.equal(body.history[0].prose, "First.");
  assert.equal(body.history[0].status, "superseded");
  assert.equal(body.history[1].prose, "Second.");
  assert.equal(body.history[1].status, "current");
});

test("POST /api/batches/:id/narrate-entity requires mutationId -- a clean 400, not a crash", async () => {
  const batch = makeTwoMutationBatch();
  const { status, body } = await postJson(`/api/batches/${batch.id}/narrate-entity`, { world: WORLD });
  assert.equal(status, 400);
  assert.match(body.error, /mutationId/);
});

test("POST /api/batches/:id/narrate-entity on a PENDING mutation is rejected cleanly (409), no API call made", async () => {
  const batch = makeTwoMutationBatch();
  const { status, body } = await postJson(`/api/batches/${batch.id}/narrate-entity`, { world: WORLD, mutationId: "m0" });
  assert.equal(status, 409);
  assert.equal(body.name, "NarrationGateError");
  assert.equal(body.notAccepted[0].mutationId, "m0");
});

test("THE ACTUAL GRAIN FIX: narrate-entity on mutation m0 is refused independently of m1's status -- accepting only m1 does NOT unlock m0", async () => {
  const batch = makeTwoMutationBatch();
  const accept = await postJson(`/api/batches/${batch.id}/accept`, { world: WORLD, scope: "entity", id: "m1" });
  assert.equal(accept.status, 200);

  // m0 is still pending -- narrate-entity for m0 must still be gated.
  const { status, body } = await postJson(`/api/batches/${batch.id}/narrate-entity`, { world: WORLD, mutationId: "m0" });
  assert.equal(status, 409);
  assert.equal(body.notAccepted[0].mutationId, "m0");
});

test("an unknown route still returns a clean 404 alongside the new entity-narration routes", async () => {
  const { status } = await getJson("/api/entities/x/not-a-real-route");
  assert.equal(status, 404);
});
