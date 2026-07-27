import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Task 14.8 -- deterministic, no-API-call unit coverage for the actual
 * duplicate-prevention MECHANISM (dedupedScan, review-ui/server.mjs): a
 * rapid double-trigger of the same scan (same world/entity/text) must reuse
 * the same in-flight (or very-recently-settled) result instead of running
 * the real thunk twice -- proportionate, deterministic proof that doesn't
 * need a real, billed LLM call to verify. The full end-to-end proof (a real
 * HTTP double-POST producing exactly one batch) is a real-API test in the
 * sibling routes-live.smoke.mjs, matching this project's established split.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-scan-dedupe-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.WF_DATA_DIR = join(scratchDir, "foundrydata");

const { dedupedScan, __testOnlyRecentScans } = await import("../server.mjs");

test("dedupedScan: a rapid double-trigger with the SAME world/entity/text reuses the same in-flight promise -- the thunk only runs ONCE", async () => {
  __testOnlyRecentScans.clear();
  let callCount = 0;
  const runScan = () => {
    callCount++;
    return new Promise((resolve) => setTimeout(() => resolve({ batchId: "batch_only_once" }), 20));
  };

  // Fire two "double-trigger" calls back to back, BEFORE the first settles --
  // exactly the "navigate away then retry" / accidental-double-click shape.
  const [first, second] = await Promise.all([
    dedupedScan("world-a", "entity-1", "some text", runScan),
    dedupedScan("world-a", "entity-1", "some text", runScan)
  ]);

  assert.equal(callCount, 1, "the real scan thunk should only have run once");
  assert.equal(first.batchId, "batch_only_once");
  assert.deepEqual(first, second, "both calls should resolve to the SAME result -- the same batch, not two");
});

test("dedupedScan: a SEQUENTIAL retry shortly after the first call settled still reuses the result (the 'confused retry-click' case)", async () => {
  __testOnlyRecentScans.clear();
  let callCount = 0;
  const runScan = () => {
    callCount++;
    return Promise.resolve({ batchId: "batch_settled_once" });
  };

  const first = await dedupedScan("world-b", "entity-2", "some text", runScan);
  const second = await dedupedScan("world-b", "entity-2", "some text", runScan); // fired AFTER the first already resolved, but quickly

  assert.equal(callCount, 1, "a quick retry right after the first call settled should NOT trigger a second real scan");
  assert.deepEqual(first, second);
});

test("dedupedScan: a DIFFERENT entity (even same world/text) is genuinely independent -- never deduped against an unrelated scan", async () => {
  __testOnlyRecentScans.clear();
  let callCount = 0;
  const runScan = () => { callCount++; return Promise.resolve({ batchId: `batch_${callCount}` }); };

  const forEntityA = await dedupedScan("world-c", "entity-a", "identical text", runScan);
  const forEntityB = await dedupedScan("world-c", "entity-b", "identical text", runScan);

  assert.equal(callCount, 2, "two genuinely different entities must each get their own real scan");
  assert.notEqual(forEntityA.batchId, forEntityB.batchId);
});

test("dedupedScan: DIFFERENT text for the same entity is also genuinely independent -- a real edit to the source text must not be silently deduped away", async () => {
  __testOnlyRecentScans.clear();
  let callCount = 0;
  const runScan = () => { callCount++; return Promise.resolve({ batchId: `batch_${callCount}` }); };

  const forTextA = await dedupedScan("world-d", "entity-3", "first draft of the text", runScan);
  const forTextB = await dedupedScan("world-d", "entity-3", "a meaningfully edited draft", runScan);

  assert.equal(callCount, 2);
  assert.notEqual(forTextA.batchId, forTextB.batchId);
});

test("dedupedScan: a FAILED scan is never cached -- a real retry after a genuine error must actually retry", async () => {
  __testOnlyRecentScans.clear();
  let callCount = 0;
  const runScan = () => {
    callCount++;
    return callCount === 1 ? Promise.reject(new Error("transient failure")) : Promise.resolve({ batchId: "batch_after_retry" });
  };

  await assert.rejects(() => dedupedScan("world-e", "entity-4", "text", runScan));
  const second = await dedupedScan("world-e", "entity-4", "text", runScan);

  assert.equal(callCount, 2, "the failed first attempt must not block a genuine retry from actually running");
  assert.equal(second.batchId, "batch_after_retry");
});

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
