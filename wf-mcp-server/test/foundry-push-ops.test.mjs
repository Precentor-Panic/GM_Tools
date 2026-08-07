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
const dataDir = join(scratchDir, "foundrydata");

const { pushSceneToFoundry } = await import("../lib/foundry-push-ops.mjs");
const { foundryOpsPath, foundryResultsPath } = await import("../lib/snapshot.mjs");
const { createScene, getScene } = await import("../../session-planner/scenes.mjs");

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

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
