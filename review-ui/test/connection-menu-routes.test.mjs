import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, dirname as pathDirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — Phase 34 task 34.1's Connection-Menu backend glue
 * routes, per plans/phase-34-tasks.md's pre-specified route/store contract
 * (orchestrator-locked so 34.0's e2e can be written against the SAME
 * shapes in parallel). Real HTTP requests via fetch() against an in-process
 * server.listen(0), same pattern as review-ui/test/foundry-pull-routes.test.mjs.
 *
 *   GET  /api/foundry/connection?world=
 *   POST /api/foundry/sync-now       {world}
 *   GET  /api/settings?world=
 *   POST /api/settings               {world, ...patch}
 *   POST /api/lore/worldanvil        {world, url}
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "..", "wf-mcp-server", "test", "fixtures", "foundry-bridge");

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-connection-menu-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");
process.env.GM_TOOLS_SYNC_LOG_DIR = join(scratchDir, "foundry-sync-log");
process.env.GM_TOOLS_APP_SETTINGS_DIR = join(scratchDir, "app-settings");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "connection-menu-routes-test-world";
const NO_INDEX_WORLD = "connection-menu-routes-no-index-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { foundryIndexPath, snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../server.mjs");

// POST /api/lore/worldanvil loads the world's live snapshot before
// delegating (the SAME unconditional loadSnapshot precondition the existing
// POST /api/writeup-propose route's own proposeFromWriteupOp already has --
// not something this task's route invented) -- so the worldanvil tests
// below need a real (even if empty) snapshot to exist for WORLD first.
bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

const sampleFixture = JSON.parse(readFileSync(join(FIXTURES_DIR, "foundry-index.sample.json"), "utf8"));
const indexDest = foundryIndexPath(dataDir, WORLD);
mkdirSync(pathDirname(indexDest), { recursive: true });
// Fresh at write time -- deriveConnectionState's own tests already cover
// stale/off math directly against the library function; this route-level
// suite only needs to confirm the HTTP layer wires it through correctly.
writeFileSync(indexDest, JSON.stringify({ ...sampleFixture, exportedAt: new Date().toISOString() }), "utf8");

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

// ---------------------------------------------------------------- GET /api/foundry/connection

test("GET /api/foundry/connection: a fresh index -- state live, counts populated, exact contract shape", async () => {
  const { status, body } = await getJson(`/api/foundry/connection?world=${WORLD}`);
  assert.equal(status, 200);
  assert.equal(body.state, "live");
  assert.equal(body.world, WORLD);
  assert.ok(typeof body.ageMs === "number");
  assert.ok(typeof body.staleThresholdMs === "number");
  assert.deepEqual(body.counts, { actors: 3, items: 0, scenes: 1, journals: 0 });
  assert.equal(body.lastSync, null, "no sync has happened yet for this world");
});

test("GET /api/foundry/connection: no index at all -- state off, counts null, still 200", async () => {
  const { status, body } = await getJson(`/api/foundry/connection?world=${NO_INDEX_WORLD}`);
  assert.equal(status, 200);
  assert.equal(body.state, "off");
  assert.equal(body.counts, null);
  assert.equal(body.exportedAt, null);
});

test("GET /api/foundry/connection: a per-world staleThresholdMs from the settings store shifts the state", async () => {
  const world = "connection-menu-threshold-world";
  const dest = foundryIndexPath(dataDir, world);
  mkdirSync(pathDirname(dest), { recursive: true });
  // Deliberately 2 hours old -- stale under the default 15-min threshold.
  writeFileSync(dest, JSON.stringify({ ...sampleFixture, exportedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }), "utf8");

  const beforeSettings = await getJson(`/api/foundry/connection?world=${world}`);
  assert.equal(beforeSettings.body.state, "stale");

  await postJson("/api/settings", { world, staleThresholdMs: 6 * 60 * 60 * 1000 }); // 6 hours
  const afterSettings = await getJson(`/api/foundry/connection?world=${world}`);
  assert.equal(afterSettings.body.state, "live", "a wider settings-store threshold must move a stale index back to live");
});

test("SECURITY: GET /api/foundry/connection rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await getJson(`/api/foundry/connection?world=${encodeURIComponent("../../../../etc")}`);
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

// ---------------------------------------------------------------- POST /api/foundry/sync-now

test("POST /api/foundry/sync-now: no index yet -- 200, {state:'off', message}, NOT a throw/block", async () => {
  const { status, body } = await postJson("/api/foundry/sync-now", { world: NO_INDEX_WORLD });
  assert.equal(status, 200);
  assert.equal(body.state, "off");
  assert.match(body.message, /No Foundry index found/);
});

test("POST /api/foundry/sync-now: real fixture -- pulls, reports state/indexAgeMs, and the connection route's lastSync updates afterward", async () => {
  const { status, body } = await postJson("/api/foundry/sync-now", { world: WORLD });
  assert.equal(status, 200);
  assert.equal(body.state, "live");
  assert.ok(typeof body.indexAgeMs === "number");
  assert.equal(body.pulled.bestiaryProposed.length, 2);
  assert.equal(body.pulled.partyProposed.length, 1);

  const connection = await getJson(`/api/foundry/connection?world=${WORLD}`);
  assert.ok(connection.body.lastSync, "a sync-now call must be reflected in the connection route's lastSync afterward");
  assert.equal(connection.body.lastSync.ok, true);
});

// ---------------------------------------------------------------- GET/POST /api/settings

test("GET /api/settings: no settings yet -- {}", async () => {
  const { status, body } = await getJson(`/api/settings?world=${encodeURIComponent("settings-fresh-world")}`);
  assert.equal(status, 200);
  assert.deepEqual(body, {});
});

test("POST /api/settings: patch semantics -- a second patch only changes the keys it supplies", async () => {
  const world = "settings-patch-world";
  const first = await postJson("/api/settings", { world, campaignName: "The Threadbare City", calendar: "Harptos" });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { campaignName: "The Threadbare City", calendar: "Harptos" });

  const second = await postJson("/api/settings", { world, calendar: "Barovian" });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, { campaignName: "The Threadbare City", calendar: "Barovian" });

  const read = await getJson(`/api/settings?world=${world}`);
  assert.deepEqual(read.body, second.body);
});

test("POST /api/settings: `world`/`dataDir` in the body are stripped from the stored patch, never persisted as settings fields", async () => {
  const world = "settings-strip-world";
  const { body } = await postJson("/api/settings", { world, dataDir: "../../etc", campaignName: "Real Campaign" });
  assert.deepEqual(body, { campaignName: "Real Campaign" });
});

test("SECURITY: POST /api/settings rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await postJson("/api/settings", { world: "../../../../etc", campaignName: "x" });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

// ---------------------------------------------------------------- POST /api/lore/worldanvil

test("POST /api/lore/worldanvil: requires a non-empty url -- 400", async () => {
  const { status, body } = await postJson("/api/lore/worldanvil", { world: WORLD });
  assert.equal(status, 400);
  assert.match(body.error, /url/i);
});

test("POST /api/lore/worldanvil: an unreachable URL -- clean 4xx (not a 500/502), clear message", async () => {
  const { status, body } = await postJson("/api/lore/worldanvil", { world: WORLD, url: "http://127.0.0.1:1/definitely-not-listening" });
  assert.ok(status >= 400 && status < 500, `expected a clean 4xx, got ${status}`);
  assert.ok(body.error && body.error.length > 0);
});

test("POST /api/lore/worldanvil: a non-http(s) url -- 400 before any fetch is attempted", async () => {
  const { status, body } = await postJson("/api/lore/worldanvil", { world: WORLD, url: "file:///etc/passwd" });
  assert.equal(status, 400);
  assert.match(body.error, /http/i);
});

void __dirname;
