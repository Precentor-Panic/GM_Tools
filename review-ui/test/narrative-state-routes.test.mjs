import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST -- narrative-state ("Layer 2") HTTP routes:
 *   GET  /api/entities/:id/narrative-state?world=        -> {entityId, entityName, narrativeState|null}
 *   POST /api/entities/:id/narrative-state               {world, revealState?, truth?, stance?, clock?, note?, sessionNumber?}
 *   POST /api/entities/:id/narrative-state/tick          {world, delta?}
 *   GET  /api/narrative-state?world=&state=&ids=a,b      -> {world, records:[...record, entityName]}
 * Same harness as briefing-routes.test.mjs. The store override keeps writes
 * in scratch; ids bulk mode is the WS6 run-spread tab-seeding fetch.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-narrative-state-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_NARRATIVE_STATE_DIR = join(scratchDir, "narrative-state");
process.env.WF_DATA_DIR = dataDir;
const WORLD = "narrative-state-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;
const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../server.mjs");
const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "r-vane", name: "Corvin Vane", type: "person", importance: 0.9 } },
  { op: "upsert_entity", data: { id: "r-guild", name: "Dyers' Guild", type: "faction", importance: 0.5 } }
]);

let server, base;
before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(scratchDir, { recursive: true, force: true }); });
async function getJson(path) { const res = await fetch(`${base}${path}`); return { status: res.status, body: await res.json() }; }
async function postJson(path, body) { const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; }

test("GET: no record => narrativeState:null (fully open), name joined from snapshot", async () => {
  const { status, body } = await getJson(`/api/entities/r-vane/narrative-state?world=${WORLD}`);
  assert.equal(status, 200);
  assert.equal(body.narrativeState, null);
  assert.equal(body.entityName, "Corvin Vane");
});

test("POST combined write: create with truth+stance defaults to unrevealed; reveal transition appends; null clears", async () => {
  let res = await postJson("/api/entities/r-vane/narrative-state", {
    world: WORLD, truth: "He drains the Source.", stance: "concealing"
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.narrativeState.revealState, "unrevealed");
  assert.equal(res.body.narrativeState.stance, "concealing");

  res = await postJson("/api/entities/r-vane/narrative-state", {
    world: WORLD, revealState: "hinted", note: "ledger clue", sessionNumber: 2
  });
  assert.equal(res.body.narrativeState.revealState, "hinted");
  assert.equal(res.body.narrativeState.transitions.length, 2);
  assert.equal(res.body.narrativeState.truth, "He drains the Source.", "omitted fields untouched");

  res = await postJson("/api/entities/r-vane/narrative-state", { world: WORLD, stance: null });
  assert.equal(res.body.narrativeState.stance, undefined);
  assert.equal(res.body.narrativeState.truth, "He drains the Source.");
});

test("clock: set via combined write, tick route clamps, tick without a clock is a clean error", async () => {
  await postJson("/api/entities/r-guild/narrative-state", { world: WORLD, clock: { value: 2, max: 6 } });
  let res = await postJson("/api/entities/r-guild/narrative-state/tick", { world: WORLD, delta: 10 });
  assert.equal(res.status, 200);
  assert.equal(res.body.narrativeState.clock.value, 6, "clamped at max");
  res = await postJson("/api/entities/r-vane/narrative-state/tick", { world: WORLD });
  assert.ok(res.status >= 400, "no clock => error, not quiet success");
});

test("GET list: full scan with names, state filter, and ids bulk mode (the WS6 fetch)", async () => {
  const all = await getJson(`/api/narrative-state?world=${WORLD}`);
  assert.equal(all.body.records.length, 2);
  const hinted = await getJson(`/api/narrative-state?world=${WORLD}&state=hinted`);
  assert.deepEqual(hinted.body.records.map((r) => r.entityId), ["r-vane"]);
  const bulk = await getJson(`/api/narrative-state?world=${WORLD}&ids=r-vane,nobody`);
  assert.deepEqual(bulk.body.records.map((r) => r.entityId), ["r-vane"]);
  assert.equal(bulk.body.records[0].entityName, "Corvin Vane");
});

test("writes against an entity missing from the snapshot are refused", async () => {
  const res = await postJson("/api/entities/ghost/narrative-state", { world: WORLD, truth: "boo" });
  assert.ok(res.status >= 400);
});

test("SECURITY: a path-traversal-shaped world id is rejected with 400", async () => {
  const res = await getJson(`/api/narrative-state?world=${encodeURIComponent("../../etc")}`);
  assert.equal(res.status, 400);
});
