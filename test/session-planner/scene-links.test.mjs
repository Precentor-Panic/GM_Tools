import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — session-planner/scene-links.mjs (Phase 26 task 26.3,
 * extended Phase 27 task 27.3, F12). Explicit scene-to-scene links, entirely
 * OUTSIDE the World Fabric graph. This is the first dedicated unit-test file
 * for this module (it previously had only e2e/route coverage) -- written
 * while extending it for the optional `graphEdgeId` field, per
 * gm-tools-conventions' "deterministic logic must have unit tests before
 * done" and the Phase 27 task 27.3 grounding instruction to "put new tests
 * where the sibling tests already live."
 *
 * Record shape (SCHEMA_VERSION 2): `{sceneId, linkedSceneId, reason:string|
 * null, graphEdgeId:string|null}`. `graphEdgeId` is purely additive relative
 * to the original (SCHEMA_VERSION-1, pre-27.3) shape -- a record that never
 * had it simply reads as `graphEdgeId: null`, no normalize-on-read step
 * needed (unlike saved-encounter.mjs's field-rename).
 *
 * linkScenes(world, sceneIdA, sceneIdB, reason?, graphEdgeId?) is idempotent
 * by UNORDERED pair: re-linking an already-linked pair updates the existing
 * record (reason and/or graphEdgeId, whichever is supplied) rather than
 * creating a second record. getLinkedScenes(world, sceneId) is a
 * bidirectional query returning one entry per OTHER linked scene, each
 * carrying {sceneId, reason, graphEdgeId}. unlinkScenes(world, sceneIdA,
 * sceneIdB) is idempotent and returns {removed, link} -- `link` is the
 * REMOVED record (as-stored orientation) so a caller can target its
 * graphEdgeId for a real graph-edge break, or null when nothing matched.
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

// Isolate BOTH review-state.mjs (scene-links.mjs reuses its withLock) and
// scene-links.mjs's own root BEFORE importing either -- same pattern as
// test/session-planner/scenes.test.mjs.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-scene-links-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_SCENE_LINKS_DIR = join(scratchDir, "scene-links");

const REPO_DEFAULT_ROOT = join(new URL("../../scene-links", import.meta.url).pathname);
const before = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();

const WORLD = "scene-links-test-world";

const { linkScenes, unlinkScenes, getLinkedScenes, sceneLinksRoot, SCHEMA_VERSION } =
  await import("../../session-planner/scene-links.mjs");

test("directory isolation: sceneLinksRoot() honors GM_TOOLS_SCENE_LINKS_DIR, never the repo's real default", () => {
  assert.equal(sceneLinksRoot(), process.env.GM_TOOLS_SCENE_LINKS_DIR);
  assert.notEqual(sceneLinksRoot(), REPO_DEFAULT_ROOT);
});

test("SCHEMA_VERSION is exported (2 = the optional graphEdgeId field)", () => {
  assert.equal(SCHEMA_VERSION, 2);
});

test("getLinkedScenes: [] for a scene with no links yet -- not an error", () => {
  assert.deepEqual(getLinkedScenes(WORLD, "scene-never-linked"), []);
});

test("linkScenes: creates a link, no graphEdgeId supplied -> graphEdgeId reads as null", () => {
  const link = linkScenes(WORLD, "scene-a", "scene-b", "adjacent rooms");
  assert.equal(link.sceneId, "scene-a");
  assert.equal(link.linkedSceneId, "scene-b");
  assert.equal(link.reason, "adjacent rooms");
  assert.equal(link.graphEdgeId, null, "no graphEdgeId supplied must read as null, not undefined");

  const linkedFromA = getLinkedScenes(WORLD, "scene-a");
  assert.equal(linkedFromA.length, 1);
  assert.deepEqual(linkedFromA[0], { sceneId: "scene-b", reason: "adjacent rooms", graphEdgeId: null });
});

test("linkScenes: bidirectional query -- getLinkedScenes surfaces the link from BOTH sides regardless of stored orientation", () => {
  linkScenes(WORLD, "scene-bidir-x", "scene-bidir-y", "same hallway", "edge-bidir-1");
  const fromX = getLinkedScenes(WORLD, "scene-bidir-x");
  const fromY = getLinkedScenes(WORLD, "scene-bidir-y");
  assert.deepEqual(fromX, [{ sceneId: "scene-bidir-y", reason: "same hallway", graphEdgeId: "edge-bidir-1" }]);
  assert.deepEqual(fromY, [{ sceneId: "scene-bidir-x", reason: "same hallway", graphEdgeId: "edge-bidir-1" }]);
});

// ------------------------------------------------- Phase 27 task 27.3 (F12)

test("graphEdgeId round-trip: linkScenes stores it, getLinkedScenes echoes it per entry", () => {
  linkScenes(WORLD, "scene-edge-a", "scene-edge-b", "pushed a real graph edge", "edge-abc-123");
  const linked = getLinkedScenes(WORLD, "scene-edge-a");
  assert.equal(linked.length, 1);
  assert.equal(linked[0].graphEdgeId, "edge-abc-123");
});

test("idempotent re-link UPDATES graphEdgeId on the existing record rather than duplicating", () => {
  linkScenes(WORLD, "scene-relink-a", "scene-relink-b", "first link, no graph push yet");
  const beforeUpdate = getLinkedScenes(WORLD, "scene-relink-a");
  assert.equal(beforeUpdate.length, 1);
  assert.equal(beforeUpdate[0].graphEdgeId, null);

  // Re-link the SAME unordered pair, this time supplying a graphEdgeId (the
  // "push a graph link" confirm-yes path, per the design record).
  const relinked = linkScenes(WORLD, "scene-relink-a", "scene-relink-b", undefined, "edge-added-later");
  assert.equal(relinked.graphEdgeId, "edge-added-later");

  const afterUpdate = getLinkedScenes(WORLD, "scene-relink-a");
  assert.equal(afterUpdate.length, 1, "still exactly ONE record for this pair -- never duplicated");
  assert.equal(afterUpdate[0].graphEdgeId, "edge-added-later");

  // Also idempotent from the OTHER orientation (sceneIdA/sceneIdB swapped).
  const relinkedSwapped = linkScenes(WORLD, "scene-relink-b", "scene-relink-a", undefined, "edge-final");
  assert.equal(relinkedSwapped.graphEdgeId, "edge-final");
  assert.equal(getLinkedScenes(WORLD, "scene-relink-a").length, 1, "still only one record after a swapped-orientation relink");
});

test("linkScenes: re-linking without supplying reason/graphEdgeId leaves the existing record's own values untouched", () => {
  linkScenes(WORLD, "scene-preserve-a", "scene-preserve-b", "original reason", "original-edge");
  const unchanged = linkScenes(WORLD, "scene-preserve-a", "scene-preserve-b");
  assert.equal(unchanged.reason, "original reason", "omitting reason on relink must not clear the existing one");
  assert.equal(unchanged.graphEdgeId, "original-edge", "omitting graphEdgeId on relink must not clear the existing one");
});

test("unlinkScenes: returns {removed:true, link} -- the REMOVED record (as-stored orientation), including its graphEdgeId", () => {
  linkScenes(WORLD, "scene-unlink-a", "scene-unlink-b", "will be broken", "edge-to-break");
  const result = unlinkScenes(WORLD, "scene-unlink-a", "scene-unlink-b");
  assert.equal(result.removed, true);
  assert.ok(result.link, "must return the removed record, not just a boolean");
  assert.equal(result.link.sceneId, "scene-unlink-a");
  assert.equal(result.link.linkedSceneId, "scene-unlink-b");
  assert.equal(result.link.reason, "will be broken");
  assert.equal(result.link.graphEdgeId, "edge-to-break", "the removed record's graphEdgeId is exactly what a caller needs to target the specific edge for a break");

  assert.deepEqual(getLinkedScenes(WORLD, "scene-unlink-a"), [], "the link is genuinely gone");
});

test("unlinkScenes: unlinking an absent pair is a safe no-op, returns {removed:false, link:null}", () => {
  const result = unlinkScenes(WORLD, "scene-never-linked-x", "scene-never-linked-y");
  assert.deepEqual(result, { removed: false, link: null });
});

test("unlinkScenes: works from either orientation of the unordered pair", () => {
  linkScenes(WORLD, "scene-orient-a", "scene-orient-b", "reason", "edge-orient");
  const result = unlinkScenes(WORLD, "scene-orient-b", "scene-orient-a");
  assert.equal(result.removed, true);
  assert.equal(result.link.graphEdgeId, "edge-orient");
});

test("existing scene-links tests still green: a record without graphEdgeId ever stored reads back as graphEdgeId:null, not undefined/missing -- backward compatible", () => {
  linkScenes(WORLD, "scene-backcompat-a", "scene-backcompat-b", "plain link, no edge");
  const linked = getLinkedScenes(WORLD, "scene-backcompat-a");
  assert.equal(linked[0].graphEdgeId, null);
  assert.ok("graphEdgeId" in linked[0], "the field is always present on the returned shape, even when null");
});

test("no Foundry-facing import anywhere in scene-links.mjs", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../session-planner/scene-links.mjs", import.meta.url), "utf8");
  assert.ok(!/foundry_worldFabric/.test(src));
  assert.ok(!/graph-service/i.test(src));
});

test("no write in this file leaked into the repo's real default scene-links/ directory", () => {
  const after = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();
  const added = [...after].filter((f) => !before.has(f));
  assert.deepEqual(added, [], `this test run must not add new entries to ${REPO_DEFAULT_ROOT}, found: ${added}`);
});

console.log(`\n${passed} passed`);
rmSync(scratchDir, { recursive: true, force: true });
