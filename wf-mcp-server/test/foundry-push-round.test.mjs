import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

/**
 * CONTRACT UNDER TEST — the push round (2026-10-07). Six defects, each one
 * something that actually went wrong pushing session three by hand, and each
 * one a property of the push PROCESS rather than of any single route:
 *
 *   1. syncFoundryToPlans RE-CREATED THE SCENES IT JUST DELETED. It cleared
 *      the ref but left stagedForFoundry true, so isSceneDirty was instantly
 *      true again and its own trailing flush re-created every one. The only
 *      confirm:true test that existed used a CLEAN scene, so the flush never
 *      ran and the bug was invisible.
 *   2. The `push` set was ADVISORY — computed, reported, then ignored by a
 *      flush that re-scanned the whole world, so the dry run could honestly
 *      disagree with the apply.
 *   3. pushOne RACED the route it was waiting on: writeFoundryOps deletes its
 *      own batch's results before returning them, so polling the file
 *      afterwards found nothing and reported a FAILURE for a push that
 *      worked. The worst possible failure mode, because the obvious response
 *      is to run the push again.
 *   4. A QUEUED DELETE lost its ref permanently.
 *   5. update_token had no caller at all.
 *   6. Nothing anywhere refused to write to a player character.
 *
 * Real stores, real ops-channel writer, a background timer standing in for
 * Foundry's watcher — the established pattern from foundry-push-ops.test.mjs.
 */
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

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-push-round-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_STAGECRAFT_DIR = join(scratchDir, "stagecraft");
process.env.GM_TOOLS_SCENE_TRAY_DIR = join(scratchDir, "scene-tray");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");
process.env.GM_TOOLS_PUSH_LOCK_DIR = join(scratchDir, "push-locks");
const dataDir = join(scratchDir, "foundrydata");

const { flushDirtyStagedScenes, syncFoundryToPlans, isSceneDirty } = await import("../lib/foundry-push-ops.mjs");
const { refreshSceneTokenArt, assertNotPlayerCharacter } = await import("../lib/foundry-item-push-ops.mjs");
const { pushOne, withPushLock } = await import("../lib/foundry-push-orchestrator.mjs");
const { foundryOpsPath, foundryResultsPath, foundryIndexPath } = await import("../lib/snapshot.mjs");
const { createScene, getScene, updateScene, markScenePushed } = await import("../../session-planner/scenes.mjs");
const { createPlan, addSceneToPlan } = await import("../../session-planner/plans.mjs");
const { addToSceneTray } = await import("../../session-planner/scene-tray.mjs");
const { saveStagecraftAsset, acceptStagecraftAsset } = await import("../../session-planner/stagecraft-store.mjs");
const { saveBestiaryEntry, acceptBestiaryEntry, setBestiaryTokenImg, setBestiaryFoundryActorRef } = await import("../../combat-planning/bestiary-store.mjs");
const { savePartyMember } = await import("../../combat-planning/party-roster-store.mjs");
const { playerCharacterUuids } = await import("../../combat-planning/party-sheet-index.mjs");

function seedFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
}

/** The established fake watcher: answer every op currently in the file, then clear it. */
function armFakeWatcher(world, { uuidFor = (op) => `Scene.${op.opId}`, ok = true, delayMs = 15 } = {}) {
  const opsPath = foundryOpsPath(dataDir, world);
  const resultsPath = foundryResultsPath(dataDir, world);
  const tick = setInterval(() => {
    if (!existsSync(opsPath)) return;
    let ops;
    try { ops = JSON.parse(readFileSync(opsPath, "utf8")); } catch { return; }
    if (!Array.isArray(ops) || ops.length === 0) return;
    const prior = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8") || "[]") : [];
    seedFile(resultsPath, [...prior, ...ops.map((o) => ({ opId: o.opId, ok, foundryUuid: uuidFor(o), ...(ok ? {} : { error: "nope" }) }))]);
    writeFileSync(opsPath, "[]", "utf8");
  }, delayMs);
  return () => clearInterval(tick);
}

/** A staged, pushable scene with a real accepted map asset. */
function stagedScene(world, name) {
  const asset = saveStagecraftAsset(world, { kind: "map", name: `${name} map`, src: `scenes/${name.replace(/\W+/g, "-")}.webp`, provenance: "local" });
  acceptStagecraftAsset(world, asset.id);
  const scene = createScene(world, { objectiveNote: name });
  updateScene(world, scene.id, { name, stagedForFoundry: true, mapAssetId: asset.id });
  return getScene(world, scene.id);
}

const budget = { pollMs: 5, timeoutMs: 1500 };

// -------------------------------------------------------------------------
// (1) + (2): the swap no longer re-creates what it just deleted, and the
//            flush it runs is the SET IT REPORTED.
// -------------------------------------------------------------------------

await test("syncFoundryToPlans: a scene dropped from the plan is deleted and STAYS deleted — the trailing flush must not re-create it", async () => {
  const WORLD = "swap-no-recreate";
  const keep = stagedScene(WORLD, "Kept scene");
  const drop = stagedScene(WORLD, "Dropped scene");
  // Both are live in Foundry. `drop` is NOT in the plan, so the swap removes it.
  markScenePushed(WORLD, keep.id, { foundrySceneRef: "Scene.KEEP", lastPushedAt: new Date(Date.now() + 60000).toISOString() });
  markScenePushed(WORLD, drop.id, { foundrySceneRef: "Scene.DROP", lastPushedAt: new Date(Date.now() + 60000).toISOString() });
  const plan = createPlan(WORLD, { name: "Tonight" });
  addSceneToPlan(WORLD, plan.id, keep.id);

  const stop = armFakeWatcher(WORLD);
  try {
    const out = await syncFoundryToPlans(dataDir, WORLD, [plan.id], { confirm: true, ...budget });
    assert.equal(out.status, "applied", JSON.stringify(out));
    assert.deepEqual(out.removed.map((r) => r.sceneId), [drop.id], "the out-of-plan scene is removed");
  } finally { stop(); }

  const after = getScene(WORLD, drop.id);
  assert.equal(after.foundrySceneRef, null, "its Foundry ref is cleared");
  assert.equal(after.stagedForFoundry, false,
    "AND it is UNSTAGED — leaving it staged is what made isSceneDirty true again and re-created it");
  assert.equal(isSceneDirty(after), false, "so it is no longer dirty, and no later flush can resurrect it");
});

await test("syncFoundryToPlans: the flush is scoped to the push set it reported, not a fresh world-wide scan", async () => {
  const WORLD = "swap-scoped-flush";
  const inPlan = stagedScene(WORLD, "In the plan");
  const elsewhere = stagedScene(WORLD, "Staged but in no plan"); // dirty, staged, never pushed
  const plan = createPlan(WORLD, { name: "Tonight" });
  addSceneToPlan(WORLD, plan.id, inPlan.id);

  const preview = await syncFoundryToPlans(dataDir, WORLD, [plan.id], budget);
  assert.equal(preview.status, "dry-run");
  assert.deepEqual(preview.push.map((p) => p.sceneId), [inPlan.id], "the preview names ONE scene");

  const stop = armFakeWatcher(WORLD);
  try {
    await syncFoundryToPlans(dataDir, WORLD, [plan.id], { confirm: true, ...budget });
  } finally { stop(); }

  assert.ok(getScene(WORLD, inPlan.id).foundrySceneRef, "the planned scene was pushed");
  assert.equal(getScene(WORLD, elsewhere.id).foundrySceneRef, null,
    "a staged scene in NO plan must not be swept into the swap just because the flush re-scanned the world");
});

await test("flushDirtyStagedScenes: opts.sceneIds scopes the flush", async () => {
  const WORLD = "flush-scoped";
  const a = stagedScene(WORLD, "Scene A");
  const b = stagedScene(WORLD, "Scene B");
  const stop = armFakeWatcher(WORLD);
  try {
    const out = await flushDirtyStagedScenes(dataDir, WORLD, { sceneIds: [a.id], ...budget });
    assert.equal(out.flushed, 1, "only the named scene is composed");
  } finally { stop(); }
  assert.ok(getScene(WORLD, a.id).foundrySceneRef);
  assert.equal(getScene(WORLD, b.id).foundrySceneRef, null);
});

// -------------------------------------------------------------------------
// (3): pushOne trusts the route's own answer.
// -------------------------------------------------------------------------

await test("pushOne: an 'applied' route response is used DIRECTLY — it must not then poll for results the route already consumed", async () => {
  const WORLD = "pushone-fast-path";
  mkdirSync(join(dataDir, "worlds", WORLD), { recursive: true });
  writeFileSync(foundryOpsPath(dataDir, WORLD), "[]", "utf8");
  // No watcher, and the results file is EMPTY — exactly the state
  // writeFoundryOps leaves behind after it consumes its own batch.
  writeFileSync(foundryResultsPath(dataDir, WORLD), "[]", "utf8");

  let reconciled = null;
  const started = Date.now();
  const row = await pushOne({
    dataDir, world: WORLD,
    label: "An actor",
    alreadyPushed: false,
    timeoutMs: 4000,
    queueFn: async () => ({ status: "applied", opId: "op_1", ok: true, foundryUuid: "Actor.ABC" }),
    reconcileFn: (ref) => { reconciled = ref; }
  });
  assert.equal(row.status, "ok", `a push the route confirmed must not be reported as a failure: ${row.reason}`);
  assert.equal(row.ref, "Actor.ABC");
  assert.equal(reconciled, "Actor.ABC", "and the ref is reconciled");
  assert.ok(Date.now() - started < 3000, "it must return immediately, not wait out the poll budget");
});

await test("pushOne: a 'queued' route response still falls back to polling the results file", async () => {
  const WORLD = "pushone-queued-path";
  mkdirSync(join(dataDir, "worlds", WORLD), { recursive: true });
  writeFileSync(foundryOpsPath(dataDir, WORLD), "[]", "utf8");
  seedFile(foundryResultsPath(dataDir, WORLD), [{ opId: "op_late", ok: true, foundryUuid: "Scene.LATE" }]);

  const row = await pushOne({
    dataDir, world: WORLD,
    label: "A late scene",
    alreadyPushed: false,
    timeoutMs: 4000,
    queueFn: async () => ({ status: "queued", opId: "op_late" })
  });
  assert.equal(row.status, "ok", row.reason);
  assert.equal(row.ref, "Scene.LATE");
});

await test("pushOne: an 'applied' response carrying ok:false is a failure, with Foundry's own reason", async () => {
  const WORLD = "pushone-applied-failure";
  mkdirSync(join(dataDir, "worlds", WORLD), { recursive: true });
  writeFileSync(foundryOpsPath(dataDir, WORLD), "[]", "utf8");
  const row = await pushOne({
    dataDir, world: WORLD,
    label: "A doomed actor",
    alreadyPushed: false,
    timeoutMs: 2000,
    queueFn: async () => ({ status: "applied", opId: "op_2", ok: false, error: "Actor type not permitted" })
  });
  assert.equal(row.status, "failed");
  assert.match(row.reason, /Actor type not permitted/);
});

// -------------------------------------------------------------------------
// (4): a queued delete stays recoverable.
// -------------------------------------------------------------------------

await test("syncFoundryToPlans: a delete that does not confirm is reported, KEEPS its ref for a retry, and is already unstaged", async () => {
  const WORLD = "swap-queued-delete";
  const keep = stagedScene(WORLD, "Kept");
  const drop = stagedScene(WORLD, "Doomed");
  markScenePushed(WORLD, keep.id, { foundrySceneRef: "Scene.K2", lastPushedAt: new Date(Date.now() + 60000).toISOString() });
  markScenePushed(WORLD, drop.id, { foundrySceneRef: "Scene.D2", lastPushedAt: new Date(Date.now() + 60000).toISOString() });
  const plan = createPlan(WORLD, { name: "Tonight" });
  addSceneToPlan(WORLD, plan.id, keep.id);

  // NO watcher: the delete is written and never answered.
  const out = await syncFoundryToPlans(dataDir, WORLD, [plan.id], { confirm: true, pollMs: 5, timeoutMs: 60 });
  assert.ok(out.queuedRemovals?.length, "an unconfirmed removal must be reported, never silently counted as done");
  assert.equal(out.removed.length, 0);

  const after = getScene(WORLD, drop.id);
  assert.equal(after.foundrySceneRef, "Scene.D2",
    "the ref is KEPT so a retry can re-send the delete — clearing it here is how the ref was lost for good");
  assert.equal(after.stagedForFoundry, false, "and it is already unstaged, so nothing re-creates it meanwhile");
});

// -------------------------------------------------------------------------
// (5): update_token reaches the ops file.
// -------------------------------------------------------------------------

await test("refreshSceneTokenArt: emits one update_token per tray creature with BOTH an actor and an accepted face", async () => {
  const WORLD = "refresh-tokens";
  const scene = stagedScene(WORLD, "A dressed scene");
  markScenePushed(WORLD, scene.id, { foundrySceneRef: "Scene.DRESSED", lastPushedAt: new Date().toISOString() });

  const mk = (name) => {
    const e = saveBestiaryEntry({ world: WORLD, rawFields: { name, ac: 12, hp: 9 }, provenance: { source: "hand" } });
    acceptBestiaryEntry(e.id);
    return e;
  };
  const ready = mk("Ready");       // actor + face
  const noFace = mk("No face");    // actor, no face
  const noActor = mk("No actor");  // face, no actor
  setBestiaryFoundryActorRef(ready.id, "Actor.READY");
  setBestiaryTokenImg(ready.id, "gm-tools/tokens/x/ready.webp");
  setBestiaryFoundryActorRef(noFace.id, "Actor.NOFACE");
  setBestiaryTokenImg(noActor.id, "gm-tools/tokens/x/noactor.webp");
  for (const e of [ready, noFace, noActor]) addToSceneTray(WORLD, scene.id, { kind: "creature", id: e.id });

  const out = await refreshSceneTokenArt(dataDir, WORLD, scene.id, { pollMs: 5, timeoutMs: 60 });
  assert.equal(out.ops.length, 1, `exactly the one eligible creature: ${JSON.stringify(out.skipped)}`);

  const onDisk = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].kind, "update_token");
  assert.equal(onDisk[0].data.sceneUuid, "Scene.DRESSED");
  assert.equal(onDisk[0].data.actorUuid, "Actor.READY");
  // The RING keys are the whole point: Foundry reads a ringed token's art
  // from ring.subject.texture and falls back to texture.src only when the
  // subject is unset, so patching texture.src alone changes nothing visible.
  assert.equal(onDisk[0].data.patch["ring.subject.texture"], "gm-tools/tokens/x/ready.webp");
  assert.equal(onDisk[0].data.patch["ring.enabled"], true);

  // And it never deletes the scene — the standing rule.
  assert.equal(getScene(WORLD, scene.id).foundrySceneRef, "Scene.DRESSED");
  writeFileSync(foundryOpsPath(dataDir, WORLD), "[]", "utf8");
});

await test("refreshSceneTokenArt: refuses a scene that was never pushed, rather than silently doing nothing", async () => {
  const WORLD = "refresh-unpushed";
  const scene = stagedScene(WORLD, "Never pushed");
  await assert.rejects(() => refreshSceneTokenArt(dataDir, WORLD, scene.id, { pollMs: 5, timeoutMs: 60 }), /push it first/);
});

// -------------------------------------------------------------------------
// (6): PC safety.
// -------------------------------------------------------------------------

await test("playerCharacterUuids: unions claimed actors and roster rows, and is BROADER than the rail's seat list", () => {
  const index = {
    users: [{ id: "u1", characterUuid: "Actor.PC1" }, { id: "u2", characterUuid: null }],
    actors: [{ uuid: "Actor.PC1", name: "Dio" }]
  };
  const roster = [
    { id: "m1", foundryActorRef: "Actor.PC2", status: "accepted" },
    { id: "m2", foundryActorRef: "Actor.DEAD", status: "discarded" }
  ];
  const pcs = playerCharacterUuids(index, roster);
  assert.ok(pcs.has("Actor.PC1"), "a claimed actor is a PC");
  assert.ok(pcs.has("Actor.PC2"), "so is one known only from the roster — an unfinished sheet is still a PC");
  assert.ok(!pcs.has("Actor.DEAD"), "a DISCARDED roster row must not protect a uuid something else may reuse");
});

await test("assertNotPlayerCharacter: refuses a claimed PC, allows an NPC, and fails OPEN when no index exists", () => {
  const WORLD = "pc-guard";
  const idxPath = foundryIndexPath(dataDir, WORLD);

  // No index at all (a world no GM client has ever connected to): must NOT
  // block the ordinary first push.
  assert.doesNotThrow(() => assertNotPlayerCharacter(dataDir, "pc-guard-never-indexed", "Actor.ANY"));

  seedFile(idxPath, {
    exportedAt: new Date().toISOString(),
    users: [{ id: "u1", characterUuid: "Actor.VELTHAR" }],
    actors: [{ uuid: "Actor.VELTHAR", name: "Velthar Starblind" }, { uuid: "Actor.CLERK", name: "The counting clerk" }]
  });
  assert.throws(
    () => assertNotPlayerCharacter(dataDir, WORLD, "Actor.VELTHAR"),
    /PLAYER CHARACTER/,
    "writing to a claimed PC must be refused, by name"
  );
  assert.doesNotThrow(() => assertNotPlayerCharacter(dataDir, WORLD, "Actor.CLERK"), "an NPC is fine");
  assert.doesNotThrow(() => assertNotPlayerCharacter(dataDir, WORLD, null), "nothing to check is not an error");
});

// -------------------------------------------------------------------------
// The lock no longer lives inside the Foundry world directory.
// -------------------------------------------------------------------------

await test("withPushLock: the lock file lives in GM_Tools' own store dir, never inside the Foundry world folder", async () => {
  const WORLD = "lock-location";
  let seen = null;
  await withPushLock(dataDir, WORLD, async () => {
    const { readdirSync } = await import("node:fs");
    seen = readdirSync(process.env.GM_TOOLS_PUSH_LOCK_DIR);
    const worldDir = join(dataDir, "worlds", WORLD);
    const strays = existsSync(worldDir) ? readdirSync(worldDir).filter((f) => f.includes("push.lock")) : [];
    assert.deepEqual(strays, [], "nothing lock-shaped may be written into Foundry's own world folder");
  });
  assert.ok(seen.includes(`${WORLD}.lock`));
});

await test("withPushLock: a second concurrent pusher is refused — two at once is how the duplicate scene happened", async () => {
  const WORLD = "lock-concurrency";
  await withPushLock(dataDir, WORLD, async () => {
    await assert.rejects(
      () => withPushLock(dataDir, WORLD, async () => {}),
      /Another push is already running/
    );
  });
  // And the lock is released afterwards, so the next run is not wedged.
  await assert.doesNotReject(() => withPushLock(dataDir, WORLD, async () => {}));
});

console.log(`\n${passed} passed`);
rmSync(scratchDir, { recursive: true, force: true });
