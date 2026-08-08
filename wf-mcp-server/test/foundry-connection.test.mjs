import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CONTRACT UNDER TEST — wf-mcp-server/lib/foundry-connection.mjs (Phase 34
 * task 34.1): deriveConnectionState (the Connection-Menu chip's off/stale/
 * live derivation + sync-log read) and syncNow (the sync-now composition:
 * read index -> pullFoundryActorsToStores -> append sync-log). Driven
 * against the real 32.0 fixture (wf-mcp-server/test/fixtures/foundry-bridge/)
 * plus hand-built off/stale cases, no live Foundry.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures", "foundry-bridge");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-foundry-connection-test-"));
process.env.GM_TOOLS_SYNC_LOG_DIR = join(scratchDir, "foundry-sync-log");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");
const dataDir = join(scratchDir, "foundrydata");

const { deriveConnectionState, syncNow, readSyncLog, appendSyncLogEntry, DEFAULT_STALE_THRESHOLD_MS, SYNC_LOG_MAX_ENTRIES } =
  await import("../lib/foundry-connection.mjs");
const { foundryIndexPath } = await import("../lib/snapshot.mjs");

const sampleFixture = JSON.parse(readFileSync(join(FIXTURES_DIR, "foundry-index.sample.json"), "utf8"));
const FRESH_WORLD = "fc-fresh-world";
const STALE_WORLD = "fc-stale-world";
const OFF_WORLD = "fc-off-world";

function writeIndex(world, overrides = {}) {
  const p = foundryIndexPath(dataDir, world);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ ...sampleFixture, ...overrides }), "utf8");
}

// FRESH_WORLD: exportedAt very close to "now" (opts.now below).
writeIndex(FRESH_WORLD, { exportedAt: "2026-08-08T12:00:00.000Z" });
// STALE_WORLD: exportedAt 30 minutes before "now" -- over the 15-min default threshold.
writeIndex(STALE_WORLD, { exportedAt: "2026-08-08T11:30:00.000Z" });

const NOW = "2026-08-08T12:00:00.000Z";

// ---------------------------------------------------------------- deriveConnectionState

test("deriveConnectionState: OFF -- no index file at all", () => {
  const result = deriveConnectionState(dataDir, OFF_WORLD, { now: NOW });
  assert.equal(result.state, "off");
  assert.equal(result.exportedAt, null);
  assert.equal(result.ageMs, null);
  assert.equal(result.counts, null);
  assert.equal(result.staleThresholdMs, DEFAULT_STALE_THRESHOLD_MS);
  assert.equal(result.world, OFF_WORLD);
  assert.equal(result.lastSync, null);
});

test("deriveConnectionState: LIVE -- index fresh (age 0, well under the default 15-min threshold)", () => {
  const result = deriveConnectionState(dataDir, FRESH_WORLD, { now: NOW });
  assert.equal(result.state, "live");
  assert.equal(result.exportedAt, "2026-08-08T12:00:00.000Z");
  assert.equal(result.ageMs, 0);
  assert.deepEqual(result.counts, { actors: 3, items: 0, scenes: 1, journals: 0 });
});

test("deriveConnectionState: STALE -- index age (30min) exceeds the default 15-min threshold", () => {
  const result = deriveConnectionState(dataDir, STALE_WORLD, { now: NOW });
  assert.equal(result.state, "stale");
  assert.equal(result.ageMs, 30 * 60 * 1000);
  assert.ok(result.counts, "stale still reports real counts, unlike off");
});

test("deriveConnectionState: a custom staleThresholdMs (e.g. from the settings store) shifts the live/stale boundary", () => {
  // Same STALE_WORLD (30min old), but with a 1-hour threshold it now reads live.
  const result = deriveConnectionState(dataDir, STALE_WORLD, { now: NOW, staleThresholdMs: 60 * 60 * 1000 });
  assert.equal(result.state, "live");
  assert.equal(result.staleThresholdMs, 60 * 60 * 1000);
});

test("deriveConnectionState: exactly AT the threshold is still live (only strictly OVER counts as stale)", () => {
  const world = "fc-exact-threshold-world";
  writeIndex(world, { exportedAt: "2026-08-08T11:45:00.000Z" }); // exactly 15 min before NOW
  const result = deriveConnectionState(dataDir, world, { now: NOW });
  assert.equal(result.ageMs, DEFAULT_STALE_THRESHOLD_MS);
  assert.equal(result.state, "live");
});

// ---------------------------------------------------------------- sync-log

test("appendSyncLogEntry + readSyncLog: entries persist, newest included, capped at SYNC_LOG_MAX_ENTRIES", () => {
  const world = "fc-synclog-world";
  for (let i = 0; i < SYNC_LOG_MAX_ENTRIES + 5; i++) {
    appendSyncLogEntry(world, { ok: true, pulled: { bestiaryProposed: i, partyProposed: 0 } }, { now: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z` });
  }
  const log = readSyncLog(world);
  assert.equal(log.length, SYNC_LOG_MAX_ENTRIES, "log must be capped, not grow unboundedly");
  assert.equal(log[log.length - 1].pulled.bestiaryProposed, SYNC_LOG_MAX_ENTRIES + 4, "the newest entry must be the last one appended");
});

test("deriveConnectionState's lastSync reflects the newest sync-log entry (at/ok/error only, not `pulled`)", () => {
  const world = "fc-lastsync-world";
  appendSyncLogEntry(world, { ok: false, error: "boom" }, { now: "2026-01-01T00:00:00.000Z" });
  appendSyncLogEntry(world, { ok: true, pulled: { bestiaryProposed: 2, partyProposed: 1 } }, { now: "2026-01-01T00:01:00.000Z" });
  const result = deriveConnectionState(dataDir, world, { now: NOW }); // off (no index for this world) but lastSync is independent
  assert.deepEqual(result.lastSync, { at: "2026-01-01T00:01:00.000Z", ok: true });
});

// ---------------------------------------------------------------- syncNow

test("syncNow: no index yet -- returns {state:'off', message}, 200-shaped (no throw), and logs NOTHING (no attempt was made)", async () => {
  const world = "fc-synonow-off-world";
  const result = syncNow(dataDir, world);
  assert.equal(result.state, "off");
  assert.match(result.message, /No Foundry index found/);
  assert.equal(readSyncLog(world).length, 0, "no sync-log entry for a call that never attempted a pull");
});

test("syncNow: real fixture -- pulls actors, appends a sync-log entry, reports state/indexAgeMs", () => {
  const world = "fc-synonow-real-world";
  writeIndex(world, { exportedAt: NOW });
  const result = syncNow(dataDir, world, { now: NOW });
  assert.equal(result.state, "live");
  assert.equal(result.indexAgeMs, 0);
  assert.equal(result.pulled.bestiaryProposed.length, 2);
  assert.equal(result.pulled.partyProposed.length, 1);
  // Phase 35 task 35.1, §6: alreadyLinked gains a THIRD key, `items` (foundry-pull-ops.mjs's own additive response-shape change) -- passed through here unmodified by syncNow's own `pulled` composition.
  assert.deepEqual(result.pulled.alreadyLinked, { bestiary: [], party: [], items: [] });

  const log = readSyncLog(world);
  assert.equal(log.length, 1);
  assert.equal(log[0].ok, true);
  assert.deepEqual(log[0].pulled, { bestiaryProposed: 2, partyProposed: 1 });

  // And the connection route's own read now reflects that sync in lastSync.
  const connection = deriveConnectionState(dataDir, world, { now: NOW });
  assert.equal(connection.lastSync.ok, true);
});

console.log(`\n${passed} test(s) passed.`);
void existsSync;
