import assert from "node:assert/strict";
import { mkdtempSync, rmSync, openSync, closeSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate both review-state.mjs (entity-narration.mjs reuses its withLock)
// and entity-narration.mjs's own root before importing either -- same
// isolation pattern as test/human-review.test.mjs / test/user-settings.test.mjs,
// per Phase 4's own hard-won lesson (real repo-pollution bugs from skipping
// this).
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-entity-narration-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");

const REPO_DEFAULT_ROOT = join(new URL("../entity-narration", import.meta.url).pathname);
// Snapshot BEFORE importing/running anything -- the meaningful guarantee is
// "this test run didn't ADD anything to the repo's real default directory,"
// not "it's empty/absent" (matching test/user-settings.test.mjs's own
// reasoning).
const before = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();

const {
  getEntityNarrationHistory,
  getCurrentEntityNarration,
  saveEntityNarration,
  supersedeEntityNarration,
  entityNarrationRoot,
  ConcurrentWriteError
} = await import("../mutation-engine/entity-narration.mjs");

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

const WORLD = "wf-test";

// ------------------------------------------------------------------- basics

test("directory isolation: entityNarrationRoot() honors GM_TOOLS_ENTITY_NARRATION_DIR, never the repo's real default", () => {
  assert.equal(entityNarrationRoot(), process.env.GM_TOOLS_ENTITY_NARRATION_DIR);
  assert.notEqual(entityNarrationRoot(), REPO_DEFAULT_ROOT);
});

test("getEntityNarrationHistory: an entity never narrated returns an empty array, not an error", () => {
  assert.deepEqual(getEntityNarrationHistory(WORLD, "never-narrated"), []);
});

test("getCurrentEntityNarration: an entity never narrated returns null", () => {
  assert.equal(getCurrentEntityNarration(WORLD, "never-narrated"), null);
});

test("save-then-get round trip: saving persists prose retrievable via both history and current", () => {
  const entity = "alvor";
  saveEntityNarration(
    WORLD,
    entity,
    { prose: "The forge falls silent.", sourceMutationId: "m0", sourceBatchId: "batch1" },
    { now: "2026-01-01T00:00:00.000Z", makeId: () => "n1" }
  );

  const current = getCurrentEntityNarration(WORLD, entity);
  assert.ok(current, "should have a current entry");
  assert.equal(current.prose, "The forge falls silent.");
  assert.equal(current.status, "current");
  assert.equal(current.sourceMutationId, "m0");
  assert.equal(current.sourceBatchId, "batch1");
  assert.equal(current.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(current.narrationId, "n1");

  const history = getEntityNarrationHistory(WORLD, entity);
  assert.equal(history.length, 1);
});

test("THE CORE REQUIREMENT: a second save supersedes the first -- BOTH remain in history, only the newer is 'current'", () => {
  const entity = "gerdur";
  saveEntityNarration(WORLD, entity, { prose: "First narration.", sourceMutationId: "m0", sourceBatchId: "batch1" }, { now: "2026-01-01T00:00:00.000Z", makeId: () => "n1" });
  saveEntityNarration(WORLD, entity, { prose: "Second narration.", sourceMutationId: "m1", sourceBatchId: "batch2" }, { now: "2026-02-01T00:00:00.000Z", makeId: () => "n2" });

  const history = getEntityNarrationHistory(WORLD, entity);
  assert.equal(history.length, 2, "nothing was deleted -- a real history, not an overwritten latest value");

  const first = history.find((e) => e.narrationId === "n1");
  const second = history.find((e) => e.narrationId === "n2");
  assert.equal(first.status, "superseded");
  assert.equal(first.prose, "First narration.", "superseded entries keep their original prose, recallable later");
  assert.equal(second.status, "current");

  const current = getCurrentEntityNarration(WORLD, entity);
  assert.equal(current.narrationId, "n2");
  assert.equal(current.prose, "Second narration.");
});

test("only one entry may be 'current' at a time, even after several saves", () => {
  const entity = "sven";
  for (let i = 0; i < 5; i++) {
    saveEntityNarration(WORLD, entity, { prose: `Narration ${i}.`, sourceMutationId: `m${i}`, sourceBatchId: `batch${i}` }, { now: `2026-0${i + 1}-01T00:00:00.000Z`, makeId: () => `n${i}` });
  }
  const history = getEntityNarrationHistory(WORLD, entity);
  assert.equal(history.length, 5);
  const currentEntries = history.filter((e) => e.status === "current");
  assert.equal(currentEntries.length, 1);
  assert.equal(currentEntries[0].narrationId, "n4");
});

// --------------------------------------------------------------- supersede

test("supersedeEntityNarration: marks the current entry superseded without adding a new one -- history is still readable afterward", () => {
  const entity = "riverwood";
  saveEntityNarration(WORLD, entity, { prose: "Original narration.", sourceMutationId: "m0", sourceBatchId: "batch1" }, { now: "2026-01-01T00:00:00.000Z", makeId: () => "n1" });

  const before = getEntityNarrationHistory(WORLD, entity);
  assert.equal(before.length, 1);

  supersedeEntityNarration(WORLD, entity);

  const after = getEntityNarrationHistory(WORLD, entity);
  assert.equal(after.length, 1, "no new entry added -- supersede alone doesn't create a narration");
  assert.equal(after[0].status, "superseded");
  assert.equal(after[0].prose, "Original narration.", "the original prose remains readable from history");
  assert.equal(getCurrentEntityNarration(WORLD, entity), null, "nothing presents as current anymore");
});

test("supersedeEntityNarration on an entity with no narration yet is a safe no-op", () => {
  const entity = "never-touched-entity";
  assert.doesNotThrow(() => supersedeEntityNarration(WORLD, entity));
  assert.deepEqual(getEntityNarrationHistory(WORLD, entity), []);
  assert.equal(getCurrentEntityNarration(WORLD, entity), null);
});

// --------------------------------------------------------------- concurrency

test("concurrent write: an existing lock file causes saveEntityNarration to throw ConcurrentWriteError, not silently clobber", () => {
  const entity = "concurrent-entity";
  saveEntityNarration(WORLD, entity, { prose: "Before the lock.", sourceMutationId: "m0", sourceBatchId: "batch1" }, { now: "2026-01-01T00:00:00.000Z", makeId: () => "n1" });
  const beforeHistory = getEntityNarrationHistory(WORLD, entity);

  const lockPath = join(entityNarrationRoot(), WORLD, `${entity}.json.lock`);
  const fd = openSync(lockPath, "wx");
  try {
    assert.throws(
      () => saveEntityNarration(WORLD, entity, { prose: "Should not be written.", sourceMutationId: "m1", sourceBatchId: "batch2" }, { now: "2026-01-02T00:00:00.000Z" }),
      ConcurrentWriteError
    );
    assert.deepEqual(getEntityNarrationHistory(WORLD, entity), beforeHistory, "history must be unchanged after a rejected concurrent write");
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }

  // Once the lock clears, a normal write succeeds.
  saveEntityNarration(WORLD, entity, { prose: "After the lock clears.", sourceMutationId: "m1", sourceBatchId: "batch2" }, { now: "2026-01-03T00:00:00.000Z", makeId: () => "n2" });
  assert.equal(getCurrentEntityNarration(WORLD, entity).prose, "After the lock clears.");
});

test("no write in this file leaked into the repo's real default entity-narration/ directory (the Phase 4 lesson)", () => {
  const after = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();
  const added = [...after].filter((f) => !before.has(f));
  assert.deepEqual(added, [], `this test run must not add new entries to ${REPO_DEFAULT_ROOT}, found: ${added}`);
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
