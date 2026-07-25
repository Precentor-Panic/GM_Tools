import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate review-state.mjs, time-skip/status.mjs (unused here but harmless to
// set), and pending-ledger.mjs before importing anything that reads their
// root env vars lazily -- same isolation pattern as
// test/resumability.test.mjs / test/pending-ledger.test.mjs.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-run-cycle-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");

const { orchestrateCycle, DEFAULT_GROWTH_BOUND_THRESHOLD, SWEEP_REGION_ID } = await import("../time-skip/run-cycle.mjs");
const { readPending, listPendingEntities, writePending } = await import("../mutation-engine/pending-ledger.mjs");
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

const WORLD = "run-cycle-test-world";

// riverwood --presence-- alvor --social-- sven --kinship-- gerdur
// headline anchor = riverwood, headlineDepth = 1 -> headline subset = {riverwood, alvor}.
// sven and gerdur are outside the headline subset -- their ambient-decay
// deltas (whole-graph mode:'ambient') must be DEFERRED, not textured.
const entities = [
  { id: "riverwood", name: "Riverwood", type: "place", importance: 0.8 },
  { id: "alvor", name: "Alvor", type: "person", importance: 0.6 },
  { id: "sven", name: "Sven", type: "person", importance: 0.5 },
  { id: "gerdur", name: "Gerdur", type: "person", importance: 0.5 }
];
const edges = [
  { id: "e-pres", sourceId: "riverwood", targetId: "alvor", relationshipType: "presence", strength: 0.8 },
  { id: "e-soc", sourceId: "alvor", targetId: "sven", relationshipType: "social", strength: 0.7 },
  { id: "e-kin", sourceId: "sven", targetId: "gerdur", relationshipType: "kinship", strength: 0.9 }
];

function mockClient(responses) {
  let call = 0;
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        const resp = responses[Math.min(call, responses.length - 1)];
        call++;
        return { content: [{ type: "text", text: resp }] };
      }
    }
  };
}

const headlineResponse = JSON.stringify([
  { op: "upsert_entity", id: "alvor", data: { description: "News from downriver reaches the forge." }, rationale: "Presence bond with Riverwood shifted." }
]);
const sweepResponse = JSON.stringify([
  { op: "upsert_entity", id: "gerdur", data: { description: "Months of accumulated rumor finally catch up with her." }, rationale: "Backlog resolved." }
]);

// ------------------------------------------------------------- validation

await test("orchestrateCycle: requires opts.entities/opts.edges", async () => {
  await assert.rejects(
    () => orchestrateCycle(WORLD, { cycleScope: { mode: "ambient" }, headlineAnchorId: "riverwood", cycleDescriptor: "month 1" }, {}),
    /entities and opts\.edges/
  );
});

await test("orchestrateCycle: requires cycleSpec.headlineAnchorId", async () => {
  await assert.rejects(
    () => orchestrateCycle(WORLD, { cycleScope: { mode: "ambient" }, cycleDescriptor: "month 1" }, { entities, edges, textureOpts: { client: mockClient([]) } }),
    /headlineAnchorId/
  );
});

await test("orchestrateCycle: requires cycleSpec.cycleDescriptor", async () => {
  await assert.rejects(
    () => orchestrateCycle(WORLD, { cycleScope: { mode: "ambient" }, headlineAnchorId: "riverwood" }, { entities, edges, textureOpts: { client: mockClient([]) } }),
    /cycleDescriptor/
  );
});

// ------------------------------------------------------- main cycle behavior

await test("orchestrateCycle: headline-subset entities get textured; non-headline entities get ledger entries instead; a bloated entity gets swept rather than growing further", async () => {
  // Pre-seed gerdur with 6 existing pending entries from "prior cycles" --
  // this cycle would normally add a 7th (via e-kin); the growth-bound sweep
  // must fold the whole backlog into this cycle's resolution instead of
  // letting it reach/persist at 7.
  for (let i = 1; i <= 6; i++) {
    writePending(WORLD, "gerdur", {
      causeTag: `ripple from events at Riverwood, month ${i}`,
      impactScore: 0.2 + i * 0.01,
      sourceBatchId: `batch_prior_${i}`,
      cycleDescriptor: `month ${i}`
    });
  }
  assert.equal(readPending(WORLD, "gerdur").length, 6, "precondition: gerdur starts with 6 pending entries");

  const client = mockClient([headlineResponse, sweepResponse]);
  const result = await orchestrateCycle(
    WORLD,
    {
      cycleScope: { mode: "ambient", elapsedSessions: 20 },
      headlineAnchorId: "riverwood",
      headlineDepth: 1,
      cycleDescriptor: "month 7",
      elapsedTimeDescriptor: "one month"
    },
    { entities, edges, textureOpts: { client } }
  );

  // --- headline: textured now ---
  assert.equal(result.headlineTexturedCount, 1, "the headline region (riverwood<->alvor) should texture to exactly one mutation");
  const batch = loadBatch(WORLD, result.batchId);
  assert.ok(batch.mutations.some((m) => m.id === "alvor" && m.sourceKind !== "deferred-resolution"), "alvor's headline mutation should be present and NOT tagged deferred-resolution");

  // --- non-headline (sven): ledger entries, not texturing ---
  const svenPending = readPending(WORLD, "sven");
  assert.ok(svenPending.length >= 1, "sven (outside the headline subset) should have accumulated pending ledger entries, not been textured");
  assert.ok(svenPending.every((e) => e.status === "pending"));
  assert.equal(batch.mutations.some((m) => m.id === "sven"), false, "sven must NOT appear as a directly-textured mutation this cycle");

  // --- bloated entity (gerdur): swept into this cycle's resolution ---
  assert.equal(result.sweptEntityCount, 1, "exactly one entity (gerdur) should have been swept");
  const gerdurAfter = readPending(WORLD, "gerdur");
  assert.equal(gerdurAfter.filter((e) => e.status === "pending").length, 0, "gerdur's backlog must not be left sitting at 7 pending entries -- it should have been swept, not grown further");
  assert.equal(gerdurAfter.filter((e) => e.status === "proposed").length, 7, "all 7 entries (6 prior + this cycle's own) should be locked into the sweep's batch, not deleted or lost");
  assert.equal(listPendingEntities(WORLD).includes("gerdur"), false, "gerdur should no longer show up as having an AVAILABLE backlog");

  assert.ok(batch.mutations.some((m) => m.id === "gerdur" && m.sourceKind === "deferred-resolution"), "gerdur's swept mutation should be present, tagged deferred-resolution");
  assert.ok(batch.resolvedPendingEntries?.length === 1, "batch should record exactly one resolvedPendingEntries record (gerdur's sweep)");
  assert.equal(batch.resolvedPendingEntries[0].entityId, "gerdur");
  assert.equal(batch.resolvedPendingEntries[0].regionId, SWEEP_REGION_ID);
  assert.equal(batch.resolvedPendingEntries[0].entryIds.length, 7);

  // Two API calls total: one for the headline region, one for the sweep --
  // never one call per swept entity (cost-control acceptance criterion).
  assert.equal(client.calls.length, 2);
});

await test("orchestrateCycle: with no bloated entities, no sweep call is made and resolvedPendingEntries is absent", async () => {
  const world2 = "run-cycle-test-world-nosweep";
  const client = mockClient([headlineResponse]);
  const result = await orchestrateCycle(
    world2,
    { cycleScope: { mode: "ambient", elapsedSessions: 20 }, headlineAnchorId: "riverwood", headlineDepth: 1, cycleDescriptor: "month 1" },
    { entities, edges, textureOpts: { client } }
  );
  assert.equal(result.sweptEntityCount, 0);
  assert.equal(client.calls.length, 1, "only the headline call should have been made -- no sweep call with nothing to sweep");
  const batch = loadBatch(world2, result.batchId);
  assert.equal(batch.resolvedPendingEntries, undefined);

  // sven should still have accumulated a deferred entry even with no sweep in play.
  assert.ok(readPending(world2, "sven").length >= 1);
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
