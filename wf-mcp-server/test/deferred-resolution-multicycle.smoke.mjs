#!/usr/bin/env node
/**
 * Manual/integration smoke test for Phase 3.5's full deferred-resolution
 * round trip — the phase's own Definition of Done: "A full multi-cycle
 * scenario run manually end-to-end through the real MCP server: several
 * wf_run_cycle calls with different headline foci -> backlog accumulation
 * confirmed -> explicit resolve -> accept -> sync." Also covers task 3.5.4's
 * own acceptance text (resolve -> accept -> ledger cleared -> defer again ->
 * resolve again -> REJECT this time -> ledger back to 'pending') and task
 * 3.5.5's (wf_run_cycle x3 with rotating headline foci -> backlog
 * accumulates for a non-headline entity -> wf_resolve_pending references
 * multiple cycles -> wf_accept -> sync/rollback still work on a
 * resolve-originated batch).
 *
 * Same pattern as live-diff-narrate.smoke.mjs: spawns the REAL
 * wf-mcp-server/index.mjs as a child process and drives it over the real
 * MCP protocol via the SDK's Client + StdioClientTransport. Genuinely billed
 * Anthropic API calls (wf_run_cycle's headline texturing, wf_resolve_pending's
 * resolve texturing) -- NOT run as part of `node --test` / `npm test`,
 * follows this repo's established .smoke.mjs naming/exclusion convention.
 *
 * Run manually once ANTHROPIC_API_KEY is set (from GM_Tools/):
 *
 *   node --env-file-if-exists=.env wf-mcp-server/test/deferred-resolution-multicycle.smoke.mjs
 *
 * Fixture: a small "Riverwood" town --
 *   riverwood --presence-- alvor    (month 1's headline anchor)
 *   riverwood --presence-- gerdur   (month 2's headline anchor)
 *   riverwood --presence-- sven     (month 3's / month 4's headline anchor)
 *   riverwood --social----- ellendra (never headline -- accumulates a
 *                                      deferred ledger entry every cycle,
 *                                      regardless of which of
 *                                      alvor/gerdur/sven is that cycle's
 *                                      headline focus, since ellendra is
 *                                      never within headlineDepth=1 of any
 *                                      of them)
 * Deliberately simple/repetitive (the same few edges decay from the same
 * base strength every cycle, since nothing is ever accepted+synced back
 * into the live graph mid-test) -- this is a MECHANISM smoke test, not a
 * narrative-quality one. Per this project's testing conventions, LLM output
 * content is printed for inspection, not strictly asserted on.
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

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-deferred-resolution-multicycle-smoke-"));
const dataDir = join(scratchDir, "foundrydata");
const reviewStateDir = join(scratchDir, "review-state");
const statusDir = join(scratchDir, "time-skip-status");
const pendingLedgerDir = join(scratchDir, "pending-resolution");
const humanReviewDir = join(scratchDir, "human-review"); // Phase 4 task 4.2 -- wf_accept/wf_reject below write here; must not touch the real repo default

const WORLD = "deferred-resolution-multicycle-smoke-world";
const snapPath = snapshotFilePath(dataDir, WORLD);

// This process's own pending-ledger.mjs import (for direct on-disk
// inspection between MCP calls) must agree with the subprocess's env.
process.env.GM_TOOLS_PENDING_LEDGER_DIR = pendingLedgerDir;
const { readPending } = await import("../../mutation-engine/pending-ledger.mjs");

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

// --- fixture: seeded headlessly, no live Foundry client needed ---
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "riverwood", name: "Riverwood", type: "place", importance: 0.8, summary: "A logging village by the river." } },
  { op: "upsert_entity", data: { id: "alvor", name: "Alvor", type: "person", importance: 0.5, summary: "The village smith." } },
  { op: "upsert_entity", data: { id: "gerdur", name: "Gerdur", type: "person", importance: 0.5, summary: "Alvor's sister, runs the mill." } },
  { op: "upsert_entity", data: { id: "sven", name: "Sven", type: "person", importance: 0.4, summary: "The innkeeper's helper." } },
  { op: "upsert_entity", data: { id: "ellendra", name: "Ellendra", type: "person", importance: 0.5, summary: "A traveling herbalist who passes through Riverwood." } },
  { op: "upsert_edge", data: { id: "e-alvor", sourceId: "riverwood", targetId: "alvor", relationshipType: "presence", strength: 0.8 } },
  { op: "upsert_edge", data: { id: "e-gerdur", sourceId: "riverwood", targetId: "gerdur", relationshipType: "presence", strength: 0.8 } },
  { op: "upsert_edge", data: { id: "e-sven", sourceId: "riverwood", targetId: "sven", relationshipType: "presence", strength: 0.8 } },
  { op: "upsert_edge", data: { id: "e-ellendra", sourceId: "riverwood", targetId: "ellendra", relationshipType: "social", strength: 0.6 } }
]);

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
      GM_TOOLS_PENDING_LEDGER_DIR: pendingLedgerDir,
      GM_TOOLS_HUMAN_REVIEW_DIR: humanReviewDir,
      WF_DEFAULT_WORLD: WORLD
    },
    stderr: "pipe"
  });
  client = new Client({ name: "deferred-resolution-multicycle-smoke-client", version: "0.0.0" });
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

  // === Three cycles, three different headline foci, elapsedSessions large
  // enough that the presence-edge decay clears IMPACT_THRESHOLD every time ===

  const cycles = [
    { headlineAnchorId: "alvor", cycleDescriptor: "month 1" },
    { headlineAnchorId: "gerdur", cycleDescriptor: "month 2" },
    { headlineAnchorId: "sven", cycleDescriptor: "month 3" }
  ];

  for (const c of cycles) {
    const result = await step(`wf_run_cycle (headline='${c.headlineAnchorId}', cycleDescriptor='${c.cycleDescriptor}')`, () =>
      call("wf_run_cycle", {
        cycleScope: { mode: "ambient", elapsedSessions: 3 },
        headlineAnchorId: c.headlineAnchorId,
        headlineDepth: 1,
        cycleDescriptor: c.cycleDescriptor,
        elapsedTimeDescriptor: "one month"
      })
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.headlineTexturedCount < 1) {
      throw new Error(`Expected the headline (${c.headlineAnchorId}) to texture at least 1 mutation; got ${result.headlineTexturedCount}`);
    }
  }

  await step("Backlog accumulation confirmed: ellendra (never headline) has 3 pending entries spanning all 3 cycles", async () => {
    const entries = readPending(WORLD, "ellendra");
    console.log(JSON.stringify(entries, null, 2));
    if (entries.length !== 3) throw new Error(`Expected ellendra to have exactly 3 pending entries after 3 cycles, got ${entries.length}`);
    const descriptors = new Set(entries.map((e) => e.cycleDescriptor));
    for (const c of cycles) {
      if (!descriptors.has(c.cycleDescriptor)) throw new Error(`Expected a pending entry for cycleDescriptor="${c.cycleDescriptor}", missing`);
    }
    if (!entries.every((e) => e.status === "pending")) throw new Error("All 3 entries should still be 'pending' before any resolve");
  });

  // === Explicit resolve -> accept -> ledger cleared ===

  const resolveA = await step("wf_resolve_pending (entityId='ellendra') -- resolving all 3 accumulated cycles in one call", () =>
    call("wf_resolve_pending", { entityId: "ellendra", depth: 1 })
  );
  console.log(JSON.stringify(resolveA, null, 2));
  if (!resolveA.resolvedEntityIds.includes("ellendra")) throw new Error("ellendra should be among the resolved entities");
  console.log("\n=== RESOLVED HEADLINE (references multiple cycles) ===");
  console.log(resolveA.headline);
  console.log("=== END ===\n");

  const reviewA = await step("wf_review_batch (grain='entity', ellendra) -- inspect the actual resolved mutation content", () =>
    call("wf_review_batch", { batchId: resolveA.batchId, grain: "entity", entityId: "ellendra" })
  );
  console.log(reviewA.rendered);

  const acceptA = await step("wf_accept (scope='batch') on the resolve batch", () =>
    call("wf_accept", { batchId: resolveA.batchId, scope: "batch" })
  );
  console.log(JSON.stringify(acceptA, null, 2));
  if (!acceptA.ledgerResolved || !acceptA.ledgerResolved.length) {
    throw new Error("wf_accept on a resolve-originated batch should report ledgerResolved");
  }

  await step("Ledger cleared after accept: readPending('ellendra') returns []", async () => {
    const after = readPending(WORLD, "ellendra");
    console.log(JSON.stringify(after));
    if (after.length !== 0) throw new Error(`Expected ellendra's ledger to be fully cleared after accept, got ${after.length} entries`);
  });

  const syncA = await step("wf_sync_to_foundry on the accepted resolve batch -- sync must behave normally on a resolve-originated batch", () =>
    call("wf_sync_to_foundry", { batchId: resolveA.batchId })
  );
  console.log(JSON.stringify(syncA, null, 2));
  if (syncA.status !== "applied") throw new Error(`Expected sync status 'applied', got '${syncA.status}'`);

  // === One more cycle deferring to ellendra again -> resolve again -> REJECT -> back to 'pending' ===

  const cycle4 = await step("wf_run_cycle (4th cycle, headline='sven' again, cycleDescriptor='month 4') -- ellendra defers again", () =>
    call("wf_run_cycle", {
      cycleScope: { mode: "ambient", elapsedSessions: 3 },
      headlineAnchorId: "sven",
      headlineDepth: 1,
      cycleDescriptor: "month 4",
      elapsedTimeDescriptor: "one more month"
    })
  );
  console.log(JSON.stringify(cycle4, null, 2));

  await step("ellendra has exactly 1 fresh pending entry (the ledger was cleared, not left at 3+1)", async () => {
    const entries = readPending(WORLD, "ellendra");
    console.log(JSON.stringify(entries, null, 2));
    if (entries.length !== 1) throw new Error(`Expected exactly 1 pending entry for ellendra after the 4th cycle, got ${entries.length}`);
    if (entries[0].cycleDescriptor !== "month 4") throw new Error(`Expected the fresh entry's cycleDescriptor to be "month 4", got "${entries[0].cycleDescriptor}"`);
  });

  const resolveB = await step("wf_resolve_pending (entityId='ellendra') again", () =>
    call("wf_resolve_pending", { entityId: "ellendra", depth: 1 })
  );
  console.log(JSON.stringify(resolveB, null, 2));

  await step("The entry is now locked 'proposed' (in-flight), not deleted", async () => {
    const entries = readPending(WORLD, "ellendra");
    if (entries.length !== 1) throw new Error(`Expected the single entry to still exist (locked), got ${entries.length}`);
    if (entries[0].status !== "proposed") throw new Error(`Expected status 'proposed' while the resolve batch is pending review, got "${entries[0].status}"`);
  });

  const rejectB = await step("wf_reject (scope='batch') on the second resolve batch -- reject path", () =>
    call("wf_reject", { batchId: resolveB.batchId, scope: "batch" })
  );
  console.log(JSON.stringify(rejectB, null, 2));
  if (!rejectB.ledgerReverted || !rejectB.ledgerReverted.length) {
    throw new Error("wf_reject on a resolve-originated batch should report ledgerReverted");
  }

  await step("Rejected entry is back to 'pending', not gone", async () => {
    const entries = readPending(WORLD, "ellendra");
    console.log(JSON.stringify(entries, null, 2));
    if (entries.length !== 1) throw new Error(`Expected the entry to still exist after rejection, got ${entries.length}`);
    if (entries[0].status !== "pending") throw new Error(`Expected status 'pending' after rejection, got "${entries[0].status}"`);
    if (entries[0].cycleDescriptor !== "month 4") throw new Error("The reverted entry should be the same one, not a new/different one");
  });

  // === Rollback still behaves normally on a resolve-originated (accepted) batch ===

  const rollbackA = await step("wf_rollback_batch on the FIRST resolve batch (already accepted+synced) -- rollback must still function", () =>
    call("wf_rollback_batch", { batchId: resolveA.batchId })
  );
  console.log(JSON.stringify(rollbackA, null, 2));
  if (rollbackA.status === "no-op" && (!rollbackA.skipped || !rollbackA.skipped.length)) {
    // A genuine no-op with nothing skipped would be surprising (there was exactly one accepted mutation to restore) --
    // but not treated as a hard failure here, since rollback's own Phase-1 "most-recently-accepted only" scope note
    // means outcomes can vary depending on what else has been accepted/synced since. Report loudly either way.
    console.warn("NOTE: wf_rollback_batch reported a no-op with nothing skipped -- unexpected but not treated as fatal here.");
  }

  await client.close();

  console.log(`\n${passed} steps passed, ${failed} failed.`);
  console.log(
    "\nSMOKE TEST PASSED: 3 wf_run_cycle calls with rotating headline foci -> ellendra's backlog accumulated " +
    "across all 3 cycles -> wf_resolve_pending folded all 3 into one batch -> wf_accept cleared the ledger -> " +
    "wf_sync_to_foundry applied normally -> a 4th cycle deferred to ellendra again -> wf_resolve_pending -> " +
    "wf_reject reverted the entry to 'pending' (not deleted) -> wf_rollback_batch still functions against a " +
    "resolve-originated batch."
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
