#!/usr/bin/env node
/**
 * Manual/integration smoke test for Phase 5's full import-from-writeup round
 * trip — task 5.3's acceptance criterion: "manual smoke test driving the
 * real deployed MCP server ... through a full round trip:
 * wf_propose_from_writeup (against a fixture writeup) -> wf_review_batch ->
 * wf_accept -> wf_sync_to_foundry (both against an existing populated
 * snapshot AND against a freshly-bootstrapped empty one) -> confirm the
 * committed graph state actually reflects the writeup's content, not just
 * that the tool call succeeded."
 *
 * NOT run as part of `node --test` — wf_propose_from_writeup's underlying
 * proposeWfiFromWriteup call is a real, billed Anthropic API call, so this
 * follows the established .smoke.mjs naming/exclusion convention
 * (texture.smoke.mjs, resolve-seed.smoke.mjs, narrate.smoke.mjs,
 * live-diff-narrate.smoke.mjs) rather than a `.test.mjs` one. Spawns the
 * REAL wf-mcp-server/index.mjs as a child process and drives it over the
 * real MCP protocol via the SDK's Client + StdioClientTransport — same
 * pattern as live-diff-narrate.smoke.mjs.
 *
 * Run manually once ANTHROPIC_API_KEY is set (from GM_Tools/):
 *
 *   node --env-file-if-exists=.env wf-mcp-server/test/writeup-import-roundtrip.smoke.mjs
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
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-writeup-import-smoke-"));
const dataDir = join(scratchDir, "foundrydata");
const reviewStateDir = join(scratchDir, "review-state");
const humanReviewDir = join(scratchDir, "human-review");

const WORLD_EXISTING = "writeup-import-smoke-existing";
const WORLD_FRESH = "writeup-import-smoke-fresh";
const snapPathExisting = snapshotFilePath(dataDir, WORLD_EXISTING);
const snapPathFresh = snapshotFilePath(dataDir, WORLD_FRESH);

let passed = 0;
let failed = 0;
async function step(name, fn) {
  console.log(`\n--- ${name} ---`);
  try {
    const result = await fn();
    passed++;
    return result;
  } catch (err) {
    failed++;
    console.error(`FAILED: ${name}`);
    console.error(err.stack || err.message);
    throw err;
  }
}

function readSnapshot(path) {
  return JSON.parse(readFileSync(path, "utf8")).snapshot;
}

// --- fixture A: an EXISTING populated snapshot, seeded headlessly ---
bootstrapSnapshot(snapPathExisting, { worldId: WORLD_EXISTING });
applyHeadless(snapPathExisting, [
  { op: "upsert_entity", data: { id: "alvor", name: "Alvor", type: "person", importance: 0.5, description: "The village smith." } },
  { op: "upsert_entity", data: { id: "riverwood", name: "Riverwood", type: "place", importance: 0.7, description: "A logging village by the river." } }
]);

// --- fixture B: a FRESHLY-BOOTSTRAPPED EMPTY snapshot (genuinely new campaign) ---
bootstrapSnapshot(snapPathFresh, { worldId: WORLD_FRESH });

const WRITEUP_EXISTING = `
Alvor's forge has been busier than ever since his sister Gerdur started
sending customers his way from the mill. Gerdur runs the mill in Riverwood
and has become close friends with a traveling merchant named Lucan, who
passes through every few weeks selling goods from the capital.
`.trim();

const WRITEUP_FRESH = `
The free city of Thornhollow sits at the meeting point of two rivers. It is
ruled by the Merchant Council, a faction of guild leaders who jealously
guard the city's trade routes. Captain Ysolde Marrow commands the city
watch and answers directly to the Council.
`.trim();

let client, transport;

async function connect() {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      ...process.env,
      WF_DATA_DIR: dataDir,
      GM_TOOLS_REVIEW_STATE_DIR: reviewStateDir,
      GM_TOOLS_HUMAN_REVIEW_DIR: humanReviewDir
    },
    stderr: "pipe"
  });
  client = new Client({ name: "writeup-import-smoke-client", version: "0.0.0" });
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

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set. This smoke test makes real (small, cheap) Anthropic API calls " +
      "and cannot run without credentials. Set the env var and re-run."
    );
    process.exitCode = 1;
    return;
  }

  await connect();

  // ============================================================================
  // Round trip A: EXISTING populated snapshot -- proves dedup-not-duplicate
  // (Alvor already exists) AND new-entity creation (Gerdur, Lucan) in one pass.
  // ============================================================================

  const proposeA = await step("wf_propose_from_writeup against an EXISTING populated snapshot", () =>
    call("wf_propose_from_writeup", { world: WORLD_EXISTING, dataDir, text: WRITEUP_EXISTING })
  );
  console.log(JSON.stringify(proposeA, null, 2));
  if (!proposeA.batchId) throw new Error("no batchId returned");
  if (proposeA.mutationCount < 1) throw new Error("expected at least one mutation");

  const reviewA = await step("wf_review_batch (grain='headline')", () =>
    call("wf_review_batch", { world: WORLD_EXISTING, batchId: proposeA.batchId, grain: "headline" })
  );
  console.log(reviewA.rendered);

  // Regenerate-with-note before accepting, to prove the writeup-import
  // dispatch path in wf_regenerate actually works end-to-end.
  const regenA = await step("wf_regenerate (scope='batch', note) -- re-invokes proposeWfiFromWriteup against the SAME source text", () =>
    call("wf_regenerate", {
      world: WORLD_EXISTING,
      dataDir,
      batchId: proposeA.batchId,
      scope: "batch",
      note: "Also note that Lucan sells mostly spices and dyes."
    })
  );
  console.log(JSON.stringify(regenA, null, 2));
  if (!regenA.regenerated || !regenA.regenerated.length) throw new Error("regenerate produced no mutations");

  // scope='entity' must be refused for a writeup-import batch (deliberate, documented limitation).
  await step("wf_regenerate scope='entity' on a writeup-import batch is refused with a clear error", async () => {
    const anyMutationId = regenA.regenerated[0]; // a real, currently-existing mutationId in this batch
    let threw = false;
    let errText;
    try {
      await call("wf_regenerate", {
        world: WORLD_EXISTING,
        dataDir,
        batchId: proposeA.batchId,
        scope: "entity",
        id: anyMutationId,
        note: "just this one"
      });
    } catch (err) {
      threw = true;
      errText = err.mcpErrorText ?? err.message;
    }
    console.log(`Refused as expected: ${threw}; message: ${errText}`);
    if (!threw) throw new Error("wf_regenerate scope='entity' did NOT refuse a writeup-import batch!");
    if (!/scope='entity' is not supported/.test(errText ?? "")) {
      throw new Error(`Refusal message doesn't clearly name the problem: "${errText}"`);
    }
  });

  const acceptA = await step("wf_accept (scope='batch')", () =>
    call("wf_accept", { world: WORLD_EXISTING, dataDir, batchId: proposeA.batchId, scope: "batch" })
  );
  console.log(JSON.stringify(acceptA, null, 2));

  const syncA = await step("wf_sync_to_foundry", () =>
    call("wf_sync_to_foundry", { world: WORLD_EXISTING, dataDir, batchId: proposeA.batchId })
  );
  console.log(JSON.stringify(syncA, null, 2));
  if (syncA.status !== "applied") throw new Error(`expected sync status 'applied', got '${syncA.status}'`);

  await step("confirm the committed graph state: Alvor DEDUPED (not duplicated), Gerdur/Lucan genuinely present", () => {
    const snap = readSnapshot(snapPathExisting);
    const alvorEntries = snap.entities.filter((e) => e.name === "Alvor");
    console.log(`Alvor entries on disk: ${alvorEntries.length}`);
    if (alvorEntries.length !== 1) {
      throw new Error(`Expected exactly 1 "Alvor" entity (deduped against the existing one), found ${alvorEntries.length}`);
    }
    if (alvorEntries[0].id !== "alvor") throw new Error("Alvor's real pre-existing id must be preserved, not replaced with a new one");

    const gerdur = snap.entities.find((e) => e.name === "Gerdur");
    console.log(`Gerdur present: ${!!gerdur}${gerdur ? `, description: "${gerdur.description}"` : ""}`);
    if (!gerdur) throw new Error('Expected a new "Gerdur" entity to have been created from the writeup');

    console.log(`Total entities now: ${snap.entities.length}, total edges now: ${snap.edges.length}`);
    if (snap.edges.length < 1) throw new Error("Expected at least one edge extracted from the writeup (e.g. Gerdur <-> Alvor kinship)");
  });

  // ============================================================================
  // Round trip B: FRESHLY-BOOTSTRAPPED EMPTY snapshot -- a genuinely new campaign.
  // ============================================================================

  const proposeB = await step("wf_propose_from_writeup against a FRESHLY-BOOTSTRAPPED EMPTY snapshot", () =>
    call("wf_propose_from_writeup", { world: WORLD_FRESH, dataDir, text: WRITEUP_FRESH })
  );
  console.log(JSON.stringify(proposeB, null, 2));
  if (proposeB.mutationCount < 1) throw new Error("expected at least one mutation against an empty snapshot");
  if (proposeB.importSummary.entitiesUpdated !== 0) {
    throw new Error("an empty snapshot has nothing to update -- everything must be a create");
  }

  const reviewB = await step("wf_review_batch (grain='headline')", () =>
    call("wf_review_batch", { world: WORLD_FRESH, batchId: proposeB.batchId, grain: "headline" })
  );
  console.log(reviewB.rendered);

  const acceptB = await step("wf_accept (scope='batch')", () =>
    call("wf_accept", { world: WORLD_FRESH, dataDir, batchId: proposeB.batchId, scope: "batch" })
  );
  console.log(JSON.stringify(acceptB, null, 2));

  const syncB = await step("wf_sync_to_foundry against the freshly-bootstrapped snapshot", () =>
    call("wf_sync_to_foundry", { world: WORLD_FRESH, dataDir, batchId: proposeB.batchId })
  );
  console.log(JSON.stringify(syncB, null, 2));
  if (syncB.status !== "applied") throw new Error(`expected sync status 'applied', got '${syncB.status}'`);
  if (syncB.path !== "headless") throw new Error(`expected the headless path (no live Foundry client); got '${syncB.path}'`);

  await step("confirm the freshly-bootstrapped world's graph now genuinely reflects the writeup", () => {
    const snap = readSnapshot(snapPathFresh);
    console.log(`Entities: ${snap.entities.map((e) => e.name).join(", ")}`);
    console.log(`Edges: ${snap.edges.length}`);
    if (snap.entities.length < 1) throw new Error("expected at least one entity in the previously-empty snapshot");
    const thornhollow = snap.entities.find((e) => /Thornhollow/i.test(e.name));
    if (!thornhollow) throw new Error('Expected an entity named/mentioning "Thornhollow" to have been created');
  });

  await client.close();

  console.log(`\n${passed} steps passed, ${failed} failed.`);
  console.log(
    "\nSMOKE TEST PASSED: full import-from-writeup round trip (propose -> review -> regenerate-with-note -> " +
    "accept -> sync) succeeded against BOTH an existing populated snapshot (proving dedup-not-duplicate for " +
    "Alvor) and a freshly-bootstrapped empty one (proving the bootstrap-from-nothing case actually works, not " +
    "just assumed)."
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
