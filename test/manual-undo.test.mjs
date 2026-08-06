import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolation: same pattern as entity-narration.test.mjs/human-review.test.mjs
// -- set env vars BEFORE importing the module under test.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-manual-undo-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");

const REPO_DEFAULT_ROOT = join(new URL("../manual-undo", import.meta.url).pathname);
const before = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();

const {
  getUndoSlot,
  setUndoSlot,
  clearUndoSlot,
  consumeUndoSlot,
  UndoAction,
  manualUndoRoot,
  ConcurrentWriteError
} = await import("../mutation-engine/manual-undo.mjs");

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

const WORLD = "manual-undo-test-world";

test("directory isolation: manualUndoRoot() honors GM_TOOLS_MANUAL_UNDO_DIR, never the repo's real default", () => {
  assert.equal(manualUndoRoot(), process.env.GM_TOOLS_MANUAL_UNDO_DIR);
});

test("getUndoSlot returns null for a world with no slot yet", () => {
  assert.equal(getUndoSlot("never-touched-world"), null);
});

test("setUndoSlot -> getUndoSlot round trip for a graph-mutation action", () => {
  const stored = setUndoSlot(WORLD, {
    kind: "add_node",
    description: 'Node "Kaeliss" created.',
    graphMutations: [{ op: "delete_entity", id: "e1" }]
  });
  assert.equal(stored.kind, "add_node");
  assert.equal(stored.world, WORLD);
  assert.deepEqual(stored.graphMutations, [{ op: "delete_entity", id: "e1" }]);
  assert.equal(stored.narrationUndo, null);
  assert.ok(stored.actionId);
  assert.ok(stored.createdAt);

  const fetched = getUndoSlot(WORLD);
  assert.deepEqual(fetched, stored);
});

test("setUndoSlot -> getUndoSlot round trip for a narration-reset action", () => {
  setUndoSlot(WORLD, {
    kind: "narration_reset",
    description: "Narration reset for Alvor.",
    narrationUndo: { entityId: "alvor", priorProse: "Alvor is a blacksmith." }
  });
  const fetched = getUndoSlot(WORLD);
  assert.equal(fetched.kind, "narration_reset");
  assert.equal(fetched.graphMutations, null);
  assert.deepEqual(fetched.narrationUndo, { entityId: "alvor", priorProse: "Alvor is a blacksmith." });
});

test("a narrationUndo with priorProse:null round-trips correctly (the 'nothing was current before reset' case)", () => {
  setUndoSlot(WORLD, {
    kind: "narration_reset",
    description: "Narration reset for a never-narrated entity.",
    narrationUndo: { entityId: "brand-new-npc", priorProse: null }
  });
  const fetched = getUndoSlot(WORLD);
  assert.equal(fetched.narrationUndo.priorProse, null);
});

test("LAST-WRITE-WINS: a second setUndoSlot call OVERWRITES the first, never stacks (a single slot, not a history list)", () => {
  setUndoSlot(WORLD, { kind: "add_node", description: "first", graphMutations: [{ op: "delete_entity", id: "first" }] });
  setUndoSlot(WORLD, { kind: "add_node", description: "second", graphMutations: [{ op: "delete_entity", id: "second" }] });
  const fetched = getUndoSlot(WORLD);
  assert.equal(fetched.description, "second");
  assert.deepEqual(fetched.graphMutations, [{ op: "delete_entity", id: "second" }]);
});

test("clearUndoSlot empties the slot", () => {
  setUndoSlot(WORLD, { kind: "add_node", description: "x", graphMutations: [{ op: "delete_entity", id: "x" }] });
  assert.notEqual(getUndoSlot(WORLD), null);
  clearUndoSlot(WORLD);
  assert.equal(getUndoSlot(WORLD), null);
});

test("consumeUndoSlot returns the action AND clears it atomically -- a second consume returns null", () => {
  setUndoSlot(WORLD, { kind: "delete_node", description: "cascade delete", graphMutations: [{ op: "upsert_entity", id: "n1", data: {} }, { op: "upsert_edge", id: "e1", data: {} }] });
  const first = consumeUndoSlot(WORLD);
  assert.equal(first.kind, "delete_node");
  assert.equal(first.graphMutations.length, 2, "the cascade-delete's node re-create AND its edge re-create travel together as ONE action's mutations array");
  assert.equal(getUndoSlot(WORLD), null, "the slot must be empty immediately after consuming");
  assert.equal(consumeUndoSlot(WORLD), null, "consuming an already-empty slot is a safe no-op, not an error");
});

test("consumeUndoSlot on a never-touched world returns null without creating a file", () => {
  assert.equal(consumeUndoSlot("world-that-never-had-a-slot"), null);
});

test("UndoAction schema rejects an action carrying BOTH graphMutations and narrationUndo", () => {
  assert.throws(() => {
    UndoAction.parse({
      actionId: "x", kind: "add_node", world: WORLD, createdAt: new Date().toISOString(), description: "bad",
      graphMutations: [{ op: "delete_entity", id: "x" }],
      narrationUndo: { entityId: "x", priorProse: null }
    });
  });
});

test("UndoAction schema rejects an action carrying NEITHER graphMutations nor narrationUndo", () => {
  assert.throws(() => {
    UndoAction.parse({
      actionId: "x", kind: "add_node", world: WORLD, createdAt: new Date().toISOString(), description: "bad",
      graphMutations: null,
      narrationUndo: null
    });
  });
});

test("all six manual-write kinds plus reparent_node (Phase 30 task 30.1) and narration_reset are valid ManualUndoKind values", () => {
  for (const kind of ["add_node", "add_edge", "edit_node", "edit_edge", "delete_node", "delete_edge", "reparent_node", "narration_reset"]) {
    assert.doesNotThrow(() => setUndoSlot(`kind-check-${kind}`, {
      kind,
      description: kind,
      ...(kind === "narration_reset" ? { narrationUndo: { entityId: "e", priorProse: null } } : { graphMutations: [] })
    }));
  }
});

test("concurrent write: an existing lock file causes setUndoSlot to throw ConcurrentWriteError, not silently clobber", async () => {
  const { openSync, closeSync } = await import("node:fs");
  const { mkdirSync } = await import("node:fs");
  const filePath = join(manualUndoRoot(), "lock-check-world.json");
  mkdirSync(manualUndoRoot(), { recursive: true });
  const fd = openSync(`${filePath}.lock`, "wx");
  try {
    assert.throws(() => setUndoSlot("lock-check-world", { kind: "add_node", description: "x", graphMutations: [] }), ConcurrentWriteError);
  } finally {
    closeSync(fd);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(`${filePath}.lock`);
  }
});

test("no write in this file leaked into the repo's real default manual-undo/ directory", () => {
  const after = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();
  assert.deepEqual(after, before, "manual-undo.test.mjs must never write into the repo's real default directory");
});

console.log(`\n${passed} test(s) passed.`);
rmSync(scratchDir, { recursive: true, force: true });
