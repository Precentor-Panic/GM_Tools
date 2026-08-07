import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CONTRACT UNDER TEST — wf-mcp-server/lib/foundry-ops.mjs's writeFoundryOps
 * (Phase 32 task 32.3's ops-channel writer). Real (scratch-isolated)
 * filesystem, no live Foundry -- a background timer stands in for the
 * Foundry-side watcher when a test needs to exercise the "applied" path,
 * same simulated-watcher technique wf-mcp-server/test/sync-headless.test.mjs
 * already established for the existing mutation bridge. `pollMs`/`timeoutMs`
 * are injected small in every test here so nothing in this file waits
 * anywhere near the production 7s default.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures", "foundry-bridge");

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

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-foundry-ops-test-"));
const dataDir = join(scratchDir, "foundrydata");

const { writeFoundryOps, makeOpId, FoundryOpsInFlightError } = await import("../lib/foundry-ops.mjs");
const { foundryOpsPath, foundryResultsPath } = await import("../lib/snapshot.mjs");

const sampleOp = JSON.parse(readFileSync(join(FIXTURES_DIR, "foundry-ops.create-scene.sample.json"), "utf8"));
const sampleResult = JSON.parse(readFileSync(join(FIXTURES_DIR, "foundry-results.sample.json"), "utf8"));

function seedFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
}

// (a) writeFoundryOps writes the ops file in the contracted shape --------------
await test("writeFoundryOps: writes worlds/<world>/world-fabric-foundry-ops.json as a flat [{opId,kind,data}] array matching the fixture's own shape", async () => {
  const WORLD = "ops-write-shape-world";
  const op = { opId: "op_shape_1", kind: "create_scene", data: { name: "Test Scene", background: { src: "scenes/test.webp" } } };

  const result = await writeFoundryOps(dataDir, WORLD, [op], { pollMs: 10, timeoutMs: 40 });
  assert.equal(result.status, "queued", "no watcher is running in this test -- must be queued, not applied");

  const onDisk = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"));
  assert.deepEqual(onDisk, [op]);
  // Structural shape matches the 32.0 contract fixture: opId/kind/data, data.background.src.
  assert.equal(typeof onDisk[0].opId, "string");
  assert.equal(onDisk[0].kind, sampleOp[0].kind);
  assert.equal(typeof onDisk[0].data.name, "string");
  assert.equal(typeof onDisk[0].data.background.src, "string");
});

// (b) applied + correlated + results cleared -----------------------------------
await test("writeFoundryOps: a watcher that applies+clears quickly -> {status:'applied', results} correlated by opId, and the results file is cleared back to '[]'", async () => {
  const WORLD = "ops-applied-world";
  const opId = "op_applied_1";
  const op = { opId, kind: "create_scene", data: { name: "Ashwood Ambush Site", background: { src: "scenes/ashwood-ambush-site.webp" } } };
  const opsPath = foundryOpsPath(dataDir, WORLD);
  const resultsPath = foundryResultsPath(dataDir, WORLD);

  // Simulated Foundry-side watcher: write the result, THEN clear the ops
  // file (same ordering the contract requires -- §2 "writes ALL outcomes ...
  // FIRST, then overwrites this ops file back to []").
  const watcherTimer = setTimeout(() => {
    seedFile(resultsPath, [{ opId, ok: true, foundryUuid: "Scene.abc123" }]);
    writeFileSync(opsPath, "[]", "utf8");
  }, 25);

  const result = await writeFoundryOps(dataDir, WORLD, [op], { pollMs: 10, timeoutMs: 500 });
  clearTimeout(watcherTimer);

  assert.equal(result.status, "applied");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].opId, opId);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].foundryUuid, "Scene.abc123");

  const resultsOnDisk = readFileSync(resultsPath, "utf8").trim();
  assert.equal(resultsOnDisk, "[]", "GM_Tools (the consumer here) must clear the results file back to [] once read");
});

await test("writeFoundryOps: correlates ONLY the requested batch's own opIds -- an unrelated result in the file is not returned", async () => {
  const WORLD = "ops-correlate-world";
  const opId = "op_correlate_mine";
  const op = { opId, kind: "create_scene", data: { name: "Mine", background: { src: "scenes/mine.webp" } } };
  const opsPath = foundryOpsPath(dataDir, WORLD);
  const resultsPath = foundryResultsPath(dataDir, WORLD);

  const watcherTimer = setTimeout(() => {
    seedFile(resultsPath, [
      { opId: "op_correlate_STALE_unrelated", ok: true, foundryUuid: "Scene.stale" },
      { opId, ok: true, foundryUuid: "Scene.mine" }
    ]);
    writeFileSync(opsPath, "[]", "utf8");
  }, 25);

  const result = await writeFoundryOps(dataDir, WORLD, [op], { pollMs: 10, timeoutMs: 500 });
  clearTimeout(watcherTimer);

  assert.equal(result.status, "applied");
  assert.deepEqual(result.results.map((r) => r.opId), [opId]);
});

// (c) never clears -> queued within the injected short timeout -----------------
await test("writeFoundryOps: ops file never clears (no module running) -> {status:'queued'} within the injected short timeout, not 7s", async () => {
  const WORLD = "ops-queued-world";
  const op = { opId: "op_queued_1", kind: "create_scene", data: { name: "Nobody Home", background: { src: "scenes/x.webp" } } };

  const startedAt = Date.now();
  const result = await writeFoundryOps(dataDir, WORLD, [op], { pollMs: 10, timeoutMs: 60 });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.status, "queued");
  assert.ok(typeof result.note === "string" && result.note.length > 0);
  assert.ok(elapsedMs < 2000, `expected a fast timeout well under 7s, took ${elapsedMs}ms`);
});

// Concurrency safety -------------------------------------------------------------
await test("writeFoundryOps: refuses to clobber a still-in-flight prior ops batch (FoundryOpsInFlightError)", async () => {
  const WORLD = "ops-inflight-world";
  const opsPath = foundryOpsPath(dataDir, WORLD);
  seedFile(opsPath, [{ opId: "op_prior_batch", kind: "create_scene", data: { name: "Still Working", background: { src: "x.webp" } } }]);

  await assert.rejects(
    () => writeFoundryOps(dataDir, WORLD, [{ opId: "op_new", kind: "create_scene", data: { name: "New", background: { src: "y.webp" } } }], { pollMs: 5, timeoutMs: 20 }),
    (err) => {
      assert.ok(err instanceof FoundryOpsInFlightError);
      assert.equal(err.name, "FoundryOpsInFlightError");
      return true;
    }
  );

  // The prior (unrelated) batch's content must be untouched by the refused write.
  const stillThere = JSON.parse(readFileSync(opsPath, "utf8"));
  assert.equal(stillThere[0].opId, "op_prior_batch");
});

await test("writeFoundryOps: a fresh world (no ops file yet at all) is NOT treated as in-flight -- the first push proceeds normally", async () => {
  const WORLD = "ops-fresh-world";
  const result1 = await writeFoundryOps(dataDir, WORLD, [{ opId: "op_fresh_1", kind: "create_scene", data: { name: "A", background: { src: "a.webp" } } }], { pollMs: 5, timeoutMs: 20 });
  assert.equal(result1.status, "queued", "no watcher running -- queued is expected here, the point of this test is that it wasn't rejected as in-flight");
});

await test("writeFoundryOps: a leftover queued (never-cleared) prior batch DOES block a second push -- the guard reads real on-disk state, not in-process bookkeeping", async () => {
  const WORLD = "ops-fresh-world"; // reuses the previous test's world -- its queued batch was left un-cleared on disk, exactly the scenario being proven
  await assert.rejects(() =>
    writeFoundryOps(dataDir, WORLD, [{ opId: "op_fresh_2", kind: "create_scene", data: { name: "B", background: { src: "b.webp" } } }], { pollMs: 5, timeoutMs: 20 })
  );
});

void makeOpId; // exercised indirectly via foundry-push-ops.test.mjs; imported here only to confirm the named export exists
void sampleResult;

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
