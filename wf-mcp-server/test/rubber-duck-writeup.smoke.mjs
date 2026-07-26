#!/usr/bin/env node
/**
 * Manual/integration smoke test for Phase 8's full rubber-duck-mode round
 * trip — task 8.4's acceptance criterion: "a real, API-backed MCP-protocol
 * smoke test (matching Phase 5's writeup-import-roundtrip.smoke.mjs
 * pattern) covering: rubber-duck OFF end-to-end (unchanged from Phase 5),
 * rubber-duck ON full happy path (framings -> select -> real batch ->
 * accept -> sync), rubber-duck ON plain-reject-loops-to-new-framings,
 * rubber-duck ON second-plain-reject-requires-note, rubber-duck ON
 * explicit-note-reject skips straight to regenerate."
 *
 * NOT run as part of `node --test` — makes several real, billed Anthropic
 * API calls (5 real extraction-tier calls + 2 cheap framing-tier calls,
 * roughly 4-5 minutes total) — follows the established .smoke.mjs
 * naming/exclusion convention. Spawns the REAL wf-mcp-server/index.mjs as a
 * child process and drives it over the real MCP protocol via the SDK's
 * Client + StdioClientTransport — same pattern as
 * writeup-import-roundtrip.smoke.mjs and live-diff-narrate.smoke.mjs.
 *
 * Run manually once ANTHROPIC_API_KEY is set (from GM_Tools/):
 *
 *   node --env-file-if-exists=.env wf-mcp-server/test/rubber-duck-writeup.smoke.mjs
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "index.mjs");

const { snapshotFilePath } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../graph-import/headless-apply.mjs");

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-rubber-duck-smoke-"));
const dataDir = join(scratchDir, "foundrydata");
const reviewStateDir = join(scratchDir, "review-state");
const humanReviewDir = join(scratchDir, "human-review");
const userSettingsDir = join(scratchDir, "user-settings");

const WORLD_OFF = "rubber-duck-smoke-off";
const WORLD_ON = "rubber-duck-smoke-on";
const snapPathOff = snapshotFilePath(dataDir, WORLD_OFF);
const snapPathOn = snapshotFilePath(dataDir, WORLD_ON);

bootstrapSnapshot(snapPathOff, { worldId: WORLD_OFF });
bootstrapSnapshot(snapPathOn, { worldId: WORLD_ON });

const WRITEUP_A = `
The free city of Thornhollow sits where two rivers meet. The Merchant
Council -- a cartel of guild leaders -- has kept an uneasy peace with the
river raiders for a generation by paying them off. Captain Ysolde Marrow
commands the city watch and thinks that's cowardice.
`.trim();

const WRITEUP_B = `
Deep beneath the town of Millhaven, an old dwarven forge has reawakened.
Smoke rises from a chimney nobody has seen lit in three hundred years. The
blacksmith Corwin Ashvale insists he knows nothing about it, but his
apprentice Nell has been sneaking out at night ever since.
`.trim();

let passed = 0;
let failed = 0;
async function step(name, fn) {
  console.log(`\n--- ${name} ---`);
  const start = Date.now();
  try {
    const result = await fn();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  (${elapsed}s)`);
    passed++;
    return result;
  } catch (err) {
    failed++;
    console.error(`FAILED: ${name}`);
    console.error(err.stack || err.message);
    throw err;
  }
}

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
      GM_TOOLS_USER_SETTINGS_DIR: userSettingsDir
    },
    stderr: "pipe"
  });
  client = new Client({ name: "rubber-duck-smoke-client", version: "0.0.0" });
  await client.connect(transport);
}

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const textBlock = res.content?.find((b) => b.type === "text");
  if (res.isError) {
    const err = new Error(textBlock?.text ?? "unknown MCP tool error");
    err.mcpErrorText = textBlock?.text;
    throw err;
  }
  return textBlock ? JSON.parse(textBlock.text) : null;
}

async function callExpectingError(name, args) {
  try {
    await call(name, args);
  } catch (err) {
    return err;
  }
  throw new Error(`Expected tool "${name}" to fail, but it succeeded.`);
}

function readSnapshot(path) {
  return JSON.parse(readFileSync(path, "utf8")).snapshot;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set. This smoke test makes real (billed) Anthropic API calls and cannot run " +
      "without credentials. Set the env var and re-run."
    );
    process.exitCode = 1;
    return;
  }

  await connect();

  // ============================================================================
  // Scenario 1: rubber-duck OFF end-to-end -- unchanged from Phase 5.
  // ============================================================================

  await step("wf_get_rubber_duck_mode: default is off (fresh scratch dir, no settings file yet)", async () => {
    const settings = await call("wf_get_rubber_duck_mode", {});
    if (settings.enabled !== false) throw new Error(`Expected default enabled=false, got ${settings.enabled}`);
  });

  const proposeOff = await step("wf_propose_from_writeup, rubber-duck OFF: single call, real batch, no `phase` field at all", () =>
    call("wf_propose_from_writeup", { world: WORLD_OFF, dataDir, text: WRITEUP_A })
  );
  console.log(JSON.stringify(proposeOff, null, 2));
  if ("phase" in proposeOff) throw new Error("rubber-duck OFF must never return a `phase` field -- that's the ON-mode two-phase marker");
  if (!proposeOff.batchId) throw new Error("expected a real batchId when rubber-duck is off");

  const acceptOff = await step("wf_accept (scope='batch')", () =>
    call("wf_accept", { world: WORLD_OFF, dataDir, batchId: proposeOff.batchId, scope: "batch" })
  );
  console.log(JSON.stringify(acceptOff, null, 2));

  const syncOff = await step("wf_sync_to_foundry", () =>
    call("wf_sync_to_foundry", { world: WORLD_OFF, dataDir, batchId: proposeOff.batchId })
  );
  if (syncOff.status !== "applied") throw new Error(`expected sync status 'applied', got '${syncOff.status}'`);

  await step("confirm the OFF-world graph genuinely reflects the writeup, and the batch's own scope carries no rubberDuck field", () => {
    const snap = readSnapshot(snapPathOff);
    const thornhollow = snap.entities.find((e) => /Thornhollow/i.test(e.name));
    if (!thornhollow) throw new Error('Expected an entity named/mentioning "Thornhollow"');
  });

  // ============================================================================
  // Scenario 2: rubber-duck ON, full happy path (framings -> select -> real
  // batch -> accept -> sync).
  // ============================================================================

  await step("wf_set_rubber_duck_mode(true)", async () => {
    const settings = await call("wf_set_rubber_duck_mode", { enabled: true });
    if (settings.enabled !== true) throw new Error("expected enabled=true after set");
  });

  const proposeOn = await step("wf_propose_from_writeup, rubber-duck ON: phase A, 3 framings, NO batch created yet", () =>
    call("wf_propose_from_writeup", { world: WORLD_ON, dataDir, text: WRITEUP_A })
  );
  console.log(JSON.stringify(proposeOn, null, 2));
  if (proposeOn.phase !== "framing") throw new Error(`expected phase='framing', got '${proposeOn.phase}'`);
  if (!Array.isArray(proposeOn.framings) || proposeOn.framings.length !== 3) throw new Error("expected exactly 3 framings");
  if (proposeOn.batchId) throw new Error("phase A must not create a batch");

  const selectA = await step("wf_select_framing (writeupText path): the reviewer's first pick creates the real batch", () =>
    call("wf_select_framing", {
      world: WORLD_ON,
      dataDir,
      writeupText: proposeOn.writeupText,
      framings: proposeOn.framings,
      selection: { primary: proposeOn.framings[0], blend: "also touch on the river raiders" },
      rubberDuck: proposeOn.rubberDuck
    })
  );
  console.log(JSON.stringify(selectA, null, 2));
  if (!selectA.batchId) throw new Error("expected a real batchId after selecting a framing");
  if (selectA.framingRound !== 1) throw new Error(`expected framingRound=1 (the initial round), got ${selectA.framingRound}`);

  const acceptOn = await step("wf_accept (scope='batch')", () =>
    call("wf_accept", { world: WORLD_ON, dataDir, batchId: selectA.batchId, scope: "batch" })
  );
  console.log(JSON.stringify(acceptOn, null, 2));

  const syncOn = await step("wf_sync_to_foundry", () =>
    call("wf_sync_to_foundry", { world: WORLD_ON, dataDir, batchId: selectA.batchId })
  );
  if (syncOn.status !== "applied") throw new Error(`expected sync status 'applied', got '${syncOn.status}'`);

  await step("confirm the ON-world graph genuinely reflects the writeup, and the batch's own scope carries a rubberDuck+framingHistory record", () => {
    const snap = readSnapshot(snapPathOn);
    const thornhollow = snap.entities.find((e) => /Thornhollow/i.test(e.name));
    if (!thornhollow) throw new Error('Expected an entity named/mentioning "Thornhollow"');
  });

  // ============================================================================
  // Scenario 3: a SEPARATE rubber-duck batch, to exercise the reject loop
  // without disturbing the already-accepted/synced one above.
  // ============================================================================

  const proposeB = await step("wf_propose_from_writeup (rubber-duck already ON), second writeup, for the reject-loop scenarios", () =>
    call("wf_propose_from_writeup", { world: WORLD_ON, dataDir, text: WRITEUP_B })
  );
  if (proposeB.phase !== "framing") throw new Error("expected phase='framing'");

  const selectB = await step("wf_select_framing: create batch B", () =>
    call("wf_select_framing", {
      world: WORLD_ON,
      dataDir,
      writeupText: proposeB.writeupText,
      framings: proposeB.framings,
      selection: { primary: proposeB.framings[1] },
      rubberDuck: proposeB.rubberDuck
    })
  );
  const batchBId = selectB.batchId;
  console.log(`batch B id: ${batchBId}, framingRound=${selectB.framingRound}`);
  if (selectB.framingRound !== 1) throw new Error(`expected framingRound=1, got ${selectB.framingRound}`);

  const plainReject1 = await step("wf_reject (scope='batch', quickPickReason='missing-something'): a PLAIN reject loops back to a NEW round of framings, not a new full proposal", () =>
    call("wf_reject", { world: WORLD_ON, dataDir, batchId: batchBId, scope: "batch", quickPickReason: "missing-something" })
  );
  console.log(JSON.stringify(plainReject1, null, 2));
  if (!plainReject1.rubberDuckLoop || plainReject1.rubberDuckLoop.kind !== "reframe") {
    throw new Error(`expected rubberDuckLoop.kind='reframe', got ${JSON.stringify(plainReject1.rubberDuckLoop)}`);
  }
  if (!Array.isArray(plainReject1.rubberDuckLoop.framings) || plainReject1.rubberDuckLoop.framings.length !== 3) {
    throw new Error("expected exactly 3 new framings from the re-framing round");
  }

  const selectAfterReject = await step("wf_select_framing (batchId path): the reviewer's pick after the re-framing round REPLACES batch B's mutations wholesale", () =>
    call("wf_select_framing", {
      world: WORLD_ON,
      dataDir,
      batchId: batchBId,
      framings: plainReject1.rubberDuckLoop.framings,
      selection: { primary: plainReject1.rubberDuckLoop.framings[2] }
    })
  );
  console.log(JSON.stringify(selectAfterReject, null, 2));
  if (selectAfterReject.framingRound !== 2) {
    throw new Error(`expected framingRound=2 (the bounded re-framing round) after the second round completes, got ${selectAfterReject.framingRound}`);
  }

  // ============================================================================
  // Scenario 4: second-plain-reject-requires-note, AND explicit-note-reject
  // skips straight to regenerate (proven on the SAME batch, showing the
  // explicit-note path bypasses the now-exhausted round budget entirely).
  // ============================================================================

  const plainReject2 = await step("wf_reject (scope='batch', quickPickReason again): a SECOND plain reject on this batch is refused -- the bounded budget (1 re-framing round) is already spent", () =>
    callExpectingError("wf_reject", { world: WORLD_ON, dataDir, batchId: batchBId, scope: "batch", quickPickReason: "wrong-scope" })
  );
  console.log(`Refused as expected: ${plainReject2.mcpErrorText}`);
  if (!/already used its one bounded re-framing round/.test(plainReject2.mcpErrorText ?? "")) {
    throw new Error(`Refusal message doesn't clearly name the problem: "${plainReject2.mcpErrorText}"`);
  }

  const explicitNoteReject = await step("wf_reject (scope='batch', explicit note): skips the framing loop ENTIRELY, straight to the existing regenerate path -- works even though the round budget is exhausted", () =>
    call("wf_reject", {
      world: WORLD_ON,
      dataDir,
      batchId: batchBId,
      scope: "batch",
      note: "Make the dwarven forge angle more central and drop the apprentice subplot."
    })
  );
  console.log(JSON.stringify(explicitNoteReject, null, 2));
  if (!explicitNoteReject.rubberDuckLoop || explicitNoteReject.rubberDuckLoop.kind !== "regenerate") {
    throw new Error(`expected rubberDuckLoop.kind='regenerate', got ${JSON.stringify(explicitNoteReject.rubberDuckLoop)}`);
  }
  if (!explicitNoteReject.rubberDuckLoop.regenerated || !explicitNoteReject.rubberDuckLoop.regenerated.length) {
    throw new Error("expected the explicit-note reject to have actually regenerated mutations");
  }

  await client.close();

  console.log(`\n${passed} steps passed, ${failed} failed.`);
  console.log(
    "\nSMOKE TEST PASSED: rubber-duck OFF unchanged from Phase 5; rubber-duck ON full happy path (framings -> " +
    "select -> real batch -> accept -> sync); plain-reject-loops-to-new-framings; second-plain-reject-requires-note; " +
    "explicit-note-reject skips straight to regenerate, even past the exhausted round budget."
  );
}

try {
  await main();
} catch (err) {
  console.error("\nSMOKE TEST FAILED:", err.message);
  process.exitCode = 1;
} finally {
  try { await client?.close(); } catch { /* already closed or never connected */ }
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
