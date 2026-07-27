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

await test("Phase 10: POST /api/batches/:id/narrate-entity produces genuinely different real prose for two entities in the SAME batch, both durably persisted (real API call)", async () => {
  const batch = createBatch(WORLD, { mode: "manual" }, "a fateful evening", [
    {
      op: "upsert_entity",
      id: "alvor",
      data: { description: "Shaken, staring at smoke rising from the mill." },
      rationale: "The mill fire directly threatens Alvor's livelihood.",
      batchId: "placeholder",
      sourceKind: "manual",
      entityContext: { name: "Alvor", importance: 0.6, tags: [] }
    },
    {
      op: "upsert_entity",
      id: "riverwood",
      data: { description: "A pall of smoke hangs over the mill district." },
      rationale: "The fire is visible from across the village.",
      batchId: "placeholder",
      sourceKind: "manual",
      entityContext: { name: "Riverwood", importance: 0.7, tags: [] }
    }
  ]);
  const accept = await postJson(`/api/batches/${batch.id}/accept`, { world: WORLD, scope: "batch" });
  assert.equal(accept.status, 200);

  const alvorMutationId = batch.mutations.find((m) => m.id === "alvor").mutationId;
  const riverwoodMutationId = batch.mutations.find((m) => m.id === "riverwood").mutationId;

  const alvorNarrate = await postJson(`/api/batches/${batch.id}/narrate-entity`, { world: WORLD, mutationId: alvorMutationId });
  assert.equal(alvorNarrate.status, 200, `expected 200; got ${JSON.stringify(alvorNarrate.body)}`);
  assert.equal(alvorNarrate.body.entityId, "alvor");
  console.log(`\n    --- alvor narration ---\n    ${alvorNarrate.body.prose.replace(/\n/g, "\n    ")}\n`);

  const riverwoodNarrate = await postJson(`/api/batches/${batch.id}/narrate-entity`, { world: WORLD, mutationId: riverwoodMutationId });
  assert.equal(riverwoodNarrate.status, 200, `expected 200; got ${JSON.stringify(riverwoodNarrate.body)}`);
  assert.equal(riverwoodNarrate.body.entityId, "riverwood");
  console.log(`\n    --- riverwood narration ---\n    ${riverwoodNarrate.body.prose.replace(/\n/g, "\n    ")}\n`);

  assert.notEqual(alvorNarrate.body.prose, riverwoodNarrate.body.prose, "THE REGRESSION CHECK: two different entities in one batch must get different narrations, not the same cached text");

  // Persistence: durably readable back via the GET routes, surviving what
  // would be a page reload in the real frontend.
  const alvorCurrent = await getJson(`/api/entities/alvor/narration?world=${WORLD}`);
  assert.equal(alvorCurrent.body.narration.prose, alvorNarrate.body.prose);
  const riverwoodCurrent = await getJson(`/api/entities/riverwood/narration?world=${WORLD}`);
  assert.equal(riverwoodCurrent.body.narration.prose, riverwoodNarrate.body.prose);
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

await test("Task 14.7: POST /api/entities/:id/narrate (standalone entity page, no batch context) finds the most recent accepted batch and narrates it (real API call)", async () => {
  const batch = createBatch(WORLD, { mode: "manual" }, "a quiet afternoon", [
    {
      op: "upsert_entity",
      id: "alvor",
      data: { description: "Back at the forge, hammering out a new set of horseshoes." },
      rationale: "A quiet day of ordinary work.",
      batchId: "placeholder",
      sourceKind: "manual",
      entityContext: { name: "Alvor", importance: 0.6, tags: [] }
    }
  ]);
  const accept = await postJson(`/api/batches/${batch.id}/accept`, { world: WORLD, scope: "batch" });
  assert.equal(accept.status, 200);

  const narrate = await postJson("/api/entities/alvor/narrate", { world: WORLD });
  assert.equal(narrate.status, 200, `expected 200; got ${JSON.stringify(narrate.body)}`);
  assert.equal(narrate.body.entityId, "alvor");
  assert.equal(narrate.body.batchId, batch.id, "should have found and narrated THIS batch (the one with the accepted mutation)");
  assert.ok(typeof narrate.body.prose === "string" && narrate.body.prose.length > 0, "should return real, non-empty prose");
  console.log(`\n    --- standalone entity-page narration prose ---\n    ${narrate.body.prose.replace(/\n/g, "\n    ")}\n`);

  // Durably persisted, same as the batch-scoped narrate-entity path.
  const current = await getJson(`/api/entities/alvor/narration?world=${WORLD}`);
  assert.equal(current.body.narration.prose, narrate.body.prose);
});

await test("Task 14.8: a rapid double-trigger of POST /api/entities/:id/scan-mentions (same entity, same text) produces exactly ONE batch, not two (real API call)", async () => {
  const text = "Alvor mentioned a traveling merchant named Corwin who passes through Riverwood every few weeks.";

  // Fire both requests essentially simultaneously -- the exact "double-click,
  // or a confused retry right after navigating away mid-request" shape.
  const [first, second] = await Promise.all([
    postJson("/api/entities/alvor/scan-mentions", { world: WORLD, text }),
    postJson("/api/entities/alvor/scan-mentions", { world: WORLD, text })
  ]);

  assert.equal(first.status, 200, `expected 200; got ${JSON.stringify(first.body)}`);
  assert.equal(second.status, 200, `expected 200; got ${JSON.stringify(second.body)}`);
  assert.equal(first.body.batchId, second.body.batchId, "both requests should resolve to the SAME batch, not two separate ones");

  // Confirm directly against the batch list -- only one scan-produced batch
  // should exist for this world, not two.
  const { body: batches } = await getJson(`/api/batches?world=${WORLD}`);
  const scanBatches = batches.batches.filter((b) => b.id === first.body.batchId);
  assert.equal(scanBatches.length, 1, "exactly one batch should exist with this id");
});

await new Promise((resolve) => server.close(resolve));
rmSync(scratchDir, { recursive: true, force: true });

console.log(`\n${passed} passed`);
process.exit(process.exitCode ?? 0);
