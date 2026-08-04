import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — new `session-planner/scene-narration.mjs` (Phase 28
 * task 28.1). `sceneId`-keyed history/supersede store mirroring
 * mutation-engine/entity-narration.mjs's shape one level up: every save
 * appends a new `'current'` entry and marks the prior `'current'` entry (if
 * any) `'superseded'` first -- nothing is ever deleted, only one entry per
 * scene may be `'current'` at a time.
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

// Isolate BOTH review-state.mjs (this module reuses its withLock) and its
// own root BEFORE importing either -- same pattern as
// test/scene-planning/scene-membership.test.mjs.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-scene-narration-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_SCENE_NARRATION_DIR = join(scratchDir, "scene-narration");

const REPO_DEFAULT_ROOT = join(new URL("../../scene-narration", import.meta.url).pathname);
const before = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();

const WORLD = "scene-narration-test-world";

const {
  getSceneNarrationHistory,
  getCurrentSceneNarration,
  saveSceneNarration,
  supersedeSceneNarration,
  sceneNarrationRoot,
  SCHEMA_VERSION
} = await import("../../session-planner/scene-narration.mjs");

test("directory isolation: sceneNarrationRoot() honors GM_TOOLS_SCENE_NARRATION_DIR, never the repo's real default", () => {
  assert.equal(sceneNarrationRoot(), process.env.GM_TOOLS_SCENE_NARRATION_DIR);
  assert.notEqual(sceneNarrationRoot(), REPO_DEFAULT_ROOT);
});

test("SCHEMA_VERSION is exported", () => {
  assert.equal(SCHEMA_VERSION, 1);
});

test("getCurrentSceneNarration: null for a scene with no narration saved yet -- never an error", () => {
  assert.equal(getCurrentSceneNarration(WORLD, "scene-never-narrated"), null);
});

test("getSceneNarrationHistory: [] for a scene with no narration saved yet", () => {
  assert.deepEqual(getSceneNarrationHistory(WORLD, "scene-never-narrated"), []);
});

test("saveSceneNarration: creates a 'current' entry, returned directly and via getCurrentSceneNarration", () => {
  const saved = saveSceneNarration(WORLD, "scene-narr-1", { text: "The chapel is silent, dust hanging in shafts of grey light." }, {
    makeId: () => "snarr-1",
    now: "2026-08-01T00:00:00.000Z"
  });
  assert.equal(saved.narrationId, "snarr-1");
  assert.equal(saved.sceneId, "scene-narr-1");
  assert.equal(saved.text, "The chapel is silent, dust hanging in shafts of grey light.");
  assert.equal(saved.status, "current");
  assert.equal(saved.createdAt, "2026-08-01T00:00:00.000Z");

  const current = getCurrentSceneNarration(WORLD, "scene-narr-1");
  assert.deepEqual(current, saved);
});

test("saveSceneNarration: a second save supersedes the first -- history preserves BOTH, only the newest is 'current'", () => {
  saveSceneNarration(WORLD, "scene-narr-2", { text: "First draft." }, { makeId: () => "snarr-2a", now: "2026-08-01T01:00:00.000Z" });
  saveSceneNarration(WORLD, "scene-narr-2", { text: "Revised draft." }, { makeId: () => "snarr-2b", now: "2026-08-01T02:00:00.000Z" });

  const history = getSceneNarrationHistory(WORLD, "scene-narr-2");
  assert.equal(history.length, 2, "nothing is ever deleted");
  assert.equal(history[0].text, "First draft.");
  assert.equal(history[0].status, "superseded");
  assert.equal(history[1].text, "Revised draft.");
  assert.equal(history[1].status, "current");

  const current = getCurrentSceneNarration(WORLD, "scene-narr-2");
  assert.equal(current.text, "Revised draft.");
  assert.equal(current.narrationId, "snarr-2b");
});

test("saveSceneNarration: only ONE entry may be 'current' at a time, even across three saves", () => {
  saveSceneNarration(WORLD, "scene-narr-3", { text: "v1" }, { makeId: () => "snarr-3a" });
  saveSceneNarration(WORLD, "scene-narr-3", { text: "v2" }, { makeId: () => "snarr-3b" });
  saveSceneNarration(WORLD, "scene-narr-3", { text: "v3" }, { makeId: () => "snarr-3c" });

  const history = getSceneNarrationHistory(WORLD, "scene-narr-3");
  assert.equal(history.length, 3);
  const currentEntries = history.filter((e) => e.status === "current");
  assert.equal(currentEntries.length, 1, "exactly one current entry, ever");
  assert.equal(currentEntries[0].text, "v3");
});

test("supersedeSceneNarration: marks the current entry superseded WITHOUT adding a new one", () => {
  saveSceneNarration(WORLD, "scene-narr-supersede", { text: "The only draft." }, { makeId: () => "snarr-supersede-1" });
  assert.ok(getCurrentSceneNarration(WORLD, "scene-narr-supersede"));

  const updated = supersedeSceneNarration(WORLD, "scene-narr-supersede");
  assert.equal(updated.length, 1, "no new entry added");
  assert.equal(updated[0].status, "superseded");
  assert.equal(getCurrentSceneNarration(WORLD, "scene-narr-supersede"), null, "no longer presents as current");
});

test("supersedeSceneNarration: safe no-op for a scene with no current narration (writes nothing)", () => {
  const result = supersedeSceneNarration(WORLD, "scene-narr-never-saved");
  assert.deepEqual(result, []);
});

test("scene narration is scoped per-scene -- saving for one scene never touches another's history", () => {
  saveSceneNarration(WORLD, "scene-narr-scope-a", { text: "Scene A's own text." }, { makeId: () => "snarr-scope-a" });
  saveSceneNarration(WORLD, "scene-narr-scope-b", { text: "Scene B's own text." }, { makeId: () => "snarr-scope-b" });

  assert.equal(getCurrentSceneNarration(WORLD, "scene-narr-scope-a").text, "Scene A's own text.");
  assert.equal(getCurrentSceneNarration(WORLD, "scene-narr-scope-b").text, "Scene B's own text.");
});

test("no write in this file leaked into the repo's real default scene-narration/ directory", () => {
  const after = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();
  const added = [...after].filter((f) => !before.has(f));
  assert.deepEqual(added, [], `this test run must not add new entries to ${REPO_DEFAULT_ROOT}, found: ${added}`);
});

console.log(`\n${passed} passed`);
rmSync(scratchDir, { recursive: true, force: true });
