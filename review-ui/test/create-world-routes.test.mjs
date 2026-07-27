import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * Task 14.2 — "a brand-new world is a dead end" QA finding. bootstrapSnapshot()
 * (graph-import/headless-apply.mjs) already existed and was already tested,
 * but was never called from any production code path -- this proves the new
 * POST /api/worlds route (review-ui/server.mjs) actually wires it in, driven
 * from GENUINELY NOTHING ON DISK (no bootstrapSnapshot call anywhere in this
 * file's own setup, unlike every other route test in this suite), and that
 * the created world immediately appears in GET /api/worlds.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-create-world-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
// Deliberately NOT bootstrapping any world here -- this is the "nothing on
// disk yet" starting condition the task's acceptance criteria calls for.
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.WF_DATA_DIR = dataDir;

const { createReviewServer } = await import("../server.mjs");
const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");

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

test("precondition: dataDir/worlds does not exist yet -- genuinely nothing on disk", () => {
  assert.equal(existsSync(join(dataDir, "worlds")), false);
});

test("GET /api/worlds returns empty before any world is created", async () => {
  const { status, body } = await getJson("/api/worlds");
  assert.equal(status, 200);
  assert.deepEqual(body.worlds, []);
});

test("POST /api/worlds creates a brand-new world from nothing on disk", async () => {
  const { status, body } = await postJson("/api/worlds", { world: "brand-new-campaign" });
  assert.equal(status, 200);
  assert.equal(body.world, "brand-new-campaign");
  assert.equal(body.created, true);

  const snapPath = snapshotFilePath(dataDir, "brand-new-campaign");
  assert.equal(existsSync(snapPath), true, "bootstrapSnapshot should have written a real snapshot file");
});

test("the newly-created world immediately appears in GET /api/worlds", async () => {
  const { body } = await getJson("/api/worlds");
  assert.ok(body.worlds.includes("brand-new-campaign"));
});

test("POST /api/worlds with an already-taken id is rejected with a clean 409, not a crash or silent overwrite", async () => {
  const { status, body } = await postJson("/api/worlds", { world: "brand-new-campaign" });
  assert.equal(status, 409);
  assert.match(body.error, /already exists/i);
});

test("POST /api/worlds with a missing/blank world id is rejected with a clean 400", async () => {
  const { status } = await postJson("/api/worlds", { world: "   " });
  assert.equal(status, 400);
});

test("POST /api/worlds rejects an id with path-unsafe characters (it becomes a directory name)", async () => {
  const { status, body } = await postJson("/api/worlds", { world: "../escape-attempt" });
  assert.equal(status, 400);
  assert.match(body.error, /letters, digits, hyphens/i);
});

test("a second, independently-created world also appears alongside the first", async () => {
  const { status } = await postJson("/api/worlds", { world: "second_world-2" });
  assert.equal(status, 200);
  const { body } = await getJson("/api/worlds");
  assert.ok(body.worlds.includes("brand-new-campaign"));
  assert.ok(body.worlds.includes("second_world-2"));
});
