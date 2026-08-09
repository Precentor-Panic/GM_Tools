// Phase 36 task 36.0 -- QE-first e2e contract, part 3: ROUTE-LEVEL only (no
// browser). Read phase36-fixture.mjs FIRST (§4 pull capture:
// foundryRef.imagePath). NO live Foundry -- reuses phase35-fixture.mjs's
// own writeFoundryIndexFixture (a real scene with background.src) as the
// deterministic stand-in for a Foundry-side export.
//
// EXPECTED-RED reason: `upsertStagecraftMap` (wf-mcp-server/lib/
// foundry-pull-ops.mjs:199-220) builds `foundryRef: { sceneUuid: scene.uuid
// }` only -- `imagePath` is never assigned (grep/read-confirmed) -- this is
// the exact grounding-facts gap ("StagecraftAsset.foundryRef = {sceneUuid}
// only -- the pull DISCARDS background.src"). A clean assertion failure
// (the field is `undefined`), not a fixture crash.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import {
  setupPhase36Env,
  cleanupScratchEnv,
  writeFoundryIndexFixture,
  pullActorsViaRoute,
  listStagecraftViaRoute
} from "./phase36-fixture.mjs";

const { scratchDir, dataDir } = setupPhase36Env("gm-tools-e2e-p36imgpath-");
const WORLD = "e2e-p36-pull-imagepath";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });
const seededIndex = writeFoundryIndexFixture(dataDir, WORLD); // "The Sunken Chantry", background.src = "scenes/sunken-chantry.webp"

let server, base, pulled;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  pulled = await pullActorsViaRoute(base, WORLD);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("pull-actors' stagecraftProposed map ref captures foundryRef.imagePath from scenes[].background.src (§4)", async () => {
  assert.ok(Array.isArray(pulled.stagecraftProposed), "sanity: the §6-of-phase35 stagecraftProposed array must already exist (Phase 35 shipped this)");
  const chantryMap = pulled.stagecraftProposed.find((a) => a.foundryRef?.sceneUuid === "Scene.sunkenChantry");
  assert.ok(chantryMap, `expected a stagecraft map proposal for Scene.sunkenChantry -- got ${JSON.stringify(pulled.stagecraftProposed)}`);
  assert.equal(
    chantryMap.foundryRef.imagePath,
    seededIndex.scenes[0].background.src,
    "foundryRef.imagePath must be captured from scenes[].background.src (currently DISCARDED by upsertStagecraftMap -- only sceneUuid is set today)"
  );
});

test("the same capture happens via GET /api/session-planner/stagecraft (the actual on-disk record, not just the pull response)", async () => {
  const r = await listStagecraftViaRoute(base, WORLD, "map");
  assert.equal(r.status, 200);
  const chantryMap = r.body.assets.find((a) => a.foundryRef?.sceneUuid === "Scene.sunkenChantry");
  assert.ok(chantryMap, `expected a persisted stagecraft map asset for Scene.sunkenChantry -- got ${JSON.stringify(r.body.assets)}`);
  assert.equal(chantryMap.foundryRef.imagePath, seededIndex.scenes[0].background.src);
});
