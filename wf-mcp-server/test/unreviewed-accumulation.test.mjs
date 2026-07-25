import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Phase 4 task 4.2's own acceptance criteria, exercised end-to-end against
 * the real deployed MCP server (real subprocess, real MCP protocol, real
 * on-disk state -- same pattern as sync-headless.test.mjs /
 * rollback-created-entity.test.mjs), not just the underlying
 * mutation-engine/human-review.mjs and grain.mjs functions in isolation
 * (those get their own dedicated unit coverage in test/human-review.test.mjs
 * and test/grain.test.mjs). This file's job is proving the WIRING: that
 * wf_accept/wf_reject/wf_regenerate/wf_review_batch actually call into
 * human-review.mjs correctly, and that wf_review_batch's headline rendering
 * actually consults it.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "index.mjs");

const { snapshotFilePath } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createBatch } = await import("../../mutation-engine/review-state.mjs");

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-unreviewed-accumulation-test-"));
const dataDir = join(scratchDir, "foundrydata");
const reviewStateDir = join(scratchDir, "review-state");
const humanReviewDir = join(scratchDir, "human-review");
process.env.GM_TOOLS_REVIEW_STATE_DIR = reviewStateDir; // this process's own createBatch calls below
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = humanReviewDir; // this process's own markHumanReviewed seed call below

const { markHumanReviewed } = await import("../../mutation-engine/human-review.mjs");

const WORLD = "unreviewed-accumulation-test-world";
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
  { op: "upsert_entity", data: { id: "alvor", name: "Alvor", type: "person", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "sven", name: "Sven", type: "person", importance: 0.4 } },
  { op: "upsert_entity", data: { id: "riverwood", name: "Riverwood", type: "place", importance: 0.8 } },
  { op: "upsert_entity", data: { id: "gerdur", name: "Gerdur", type: "person", importance: 0.5 } }
]);

/** A one-mutation batch targeting `entityId`, hand-authored (no LLM call needed to exercise this wiring). */
function makeSingleMutationBatch(entityId, { importance = 0.3, regionId = `region-${entityId}` } = {}) {
  return createBatch(
    WORLD,
    { mode: "manual" },
    "a test session",
    [
      {
        op: "upsert_entity",
        id: entityId,
        data: { description: `Something changed for ${entityId}.` },
        rationale: "test",
        batchId: "placeholder",
        sourceKind: "manual",
        regionId,
        entityContext: { name: entityId, importance, tags: [] }
      }
    ]
  );
}

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
      GM_TOOLS_HUMAN_REVIEW_DIR: humanReviewDir,
      WF_DEFAULT_WORLD: WORLD
    },
    stderr: "pipe"
  });
  client = new Client({ name: "unreviewed-accumulation-test-client", version: "0.0.0" });
  await client.connect(transport);
}

async function callTool(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const textBlock = res.content?.find((b) => b.type === "text");
  return JSON.parse(textBlock.text);
}

async function unreviewedIds() {
  const result = await callTool("wf_get_unreviewed_entities", {});
  return result.entities.map((e) => e.entityId);
}

await connect();

await test("THE CORE DISTINCTION: wf_accept scope='batch' (accept-all) does NOT count as review -- the touched entity is surfaced by wf_get_unreviewed_entities afterward", async () => {
  const batch = makeSingleMutationBatch("alvor");
  const acceptResult = await callTool("wf_accept", { batchId: batch.id, scope: "batch" });
  assert.equal(acceptResult.accepted.length, 1);

  const flagged = await unreviewedIds();
  assert.ok(flagged.includes("alvor"), "a batch-accept-all must leave the touched entity flagged as unreviewed");
});

await test("a scoped wf_accept (scope='entity') DOES count as review -- the entity is NOT surfaced afterward (positive case)", async () => {
  const batch = makeSingleMutationBatch("sven");
  const acceptResult = await callTool("wf_accept", { batchId: batch.id, scope: "entity", id: "sven" });
  assert.equal(acceptResult.accepted.length, 1);

  const flagged = await unreviewedIds();
  assert.ok(!flagged.includes("sven"), "a scoped accept is a genuine review -- must NOT be flagged as unreviewed");
});

await test("wf_review_batch grain='headline' viewing does NOT count as review (still flagged afterward)", async () => {
  const batch = makeSingleMutationBatch("gerdur");
  await callTool("wf_accept", { batchId: batch.id, scope: "batch" }); // build debt via accept-all
  assert.ok((await unreviewedIds()).includes("gerdur"), "sanity: debt exists after the accept-all");

  await callTool("wf_review_batch", { batchId: batch.id, grain: "headline" });

  const flagged = await unreviewedIds();
  assert.ok(flagged.includes("gerdur"), "a headline-grain VIEW is a collapsed overview, not a genuine per-entity review -- must still be flagged");
});

await test("wf_review_batch grain='entity' viewing DOES count as review (clears the flag)", async () => {
  const batch = makeSingleMutationBatch("riverwood");
  await callTool("wf_accept", { batchId: batch.id, scope: "batch" }); // build debt via accept-all
  assert.ok((await unreviewedIds()).includes("riverwood"), "sanity: debt exists after the accept-all");

  const viewResult = await callTool("wf_review_batch", { batchId: batch.id, grain: "entity", entityId: "riverwood" });
  assert.ok(viewResult.rendered.includes("riverwood") || viewResult.rendered.length > 0, "sanity: got a real render back");

  const flagged = await unreviewedIds();
  assert.ok(!flagged.includes("riverwood"), "viewing the full entity diff is a genuine review -- must clear the flag");
});

await test("FORCE-INTO-HEADLINE: an entity flagged for stale/long-unreviewed history surfaces in wf_review_batch's headline even at low importance", async () => {
  // Seed a stale lastHumanReviewedAt directly (equivalent to the 'stale'
  // reason path already unit-tested in human-review.test.mjs/grain.test.mjs
  // -- this test's job is proving wf_review_batch's headline rendering
  // actually wires the flagged set through, not re-proving the underlying
  // staleness math).
  markHumanReviewed(WORLD, ["quiet-shopkeep"], { now: "2020-01-01T00:00:00.000Z" });

  const batch = makeSingleMutationBatch("quiet-shopkeep", { importance: 0.05 }); // well under HEADLINE_IMPORTANCE_THRESHOLD, no pin-review tag

  const headlineResult = await callTool("wf_review_batch", { batchId: batch.id, grain: "headline" });
  assert.ok(
    headlineResult.rendered.includes("quiet-shopkeep"),
    `low-importance entity with stale review history should be forced into the headline; got:\n${headlineResult.rendered}`
  );
  assert.ok(
    headlineResult.rendered.includes("Unreviewed-accumulation flagged for"),
    "the top-level headline should explicitly call out the unreviewed-accumulation flag"
  );
});

await test("wf_get_unreviewed_entities: an entity with no accept/review history at all is never surfaced", async () => {
  const flagged = await unreviewedIds();
  assert.ok(!flagged.includes("completely-untouched-entity"));
});

await client.close();
console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
