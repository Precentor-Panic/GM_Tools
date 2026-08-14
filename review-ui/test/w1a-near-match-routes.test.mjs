import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * Friction Wave 1, W1a -- near-match chips on proposed CREATE cards.
 * Deterministic HTTP-layer test: GET /api/batches/:batchId must annotate
 * every pending CREATE mutation with `nearMatches` computed against the live
 * snapshot (graph-import/name-similarity.mjs via mutation-ops'
 * nearMatchesForBatch). The fixture reproduces the REAL Kilmarn seed-3a
 * duplicate-create shapes from the friction log: a shorthand person name, an
 * exact-name/different-type object, a prefix-near-miss faction -- plus an
 * UPDATE row and an EDGE row that must carry no annotation at all.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-w1a-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "w1a-near-match-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createBatch } = await import("../../mutation-engine/review-state.mjs");
const { attachDiffs } = await import("../../time-skip/run.mjs");
const { createReviewServer } = await import("../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "vane", name: "Master Aldric Vane", type: "person", importance: 0.7, description: "Guildmaster of the weavers." } },
  { op: "upsert_entity", data: { id: "bridge", name: "Kilmarn Bridge", type: "object", importance: 0.5, description: "The old stone crossing." } },
  { op: "upsert_entity", data: { id: "council", name: "Kilmarn Trade Council", type: "faction", importance: 0.6, description: "Merchants who run the docks." } }
]);

const liveEntities = [
  { id: "vane", name: "Master Aldric Vane", type: "person", description: "Guildmaster of the weavers." },
  { id: "bridge", name: "Kilmarn Bridge", type: "object", description: "The old stone crossing." },
  { id: "council", name: "Kilmarn Trade Council", type: "faction", description: "Merchants who run the docks." }
];

function writeupMutation(extra) {
  return { rationale: "from the writeup", batchId: "placeholder", sourceKind: "writeup-import", ...extra };
}

const batch = createBatch(
  WORLD,
  { mode: "writeup-import", text: "seed 3a" },
  undefined,
  attachDiffs(
    [
      writeupMutation({ op: "upsert_entity", id: "wf_new_0", data: { name: "Master Vane", type: "person", description: "Placed the fate-threads." } }),
      writeupMutation({ op: "upsert_entity", id: "wf_new_1", data: { name: "Kilmarn Bridge", type: "place", description: "A bridge across the river." } }),
      writeupMutation({ op: "upsert_entity", id: "wf_new_2", data: { name: "Trade Council", type: "faction", description: "They set the mooring fees." } }),
      writeupMutation({ op: "upsert_entity", id: "wf_new_3", data: { name: "The Underbreach", type: "place", description: "Genuinely new place, no near match." } }),
      writeupMutation({ op: "upsert_entity", id: "vane", data: { description: "Updated lore for the guildmaster." } }),
      writeupMutation({ op: "upsert_edge", id: "wf_edge_0", data: { sourceId: "wf_new_0", targetId: "wf_new_1", relationshipType: "placed" } })
    ],
    liveEntities,
    []
  ),
  { makeId: () => "batch_w1a_test" }
);

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

async function getDetail() {
  const res = await fetch(`${base}/api/batches/${batch.id}?world=${WORLD}`);
  assert.equal(res.status, 200);
  return res.json();
}

function entityByMutationId(detail, mutationId) {
  return detail.regions.flatMap((r) => r.entities).find((e) => e.mutationId === mutationId);
}

test("W1a: a shorthand-name CREATE carries its same-type near match", async () => {
  const detail = await getDetail();
  const row = entityByMutationId(detail, batch.mutations[0].mutationId);
  assert.ok(Array.isArray(row.nearMatches), "create row must carry nearMatches");
  assert.equal(row.nearMatches.length, 1);
  assert.equal(row.nearMatches[0].entityId, "vane");
  assert.equal(row.nearMatches[0].reason, "similar-name");
});

test("W1a: an exact-name/different-type CREATE is flagged (the 'Kilmarn Bridge' place-vs-object miss)", async () => {
  const detail = await getDetail();
  const row = entityByMutationId(detail, batch.mutations[1].mutationId);
  assert.equal(row.nearMatches?.length, 1);
  assert.equal(row.nearMatches[0].entityId, "bridge");
  assert.equal(row.nearMatches[0].reason, "exact-name-different-type");
});

test("W1a: a prefix-near-miss faction CREATE matches its canon expansion", async () => {
  const detail = await getDetail();
  const row = entityByMutationId(detail, batch.mutations[2].mutationId);
  assert.equal(row.nearMatches?.length, 1);
  assert.equal(row.nearMatches[0].entityId, "council");
});

test("W1a: a genuinely-new CREATE, an UPDATE, and an EDGE carry no near-match annotation", async () => {
  const detail = await getDetail();
  assert.equal(entityByMutationId(detail, batch.mutations[3].mutationId).nearMatches, undefined, "new place with no plausible match");
  assert.equal(entityByMutationId(detail, batch.mutations[4].mutationId).nearMatches, undefined, "update of a live entity is never a duplicate candidate");
  assert.equal(entityByMutationId(detail, batch.mutations[5].mutationId).nearMatches, undefined, "edge rows are out of scope for W1a");
});

test("W1a: a settled (rejected) CREATE loses its advisory chips", async () => {
  const rejectRes = await fetch(`${base}/api/batches/${batch.id}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, scope: "entity", id: batch.mutations[2].mutationId })
  });
  assert.equal(rejectRes.status, 200);
  const detail = await getDetail();
  const row = entityByMutationId(detail, batch.mutations[2].mutationId);
  assert.equal(row.status, "rejected");
  assert.equal(row.nearMatches, undefined, "annotations are for pending decisions only");
});

console.log("w1a-near-match-routes.test.mjs: all node:test cases registered.");
