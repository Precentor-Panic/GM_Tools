// Phase 36 task 36.0 -- QE-first e2e contract, part 2: ROUTE-LEVEL only (no
// browser -- mirrors phase35-pull-and-persistence.e2e.mjs/
// phase33-remove-from-graph.e2e.mjs's own route-only *.e2e.mjs precedent).
// Read phase36-fixture.mjs FIRST (§5 flush semantics, §6 exact op shapes).
//
// Deterministic ops-FILE assertions -- NO live Foundry anywhere. Scenes are
// seeded staged+dirty directly (seedSceneStaged, §1's raw-fs seed exception)
// with real bestiary/party-roster/stagecraft records (real store functions)
// dropped into the real, already-shipped scene-tray via
// dropOnSceneTrayViaRoute. The flush TRIGGER used throughout is the existing,
// reused `POST /api/foundry/sync-now` route (§5's second trigger) -- since
// the debounced auto-flush-on-mutation trigger (§5's first trigger) has no
// externally-observable synchronous completion point to await from a test,
// sync-now is the deterministic, awaitable trigger this suite exercises.
//
// EXPECTED-RED reasons: nothing in wf-mcp-server/lib/foundry-connection.mjs's
// `syncNow` today writes `world-fabric-foundry-ops.json` at all (grep/read-
// confirmed -- it only ever calls `pullFoundryActorsToStores` +
// `appendSyncLogEntry`) and its response has no `pushed` key -- every
// assertion below either reads back an ops file that plainly does not exist
// (`readFoundryOpsFileSync` returns `[]`) or asserts a `.pushed` key that is
// `undefined` today. These are clean assertion failures against the REAL,
// already-shipped route's CURRENT behavior, not fixture crashes.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  setupPhase36Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  seedSceneStaged,
  seedRosterCreature,
  seedRosterHero,
  seedRosterMapOrSplashAsset,
  dropOnSceneTrayViaRoute,
  syncNowViaRoute,
  readFoundryOpsFileSync,
  expectedCreateSceneOpData,
  expectedCreateTokenOpData,
  expectedCreateJournalImageOpData,
  clusterTokenPositions,
  DEFAULT_CANVAS
} from "./phase36-fixture.mjs";

const { scratchDir, dataDir } = setupPhase36Env("gm-tools-e2e-p36flush-");
const WORLD = "e2e-p36-flush-ops-shapes";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

let server, base;
let sceneMap, sceneSplash;
let ogrekin, kestrel;
let mapAsset, splashAsset;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  // --- Scene A: map + 2 tokens (a creature dropped TWICE, stacking to n:2, plus one hero) ---
  sceneMap = await createSceneViaRoute(base, WORLD, { objectiveNote: "The ferry landing ambush." });
  ogrekin = await seedRosterCreature(WORLD, { name: "Ogrekin Skirmisher", foundryActorRef: "Actor.ogrekinSkirmisher" });
  kestrel = await seedRosterHero(WORLD, { name: "Kestrel Windrider", foundryActorRef: "Actor.kestrelWindrider" });
  mapAsset = await seedRosterMapOrSplashAsset(WORLD, { kind: "map", name: "Ferry Landing", imagePath: "scenes/ferry-landing.webp" });

  await dropOnSceneTrayViaRoute(base, WORLD, sceneMap.id, { kind: "creature", id: ogrekin.id }); // n:1
  await dropOnSceneTrayViaRoute(base, WORLD, sceneMap.id, { kind: "creature", id: ogrekin.id }); // n:2 (stacking)
  await dropOnSceneTrayViaRoute(base, WORLD, sceneMap.id, { kind: "hero", id: kestrel.id }); // n:1
  await dropOnSceneTrayViaRoute(base, WORLD, sceneMap.id, { kind: "asset", id: mapAsset.id });
  seedSceneStaged(WORLD, sceneMap.id, { stagedForFoundry: true, lastPushedAt: null });

  // --- Scene B: splash only, no creatures/tokens ---
  sceneSplash = await createSceneViaRoute(base, WORLD, { objectiveNote: "Between-session title card." });
  splashAsset = await seedRosterMapOrSplashAsset(WORLD, { kind: "splash", name: "Ferry Landing Splash", imagePath: "scenes/ferry-splash.webp" });
  await dropOnSceneTrayViaRoute(base, WORLD, sceneSplash.id, { kind: "asset", id: splashAsset.id });
  seedSceneStaged(WORLD, sceneSplash.id, { stagedForFoundry: true, lastPushedAt: null });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

// ---------------------------------------------------------------------------
// sync-now-flushes contract: gains a `pushed` key, flushes BOTH dirty staged
// scenes seeded above in ONE call.
// ---------------------------------------------------------------------------

test("POST /api/foundry/sync-now response gains a pushed:{flushed,results,skipped} key (§5) and flushes every dirty staged scene in this world", async () => {
  const result = await syncNowViaRoute(base, WORLD);
  assert.ok(result.pushed, 'sync-now response must gain a "pushed" key -- absent from the real, already-shipped route\'s current return shape');
  assert.equal(result.pushed.flushed, 2, "both seeded staged+dirty scenes (map scene + splash scene) must be flushed by ONE sync-now call");
});

// ---------------------------------------------------------------------------
// Scene A (map + tokens, CREATE path) -- exact v2 op shapes
// ---------------------------------------------------------------------------

// Orchestrator reconcile (36.3 live-smoke finding): create-path tokens ride
// INSIDE create_scene.data.tokens (the module batch-places them post-create),
// NOT as standalone create_token ops -- the original opId-correlation scheme
// failed live ('create_token: unresolvable sceneUuid "op_..."'; the module's
// creator resolves sceneUuid via fromUuid()). create_token stays reserved
// for a future update-path with a real sceneUuid.
test("flush composes a create_scene op for the map scene with background.src = the map asset's imagePath AND the 3 roster tokens INLINE (2 stacked Ogrekin + 1 Kestrel, clustered at scene center)", async () => {
  await syncNowViaRoute(base, WORLD);
  const ops = readFoundryOpsFileSync(dataDir, WORLD);
  const sceneOp = ops.find((o) => o.kind === "create_scene" && o.data?.name === sceneMap.objectiveNote);
  assert.ok(sceneOp, `expected a create_scene op for the map scene -- ops on disk: ${JSON.stringify(ops)}`);
  const expectedPositions = clusterTokenPositions(3, { center: { x: DEFAULT_CANVAS.width / 2, y: DEFAULT_CANVAS.height / 2 } });
  assert.deepEqual(sceneOp.data, expectedCreateSceneOpData({
    name: sceneMap.objectiveNote,
    backgroundSrc: "scenes/ferry-landing.webp",
    tokens: [
      { actorUuid: "Actor.ogrekinSkirmisher", ...expectedPositions[0] },
      { actorUuid: "Actor.ogrekinSkirmisher", ...expectedPositions[1] },
      { actorUuid: "Actor.kestrelWindrider", ...expectedPositions[2] }
    ]
  }));
});

test("flush composes NO standalone create_token ops on the create path (tokens are inline in create_scene.data -- the live-smoke fix)", async () => {
  await syncNowViaRoute(base, WORLD);
  const ops = readFoundryOpsFileSync(dataDir, WORLD);
  const tokenOps = ops.filter((o) => o.kind === "create_token");
  assert.equal(tokenOps.length, 0, `standalone create_token must not appear in a create-path batch -- got ${JSON.stringify(tokenOps)}`);
});

// ---------------------------------------------------------------------------
// Scene B (splash only, CREATE path) -- foreground + create_journal_image
// ---------------------------------------------------------------------------

test("flush composes a create_scene op for the splash scene with foreground.src set and NO background key", async () => {
  await syncNowViaRoute(base, WORLD);
  const ops = readFoundryOpsFileSync(dataDir, WORLD);
  const sceneOp = ops.find((o) => o.kind === "create_scene" && o.data?.name === sceneSplash.objectiveNote);
  assert.ok(sceneOp, `expected a create_scene op for the splash scene -- ops on disk: ${JSON.stringify(ops)}`);
  assert.deepEqual(
    sceneOp.data,
    expectedCreateSceneOpData({ name: sceneSplash.objectiveNote, foregroundSrc: "scenes/ferry-splash.webp" })
  );
  assert.ok(!("background" in sceneOp.data), "a scene with no accepted map asset must OMIT background entirely, never null/empty");
});

test("flush composes a create_journal_image op for the splash asset", async () => {
  await syncNowViaRoute(base, WORLD);
  const ops = readFoundryOpsFileSync(dataDir, WORLD);
  const journalOp = ops.find((o) => o.kind === "create_journal_image");
  assert.ok(journalOp, `expected a create_journal_image op -- ops on disk: ${JSON.stringify(ops)}`);
  assert.deepEqual(journalOp.data, expectedCreateJournalImageOpData({
    imageSrc: "scenes/ferry-splash.webp",
    journalName: "Ferry Landing Splash",
    pageName: "Ferry Landing Splash"
  }));
});

// ---------------------------------------------------------------------------
// 409 in-flight -> queue, never clobber (a separate, isolated world so this
// test's pre-armed "stuck batch" can't interfere with the two scenes above)
// ---------------------------------------------------------------------------

test("409 FoundryOpsInFlightError -> sync-now queues (doesn't throw/500), leaves the scene dirty, and never clobbers the in-flight ops file", async () => {
  const WORLD2 = "e2e-p36-flush-409-world";
  bootstrapSnapshot(snapshotFilePath(dataDir, WORLD2), { worldId: WORLD2 });
  const scene = await createSceneViaRoute(base, WORLD2, { objectiveNote: "Blocked push." });
  const asset = await seedRosterMapOrSplashAsset(WORLD2, { kind: "map", name: "Blocked Map", imagePath: "scenes/blocked.webp" });
  await dropOnSceneTrayViaRoute(base, WORLD2, scene.id, { kind: "asset", id: asset.id });
  seedSceneStaged(WORLD2, scene.id, { stagedForFoundry: true, lastPushedAt: null });

  // Simulate a still-in-flight prior batch, exactly as foundry-ops.mjs's
  // writeOpsFileChecked would find it: a non-empty, non-"[]" ops file already
  // on disk for this world.
  const opsPath = join(dataDir, "worlds", WORLD2, "world-fabric-foundry-ops.json");
  mkdirSync(dirname(opsPath), { recursive: true });
  const stuckBatch = [{ opId: "op_stuck_prior_batch", kind: "create_scene", data: { name: "Someone else's push" } }];
  writeFileSync(opsPath, JSON.stringify(stuckBatch), "utf8");

  const res = await fetch(`${base}/api/foundry/sync-now`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world: WORLD2 })
  });
  const body = await res.json().catch(() => null);
  assert.equal(res.status, 200, `sync-now must never 500 on a 409-in-flight condition -- got ${res.status}: ${JSON.stringify(body)}`);

  const onDisk = readFoundryOpsFileSync(dataDir, WORLD2);
  assert.deepEqual(onDisk, stuckBatch, "the pre-existing in-flight batch must be left untouched, never clobbered by a blocked flush attempt");
});
