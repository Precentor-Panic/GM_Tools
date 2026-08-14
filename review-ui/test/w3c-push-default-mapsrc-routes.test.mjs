import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — Friction Wave 1 W3c: POST /api/foundry/push-scene
 * no longer requires `mapSrc`. Omitted, pushSceneToFoundry defaults it from
 * the scene's linked map asset (scene.mapAssetId -> asset.src, else
 * foundryRef.imagePath). An explicit mapSrc still overrides. No mapSrc AND
 * no resolvable linked asset -> clean 400 with actionable guidance.
 *
 * Same in-process server + fake-watcher pattern as
 * review-ui/test/foundry-push-routes.test.mjs (which keeps covering the
 * explicit-mapSrc path unchanged).
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-w3c-push-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_STAGECRAFT_DIR = join(scratchDir, "stagecraft");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "w3c-push-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { foundryOpsPath, foundryResultsPath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { createScene, getScene } = await import("../../session-planner/scenes.mjs");
const { saveStagecraftAsset } = await import("../../session-planner/stagecraft-store.mjs");
const { createReviewServer } = await import("../server.mjs");

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

async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

function seedFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
}

test("push-scene with NO mapSrc: defaults from the linked asset's src -- full round trip, the applied op's background.src is the asset's path", async () => {
  const asset = saveStagecraftAsset(
    WORLD,
    { kind: "map", name: "Lowway Alleys", src: "worlds/kilmarn/maps/lowway.webp" },
    { makeId: () => "sc-w3c-route-1" }
  );
  const scene = createScene(WORLD, { objectiveNote: "Alley chase", mapAssetId: asset.id });

  const opsPath = foundryOpsPath(dataDir, WORLD);
  const resultsPath = foundryResultsPath(dataDir, WORLD);
  let capturedOp = null;
  const watcherInterval = setInterval(() => {
    if (!existsSync(opsPath)) return;
    let ops;
    try { ops = JSON.parse(readFileSync(opsPath, "utf8")); } catch { return; }
    if (Array.isArray(ops) && ops.length && ops[0].kind === "create_scene") {
      clearInterval(watcherInterval);
      capturedOp = ops[0];
      seedFile(resultsPath, [{ opId: ops[0].opId, ok: true, foundryUuid: "Scene.w3cDefaulted" }]);
      writeFileSync(opsPath, "[]", "utf8");
    }
  }, 20);

  const { status, body } = await postJson("/api/foundry/push-scene", { world: WORLD, sceneId: scene.id });
  clearInterval(watcherInterval);

  assert.equal(status, 200);
  assert.equal(body.status, "applied");
  assert.equal(body.ok, true);
  assert.deepEqual(capturedOp.data.background, { src: "worlds/kilmarn/maps/lowway.webp" }, "the DEFAULTED src rode the op");
  assert.equal(getScene(WORLD, scene.id).foundrySceneRef, "Scene.w3cDefaulted");
});

test("push-scene with an explicit mapSrc still overrides the linked asset", async () => {
  const asset = saveStagecraftAsset(WORLD, { kind: "map", name: "Default Map", src: "worlds/x/maps/default.webp" }, { makeId: () => "sc-w3c-route-2" });
  const scene = createScene(WORLD, { objectiveNote: "Override", mapAssetId: asset.id });

  // No watcher -- queued is fine, we inspect the composed op directly.
  const { status, body } = await postJson("/api/foundry/push-scene", {
    world: WORLD, sceneId: scene.id, mapSrc: "scenes/explicit.webp"
  });
  assert.equal(status, 200);
  assert.equal(body.status, "queued");
  const ops = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"));
  const op = ops.find((o) => o.opId === body.opId);
  assert.deepEqual(op.data.background, { src: "scenes/explicit.webp" });
  // Leave the channel clean for any later test.
  writeFileSync(foundryOpsPath(dataDir, WORLD), "[]", "utf8");
});

test("push-scene with NO mapSrc and NO linked asset -> clean 400 pointing at both fixes", async () => {
  const scene = createScene(WORLD, { objectiveNote: "Mapless" });
  const { status, body } = await postJson("/api/foundry/push-scene", { world: WORLD, sceneId: scene.id });
  assert.equal(status, 400);
  assert.match(body.error, /mapSrc/);
  assert.match(body.error, /link a map asset/i);
});

test("push-scene with a linked asset that has NO resolvable source -> clean 400 naming the asset", async () => {
  const asset = saveStagecraftAsset(WORLD, { kind: "map", name: "Pathless" }, { makeId: () => "sc-w3c-route-4" });
  const scene = createScene(WORLD, { objectiveNote: "Pathless push", mapAssetId: asset.id });
  const { status, body } = await postJson("/api/foundry/push-scene", { world: WORLD, sceneId: scene.id });
  assert.equal(status, 400);
  assert.match(body.error, /sc-w3c-route-4/);
  assert.match(body.error, /no resolvable source/i);
});
