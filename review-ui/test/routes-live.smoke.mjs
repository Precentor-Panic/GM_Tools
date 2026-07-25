#!/usr/bin/env node
/**
 * Manual/integration smoke test for review-ui/server.mjs's two routes whose
 * success path genuinely requires a real Anthropic API call: POST
 * /api/batches/:id/narrate (once fully accepted) and POST
 * /api/pending-entities/:id/resolve. routes.test.mjs (the deterministic
 * suite, run by `npm test`) already proves the narration GATE fails cleanly
 * with no API call at all -- this file proves the actual success path,
 * matching this project's established split (gm-tools-conventions: "a unit
 * test with the API call mocked ... plus a documented ... smoke test that
 * makes a real API call") and wf-mcp-server/test/live-diff-narrate.smoke.mjs's
 * own precedent for the exact same reasoning at the MCP layer.
 *
 * NOT run as part of `npm test`/`node --test`. Run manually once
 * ANTHROPIC_API_KEY is set:
 *
 *   node --env-file-if-exists=../.env test/routes-live.smoke.mjs
 *
 * (from review-ui/), or from GM_Tools/: node --env-file=.env review-ui/test/routes-live.smoke.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set -- this smoke test makes real API calls and cannot run without it.");
  process.exit(1);
}

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-review-ui-live-smoke-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "review-ui-live-smoke-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createBatch } = await import("../../mutation-engine/review-state.mjs");
const { writePending } = await import("../../mutation-engine/pending-ledger.mjs");
const { createReviewServer } = await import("../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "alvor", name: "Alvor", type: "person", importance: 0.6, description: "A blacksmith in Riverwood." } },
  { op: "upsert_entity", data: { id: "riverwood", name: "Riverwood", type: "place", importance: 0.7, description: "A small mill town." } }
]);

const server = createReviewServer({ port: 0 });
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://localhost:${server.address().port}`;

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}
async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

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

await test("POST /api/batches/:id/narrate on a fully-accepted batch SUCCEEDS and returns real prose (real API call)", async () => {
  const batch = createBatch(WORLD, { mode: "manual" }, "a fateful evening", [
    {
      op: "upsert_entity",
      id: "alvor",
      data: { description: "Shaken, staring at smoke rising from the mill." },
      rationale: "The mill fire directly threatens Alvor's livelihood.",
      batchId: "placeholder",
      sourceKind: "manual",
      entityContext: { name: "Alvor", importance: 0.6, tags: [] }
    }
  ]);
  const accept = await postJson(`/api/batches/${batch.id}/accept`, { world: WORLD, scope: "batch" });
  assert.equal(accept.status, 200);

  const detail = await getJson(`/api/batches/${batch.id}?world=${WORLD}`);
  assert.equal(detail.body.narratable, true);

  const narrate = await postJson(`/api/batches/${batch.id}/narrate`, { world: WORLD });
  assert.equal(narrate.status, 200, `expected 200; got ${JSON.stringify(narrate.body)}`);
  assert.equal(narrate.body.batchId, batch.id);
  assert.ok(typeof narrate.body.prose === "string" && narrate.body.prose.length > 0, "narration should return non-empty real prose");
  console.log(`\n    --- narration prose ---\n    ${narrate.body.prose.replace(/\n/g, "\n    ")}\n`);
});

await test("POST /api/pending-entities/:id/resolve produces a real synthesized diff and clears the ledger entries (real API call)", async () => {
  writePending(WORLD, "riverwood", {
    causeTag: "Riverwood: a stranger arrives asking after the old mill (cycle 1)",
    impactScore: 0.5,
    sourceBatchId: "batch_fixture_cycle1",
    cycleDescriptor: "cycle 1"
  });
  writePending(WORLD, "riverwood", {
    causeTag: "Riverwood: the millpond floods after heavy rain (cycle 2)",
    impactScore: 0.6,
    sourceBatchId: "batch_fixture_cycle2",
    cycleDescriptor: "cycle 2"
  });

  const before = await getJson(`/api/pending-entities?world=${WORLD}`);
  assert.ok(before.body.entities.find((e) => e.entityId === "riverwood"), "riverwood should have a pending backlog before resolving");

  const resolve = await postJson("/api/pending-entities/riverwood/resolve", { world: WORLD, elapsedTimeDescriptor: "a season" });
  assert.equal(resolve.status, 200, `expected 200; got ${JSON.stringify(resolve.body)}`);
  assert.ok(resolve.body.batchId);
  assert.ok(resolve.body.mutationCount >= 1);
  console.log(`\n    --- resolved batch headline ---\n    ${resolve.body.headline.replace(/\n/g, "\n    ")}\n`);

  const detail = await getJson(`/api/batches/${resolve.body.batchId}?world=${WORLD}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.regions.length >= 1);

  const after = await getJson(`/api/pending-entities?world=${WORLD}`);
  assert.ok(!after.body.entities.find((e) => e.entityId === "riverwood"), "riverwood's entries should be locked out of the AVAILABLE list once proposed for resolve");
});

await new Promise((resolve) => server.close(resolve));
rmSync(scratchDir, { recursive: true, force: true });

console.log(`\n${passed} passed`);
process.exit(process.exitCode ?? 0);
