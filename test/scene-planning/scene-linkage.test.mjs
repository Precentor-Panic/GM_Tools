import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — new `session-planner/scene-linkage.mjs` (Phase 22
 * task 22.1). This module does not exist yet; this file is the interface
 * spec for it, per plans/phase-22-tasks.md task 22.0. Expected to fail with
 * "Cannot find module" until 22.1 lands.
 *
 * Resolves plans/phase-21-review.md §12's "scene-to-scene linkage" open
 * question exactly as adjudicated: DERIVED on demand from World Fabric
 * graph adjacency, never stored on the scene record. No new persisted
 * field anywhere — `session-planner/scenes.mjs` (createScene/forkScene/
 * getScene/listScenesForWorld) is used completely unmodified, imported
 * read-only.
 *
 * ---------------------------------------------------------------------------
 * export const DEFAULT_LINKAGE_MAX_HOPS = 4
 * ---------------------------------------------------------------------------
 * The default hop-distance ceiling for "nearby enough to surface as
 * linked" — a plain exported constant, overridable per-call via
 * opts.maxHops. Deliberately looser than session-planner/corridor.mjs's own
 * 1-hop scene-MEMBERSHIP default: this is a *discovery/browse* query (Phase
 * 24's Scenes tab), not a membership boundary, so a wider net is correct.
 *
 * ---------------------------------------------------------------------------
 * linkedScenesForScene(world, sceneId, snapshot, opts = {})
 * ---------------------------------------------------------------------------
 *   @param {string} world
 *   @param {string} sceneId              an existing scene id (session-planner/scenes.mjs)
 *   @param {{entities:object[], edges:object[]}} snapshot
 *                                        the CALLER-loaded live World Fabric
 *                                        snapshot — this function performs
 *                                        NO snapshot I/O of its own (matches
 *                                        session-planner/corridor.mjs's own
 *                                        "pure functions over already-loaded
 *                                        data" convention).
 *   @param {number} [opts.maxHops]       default DEFAULT_LINKAGE_MAX_HOPS
 *   @returns {Array<{sceneId:string, anchorEntityId:string, anchorEntityName:string, hopDistance:number}>}
 *     Every OTHER scene in `world` (never sceneId itself) whose own
 *     `locationEntityId` sits within opts.maxHops hops of the QUERIED
 *     scene's own `locationEntityId`, sorted ascending by hopDistance. A
 *     scene with `locationEntityId: null` (untethered) is NEVER returned as
 *     a linkage target (nothing to derive adjacency from), and if the
 *     QUERIED scene itself has `locationEntityId: null`, the result is `[]`
 *     unconditionally (no snapshot traversal even attempted).
 *
 *   The ONE piece of store I/O this function performs is a READ-ONLY call to
 *   session-planner/scenes.mjs's getScene(world, sceneId) (throws the same
 *   "No scene found" Error if unknown — not caught/reinterpreted) and
 *   listScenesForWorld(world) — it derives, it never writes a linkage field
 *   to any scene record, ever. Implementation is expected to compose
 *   session-planner/corridor.mjs's corridorNodes()  (already exported,
 *   already hop-distance-tagged) over a single-node path
 *   ([scene.locationEntityId]) rather than reimplementing BFS — no new
 *   graph-traversal algorithm should exist in this module's own source.
 *
 * ---------------------------------------------------------------------------
 * PURITY (the single highest-value property of this task, per 22.0's own
 * explicit instruction): linkage derivation never persists anything, and is
 * side-effect-free / idempotent against unchanged state.
 * ---------------------------------------------------------------------------
 */

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-scene-linkage-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");

const { linkedScenesForScene, DEFAULT_LINKAGE_MAX_HOPS } = await import("../../session-planner/scene-linkage.mjs");
const { createScene } = await import("../../session-planner/scenes.mjs");

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

const WORLD = "scene-linkage-test-world";

// -----------------------------------------------------------------------
// Fixture: a straight 6-node chain a-b-c-d-e-f, hop distance from 'a' is
// exactly its index (a=0, b=1, c=2, d=3, e=4, f=5).
// -----------------------------------------------------------------------
function chainSnapshot() {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const entities = ids.map((id) => ({ id, name: id.toUpperCase(), type: "place", importance: 0.5 }));
  const edges = [];
  for (let i = 0; i < ids.length - 1; i++) {
    edges.push({ id: `e${i}`, sourceId: ids[i], targetId: ids[i + 1], relationshipType: "unspecified" });
  }
  return { entities, edges };
}

function seedScenes() {
  const sceneA = createScene(WORLD, { locationEntityId: "a" });
  const sceneC = createScene(WORLD, { locationEntityId: "c" }); // hop 2 from a
  const sceneF = createScene(WORLD, { locationEntityId: "f" }); // hop 5 from a
  const sceneUntethered = createScene(WORLD, { locationEntityId: null });
  return { sceneA, sceneC, sceneF, sceneUntethered };
}

test("DEFAULT_LINKAGE_MAX_HOPS is a real positive number, exported", () => {
  assert.equal(typeof DEFAULT_LINKAGE_MAX_HOPS, "number");
  assert.ok(DEFAULT_LINKAGE_MAX_HOPS > 0);
});

test("returns the within-default-range scene (hop 2), excludes the itself scene, the untethered scene, and the beyond-default-range scene (hop 5)", () => {
  const { sceneA, sceneC } = seedScenes();
  const linked = linkedScenesForScene(WORLD, sceneA.id, chainSnapshot());
  assert.equal(linked.length, 1, "only sceneC (hop 2) should be within DEFAULT_LINKAGE_MAX_HOPS=4");
  assert.equal(linked[0].sceneId, sceneC.id);
  assert.equal(linked[0].anchorEntityId, "c");
  assert.equal(linked[0].anchorEntityName, "C");
  assert.equal(linked[0].hopDistance, 2);
});

test("raising opts.maxHops surfaces the further scene too, sorted ascending by hopDistance", () => {
  const { sceneA, sceneC, sceneF } = seedScenes();
  const linked = linkedScenesForScene(WORLD, sceneA.id, chainSnapshot(), { maxHops: 6 });
  assert.equal(linked.length, 2);
  assert.deepEqual(linked.map((l) => l.sceneId), [sceneC.id, sceneF.id], "ascending hop order");
  assert.equal(linked[1].hopDistance, 5);
});

test("a scene with locationEntityId:null returns [] unconditionally, no traversal attempted", () => {
  const { sceneUntethered } = seedScenes();
  const linked = linkedScenesForScene(WORLD, sceneUntethered.id, chainSnapshot(), { maxHops: 100 });
  assert.deepEqual(linked, []);
});

test("throws the same 'No scene found' error getScene throws, for an unknown sceneId", () => {
  assert.throws(() => linkedScenesForScene(WORLD, "does-not-exist", chainSnapshot()), /No scene found/);
});

// -------------------------------------------------------------- PURITY

test("PURITY: repeated calls against unchanged state return deep-equal results (genuinely derived, never cached-and-drifting)", () => {
  const { sceneA } = seedScenes();
  const snap = chainSnapshot();
  const first = linkedScenesForScene(WORLD, sceneA.id, snap);
  const second = linkedScenesForScene(WORLD, sceneA.id, snap);
  const third = linkedScenesForScene(WORLD, sceneA.id, snap);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
});

test("PURITY: never writes -- session-scenes store directory listing AND every file's content are byte-identical before/after a call", () => {
  const { sceneA } = seedScenes();
  const dir = process.env.GM_TOOLS_SESSION_SCENES_DIR;
  const filesBefore = readdirSync(dir).sort();
  const contentsBefore = Object.fromEntries(filesBefore.map((f) => [f, readFileSync(join(dir, f), "utf8")]));

  linkedScenesForScene(WORLD, sceneA.id, chainSnapshot(), { maxHops: 6 });

  const filesAfter = readdirSync(dir).sort();
  const contentsAfter = Object.fromEntries(filesAfter.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
  assert.deepEqual(filesAfter, filesBefore, "no new/removed files in the session-scenes store");
  assert.deepEqual(contentsAfter, contentsBefore, "no existing scene file was rewritten");
});

test("PURITY: does not mutate the caller-supplied snapshot object (entities/edges arrays untouched)", () => {
  const { sceneA } = seedScenes();
  const snap = chainSnapshot();
  const snapJsonBefore = JSON.stringify(snap);
  linkedScenesForScene(WORLD, sceneA.id, snap, { maxHops: 6 });
  assert.equal(JSON.stringify(snap), snapJsonBefore, "snapshot must be read-only from this function's perspective");
});

console.log(`\n${passed} test(s) passed.`);
rmSync(scratchDir, { recursive: true, force: true });
