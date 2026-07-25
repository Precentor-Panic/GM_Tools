import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Phase 4 task 4.1's own explicit acceptance criterion: not a unit test on
 * the id-reporting function in isolation, but an actual end-to-end proof --
 * propose (here: create a real batch via review-state.mjs's createBatch,
 * the same function wf_propose_mutations itself calls into after texturing
 * -- no need to spend a real Anthropic call just to prove id-read-back
 * plumbing) -> accept -> apply headless -> roll back -> confirm the created
 * entity is genuinely gone from the snapshot.
 *
 * Spawns the REAL wf-mcp-server/index.mjs as a child process and drives it
 * over the real MCP protocol, against a real fixture snapshot file seeded
 * with genuine prior content (via the real applyHeadless path, not a
 * hand-typed fixture) -- same pattern as sync-headless.test.mjs. Nothing
 * here is mocked: wf_accept, wf_sync_to_foundry, and wf_rollback_batch are
 * all exercised as real MCP tool calls against real on-disk state.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "index.mjs");

const { snapshotFilePath } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createBatch, loadBatch } = await import("../../mutation-engine/review-state.mjs");

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-rollback-created-entity-test-"));
const dataDir = join(scratchDir, "foundrydata");
const reviewStateDir = join(scratchDir, "review-state");
process.env.GM_TOOLS_REVIEW_STATE_DIR = reviewStateDir; // this process's own review-state.mjs calls below

const WORLD = "rollback-created-entity-test-world";
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

function readEntities() {
  return JSON.parse(readFileSync(snapPath, "utf8")).snapshot.entities;
}

// --- fixture setup: a real standalone snapshot with genuine prior content, via the real headless-apply path ---
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "alvor", name: "Alvor", type: "person", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "riverwood", name: "Riverwood", type: "place", importance: 0.7 } }
]);
assert.equal(readEntities().length, 2, "sanity: fixture snapshot should start with exactly the two seeded entities");

let client;
let transport;

async function connect() {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      ...process.env,
      WF_DATA_DIR: dataDir,
      GM_TOOLS_REVIEW_STATE_DIR: reviewStateDir,
      WF_DEFAULT_WORLD: WORLD
    },
    stderr: "pipe"
  });
  client = new Client({ name: "rollback-created-entity-test-client", version: "0.0.0" });
  await client.connect(transport);
}

async function callTool(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const textBlock = res.content?.find((b) => b.type === "text");
  return JSON.parse(textBlock.text);
}

await connect();

let createdBatchId;
let assignedId;

await test("propose (createBatch) -> accept -> sync (headless): a new entity is created and its assigned id is reported + written back onto the batch", async () => {
  const batch = createBatch(
    WORLD,
    { mode: "manual" },
    "a test session",
    [
      {
        op: "upsert_entity",
        // no id -- genuine create, exactly the case rollback.mjs's own doc
        // comment used to flag as unrollback-able
        data: { name: "A New Rumor", type: "concept", importance: 0.3 },
        rationale: "A rumor about the siege starts circulating.",
        batchId: "placeholder",
        sourceKind: "manual"
      }
    ]
  );
  createdBatchId = batch.id;

  const acceptResult = await callTool("wf_accept", { batchId: createdBatchId, scope: "batch" });
  assert.equal(acceptResult.batchStatus, "open", "batch stays 'open' after an accept -- 'synced' only happens on sync");

  const afterAccept = loadBatch(WORLD, createdBatchId);
  const acceptedEntry = afterAccept.mutations.find((m) => m.mutationId === "m0");
  assert.equal(acceptedEntry.status, "accepted");
  assert.equal(acceptedEntry.preState, null, "the entity did not exist before -- pre-state is null, correctly");
  assert.equal(acceptedEntry.id, undefined, "no id known yet at accept-time -- this is the gap task 4.1 closes downstream");

  const syncResult = await callTool("wf_sync_to_foundry", { batchId: createdBatchId });
  assert.equal(syncResult.path, "headless", `expected the headless fallback (no live Foundry client); got: ${JSON.stringify(syncResult)}`);
  assert.equal(syncResult.status, "applied");
  assert.ok(syncResult.idAssignments, "wf_sync_to_foundry should report the id it assigned to the new entity");
  assignedId = syncResult.idAssignments.m0;
  assert.ok(assignedId, "the assignment should be keyed by mutationId ('m0')");

  const onDisk = readEntities();
  assert.equal(onDisk.length, 3, "prior 2 + 1 new");
  const created = onDisk.find((e) => e.name === "A New Rumor");
  assert.ok(created, "the new entity should genuinely be on disk");
  assert.equal(created.id, assignedId, "the id reported back must be the SAME id the entity actually has on disk");

  const afterSync = loadBatch(WORLD, createdBatchId);
  const syncedEntry = afterSync.mutations.find((m) => m.mutationId === "m0");
  assert.equal(syncedEntry.id, assignedId, "the assigned id must be written back onto the batch's stored mutation entry -- this is what makes rollback possible");
  assert.equal(afterSync.status, "synced");
});

await test("roll back the synced batch: the created entity is ACTUALLY deleted from the snapshot, not just reported as skipped", async () => {
  const rollbackResult = await callTool("wf_rollback_batch", { batchId: createdBatchId });

  assert.equal(rollbackResult.path, "headless", `expected the headless fallback; got: ${JSON.stringify(rollbackResult)}`);
  assert.equal(rollbackResult.status, "applied");
  assert.equal(rollbackResult.restoredCount, 1);
  assert.deepEqual(rollbackResult.skipped, [], "the created entity must NOT be reported as skipped -- task 4.1's whole point is that it's now resolvable");

  const onDisk = readEntities();
  assert.equal(onDisk.length, 2, "back down to just the two originally-seeded entities");
  assert.equal(onDisk.find((e) => e.id === assignedId), undefined, "the created entity must be genuinely gone from the snapshot");
  assert.ok(onDisk.find((e) => e.id === "alvor"), "pre-existing entities must survive the rollback untouched");
  assert.ok(onDisk.find((e) => e.id === "riverwood"), "pre-existing entities must survive the rollback untouched");

  const afterRollback = loadBatch(WORLD, createdBatchId);
  assert.equal(afterRollback.status, "rolled-back");
  assert.equal(afterRollback.mutations.find((m) => m.mutationId === "m0").status, "rolled-back");
});

await test("the existing graceful-skip behavior still holds for whatever remains genuinely unresolvable: a created entity accepted but never synced has no id to roll back", async () => {
  // No wf_sync_to_foundry call in this test -- the id never gets assigned/
  // written back, mirroring the still-open live-Foundry-path limitation
  // (Foundry assigns an id in-browser that this file bridge can never read
  // back). rollback.mjs must still degrade gracefully here, not crash.
  const batch = createBatch(
    WORLD,
    { mode: "manual" },
    undefined,
    [
      {
        op: "upsert_entity",
        data: { name: "Never Synced Thing", type: "object" },
        rationale: "test",
        batchId: "placeholder",
        sourceKind: "manual"
      }
    ]
  );

  await callTool("wf_accept", { batchId: batch.id, scope: "batch" });

  const rollbackResult = await callTool("wf_rollback_batch", { batchId: batch.id });
  assert.equal(rollbackResult.status, "no-op", "nothing to restore -- the create was never synced, so it has no known id");
  assert.equal(rollbackResult.skipped.length, 1);
  assert.equal(rollbackResult.skipped[0].mutationId, "m0");
  assert.match(rollbackResult.skipped[0].reason, /no known id/);

  // Confirm this batch's phantom entity was of course never created on disk
  // in the first place (it was never synced) -- nothing to clean up.
  assert.equal(readEntities().length, 2, "unaffected by an accept that was never synced");
});

await client.close();
console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
