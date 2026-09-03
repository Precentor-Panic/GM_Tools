import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — session-planner/truth-notes.mjs. Store CRUD +
 * supersede-never-delete, cloned from mutation-engine/entity-narration.mjs's
 * exact history/supersede pattern one level up (keyed by planId instead of
 * entityId). Also the standing "no write leaked into the repo's real
 * default directory" regression test, copied from test/user-settings.test.mjs's
 * snapshot-before pattern.
 */

// Isolate the store root (and review-state, whose withLock it reuses) BEFORE
// importing -- same isolation pattern as every sibling store's own test file.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-truth-notes-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_TRUTH_NOTES_DIR = join(scratchDir, "truth-notes");

const REPO_DEFAULT_ROOT = join(new URL("../../truth-notes", import.meta.url).pathname);
// Snapshot BEFORE importing/running anything -- the repo's real default
// directory legitimately has a .gitkeep in it, so the meaningful guarantee
// is "this test run didn't ADD anything," not "it's empty."
const before = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();

const {
  SCHEMA_VERSION,
  truthNotesRoot,
  getCurrentTruthNotes,
  getTruthNotesHistory,
  saveTruthNotes,
  ConcurrentWriteError
} = await import("../../session-planner/truth-notes.mjs");

const WORLD = "truth-notes-test-world";
const PLAN_ID = "plan-tn-1";

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

// ------------------------------------------------------------------- basics

test("schema version exported", () => {
  assert.equal(SCHEMA_VERSION, 1);
});

test("directory isolation: truthNotesRoot() honors GM_TOOLS_TRUTH_NOTES_DIR, never the repo's real default", () => {
  assert.equal(truthNotesRoot(), process.env.GM_TOOLS_TRUTH_NOTES_DIR);
  assert.notEqual(truthNotesRoot(), REPO_DEFAULT_ROOT);
});

test("getTruthNotesHistory / getCurrentTruthNotes: [] / null for a plan with no saved notes yet -- not an error", () => {
  assert.deepEqual(getTruthNotesHistory(WORLD, PLAN_ID), []);
  assert.equal(getCurrentTruthNotes(WORLD, PLAN_ID), null);
});

test("saveTruthNotes: creates the first entry as 'current'", () => {
  const entry = saveTruthNotes(
    WORLD,
    PLAN_ID,
    { sessionNumber: 3, revealedEntityIds: ["ent-a"], markdown: "You learned ent-a's secret." },
    { now: "2026-09-02T10:00:00.000Z", makeId: () => "tnote-1" }
  );
  assert.deepEqual(entry, {
    id: "tnote-1",
    createdAt: "2026-09-02T10:00:00.000Z",
    sessionNumber: 3,
    revealedEntityIds: ["ent-a"],
    markdown: "You learned ent-a's secret.",
    status: "current"
  });
  assert.equal(getCurrentTruthNotes(WORLD, PLAN_ID).id, "tnote-1");
});

test("saveTruthNotes: a second save SUPERSEDES the first (still present, never deleted) and becomes current", () => {
  saveTruthNotes(
    WORLD,
    PLAN_ID,
    { sessionNumber: 4, revealedEntityIds: ["ent-a", "ent-b"], markdown: "You learned more." },
    { now: "2026-09-02T11:00:00.000Z", makeId: () => "tnote-2" }
  );

  const history = getTruthNotesHistory(WORLD, PLAN_ID);
  assert.equal(history.length, 2);
  assert.equal(history[0].id, "tnote-1");
  assert.equal(history[0].status, "superseded", "never deleted, just marked superseded");
  assert.equal(history[1].id, "tnote-2");
  assert.equal(history[1].status, "current");

  const current = getCurrentTruthNotes(WORLD, PLAN_ID);
  assert.equal(current.id, "tnote-2");
  assert.deepEqual(current.revealedEntityIds, ["ent-a", "ent-b"]);
});

test("saveTruthNotes: sessionNumber defaults to null when omitted; revealedEntityIds defaults to []", () => {
  const entry = saveTruthNotes(WORLD, "plan-tn-defaults", { markdown: "Nothing revealed yet." }, { now: "2026-09-02T12:00:00.000Z", makeId: () => "tnote-defaults" });
  assert.equal(entry.sessionNumber, null);
  assert.deepEqual(entry.revealedEntityIds, []);
});

test("different plans in the same world keep fully independent histories", () => {
  saveTruthNotes(WORLD, "plan-tn-other", { sessionNumber: 1, revealedEntityIds: ["ent-z"], markdown: "A different plan's own recap." }, { now: "2026-09-02T13:00:00.000Z", makeId: () => "tnote-other" });
  assert.equal(getTruthNotesHistory(WORLD, PLAN_ID).length, 2, "the original plan's history is untouched by a save to a different plan");
  assert.equal(getCurrentTruthNotes(WORLD, "plan-tn-other").id, "tnote-other");
});

// --------------------------------------------------------------- concurrency

test("concurrent write: an existing lock file causes saveTruthNotes to throw ConcurrentWriteError, not silently clobber", () => {
  const lockPath = join(truthNotesRoot(), WORLD, `${PLAN_ID}.json.lock`);
  const fd = openSync(lockPath, "wx");
  const before = getTruthNotesHistory(WORLD, PLAN_ID);
  try {
    assert.throws(() => saveTruthNotes(WORLD, PLAN_ID, { markdown: "should not persist" }, { now: "2026-09-02T14:00:00.000Z" }), ConcurrentWriteError);
    assert.deepEqual(getTruthNotesHistory(WORLD, PLAN_ID), before, "history must be unchanged after a rejected concurrent write");
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
});

// ------------------------------------------------------------- no-leak regression

test("no write in this file leaked into the repo's real default truth-notes/ directory (the recurring gap this project's own .gitignore comments call out)", () => {
  const after = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();
  const added = [...after].filter((f) => !before.has(f));
  assert.deepEqual(added, [], `this test run must not add new entries to ${REPO_DEFAULT_ROOT}, found: ${added}`);
});

console.log(`\n${passed} passed`);
rmSync(scratchDir, { recursive: true, force: true });
