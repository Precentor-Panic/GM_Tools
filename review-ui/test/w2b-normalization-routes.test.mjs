import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * Friction Wave 1, W2a/W2b -- HTTP layer: GET /api/batches/:batchId carries
 * the writeup-import pre-dry-run normalization record on the affected rows
 * (grain.mjs -> batchDetailPayload), and a type-conflict-resolved row's
 * triage never reads 'low-risk'. The batch is created through the REAL
 * importWriteup pipeline (mocked LLM client, real normalization + dry-run +
 * diff), against a real on-disk snapshot -- not a hand-assembled batch, so
 * this covers the whole producer-to-payload path.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-w2b-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "w2b-norm-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath, loadSnapshot } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { importWriteup } = await import("../../graph-import/writeup-import.mjs");
const { createReviewServer } = await import("../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  // Real Kilmarn canon shapes: the bridge is an OBJECT, the Lowway carries a
  // leading article.
  { op: "upsert_entity", data: { id: "wf_bridge", name: "Kilmarn Bridge", type: "object", importance: 0.6, description: "A stone bridge." } },
  { op: "upsert_entity", data: { id: "wf_lowway", name: "The Lowway", type: "place", importance: 0.6, description: "A sunken street." } }
]);

function mockClient(response) {
  return { messages: { create: async () => ({ content: [{ type: "text", text: response }], stop_reason: "end_turn" }) } };
}

const extraction = JSON.stringify({
  entities: [
    { name: "Kilmarn Bridge", type: "place", description: "A stone bridge. Threads are tied to the span.", rationale: "Ceremony site." },
    { name: "Lowway", type: "place", description: "A sunken street. Smugglers pass beneath.", rationale: "Mentioned in passing." }
  ],
  edges: []
});

const { snapshot } = loadSnapshot(dataDir, WORLD);
const result = await importWriteup(WORLD, "seed text", snapshot, { llmOpts: { client: mockClient(extraction) } });

let server, base;
before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratchDir, { recursive: true, force: true });
});

test("W2a/W2b: batch detail rows carry writeupNormalization; type-conflict rows are never low-risk", async () => {
  const res = await fetch(`${base}/api/batches/${result.batchId}?world=${WORLD}`);
  assert.equal(res.status, 200);
  const detail = await res.json();
  const rows = detail.regions.flatMap((r) => r.entities);

  const bridge = rows.find((r) => r.name === "Kilmarn Bridge");
  assert.ok(bridge, "bridge row present");
  assert.equal(bridge.entityId, "wf_bridge", "resolved onto the existing entity, not a duplicate create");
  assert.equal(bridge.writeupNormalization.kind, "type-conflict-resolved");
  assert.equal(bridge.writeupNormalization.keptType, "object");
  assert.equal(bridge.writeupNormalization.extractedType, "place");
  assert.notEqual(bridge.triage, "low-risk", "a resolved type conflict always deserves a look");

  const lowway = rows.find((r) => r.name === "The Lowway");
  assert.ok(lowway, "the extracted 'Lowway' resolved to the canon name");
  assert.equal(lowway.entityId, "wf_lowway");
  assert.equal(lowway.writeupNormalization.kind, "near-miss-rename");
  assert.equal(lowway.writeupNormalization.from, "Lowway");
});
