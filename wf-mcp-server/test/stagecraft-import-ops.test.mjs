import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

/**
 * CONTRACT UNDER TEST — wf-mcp-server/lib/stagecraft-import-ops.mjs's
 * importCompendiumSceneOnAccept/reconcilePendingCompendiumImports (Phase 38
 * task 38.2, §4 of review-ui/test/e2e/phase38-fixture.mjs -- THE WRITTEN
 * CONTRACT). Real (scratch-isolated) stagecraft-store.mjs + the real
 * ops-channel writer, no live Foundry -- a background timer stands in for
 * the Foundry-side watcher, same simulated-watcher technique
 * foundry-push-ops.test.mjs/foundry-ops.test.mjs already established.
 * `pollMs`/`timeoutMs` are injected small everywhere so nothing here waits
 * anywhere near the production 7s default.
 *
 * The review-ui/test/e2e/phase38-import-on-accept.e2e.mjs suite covers the
 * SAME contract at the route level (through review-ui/server.mjs's extended
 * accept route) -- this file is the fast, unit-level pass directly against
 * this module.
 */
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

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-stagecraft-import-ops-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_STAGECRAFT_DIR = join(scratchDir, "stagecraft");
const dataDir = join(scratchDir, "foundrydata");

const { importCompendiumSceneOnAccept, reconcilePendingCompendiumImports } = await import("../lib/stagecraft-import-ops.mjs");
const { foundryOpsPath, foundryResultsPath } = await import("../lib/snapshot.mjs");
const { saveStagecraftAsset, getStagecraftAsset } = await import("../../session-planner/stagecraft-store.mjs");

function seedFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
}

function seedBrowseRow(world, { name, packId, entryId }) {
  return saveStagecraftAsset(
    world,
    { kind: "map", name, source: "foundry", meta: "in compendium — import to stage", foundryRef: null, compendiumRef: { packId, entryId }, status: "proposed" },
    { makeId: () => `sc_${world}_${entryId}` }
  );
}

// (a) throws for a non-compendiumRef asset --------------------------------------
await test("importCompendiumSceneOnAccept: throws a clear error for an asset with no compendiumRef -- caller-side gating bug, not a runtime condition to handle gracefully", async () => {
  const WORLD = "import-ops-no-ref-world";
  const asset = saveStagecraftAsset(WORLD, { kind: "splash", name: "Hand-added", status: "proposed" }, { makeId: () => "sc-plain" });
  await assert.rejects(() => importCompendiumSceneOnAccept(dataDir, WORLD, asset.id), /no compendiumRef/);
});

// (b) writes exactly one import_compendium_scene op ------------------------------
await test("importCompendiumSceneOnAccept: writes ONE import_compendium_scene op {packId, entryId} onto the ops channel", async () => {
  const WORLD = "import-ops-write-shape-world";
  const row = seedBrowseRow(WORLD, { name: "The Drowned Anchor", packId: "czepeku-taverns.scenes", entryId: "scnEntryTavernA" });

  const outcome = await importCompendiumSceneOnAccept(dataDir, WORLD, row.id, { pollMs: 10, timeoutMs: 40 });
  assert.equal(outcome.status, "queued", "no watcher is running in this test -- must be queued, not applied");

  const onDisk = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].kind, "import_compendium_scene");
  assert.deepEqual(onDisk[0].data, { packId: "czepeku-taverns.scenes", entryId: "scnEntryTavernA" });
  assert.equal(typeof onDisk[0].opId, "string");
});

// (c) queued outcome sets the pendingImport ledger -------------------------------
await test("importCompendiumSceneOnAccept: a queued outcome (no watcher within the poll window) sets pendingImport:{opId,requestedAt}, asset stays 'proposed'", async () => {
  const WORLD = "import-ops-queued-world";
  const row = seedBrowseRow(WORLD, { name: "The Gilded Cask", packId: "czepeku-taverns.scenes", entryId: "scnEntryTavernB" });

  const outcome = await importCompendiumSceneOnAccept(dataDir, WORLD, row.id, { pollMs: 10, timeoutMs: 40, now: "2026-08-10T00:00:00.000Z" });
  assert.equal(outcome.status, "queued");
  assert.equal(outcome.asset.status, "proposed");
  assert.deepEqual(outcome.asset.pendingImport, { opId: outcome.opId, requestedAt: "2026-08-10T00:00:00.000Z" });

  const onDisk = getStagecraftAsset(WORLD, row.id);
  assert.deepEqual(onDisk.pendingImport, { opId: outcome.opId, requestedAt: "2026-08-10T00:00:00.000Z" });
  assert.equal(onDisk.status, "proposed");
  assert.equal(onDisk.foundryRef, null);
});

// (d) applied ok:true completes the row ------------------------------------------
await test("importCompendiumSceneOnAccept: applied ok:true -- foundryRef.sceneUuid set, status:'accepted', pendingImport cleared, response {status:'applied', ok:true, foundryUuid, asset}", async () => {
  const WORLD = "import-ops-applied-ok-world";
  const row = seedBrowseRow(WORLD, { name: "The Salt & Smoke", packId: "czepeku-taverns.scenes", entryId: "scnEntryTavernC" });
  const opsPath = foundryOpsPath(dataDir, WORLD);
  const resultsPath = foundryResultsPath(dataDir, WORLD);

  const watcherTimer = setTimeout(() => {
    const ops = JSON.parse(readFileSync(opsPath, "utf8"));
    seedFile(resultsPath, [{ opId: ops[0].opId, ok: true, foundryUuid: "Scene.saltAndSmokeImported" }]);
    writeFileSync(opsPath, "[]", "utf8");
  }, 25);

  const outcome = await importCompendiumSceneOnAccept(dataDir, WORLD, row.id, { pollMs: 10, timeoutMs: 500 });
  clearTimeout(watcherTimer);

  assert.equal(outcome.status, "applied");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.foundryUuid, "Scene.saltAndSmokeImported");
  assert.equal(outcome.asset.status, "accepted");
  assert.deepEqual(outcome.asset.foundryRef, { sceneUuid: "Scene.saltAndSmokeImported" });
  assert.equal(outcome.asset.pendingImport, null);

  const resultsOnDisk = readFileSync(resultsPath, "utf8").trim();
  assert.equal(resultsOnDisk, "[]", "GM_Tools (the consumer here) must clear the results file back to [] once read");
});

// (e) applied ok:false leaves the row retryable ----------------------------------
await test("importCompendiumSceneOnAccept: applied ok:false -- asset UNCHANGED (stays 'proposed', compendiumRef intact), response carries {status:'applied', ok:false, error, asset}", async () => {
  const WORLD = "import-ops-applied-fail-world";
  const row = seedBrowseRow(WORLD, { name: "Bad Import", packId: "czepeku-taverns.scenes", entryId: "scnEntryBad" });
  const opsPath = foundryOpsPath(dataDir, WORLD);
  const resultsPath = foundryResultsPath(dataDir, WORLD);

  const watcherTimer = setTimeout(() => {
    const ops = JSON.parse(readFileSync(opsPath, "utf8"));
    seedFile(resultsPath, [{ opId: ops[0].opId, ok: false, error: "unknown pack \"czepeku-taverns.scenes\"" }]);
    writeFileSync(opsPath, "[]", "utf8");
  }, 25);

  const outcome = await importCompendiumSceneOnAccept(dataDir, WORLD, row.id, { pollMs: 10, timeoutMs: 500 });
  clearTimeout(watcherTimer);

  assert.equal(outcome.status, "applied");
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /unknown pack/);
  assert.equal(outcome.asset.status, "proposed");
  assert.deepEqual(outcome.asset.compendiumRef, { packId: "czepeku-taverns.scenes", entryId: "scnEntryBad" });
  assert.equal(outcome.asset.pendingImport, null, "a failed import never leaves a dangling pendingImport behind");
});

// (f) reconcilePendingCompendiumImports -- late ok:true --------------------------
await test("reconcilePendingCompendiumImports: consumes a late ok:true result for a pending asset -- completes the row, clears the ledger, consumes ONLY its own opId from the results file", async () => {
  const WORLD = "import-ops-reconcile-ok-world";
  const row = seedBrowseRow(WORLD, { name: "Late Import", packId: "czepeku-taverns.scenes", entryId: "scnEntryLate" });
  const outcome = await importCompendiumSceneOnAccept(dataDir, WORLD, row.id, { pollMs: 10, timeoutMs: 20 }); // times out -> queued
  assert.equal(outcome.status, "queued");

  const resultsPath = foundryResultsPath(dataDir, WORLD);
  seedFile(resultsPath, [
    { opId: outcome.opId, ok: true, foundryUuid: "Scene.lateImported" },
    { opId: "op_unrelated_from_some_other_poll", ok: true, foundryUuid: "Scene.unrelated" }
  ]);

  const reconciledCount = reconcilePendingCompendiumImports(dataDir, WORLD);
  assert.equal(reconciledCount, 1);

  const asset = getStagecraftAsset(WORLD, row.id);
  assert.equal(asset.status, "accepted");
  assert.deepEqual(asset.foundryRef, { sceneUuid: "Scene.lateImported" });
  assert.equal(asset.pendingImport, null);

  const remaining = JSON.parse(readFileSync(resultsPath, "utf8"));
  assert.deepEqual(remaining, [{ opId: "op_unrelated_from_some_other_poll", ok: true, foundryUuid: "Scene.unrelated" }], "only the recognized opId is consumed -- an unrelated in-flight poll's own result is left untouched");
});

// (g) reconcilePendingCompendiumImports -- late ok:false, no-op when nothing pending --
await test("reconcilePendingCompendiumImports: a late ok:false result clears the ledger only (row stays proposed); a world with nothing pending is a cheap no-op (0, no file touched)", async () => {
  const WORLD = "import-ops-reconcile-fail-world";
  const row = seedBrowseRow(WORLD, { name: "Late Failure", packId: "czepeku-taverns.scenes", entryId: "scnEntryLateFail" });
  const outcome = await importCompendiumSceneOnAccept(dataDir, WORLD, row.id, { pollMs: 10, timeoutMs: 20 });
  assert.equal(outcome.status, "queued");

  seedFile(foundryResultsPath(dataDir, WORLD), [{ opId: outcome.opId, ok: false, error: "boom" }]);
  const reconciledCount = reconcilePendingCompendiumImports(dataDir, WORLD);
  assert.equal(reconciledCount, 1);

  const asset = getStagecraftAsset(WORLD, row.id);
  assert.equal(asset.status, "proposed");
  assert.equal(asset.pendingImport, null, "cleared -- retryable, never permanently stuck");

  const NOTHING_PENDING_WORLD = "import-ops-reconcile-noop-world";
  seedBrowseRow(NOTHING_PENDING_WORLD, { name: "Never Accepted", packId: "czepeku-taverns.scenes", entryId: "scnEntryNeverAccepted" });
  assert.equal(reconcilePendingCompendiumImports(dataDir, NOTHING_PENDING_WORLD), 0);
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
