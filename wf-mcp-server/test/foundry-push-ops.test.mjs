import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CONTRACT UNDER TEST — wf-mcp-server/lib/foundry-push-ops.mjs's
 * pushSceneToFoundry(dir, world, sceneId, {mapSrc}) (Phase 32 task 32.3).
 * End-to-end against a real (scratch-isolated) scenes.mjs store + the real
 * ops-channel writer, no live Foundry -- a background timer simulates the
 * Foundry-side watcher exactly like foundry-ops.test.mjs does, and small
 * injected pollMs/timeoutMs keep every test here fast.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures", "foundry-bridge");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-foundry-push-ops-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state"); // scenes.mjs transitively imports withLock from review-state.mjs
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
// Phase 36 task 36.2 -- the flush engine's own store dependencies.
process.env.GM_TOOLS_STAGECRAFT_DIR = join(scratchDir, "stagecraft");
process.env.GM_TOOLS_SCENE_TRAY_DIR = join(scratchDir, "scene-tray");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");
const dataDir = join(scratchDir, "foundrydata");
const localFilesDir = join(scratchDir, "local-files"); // a hand-added 'local' asset's source dir, OUTSIDE dataDir

const {
  pushSceneToFoundry, composeSceneOps, flushDirtyStagedScenes, isSceneDirty,
  clusterTokenPositions, DEFAULT_CANVAS, DEFAULT_GRID_SIZE
} = await import("../lib/foundry-push-ops.mjs");
const { foundryOpsPath, foundryResultsPath } = await import("../lib/snapshot.mjs");
const { createScene, getScene, updateScene, markScenePushed } = await import("../../session-planner/scenes.mjs");
const { addToSceneTray } = await import("../../session-planner/scene-tray.mjs");
const { saveStagecraftAsset, acceptStagecraftAsset, stagecraftRoot } = await import("../../session-planner/stagecraft-store.mjs");
const { saveBestiaryEntry, acceptBestiaryEntry } = await import("../../combat-planning/bestiary-store.mjs");
const { savePartyMember } = await import("../../combat-planning/party-roster-store.mjs");

const sampleOp = JSON.parse(readFileSync(join(FIXTURES_DIR, "foundry-ops.create-scene.sample.json"), "utf8"))[0];

function seedFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
}

/** Arms a one-shot fake watcher: after `delayMs`, writes `result` to the results file then clears the ops file to "[]". */
function armFakeWatcher(world, result, delayMs = 25) {
  const opsPath = foundryOpsPath(dataDir, world);
  const resultsPath = foundryResultsPath(dataDir, world);
  return setTimeout(() => {
    seedFile(resultsPath, [result]);
    writeFileSync(opsPath, "[]", "utf8");
  }, delayMs);
}

await test("pushSceneToFoundry: requires mapSrc", async () => {
  const WORLD = "push-validation-world";
  const scene = createScene(WORLD, { objectiveNote: "test" });
  await assert.rejects(() => pushSceneToFoundry(dataDir, WORLD, scene.id, {}, { pollMs: 5, timeoutMs: 20 }), /mapSrc/);
});

await test("pushSceneToFoundry: an unknown sceneId throws the same clear error getScene already does", async () => {
  const WORLD = "push-unknown-scene-world";
  await assert.rejects(
    () => pushSceneToFoundry(dataDir, WORLD, "scene_does_not_exist", { mapSrc: "scenes/x.webp" }, { pollMs: 5, timeoutMs: 20 }),
    /No scene found/
  );
});

await test("pushSceneToFoundry: builds a create_scene op matching the contract fixture's shape (opId/kind/data.background.src), and forwards width/height", async () => {
  const WORLD = "push-op-shape-world";
  const scene = createScene(WORLD, { objectiveNote: "Ambush prep" }, { now: "2026-08-06T00:00:00.000Z" });

  const result = await pushSceneToFoundry(
    dataDir,
    WORLD,
    scene.id,
    { mapSrc: "scenes/ashwood-ambush-site.webp", name: "Ashwood Ambush Site", width: 3000, height: 2000 },
    { pollMs: 5, timeoutMs: 20, makeOpId: () => sampleOp.opId }
  );
  assert.equal(result.status, "queued"); // no watcher armed in this test

  const onDiskOps = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"));
  assert.equal(onDiskOps.length, 1);
  const op = onDiskOps[0];
  assert.equal(op.opId, sampleOp.opId);
  assert.equal(op.kind, "create_scene");
  assert.deepEqual(op.data, {
    name: "Ashwood Ambush Site",
    background: { src: "scenes/ashwood-ambush-site.webp" },
    width: 3000,
    height: 2000
  });
  // Shape parity with the 32.0 fixture (same keys, same nesting).
  assert.deepEqual(Object.keys(op).sort(), Object.keys(sampleOp).sort());
  assert.deepEqual(Object.keys(op.data.background).sort(), Object.keys(sampleOp.data.background).sort());
});

await test("pushSceneToFoundry: falls back to the scene's own resolved display name when no explicit `name` is given (no locationEntityId/name -> objectiveNote)", async () => {
  const WORLD = "push-name-fallback-world";
  const scene = createScene(WORLD, { objectiveNote: "The old mill at dusk" });

  await pushSceneToFoundry(dataDir, WORLD, scene.id, { mapSrc: "scenes/mill.webp" }, { pollMs: 5, timeoutMs: 20 });
  const onDiskOps = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"));
  assert.equal(onDiskOps[0].data.name, "The old mill at dusk");
});

await test("pushSceneToFoundry: ok:true applied result writes foundryUuid onto the scene's foundrySceneRef", async () => {
  const WORLD = "push-applied-ok-world";
  const scene = createScene(WORLD, { objectiveNote: "Ambush site" });
  assert.equal(scene.foundrySceneRef, null, "sanity: starts null");

  const opId = "op_push_applied_ok";
  armFakeWatcher(WORLD, { opId, ok: true, foundryUuid: "Scene.abc123" });

  const result = await pushSceneToFoundry(
    dataDir,
    WORLD,
    scene.id,
    { mapSrc: "scenes/ambush.webp" },
    { pollMs: 10, timeoutMs: 500, makeOpId: () => opId }
  );

  assert.equal(result.status, "applied");
  assert.equal(result.ok, true);
  assert.equal(result.foundryUuid, "Scene.abc123");
  assert.equal(result.scene.foundrySceneRef, "Scene.abc123");

  // (e) foundrySceneRef round-trips via getScene -- a completely fresh read, not just the return value.
  const reread = getScene(WORLD, scene.id);
  assert.equal(reread.foundrySceneRef, "Scene.abc123");
});

await test("pushSceneToFoundry: ok:false applied result leaves foundrySceneRef null, surfaces the error", async () => {
  const WORLD = "push-applied-fail-world";
  const scene = createScene(WORLD, { objectiveNote: "Doomed push" });
  const opId = "op_push_applied_fail";
  armFakeWatcher(WORLD, { opId, ok: false, error: "Scene.create threw: permission denied" });

  const result = await pushSceneToFoundry(
    dataDir,
    WORLD,
    scene.id,
    { mapSrc: "scenes/doomed.webp" },
    { pollMs: 10, timeoutMs: 500, makeOpId: () => opId }
  );

  assert.equal(result.status, "applied");
  assert.equal(result.ok, false);
  assert.match(result.error, /permission denied/);

  const reread = getScene(WORLD, scene.id);
  assert.equal(reread.foundrySceneRef, null, "a failed op must never write a ref");
});

await test("pushSceneToFoundry: queued (no live Foundry client) leaves foundrySceneRef null", async () => {
  const WORLD = "push-queued-world";
  const scene = createScene(WORLD, { objectiveNote: "Nobody home" });

  const result = await pushSceneToFoundry(dataDir, WORLD, scene.id, { mapSrc: "scenes/x.webp" }, { pollMs: 10, timeoutMs: 40 });

  assert.equal(result.status, "queued");
  assert.equal(result.sceneId, scene.id);
  assert.ok(typeof result.opId === "string");

  const reread = getScene(WORLD, scene.id);
  assert.equal(reread.foundrySceneRef, null);
});

// ===========================================================================
// Phase 36 task 36.2 -- the quiet-push flush engine (clusterTokenPositions /
// isSceneDirty / composeSceneOps / flushDirtyStagedScenes).
// ===========================================================================

await test("clusterTokenPositions: count=1 lands exactly at center", () => {
  const positions = clusterTokenPositions(1, { center: { x: 2000, y: 1500 }, gridSize: 100 });
  assert.deepEqual(positions, [{ x: 2000, y: 1500 }]);
});

await test("clusterTokenPositions: count=4 -- a centered 2x2 grid, one gridSize apart, deterministic order", () => {
  const positions = clusterTokenPositions(4, { center: { x: 2000, y: 1500 }, gridSize: 100 });
  assert.deepEqual(positions, [
    { x: 1950, y: 1450 }, { x: 2050, y: 1450 },
    { x: 1950, y: 1550 }, { x: 2050, y: 1550 }
  ]);
});

await test("clusterTokenPositions: defaults to DEFAULT_CANVAS/DEFAULT_GRID_SIZE when opts omitted", () => {
  const positions = clusterTokenPositions(1);
  assert.deepEqual(positions, [{ x: DEFAULT_CANVAS.width / 2, y: DEFAULT_CANVAS.height / 2 }]);
  void DEFAULT_GRID_SIZE;
});

await test("isSceneDirty: never-pushed staged scene (lastPushedAt:null) is ALWAYS dirty regardless of updatedAt age", () => {
  assert.equal(isSceneDirty({ stagedForFoundry: true, lastPushedAt: null, updatedAt: "2000-01-01T00:00:00.000Z" }), true);
});

await test("isSceneDirty: a previously-pushed scene is dirty only if touched again since", () => {
  assert.equal(isSceneDirty({ stagedForFoundry: true, lastPushedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }), false, "same instant -- not dirty");
  assert.equal(isSceneDirty({ stagedForFoundry: true, lastPushedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" }), true, "touched again after the push -- dirty");
});

await test("isSceneDirty: an unstaged scene is never dirty, no matter its updatedAt/lastPushedAt", () => {
  assert.equal(isSceneDirty({ stagedForFoundry: false, lastPushedAt: null, updatedAt: "2026-01-01T00:00:00.000Z" }), false);
});

// --- composeSceneOps ---------------------------------------------------

await test("composeSceneOps: CREATE path -- map asset resolved via foundryRef.imagePath, tokens clustered, roster order creatures-then-heroes", () => {
  const WORLD = "compose-create-world";
  const scene = createScene(WORLD, { objectiveNote: "Ambush prep" }, { makeId: () => "compose-scene-1" });
  const ogrekin = acceptBestiaryEntry(saveBestiaryEntry({ rawFields: { name: "Ogrekin", hp: 10, ac: 12 }, foundryActorRef: "Actor.ogrekin" }).id);
  const kestrel = savePartyMember(WORLD, {
    name: "Kestrel", combatRelevant: { class: "Ranger", level: 5, ac: 15, hp: 40, attackBonus: 5, saveDCs: {} },
    buildRelevant: {}, foundryActorRef: "Actor.kestrel", status: "accepted"
  });
  const map = acceptStagecraftAsset(WORLD, saveStagecraftAsset(WORLD, { kind: "map", name: "Ferry Landing", source: "foundry", foundryRef: { imagePath: "scenes/ferry.webp" }, status: "proposed" }).id);

  addToSceneTray(WORLD, scene.id, { id: ogrekin.id, kind: "creature" });
  addToSceneTray(WORLD, scene.id, { id: ogrekin.id, kind: "creature" }); // stacks to n:2
  addToSceneTray(WORLD, scene.id, { id: kestrel.id, kind: "hero" });
  addToSceneTray(WORLD, scene.id, { id: map.id, kind: "asset" });

  const { sceneOp, tokenOps, journalOp, skipped } = composeSceneOps(dataDir, WORLD, getScene(WORLD, scene.id));
  assert.equal(sceneOp.kind, "create_scene");
  // 36.3 live-smoke fix: create-path tokens are INLINE in create_scene.data
  // (the opId-correlation scheme for standalone create_token ops failed
  // against the real module -- see phase36-fixture.mjs's ADDENDUM).
  const expectedPositions = clusterTokenPositions(3, { center: { x: DEFAULT_CANVAS.width / 2, y: DEFAULT_CANVAS.height / 2 } });
  assert.deepEqual(sceneOp.data, {
    name: "Ambush prep",
    background: { src: "scenes/ferry.webp" },
    tokens: [
      { actorUuid: "Actor.ogrekin", ...expectedPositions[0] },
      { actorUuid: "Actor.ogrekin", ...expectedPositions[1] },
      { actorUuid: "Actor.kestrel", ...expectedPositions[2] }
    ]
  });
  assert.deepEqual(tokenOps, [], "no standalone create_token ops on the create path (36.3 fix)");
  assert.equal(journalOp, null, "no splash asset in this roster");
  assert.deepEqual(skipped, []);
});

await test("composeSceneOps: UPDATE path (foundrySceneRef already set) -- scene patch ONLY, no token/journal ops even with an eligible roster (§5's pinned limitation)", () => {
  const WORLD = "compose-update-world";
  const scene = createScene(WORLD, { objectiveNote: "Already live" }, { makeId: () => "compose-scene-update-1" });
  updateScene(WORLD, scene.id, { foundrySceneRef: "Scene.alreadyPushed" });
  const ogrekin = acceptBestiaryEntry(saveBestiaryEntry({ rawFields: { name: "Ogrekin2" }, foundryActorRef: "Actor.ogrekin2" }).id);
  addToSceneTray(WORLD, scene.id, { id: ogrekin.id, kind: "creature" });

  const { sceneOp, tokenOps, journalOp } = composeSceneOps(dataDir, WORLD, getScene(WORLD, scene.id));
  assert.equal(sceneOp.kind, "update_scene");
  assert.deepEqual(sceneOp.data, { sceneUuid: "Scene.alreadyPushed", patch: { name: "Already live" } });
  assert.deepEqual(tokenOps, [], "update-path never re-emits token ops");
  assert.equal(journalOp, null);
});

await test("composeSceneOps: a SECOND accepted map asset is skipped with 'only one map per scene push, first-pass'", () => {
  const WORLD = "compose-multimap-world";
  const scene = createScene(WORLD, {}, { makeId: () => "compose-scene-multimap" });
  const map1 = acceptStagecraftAsset(WORLD, saveStagecraftAsset(WORLD, { kind: "map", name: "Map One", source: "foundry", foundryRef: { imagePath: "scenes/one.webp" }, status: "proposed" }).id);
  const map2 = acceptStagecraftAsset(WORLD, saveStagecraftAsset(WORLD, { kind: "map", name: "Map Two", source: "foundry", foundryRef: { imagePath: "scenes/two.webp" }, status: "proposed" }).id);
  addToSceneTray(WORLD, scene.id, { id: map1.id, kind: "asset" });
  addToSceneTray(WORLD, scene.id, { id: map2.id, kind: "asset" });

  const { sceneOp, skipped } = composeSceneOps(dataDir, WORLD, getScene(WORLD, scene.id));
  assert.equal(sceneOp.data.background.src, "scenes/one.webp", "first accepted map wins, roster order");
  assert.ok(skipped.some((s) => s.reason.includes("only one map per scene push, first-pass")), `expected the pinned skip reason -- got ${JSON.stringify(skipped)}`);
});

await test("composeSceneOps: an ineligible roster row (not accepted / no foundryActorRef) is skipped with a recorded reason, not silently dropped", () => {
  const WORLD = "compose-ineligible-world";
  const scene = createScene(WORLD, {}, { makeId: () => "compose-scene-ineligible" });
  const noRef = saveBestiaryEntry({ rawFields: { name: "No Foundry Link" } }); // never accepted, no foundryActorRef
  addToSceneTray(WORLD, scene.id, { id: noRef.id, kind: "creature" });

  const { tokenOps, skipped } = composeSceneOps(dataDir, WORLD, getScene(WORLD, scene.id));
  assert.deepEqual(tokenOps, []);
  assert.ok(skipped.some((s) => s.reason.includes("not eligible for token push")), `expected an eligibility skip reason -- got ${JSON.stringify(skipped)}`);
});

await test("composeSceneOps: an asset with NEITHER foundryRef.imagePath NOR a local file is skipped with 'no image source available'", () => {
  const WORLD = "compose-no-src-world";
  const scene = createScene(WORLD, {}, { makeId: () => "compose-scene-no-src" });
  const bareAsset = acceptStagecraftAsset(WORLD, saveStagecraftAsset(WORLD, { kind: "map", name: "No Source", source: "local", status: "proposed" }).id);
  addToSceneTray(WORLD, scene.id, { id: bareAsset.id, kind: "asset" });

  const { sceneOp, skipped } = composeSceneOps(dataDir, WORLD, getScene(WORLD, scene.id));
  assert.ok(!("background" in sceneOp.data), "no usable src -- background omitted entirely");
  assert.ok(skipped.some((s) => s.reason.includes("no image source available")), `expected the no-src skip reason -- got ${JSON.stringify(skipped)}`);
});

await test("composeSceneOps: local-copy resolution -- source:'local' + localFilePath copies the file into <dataDir>/worlds/<world>/scenes-from-gmtools/, src becomes the Foundry-relative path", () => {
  const WORLD = "compose-local-copy-world";
  const scene = createScene(WORLD, {}, { makeId: () => "compose-scene-local-copy" });
  mkdirSync(localFilesDir, { recursive: true });
  const localPath = join(localFilesDir, "hand-drawn-map.webp");
  writeFileSync(localPath, "fake-image-bytes", "utf8");

  const asset = acceptStagecraftAsset(WORLD, saveStagecraftAsset(WORLD, { kind: "map", name: "Hand-Drawn", source: "local", status: "proposed" }).id);
  // localFilePath has no dedicated store setter yet this phase (per stagecraft-store.mjs's own header) -- direct patch, same class of exception the phase36 fixture's own seedRosterMapOrSplashAsset uses.
  const assets = JSON.parse(readFileSync(join(stagecraftRoot(), `${WORLD}.json`), "utf8"));
  assets.find((a) => a.id === asset.id).localFilePath = localPath;
  writeFileSync(join(stagecraftRoot(), `${WORLD}.json`), JSON.stringify(assets), "utf8");
  addToSceneTray(WORLD, scene.id, { id: asset.id, kind: "asset" });

  const { sceneOp } = composeSceneOps(dataDir, WORLD, getScene(WORLD, scene.id));
  assert.equal(sceneOp.data.background.src, `worlds/${WORLD}/scenes-from-gmtools/hand-drawn-map.webp`);
  const copiedPath = join(dataDir, "worlds", WORLD, "scenes-from-gmtools", "hand-drawn-map.webp");
  assert.equal(readFileSync(copiedPath, "utf8"), "fake-image-bytes", "the file must have genuinely been copied, not just referenced");
});

// --- flushDirtyStagedScenes ---------------------------------------------

await test("flushDirtyStagedScenes: no dirty staged scenes -- {flushed:0, results:[], skipped:[]}, no ops file written", async () => {
  const WORLD = "flush-nothing-dirty-world";
  createScene(WORLD, { objectiveNote: "Never staged" });
  const result = await flushDirtyStagedScenes(dataDir, WORLD, { pollMs: 5, timeoutMs: 20 });
  assert.deepEqual(result, { flushed: 0, results: [], skipped: [], reconciled: 0 });
});

await test("flushDirtyStagedScenes: applied ok:true -> markScenePushed lands (foundrySceneRef + lastPushedAt), scene no longer dirty on the NEXT flush", async () => {
  const WORLD = "flush-applied-ok-world";
  const scene = createScene(WORLD, { objectiveNote: "Ready to run" });
  updateScene(WORLD, scene.id, { stagedForFoundry: true });
  const opId = "op_flush_applied_ok";

  armFakeWatcher(WORLD, { opId, ok: true, foundryUuid: "Scene.flushOk1" });
  const result = await flushDirtyStagedScenes(dataDir, WORLD, { pollMs: 10, timeoutMs: 500, makeOpId: () => opId });

  assert.equal(result.flushed, 1);
  assert.equal(result.results.length, 1);
  const reread = getScene(WORLD, scene.id);
  assert.equal(reread.foundrySceneRef, "Scene.flushOk1");
  assert.ok(reread.lastPushedAt, "lastPushedAt must be stamped");

  // A second flush call finds NOTHING dirty (the scene hasn't been touched since).
  const second = await flushDirtyStagedScenes(dataDir, WORLD, { pollMs: 5, timeoutMs: 20 });
  assert.deepEqual(second, { flushed: 0, results: [], skipped: [], reconciled: 0 });
});

await test("flushDirtyStagedScenes: applied ok:false -> scene stays dirty (untouched), retried next cycle", async () => {
  const WORLD = "flush-applied-fail-world";
  const scene = createScene(WORLD, { objectiveNote: "Doomed" });
  updateScene(WORLD, scene.id, { stagedForFoundry: true });
  const opId = "op_flush_applied_fail";

  armFakeWatcher(WORLD, { opId, ok: false, error: "Scene.create threw" });
  const result = await flushDirtyStagedScenes(dataDir, WORLD, { pollMs: 10, timeoutMs: 500, makeOpId: () => opId });

  assert.equal(result.flushed, 1, "the op WAS composed+written this cycle, even though it came back ok:false");
  const reread = getScene(WORLD, scene.id);
  assert.equal(reread.foundrySceneRef, null);
  assert.equal(reread.lastPushedAt, null, "a failed push must never mark the scene pushed -- stays dirty");
});

await test("flushDirtyStagedScenes: 409 in-flight -> {flushed:0, queued:true}, nothing marked pushed, the stuck ops file is left untouched", async () => {
  const WORLD = "flush-409-world";
  const scene = createScene(WORLD, { objectiveNote: "Blocked" });
  updateScene(WORLD, scene.id, { stagedForFoundry: true });

  const opsPath = foundryOpsPath(dataDir, WORLD);
  mkdirSync(dirname(opsPath), { recursive: true });
  const stuckBatch = [{ opId: "op_stuck", kind: "create_scene", data: { name: "stuck" } }];
  writeFileSync(opsPath, JSON.stringify(stuckBatch), "utf8");

  const result = await flushDirtyStagedScenes(dataDir, WORLD, { pollMs: 5, timeoutMs: 20 });
  assert.equal(result.flushed, 0);
  assert.equal(result.queued, true);
  assert.deepEqual(result.results, []);
  assert.deepEqual(JSON.parse(readFileSync(opsPath, "utf8")), stuckBatch, "the in-flight batch must never be clobbered");

  const reread = getScene(WORLD, scene.id);
  assert.equal(reread.lastPushedAt, null, "still dirty -- untouched by the blocked attempt");
});

await test("flushDirtyStagedScenes: one flush cycle batches EVERY dirty staged scene into ONE ops-channel write, most-recently-touched first", async () => {
  const WORLD = "flush-multi-scene-world";
  const older = createScene(WORLD, { objectiveNote: "Older" }, { now: "2026-08-01T09:00:00.000Z" });
  updateScene(WORLD, older.id, { stagedForFoundry: true }, { now: "2026-08-01T09:00:00.000Z" });
  const newer = createScene(WORLD, { objectiveNote: "Newer" }, { now: "2026-08-01T09:10:00.000Z" });
  updateScene(WORLD, newer.id, { stagedForFoundry: true }, { now: "2026-08-01T09:10:00.000Z" });

  const result = await flushDirtyStagedScenes(dataDir, WORLD, { pollMs: 5, timeoutMs: 20 });
  assert.equal(result.flushed, 2);
  const ops = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"));
  const names = ops.filter((o) => o.kind === "create_scene").map((o) => o.data.name);
  assert.deepEqual(names, ["Newer", "Older"], "listScenesByRecency order -- most-recently-touched first");
});

// --- pending-push ledger + reconcile (36.3 live-smoke fix) ----------------

await test("flushDirtyStagedScenes: queued-after-write records the pendingPush ledger entry (opId + compose-time snapshot), and the NEXT cycle EXCLUDES the pending scene (no duplicate create)", async () => {
  const WORLD = "flush-pending-record-world";
  const scene = createScene(WORLD, { objectiveNote: "Slow watcher" });
  updateScene(WORLD, scene.id, { stagedForFoundry: true });
  const opId = "op_pending_record";

  // No fake watcher -- the poll window closes with the ops written but unapplied.
  const result = await flushDirtyStagedScenes(dataDir, WORLD, { pollMs: 5, timeoutMs: 20, makeOpId: () => opId });
  assert.equal(result.flushed, 1);
  assert.equal(result.queued, true);
  const reread = getScene(WORLD, scene.id);
  assert.deepEqual(reread.pendingPush, { opId, snapshotUpdatedAt: reread.updatedAt }, "queued-after-write must record the ledger entry with the compose-time updatedAt snapshot");
  assert.equal(reread.lastPushedAt, null, "not marked pushed yet -- the result hasn't arrived");

  // Next cycle: ops file still stuck (409 path), but the CRITICAL assertion
  // is the pending scene is excluded -- flushed stays 0 even though the
  // scene's dirty predicate alone would match.
  const second = await flushDirtyStagedScenes(dataDir, WORLD, { pollMs: 5, timeoutMs: 20 });
  assert.equal(second.flushed, 0, "a pending scene must never be recomposed -- that is exactly the duplicate-create bug the live smoke caught");
});

await test("reconcile: a LATE ok:true result is consumed on the next flush -- markScenePushed (foundryUuid + LEDGER snapshot), ledger cleared, consumed entry removed from the results file", async () => {
  const WORLD = "flush-reconcile-ok-world";
  const scene = createScene(WORLD, { objectiveNote: "Late apply" });
  updateScene(WORLD, scene.id, { stagedForFoundry: true });
  const opId = "op_reconcile_ok";

  const first = await flushDirtyStagedScenes(dataDir, WORLD, { pollMs: 5, timeoutMs: 20, makeOpId: () => opId });
  assert.equal(first.queued, true);
  const snapshot = getScene(WORLD, scene.id).pendingPush.snapshotUpdatedAt;

  // The watcher applies LATE: results land, ops clear -- after the poll window.
  seedFile(foundryResultsPath(dataDir, WORLD), [
    { opId, ok: true, foundryUuid: "Scene.lateApplied1" },
    { opId: "op_someone_elses", ok: true, foundryUuid: "Scene.other" }
  ]);
  writeFileSync(foundryOpsPath(dataDir, WORLD), "[]", "utf8");

  const second = await flushDirtyStagedScenes(dataDir, WORLD, { pollMs: 5, timeoutMs: 20 });
  assert.equal(second.reconciled, 1, "the late result must be reconciled");
  const reread = getScene(WORLD, scene.id);
  assert.equal(reread.foundrySceneRef, "Scene.lateApplied1");
  assert.equal(reread.lastPushedAt, snapshot, "lastPushedAt must be the LEDGER's compose-time snapshot, not reconcile-time now");
  assert.equal(reread.pendingPush, null, "ledger entry cleared");
  const remaining = JSON.parse(readFileSync(foundryResultsPath(dataDir, WORLD), "utf8"));
  assert.deepEqual(remaining, [{ opId: "op_someone_elses", ok: true, foundryUuid: "Scene.other" }], "only the CONSUMED entry is removed -- unknown entries stay for their own poller");
  // And with nothing else dirty, nothing is recomposed.
  assert.equal(second.flushed, 0);
});

await test("reconcile: a LATE ok:false result clears the ledger WITHOUT marking pushed -- the scene is dirty again and safely re-composable", async () => {
  const WORLD = "flush-reconcile-fail-world";
  const scene = createScene(WORLD, { objectiveNote: "Late failure" });
  updateScene(WORLD, scene.id, { stagedForFoundry: true });
  const opId = "op_reconcile_fail";

  const first = await flushDirtyStagedScenes(dataDir, WORLD, { pollMs: 5, timeoutMs: 20, makeOpId: () => opId });
  assert.equal(first.queued, true);

  seedFile(foundryResultsPath(dataDir, WORLD), [{ opId, ok: false, error: "Scene.create threw late" }]);
  writeFileSync(foundryOpsPath(dataDir, WORLD), "[]", "utf8");

  const second = await flushDirtyStagedScenes(dataDir, WORLD, { pollMs: 5, timeoutMs: 20, makeOpId: () => "op_reconcile_fail_retry" });
  assert.equal(second.reconciled, 1);
  const reread = getScene(WORLD, scene.id);
  assert.equal(reread.foundrySceneRef, null, "a failed create must never set foundrySceneRef");
  assert.equal(reread.lastPushedAt, null);
  // The SAME cycle recomposes it (dirty again, no longer pending): a fresh
  // create was written -- and since this test arms no watcher, THAT write is
  // itself queued-after-write, correctly recording a NEW ledger entry for
  // the retry op (the old failed entry is gone).
  assert.equal(second.flushed, 1, "after clearing a failed pending entry the scene is immediately re-composable");
  assert.equal(reread.pendingPush?.opId, "op_reconcile_fail_retry", "the retry write records its own fresh ledger entry");
});

await test("composeSceneOps: create-path roster tokens are INLINE in create_scene.data.tokens (no standalone create_token ops) -- the live-smoke correlation fix", async () => {
  const WORLD = "compose-inline-tokens-world";
  const scene = createScene(WORLD, { objectiveNote: "Inline tokens" });
  const entry = acceptBestiaryEntry(saveBestiaryEntry({ rawFields: { name: "Inline Ogrekin" }, foundryActorRef: "Actor.inlineOgrekin" }).id);
  addToSceneTray(WORLD, scene.id, { id: entry.id, kind: "creature" });
  addToSceneTray(WORLD, scene.id, { id: entry.id, kind: "creature" }); // stack to n:2

  const { sceneOp, tokenOps } = composeSceneOps(dataDir, WORLD, getScene(WORLD, scene.id));
  assert.equal(sceneOp.kind, "create_scene");
  const expected = clusterTokenPositions(2, { center: { x: DEFAULT_CANVAS.width / 2, y: DEFAULT_CANVAS.height / 2 } });
  assert.deepEqual(sceneOp.data.tokens, [
    { actorUuid: "Actor.inlineOgrekin", ...expected[0] },
    { actorUuid: "Actor.inlineOgrekin", ...expected[1] }
  ]);
  assert.deepEqual(tokenOps, [], "standalone create_token ops must not be composed on the create path");
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
