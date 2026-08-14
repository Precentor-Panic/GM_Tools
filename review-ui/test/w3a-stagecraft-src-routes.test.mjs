import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — Friction Wave 1 W3a (the "scenes cannot reference a
 * map" cluster, scene↔map association):
 *   - POST /api/session-planner/stagecraft/hand-add gained an optional `src`
 *     field (the asset's Foundry-resolvable file path/URL).
 *   - NEW POST /api/session-planner/stagecraft/:id/src {world, src} sets or
 *     clears it on an EXISTING asset, status-independently (an accepted
 *     asset's path is an ongoing table-use edit, bestiary note convention).
 *   - GET /api/session-planner/stagecraft returns `src` (null for every
 *     pre-W3a record -- the kilmarn back-compat case).
 *
 * Real HTTP requests via fetch() against an in-process server.listen(0),
 * same pattern as review-ui/test/library-routes.test.mjs.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-w3a-src-routes-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_STAGECRAFT_DIR = join(scratchDir, "stagecraft");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.WF_DATA_DIR = join(scratchDir, "foundrydata");

const WORLD = "w3a-src-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { createReviewServer } = await import("../server.mjs");
const { saveStagecraftAsset, getStagecraftAsset } = await import("../../session-planner/stagecraft-store.mjs");

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

test("hand-add: `src` is optional and round-trips; omitted -> null", async () => {
  const withSrc = await postJson("/api/session-planner/stagecraft/hand-add", {
    world: WORLD, name: "Lowway Alleys", kind: "map", src: "worlds/kilmarn/maps/lowway-alleys.webp"
  });
  assert.equal(withSrc.status, 200);
  assert.equal(withSrc.body.asset.src, "worlds/kilmarn/maps/lowway-alleys.webp");
  assert.equal(withSrc.body.asset.status, "accepted", "hand-add stays the deliberate authorship act");

  const without = await postJson("/api/session-planner/stagecraft/hand-add", {
    world: WORLD, name: "Unmapped Splash", kind: "splash"
  });
  assert.equal(without.status, 200);
  assert.equal(without.body.asset.src, null);
});

test("POST .../stagecraft/:id/src sets, edits, and clears the path on an ACCEPTED asset; the list route reflects it", async () => {
  const asset = saveStagecraftAsset(WORLD, { kind: "map", name: "Docks" }, { makeId: () => "sc-route-1" });
  assert.equal(asset.status, "accepted");

  const set = await postJson(`/api/session-planner/stagecraft/${asset.id}/src`, {
    world: WORLD, src: "worlds/kilmarn/maps/docks.webp"
  });
  assert.equal(set.status, 200);
  assert.equal(set.body.asset.src, "worlds/kilmarn/maps/docks.webp");

  const list = await getJson(`/api/session-planner/stagecraft?world=${WORLD}&kind=map`);
  assert.equal(list.status, 200);
  const row = list.body.assets.find((a) => a.id === asset.id);
  assert.equal(row.src, "worlds/kilmarn/maps/docks.webp");

  const cleared = await postJson(`/api/session-planner/stagecraft/${asset.id}/src`, { world: WORLD, src: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.asset.src, null);
  assert.equal(getStagecraftAsset(WORLD, asset.id).src, null, "persisted, not just echoed");
});

test("POST .../stagecraft/:id/src: unknown asset id -> clean 400, not a 500 (same convention as the sibling accept/discard/tags routes)", async () => {
  const { status, body } = await postJson("/api/session-planner/stagecraft/sc-does-not-exist/src", {
    world: WORLD, src: "x.webp"
  });
  assert.equal(status, 400);
  assert.match(body.error, /No stagecraft asset found/);
});

test("SECURITY: the src route rejects a path-traversal-shaped world id with 400 before any file read", async () => {
  const { status, body } = await postJson("/api/session-planner/stagecraft/whatever/src", {
    world: "../../../../etc", src: "x.webp"
  });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("back-compat: an asset saved without src (every pre-W3a kilmarn record's shape) lists with src:null and stays otherwise intact", async () => {
  const legacy = saveStagecraftAsset(
    WORLD,
    { kind: "map", name: "Kilmarn Bridge Crossing", desc: "MAP path lives in desc, the old workaround" },
    { makeId: () => "sc-legacy-1" }
  );
  const list = await getJson(`/api/session-planner/stagecraft?world=${WORLD}`);
  const row = list.body.assets.find((a) => a.id === legacy.id);
  assert.equal(row.src ?? null, null);
  assert.equal(row.desc, "MAP path lives in desc, the old workaround");
});
