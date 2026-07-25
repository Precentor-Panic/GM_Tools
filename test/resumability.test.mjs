import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Phase 2 task 2.2 -- in-process simulated-kill-and-resume test. This mocks
// texture.mjs's outbound API call and simulates a mid-run crash by making
// the SECOND region's texture call throw (rather than actually killing a
// process -- test/resumability-crossprocess.test.mjs covers the real
// cross-process kill, per phase-2-tasks.md's explicit requirement that
// in-process simulation alone isn't sufficient coverage for this task).
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-resumability-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_TIMESKIP_STATUS_DIR = join(scratchDir, "time-skip-status");

const { orchestrateBatch } = await import("../time-skip/run.mjs");
const { loadStatus } = await import("../time-skip/status.mjs");
const { loadBatch } = await import("../mutation-engine/review-state.mjs");

let passed = 0;
// Sequential (not the pending-array/concurrent pattern texture.test.mjs
// uses) -- deliberate: the second and third tests below depend on the
// on-disk state the first test's simulated crash leaves behind (same
// batchId, resumed), so they must run in file order, not concurrently.
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

const WORLD = "resumability-test-world";

// Three disjoint pairs -> three disconnected regions (no edge connects
// across pairs, so groupByRegion's union-find keeps them separate).
const entities = [
  { id: "a1", name: "A1", type: "person", importance: 0.6 },
  { id: "a2", name: "A2", type: "person", importance: 0.6 },
  { id: "b1", name: "B1", type: "person", importance: 0.6 },
  { id: "b2", name: "B2", type: "person", importance: 0.6 },
  { id: "c1", name: "C1", type: "person", importance: 0.6 },
  { id: "c2", name: "C2", type: "person", importance: 0.6 }
];
const edges = [
  { id: "eA", sourceId: "a1", targetId: "a2", relationshipType: "social", strength: 0.9 },
  { id: "eB", sourceId: "b1", targetId: "b2", relationshipType: "social", strength: 0.9 },
  { id: "eC", sourceId: "c1", targetId: "c2", relationshipType: "social", strength: 0.9 }
];

function validResponseFor(edgeId) {
  return JSON.stringify([{ op: "upsert_edge", id: edgeId, data: { strength: 0.1 }, rationale: "Time passed." }]);
}

/** A mock Anthropic-SDK-shaped client that records every call and can be told to throw on a specific call number. */
function mockClient({ throwOnCall } = {}) {
  let callCount = 0;
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        callCount++;
        calls.push(params);
        if (throwOnCall && callCount === throwOnCall) {
          throw new Error("Simulated crash: connection dropped mid-run.");
        }
        // Respond with a decay-plausible mutation for whichever edge id is
        // mentioned in this call's prompt (eA/eB/eC), so each region gets a
        // distinguishable, schema-valid mutation.
        const prompt = params.messages[0].content;
        const edgeId = ["eA", "eB", "eC"].find((id) => prompt.includes(`[edgeId=${id}]`));
        return { content: [{ type: "text", text: validResponseFor(edgeId ?? "eA") }] };
      }
    }
  };
}

await test("orchestrateBatch: a mid-run failure leaves status.json with exactly the completed region(s) recorded, not more", async () => {
  const batchId = "batch_resume_sim_1";
  const client = mockClient({ throwOnCall: 2 }); // region 1 succeeds, region 2 "crashes"

  await assert.rejects(
    orchestrateBatch(WORLD, { mode: "ambient", elapsedSessions: 10 }, "some time", {
      entities,
      edges,
      batchId,
      textureOpts: { client }
    }),
    /Simulated crash/
  );

  assert.equal(client.calls.length, 2, "sanity: exactly 2 calls were attempted before the simulated crash");

  const status = loadStatus(WORLD, batchId);
  assert.ok(status, "status file should exist after the simulated crash");
  assert.equal(status.phase, "texturing", "phase should still be texturing, not done");
  assert.equal(status.processedNodeIds.length, 2, "exactly one region's two entity ids should be recorded as processed");
  assert.equal(status.mutations.length, 1, "exactly one region's mutation should be persisted so far");
});

await test("orchestrateBatch: resuming with the same batchId does NOT re-call texture for the already-completed region", async () => {
  const batchId = "batch_resume_sim_1"; // same id as the crashed run above -- this IS the resume
  const statusBefore = loadStatus(WORLD, batchId);
  assert.ok(statusBefore, "precondition: a partial status file from the crashed run must already exist on disk");
  const completedIdsBefore = new Set(statusBefore.processedNodeIds);

  const resumeClient = mockClient(); // fresh client instance -- its call count should reflect ONLY the resumed work
  const result = await orchestrateBatch(WORLD, { mode: "ambient", elapsedSessions: 10 }, "some time", {
    entities,
    edges,
    batchId,
    textureOpts: { client: resumeClient }
  });

  // Exactly 2 calls: the two regions NOT already completed before the crash
  // (3 total regions - 1 already done = 2 remaining). If the already-done
  // region were re-textured, this would be 3.
  assert.equal(resumeClient.calls.length, 2, "resume must not re-call texture for the region completed pre-crash");

  assert.equal(result.mutationCount, 3, "final batch should have all 3 regions' mutations (1 from before the crash + 2 from the resume)");

  const finalStatus = loadStatus(WORLD, batchId);
  assert.equal(finalStatus.phase, "done");
  assert.equal(finalStatus.processedNodeIds.length, 6, "all 6 entities across all 3 regions should now be recorded as processed");
  for (const id of completedIdsBefore) {
    assert.ok(finalStatus.processedNodeIds.includes(id), "the pre-crash region's ids should still be present after resume, not dropped");
  }

  const batch = loadBatch(WORLD, batchId);
  assert.equal(batch.mutations.length, 3);
  assert.equal(batch.status, "open");
});

await test("orchestrateBatch: a fresh batchId (no prior status file) is unaffected -- runs all regions in one pass", async () => {
  const batchId = "batch_resume_sim_fresh";
  const client = mockClient();
  const result = await orchestrateBatch(WORLD, { mode: "ambient", elapsedSessions: 10 }, "some time", {
    entities,
    edges,
    batchId,
    textureOpts: { client }
  });
  assert.equal(client.calls.length, 3, "a fresh run with no prior status should texture all 3 regions");
  assert.equal(result.mutationCount, 3);
  assert.equal(loadStatus(WORLD, batchId).phase, "done");
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
