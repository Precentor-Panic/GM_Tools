// The grid a map is drawn at travels with the scene (2026-10-13):
//   - module-scene-grid.mjs reads it from a module's own Scene pack,
//   - the map asset records it (stagecraft-store gridSize),
//   - composeSceneOps sends it on CREATE only,
//   - regridSceneInFoundry sets it on an already-pushed scene, on request.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-scene-grid-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_STAGECRAFT_DIR = join(scratchDir, "stagecraft");
process.env.GM_TOOLS_SCENE_TRAY_DIR = join(scratchDir, "scene-tray");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");
const dataDir = join(scratchDir, "foundrydata");
const WORLD = "scene-grid-world";
after(() => rmSync(scratchDir, { recursive: true, force: true }));

const { parseModuleSrc, imageKey, gridSizeOf, gridsFromSceneDocs, readModuleSceneGrids, gridForSrc } = await import("../lib/module-scene-grid.mjs");
const { composeSceneOps, regridSceneInFoundry } = await import("../lib/foundry-push-ops.mjs");
const { foundryOpsPath } = await import("../lib/snapshot.mjs");
const { createScene, getScene, updateScene } = await import("../../session-planner/scenes.mjs");
const { saveStagecraftAsset, updateStagecraftAssetGrid, getStagecraftAsset } = await import("../../session-planner/stagecraft-store.mjs");

test("parseModuleSrc / imageKey: module images only, and URL-encoding does not matter", () => {
  assert.deepEqual(parseModuleSrc("modules/some-pack/Maps/Duke's Plaza.jpg"), { moduleId: "some-pack", file: "duke's plaza.jpg" });
  assert.equal(parseModuleSrc("worlds/x/maps/a.webp"), null);
  assert.equal(parseModuleSrc(null), null);
  assert.equal(imageKey("modules/p/Maps/Duke%27s%20Plaza.jpg"), "duke's plaza.jpg");
});

test("gridSizeOf: number (old schema) and {size} (current); implausible values are unknown", () => {
  assert.equal(gridSizeOf({ grid: 140 }), 140);
  assert.equal(gridSizeOf({ grid: { size: 70 } }), 70);
  assert.equal(gridSizeOf({ grid: { size: 0 } }), null);
  assert.equal(gridSizeOf({}), null);
});

test("gridsFromSceneDocs: background.src or img, keyed by image", () => {
  assert.deepEqual(
    gridsFromSceneDocs([
      { background: { src: "modules/p/Maps/A%27s.jpg" }, grid: { size: 140 } },
      { img: "modules/p/Maps/B.jpg", grid: 100 },
      { background: { src: "modules/p/Maps/C.jpg" } }
    ]),
    { "a's.jpg": 140, "b.jpg": 100 }
  );
});

test("readModuleSceneGrids: reads a NeDB pack; says why when there is nothing to read", async () => {
  const mod = join(dataDir, "modules", "pack-a");
  mkdirSync(join(mod, "packs"), { recursive: true });
  writeFileSync(join(mod, "packs", "maps.db"), [
    JSON.stringify({ name: "One", background: { src: "modules/pack-a/Maps/One.jpg" }, grid: { size: 140 } }),
    "",
    JSON.stringify({ name: "Two", img: "modules/pack-a/Maps/Two.jpg", grid: 70 })
  ].join("\n"));
  assert.deepEqual(await readModuleSceneGrids(dataDir, "pack-a", {}), { grids: { "one.jpg": 140, "two.jpg": 70 }, reason: null });
  assert.deepEqual(await gridForSrc(dataDir, "modules/pack-a/Maps/One.jpg", {}), { size: 140, reason: null });
  assert.match((await gridForSrc(dataDir, "modules/pack-a/Maps/Missing.jpg", {})).reason, /no scene for this image/);

  mkdirSync(join(dataDir, "modules", "images-only", "Maps"), { recursive: true });
  assert.match((await readModuleSceneGrids(dataDir, "images-only", {})).reason, /no scene pack/);
  assert.match((await readModuleSceneGrids(dataDir, "absent", {})).reason, /not installed/);
});

test("the map asset records gridSize; only a map may carry one; bad values are refused", () => {
  const map = saveStagecraftAsset(WORLD, { kind: "map", name: "Plaza", src: "modules/pack-a/Maps/One.jpg" }, { makeId: () => "sc-grid-map" });
  assert.equal(map.gridSize, null);
  assert.equal(updateStagecraftAssetGrid(WORLD, map.id, "140").gridSize, 140);
  assert.equal(getStagecraftAsset(WORLD, map.id).gridSize, 140);
  assert.throws(() => updateStagecraftAssetGrid(WORLD, map.id, 5), /10 to 2000/);
  assert.equal(updateStagecraftAssetGrid(WORLD, map.id, null).gridSize, null);
  const splash = saveStagecraftAsset(WORLD, { kind: "splash", name: "Art" }, { makeId: () => "sc-grid-splash" });
  assert.throws(() => updateStagecraftAssetGrid(WORLD, splash.id, 140), /not a map/);
});

test("composeSceneOps sends the grid on CREATE, and never on the update path", () => {
  updateStagecraftAssetGrid(WORLD, "sc-grid-map", 140);
  const scene = createScene(WORLD, { objectiveNote: "Plaza at night", mapAssetId: "sc-grid-map" });
  const created = composeSceneOps(dataDir, WORLD, getScene(WORLD, scene.id));
  assert.equal(created.sceneOp.kind, "create_scene");
  assert.deepEqual(created.sceneOp.data.grid, { size: 140 });

  updateScene(WORLD, scene.id, { foundrySceneRef: "Scene.already" });
  const updated = composeSceneOps(dataDir, WORLD, getScene(WORLD, scene.id));
  assert.equal(updated.sceneOp.kind, "update_scene");
  assert.equal(updated.sceneOp.data.patch.grid, undefined, "a re-push must not resize a dressed scene's tokens");
});

test("a map with no recorded grid sends none (Foundry keeps its default)", () => {
  saveStagecraftAsset(WORLD, { kind: "map", name: "Unknown", src: "worlds/x/a.webp" }, { makeId: () => "sc-grid-none" });
  const scene = createScene(WORLD, { objectiveNote: "No grid", mapAssetId: "sc-grid-none" });
  assert.equal(composeSceneOps(dataDir, WORLD, getScene(WORLD, scene.id)).sceneOp.data.grid, undefined);
});

test("regridSceneInFoundry: one update_scene op carrying the grid and nothing else", async () => {
  const scene = createScene(WORLD, { objectiveNote: "Regrid me", mapAssetId: "sc-grid-map" });
  await assert.rejects(() => regridSceneInFoundry(dataDir, WORLD, scene.id, { pollMs: 5, timeoutMs: 20 }), /no Foundry scene yet/);
  updateScene(WORLD, scene.id, { foundrySceneRef: "Scene.regrid" });
  const out = await regridSceneInFoundry(dataDir, WORLD, scene.id, { pollMs: 5, timeoutMs: 20 });
  assert.equal(out.status, "queued"); // no watcher in this test
  assert.equal(out.gridSize, 140);
  const ops = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"));
  assert.deepEqual(ops.at(-1).data, { sceneUuid: "Scene.regrid", patch: { grid: { size: 140 } } });
  rmSync(foundryOpsPath(dataDir, WORLD), { force: true });

  const bare = createScene(WORLD, { objectiveNote: "No size", mapAssetId: "sc-grid-none" });
  updateScene(WORLD, bare.id, { foundrySceneRef: "Scene.bare" });
  const noop = await regridSceneInFoundry(dataDir, WORLD, bare.id, { pollMs: 5, timeoutMs: 20 });
  assert.equal(noop.status, "noop");
  assert.match(noop.reason, /no grid size recorded/);
});
