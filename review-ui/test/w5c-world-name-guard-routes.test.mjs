import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * Friction Wave 1, W5c — HTTP layer: GET /api/batches/:batchId marks any
 * pending entity row named exactly like the world with
 * `worldNameCollision: true` (non-blocking advisory; proposal-card renders
 * it as a subtle "shares the world's name" tag). Same read-time convention
 * as W1a's nearMatches / W1e's triage — nothing persisted.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-w5c-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "kilmarn-guard-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../graph-import/headless-apply.mjs");
const { createBatch } = await import("../../mutation-engine/review-state.mjs");
const { createReviewServer } = await import("../server.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

const CREATED = (data) => [{ field: "(created)", from: null, to: data }];
function wm(extra) {
  return { rationale: "r", batchId: "placeholder", sourceKind: "writeup-import", ...extra };
}

const batch = createBatch(
  WORLD,
  { mode: "writeup-import", text: "seed" },
  undefined,
  [
    // Named EXACTLY like the world (different casing) — flagged.
    wm({ op: "upsert_entity", id: "wf_new_0", data: { name: "Kilmarn-Guard-World", type: "place", description: "The city." }, diff: CREATED({ name: "Kilmarn-Guard-World" }) }),
    // An ordinary create — never flagged.
    wm({ op: "upsert_entity", id: "wf_new_1", data: { name: "The Underbreach", type: "place", description: "A quarter." }, diff: CREATED({ name: "The Underbreach" }) })
  ],
  { makeId: () => "batch_w5c_test" }
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

test("W5c: the batch detail payload flags the world-named row (case-insensitive) and only that row", async () => {
  const res = await fetch(`${base}/api/batches/${batch.id}?world=${WORLD}`);
  assert.equal(res.status, 200);
  const detail = await res.json();
  const rows = detail.regions.flatMap((r) => r.entities);
  const flagged = rows.find((e) => e.mutationId === batch.mutations[0].mutationId);
  const plain = rows.find((e) => e.mutationId === batch.mutations[1].mutationId);
  assert.equal(flagged.worldNameCollision, true, "the world-named create carries the advisory");
  assert.equal(plain.worldNameCollision, undefined, "an ordinary create does not");
});

test("W5c: the guard is advisory only — the flagged mutation accepts exactly like any other", async () => {
  const mid = batch.mutations[0].mutationId;
  const res = await fetch(`${base}/api/batches/${batch.id}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, scope: "entity", id: mid })
  });
  assert.equal(res.status, 200, "never a block");
  const detail = await (await fetch(`${base}/api/batches/${batch.id}?world=${WORLD}`)).json();
  const row = detail.regions.flatMap((r) => r.entities).find((e) => e.mutationId === mid);
  assert.equal(row.status, "accepted");
  assert.equal(row.worldNameCollision, undefined, "a settled row no longer needs the advisory");
});
