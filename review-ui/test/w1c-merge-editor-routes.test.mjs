import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * Friction Wave 1, W1c -- the "yes, but" merge editor's server half:
 * POST .../patch-data on a pending mutation must (a) persist the reviewer's
 * hand-combined staged text and (b) RE-DIFF it against the live snapshot so
 * the card's before/after shows exactly what accepting would apply. Also
 * guards the refusal on a settled mutation (editing history is forbidden).
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-w1c-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_PREP_CONTENT_DIR = join(scratchDir, "prep-content");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "w1c-merge-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createBatch, loadBatch } = await import("../../mutation-engine/review-state.mjs");
const { attachDiffs } = await import("../../time-skip/run.mjs");
const { createReviewServer } = await import("../server.mjs");

const liveEntities = [
  { id: "vane", name: "Master Aldric Vane", type: "person", importance: 0.7, description: "Guildmaster of the weavers." }
];
const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, liveEntities.map((e) => ({ op: "upsert_entity", data: e })));

let idCounter = 0;
function buildBatch() {
  const mutations = attachDiffs(
    [{
      op: "upsert_entity",
      id: "vane",
      data: { description: "Replacement text that would lose the original lore." },
      rationale: "destructive update from the writeup",
      batchId: "placeholder",
      sourceKind: "writeup-import"
    }],
    liveEntities,
    []
  );
  return createBatch(WORLD, { mode: "writeup-import", text: "seed" }, undefined, mutations, {
    makeId: () => `batch_w1c_route_${idCounter++}`
  });
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

async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

const MERGED = "Guildmaster of the weavers. Placed the fate-threads over three years.";

test("W1c: patch-data persists the hand-merged text AND re-diffs it against the live snapshot", async () => {
  const batch = buildBatch();
  const mid = batch.mutations[0].mutationId;
  const { status, body } = await postJson(`/api/batches/${batch.id}/mutations/${mid}/patch-data`, {
    world: WORLD,
    data: { description: MERGED }
  });
  assert.equal(status, 200);
  assert.equal(body.mutation.data.description, MERGED);

  const detail = await getJson(`/api/batches/${batch.id}?world=${WORLD}`);
  const row = detail.body.regions.flatMap((r) => r.entities).find((e) => e.mutationId === mid);
  assert.equal(row.data.description, MERGED, "the staged data is the edited version");
  const descChange = row.diff.find((c) => c.field === "description");
  assert.equal(descChange.to, MERGED, "the diff's AFTER side is the edited version -- what accept will apply");
  assert.equal(descChange.from, "Guildmaster of the weavers.");

  // Accept reads the same batch entry -- confirm the accepted mutation's data
  // is the edited version (sync then applies m.data verbatim, proven end to
  // end by w1b-convert-routes.test.mjs's sync test).
  const acc = await postJson(`/api/batches/${batch.id}/accept`, { world: WORLD, scope: "entity", id: mid });
  assert.equal(acc.status, 200);
  const saved = loadBatch(WORLD, batch.id);
  assert.equal(saved.mutations[0].status, "accepted");
  assert.equal(saved.mutations[0].data.description, MERGED, "accept applies the edited version, not the original proposal");
});

test("W1c: patch-data refuses a settled mutation (400) -- editing history is forbidden", async () => {
  const batch = buildBatch();
  const mid = batch.mutations[0].mutationId;
  await postJson(`/api/batches/${batch.id}/accept`, { world: WORLD, scope: "entity", id: mid });
  const { status } = await postJson(`/api/batches/${batch.id}/mutations/${mid}/patch-data`, {
    world: WORLD,
    data: { description: "too late" }
  });
  assert.equal(status, 400);
});

console.log("w1c-merge-editor-routes.test.mjs: all node:test cases registered.");
