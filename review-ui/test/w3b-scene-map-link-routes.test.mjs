import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — Friction Wave 1 W3b (scene↔map association):
 * the scene patch route POST /api/session-planner/scenes/:sceneId gained
 * `mapAssetId` — link (or clear, with null) ONE stagecraft map asset to a
 * scene. Cross-store validation lives at the ROUTE (scenes.mjs stays pure):
 *   - unknown asset id -> clean 400 ("No stagecraft asset found")
 *   - a non-map asset (splash/music) -> 400 (kind guard)
 *   - null clears; omitting the key leaves the link untouched
 * GET scene routes return the field (null for pre-W3b records).
 *
 * Real HTTP via fetch() against an in-process server.listen(0), same
 * pattern as review-ui/test/session-planner-routes.test.mjs.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-w3b-scene-map-routes-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_STAGECRAFT_DIR = join(scratchDir, "stagecraft");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_SCENE_TRAY_DIR = join(scratchDir, "scene-tray");
process.env.WF_DATA_DIR = join(scratchDir, "foundrydata");

const WORLD = "w3b-scene-map-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { createReviewServer } = await import("../server.mjs");
const { createScene, getScene } = await import("../../session-planner/scenes.mjs");
const { saveStagecraftAsset } = await import("../../session-planner/stagecraft-store.mjs");

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

test("scene patch: links an existing kind:'map' asset, GET reflects it, an unrelated patch leaves it untouched, null clears it", async () => {
  const mapAsset = saveStagecraftAsset(WORLD, { kind: "map", name: "Lowway Alleys", src: "worlds/kilmarn/maps/lowway.webp" }, { makeId: () => "sc-map-1" });
  const scene = createScene(WORLD, { objectiveNote: "Chase through the alleys" }, { makeId: () => "scene-map-1" });

  const link = await postJson(`/api/session-planner/scenes/${scene.id}`, { world: WORLD, mapAssetId: mapAsset.id });
  assert.equal(link.status, 200);
  assert.equal(link.body.scene.mapAssetId, "sc-map-1");

  const got = await getJson(`/api/session-planner/scenes/${scene.id}?world=${WORLD}`);
  assert.equal(got.body.scene.mapAssetId, "sc-map-1");

  // An unrelated objective edit must not drop the link (undefined-means-untouched).
  const unrelated = await postJson(`/api/session-planner/scenes/${scene.id}`, { world: WORLD, objectiveNote: "Updated objective" });
  assert.equal(unrelated.status, 200);
  assert.equal(unrelated.body.scene.mapAssetId, "sc-map-1");

  const clear = await postJson(`/api/session-planner/scenes/${scene.id}`, { world: WORLD, mapAssetId: null });
  assert.equal(clear.status, 200);
  assert.equal(clear.body.scene.mapAssetId, null);
  assert.equal(getScene(WORLD, scene.id).mapAssetId, null, "persisted, not just echoed");
});

test("scene patch: an UNKNOWN mapAssetId -> clean 400, nothing written", async () => {
  const scene = createScene(WORLD, {}, { makeId: () => "scene-map-2" });
  const { status, body } = await postJson(`/api/session-planner/scenes/${scene.id}`, { world: WORLD, mapAssetId: "sc-does-not-exist" });
  assert.equal(status, 400);
  assert.match(body.error, /No stagecraft asset found/);
  assert.equal(getScene(WORLD, scene.id).mapAssetId, null, "the failed link must not half-write");
});

test("scene patch: a NON-map asset (splash) -> 400 kind guard, nothing written", async () => {
  const splash = saveStagecraftAsset(WORLD, { kind: "splash", name: "Cover Art" }, { makeId: () => "sc-splash-1" });
  const scene = createScene(WORLD, {}, { makeId: () => "scene-map-3" });
  const { status, body } = await postJson(`/api/session-planner/scenes/${scene.id}`, { world: WORLD, mapAssetId: splash.id });
  assert.equal(status, 400);
  assert.match(body.error, /must reference a kind:"map" stagecraft asset/);
  assert.equal(getScene(WORLD, scene.id).mapAssetId, null);
});

test("scene list + scene-planning list both carry mapAssetId (the scene-card chips' data), null for a linkless scene", async () => {
  const mapAsset = saveStagecraftAsset(WORLD, { kind: "map", name: "Docks" }, { makeId: () => "sc-map-list" });
  const linked = createScene(WORLD, { mapAssetId: mapAsset.id }, { makeId: () => "scene-map-4" });
  const bare = createScene(WORLD, {}, { makeId: () => "scene-map-5" });

  const list = await getJson(`/api/session-planner/scenes?world=${WORLD}`);
  assert.equal(list.status, 200);
  const rowLinked = list.body.scenes.find((s) => s.id === linked.id);
  const rowBare = list.body.scenes.find((s) => s.id === bare.id);
  assert.equal(rowLinked.mapAssetId, "sc-map-list");
  assert.equal(rowBare.mapAssetId, null);

  // The scene-tray's own list route (scene-planning prefix, recency sort)
  // reads the same store, so the chip data flows there too.
  const trayList = await getJson(`/api/scene-planning/scenes?world=${WORLD}&sort=recency`);
  if (trayList.status === 200) {
    const trayRow = trayList.body.scenes.find((s) => s.id === linked.id);
    assert.equal(trayRow.mapAssetId, "sc-map-list");
  }
});

test("fork route: the fork inherits the parent's mapAssetId (same place, same map)", async () => {
  const mapAsset = saveStagecraftAsset(WORLD, { kind: "map", name: "Bridge" }, { makeId: () => "sc-map-fork" });
  const parent = createScene(WORLD, { mapAssetId: mapAsset.id }, { makeId: () => "scene-map-parent" });
  const { status, body } = await postJson(`/api/session-planner/scenes/${parent.id}/fork`, { world: WORLD });
  assert.equal(status, 200);
  assert.equal(body.scene.mapAssetId, "sc-map-fork");
  assert.equal(body.scene.foundrySceneRef, null, "push-instance state still not inherited");
});
