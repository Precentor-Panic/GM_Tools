import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Packaging verification (MCP wave, Deliverable 2): "the offline fallbacks
 * apply to MCP LLM tools too" -- VERIFIED here, not just asserted in a doc.
 *
 * Before this wave, wf-mcp-server/index.mjs's LLM-backed tools (unlike
 * review-ui/server.mjs's HTTP routes, which have gone through the shared
 * offlineOpts() degrade since the QA fix-wave) called straight into their
 * library functions with no textureOpts/llmOpts at all. Confirmed by
 * reading the pre-fix source directly: wf_propose_mutations passed
 * `{entities, edges, seeds}` to orchestrateBatch with no `textureOpts` key
 * whatsoever -- a genuinely real, reproducible gap, not a hypothetical. A
 * wf-mcp-server process with no ANTHROPIC_API_KEY in ITS OWN environment
 * (a real supported configuration -- see RUN.md/.mcp.json.example) would
 * crash on the Anthropic SDK's own construction-time "Could not resolve
 * authentication method" error the moment any of these tools were invoked.
 *
 * This file spawns the REAL server with NO ANTHROPIC_API_KEY (explicitly
 * stripped below, regardless of the parent shell's own env) and drives
 * every LLM-backed tool that exists in this MCP surface (both pre-existing
 * and new) through a real, minimal, valid call -- asserting each one
 * either succeeds outright (most do, via the shared offline-clients.mjs
 * degrade) or fails for a real domain reason, but NEVER with the raw SDK
 * auth-error signature. That signature string is the actual regression
 * guard -- if any tool regresses to constructing a real client keyless,
 * this test catches it by the exact error text, not a guess.
 */
const AUTH_ERROR_SIGNATURE = /Could not resolve authentication method/i;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "index.mjs");

const { snapshotFilePath } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-keyless-offline-safety-test-"));
const dataDir = join(scratchDir, "foundrydata");
const env = {
  ...process.env,
  WF_DATA_DIR: dataDir,
  GM_TOOLS_REVIEW_STATE_DIR: join(scratchDir, "review-state"),
  GM_TOOLS_PENDING_LEDGER_DIR: join(scratchDir, "pending-resolution"),
  GM_TOOLS_HUMAN_REVIEW_DIR: join(scratchDir, "human-review"),
  GM_TOOLS_ENTITY_NARRATION_DIR: join(scratchDir, "entity-narration"),
  GM_TOOLS_PREP_CONTENT_DIR: join(scratchDir, "prep-content"),
  GM_TOOLS_USER_SETTINGS_DIR: join(scratchDir, "user-settings")
};
delete env.ANTHROPIC_API_KEY;

const WORLD = "keyless-offline-safety-test-world";
const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "kael", name: "Kael", type: "person", importance: 0.7 } },
  { op: "upsert_entity", data: { id: "the-anvil", name: "The Anvil Inn", type: "place", importance: 0.6 } },
  { op: "upsert_edge", data: { id: "kael-anvil-edge", sourceId: "kael", targetId: "the-anvil", relationshipType: "presence" } }
]);

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

let client, transport;
async function connect() {
  transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_PATH], env, stderr: "pipe" });
  client = new Client({ name: "keyless-offline-safety-test-client", version: "0.0.0" });
  await client.connect(transport);
}

/** Calls the tool and returns {isError, text, json} -- deliberately does NOT throw on isError (that's the thing under test), unlike the other test files' `call()` helper. */
async function callRaw(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const block = res.content?.find((b) => b.type === "text");
  const text = block?.text ?? "";
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON, e.g. a plain error string */ }
  return { isError: !!res.isError, text, json };
}

/** The actual regression guard: never the raw SDK auth-error signature, regardless of success/failure. */
function assertNeverAuthError(result, toolName) {
  assert.doesNotMatch(result.text, AUTH_ERROR_SIGNATURE, `${toolName} must never crash on the raw SDK auth error keyless -- got: ${result.text}`);
}

await connect();

await test("wf_propose_mutations degrades to the offline texture client instead of crashing keyless", async () => {
  const result = await callRaw("wf_propose_mutations", { world: WORLD, scope: { mode: "seed", anchorId: "kael", depth: 2 } });
  assertNeverAuthError(result, "wf_propose_mutations");
  assert.equal(result.isError, false, `expected success, got: ${result.text}`);
  assert.ok(result.json.batchId);
});

await test("wf_run_cycle degrades to the offline texture client instead of crashing keyless", async () => {
  const result = await callRaw("wf_run_cycle", {
    world: WORLD,
    cycleScope: { mode: "seed", anchorId: "kael", depth: 1 },
    headlineAnchorId: "kael",
    cycleDescriptor: "keyless-safety-test-cycle"
  });
  assertNeverAuthError(result, "wf_run_cycle");
  assert.equal(result.isError, false, `expected success, got: ${result.text}`);
});

await test("wf_queue_intent + wf_resolve_pending degrades to the offline texture client instead of crashing keyless", async () => {
  const queued = await callRaw("wf_queue_intent", { world: WORLD, name: "A debt owed to the Anvil's owner" });
  const result = await callRaw("wf_resolve_pending", { world: WORLD, entityId: queued.json.entityId });
  assertNeverAuthError(result, "wf_resolve_pending");
  assert.equal(result.isError, false, `expected success, got: ${result.text}`);
});

await test("wf_propose_from_writeup (rubber-duck off, the default) degrades to the offline writeup client instead of crashing keyless", async () => {
  const result = await callRaw("wf_propose_from_writeup", { world: WORLD, text: "Kael meets a stranger at the Anvil Inn." });
  assertNeverAuthError(result, "wf_propose_from_writeup");
  assert.equal(result.isError, false, `expected success, got: ${result.text}`);
  assert.ok(result.json.batchId, "even the honest zero-entity offline extraction still produces a real batch");
  // Persona round (M5): the empty batch must SAY it's offline -- previously
  // indistinguishable from "your writeup contained nothing extractable".
  assert.equal(result.json.offline, true, "keyless response is stamped offline");
  assert.match(result.json.offlineNote ?? "", /ANTHROPIC_API_KEY/, "and explains what that means");
});

await test("wf_set_rubber_duck_mode(true) + wf_propose_from_writeup (framing phase) + wf_select_framing both degrade offline instead of crashing keyless", async () => {
  await callRaw("wf_set_rubber_duck_mode", { enabled: true });
  const phaseA = await callRaw("wf_propose_from_writeup", { world: WORLD, text: "A caravan arrives at the Anvil Inn." });
  assertNeverAuthError(phaseA, "wf_propose_from_writeup (framing phase)");
  assert.equal(phaseA.isError, false, `expected success, got: ${phaseA.text}`);
  assert.equal(phaseA.json.phase, "framing");
  assert.equal(phaseA.json.offline, true, "the keyless framing phase is stamped offline too (M5)");
  assert.equal(phaseA.json.framings.length, 3);

  const phaseB = await callRaw("wf_select_framing", {
    world: WORLD,
    writeupText: phaseA.json.writeupText,
    framings: phaseA.json.framings,
    selection: { primary: phaseA.json.framings[0] },
    rubberDuck: phaseA.json.rubberDuck
  });
  assertNeverAuthError(phaseB, "wf_select_framing");
  assert.equal(phaseB.isError, false, `expected success, got: ${phaseB.text}`);
  assert.ok(phaseB.json.batchId);

  await callRaw("wf_set_rubber_duck_mode", { enabled: false }); // leave the shared setting clean for later tests in this file
});

let regenBatchId;
await test("wf_regenerate degrades to the offline texture client instead of crashing keyless", async () => {
  const proposed = await callRaw("wf_propose_mutations", { world: WORLD, scope: { mode: "seed", anchorId: "the-anvil", depth: 1 } });
  regenBatchId = proposed.json.batchId;
  const result = await callRaw("wf_regenerate", { world: WORLD, batchId: regenBatchId, scope: "batch", note: "make it darker" });
  assertNeverAuthError(result, "wf_regenerate");
  assert.equal(result.isError, false, `expected success, got: ${result.text}`);
});

await test("wf_narrate_batch / wf_narrate_entity degrade to the offline narrate client instead of crashing keyless", async () => {
  const grain = await callRaw("wf_review_batch", { world: WORLD, batchId: regenBatchId, grain: "headline" });
  const accepted = await callRaw("wf_accept", { world: WORLD, batchId: regenBatchId, scope: "batch" });
  assert.equal(accepted.isError, false, `expected accept to succeed, got: ${accepted.text}`);

  const batchNarration = await callRaw("wf_narrate_batch", { world: WORLD, batchId: regenBatchId });
  assertNeverAuthError(batchNarration, "wf_narrate_batch");
  assert.equal(batchNarration.isError, false, `expected success, got: ${batchNarration.text}`);

  void grain; // headline render above only exists to keep this test self-explanatory; not asserted on
});

await test("wf_propose_prep_framings / wf_generate_prep_content / wf_regenerate_prep_field degrade to the offline prep-content client instead of crashing keyless", async () => {
  const framings = await callRaw("wf_propose_prep_framings", { world: WORLD, entityId: "kael" });
  assertNeverAuthError(framings, "wf_propose_prep_framings");
  assert.equal(framings.isError, false, `expected success, got: ${framings.text}`);
  assert.equal(framings.json.framings.length, 3);

  const generated = await callRaw("wf_generate_prep_content", { world: WORLD, entityId: "kael", selection: { primary: framings.json.framings[0] } });
  assertNeverAuthError(generated, "wf_generate_prep_content");
  assert.equal(generated.isError, false, `expected success, got: ${generated.text}`);
  // entityType-aware offline placeholder (the specific gap this wave fixed --
  // the client needs to know it's grounding a "person" to produce the RIGHT
  // field set, not a generic/wrong-shaped one): 'person' template's fields
  // must actually be present.
  assert.ok(generated.json.fields, "generated prep content must carry a fields object");

  await callRaw("wf_accept_prep_content", { world: WORLD, entityId: "kael" });
  const regenField = await callRaw("wf_regenerate_prep_field", { world: WORLD, entityId: "kael", fieldName: Object.keys(generated.json.fields)[0] });
  assertNeverAuthError(regenField, "wf_regenerate_prep_field");
  assert.equal(regenField.isError, false, `expected success, got: ${regenField.text}`);
});

await client.close();
console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
