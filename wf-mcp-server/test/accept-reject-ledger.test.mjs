import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Phase 3.5 task 3.5.4's acceptance criterion, automated: a real subprocess,
 * real MCP protocol round trip proving wf_accept/wf_reject's pending-ledger
 * hook (mutation-engine/pending-ledger.mjs's applyLedgerOutcome(), wired in
 * wf-mcp-server/index.mjs) actually fires -- accept clears (resolves) the
 * ledger entries a batch names in `resolvedPendingEntries`; reject reverts
 * them to 'pending', never deletes them.
 *
 * Deliberately does NOT go through wf_run_cycle/wf_resolve_pending here
 * (those make real, billed Anthropic API calls -- see the .smoke.mjs
 * sibling test for the full, real end-to-end multi-cycle scenario). Instead
 * this fabricates a batch with resolvedPendingEntries + matching pending-
 * ledger entries directly via review-state.mjs's createBatch and pending-
 * ledger.mjs's writePending/markProposed -- exactly the SHAPE either
 * orchestrateCycle's growth-bound sweep or resolvePending would have
 * produced, just without spending real API tokens to get there. What's
 * under test here is the wf_accept/wf_reject WIRING itself, not the
 * texturing content -- same "fabricate the batch, don't hand-roll a second
 * pipeline" approach sync-headless.test.mjs already established for
 * wf_sync_to_foundry.
 *
 * No ANTHROPIC_API_KEY required -- runs as a normal automated test, same
 * pattern as sync-headless.test.mjs. Lives under wf-mcp-server/test/ (its
 * own node --test-able tree, not swept up by the root `npm test` glob) for
 * the same @modelcontextprotocol/sdk dependency-scoping reason documented
 * in sync-headless.test.mjs's own doc comment.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "index.mjs");

const { snapshotFilePath } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createBatch } = await import("../../mutation-engine/review-state.mjs");
const { writePending, markProposed, readPending } = await import("../../mutation-engine/pending-ledger.mjs");

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-accept-reject-ledger-test-"));
const dataDir = join(scratchDir, "foundrydata");
const reviewStateDir = join(scratchDir, "review-state");
const pendingLedgerDir = join(scratchDir, "pending-resolution");
const humanReviewDir = join(scratchDir, "human-review");
process.env.GM_TOOLS_REVIEW_STATE_DIR = reviewStateDir; // this process's own createBatch/writePending calls below
process.env.GM_TOOLS_PENDING_LEDGER_DIR = pendingLedgerDir;
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = humanReviewDir; // wf_accept/wf_reject below write here (Phase 4 task 4.2) -- must not touch the real repo default

const WORLD = "accept-reject-ledger-test-world";
const snapPath = snapshotFilePath(dataDir, WORLD);

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

bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [{ op: "upsert_entity", data: { id: "gerdur", name: "Gerdur", type: "person", importance: 0.5 } }]);

/** Fabricate a resolve-shaped batch (one mutation targeting `entityId`, `resolvedPendingEntries` naming the ledger entries it resolves) plus the matching, already-'proposed' ledger entries on disk. Mirrors exactly what resolvePending()/run-cycle.mjs's sweep produce, minus the real API call. */
function fabricateResolveBatch(entityId, batchIdSuffix, entryIds) {
  for (const entryId of entryIds) {
    writePending(WORLD, entityId, {
      causeTag: `ripple from events at Riverwood, ${entryId}`,
      impactScore: 0.3,
      sourceBatchId: `batch_source_${entryId}`,
      cycleDescriptor: entryId
    }, { makeId: () => entryId });
  }
  markProposed(WORLD, entityId, entryIds);

  const batchId = `batch_resolve_test_${batchIdSuffix}`;
  const batch = createBatch(
    WORLD,
    { mode: "resolve-pending", requestedEntityId: entityId },
    "several months",
    [{
      op: "upsert_entity",
      id: entityId,
      data: { description: "Accumulated backlog resolved." },
      rationale: "test resolve",
      batchId: "placeholder",
      sourceKind: "deferred-resolution",
      regionId: "region-resolve-pending"
    }],
    {
      makeId: () => batchId,
      resolvedPendingEntries: [{ regionId: "region-resolve-pending", entityId, entryIds }]
    }
  );
  return { batchId, mutationId: batch.mutations[0].mutationId };
}

let client, transport;

async function connect() {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      ...process.env,
      WF_DATA_DIR: dataDir,
      GM_TOOLS_REVIEW_STATE_DIR: reviewStateDir,
      GM_TOOLS_PENDING_LEDGER_DIR: pendingLedgerDir,
      GM_TOOLS_HUMAN_REVIEW_DIR: humanReviewDir,
      WF_DEFAULT_WORLD: WORLD
    },
    stderr: "pipe"
  });
  client = new Client({ name: "accept-reject-ledger-test-client", version: "0.0.0" });
  await client.connect(transport);
}

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const textBlock = res.content?.find((b) => b.type === "text");
  if (res.isError) throw new Error(textBlock?.text ?? "unknown MCP tool error");
  return textBlock ? JSON.parse(textBlock.text) : null;
}

await connect();

await test("wf_accept on a batch with resolvedPendingEntries clears (resolves) the named ledger entries and reports ledgerResolved", async () => {
  const { batchId } = fabricateResolveBatch("gerdur", "accept", ["ea1", "ea2"]);
  assert.equal(readPending(WORLD, "gerdur").length, 2, "precondition: two 'proposed' entries on disk");

  const result = await call("wf_accept", { batchId, scope: "batch" });

  assert.ok(Array.isArray(result.ledgerResolved) && result.ledgerResolved.length === 1, "wf_accept should report the resolved ledger record");
  assert.equal(result.ledgerResolved[0].entityId, "gerdur");
  assert.deepEqual(result.ledgerResolved[0].entryIds.sort(), ["ea1", "ea2"]);

  assert.deepEqual(readPending(WORLD, "gerdur"), [], "accepted entries must be fully cleared (removed), not just flagged");
});

await test("wf_reject on a batch with resolvedPendingEntries reverts the named ledger entries back to 'pending' (not deleted) and reports ledgerReverted", async () => {
  const { batchId } = fabricateResolveBatch("gerdur", "reject", ["er1"]);
  assert.equal(readPending(WORLD, "gerdur").length, 1, "precondition: one 'proposed' entry on disk (accept test above already cleared its own)");
  assert.equal(readPending(WORLD, "gerdur")[0].status, "proposed");

  const result = await call("wf_reject", { batchId, scope: "batch" });

  assert.ok(Array.isArray(result.ledgerReverted) && result.ledgerReverted.length === 1, "wf_reject should report the reverted ledger record");
  assert.equal(result.ledgerReverted[0].entityId, "gerdur");
  assert.deepEqual(result.ledgerReverted[0].entryIds, ["er1"]);

  const after = readPending(WORLD, "gerdur");
  assert.equal(after.length, 1, "rejected entry must still exist -- reverted, not deleted");
  assert.equal(after[0].status, "pending", "must be back to 'pending', available for a future resolve attempt");
});

await test("wf_accept on an ordinary batch (no resolvedPendingEntries) omits ledgerResolved entirely -- the common-case no-op", async () => {
  const batchId = "batch_ordinary_accept";
  const batch = createBatch(
    WORLD,
    { mode: "manual" },
    "a session",
    [{ op: "upsert_entity", id: "gerdur", data: { importance: 0.6 }, rationale: "test", batchId: "placeholder", sourceKind: "manual" }],
    { makeId: () => batchId }
  );
  const result = await call("wf_accept", { batchId, scope: "batch" });
  assert.equal("ledgerResolved" in result, false, "an ordinary batch should not carry a ledgerResolved field at all");
  assert.equal(result.batchStatus, "open");
});

await client.close();
console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
