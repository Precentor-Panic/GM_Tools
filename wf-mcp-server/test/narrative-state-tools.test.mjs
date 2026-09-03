import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * CONTRACT UNDER TEST -- the narrative-state ("Layer 2") MCP tools:
 *   wf_get_narrative_state, wf_set_narrative_state, wf_set_reveal_state,
 *   wf_tick_clock, wf_list_narrative_state
 * Real MCP subprocess over stdio against scratch stores, keyless, same
 * harness as run-layout-tools.test.mjs. Also proves the call-A default
 * store location: with NO GM_TOOLS_NARRATIVE_STATE_DIR override, records
 * land inside the WORLD data dir (worlds/<world>/narrative-state/) — the
 * git world-timeline's atomicity requirement.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "index.mjs");
const { snapshotFilePath } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-narrative-state-tools-test-"));
const dataDir = join(scratchDir, "foundrydata");
const env = {
  ...process.env,
  WF_DATA_DIR: dataDir,
  GM_TOOLS_REVIEW_STATE_DIR: join(scratchDir, "review-state"),
  GM_TOOLS_PENDING_LEDGER_DIR: join(scratchDir, "pending-resolution"),
  GM_TOOLS_HUMAN_REVIEW_DIR: join(scratchDir, "human-review"),
  GM_TOOLS_MANUAL_UNDO_DIR: join(scratchDir, "manual-undo")
};
delete env.ANTHROPIC_API_KEY;
delete env.WF_DEFAULT_WORLD;
// Deliberately NO GM_TOOLS_NARRATIVE_STATE_DIR: this test proves the world-dir
// default. The dataDir is itself a scratch dir, so nothing real is touched.
delete env.GM_TOOLS_NARRATIVE_STATE_DIR;

const WORLD = "narrative-state-tools-test-world";
const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "ns-vane", name: "Corvin Vane", type: "person", importance: 0.9 } },
  { op: "upsert_entity", data: { id: "ns-source", name: "The Source", type: "object", importance: 0.9 } }
]);

const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_PATH], env, stderr: "pipe" });
const client = new Client({ name: "narrative-state-tools-test-client", version: "0.0.0" });
await client.connect(transport);

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const textBlock = res.content?.find((b) => b.type === "text");
  if (res.isError) throw new Error(textBlock?.text ?? "unknown MCP tool error");
  return textBlock ? JSON.parse(textBlock.text) : null;
}
async function callExpectError(name, args) {
  const res = await client.callTool({ name, arguments: args });
  assert.equal(res.isError, true, `expected ${name} to error`);
  return res.content?.find((b) => b.type === "text")?.text ?? "";
}

await test("wf_get_narrative_state: no record => narrativeState:null (fully open), name joined", async () => {
  const res = await call("wf_get_narrative_state", { world: WORLD, entityId: "ns-vane" });
  assert.equal(res.narrativeState, null);
  assert.equal(res.entityName, "Corvin Vane");
});

await test("wf_set_narrative_state: combined write creates the record; truth+stance+reveal round-trip", async () => {
  const res = await call("wf_set_narrative_state", {
    world: WORLD,
    entityId: "ns-vane",
    truth: "He is quietly draining the Source to fuel his ascension.",
    stance: "concealing"
  });
  assert.equal(res.narrativeState.revealState, "unrevealed", "truth-first creation defaults to unrevealed");
  assert.equal(res.narrativeState.stance, "concealing");
  assert.equal(res.narrativeState.transitions.length, 1);
  assert.equal(res.narrativeState.transitions[0].from, null);
});

await test("call-A store location: the record file lives inside the WORLD data dir, beside the snapshot", async () => {
  const recordPath = join(dataDir, "worlds", WORLD, "narrative-state", "ns-vane.json");
  assert.ok(existsSync(recordPath), `expected ${recordPath} to exist`);
});

await test("wf_set_reveal_state appends transitions; same-state is a safe no-op", async () => {
  let res = await call("wf_set_reveal_state", { world: WORLD, entityId: "ns-vane", to: "hinted", note: "the ledger clue", sessionNumber: 2 });
  assert.equal(res.narrativeState.revealState, "hinted");
  assert.equal(res.narrativeState.transitions.length, 2);
  assert.equal(res.narrativeState.transitions[1].note, "the ledger clue");
  assert.equal(res.narrativeState.transitions[1].sessionNumber, 2);
  res = await call("wf_set_reveal_state", { world: WORLD, entityId: "ns-vane", to: "hinted" });
  assert.equal(res.narrativeState.transitions.length, 2, "no-op appended nothing");
});

await test("wf_set_narrative_state: null clears truth/stance without touching reveal state or history", async () => {
  const res = await call("wf_set_narrative_state", { world: WORLD, entityId: "ns-vane", truth: null, stance: null });
  assert.equal(res.narrativeState.truth, undefined);
  assert.equal(res.narrativeState.stance, undefined);
  assert.equal(res.narrativeState.revealState, "hinted");
  assert.equal(res.narrativeState.transitions.length, 2);
});

await test("clocks: set via wf_set_narrative_state, tick clamps, missing clock errors", async () => {
  await call("wf_set_narrative_state", { world: WORLD, entityId: "ns-source", revealState: "hidden", clock: { value: 0, max: 4, cadence: "per session" } });
  let res = await call("wf_tick_clock", { world: WORLD, entityId: "ns-source" });
  assert.equal(res.narrativeState.clock.value, 1);
  res = await call("wf_tick_clock", { world: WORLD, entityId: "ns-source", delta: 99 });
  assert.equal(res.narrativeState.clock.value, 4, "clamped at max");
  const errText = await callExpectError("wf_tick_clock", { world: WORLD, entityId: "ns-vane" });
  assert.match(errText, /no clock to tick/);
});

await test("wf_list_narrative_state: full list with names, revealState filter, and ids bulk mode", async () => {
  const all = await call("wf_list_narrative_state", { world: WORLD });
  assert.equal(all.records.length, 2);
  assert.ok(all.records.some((r) => r.entityName === "Corvin Vane"));
  const hidden = await call("wf_list_narrative_state", { world: WORLD, revealState: "hidden" });
  assert.deepEqual(hidden.records.map((r) => r.entityId), ["ns-source"]);
  const bulk = await call("wf_list_narrative_state", { world: WORLD, ids: ["ns-vane", "no-such-entity"] });
  assert.deepEqual(bulk.records.map((r) => r.entityId), ["ns-vane"], "absent entities absent — callers treat absence as open");
});

await test("writes against an entity missing from the snapshot are refused with a clear error", async () => {
  const errText = await callExpectError("wf_set_narrative_state", { world: WORLD, entityId: "ghost", truth: "boo" });
  assert.match(errText, /No committed entity "ghost"/);
});

after(async () => {
  await client.close();
  rmSync(scratchDir, { recursive: true, force: true });
});
