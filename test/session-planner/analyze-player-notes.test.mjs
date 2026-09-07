import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

/**
 * CONTRACT — session-planner/analyze-player-notes.mjs (GM-only, truth-aware
 * player-note analysis). Mirrors session-wrap.test.mjs's isolation pattern:
 * every store pointed at a scratch dir BEFORE import; the LLM call is a mocked
 * client so validation (drop-not-coerce) and the zero-spend short-circuit are
 * pinned without a real API call.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-analyze-notes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_NARRATIVE_STATE_DIR = join(scratchDir, "narrative-state");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.WF_DATA_DIR = dataDir;
process.env.WF_TIMELINE_GIT = "0";

const WORLD = "analyze-notes-world";

const { analyzePlayerNotes } = await import("../../session-planner/analyze-player-notes.mjs");
const { setNarrativeTruth, setRevealState } = await import("../../mutation-engine/narrative-state.mjs");
const { snapshotFilePath, playerNotesPath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");

// Snapshot with two entities.
const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "ent-source", name: "The Source", type: "object", description: "A hidden force.", importance: 0.9 } },
  { op: "upsert_entity", data: { id: "ent-mira", name: "Mira", type: "person", description: "A barkeep.", importance: 0.4 } }
]);
// ent-source carries a withheld truth (a close-to-truth target).
setNarrativeTruth(dataDir, WORLD, "ent-source", "It is a failing pre-war device draining the land's magic.", { stance: "concealing" }, { now: "2026-09-07T00:00:00.000Z" });
setRevealState(dataDir, WORLD, "ent-source", "unrevealed", { source: "test" }, { now: "2026-09-07T00:01:00.000Z" });

function writeNotes(notes) {
  const p = playerNotesPath(dataDir, WORLD);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ version: 1, worldId: WORLD, notes }, null, 2), "utf8");
}

/** Fake Anthropic-SDK-shaped client returning canned flags; counts calls. */
function fakeClient(flags) {
  const state = { calls: 0 };
  const client = {
    messages: { create: async () => { state.calls++; return { content: [{ type: "text", text: JSON.stringify({ flags }) }], stop_reason: "end_turn" }; } }
  };
  return { client, state };
}

test("empty notes -> zero-spend short-circuit, client never called", async () => {
  writeNotes([]);
  const { client, state } = fakeClient([]);
  const result = await analyzePlayerNotes(dataDir, WORLD, { client });
  assert.deepEqual(result, { flags: [], dropped: [], noteCount: 0 });
  assert.equal(state.calls, 0, "no LLM call when there are no notes");
});

test("valid flags kept; author carried from the note; invalid dropped not coerced", async () => {
  writeNotes([
    { noteId: "n1", title: "theory", text: "I think the water problem is a machine underground", authorId: "u_alice", authorName: "Alice" },
    { noteId: "n2", title: "q", text: "wait who runs the gates?", authorId: "u_bob", authorName: "Bob" }
  ]);
  const { client, state } = fakeClient([
    { noteId: "n1", entityId: "ent-source", kind: "close-to-truth", detail: "warm on the Source" },
    { noteId: "n2", kind: "confusion", detail: "unsure about the Copper Hand" },
    { noteId: "ghost", kind: "thread", detail: "unknown note" },              // unknown noteId -> drop
    { noteId: "n1", entityId: "ent-nope", kind: "thread", detail: "bad ent" }, // unknown entityId -> drop
    { noteId: "n2", kind: "close-to-truth", detail: "no entityId" },           // close-to-truth needs entityId -> drop
    { noteId: "n1", kind: "banter", detail: "bad kind" }                       // invalid kind -> drop
  ]);
  const result = await analyzePlayerNotes(dataDir, WORLD, { client });
  assert.equal(state.calls, 1);
  assert.equal(result.noteCount, 2);
  assert.equal(result.flags.length, 2);
  const f1 = result.flags.find((f) => f.noteId === "n1");
  assert.equal(f1.kind, "close-to-truth");
  assert.equal(f1.entityId, "ent-source");
  assert.equal(f1.authorId, "u_alice", "author comes from the note, not the model");
  const f2 = result.flags.find((f) => f.noteId === "n2");
  assert.equal(f2.kind, "confusion");
  assert.equal(f2.entityId, null);
  assert.equal(f2.authorId, "u_bob");
  assert.equal(result.dropped.length, 4);
  const reasons = new Set(result.dropped.map((d) => d.reason));
  assert.ok(reasons.has("unknown noteId"));
  assert.ok(reasons.has("unknown entityId"));
  assert.ok(reasons.has("close-to-truth needs a real entityId"));
  assert.ok(reasons.has("invalid kind"));
});

test("cleanup", () => {
  rmSync(scratchDir, { recursive: true, force: true });
});
