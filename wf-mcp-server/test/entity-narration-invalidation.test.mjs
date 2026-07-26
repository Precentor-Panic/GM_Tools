import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Phase 10 task 10.3's acceptance criterion, automated: a real subprocess,
 * real MCP protocol round trip proving that accepting a LATER batch that
 * mutates an entity which already has a 'current' narration supersedes that
 * narration (mutation-engine/entity-narration.mjs's supersedeEntityNarration,
 * wired into wf-mcp-server/lib/mutation-ops.mjs's acceptMutationIds) --
 * WITHOUT deleting it: the original prose must still be readable from
 * getEntityNarrationHistory() afterward.
 *
 * Same "fabricate the shape directly, don't hand-roll a second pipeline"
 * approach test/accept-reject-ledger.test.mjs already established: this
 * test doesn't make a real narrate call (that would need ANTHROPIC_API_KEY
 * and is already covered by mutation-engine/narrate-entity.smoke.mjs) --
 * it seeds a narration directly via saveEntityNarration to set up the
 * precondition, then proves wf_accept's OWN hook fires correctly.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "index.mjs");

const { snapshotFilePath } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createBatch } = await import("../../mutation-engine/review-state.mjs");

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-entity-narration-invalidation-test-"));
const dataDir = join(scratchDir, "foundrydata");
const reviewStateDir = join(scratchDir, "review-state");
const humanReviewDir = join(scratchDir, "human-review");
const entityNarrationDir = join(scratchDir, "entity-narration");
process.env.GM_TOOLS_REVIEW_STATE_DIR = reviewStateDir; // this process's own createBatch call below
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = humanReviewDir;
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = entityNarrationDir; // this process's own saveEntityNarration/getEntityNarrationHistory calls below

const { saveEntityNarration, getCurrentEntityNarration, getEntityNarrationHistory } =
  await import("../../mutation-engine/entity-narration.mjs");

const WORLD = "entity-narration-invalidation-test-world";
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

let client, transport;

async function connect() {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      ...process.env,
      WF_DATA_DIR: dataDir,
      GM_TOOLS_REVIEW_STATE_DIR: reviewStateDir,
      GM_TOOLS_HUMAN_REVIEW_DIR: humanReviewDir,
      GM_TOOLS_ENTITY_NARRATION_DIR: entityNarrationDir,
      WF_DEFAULT_WORLD: WORLD
    },
    stderr: "pipe"
  });
  client = new Client({ name: "entity-narration-invalidation-test-client", version: "0.0.0" });
  await client.connect(transport);
}

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const textBlock = res.content?.find((b) => b.type === "text");
  if (res.isError) throw new Error(textBlock?.text ?? "unknown MCP tool error");
  return textBlock ? JSON.parse(textBlock.text) : null;
}

function fabricateOrdinaryBatch(entityId, batchIdSuffix) {
  const batchId = `batch_invalidation_test_${batchIdSuffix}`;
  const batch = createBatch(
    WORLD,
    { mode: "manual" },
    "a session",
    [{
      op: "upsert_entity",
      id: entityId,
      data: { description: "A later, real mutation." },
      rationale: "test re-mutation",
      batchId: "placeholder",
      sourceKind: "manual"
    }],
    { makeId: () => batchId }
  );
  return { batchId, mutationId: batch.mutations[0].mutationId };
}

await connect();

await test("THE ACTUAL REQUIREMENT: an entity narrated, then re-mutated and accepted in a LATER batch, has its narration superseded -- but the original prose is still readable from history", async () => {
  saveEntityNarration(WORLD, "gerdur", { prose: "Gerdur watches the smoke rise over the mill.", sourceMutationId: "m0", sourceBatchId: "batch_original" }, { now: "2026-01-01T00:00:00.000Z", makeId: () => "n1" });
  const before = getCurrentEntityNarration(WORLD, "gerdur");
  assert.ok(before, "precondition: gerdur has a current narration");
  assert.equal(before.prose, "Gerdur watches the smoke rise over the mill.");

  const { batchId } = fabricateOrdinaryBatch("gerdur", "1");
  const result = await call("wf_accept", { batchId, scope: "batch" });
  assert.equal(typeof result.batchStatus, "string", "sanity: the accept call itself succeeded, no crash");

  const after = getCurrentEntityNarration(WORLD, "gerdur");
  assert.equal(after, null, "narration must no longer present as current once the entity it describes is mutated again");

  const history = getEntityNarrationHistory(WORLD, "gerdur");
  assert.equal(history.length, 1, "the original entry is still in history -- NEVER deleted");
  assert.equal(history[0].status, "superseded");
  assert.equal(history[0].prose, "Gerdur watches the smoke rise over the mill.", "the original prose remains recallable, word for word");
});

await test("an entity with NO prior narration is unaffected by acceptance -- supersede is a safe no-op, not an error", async () => {
  applyHeadless(snapPath, [{ op: "upsert_entity", data: { id: "sven", name: "Sven", type: "person", importance: 0.4 } }]);
  assert.equal(getCurrentEntityNarration(WORLD, "sven"), null, "precondition: never narrated");

  const { batchId } = fabricateOrdinaryBatch("sven", "2");
  await assert.doesNotReject(() => call("wf_accept", { batchId, scope: "batch" }));

  assert.equal(getCurrentEntityNarration(WORLD, "sven"), null, "still nothing to show -- and no crash happened getting here");
  assert.deepEqual(getEntityNarrationHistory(WORLD, "sven"), []);
});

await test("a scoped ('entity') accept ALSO supersedes -- the hook fires regardless of accept scope, since the entity was mutated either way", async () => {
  saveEntityNarration(WORLD, "gerdur", { prose: "A brand new narration after the first supersede.", sourceMutationId: "m1", sourceBatchId: "batch_second" }, { now: "2026-02-01T00:00:00.000Z", makeId: () => "n2" });
  assert.ok(getCurrentEntityNarration(WORLD, "gerdur"), "precondition: current again");

  const { batchId, mutationId } = fabricateOrdinaryBatch("gerdur", "3");
  await call("wf_accept", { batchId, scope: "entity", id: mutationId });

  assert.equal(getCurrentEntityNarration(WORLD, "gerdur"), null, "scope='entity' accept must supersede too, not just scope='batch'");
  const history = getEntityNarrationHistory(WORLD, "gerdur");
  assert.equal(history.length, 2, "both the original and this second narration remain in history");
  assert.ok(history.every((e) => e.status === "superseded"));
});

await client.close();
console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
