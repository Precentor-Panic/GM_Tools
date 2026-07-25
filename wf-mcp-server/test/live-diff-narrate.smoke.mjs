#!/usr/bin/env node
/**
 * Manual/integration smoke test for Phase 3's full live-diff round trip —
 * task 3.3's acceptance criterion: "manual smoke test driving the real
 * deployed MCP server (same pattern Phase 2's sync-headless.test.mjs used —
 * real subprocess, real MCP protocol, not a mocked handler call) through a
 * full live-diff round trip: wf_propose_mutations (single seed) ->
 * wf_review_batch -> wf_accept -> wf_narrate_batch -> confirm the narration
 * is rejected if attempted against a batch with pending/rejected mutations
 * still in it." Also exercises the rest of Phase 3's Definition of Done:
 * regenerate-with-note on the narration, then wf_sync_to_foundry.
 *
 * NOT run as part of `node --test` / `npm test` (in this directory or the
 * repo root) — unlike sync-headless.test.mjs (which needs no API key,
 * because wf_sync_to_foundry never calls texture.mjs), this script's
 * wf_propose_mutations and wf_narrate_batch calls are genuinely billed
 * Anthropic API calls, so it follows this repo's established .smoke.mjs
 * naming/exclusion convention (texture.smoke.mjs, resolve-seed.smoke.mjs,
 * narrate.smoke.mjs) rather than sync-headless.test.mjs's automated-.test.mjs
 * one. Still spawns the REAL wf-mcp-server/index.mjs as a child process and
 * drives it over the real MCP protocol via the SDK's Client +
 * StdioClientTransport, exactly like sync-headless.test.mjs does — the only
 * difference from that file's pattern is the file extension/exclusion, not
 * the transport or protocol realism.
 *
 * Run manually once ANTHROPIC_API_KEY is set (from GM_Tools/):
 *
 *   node --env-file-if-exists=.env wf-mcp-server/test/live-diff-narrate.smoke.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "index.mjs");

const { snapshotFilePath } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-live-diff-narrate-smoke-"));
const dataDir = join(scratchDir, "foundrydata");
const reviewStateDir = join(scratchDir, "review-state");
const statusDir = join(scratchDir, "time-skip-status");
const humanReviewDir = join(scratchDir, "human-review"); // Phase 4 task 4.2 -- wf_accept below writes here; must not touch the real repo default

const WORLD = "live-diff-narrate-smoke-world";
const snapPath = snapshotFilePath(dataDir, WORLD);

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

// --- fixture: a small "Riverwood" town, seeded headlessly (no live Foundry client needed) ---
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "riverwood", name: "Riverwood", type: "place", importance: 0.8, summary: "A logging village by the river." } },
  { op: "upsert_entity", data: { id: "alvor", name: "Alvor", type: "person", importance: 0.5, summary: "The village smith, runs the forge." } },
  { op: "upsert_entity", data: { id: "gerdur", name: "Gerdur", type: "person", importance: 0.5, summary: "Alvor's sister, runs the mill." } },
  { op: "upsert_entity", data: { id: "sven", name: "Sven", type: "person", importance: 0.4, summary: "The innkeeper's helper, a bard at heart." } },
  { op: "upsert_edge", data: { id: "e-kin", sourceId: "alvor", targetId: "gerdur", relationshipType: "kinship", strength: 0.8 } },
  { op: "upsert_edge", data: { id: "e-soc", sourceId: "alvor", targetId: "sven", relationshipType: "social", strength: 0.6 } }
]);
// Seeding through upsert_entity/upsert_edge ops (not a raw snapshot write) exercises
// the same headless-apply path wf_sync_to_foundry's fallback uses -- not a shortcut.

let client, transport;

async function connect() {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      ...process.env,
      WF_DATA_DIR: dataDir,
      GM_TOOLS_REVIEW_STATE_DIR: reviewStateDir,
      GM_TOOLS_TIMESKIP_STATUS_DIR: statusDir,
      GM_TOOLS_HUMAN_REVIEW_DIR: humanReviewDir,
      WF_DEFAULT_WORLD: WORLD
    },
    stderr: "pipe"
  });
  client = new Client({ name: "live-diff-narrate-smoke-client", version: "0.0.0" });
  await client.connect(transport);
}

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const textBlock = res.content?.find((b) => b.type === "text");
  if (res.isError) {
    // errorText()'s shape (index.mjs) is plain "Error: ..." text, NOT JSON --
    // must not JSON.parse an error response (that would throw a masking
    // SyntaxError and hide the real, useful error message from errorText()).
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

  // === Round trip A: propose -> review -> accept (whole batch) -> narrate -> regenerate-with-note -> sync ===

  const proposeA = await step("wf_propose_mutations (scope.mode='seed', anchorId='alvor', depth=1)", () =>
    call("wf_propose_mutations", {
      scope: { mode: "seed", anchorId: "alvor", depth: 1 },
      elapsedTimeDescriptor: "right now"
    })
  );
  console.log(JSON.stringify(proposeA, null, 2));
  const batchIdA = proposeA.batchId;

  const reviewA = await step("wf_review_batch (grain='headline')", () =>
    call("wf_review_batch", { batchId: batchIdA, grain: "headline" })
  );
  console.log(reviewA.rendered);

  const acceptA = await step("wf_accept (scope='batch')", () =>
    call("wf_accept", { batchId: batchIdA, scope: "batch" })
  );
  console.log(JSON.stringify(acceptA, null, 2));
  if (acceptA.batchStatus !== "open") {
    // batch.status is only bumped by sync/rollback, not accept -- sanity-check it's still a normal open batch here.
    console.warn(`Note: batch status after accept was "${acceptA.batchStatus}", expected "open" (bumped later by sync).`);
  }

  const narrateA = await step("wf_narrate_batch (fully accepted batch -- should succeed)", () =>
    call("wf_narrate_batch", { batchId: batchIdA })
  );
  console.log("\n=== REAL NARRATION OUTPUT ===");
  console.log(narrateA.prose);
  console.log("=== END NARRATION ===\n");
  if (!narrateA.prose || !narrateA.prose.length) throw new Error("narration prose was empty");

  const narrateARegen = await step("wf_narrate_batch with note (regenerate-with-note)", () =>
    call("wf_narrate_batch", { batchId: batchIdA, note: "Make the tone more urgent and ominous." })
  );
  console.log("\n=== REGENERATED NARRATION (with steering note) ===");
  console.log(narrateARegen.prose);
  console.log("=== END REGENERATED NARRATION ===\n");
  if (!narrateARegen.prose || !narrateARegen.prose.length) throw new Error("regenerated narration prose was empty");
  console.log(`Regenerated narration differs from the original: ${narrateARegen.prose !== narrateA.prose}`);

  const syncA = await step("wf_sync_to_foundry", () => call("wf_sync_to_foundry", { batchId: batchIdA }));
  console.log(JSON.stringify(syncA, null, 2));
  if (syncA.status !== "applied") throw new Error(`expected sync status 'applied', got '${syncA.status}'`);

  // === Round trip B: propose a second batch, accept only PART of it, confirm narration is REJECTED ===

  const proposeB = await step("wf_propose_mutations (2nd batch, same anchor -- for the partial-accept rejection case)", () =>
    call("wf_propose_mutations", {
      scope: { mode: "seed", anchorId: "alvor", depth: 1 },
      elapsedTimeDescriptor: "a little while later"
    })
  );
  console.log(JSON.stringify(proposeB, null, 2));
  const batchIdB = proposeB.batchId;

  if (proposeB.mutationCount < 2) {
    throw new Error(
      `Need >=2 mutations in batch B to exercise the partial-accept rejection case; got ${proposeB.mutationCount}. ` +
      `(The model may have judged fewer deltas worth texturing this run -- re-run the smoke test.)`
    );
  }

  const reviewB = await step("wf_review_batch (grain='headline', batch B)", () =>
    call("wf_review_batch", { batchId: batchIdB, grain: "headline" })
  );
  console.log(reviewB.rendered);
  const firstRegionId = reviewB.rendered.match(/^- (region-\d+):/m)?.[1];
  if (!firstRegionId) throw new Error(`Could not find a regionId in batch B's headline: ${reviewB.rendered}`);

  const acceptB = await step(`wf_accept (scope='region', id='${firstRegionId}') -- accept only ONE region, leave the rest pending`, () =>
    call("wf_accept", { batchId: batchIdB, scope: "region", id: firstRegionId })
  );
  console.log(JSON.stringify(acceptB, null, 2));

  await step("wf_narrate_batch against batch B (partially accepted -- MUST be rejected, not partially narrated)", async () => {
    let threw = false;
    let errorText;
    try {
      await call("wf_narrate_batch", { batchId: batchIdB });
    } catch (err) {
      threw = true;
      errorText = err.mcpErrorText ?? err.message;
    }
    console.log(`Rejected as expected: ${threw}`);
    console.log(`Error text: ${errorText}`);
    if (!threw) throw new Error("wf_narrate_batch did NOT reject a batch with pending mutations -- hard gate is broken!");
    if (!/not accepted|pending/i.test(errorText ?? "")) {
      throw new Error(`Rejection error text doesn't clearly name the problem: "${errorText}"`);
    }
  });

  // Now reject (not just leave pending) the remaining mutations and confirm narration is STILL refused
  // (a rejected mutation is just as much "not accepted" as a pending one).
  const rejectB = await step("wf_reject (scope='batch', batch B) -- now every remaining mutation is 'rejected', not 'pending'", () =>
    call("wf_reject", { batchId: batchIdB, scope: "batch" })
  );
  console.log(JSON.stringify(rejectB, null, 2));

  await step("wf_narrate_batch against batch B again (mix of accepted/rejected -- still MUST be rejected)", async () => {
    let threw = false;
    try {
      await call("wf_narrate_batch", { batchId: batchIdB });
    } catch (err) {
      threw = true;
      console.log(`Rejected as expected: ${err.mcpErrorText ?? err.message}`);
    }
    if (!threw) throw new Error("wf_narrate_batch did NOT reject a batch containing a rejected mutation!");
  });

  await client.close();

  console.log(`\n${passed} steps passed, ${failed} failed.`);
  console.log("\nSMOKE TEST PASSED: full live-diff round trip (propose -> review -> accept -> narrate -> " +
    "regenerate-with-note -> sync) succeeded on batch A; the narration gate correctly refused batch B " +
    "both while pending and after explicit rejection, with a clear error each time.");
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
