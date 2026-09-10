import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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
  clusterTokenPositions, DEFAULT_CANVAS, DEFAULT_GRID_SIZE,
  DEFAULT_FLUSH_POLL_MS, DEFAULT_FLUSH_TIMEOUT_MS,
  syncFoundryToPlans
} = await import("../lib/foundry-push-ops.mjs");
const { foundryOpsPath, foundryResultsPath } = await import("../lib/snapshot.mjs");
const { createScene, getScene, updateScene, markScenePushed } = await import("../../session-planner/scenes.mjs");
const { createPlan, addSceneToPlan } = await import("../../session-planner/plans.mjs");
const { addToSceneTray } = await import("../../session-planner/scene-tray.mjs");
const { saveStagecraftAsset, acceptStagecraftAsset, stagecraftRoot } = await import("../../session-planner/stagecraft-store.mjs");
const { saveBestiaryEntry, acceptBestiaryEntry, retireBestiaryEntry, setBestiaryTokenImg, setBestiaryTokenImgCandidate } = await import("../../combat-planning/bestiary-store.mjs");
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

// QA W2 fix (Group B #10): a scene anchored to a place that no longer
// resolves (deleted, or no live snapshot at all for the world) used to push
// the raw wf_ id as the Foundry scene's name -- never a good display string.
await test("pushSceneToFoundry: a locationEntityId that misses the live-snapshot lookup falls back to \"(place removed)\", never the raw id", async () => {
  const WORLD = "push-dangling-place-world";
  // No bootstrapSnapshot/entity for this world at all -- loadSnapshot throws,
  // exercising the SAME guard as a genuinely deleted place.
  const scene = createScene(WORLD, { locationEntityId: "wf_deleted_place_1" });

  await pushSceneToFoundry(dataDir, WORLD, scene.id, { mapSrc: "scenes/dangling.webp" }, { pollMs: 5, timeoutMs: 20 });
  const onDiskOps = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"));
  assert.equal(onDiskOps[0].data.name, "(place removed)");
  assert.doesNotMatch(onDiskOps[0].data.name, /wf_/, "must never leak the raw entity id");
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

// 2026-09-09 regression: this path composed an unconditional `create_scene`,
// so a second push of an already-pushed scene DUPLICATED it in Foundry and
// repointed foundrySceneRef at the bare copy. Hit for real on the live
// `aureus` world (11 duplicate scenes). A scene with a ref must UPDATE.
await test("pushSceneToFoundry: a scene that already has a foundrySceneRef composes update_scene against it -- never a second create_scene", async () => {
  const WORLD = "push-existing-ref-world";
  const scene = createScene(WORLD, { objectiveNote: "Already in Foundry" });
  markScenePushed(WORLD, scene.id, { foundrySceneRef: "Scene.alreadyThere", lastPushedAt: null });

  const opId = "op_push_existing_ref";
  await pushSceneToFoundry(
    dataDir,
    WORLD,
    scene.id,
    { mapSrc: "scenes/again.webp", name: "Second push", width: 1200, height: 900 },
    { pollMs: 5, timeoutMs: 20, makeOpId: () => opId }
  );

  const [op] = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"));
  assert.equal(op.kind, "update_scene", "an already-pushed scene must be updated, not re-created");
  assert.equal(op.data.sceneUuid, "Scene.alreadyThere", "the update must target the existing Foundry scene");
  assert.deepEqual(op.data.patch, {
    name: "Second push",
    background: { src: "scenes/again.webp" },
    width: 1200,
    height: 900
  }, "the same payload the create path would have carried, nested under `patch`");
  assert.equal(op.data.name, undefined, "update_scene carries its payload in `patch`, never at the top level");
});

await test("pushSceneToFoundry: an applied update keeps the existing ref (the module's identity round-trip), and never nulls it", async () => {
  const WORLD = "push-existing-ref-applied-world";
  const scene = createScene(WORLD, { objectiveNote: "Update me" });
  markScenePushed(WORLD, scene.id, { foundrySceneRef: "Scene.keepMe", lastPushedAt: null });

  const opId = "op_push_existing_ref_applied";
  // The module answers an update with the SAME uuid it was given.
  armFakeWatcher(WORLD, { opId, ok: true, foundryUuid: "Scene.keepMe" });

  const result = await pushSceneToFoundry(
    dataDir, WORLD, scene.id, { mapSrc: "scenes/update.webp" },
    { pollMs: 10, timeoutMs: 500, makeOpId: () => opId }
  );

  assert.equal(result.ok, true);
  assert.equal(result.foundryUuid, "Scene.keepMe");
  assert.equal(getScene(WORLD, scene.id).foundrySceneRef, "Scene.keepMe", "the ref must survive an update push unchanged");
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
// Friction Wave 1 W3c -- push-scene defaults mapSrc from the scene's linked
// map asset (scene.mapAssetId -> asset.src, else foundryRef.imagePath);
// explicit mapSrc still overrides; clear error when neither resolves.
// ===========================================================================

await test("W3c: no explicit mapSrc -- defaults from the linked map asset's src (the op's background.src is the asset's path)", async () => {
  const WORLD = "push-default-src-world";
  const asset = saveStagecraftAsset(WORLD, { kind: "map", name: "Lowway Alleys", src: "worlds/kilmarn/maps/lowway.webp" }, { makeId: () => "sc-w3c-1" });
  const scene = createScene(WORLD, { objectiveNote: "Alley chase", mapAssetId: asset.id });

  const result = await pushSceneToFoundry(dataDir, WORLD, scene.id, {}, { pollMs: 5, timeoutMs: 20 });
  assert.equal(result.status, "queued"); // no watcher -- we only care about the composed op
  const ops = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"));
  assert.deepEqual(ops[0].data.background, { src: "worlds/kilmarn/maps/lowway.webp" });
});

await test("W3c: a linked asset with NO src but a foundryRef.imagePath (a pulled Foundry map) defaults from the imagePath", async () => {
  const WORLD = "push-default-imagepath-world";
  const asset = saveStagecraftAsset(
    WORLD,
    { kind: "map", name: "Ferry Landing", source: "foundry", foundryRef: { sceneUuid: "Scene.ferry", imagePath: "scenes/ferry.webp" } },
    { makeId: () => "sc-w3c-2" }
  );
  const scene = createScene(WORLD, { objectiveNote: "Ferry ambush", mapAssetId: asset.id });

  await pushSceneToFoundry(dataDir, WORLD, scene.id, {}, { pollMs: 5, timeoutMs: 20 });
  const ops = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"));
  assert.deepEqual(ops[0].data.background, { src: "scenes/ferry.webp" });
});

await test("W3c: an EXPLICIT mapSrc still overrides the linked asset unconditionally", async () => {
  const WORLD = "push-override-world";
  const asset = saveStagecraftAsset(WORLD, { kind: "map", name: "Default Map", src: "worlds/x/maps/default.webp" }, { makeId: () => "sc-w3c-3" });
  const scene = createScene(WORLD, { objectiveNote: "Override push", mapAssetId: asset.id });

  await pushSceneToFoundry(dataDir, WORLD, scene.id, { mapSrc: "scenes/explicit-override.webp" }, { pollMs: 5, timeoutMs: 20 });
  const ops = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"));
  assert.deepEqual(ops[0].data.background, { src: "scenes/explicit-override.webp" });
});

await test("W3c: linked asset with NEITHER src nor imagePath -> clear error naming the asset and both fixes (set the path / pass mapSrc); nothing written", async () => {
  const WORLD = "push-no-source-asset-world";
  const asset = saveStagecraftAsset(WORLD, { kind: "map", name: "Pathless Map" }, { makeId: () => "sc-w3c-4" });
  const scene = createScene(WORLD, { objectiveNote: "Doomed default", mapAssetId: asset.id });

  await assert.rejects(
    () => pushSceneToFoundry(dataDir, WORLD, scene.id, {}, { pollMs: 5, timeoutMs: 20 }),
    (err) => /mapSrc/.test(err.message) && /sc-w3c-4/.test(err.message) && /no\s+resolvable source/i.test(err.message)
  );
  const { existsSync: fsExists } = await import("node:fs");
  assert.ok(!fsExists(foundryOpsPath(dataDir, WORLD)), "no op may be composed without a real map source");
});

await test("W3c: a DANGLING mapAssetId (asset deleted out from under the scene) falls through to the same clear error, not a store-level not-found", async () => {
  const WORLD = "push-dangling-asset-world";
  const scene = createScene(WORLD, { objectiveNote: "Dangling link", mapAssetId: "sc-deleted-long-ago" });

  await assert.rejects(
    () => pushSceneToFoundry(dataDir, WORLD, scene.id, {}, { pollMs: 5, timeoutMs: 20 }),
    (err) => /mapSrc/.test(err.message) && /sc-deleted-long-ago/.test(err.message)
  );
});

await test("W3c: the ORIGINAL no-mapSrc-no-link error still names mapSrc and now also points at linking a map asset", async () => {
  const WORLD = "push-neither-world";
  const scene = createScene(WORLD, { objectiveNote: "Nothing to push with" });
  await assert.rejects(
    () => pushSceneToFoundry(dataDir, WORLD, scene.id, {}, { pollMs: 5, timeoutMs: 20 }),
    (err) => /mapSrc/.test(err.message) && /link a map asset/i.test(err.message)
  );
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

// Table round 2026-09-09 (WS-E): one music track per scene.
await test("composeSceneOps: a linked music asset emits playlist (uuid) + playlistSound (track id, else name) on BOTH the create and the update path", () => {
  const WORLD = "compose-music-world";
  const byId = acceptStagecraftAsset(WORLD, saveStagecraftAsset(WORLD, { kind: "music", name: "Casbah market", source: "foundry", foundryRef: { playlistUuid: "Playlist.amb", playlistName: "Ambience", trackName: "Casbah market", trackId: "sndCasbah" }, status: "proposed" }).id);
  const byName = acceptStagecraftAsset(WORLD, saveStagecraftAsset(WORLD, { kind: "music", name: "Teahouse", source: "foundry", foundryRef: { playlistUuid: "Playlist.amb", playlistName: "Ambience", trackName: "Teahouse" }, status: "proposed" }).id);

  const fresh = createScene(WORLD, { objectiveNote: "Souk at noon", musicAssetId: byId.id }, { makeId: () => "compose-music-create" });
  const created = composeSceneOps(dataDir, WORLD, getScene(WORLD, fresh.id));
  assert.equal(created.sceneOp.kind, "create_scene");
  assert.equal(created.sceneOp.data.playlist, "Playlist.amb");
  assert.equal(created.sceneOp.data.playlistSound, "sndCasbah", "the track id wins when the pull carried one");
  assert.deepEqual(created.skipped, []);

  const live = createScene(WORLD, { objectiveNote: "Teahouse at dusk", musicAssetId: byName.id }, { makeId: () => "compose-music-update" });
  updateScene(WORLD, live.id, { foundrySceneRef: "Scene.teahouseLive" });
  const updated = composeSceneOps(dataDir, WORLD, getScene(WORLD, live.id));
  assert.equal(updated.sceneOp.kind, "update_scene");
  assert.deepEqual(updated.sceneOp.data, { sceneUuid: "Scene.teahouseLive", patch: { name: "Teahouse at dusk", playlist: "Playlist.amb", playlistSound: "Teahouse" } },
    "a scene already in Foundry gains its music through the patch -- no re-create; the name is the fallback address");
});

await test("composeSceneOps: an unlinked scene never emits playlist keys (Foundry's own music stays untouched); a music link with no playlist ref, a discarded one, and a dangling id are each skipped with a reason and no playlist keys", () => {
  const WORLD = "compose-music-skip-world";
  const plain = createScene(WORLD, { objectiveNote: "Silent" }, { makeId: () => "compose-music-silent" });
  const silent = composeSceneOps(dataDir, WORLD, getScene(WORLD, plain.id));
  assert.equal("playlist" in silent.sceneOp.data, false);
  assert.equal("playlistSound" in silent.sceneOp.data, false);

  const local = saveStagecraftAsset(WORLD, { kind: "music", name: "Hand-added drone", source: "local" });
  const noRef = createScene(WORLD, { objectiveNote: "Local", musicAssetId: local.id }, { makeId: () => "compose-music-local" });
  const r1 = composeSceneOps(dataDir, WORLD, getScene(WORLD, noRef.id));
  assert.equal("playlist" in r1.sceneOp.data, false);
  assert.ok(r1.skipped.some((x) => x.id === local.id && /no Foundry playlist reference/.test(x.reason)), JSON.stringify(r1.skipped));

  const dangling = createScene(WORLD, { objectiveNote: "Gone", musicAssetId: "sca_nope" }, { makeId: () => "compose-music-dangling" });
  const r2 = composeSceneOps(dataDir, WORLD, getScene(WORLD, dangling.id));
  assert.ok(r2.skipped.some((x) => x.id === "sca_nope" && /not found/.test(x.reason)), JSON.stringify(r2.skipped));

  const map = saveStagecraftAsset(WORLD, { kind: "map", name: "Not music", source: "local" });
  const wrongKind = createScene(WORLD, { objectiveNote: "Wrong", musicAssetId: map.id }, { makeId: () => "compose-music-wrongkind" });
  const r3 = composeSceneOps(dataDir, WORLD, getScene(WORLD, wrongKind.id));
  assert.ok(r3.skipped.some((x) => x.id === map.id && /wrong kind or discarded/.test(x.reason)), JSON.stringify(r3.skipped));
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

await test("composeSceneOps: a RETIRED roster row (accepted, linked, then retired) is skipped with a 'retired' reason -- its Foundry ref never reaches a token op", () => {
  // Table round 2026-09-09 (WS-H): renaming a row "(retired)" used to leave
  // it droppable and pushable; a real status must take it out of play.
  const WORLD = "compose-retired-world";
  const scene = createScene(WORLD, {}, { makeId: () => "compose-scene-retired" });
  const retired = retireBestiaryEntry(acceptBestiaryEntry(saveBestiaryEntry({ rawFields: { name: "Retired Ogrekin" }, foundryActorRef: "Actor.retiredOgrekin" }).id).id);
  addToSceneTray(WORLD, scene.id, { id: retired.id, kind: "creature" });

  const { tokenOps, skipped } = composeSceneOps(dataDir, WORLD, getScene(WORLD, scene.id));
  assert.deepEqual(tokenOps, []);
  assert.ok(skipped.some((s) => /is retired/.test(s.reason) && s.reason.includes("Retired Ogrekin")), `expected a retired skip reason -- got ${JSON.stringify(skipped)}`);
});

await test("WS-F composeSceneOps: an ACCEPTED tokenImg rides on every create-path token as `img`; a candidate alone never does", () => {
  // Table round 2026-09-09 (WS-F): the bridge's buildTokenData honours
  // tokens[].img over the prototype texture -- so the create path carries
  // the face with no module change. A generated-but-unreviewed candidate is
  // invisible to the push.
  const WORLD = "compose-token-img-world";
  const scene = createScene(WORLD, {}, { makeId: () => "compose-scene-token-img" });
  const faced = acceptBestiaryEntry(saveBestiaryEntry({ rawFields: { name: "Faced Cultist" }, foundryActorRef: "Actor.faced" }).id);
  setBestiaryTokenImg(faced.id, "gm-tools/tokens/w/faced-cultist.webp");
  const candidateOnly = acceptBestiaryEntry(saveBestiaryEntry({ rawFields: { name: "Pending Cultist" }, foundryActorRef: "Actor.pending" }).id);
  setBestiaryTokenImgCandidate(candidateOnly.id, "gm-tools/tokens/w/pending-cultist.candidate.webp");
  addToSceneTray(WORLD, scene.id, { id: faced.id, kind: "creature" });
  addToSceneTray(WORLD, scene.id, { id: faced.id, kind: "creature" }); // n=2
  addToSceneTray(WORLD, scene.id, { id: candidateOnly.id, kind: "creature" });

  const { sceneOp } = composeSceneOps(dataDir, WORLD, getScene(WORLD, scene.id));
  assert.equal(sceneOp.kind, "create_scene");
  const tokens = sceneOp.data.tokens;
  assert.equal(tokens.length, 3);
  const facedTokens = tokens.filter((t) => t.actorUuid === "Actor.faced");
  assert.equal(facedTokens.length, 2);
  for (const t of facedTokens) assert.equal(t.img, "gm-tools/tokens/w/faced-cultist.webp");
  const pending = tokens.find((t) => t.actorUuid === "Actor.pending");
  assert.ok(pending && !("img" in pending), `candidate must not leak into the op -- got ${JSON.stringify(pending)}`);
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

await test("composeSceneOps (W3a/W3c): a roster map asset with ONLY a `src` (no foundryRef.imagePath, no localFilePath) resolves via src as-is -- the new middle tier", () => {
  const WORLD = "compose-src-tier-world";
  const scene = createScene(WORLD, {}, { makeId: () => "compose-scene-src-tier" });
  const asset = acceptStagecraftAsset(WORLD, saveStagecraftAsset(WORLD, { kind: "map", name: "Src Only", src: "worlds/kilmarn/maps/src-only.webp", status: "proposed" }).id);
  addToSceneTray(WORLD, scene.id, { id: asset.id, kind: "asset" });

  const { sceneOp, skipped } = composeSceneOps(dataDir, WORLD, getScene(WORLD, scene.id));
  assert.deepEqual(sceneOp.data.background, { src: "worlds/kilmarn/maps/src-only.webp" });
  assert.deepEqual(skipped, [], "a src-carrying asset is fully resolvable -- no skip recorded");
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

// --- 36.4a: the in-cycle quiet-flush poll budget --------------------------

await test("flushDirtyStagedScenes: default poll budget is pinned at 500ms/7000ms (36.4a -- bumped from 250/1500 to span one full ~5s Foundry watcher tick)", () => {
  assert.equal(DEFAULT_FLUSH_POLL_MS, 500);
  assert.equal(DEFAULT_FLUSH_TIMEOUT_MS, 7000);
});

await test("flushDirtyStagedScenes: with NO opts.pollMs/opts.timeoutMs given, the default budget is actually FORWARDED to writeFoundryOps -- a watcher that applies at ~2s (well past the OLD 1500ms budget, comfortably inside the NEW 7000ms one) is confirmed IN-CYCLE, not left queued/pending", async () => {
  const WORLD = "flush-default-budget-world";
  const scene = createScene(WORLD, { objectiveNote: "Slow-ish watcher, still in-cycle" });
  updateScene(WORLD, scene.id, { stagedForFoundry: true });
  const opId = "op_default_budget";

  armFakeWatcher(WORLD, { opId, ok: true, foundryUuid: "Scene.defaultBudget1" }, 2000);
  // Deliberately no pollMs/timeoutMs override -- only makeOpId, to keep the
  // result deterministic. This test really does wait out ~2s of real time
  // (the only way to observe the forwarded default without mocking the
  // module) -- short enough to keep the suite fast, long enough to prove the
  // OLD 250/1500 budget would have missed this and gone queued/pending.
  const result = await flushDirtyStagedScenes(dataDir, WORLD, { makeOpId: () => opId });

  assert.equal(result.flushed, 1);
  assert.equal(result.queued, undefined, "must confirm IN-CYCLE under the new budget, not fall through to queued");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].ok, true);
  const reread = getScene(WORLD, scene.id);
  assert.equal(reread.foundrySceneRef, "Scene.defaultBudget1");
  assert.ok(reread.lastPushedAt, "lastPushedAt must be stamped -- the in-cycle confirm marked it pushed directly, no ledger entry needed");
  assert.ok(!reread.pendingPush, "no pending-ledger entry was needed -- confirmed within the same call");
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


// ===========================================================================
// The weekly Foundry swap (2026-09-09, Russell): Foundry holds exactly the
// named plans' scenes, so the players' world stays one session light.
// ===========================================================================

/** A staged scene already live in Foundry. */
function livingScene(world, name, ref) {
  const scene = createScene(world, { name });
  updateScene(world, scene.id, { stagedForFoundry: true });
  markScenePushed(world, scene.id, { foundrySceneRef: ref, lastPushedAt: "2099-01-01T00:00:00.000Z" });
  return scene;
}

await test("syncFoundryToPlans: dry run reports the exact remove/push sets and writes NOTHING", async () => {
  const WORLD = "swap-dry-run-world";
  const keep = livingScene(WORLD, "This week", "Scene.keepMe");
  const drop = livingScene(WORLD, "Last week", "Scene.dropMe");
  const plan = createPlan(WORLD, { name: "Week 2" });
  addSceneToPlan(WORLD, plan.id, keep.id);

  const result = await syncFoundryToPlans(dataDir, WORLD, [plan.id], { pollMs: 5, timeoutMs: 20 });

  assert.equal(result.status, "dry-run");
  assert.deepEqual(result.remove.map((r) => r.foundrySceneRef), ["Scene.dropMe"]);
  assert.equal(result.push.length, 0, "a clean kept scene needs no push");
  assert.equal(getScene(WORLD, drop.id).foundrySceneRef, "Scene.dropMe", "a dry run must not clear a ref");
  assert.equal(existsSync(foundryOpsPath(dataDir, WORLD)), false, "a dry run must not write ops");
});

await test("syncFoundryToPlans: OWNERSHIP -- a Foundry scene GM_Tools never pushed is unreachable", async () => {
  const WORLD = "swap-ownership-world";
  const keep = livingScene(WORLD, "Ours, kept", "Scene.ours");
  // A scene record with NO ref stands in for everything GM_Tools doesn't own:
  // hand-built Foundry scenes, the default world scene, other worlds.
  createScene(WORLD, { name: "Never pushed" });
  const plan = createPlan(WORLD, { name: "Week 2" });
  addSceneToPlan(WORLD, plan.id, keep.id);

  const result = await syncFoundryToPlans(dataDir, WORLD, [plan.id], { pollMs: 5, timeoutMs: 20 });
  assert.equal(result.remove.length, 0, "only a scene GM_Tools has a ref for can ever be removed");
});

await test("syncFoundryToPlans: refuses an empty plan list rather than emptying the world", async () => {
  const WORLD = "swap-empty-plans-world";
  livingScene(WORLD, "Would be deleted", "Scene.x");
  await assert.rejects(() => syncFoundryToPlans(dataDir, WORLD, [], { confirm: true }), /at least one plan/);
});

await test("syncFoundryToPlans: a typo'd plan id throws instead of deleting that plan's scenes", async () => {
  const WORLD = "swap-bad-plan-world";
  livingScene(WORLD, "Innocent", "Scene.innocent");
  await assert.rejects(
    () => syncFoundryToPlans(dataDir, WORLD, ["plan_does_not_exist"], { confirm: true }),
    /No plan found/
  );
});

await test("syncFoundryToPlans: confirmed -- deletes the out-of-plan scene, clears its ref, keeps the in-plan one", async () => {
  const WORLD = "swap-applied-world";
  const keep = livingScene(WORLD, "This week", "Scene.keepMe");
  const drop = livingScene(WORLD, "Last week", "Scene.dropMe");
  const plan = createPlan(WORLD, { name: "Week 2" });
  addSceneToPlan(WORLD, plan.id, keep.id);

  const opId = "op_swap_delete";
  armFakeWatcher(WORLD, { opId, ok: true, foundryUuid: "Scene.dropMe" });

  const result = await syncFoundryToPlans(dataDir, WORLD, [plan.id], {
    confirm: true, pollMs: 10, timeoutMs: 500, makeOpId: () => opId
  });

  assert.equal(result.status, "applied");
  assert.deepEqual(result.removed.map((r) => r.name), ["Last week"]);
  assert.equal(result.failed.length, 0);
  assert.equal(getScene(WORLD, drop.id).foundrySceneRef, null, "a removed scene's ref is cleared -- GM_Tools keeps the scene, Foundry doesn't");
  assert.equal(getScene(WORLD, keep.id).foundrySceneRef, "Scene.keepMe", "the kept scene is untouched");
});

await test("syncFoundryToPlans: the delete op forwards force only when asked (the active-scene guard lives module-side)", async () => {
  const WORLD = "swap-force-world";
  const keep = livingScene(WORLD, "Kept", "Scene.kept");
  livingScene(WORLD, "Dropped", "Scene.dropped");
  const plan = createPlan(WORLD, { name: "Week 2" });
  addSceneToPlan(WORLD, plan.id, keep.id);

  await syncFoundryToPlans(dataDir, WORLD, [plan.id], { confirm: true, pollMs: 5, timeoutMs: 20, makeOpId: () => "op_noforce" });
  let [op] = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"));
  assert.equal(op.kind, "delete_scene");
  assert.equal(op.data.force, undefined, "no force by default -- the module refuses the active scene");

  writeFileSync(foundryOpsPath(dataDir, WORLD), "[]", "utf8"); // clear the in-flight guard
  await syncFoundryToPlans(dataDir, WORLD, [plan.id], { confirm: true, force: true, pollMs: 5, timeoutMs: 20, makeOpId: () => "op_force" });
  [op] = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"));
  assert.equal(op.data.force, true);
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
