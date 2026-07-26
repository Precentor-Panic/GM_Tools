import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Phase 11 task 11.4's acceptance criterion, automated: a real subprocess,
 * real MCP protocol round trip proving that accepting a LATER batch that
 * mutates an entity which already has 'accepted' prep content marks that
 * content 'stale' (mutation-engine/prep-content.mjs's markPrepContentStale,
 * wired into wf-mcp-server/lib/mutation-ops.mjs's acceptMutationIds -- the
 * SAME accept choke point Phase 10 task 10.3 already used for narration
 * invalidation, per the task file's own instruction to reuse it rather than
 * add a second hook point) -- WITHOUT deleting or altering `fields`: the
 * content remains fully readable, just flagged.
 *
 * Same "fabricate the shape directly, don't spend a real API call to set up
 * the precondition" approach test/entity-narration-invalidation.test.mjs
 * already established: this test seeds prep content directly via
 * savePrepContent/acceptPrepContent (no model call needed for the setup),
 * then proves wf_accept's OWN hook fires correctly.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "index.mjs");

const { snapshotFilePath } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createBatch } = await import("../../mutation-engine/review-state.mjs");

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-prep-content-invalidation-test-"));
const dataDir = join(scratchDir, "foundrydata");
const reviewStateDir = join(scratchDir, "review-state");
const humanReviewDir = join(scratchDir, "human-review");
const prepContentDir = join(scratchDir, "prep-content");
process.env.GM_TOOLS_REVIEW_STATE_DIR = reviewStateDir; // this process's own createBatch call below
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = humanReviewDir;
process.env.GM_TOOLS_PREP_CONTENT_DIR = prepContentDir; // this process's own savePrepContent/getPrepContent calls below

const { savePrepContent, acceptPrepContent, getPrepContent } = await import("../../mutation-engine/prep-content.mjs");

const WORLD = "prep-content-invalidation-test-world";
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
      GM_TOOLS_PREP_CONTENT_DIR: prepContentDir,
      WF_DEFAULT_WORLD: WORLD
    },
    stderr: "pipe"
  });
  client = new Client({ name: "prep-content-invalidation-test-client", version: "0.0.0" });
  await client.connect(transport);
}

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const textBlock = res.content?.find((b) => b.type === "text");
  if (res.isError) throw new Error(textBlock?.text ?? "unknown MCP tool error");
  return textBlock ? JSON.parse(textBlock.text) : null;
}

function fabricateOrdinaryBatch(entityId, batchIdSuffix) {
  const batchId = `batch_prep_invalidation_test_${batchIdSuffix}`;
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

const PERSON_FIELDS = {
  descriptionAppearance: "A miller's daughter with flour-dusted hands.",
  personalityMannerisms: "Brisk and businesslike.",
  motivationGoal: "Keep the mill running through the winter.",
  secret: "She's been skimming grain to feed a hidden refugee camp.",
  potentialRolls: [{ skill: "Perception", dc: 12, purpose: "Notice the missing grain." }],
  hook: "A grain shortage forces the town to investigate the mill's books."
};

await connect();

await test("THE ACTUAL REQUIREMENT: an entity with ACCEPTED prep content, then re-mutated and accepted in a LATER batch, has its prep content marked stale -- but fields remain fully readable, unchanged", async () => {
  savePrepContent(WORLD, "gerdur", { entityType: "person", framingUsed: "a test framing", fields: PERSON_FIELDS });
  acceptPrepContent(WORLD, "gerdur");
  const before = getPrepContent(WORLD, "gerdur");
  assert.equal(before.status, "accepted", "precondition: gerdur has accepted prep content");

  const { batchId } = fabricateOrdinaryBatch("gerdur", "1");
  const result = await call("wf_accept", { batchId, scope: "batch" });
  assert.equal(typeof result.batchStatus, "string", "sanity: the accept call itself succeeded, no crash");

  const after = getPrepContent(WORLD, "gerdur");
  assert.equal(after.status, "stale", "prep content must be marked stale once the entity it describes is mutated again");
  assert.deepEqual(after.fields, before.fields, "fields must be COMPLETELY UNCHANGED -- staleness marks, never deletes or alters content");
});

await test("an entity with NO prior prep content is unaffected by acceptance -- markPrepContentStale is a safe no-op, not an error", async () => {
  applyHeadless(snapPath, [{ op: "upsert_entity", data: { id: "sven", name: "Sven", type: "person", importance: 0.4 } }]);
  assert.equal(getPrepContent(WORLD, "sven"), null, "precondition: never developed");

  const { batchId } = fabricateOrdinaryBatch("sven", "2");
  await assert.doesNotReject(() => call("wf_accept", { batchId, scope: "batch" }));

  assert.equal(getPrepContent(WORLD, "sven"), null, "still nothing to show -- and no crash happened getting here");
});

await test("a scoped ('entity') accept ALSO marks stale -- the hook fires regardless of accept scope, since the entity was mutated either way", async () => {
  applyHeadless(snapPath, [{ op: "upsert_entity", data: { id: "riverwood", name: "Riverwood", type: "place", importance: 0.6 } }]);
  const placeFields = {
    descriptionAtmosphere: "x", notableFeatures: "x", secret: "x", potentialEncounter: "x", potentialRolls: []
  };
  savePrepContent(WORLD, "riverwood", { entityType: "place", framingUsed: "a test framing", fields: placeFields });
  acceptPrepContent(WORLD, "riverwood");
  assert.equal(getPrepContent(WORLD, "riverwood").status, "accepted", "precondition");

  const { batchId, mutationId } = fabricateOrdinaryBatch("riverwood", "3");
  await call("wf_accept", { batchId, scope: "entity", id: mutationId });

  const after = getPrepContent(WORLD, "riverwood");
  assert.equal(after.status, "stale", "scope='entity' accept must mark stale too, not just scope='batch'");
  assert.deepEqual(after.fields, placeFields);
});

await test("a 'proposed' (not yet accepted) draft is ALSO marked stale by a re-mutation, matching the store's own status-flip-only convention", async () => {
  applyHeadless(snapPath, [{ op: "upsert_entity", data: { id: "alvor", name: "Alvor", type: "person", importance: 0.5 } }]);
  savePrepContent(WORLD, "alvor", { entityType: "person", framingUsed: "a test framing", fields: PERSON_FIELDS });
  assert.equal(getPrepContent(WORLD, "alvor").status, "proposed", "precondition: still just proposed, never accepted");

  const { batchId } = fabricateOrdinaryBatch("alvor", "4");
  await call("wf_accept", { batchId, scope: "batch" });

  assert.equal(getPrepContent(WORLD, "alvor").status, "stale");
});

await client.close();
console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
