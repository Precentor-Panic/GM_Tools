import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * Friction Wave 1, W1e -- HTTP layer: GET /api/batches/:batchId carries a
 * deterministic `triage` tag and a severity-merged effective `risk` per
 * mutation. The fixture deliberately carries NO stamped risk (created via
 * createBatch without attachDiffs' risk fields, like every pre-Phase-37
 * Kilmarn batch) -- the exact state where the Triaged toggle used to lump
 * every card into one meaningless bucket.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-w1e-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "w1e-triage-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createBatch } = await import("../../mutation-engine/review-state.mjs");
const { createReviewServer } = await import("../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "vane", name: "Master Aldric Vane", type: "person", importance: 0.7, description: "Guildmaster of the weavers." } }
]);

const CREATED = (data) => [{ field: "(created)", from: null, to: data }];

function wm(extra) {
  return { rationale: "r", batchId: "placeholder", sourceKind: "writeup-import", ...extra };
}

// Hand-attached diffs WITHOUT type/risk -- the pre-Phase-37 stored shape.
const batch = createBatch(
  WORLD,
  { mode: "writeup-import", text: "seed" },
  undefined,
  [
    wm({ op: "upsert_entity", id: "wf_new_0", data: { name: "Master Vane", type: "person", description: "Placed the threads." }, diff: CREATED({ name: "Master Vane" }) }),
    wm({ op: "upsert_entity", id: "wf_new_1", data: { name: "The Underbreach", type: "place", description: "A new place." }, diff: CREATED({ name: "The Underbreach" }) }),
    wm({ op: "upsert_entity", id: "vane", data: { description: "A sinister thread-mage." }, diff: [{ field: "description", from: "Guildmaster of the weavers.", to: "A sinister thread-mage." }] }),
    wm({ op: "delete_entity", id: "vane" })
  ],
  { makeId: () => "batch_w1e_test" }
);

let server, base;
before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratchDir, { recursive: true, force: true });
});

test("W1e: the batch detail payload tags every mutation and fills the effective risk on a risk-less batch", async () => {
  const res = await fetch(`${base}/api/batches/${batch.id}?world=${WORLD}`);
  assert.equal(res.status, 200);
  const detail = await res.json();
  const rows = detail.regions.flatMap((r) => r.entities);
  const byMid = (mid) => rows.find((e) => e.mutationId === mid);

  const dupCreate = byMid(batch.mutations[0].mutationId);
  assert.equal(dupCreate.triage, "possible-duplicate");
  assert.equal(dupCreate.risk, "look", "effective risk filled from the triage tag -- was null before W1e");

  const cleanCreate = byMid(batch.mutations[1].mutationId);
  assert.equal(cleanCreate.triage, "low-risk");
  assert.equal(cleanCreate.risk, "safe");

  const destructiveUpdate = byMid(batch.mutations[2].mutationId);
  assert.equal(destructiveUpdate.triage, "fights-canon");
  assert.equal(destructiveUpdate.risk, "contradict");

  const del = byMid(batch.mutations[3].mutationId);
  assert.equal(del.triage, "needs-review");
  assert.equal(del.risk, "look");
});

console.log("w1e-triage-routes.test.mjs: all node:test cases registered.");
