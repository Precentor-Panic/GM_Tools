import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — new `mutation-engine/scene-undo.mjs` (Phase 22 task
 * 22.4). This module does not exist yet; this file is the interface spec
 * for it, per plans/phase-22-tasks.md task 22.0. Expected to fail with
 * "Cannot find module" until 22.4 lands.
 *
 * Resolves plans/phase-21-review.md §12's "scene-local rollback" open
 * question exactly as adjudicated: a GENUINE ordered action history scoped
 * to one scene-development session -- NOT mutation-engine/manual-undo.mjs's
 * single global last-write-wins slot copy-pasted under a new name. That
 * module's own header comment is explicit: "there is no history list to
 * push onto" -- this is precisely the gap this new module closes, for the
 * "Develop this scene" flow specifically. Single-node "Develop this node"
 * is UNAFFECTED and keeps using manual-undo.mjs's existing global slot,
 * completely untouched by this module (see the isolation test below).
 *
 * REUSES manual-undo.mjs's UndoAction zod schema (graphMutations/
 * narrationUndo union) by IMPORTING it -- this module must never redefine
 * its own copy of that shape.
 *
 * Storage: file-PER-(world,sceneId)-SESSION -- `<sceneUndoRoot>/<world>/
 * <sceneId>.json`, holding `{ sceneId, world, createdAt, actions:
 * UndoAction[] }`. This is deliberately the SAME per-batch-file-under-a-
 * world-subdir layout mutation-engine/review-state.mjs already uses (per
 * 22.4's own task description: "Store convention matches review-state.mjs's
 * batch-of-mutations shape more closely than manual-undo.mjs's single-slot
 * file"), NOT manual-undo.mjs's single flat-file-per-world layout. Default
 * root is GM_Tools/scene-undo/ (sibling to review-state/, manual-undo/);
 * override with GM_TOOLS_SCENE_UNDO_DIR (tests use this for isolation).
 * Reuses review-state.mjs's withLock/ConcurrentWriteError, same convention
 * as every sibling store.
 *
 * `startSceneUndoSession` ALWAYS (re)initializes a fresh, EMPTY session for
 * that (world, sceneId) pair -- one "Develop this scene" click is one
 * session; it deliberately does not try to merge across separate presses.
 *
 * ---------------------------------------------------------------------------
 * startSceneUndoSession(world, sceneId, opts={}) -> {sceneId, world, createdAt, actions:[]}
 * recordSceneUndoAction(world, sceneId, action) -> the full updated session
 *   `action` is the SAME shape setUndoSlot's own `action` param takes
 *   ({kind, description, graphMutations?, narrationUndo?}) -- validated via
 *   the imported UndoAction schema before being appended. Throws a clear
 *   error if no session has been started yet for this (world, sceneId).
 * listSceneUndoActions(world, sceneId) -> UndoAction[]   (read-only peek, [] if no session)
 * undoLastSceneAction(world, sceneId) -> UndoAction|null
 *   Pops and RETURNS the most-recently-recorded action (does NOT apply its
 *   inverse itself -- matches manual-undo.mjs's consumeUndoSlot's own
 *   "return the data, caller applies it" convention). null if the session
 *   is empty/nonexistent.
 * undoAllSceneActions(world, sceneId) -> UndoAction[]
 *   Pops and returns EVERY recorded action, in REVERSE (most-recent-first)
 *   order, clearing the session's action list. [] if empty/nonexistent.
 * clearSceneUndoSession(world, sceneId) -> void
 *
 * ---------------------------------------------------------------------------
 * THE SINGLE HIGHEST-VALUE PROPERTY (per 22.0's own explicit instruction):
 * this is a genuine ORDERED LIST, not a slot wearing a new name -- two
 * actions against two DIFFERENT entities within one session must BOTH be
 * recoverable, in reverse order. A second, separate test proves
 * manual-undo.mjs's existing global-slot behavior and state are completely
 * unaffected by this new module (no shared mutable state).
 */

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-scene-undo-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_SCENE_UNDO_DIR = join(scratchDir, "scene-undo");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");

const REPO_DEFAULT_ROOT = join(new URL("../../scene-undo", import.meta.url).pathname);
const reposDirBefore = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();

const {
  startSceneUndoSession,
  recordSceneUndoAction,
  listSceneUndoActions,
  undoLastSceneAction,
  undoAllSceneActions,
  clearSceneUndoSession,
  sceneUndoRoot
} = await import("../../mutation-engine/scene-undo.mjs");

const { getUndoSlot, setUndoSlot, manualUndoRoot } = await import("../../mutation-engine/manual-undo.mjs");

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

const WORLD = "scene-undo-test-world";

test("directory isolation: sceneUndoRoot() honors GM_TOOLS_SCENE_UNDO_DIR, never the repo's real default", () => {
  assert.equal(sceneUndoRoot(), process.env.GM_TOOLS_SCENE_UNDO_DIR);
});

test("startSceneUndoSession creates an empty session", () => {
  const session = startSceneUndoSession(WORLD, "scene-x");
  assert.equal(session.sceneId, "scene-x");
  assert.equal(session.world, WORLD);
  assert.ok(session.createdAt);
  assert.deepEqual(session.actions, []);
});

test("listSceneUndoActions on a never-started session returns [], not an error", () => {
  assert.deepEqual(listSceneUndoActions(WORLD, "never-started-scene"), []);
});

test("recordSceneUndoAction on a never-started session throws a clear error", () => {
  assert.throws(() => recordSceneUndoAction(WORLD, "never-started-scene-2", {
    kind: "edit_node",
    description: "x",
    graphMutations: [{ op: "upsert_entity", id: "e1", data: {} }]
  }), /session/i);
});

test("startSceneUndoSession is ALWAYS a fresh reset -- calling it twice discards whatever was recorded between calls", () => {
  startSceneUndoSession(WORLD, "scene-reset");
  recordSceneUndoAction(WORLD, "scene-reset", { kind: "edit_node", description: "one", graphMutations: [{ op: "upsert_entity", id: "e1", data: {} }] });
  assert.equal(listSceneUndoActions(WORLD, "scene-reset").length, 1);

  startSceneUndoSession(WORLD, "scene-reset");
  assert.deepEqual(listSceneUndoActions(WORLD, "scene-reset"), [], "a fresh start must discard the prior session's actions");
});

// -------------------------------------------------------- THE CORE PROPERTY

test("GENUINE ORDERED LIST (not a slot): two actions against TWO DIFFERENT entities in one session -- BOTH recoverable, in reverse order", () => {
  startSceneUndoSession(WORLD, "scene-multi");
  recordSceneUndoAction(WORLD, "scene-multi", {
    kind: "edit_node",
    description: "Developed entity A",
    graphMutations: [{ op: "upsert_entity", id: "entity-a", data: { description: "old-a" } }]
  });
  recordSceneUndoAction(WORLD, "scene-multi", {
    kind: "edit_node",
    description: "Developed entity B",
    graphMutations: [{ op: "upsert_entity", id: "entity-b", data: { description: "old-b" } }]
  });

  const listed = listSceneUndoActions(WORLD, "scene-multi");
  assert.equal(listed.length, 2, "both actions must be present -- a single-slot mechanism would have overwritten the first");
  assert.equal(listed[0].description, "Developed entity A");
  assert.equal(listed[1].description, "Developed entity B");

  // Reverse-order recovery: entity B (recorded last) undoes FIRST.
  const first = undoLastSceneAction(WORLD, "scene-multi");
  assert.equal(first.description, "Developed entity B");
  assert.equal(first.graphMutations[0].id, "entity-b");

  const second = undoLastSceneAction(WORLD, "scene-multi");
  assert.equal(second.description, "Developed entity A");
  assert.equal(second.graphMutations[0].id, "entity-a");

  // Both entities' actions were genuinely recoverable -- the session is now empty.
  assert.equal(undoLastSceneAction(WORLD, "scene-multi"), null, "a third undo on an exhausted session is a safe no-op, not an error");
});

test("undoAllSceneActions: reverses the WHOLE list at once, most-recent-first, and clears the session", () => {
  startSceneUndoSession(WORLD, "scene-undo-all");
  recordSceneUndoAction(WORLD, "scene-undo-all", { kind: "edit_node", description: "first", graphMutations: [{ op: "upsert_entity", id: "e1", data: {} }] });
  recordSceneUndoAction(WORLD, "scene-undo-all", { kind: "edit_node", description: "second", graphMutations: [{ op: "upsert_entity", id: "e2", data: {} }] });
  recordSceneUndoAction(WORLD, "scene-undo-all", { kind: "edit_node", description: "third", graphMutations: [{ op: "upsert_entity", id: "e3", data: {} }] });

  const reversed = undoAllSceneActions(WORLD, "scene-undo-all");
  assert.deepEqual(reversed.map((a) => a.description), ["third", "second", "first"]);
  assert.deepEqual(listSceneUndoActions(WORLD, "scene-undo-all"), [], "the session's action list must be empty after undoAllSceneActions");
});

test("clearSceneUndoSession empties a session without returning its actions", () => {
  startSceneUndoSession(WORLD, "scene-clear");
  recordSceneUndoAction(WORLD, "scene-clear", { kind: "edit_node", description: "x", graphMutations: [{ op: "upsert_entity", id: "e1", data: {} }] });
  clearSceneUndoSession(WORLD, "scene-clear");
  assert.deepEqual(listSceneUndoActions(WORLD, "scene-clear"), []);
});

test("recorded actions validate against manual-undo.mjs's IMPORTED UndoAction schema -- a malformed action (both graphMutations and narrationUndo) is rejected", () => {
  startSceneUndoSession(WORLD, "scene-invalid");
  assert.throws(() => recordSceneUndoAction(WORLD, "scene-invalid", {
    kind: "edit_node",
    description: "bad",
    graphMutations: [{ op: "upsert_entity", id: "e1", data: {} }],
    narrationUndo: { entityId: "e1", priorProse: null }
  }));
});

// -------------------------------------------------------- ISOLATION FROM manual-undo.mjs

test("ISOLATION: manual-undo.mjs's global slot is COMPLETELY UNAFFECTED by scene-undo.mjs activity -- no shared mutable state", () => {
  // Prime the global manual-undo slot for an unrelated world/action.
  setUndoSlot("manual-undo-isolation-world", {
    kind: "add_node",
    description: "an ordinary single-node manual edit, untouched by scene-undo",
    graphMutations: [{ op: "delete_entity", id: "solo-node" }]
  });
  const globalBefore = getUndoSlot("manual-undo-isolation-world");

  // Heavy scene-undo activity in the SAME world id, for good measure.
  startSceneUndoSession("manual-undo-isolation-world", "scene-heavy");
  recordSceneUndoAction("manual-undo-isolation-world", "scene-heavy", { kind: "edit_node", description: "a", graphMutations: [{ op: "upsert_entity", id: "x", data: {} }] });
  recordSceneUndoAction("manual-undo-isolation-world", "scene-heavy", { kind: "edit_node", description: "b", graphMutations: [{ op: "upsert_entity", id: "y", data: {} }] });
  undoLastSceneAction("manual-undo-isolation-world", "scene-heavy");
  undoAllSceneActions("manual-undo-isolation-world", "scene-heavy");
  clearSceneUndoSession("manual-undo-isolation-world", "scene-heavy");

  const globalAfter = getUndoSlot("manual-undo-isolation-world");
  assert.deepEqual(globalAfter, globalBefore, "the global manual-undo slot must be byte-identical before/after ANY amount of scene-undo activity in the same world");
});

test("ISOLATION: scene-undo.mjs's own store directory is COMPLETELY SEPARATE from manual-undo.mjs's -- writing to one never creates files under the other's root", () => {
  const manualUndoDirBefore = existsSync(manualUndoRoot()) ? new Set(readdirSync(manualUndoRoot())) : new Set();
  startSceneUndoSession("isolation-dir-world", "scene-dir-check");
  recordSceneUndoAction("isolation-dir-world", "scene-dir-check", { kind: "edit_node", description: "x", graphMutations: [{ op: "upsert_entity", id: "e1", data: {} }] });
  const manualUndoDirAfter = existsSync(manualUndoRoot()) ? new Set(readdirSync(manualUndoRoot())) : new Set();
  assert.deepEqual(manualUndoDirAfter, manualUndoDirBefore, "scene-undo writes must never land under manual-undo.mjs's own root directory");
});

test("no write in this file leaked into the repo's real default scene-undo/ directory", () => {
  const reposDirAfter = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();
  assert.deepEqual(reposDirAfter, reposDirBefore, "scene-undo.test.mjs must never write into the repo's real default directory");
});

console.log(`\n${passed} test(s) passed.`);
rmSync(scratchDir, { recursive: true, force: true });
