import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — session-planner/chronicle-run.mjs (Phase 37 task
 * 37.1): a tiny per-batch sidecar file, 1:1 keyed to an existing
 * review-state.mjs batch, {batchId, span, fortuneAtRun, elapsedSessions,
 * createdAt}. getChronicleRun returns null (not a throw) for any batch
 * without a sidecar.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-chronicle-run-test-"));
process.env.GM_TOOLS_CHRONICLE_RUN_DIR = join(scratchDir, "chronicle-run");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state"); // transitively needed for withLock

const { recordChronicleRun, getChronicleRun, chronicleRunRoot, SCHEMA_VERSION } = await import("../../session-planner/chronicle-run.mjs");

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

test("SCHEMA_VERSION is exported per gm-tools-conventions' schema-versioning discipline", () => {
  assert.equal(typeof SCHEMA_VERSION, "number");
});

test("chronicleRunRoot() honors GM_TOOLS_CHRONICLE_RUN_DIR", () => {
  assert.equal(chronicleRunRoot(), join(scratchDir, "chronicle-run"));
});

test("getChronicleRun: returns null (not a throw) for a batch with no sidecar -- a real, valid 'not a Chronicle-run batch' state", () => {
  assert.equal(getChronicleRun(WORLD, "batch_never_recorded"), null);
});

test("recordChronicleRun/getChronicleRun: round-trips span/fortuneAtRun/elapsedSessions exactly", () => {
  const recorded = recordChronicleRun(WORLD, "batch_cr1", {
    span: { spanId: "week" },
    fortuneAtRun: "ruinous",
    elapsedSessions: 1
  });
  assert.equal(recorded.batchId, "batch_cr1");
  assert.deepEqual(recorded.span, { spanId: "week" });
  assert.equal(recorded.fortuneAtRun, "ruinous");
  assert.equal(recorded.elapsedSessions, 1);
  assert.equal(typeof recorded.createdAt, "string");

  const fetched = getChronicleRun(WORLD, "batch_cr1");
  assert.deepEqual(fetched, recorded);
});

test("recordChronicleRun: also accepts an explicit-days span shape", () => {
  const recorded = recordChronicleRun(WORLD, "batch_cr2", { span: { days: 14 }, fortuneAtRun: "fair", elapsedSessions: 2 });
  assert.deepEqual(recorded.span, { days: 14 });
});

test("chronicle-run sidecars are keyed per (world, batchId) -- two different worlds don't collide", () => {
  recordChronicleRun("world-a", "batch_shared_id", { span: { spanId: "week" }, fortuneAtRun: "fair", elapsedSessions: 1 });
  recordChronicleRun("world-b", "batch_shared_id", { span: { spanId: "month" }, fortuneAtRun: "lean", elapsedSessions: 4 });
  assert.equal(getChronicleRun("world-a", "batch_shared_id").fortuneAtRun, "fair");
  assert.equal(getChronicleRun("world-b", "batch_shared_id").fortuneAtRun, "lean");
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
