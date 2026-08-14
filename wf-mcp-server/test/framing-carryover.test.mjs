import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";

/**
 * Friction Wave 1, W2d -- framing carry-over: proposeFromWriteupOp's
 * optional `framing` argument skips the rubber-duck phase-A round entirely
 * and dispatches to selectFramingForNewBatch, recording the carried
 * framings/selection on the new batch's framingHistory audit trail exactly
 * as a phase-B pick would. Deterministic (injected client, no real API).
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-framing-carryover-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_USER_SETTINGS_DIR = join(scratchDir, "user-settings");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "framing-carryover-test-world";

const { snapshotFilePath } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../graph-import/headless-apply.mjs");
const { proposeFromWriteupOp } = await import("../lib/mutation-ops.mjs");
const { setRubberDuckMode } = await import("../../mutation-engine/user-settings.mjs");
const { loadBatch } = await import("../../mutation-engine/review-state.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

after(() => rmSync(scratchDir, { recursive: true, force: true }));

function mockClient(responses) {
  let call = 0;
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        const resp = responses[Math.min(call, responses.length - 1)];
        call++;
        return { content: [{ type: "text", text: resp }], stop_reason: "end_turn" };
      }
    }
  };
}

const FRAMINGS = [
  { id: "a", sentence: "A tale of debts coming due." },
  { id: "b", sentence: "A conspiracy woven into the city's fabric." },
  { id: "c", sentence: "A portrait of a town on the eve of ruin." }
];
const SELECTION = { primary: FRAMINGS[1], blend: "keep the fate-threads front and center" };
// The snapshot echoed by the ORIGINAL phase-A response -- deliberately an
// old timestamp, distinct from anything the live settings store would say.
const CARRIED_RUBBER_DUCK = { enabled: true, updatedAt: "2026-08-13T00:00:00.000Z" };

const EMPTY_EXTRACTION = JSON.stringify({ entities: [], edges: [] });

test("W2d: a framing carry-over skips phase A entirely (even with rubber-duck ON live) and records the audit trail like a phase-B pick", async () => {
  setRubberDuckMode(true); // live setting ON -- without the carry-over this call would return {phase:'framing'}
  const client = mockClient([EMPTY_EXTRACTION]);
  const result = await proposeFromWriteupOp(
    dataDir,
    WORLD,
    { text: "half one of the split writeup", framing: { framings: FRAMINGS, selection: SELECTION, rubberDuck: CARRIED_RUBBER_DUCK } },
    { llmOpts: { client } }
  );

  assert.equal(result.phase, undefined, "no phase-A framing response -- the round is skipped");
  assert.ok(result.batchId, "a real batch is created in one call");
  assert.equal(result.framingRound, 1, "the carried round counts as framing round 1");
  assert.equal(client.calls.length, 1, "exactly one LLM call: the extraction -- never a framing call");

  // The steering note composed from the carried selection reached the
  // extraction prompt (the same regenerate-with-note mechanism phase B uses).
  const prompt = String(client.calls[0].messages[0].content);
  assert.match(prompt, /conspiracy woven into the city's fabric/);
  assert.match(prompt, /keep the fate-threads front and center/);

  const batch = loadBatch(WORLD, result.batchId);
  assert.deepEqual(batch.scope.rubberDuck, CARRIED_RUBBER_DUCK, "the CARRIED settings snapshot is stamped -- not a fresh live read");
  assert.equal(batch.scope.framingHistory.length, 1);
  const entry = batch.scope.framingHistory[0];
  assert.deepEqual(entry.framings, FRAMINGS, "the 3 originally-shown framings are on the audit trail");
  assert.deepEqual(entry.selection, SELECTION);
  assert.match(entry.note, /conspiracy woven/i, "the composed note is recorded, same as a phase-B pick");
});

test("W2d: the live rubber-duck setting is NOT re-read on the carry-over path (carried snapshot wins even when the live toggle is now OFF)", async () => {
  setRubberDuckMode(false); // GM flipped it off since the original submission
  const client = mockClient([EMPTY_EXTRACTION]);
  const result = await proposeFromWriteupOp(
    dataDir,
    WORLD,
    { text: "half two of the split writeup", framing: { framings: FRAMINGS, selection: { primary: FRAMINGS[0] }, rubberDuck: CARRIED_RUBBER_DUCK } },
    { llmOpts: { client } }
  );
  const batch = loadBatch(WORLD, result.batchId);
  assert.deepEqual(batch.scope.rubberDuck, CARRIED_RUBBER_DUCK, "the resubmit stays consistent with its framed original");
  assert.equal(batch.scope.framingHistory.length, 1);
});

test("W2d: a malformed carry-over is rejected with an actionable error BEFORE any LLM call", async () => {
  const client = mockClient([EMPTY_EXTRACTION]);
  const badShapes = [
    { framings: FRAMINGS.slice(0, 2), selection: SELECTION, rubberDuck: CARRIED_RUBBER_DUCK }, // only 2 framings
    { framings: [FRAMINGS[0], FRAMINGS[0], FRAMINGS[1]], selection: SELECTION, rubberDuck: CARRIED_RUBBER_DUCK }, // duplicate ids
    { framings: FRAMINGS, selection: { blend: "no primary" }, rubberDuck: CARRIED_RUBBER_DUCK }, // missing selection.primary
    { framings: FRAMINGS, selection: SELECTION } // missing rubberDuck snapshot
  ];
  for (const framing of badShapes) {
    await assert.rejects(
      proposeFromWriteupOp(dataDir, WORLD, { text: "text", framing }, { llmOpts: { client } }),
      /Invalid `framing` carry-over/
    );
  }
  assert.equal(client.calls.length, 0, "validation happens before any API spend");
});
