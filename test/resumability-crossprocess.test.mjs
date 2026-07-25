import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Phase 2 task 2.2's hard requirement: "a real cross-process kill-and-resume,
 * not just an in-process simulation" (test/resumability.test.mjs covers the
 * in-process/mocked-throw case; this file covers the real-process case that
 * category of gap-in-testing was specifically called out to require).
 *
 * Spawns test/fixtures/timeskip-worker.mjs as an actual child `node`
 * process, lets it complete one region's real (mocked-client, no network)
 * texture call, SIGKILLs it mid-delay before it can start a second, then
 * spawns a completely FRESH child process (no shared memory with the first)
 * pointed at the same batchId/status dir and confirms it resumes correctly
 * by reading the status file from disk -- not from any in-memory state,
 * since a fresh process has none.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, "fixtures", "timeskip-worker.mjs");

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-crossprocess-test-"));
const reviewStateDir = join(scratchDir, "review-state");
const statusDir = join(scratchDir, "time-skip-status");
const callLogPath = join(scratchDir, "calls.log");

const WORLD = "crossprocess-test-world";
const BATCH_ID = "batch_crossprocess_1";
const DELAY_MS = 300; // generous window for the kill signal to land well before a second call could start

function countCallLines() {
  if (!existsSync(callLogPath)) return 0;
  return readFileSync(callLogPath, "utf8").split("\n").filter((l) => l.trim() === "call").length;
}

function spawnWorker(extraEnv = {}) {
  return spawn(process.execPath, [WORKER_PATH], {
    env: {
      ...process.env,
      GM_TOOLS_REVIEW_STATE_DIR: reviewStateDir,
      GM_TOOLS_TIMESKIP_STATUS_DIR: statusDir,
      WORKER_WORLD: WORLD,
      WORKER_BATCH_ID: BATCH_ID,
      WORKER_CALL_LOG_PATH: callLogPath,
      WORKER_DELAY_MS: String(DELAY_MS),
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

/** Poll fn() every intervalMs until it returns truthy, or reject after timeoutMs. Generous timeout per this repo's e2e-testing convention. */
async function waitUntil(fn, { timeoutMs = 15000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

function waitForExit(child, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child process did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

// Set on the PARENT process's own env too, so it can use the same
// time-skip/status.mjs and review-state.mjs library functions directly to
// inspect on-disk state (these read process.env at call time, not import
// time, so setting this after the dynamic import below still works).
process.env.GM_TOOLS_REVIEW_STATE_DIR = reviewStateDir;
process.env.GM_TOOLS_TIMESKIP_STATUS_DIR = statusDir;
const { loadStatus } = await import("../time-skip/status.mjs");
const { loadBatch } = await import("../mutation-engine/review-state.mjs");

let child1;
let child2;

await test("cross-process: SIGKILL mid-run leaves a correctly partial on-disk status; a fresh process resumes without re-billing", async () => {
  // --- Phase A: start the worker, let it complete exactly one region, kill it. ---
  child1 = spawnWorker();
  let child1Stderr = "";
  child1.stderr.on("data", (chunk) => { child1Stderr += chunk.toString(); });

  // Wait for the ON-DISK status file to show the first region as fully
  // completed (its 2 entity ids recorded) -- NOT just for the call to have
  // started (countCallLines() only ticks up once a call finishes its
  // delay and logs, so this is already checkpoint-safe, but polling the
  // status file directly is the more direct proof of what we actually
  // care about: a real completed-and-persisted checkpoint, not just an
  // in-flight call). The worker's 2nd call (region 2) is deliberately slow
  // (WORKER_SLOW_CALL_INDEX=2, ~400ms) so there is a wide, deterministic gap
  // between "region 1 checkpointed" and "region 2 becomes observable" for
  // the kill to land inside, without racing fast synchronous work.
  await waitUntil(() => {
    const s = loadStatus(WORLD, BATCH_ID);
    return s && s.processedNodeIds.length >= 2;
  }, { timeoutMs: 15000 });
  child1.kill("SIGKILL");
  const exit1 = await waitForExit(child1);
  assert.equal(exit1.signal, "SIGKILL", `worker should have been killed by SIGKILL (was: signal=${exit1.signal} code=${exit1.code}, stderr=${child1Stderr})`);

  const callsAfterKill = countCallLines();
  assert.equal(callsAfterKill, 1,
    "exactly 1 call should have logged (and completed) before the kill -- the 2nd call was killed mid-sleep, before it could log");

  // --- Phase B: confirm the ON-DISK status file (not any in-memory state --
  // this process never held any) reflects exactly that partial progress. ---
  const status = loadStatus(WORLD, BATCH_ID);
  assert.ok(status, "a status file should exist on disk after the kill");
  assert.equal(status.phase, "texturing", "phase should still be texturing, not done, since the process was killed mid-run");
  assert.equal(status.processedNodeIds.length, 2, "exactly one completed region's 2 entity ids recorded");
  assert.equal(status.mutations.length, 1, "exactly one completed region's mutation persisted");

  // No final batch should exist yet -- createBatch only runs after the full
  // texturing loop completes, which never happened for the killed process.
  assert.throws(() => loadBatch(WORLD, BATCH_ID), /No batch found/);

  // --- Phase C: spawn a completely FRESH process (same batchId) to resume. ---
  child2 = spawnWorker();
  let child2Stderr = "";
  child2.stderr.on("data", (chunk) => { child2Stderr += chunk.toString(); });
  const exit2 = await waitForExit(child2, { timeoutMs: 20000 });
  assert.equal(exit2.code, 0, `resumed worker should exit cleanly (stderr: ${child2Stderr})`);

  // --- Phase D: total calls across BOTH processes must equal exactly the
  // region count (4) -- proof the resumed process picked up where the first
  // left off, reading the persisted status file from disk, and did not
  // re-texture (re-bill) the region(s) already completed before the kill. ---
  const totalCalls = countCallLines();
  assert.equal(totalCalls, 4, "total texture calls across both processes should equal exactly the region count, no duplicates");

  const finalStatus = loadStatus(WORLD, BATCH_ID);
  assert.equal(finalStatus.phase, "done");
  assert.equal(finalStatus.processedNodeIds.length, 8, "all 4 regions x 2 entities should be recorded as processed");

  const finalBatch = loadBatch(WORLD, BATCH_ID);
  assert.equal(finalBatch.mutations.length, 4, "final batch should contain all 4 regions' mutations");
  assert.equal(finalBatch.status, "open");

  const resultPath = `${callLogPath}.result.json`;
  assert.ok(existsSync(resultPath), "resumed worker should have written its final result");
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  assert.equal(result.mutationCount, 4);
  assert.equal(result.batchId, BATCH_ID);
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { child1?.kill("SIGKILL"); } catch { /* already dead */ }
  try { child2?.kill("SIGKILL"); } catch { /* already dead */ }
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
