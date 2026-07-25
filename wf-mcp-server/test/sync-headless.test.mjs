import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Phase 2 task 2.4's acceptance criterion: "manual test run twice — Foundry
 * closed (headless path exercised, standalone snapshot verified updated)
 * and Foundry open (live path exercised, existing behavior unchanged). Both
 * report which path was used."
 *
 * Written as an automated test rather than a one-off manual script because
 * it's fully deterministic and needs no external live resource (no real
 * Foundry, no ANTHROPIC_API_KEY -- wf_sync_to_foundry never calls
 * texture.mjs) -- there's no reason not to keep this as a standing
 * regression test in addition to having actually been run and inspected
 * once, which is what satisfies the "manual test" language in spirit.
 *
 * Lives under wf-mcp-server/test/ (its own `node --test`-able tree, run via
 * `node --test wf-mcp-server/test/*.test.mjs` from GM_Tools/, NOT swept up
 * by the root `npm test` glob) rather than the top-level test/ directory,
 * because it needs @modelcontextprotocol/sdk's Client/StdioClientTransport,
 * a dependency deliberately scoped to wf-mcp-server/'s own package.json/
 * node_modules per this repo's established root-vs-wf-mcp-server dependency
 * split (see package.json's own description) -- not something the root
 * suite's pure-library-code tests should need to depend on.
 *
 * Spawns the REAL wf-mcp-server/index.mjs as a child process and drives it
 * over the real MCP protocol via the SDK's Client + StdioClientTransport --
 * this exercises the actual deployed tool surface, not an in-process stand-in.
 * "Foundry closed" is the natural default (nothing clears
 * world-fabric-mutations.json). "Foundry open" is simulated by a background
 * loop in this test process that plays the role of GraphService's own
 * mutation watcher: polls the mutations file and clears it to "[]" once
 * populated, exactly like graph-service.mjs's startMutationWatcher() does.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "index.mjs");

const { snapshotFilePath, mutationsPath } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createBatch, loadBatch } = await import("../../mutation-engine/review-state.mjs");
const { acceptMutations } = await import("../../mutation-engine/rollback.mjs");

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-sync-headless-test-"));
const dataDir = join(scratchDir, "foundrydata");
const reviewStateDir = join(scratchDir, "review-state");
process.env.GM_TOOLS_REVIEW_STATE_DIR = reviewStateDir; // this process's own review-state.mjs calls below

const WORLD = "sync-headless-test-world";
const snapPath = snapshotFilePath(dataDir, WORLD);
const mutPath = mutationsPath(dataDir, WORLD);

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

// --- fixture setup: a real standalone snapshot with one entity, via the same headless path task 2.3 built ---
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [{ op: "upsert_entity", data: { id: "alvor", name: "Alvor", type: "person", importance: 0.3 } }]);

function currentAlvorImportance() {
  const onDisk = JSON.parse(readFileSync(snapPath, "utf8"));
  return onDisk.snapshot.entities.find((e) => e.id === "alvor")?.importance;
}

/** Create + accept a one-mutation batch targeting alvor's importance, via the real review-state/rollback pipeline (not hand-fabricated). */
function makeAcceptedBatch(targetImportance) {
  const entities = [{ id: "alvor", name: "Alvor", type: "person", importance: currentAlvorImportance() }];
  const edges = [];
  const batchId = `batch_sync_test_${targetImportance}`;
  const batch = createBatch(
    WORLD,
    { mode: "manual" },
    "a test session",
    [{
      op: "upsert_entity",
      id: "alvor",
      data: { importance: targetImportance },
      rationale: "test",
      batchId: "placeholder",
      sourceKind: "manual"
    }],
    { makeId: () => batchId }
  );
  const mutationId = batch.mutations[0].mutationId;
  acceptMutations(WORLD, batchId, [mutationId], entities, edges);
  return batchId;
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
      WF_DEFAULT_WORLD: WORLD
    },
    stderr: "pipe"
  });
  client = new Client({ name: "sync-headless-test-client", version: "0.0.0" });
  await client.connect(transport);
}

async function callSync(batchId) {
  const res = await client.callTool({ name: "wf_sync_to_foundry", arguments: { batchId } });
  const textBlock = res.content?.find((b) => b.type === "text");
  return JSON.parse(textBlock.text);
}

await connect();

await test('wf_sync_to_foundry: "Foundry closed" (nothing clears the mutations file) falls back to the headless path, updates the standalone snapshot, and reports path="headless"', async () => {
  const batchId = makeAcceptedBatch(0.77);

  const result = await callSync(batchId);

  assert.equal(result.path, "headless", `expected the headless fallback path; got: ${JSON.stringify(result)}`);
  assert.equal(result.status, "applied");
  assert.equal(result.syncedCount, 1);
  assert.ok(result.liveAttempt && result.liveAttempt.status === "queued", "the live attempt should have been made first, and reported queued");
  assert.ok(result.note.includes("No live Foundry client"));

  assert.equal(currentAlvorImportance(), 0.77, "the standalone snapshot file should be genuinely updated on disk");

  const batch = loadBatch(WORLD, batchId);
  assert.equal(batch.status, "synced");
});

await test('wf_sync_to_foundry: "Foundry open" (a background watcher clears the mutations file promptly) takes the live path, reports path="live", and does NOT touch the standalone snapshot', async () => {
  const beforeImportance = currentAlvorImportance();
  assert.equal(beforeImportance, 0.77, "sanity: continuing from the previous test's headless-applied value");

  // The previous test's mutations file was left non-empty (its poll timed
  // out to "queued" -- nothing ever cleared it, by design). Reset it to
  // "[]" first so the watcher below reacts to THIS test's real write, not
  // stale content left over from the previous test.
  writeFileSync(mutPath, "[]", "utf8");

  // Simulate graph-service.mjs's own startMutationWatcher(): poll the
  // mutations file, and once it's a non-empty array, clear it to "[]" --
  // exactly what the in-Foundry watcher does once it has applied the
  // mutations to its own game.settings-backed state. This test does not
  // need to actually apply them anywhere else (real GraphService state is
  // out of scope headlessly) -- it only needs to prove wf_sync_to_foundry
  // correctly detects the live pickup and stops short of the headless path.
  let watcherActive = true;
  const watcherLoop = (async () => {
    while (watcherActive) {
      try {
        const raw = readFileSync(mutPath, "utf8").trim();
        if (raw && raw !== "[]") {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length) {
            writeFileSync(mutPath, "[]", "utf8");
            break;
          }
        }
      } catch { /* file not written yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();

  const batchId = makeAcceptedBatch(0.99);
  const result = await callSync(batchId);
  watcherActive = false;
  await watcherLoop;

  assert.equal(result.path, "live", `expected the live path (Foundry "open"); got: ${JSON.stringify(result)}`);
  assert.equal(result.status, "applied");
  assert.equal(result.syncedCount, 1);
  assert.equal(result.mutationsFilePath, mutPath, "the raw mutations-file path should be reported under its own field, not collide with the path='live' label");

  // The standalone snapshot must NOT have been touched by this call -- the
  // headless fallback should never have run. It should still hold the
  // PREVIOUS test's headless-applied value (0.77), not the live batch's
  // target value (0.99), since applying 0.99 "live" in this simulation only
  // clears the mutations file -- it doesn't write to the standalone snapshot
  // (that's GraphService's own game.settings-backed job in the real system).
  assert.equal(currentAlvorImportance(), beforeImportance, "the standalone snapshot should be untouched when the live path succeeds");

  const batch = loadBatch(WORLD, batchId);
  assert.equal(batch.status, "synced");
});

await client.close();
console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
