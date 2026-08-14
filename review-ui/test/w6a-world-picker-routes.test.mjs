import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * W6a — world attach/create picker routes. Friction source (one-shot log,
 * 2026-08-14): Russell had a real Foundry world (`kilmarn`) on disk with no
 * World Fabric snapshot, and the Settings/gear create card offered no way to
 * point GM_Tools at it — typing its name would have errored "already
 * exists". These tests prove the reworked surface:
 *   - GET /api/worlds now carries `worldDirs` (EVERY Data/worlds/* dir with
 *     hasSnapshot + attachable flags) alongside the unchanged snapshot-only
 *     `worlds` list, both from the same listWorldDirs() scan.
 *   - POST /api/worlds ATTACHES when the id names an existing snapshotless
 *     folder (bootstraps the snapshot INTO it, `attached: true`, foreign
 *     files untouched) and still CREATES from nothing otherwise.
 *   - A snapshot-bearing id still 409s exactly as before.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-w6a-world-picker-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.WF_DATA_DIR = dataDir;

const { createReviewServer } = await import("../server.mjs");
const { bootstrapSnapshot } = await import("../../graph-import/headless-apply.mjs");
const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");

// The on-disk starting condition, mirroring the real friction scenario:
//   worlds/settled     -- an existing GM_Tools world (has a snapshot)
//   worlds/kilmarn     -- a real Foundry world folder, NO snapshot (the case)
//   worlds/bad name    -- a folder whose name can't be a world id
bootstrapSnapshot(snapshotFilePath(dataDir, "settled"), { worldId: "settled" });
mkdirSync(join(dataDir, "worlds", "kilmarn"), { recursive: true });
writeFileSync(join(dataDir, "worlds", "kilmarn", "world.json"), JSON.stringify({ id: "kilmarn", title: "Kilmarn" }), "utf8");
mkdirSync(join(dataDir, "worlds", "bad name"), { recursive: true });

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

test("GET /api/worlds: worldDirs lists EVERY world folder with hasSnapshot/attachable flags; `worlds` stays snapshot-only", async () => {
  const { status, body } = await getJson("/api/worlds");
  assert.equal(status, 200);

  // The long-standing topbar source is unchanged: snapshot-bearing ids only.
  assert.deepEqual(body.worlds, ["settled"]);

  const byId = Object.fromEntries(body.worldDirs.map((w) => [w.id, w]));
  assert.deepEqual(byId["settled"], { id: "settled", hasSnapshot: true, attachable: false });
  assert.deepEqual(byId["kilmarn"], { id: "kilmarn", hasSnapshot: false, attachable: true });
  // A folder name that can't be a world id is listed (never silently hidden)
  // but marked not attachable -- the same regex floor POST enforces.
  assert.deepEqual(byId["bad name"], { id: "bad name", hasSnapshot: false, attachable: false });
});

test("the two world lists come from one scan: every `worlds` entry is a hasSnapshot worldDir", async () => {
  const { body } = await getJson("/api/worlds");
  const snapshotIds = body.worldDirs.filter((w) => w.hasSnapshot).map((w) => w.id).sort();
  assert.deepEqual([...body.worlds].sort(), snapshotIds);
});

test("POST /api/worlds ATTACHES an existing snapshotless Foundry folder (the kilmarn case): snapshot bootstrapped INTO it, attached:true", async () => {
  const { status, body } = await postJson("/api/worlds", { world: "kilmarn" });
  assert.equal(status, 200);
  assert.equal(body.world, "kilmarn");
  assert.equal(body.attached, true);
  assert.equal(body.created, false);

  const snapPath = snapshotFilePath(dataDir, "kilmarn");
  assert.equal(existsSync(snapPath), true, "snapshot should be bootstrapped into the EXISTING folder");
  const snap = JSON.parse(readFileSync(snapPath, "utf8"));
  assert.equal(snap.meta.worldId, "kilmarn");

  // The real Foundry world's own files are untouched -- attach adds a
  // snapshot alongside, never rewrites the folder.
  const worldJson = JSON.parse(readFileSync(join(dataDir, "worlds", "kilmarn", "world.json"), "utf8"));
  assert.deepEqual(worldJson, { id: "kilmarn", title: "Kilmarn" });
});

test("after attach, kilmarn appears in the snapshot-bearing `worlds` list (selectable everywhere)", async () => {
  const { body } = await getJson("/api/worlds");
  assert.ok(body.worlds.includes("kilmarn"));
  const row = body.worldDirs.find((w) => w.id === "kilmarn");
  assert.equal(row.hasSnapshot, true);
  assert.equal(row.attachable, false);
});

test("POST /api/worlds on an already-attached world still 409s (the pre-W6a contract, unchanged)", async () => {
  const { status, body } = await postJson("/api/worlds", { world: "kilmarn" });
  assert.equal(status, 409);
  assert.match(body.error, /already exists/i);
});

test("POST /api/worlds still CREATES from nothing when no folder exists (created:true, attached:false)", async () => {
  const { status, body } = await postJson("/api/worlds", { world: "brand-new" });
  assert.equal(status, 200);
  assert.equal(body.created, true);
  assert.equal(body.attached, false);
  assert.equal(existsSync(snapshotFilePath(dataDir, "brand-new")), true);
});

test("POST /api/worlds rejects an id outside the regex floor even though a folder with that name exists", async () => {
  const { status, body } = await postJson("/api/worlds", { world: "bad name" });
  assert.equal(status, 400);
  assert.match(body.error, /letters, digits, hyphens/i);
});
