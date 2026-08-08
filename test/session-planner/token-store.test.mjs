import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — session-planner/token-store.mjs (Phase 35 task
 * 35.1, §3 of review-ui/test/e2e/phase35-fixture.mjs, reusing
 * plans/phase-32-deferred.md §2's TokenRecord verbatim). Per-world, no
 * status gate, per-scene REPLACE via syncTokensForScene.
 */

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-token-store-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_TOKEN_DIR = join(scratchDir, "tokens");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");

const REPO_DEFAULT_ROOT = join(new URL("../../tokens", import.meta.url).pathname);
const before = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();

const WORLD = "token-store-test-world";

(async () => {
  const { tokenRoot, syncTokensForScene, listTokens } = await import("../../session-planner/token-store.mjs");
  const { createScene, updateScene } = await import("../../session-planner/scenes.mjs");

  test("directory isolation: tokenRoot() honors GM_TOOLS_TOKEN_DIR, never the repo's real default", () => {
    assert.equal(tokenRoot(), process.env.GM_TOOLS_TOKEN_DIR);
    assert.notEqual(tokenRoot(), REPO_DEFAULT_ROOT);
  });

  test("listTokens: [] for a world with no tokens yet -- not an error", () => {
    assert.deepEqual(listTokens("a-totally-new-world"), []);
  });

  test("syncTokensForScene: inserts a fresh TokenRecord set, sceneId null when no GM_Tools scene has this foundrySceneRef yet", () => {
    const inserted = syncTokensForScene(
      WORLD,
      "Scene.camp001",
      [
        { name: "Goblin Boss", x: 100, y: 200, actorUuid: "Actor.gob1", img: "gob.webp" },
        { name: "Goblin", x: 150, y: 250, actorUuid: "Actor.gob2" }
      ],
      "2026-08-08T00:00:00.000Z",
      { makeId: (() => { let n = 0; return () => `tok-${++n}`; })() }
    );
    assert.equal(inserted.length, 2);
    assert.equal(inserted[0].world, WORLD);
    assert.equal(inserted[0].sceneUuid, "Scene.camp001");
    assert.equal(inserted[0].sceneId, null, "no GM_Tools scene has been pushed with this foundrySceneRef yet");
    assert.equal(inserted[0].name, "Goblin Boss");
    assert.equal(inserted[0].x, 100);
    assert.equal(inserted[0].actorUuid, "Actor.gob1");
    assert.equal(inserted[0].capturedAt, "2026-08-08T00:00:00.000Z");
    assert.equal(inserted[1].actorUuid, "Actor.gob2");
    assert.equal(inserted[1].img, null, "missing img defaults to null, never a fabricated value");
  });

  test("listTokens: lists everything for the world, and filters by sceneUuid", () => {
    assert.equal(listTokens(WORLD).length, 2);
    assert.equal(listTokens(WORLD, "Scene.camp001").length, 2);
    assert.equal(listTokens(WORLD, "Scene.nowhere").length, 0);
  });

  test("no write in this file leaked into the repo's real default tokens/ directory", () => {
    const after = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();
    const added = [...after].filter((f) => !before.has(f));
    assert.deepEqual(added, [], `this test run must not add new entries to ${REPO_DEFAULT_ROOT}, found: ${added}`);
  });

  test("syncTokensForScene: sceneId resolves when a GM_Tools scene DOES carry this foundrySceneRef", () => {
    const scene = createScene(WORLD, {}, { makeId: () => "scene-linked", now: "2026-08-08T00:00:00.000Z" });
    updateScene(WORLD, scene.id, { foundrySceneRef: "Scene.linkedOne" });

    const inserted = syncTokensForScene(WORLD, "Scene.linkedOne", [{ name: "Hero", x: 1, y: 1, actorUuid: "Actor.hero" }], "2026-08-08T01:00:00.000Z");
    assert.equal(inserted[0].sceneId, "scene-linked");
  });

  test("syncTokensForScene: PER-SCENE REPLACE -- a second sync for the SAME sceneUuid wipes the prior set, never accumulates", () => {
    const secondSync = syncTokensForScene(WORLD, "Scene.camp001", [{ name: "Only One Now", x: 0, y: 0, actorUuid: "Actor.gob1" }], "2026-08-08T02:00:00.000Z");
    assert.equal(secondSync.length, 1);
    assert.equal(listTokens(WORLD, "Scene.camp001").length, 1, "the old 2-token set must be wiped, not appended to");
    assert.equal(listTokens(WORLD, "Scene.camp001")[0].name, "Only One Now");
  });

  test("syncTokensForScene: an EMPTY token list for a scene correctly REPLACES (wipes) any prior tokens, reporting count:0 (not the stale count)", () => {
    const empty = syncTokensForScene(WORLD, "Scene.camp001", [], "2026-08-08T03:00:00.000Z");
    assert.deepEqual(empty, []);
    assert.equal(listTokens(WORLD, "Scene.camp001").length, 0, "genuinely empty now, distinct from 'still has tokens from before'");
  });

  test("syncTokensForScene: does not touch tokens for a DIFFERENT sceneUuid in the same world", () => {
    syncTokensForScene(WORLD, "Scene.other", [{ name: "Elsewhere", x: 0, y: 0 }], "2026-08-08T04:00:00.000Z");
    assert.equal(listTokens(WORLD, "Scene.linkedOne").length, 1, "the Scene.linkedOne token from an earlier sync is untouched");
    assert.equal(listTokens(WORLD, "Scene.other").length, 1);
    assert.equal(listTokens(WORLD).length, 2, "Scene.linkedOne (1) + Scene.other (1)");
  });

  console.log(`\n${passed} passed`);
})();

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
