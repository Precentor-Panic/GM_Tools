import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-resolve-pending-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");

const { resolvePending, DEFAULT_MAX_NEIGHBORS, RESOLVE_REGION_ID } = await import("../time-skip/resolve-pending.mjs");
const { readPending } = await import("../mutation-engine/pending-ledger.mjs");
const { loadBatch } = await import("../mutation-engine/review-state.mjs");

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

function mockClient(responseFn) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        return { content: [{ type: "text", text: responseFn(params) }] };
      }
    }
  };
}

function genericMutationResponse(ids) {
  return JSON.stringify(ids.map((id) => ({ op: "upsert_entity", id, data: {}, rationale: `Resolved: ${id}.` })));
}

// ------------------------------------------------------------------ fixtures

const WORLD_FANOUT = "resolve-pending-fanout-world";

// hub -- n1..n15, all direct (1-hop) neighbors of hub.
const fanoutEntities = [
  { id: "hub", name: "Hub", type: "place", importance: 0.7 },
  ...Array.from({ length: 15 }, (_, i) => ({ id: `n${i + 1}`, name: `N${i + 1}`, type: "person", importance: 0.5 }))
];
const fanoutEdges = Array.from({ length: 15 }, (_, i) => ({
  id: `e${i + 1}`,
  sourceId: "hub",
  targetId: `n${i + 1}`,
  relationshipType: "social",
  strength: 0.5
}));

// ------------------------------------------------------------------ the fan-out cap

await test("resolvePending: THE FAN-OUT CAP -- 15 pending-bearing 1-hop neighbors resolves at most maxNeighbors (default 8), the rest stay 'pending'", async () => {
  // Own entry for hub itself (never capped).
  const { writePending } = await import("../mutation-engine/pending-ledger.mjs");
  writePending(WORLD_FANOUT, "hub", {
    causeTag: "ripple from events at Hub, month 1",
    impactScore: 0.9,
    sourceBatchId: "batch_hub_0",
    cycleDescriptor: "month 1"
  });

  // Each n_i gets one pending entry with a distinct, deterministic impactScore
  // (n15 highest, n1 lowest) -- the top 8 by impact must win the cap.
  for (let i = 1; i <= 15; i++) {
    writePending(WORLD_FANOUT, `n${i}`, {
      causeTag: `ripple from events at Hub, month 1`,
      impactScore: i * 0.05,
      sourceBatchId: `batch_n${i}`,
      cycleDescriptor: "month 1"
    });
  }

  const client = mockClient((params) => genericMutationResponse(["hub"])); // response content doesn't need to be exhaustive for this test
  const result = await resolvePending(WORLD_FANOUT, "hub", {}, { entities: fanoutEntities, edges: fanoutEdges, textureOpts: { client } });

  assert.equal(DEFAULT_MAX_NEIGHBORS, 8, "sanity: default cap is 8");
  assert.equal(result.cappedNeighborCount, 8, "exactly 8 neighbors should be folded into the resolve");
  assert.equal(result.excludedNeighborCount, 7, "the remaining 7 pending-bearing neighbors should be excluded by the cap");
  assert.equal(client.calls.length, 1, "the fan-out cap must still cost exactly ONE API call, not one per neighbor");

  // The top 8 by impactScore are n15..n8 (impactScores 0.75 down to 0.40).
  const expectedTop8 = Array.from({ length: 8 }, (_, i) => `n${15 - i}`);
  const expectedExcluded = Array.from({ length: 7 }, (_, i) => `n${7 - i}`); // n7..n1

  for (const id of expectedTop8) {
    assert.ok(result.resolvedEntityIds.includes(id), `${id} should be among the resolved (highest-impact) entities`);
    const entries = readPending(WORLD_FANOUT, id);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, "proposed", `${id} (capped-in) should now be locked as 'proposed'`);
  }

  for (const id of expectedExcluded) {
    assert.equal(result.resolvedEntityIds.includes(id), false, `${id} should NOT have been pulled into this resolve`);
    const entries = readPending(WORLD_FANOUT, id);
    assert.equal(entries.length, 1, "excluded entity's entry must not be deleted");
    assert.equal(entries[0].status, "pending", `${id} must remain 'pending' -- untouched, still available for a future resolve`);
  }

  // hub's own entry (never subject to the cap) should also be resolved.
  assert.ok(result.resolvedEntityIds.includes("hub"));
  assert.equal(readPending(WORLD_FANOUT, "hub")[0].status, "proposed");

  const batch = loadBatch(WORLD_FANOUT, result.batchId);
  assert.equal(batch.resolvedPendingEntries.length, 9, "hub + 8 capped neighbors = 9 resolvedPendingEntries records");
  assert.ok(batch.resolvedPendingEntries.every((r) => r.regionId === RESOLVE_REGION_ID));
});

await test("resolvePending: a maxNeighbors override changes how many are capped in", async () => {
  const world = "resolve-pending-fanout-world-override";
  const { writePending } = await import("../mutation-engine/pending-ledger.mjs");
  for (let i = 1; i <= 15; i++) {
    writePending(world, `n${i}`, {
      causeTag: "x",
      impactScore: i * 0.05,
      sourceBatchId: `batch_n${i}`,
      cycleDescriptor: "month 1"
    });
  }
  const client = mockClient(() => genericMutationResponse([]));
  const result = await resolvePending(
    world,
    "hub",
    { maxNeighbors: 3 },
    { entities: fanoutEntities, edges: fanoutEdges, textureOpts: { client } }
  );
  assert.equal(result.cappedNeighborCount, 3);
  assert.equal(result.excludedNeighborCount, 12);
});

// ------------------------------------------------------------------ chronological rendering

const WORLD_CHRONO = "resolve-pending-chrono-world";
const chronoEntities = [{ id: "chrono", name: "Chrono", type: "person", importance: 0.5 }];
const chronoEdges = [];

await test("resolvePending: renders entries sorted chronologically by cycleDescriptor, not insertion order, and all in ONE call", async () => {
  const { writePending } = await import("../mutation-engine/pending-ledger.mjs");
  // Written scrambled: month 3, then month 1, then month 2.
  writePending(WORLD_CHRONO, "chrono", { causeTag: "third cause", impactScore: 0.5, sourceBatchId: "batch_3", cycleDescriptor: "month 3" });
  writePending(WORLD_CHRONO, "chrono", { causeTag: "first cause", impactScore: 0.3, sourceBatchId: "batch_1", cycleDescriptor: "month 1" });
  writePending(WORLD_CHRONO, "chrono", { causeTag: "second cause", impactScore: 0.4, sourceBatchId: "batch_2", cycleDescriptor: "month 2" });

  let capturedPrompt = "";
  const client = mockClient((params) => {
    capturedPrompt = params.messages[0].content;
    return genericMutationResponse(["chrono"]);
  });

  const result = await resolvePending(WORLD_CHRONO, "chrono", {}, { entities: chronoEntities, edges: chronoEdges, textureOpts: { client } });

  assert.equal(client.calls.length, 1, "multi-cause entries for one entity must all appear in a single rendered call, not split across multiple");

  // All three causes present in the one prompt.
  assert.ok(capturedPrompt.includes("first cause"));
  assert.ok(capturedPrompt.includes("second cause"));
  assert.ok(capturedPrompt.includes("third cause"));

  // Chronological order: month 1's line precedes month 2's, which precedes month 3's.
  const idx1 = capturedPrompt.indexOf("[month 1]");
  const idx2 = capturedPrompt.indexOf("[month 2]");
  const idx3 = capturedPrompt.indexOf("[month 3]");
  assert.ok(idx1 >= 0 && idx2 >= 0 && idx3 >= 0, "each entry should be labeled with its own cycle");
  assert.ok(idx1 < idx2, "month 1 should render before month 2 (chronological, not insertion order)");
  assert.ok(idx2 < idx3, "month 2 should render before month 3");

  assert.equal(result.mutationCount, 1);
  const batch = loadBatch(WORLD_CHRONO, result.batchId);
  assert.equal(batch.resolvedPendingEntries.length, 1);
  assert.equal(batch.resolvedPendingEntries[0].entryIds.length, 3, "all 3 of chrono's pending entries should be part of this one resolution");
});

// ------------------------------------------------------------------ no-op / error path

await test("resolvePending: throws a clear error when there's nothing to resolve", async () => {
  const world = "resolve-pending-empty-world";
  const client = mockClient(() => genericMutationResponse([]));
  await assert.rejects(
    () => resolvePending(world, "nobody-home", {}, { entities: chronoEntities, edges: chronoEdges, textureOpts: { client } }),
    /nothing to resolve/
  );
  assert.equal(client.calls.length, 0, "no API call should be made when there's nothing pending");
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
