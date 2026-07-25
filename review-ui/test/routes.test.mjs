import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";

/**
 * Task 6.1's acceptance criterion: "a smoke test (real HTTP requests against
 * a running instance of this server, not mocked) exercising each route
 * against a fixture world: list batches, get one, accept a mutation, request
 * narration on a fully-accepted batch (succeeds) and on a partially-accepted
 * one (clean error, not a crash), resolve a pending-ledger entry, rollback."
 *
 * This file covers everything from that list EXCEPT the two cases that
 * require a real, billed Anthropic API call (narration actually succeeding,
 * and resolving a pending-ledger entry, both of which make a real
 * textureRegion/narrateBatch call) -- those are covered by the sibling
 * routes-live.smoke.mjs, matching this project's own established split
 * between a deterministic *.test.mjs (mocked/no-LLM) and a real-API
 * *.smoke.mjs (see gm-tools-conventions: "LLM-dependent code gets a unit
 * test with the API call mocked ... plus a documented ... smoke test that
 * makes a real API call" -- narrateOp/resolvePending's underlying
 * narrateBatch/textureRegion calls have no test-time client-injection seam
 * threaded through the HTTP layer at all, same as the original
 * wf_narrate_batch/wf_resolve_pending MCP tool handlers this was extracted
 * from, so a real call is the only way to prove the success path here, same
 * as wf-mcp-server/test/live-diff-narrate.smoke.mjs already does at the MCP
 * layer). What IS proven here, deterministically: the narration GATE itself
 * (empty batch, partially-accepted batch) -- the single most important
 * correctness requirement in this phase -- never needs an API call to fail
 * cleanly, since assertBatchNarratable() runs before any prompt is built.
 *
 * Real HTTP requests via fetch() against an in-process server.listen(0)
 * (ephemeral port) -- no subprocess needed (unlike wf-mcp-server's MCP
 * tests, which need a real stdio transport): server.mjs's route handlers
 * read process.env directly (via resolveWorld/resolveDir and each library
 * module's own env-var convention), so setting env vars in this same
 * process before each request is sufficient, no spawn required.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-review-ui-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "review-ui-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createBatch, loadBatch } = await import("../../mutation-engine/review-state.mjs");
const { writePending } = await import("../../mutation-engine/pending-ledger.mjs");
const { createReviewServer } = await import("../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });

// mutation-engine/human-review.mjs's tracking is keyed by (world, entityId)
// and persists across every batch touching that entity within this test
// file's shared world -- so each test that asserts on human-review state
// (reviewed vs. not) needs its OWN, never-before-touched pair of entities,
// not the same "alvor"/"riverwood" reused everywhere (a genuine cross-test
// contamination bug found while writing this file, not a product bug --
// fixed here by minting a fresh entity pair per call, suffixed by a counter).
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
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

test("GET / serves the static shell", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
});

test("GET /api/worlds lists the fixture world", async () => {
  const { status, body } = await getJson("/api/worlds");
  assert.equal(status, 200);
  assert.ok(body.worlds.includes(WORLD));
});

test("GET /api/batches lists a created batch", async () => {
  const batch = makeTwoMutationBatch();
  const { status, body } = await getJson(`/api/batches?world=${WORLD}`);
  assert.equal(status, 200);
  const found = body.batches.find((b) => b.id === batch.id);
  assert.ok(found, "created batch should appear in the list");
  assert.equal(found.pendingCount, 2);
  assert.equal(found.status, "open");
});

test("GET /api/batches/:id returns full batch detail with per-entity status and narratable=false", async () => {
  const batch = makeTwoMutationBatch();
  const { status, body } = await getJson(`/api/batches/${batch.id}?world=${WORLD}`);
  assert.equal(status, 200);
  assert.equal(body.batch.id, batch.id);
  assert.equal(body.narratable, false, "nothing accepted yet -- must not be narratable");
  const allEntities = body.regions.flatMap((r) => r.entities);
  assert.equal(allEntities.length, 2);
  assert.ok(allEntities.every((e) => e.status === "pending"));
});

test("POST /api/batches/:id/narrate on a batch with NOTHING accepted is rejected cleanly (409, not a crash)", async () => {
  const batch = makeTwoMutationBatch();
  const { status, body } = await postJson(`/api/batches/${batch.id}/narrate`, { world: WORLD });
  assert.equal(status, 409);
  assert.equal(body.name, "NarrationGateError");
  assert.equal(body.notAccepted.length, 2);
});

test("POST /api/batches/:id/accept scope='entity' accepts one mutation and marks it human-reviewed", async () => {
  const batch = makeTwoMutationBatch();
  const { status, body } = await postJson(`/api/batches/${batch.id}/accept`, { world: WORLD, scope: "entity", id: "m0" });
  assert.equal(status, 200);
  assert.deepEqual(body.accepted, ["m0"]);
  assert.equal(body.batchStatus, "open");

  const { body: unreviewed } = await getJson(`/api/unreviewed-entities?world=${WORLD}`);
  assert.ok(!unreviewed.entities.some((e) => e.entityId === batch.idA), "a scoped ('entity') accept must count as a genuine review");
});

test("POST /api/batches/:id/narrate on a PARTIALLY-accepted batch is rejected cleanly (409), naming the still-pending mutation", async () => {
  const batch = makeTwoMutationBatch();
  await postJson(`/api/batches/${batch.id}/accept`, { world: WORLD, scope: "entity", id: "m0" });

  const { status, body } = await postJson(`/api/batches/${batch.id}/narrate`, { world: WORLD });
  assert.equal(status, 409);
  assert.equal(body.name, "NarrationGateError");
  assert.equal(body.notAccepted.length, 1);
  assert.equal(body.notAccepted[0].mutationId, "m1");
  assert.equal(body.notAccepted[0].status, "pending");
});

test("POST /api/batches/:id/accept scope='batch' (accept-all) does NOT mark entities as human-reviewed -- the accept-vs-review distinction", async () => {
  const batch = makeTwoMutationBatch();
  const { status, body } = await postJson(`/api/batches/${batch.id}/accept`, { world: WORLD, scope: "batch" });
  assert.equal(status, 200);
  assert.equal(body.accepted.length, 2);

  const { body: unreviewed } = await getJson(`/api/unreviewed-entities?world=${WORLD}`);
  const flaggedIds = unreviewed.entities.map((e) => e.entityId);
  assert.ok(flaggedIds.includes(batch.idA) && flaggedIds.includes(batch.idB), "a whole-batch accept-all must NOT count as review -- both entities should still be flagged");
});

test("bulk-accept with an explicit reviewedMutationIds subset splits reviewed vs unreviewed per mutation", async () => {
  const batch = makeTwoMutationBatch();
  const { status, body } = await postJson(`/api/batches/${batch.id}/bulk-accept`, {
    world: WORLD,
    mutationIds: ["m0", "m1"],
    reviewedMutationIds: ["m0"] // m0 was individually expanded/read; m1 was only swept in via bulk select
  });
  assert.equal(status, 200);
  assert.equal(body.accepted.length, 2);

  const { body: unreviewed } = await getJson(`/api/unreviewed-entities?world=${WORLD}`);
  const flaggedIds = unreviewed.entities.map((e) => e.entityId);
  assert.ok(!flaggedIds.includes(batch.idA), "m0 was in reviewedMutationIds -- must count as reviewed");
  assert.ok(flaggedIds.includes(batch.idB), "m1 was NOT in reviewedMutationIds -- must NOT count as reviewed");
});

test("bulk-reject accepts a plain mutationIds array and rejects each", async () => {
  const batch = makeTwoMutationBatch();
  const { status, body } = await postJson(`/api/batches/${batch.id}/bulk-reject`, {
    world: WORLD,
    mutationIds: ["m0", "m1"]
  });
  assert.equal(status, 200);
  assert.deepEqual(body.rejected.sort(), ["m0", "m1"]);
  const reloaded = loadBatch(WORLD, batch.id);
  assert.ok(reloaded.mutations.every((m) => m.status === "rejected"));
});

test("full accept -> sync (headless) -> rollback round trip via the HTTP API", async () => {
  const batch = makeTwoMutationBatch();
  await postJson(`/api/batches/${batch.id}/accept`, { world: WORLD, scope: "batch" });

  const detail = await getJson(`/api/batches/${batch.id}?world=${WORLD}`);
  assert.equal(detail.body.narratable, true, "fully-accepted batch should report narratable=true");

  const sync = await postJson(`/api/batches/${batch.id}/sync`, { world: WORLD });
  assert.equal(sync.status, 200);
  assert.equal(sync.body.path, "headless", "no live Foundry client in this test -- must fall back to headless");
  assert.equal(sync.body.status, "applied");

  const onDiskAfterSync = JSON.parse(readFileSync(snapPath, "utf8")).snapshot.entities;
  assert.equal(onDiskAfterSync.find((e) => e.id === batch.idA).importance, 0.6);
  assert.equal(onDiskAfterSync.find((e) => e.id === batch.idB).importance, 0.8);

  const lastRollbackable = await getJson(`/api/last-rollbackable-batch?world=${WORLD}`);
  assert.equal(lastRollbackable.status, 200);
  assert.equal(lastRollbackable.body.batch.id, batch.id);

  const rollback = await postJson(`/api/batches/${batch.id}/rollback`, { world: WORLD });
  assert.equal(rollback.status, 200);
  assert.equal(rollback.body.path, "headless");

  const onDiskAfterRollback = JSON.parse(readFileSync(snapPath, "utf8")).snapshot.entities;
  assert.equal(onDiskAfterRollback.find((e) => e.id === batch.idA).importance, 0.5, "rollback should restore the pre-accept importance");
  assert.equal(onDiskAfterRollback.find((e) => e.id === batch.idB).importance, 0.7, "rollback should restore the pre-accept importance");
});

test("GET /api/pending-entities lists an entity with an available ledger backlog", async () => {
  applyHeadless(snapPath, [{ op: "upsert_entity", data: { id: "pending-fixture-npc", name: "Borin", type: "person", importance: 0.3 } }]);
  writePending(WORLD, "pending-fixture-npc", {
    causeTag: "Borin: raided (cycle 1)",
    impactScore: 0.4,
    sourceBatchId: "batch_fixture",
    cycleDescriptor: "cycle 1"
  });
  const { status, body } = await getJson(`/api/pending-entities?world=${WORLD}`);
  assert.equal(status, 200);
  const found = body.entities.find((e) => e.entityId === "pending-fixture-npc");
  assert.ok(found, "the fixture entity should be listed as having a pending backlog");
  assert.equal(found.name, "Borin");
  assert.equal(found.entries.length, 1);
  assert.equal(found.entries[0].cycleDescriptor, "cycle 1");
});

test("an unknown route returns a clean 404, not a crash", async () => {
  const { status, body } = await getJson("/api/does-not-exist");
  assert.equal(status, 404);
  assert.ok(body.error);
});

test("POST /api/batches/:id/narrate on a batch with zero mutations is also rejected cleanly (409)", async () => {
  const batch = createBatch(WORLD, { mode: "manual" }, undefined, []);
  const { status, body } = await postJson(`/api/batches/${batch.id}/narrate`, { world: WORLD });
  assert.equal(status, 409);
  assert.equal(body.name, "NarrationGateError");
});
