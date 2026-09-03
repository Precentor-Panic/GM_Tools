import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

/**
 * CONTRACT UNDER TEST — the scene-lifecycle half of the Aureus table wave
 * (B1/G1 + G12): activateSceneInFoundry, removeSceneFromFoundry
 * (unstage-first ordering), handleFoundrySceneOnDelete (orphan capture on
 * every branch), the stale-scene sweep (listStale/removeStale), the orphan
 * ledger, and the G12 transport fix (a sibling producer's late results
 * SURVIVE another producer's consume). Fake-watcher pattern from
 * foundry-push-ops.test.mjs; small pollMs keeps everything fast.
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

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-scene-lifecycle-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_FOUNDRY_ORPHANS_DIR = join(scratchDir, "foundry-orphans");
process.env.GM_TOOLS_STAGECRAFT_DIR = join(scratchDir, "stagecraft");
process.env.GM_TOOLS_SCENE_TRAY_DIR = join(scratchDir, "scene-tray");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");
const dataDir = join(scratchDir, "foundrydata");

const {
  activateSceneInFoundry, removeSceneFromFoundry, handleFoundrySceneOnDelete,
  listStaleFoundryScenes, removeStaleFoundryScenes
} = await import("../lib/foundry-push-ops.mjs");
const { writeFoundryOps } = await import("../lib/foundry-ops.mjs");
const { foundryOpsPath, foundryResultsPath } = await import("../lib/snapshot.mjs");
const { createScene, getScene, updateScene, markScenePushed } = await import("../../session-planner/scenes.mjs");
const { recordOrphan, listOrphans, clearOrphan } = await import("../../session-planner/foundry-orphans.mjs");

const FAST = { pollMs: 5, timeoutMs: 150 };

function seedFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
}

/** One-shot fake watcher: after delayMs, captures the ops batch, writes results (built from the captured ops via `respond`), clears ops to "[]". */
function armCapturingWatcher(world, respond, delayMs = 20) {
  const opsPath = foundryOpsPath(dataDir, world);
  const resultsPath = foundryResultsPath(dataDir, world);
  const captured = { ops: null };
  const timer = setTimeout(() => {
    captured.ops = JSON.parse(readFileSync(opsPath, "utf8"));
    seedFile(resultsPath, respond(captured.ops));
    writeFileSync(opsPath, "[]", "utf8");
  }, delayMs);
  return { captured, timer };
}

function pushedScene(world, ref) {
  const scene = createScene(world, { objectiveNote: "lifecycle test" });
  updateScene(world, scene.id, { stagedForFoundry: true });
  markScenePushed(world, scene.id, { foundrySceneRef: ref, lastPushedAt: new Date().toISOString() });
  return getScene(world, scene.id);
}

// ─── G12: transport survivor fix ────────────────────────────────────────────

await test("G12: a sibling producer's late result SURVIVES another producer's consume (no more blanket results clear)", async () => {
  const WORLD = "g12-world";
  const foreign = { opId: "op_foreign_late", ok: true, foundryUuid: "Scene.someone.elses" };
  const { timer } = armCapturingWatcher(WORLD, (ops) => [
    { opId: ops[0].opId, ok: true, foundryUuid: "Scene.mine" },
    foreign // a sibling batch's late result sitting in the same results file
  ]);
  const outcome = await writeFoundryOps(dataDir, WORLD, [{ opId: "op_mine", kind: "activate_scene", data: { sceneUuid: "Scene.mine" } }], FAST);
  clearTimeout(timer);
  assert.equal(outcome.status, "applied");
  assert.equal(outcome.results.length, 1, "only my own results come back");
  const survivors = JSON.parse(readFileSync(foundryResultsPath(dataDir, WORLD), "utf8"));
  assert.deepEqual(survivors, [foreign], "the foreign result survives on disk for its own producer's reconcile");
});

// ─── activate ───────────────────────────────────────────────────────────────

await test("activateSceneInFoundry: refuses a never-pushed scene; composes activate_scene from the scene's own ref", async () => {
  const WORLD = "activate-world";
  const bare = createScene(WORLD, { objectiveNote: "unpushed" });
  await assert.rejects(() => activateSceneInFoundry(dataDir, WORLD, bare.id, FAST), /no foundrySceneRef/);

  const scene = pushedScene(WORLD, "Scene.act1");
  const { captured, timer } = armCapturingWatcher(WORLD, (ops) => [{ opId: ops[0].opId, ok: true, foundryUuid: "Scene.act1" }]);
  const res = await activateSceneInFoundry(dataDir, WORLD, scene.id, FAST);
  clearTimeout(timer);
  assert.equal(res.ok, true);
  assert.equal(captured.ops[0].kind, "activate_scene");
  assert.equal(captured.ops[0].data.sceneUuid, "Scene.act1", "only the self-written ref is ever composed");
});

// ─── remove from Foundry ────────────────────────────────────────────────────

await test("removeSceneFromFoundry: unstages FIRST (queued outcome leaves scene unstaged, ref kept for retry)", async () => {
  const WORLD = "remove-queued-world";
  const scene = pushedScene(WORLD, "Scene.rm-queued");
  // No watcher armed → the op stays queued.
  const res = await removeSceneFromFoundry(dataDir, WORLD, scene.id, { pollMs: 5, timeoutMs: 30 });
  assert.equal(res.status, "queued");
  const after = getScene(WORLD, scene.id);
  assert.equal(after.stagedForFoundry, false, "unstaged BEFORE the delete confirms — closes the auto-flush re-create race");
  assert.equal(after.pendingPush, null);
  assert.equal(after.foundrySceneRef, "Scene.rm-queued", "ref kept until a confirmed ok");
  writeFileSync(foundryOpsPath(dataDir, WORLD), "[]", "utf8"); // clear the queued batch for later tests
});

await test("removeSceneFromFoundry: confirmed ok clears the ref (a future re-stage is a fresh create)", async () => {
  const WORLD = "remove-ok-world";
  const scene = pushedScene(WORLD, "Scene.rm-ok");
  const { captured, timer } = armCapturingWatcher(WORLD, (ops) => [{ opId: ops[0].opId, ok: true, foundryUuid: "Scene.rm-ok" }]);
  const res = await removeSceneFromFoundry(dataDir, WORLD, scene.id, FAST);
  clearTimeout(timer);
  assert.equal(res.ok, true);
  assert.equal(res.removedFoundryUuid, "Scene.rm-ok");
  assert.equal(captured.ops[0].kind, "delete_scene");
  const after = getScene(WORLD, scene.id);
  assert.equal(after.foundrySceneRef, null);
  assert.equal(after.lastPushedAt, null);
});

// ─── delete-everywhere branches ─────────────────────────────────────────────

await test("handleFoundrySceneOnDelete: never-pushed => none; default => orphan captured; failed removal => orphaned anyway", async () => {
  const WORLD = "delete-branches-world";
  const bare = createScene(WORLD, { objectiveNote: "never pushed" });
  assert.deepEqual(await handleFoundrySceneOnDelete(dataDir, WORLD, getScene(WORLD, bare.id), {}), { foundry: "none" });

  const kept = pushedScene(WORLD, "Scene.orphan-me");
  const r1 = await handleFoundrySceneOnDelete(dataDir, WORLD, getScene(WORLD, kept.id), {});
  assert.equal(r1.foundry, "orphaned");
  assert.equal(listOrphans(WORLD).length, 1);
  assert.equal(listOrphans(WORLD)[0].foundrySceneRef, "Scene.orphan-me");

  // alsoRemoveFromFoundry with NO watcher → removal queues → orphaned anyway (the ref dies with the record otherwise).
  const doomed = pushedScene(WORLD, "Scene.remove-fails");
  const r2 = await handleFoundrySceneOnDelete(dataDir, WORLD, getScene(WORLD, doomed.id), { alsoRemoveFromFoundry: true }, { pollMs: 5, timeoutMs: 30 });
  assert.equal(r2.foundry, "orphaned-after-failed-removal");
  assert.ok(listOrphans(WORLD).some((o) => o.foundrySceneRef === "Scene.remove-fails"));
  writeFileSync(foundryOpsPath(dataDir, WORLD), "[]", "utf8");
});

// ─── stale sweep ────────────────────────────────────────────────────────────

await test("stale sweep: lists orphans + unstaged-with-ref; bulk removal clears ledger rows and scene refs; unknown targets are skipped never guessed", async () => {
  const WORLD = "sweep-world";
  const unstaged = pushedScene(WORLD, "Scene.sweep-unstaged");
  updateScene(WORLD, unstaged.id, { stagedForFoundry: false });
  recordOrphan(WORLD, { sceneId: "gone", name: "Old market", foundrySceneRef: "Scene.sweep-orphan" });

  const stale = listStaleFoundryScenes(dataDir, WORLD);
  assert.equal(stale.unstagedWithRef.length, 1);
  assert.equal(stale.orphans.length, 1);
  const orphanId = stale.orphans[0].id;

  const { captured, timer } = armCapturingWatcher(WORLD, (ops) => [
    { opId: ops[0].opId, ok: true, foundryUuid: ops[0].data.sceneUuid },
    { opId: ops[1].opId, ok: true, foundryUuid: ops[1].data.sceneUuid }
  ]);
  const res = await removeStaleFoundryScenes(dataDir, WORLD, [
    { kind: "orphan", id: orphanId },
    { kind: "scene", id: unstaged.id },
    { kind: "scene", id: "not-a-current-target" }
  ], FAST);
  clearTimeout(timer);
  assert.equal(res.status, "applied");
  assert.equal(res.removed.length, 2);
  assert.equal(res.skipped.length, 1);
  assert.equal(captured.ops.length, 2, "unknown targets never reach the ops batch");
  assert.ok(captured.ops.every((o) => o.kind === "delete_scene"));
  assert.deepEqual(listOrphans(WORLD), [], "confirmed orphan removal clears the ledger row");
  assert.equal(getScene(WORLD, unstaged.id).foundrySceneRef, null);
});

// ─── orphan store hygiene ───────────────────────────────────────────────────

await test("orphan ledger: dedupes on foundrySceneRef; clearOrphan is a safe no-op for unknown ids; refuses a ref-less record", async () => {
  const WORLD = "orphan-store-world";
  recordOrphan(WORLD, { sceneId: "s1", name: "A", foundrySceneRef: "Scene.dup" });
  recordOrphan(WORLD, { sceneId: "s1b", name: "A again", foundrySceneRef: "Scene.dup" });
  assert.equal(listOrphans(WORLD).length, 1);
  clearOrphan(WORLD, "no-such-id");
  assert.equal(listOrphans(WORLD).length, 1);
  assert.throws(() => recordOrphan(WORLD, { sceneId: "s2", name: "B", foundrySceneRef: null }), /foundrySceneRef is required/);
});

console.log(`\n${passed} passed`);
rmSync(scratchDir, { recursive: true, force: true });
