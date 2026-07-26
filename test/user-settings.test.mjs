import assert from "node:assert/strict";
import { mkdtempSync, rmSync, openSync, closeSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate both review-state.mjs (user-settings.mjs reuses its withLock) and
// user-settings.mjs's own root before importing either -- same isolation
// pattern as test/human-review.test.mjs, per Phase 4's own hard-won lesson
// (four existing files once skipped this and polluted the repo's real
// default directory).
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-user-settings-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_USER_SETTINGS_DIR = join(scratchDir, "user-settings");

const REPO_DEFAULT_ROOT = join(new URL("../user-settings", import.meta.url).pathname);

const { getUserSettings, setRubberDuckMode, userSettingsRoot, ConcurrentWriteError } =
  await import("../mutation-engine/user-settings.mjs");

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

test("directory isolation: userSettingsRoot() honors GM_TOOLS_USER_SETTINGS_DIR, never the repo's real default", () => {
  assert.equal(userSettingsRoot(), process.env.GM_TOOLS_USER_SETTINGS_DIR);
  assert.notEqual(userSettingsRoot(), REPO_DEFAULT_ROOT);
});

test("getUserSettings: default state (no file exists yet) is rubberDuckMode.enabled=false, updatedAt=null", () => {
  assert.ok(!existsSync(join(userSettingsRoot(), "settings.json")), "sanity: no file yet");
  const settings = getUserSettings();
  assert.deepEqual(settings, { rubberDuckMode: { enabled: false, updatedAt: null } });
});

test("setRubberDuckMode -> getUserSettings round trip: enabling persists enabled=true and a real updatedAt", () => {
  const updated = setRubberDuckMode(true, { now: "2026-07-22T10:00:00.000Z" });
  assert.equal(updated.rubberDuckMode.enabled, true);
  assert.equal(updated.rubberDuckMode.updatedAt, "2026-07-22T10:00:00.000Z");

  const reread = getUserSettings();
  assert.deepEqual(reread, { rubberDuckMode: { enabled: true, updatedAt: "2026-07-22T10:00:00.000Z" } });
});

test("setRubberDuckMode -> getUserSettings round trip: disabling again persists enabled=false with a NEW updatedAt", () => {
  setRubberDuckMode(true, { now: "2026-07-22T10:00:00.000Z" });
  const updated = setRubberDuckMode(false, { now: "2026-07-22T11:30:00.000Z" });
  assert.equal(updated.rubberDuckMode.enabled, false);
  assert.equal(updated.rubberDuckMode.updatedAt, "2026-07-22T11:30:00.000Z");

  const reread = getUserSettings();
  assert.equal(reread.rubberDuckMode.enabled, false);
  assert.equal(reread.rubberDuckMode.updatedAt, "2026-07-22T11:30:00.000Z");
});

test("setRubberDuckMode: coerces a truthy/falsy non-boolean to a real boolean, doesn't store garbage", () => {
  const updated = setRubberDuckMode(1, { now: "2026-07-22T12:00:00.000Z" });
  assert.strictEqual(updated.rubberDuckMode.enabled, true);
});

// --------------------------------------------------------------- concurrency

test("concurrent write: an existing lock file causes setRubberDuckMode to throw ConcurrentWriteError, not silently clobber", () => {
  // Establish a known starting state.
  setRubberDuckMode(false, { now: "2026-01-01T00:00:00.000Z" });
  const before = getUserSettings();

  const lockPath = join(userSettingsRoot(), "settings.json.lock");
  const fd = openSync(lockPath, "wx");
  try {
    assert.throws(() => setRubberDuckMode(true, { now: "2026-01-02T00:00:00.000Z" }), ConcurrentWriteError);
    // The settings file on disk must be untouched by the rejected write.
    assert.deepEqual(getUserSettings(), before, "settings must be unchanged after a rejected concurrent write");
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }

  // Once the lock clears, a normal write succeeds.
  const updated = setRubberDuckMode(true, { now: "2026-01-03T00:00:00.000Z" });
  assert.equal(updated.rubberDuckMode.enabled, true);
  assert.equal(updated.rubberDuckMode.updatedAt, "2026-01-03T00:00:00.000Z");
});

test("no write in this file leaked into the repo's real default user-settings/ directory (the Phase 4 lesson)", () => {
  assert.ok(!existsSync(REPO_DEFAULT_ROOT), `${REPO_DEFAULT_ROOT} must not exist after a fully-isolated test run`);
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
