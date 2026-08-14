import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * Friction Wave 1, W2d -- HTTP layer: POST /api/writeup-propose accepts the
 * optional `framing` carry-over and skips the rubber-duck phase-A round
 * (proposeFromWriteupOp's dispatch, shared verbatim with the MCP tool).
 * Runs keyless -- the offline writeup client returns an honestly-empty
 * extraction, which still creates a REAL batch whose framingHistory this
 * test asserts on.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-w2d-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_USER_SETTINGS_DIR = join(scratchDir, "user-settings");
process.env.WF_DATA_DIR = dataDir;
delete process.env.ANTHROPIC_API_KEY; // force the offline-degrade path

const WORLD = "w2d-carryover-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../graph-import/headless-apply.mjs");
const { setRubberDuckMode } = await import("../../mutation-engine/user-settings.mjs");
const { loadBatch } = await import("../../mutation-engine/review-state.mjs");
const { createReviewServer } = await import("../server.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

const FRAMINGS = [
  { id: "a", sentence: "Reading one." },
  { id: "b", sentence: "Reading two." },
  { id: "c", sentence: "Reading three." }
];
const CARRY_OVER = {
  framings: FRAMINGS,
  selection: { primary: FRAMINGS[0] },
  rubberDuck: { enabled: true, updatedAt: "2026-08-13T00:00:00.000Z" }
};

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

test("W2d: writeup-propose with a framing carry-over creates a batch in one call even with rubber-duck ON, audit trail recorded", async () => {
  setRubberDuckMode(true); // without the carry-over this would return {phase:'framing'} and no batch
  const res = await fetch(`${base}/api/writeup-propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, text: "second half of a split writeup", framing: CARRY_OVER })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.phase, undefined, "phase A skipped");
  assert.ok(body.batchId, "a real batch landed in one round trip");

  const batch = loadBatch(WORLD, body.batchId);
  assert.deepEqual(batch.scope.rubberDuck, CARRY_OVER.rubberDuck, "the carried snapshot is stamped, not a live re-read");
  assert.equal(batch.scope.framingHistory.length, 1);
  assert.deepEqual(batch.scope.framingHistory[0].framings, FRAMINGS);
});

test("W2d: a malformed framing carry-over is a 400 with an actionable message", async () => {
  const res = await fetch(`${base}/api/writeup-propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, text: "text", framing: { framings: FRAMINGS.slice(0, 2), selection: { primary: FRAMINGS[0] } } })
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Invalid `framing` carry-over/);
});
