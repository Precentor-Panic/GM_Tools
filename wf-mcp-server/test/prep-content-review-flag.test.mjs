import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Task 14.4 (QA-pass finding): every OTHER write path in this project
 * (mutation-ops.mjs's scoped accept, manual-edit-ops.mjs's six write
 * functions) calls markHumanReviewed on a genuinely scoped GM action --
 * prep-content-ops.mjs's acceptPrepContentOp never did, at all, so
 * developing and accepting a node's content left it indistinguishable from
 * one nobody had ever opened. Real subprocess, real MCP protocol round
 * trip (matching test/unreviewed-accumulation.test.mjs's own established
 * pattern for exactly this class of wiring proof), not a mocked call.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "index.mjs");

const { snapshotFilePath } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-prep-content-review-flag-test-"));
const dataDir = join(scratchDir, "foundrydata");
const reviewStateDir = join(scratchDir, "review-state");
const humanReviewDir = join(scratchDir, "human-review");
const prepContentDir = join(scratchDir, "prep-content");
process.env.GM_TOOLS_REVIEW_STATE_DIR = reviewStateDir;
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = humanReviewDir;
process.env.GM_TOOLS_PREP_CONTENT_DIR = prepContentDir;

const { savePrepContent } = await import("../../mutation-engine/prep-content.mjs");
const { getHumanReviewState } = await import("../../mutation-engine/human-review.mjs");

const WORLD = "prep-content-review-flag-test-world";
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
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "riverwood-miller", name: "Riverwood Miller", type: "person", importance: 0.3 } },
  { op: "upsert_entity", data: { id: "untouched-entity", name: "Untouched Entity", type: "person", importance: 0.3 } }
]);

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
  client = new Client({ name: "prep-content-review-flag-test-client", version: "0.0.0" });
  await client.connect(transport);
}

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const textBlock = res.content?.find((b) => b.type === "text");
  if (res.isError) throw new Error(textBlock?.text ?? "unknown MCP tool error");
  return textBlock ? JSON.parse(textBlock.text) : null;
}

async function unreviewedIds() {
  const result = await call("wf_get_unreviewed_entities", {});
  return result.entities.map((e) => e.entityId);
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

await test("sanity: a freshly-created entity with no accept/review history at all is not flagged as unreviewed", async () => {
  const flagged = await unreviewedIds();
  assert.ok(!flagged.includes("riverwood-miller"));
});

await test("developing a node's content and accepting it clears its unreviewed flag (task 14.4 regression)", async () => {
  // Fabricate the generated draft directly (no real API call needed to set
  // up the precondition -- savePrepContent is the same persistence step
  // generatePrepContentOp calls after a real model call).
  savePrepContent(WORLD, "riverwood-miller", { entityType: "person", framingUsed: "test framing", fields: PERSON_FIELDS });

  // Precondition: developing (but not yet accepting) content leaves NO
  // human-review record at all -- a "not in the flagged list" check alone
  // would be a false-positive-prone test here (an entity with literally no
  // record is ALSO never flagged, same as one just genuinely reviewed), so
  // assert the real underlying state directly: no record exists yet.
  assert.deepEqual(getHumanReviewState(WORLD, "riverwood-miller"), { lastHumanReviewedAt: null, unreviewedAcceptCount: 0 });

  const result = await call("wf_accept_prep_content", { entityId: "riverwood-miller" });
  assert.equal(result.status, "accepted");

  // THE ACTUAL REGRESSION: a real markHumanReviewed record must now exist --
  // this is the positive proof the OLD code (no markHumanReviewed call at
  // all) could not produce; the OLD code would leave this exactly as it was
  // before accept (no record), indistinguishable from "never touched."
  const reviewState = getHumanReviewState(WORLD, "riverwood-miller");
  assert.ok(reviewState.lastHumanReviewedAt !== null, "accepting a developed node's content should record a genuine, scoped human review");
  assert.equal(reviewState.unreviewedAcceptCount, 0);

  const flagged = await unreviewedIds();
  assert.ok(!flagged.includes("riverwood-miller"), "a just-reviewed entity should not be flagged as unreviewed");
});

await test("accepting prep content for one entity does not affect a completely different, untouched entity", async () => {
  const flagged = await unreviewedIds();
  assert.ok(!flagged.includes("untouched-entity"), "an entity nobody has touched at all should never be surfaced as 'unreviewed' -- it has no accept/review history to be stale");
});

await client.close();
console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
